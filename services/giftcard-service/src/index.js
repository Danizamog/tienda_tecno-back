const express = require('express')
const cors    = require('cors')

const app  = express()
const PORT = Number(process.env.PORT || 9009)

app.use(cors())
app.use(express.json())

const PB_URL      = (process.env.POCKETBASE_URL || '').replace(/\/$/, '')
const PB_IDENTITY = process.env.POCKETBASE_AUTH_IDENTITY || ''
const PB_PASSWORD = process.env.POCKETBASE_AUTH_PASSWORD || ''

// ── Admin token cache ─────────────────────────────────────────────────────────
let _adminToken = null
let _adminTokenExpiry = 0

async function readJsonSafe(res) {
  const text = await res.text()
  if (!text) return null
  try { return JSON.parse(text) } catch { return { raw: text } }
}

async function getAdminToken() {
  if (_adminToken && Date.now() < _adminTokenExpiry) return _adminToken
  const res = await fetch(`${PB_URL}/api/collections/_superusers/auth-with-password`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ identity: PB_IDENTITY, password: PB_PASSWORD }),
  })
  if (!res.ok) {
    const details = await readJsonSafe(res)
    throw new Error(`PB admin auth failed (${res.status}): ${JSON.stringify(details)}`)
  }
  const { token } = await res.json()
  _adminToken = token
  _adminTokenExpiry = Date.now() + 55 * 60 * 1000
  return token
}

function pbHeaders(token) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
}

function safeId(value) {
  return String(value || '').replace(/[^a-z0-9_]/gi, '').slice(0, 30)
}

function safeCode(value) {
  return String(value || '').replace(/[^A-Z0-9_-]/g, '').slice(0, 32).toUpperCase()
}

async function propagateCodeStatusToGiftcards(token, codeId, targetStatus, usageType) {
  if (!['cancelled', 'expired', 'redeemed'].includes(targetStatus)) return
  if (usageType !== 'single_use') return

  const params = new URLSearchParams({
    filter:  `source_code="${safeId(codeId)}" && status="active"`,
    fields:  'id,status',
    perPage: '200',
    page:    '1',
  })

  const listRes = await fetch(
    `${PB_URL}/api/collections/giftcards/records?${params}`,
    { headers: pbHeaders(token) }
  )
  if (!listRes.ok) return

  const data = await listRes.json()
  for (const gc of (data.items || [])) {
    await fetch(`${PB_URL}/api/collections/giftcards/records/${gc.id}`, {
      method:  'PATCH',
      headers: pbHeaders(token),
      body:    JSON.stringify({ status: targetStatus }),
    })
  }
}

async function autoExpireGiftcard(token, gc) {
  if (!gc?.expires_at) return gc
  if (new Date(gc.expires_at) >= new Date()) return gc
  if (gc.status !== 'active') return gc
  await fetch(`${PB_URL}/api/collections/giftcards/records/${gc.id}`, {
    method:  'PATCH',
    headers: pbHeaders(token),
    body:    JSON.stringify({ status: 'expired' }),
  })
  return { ...gc, status: 'expired' }
}

// ── Middlewares ───────────────────────────────────────────────────────────────
function requireUser(req, res, next) {
  const userId = (req.headers['x-user-id'] || '').trim()
  if (!userId || userId.length < 5) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  req.userId = userId
  req.userRole = (req.headers['x-user-role'] || '').trim()
  next()
}

function requireVendorOrAdmin(req, res, next) {
  const userId = (req.headers['x-user-id'] || '').trim()
  const role   = (req.headers['x-user-role'] || '').trim()
  if (!userId || !['vendor', 'admin'].includes(role)) {
    return res.status(403).json({ error: 'forbidden' })
  }
  req.userId = userId
  req.userRole = role
  next()
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ service: 'giftcard-service', ok: true, port: PORT })
})

// ── GET / — Listar gift cards del usuario ─────────────────────────────────────
// Devuelve las gift cards que el usuario ha canjeado (tabla giftcards)
app.get('/', requireUser, async (req, res) => {
  try {
    const token  = await getAdminToken()
    const userId = safeId(req.userId)
    const storeId = safeId(req.query.storeId || '')
    const status  = String(req.query.status || '').trim()
    const activeOnly = req.query.activeOnly === 'true' || req.query.activeOnly === '1'

    let filter = `owner="${userId}"`
    if (storeId) filter += ` && store="${storeId}"`
    if (status) {
      filter += ` && status="${status.replace(/[^a-z]/gi, '')}"`
    } else if (activeOnly) {
      filter += ` && status="active"`
    }

    const params = new URLSearchParams({
      filter,
      expand:  'store,source_code',
      sort:    '-created',
      perPage: '100',
      page:    '1',
    })

    const pbRes = await fetch(
      `${PB_URL}/api/collections/giftcards/records?${params}`,
      { headers: pbHeaders(token) }
    )

    if (!pbRes.ok) {
      const details = await readJsonSafe(pbRes)
      return res.status(pbRes.status).json({ error: 'pb_error', details })
    }

    const data = await pbRes.json()
    const items = []
    for (const raw of (data.items || [])) {
      const gc = await autoExpireGiftcard(token, raw)
      // Si pediste activeOnly o status=active, descarta los que ya expiraron.
      if ((activeOnly || status === 'active') && gc.status !== 'active') continue
      // Si pidió una tienda, sólo retorna gift cards bound a esa tienda (defensa extra).
      if (storeId) {
        const gcStoreId = Array.isArray(gc.store) ? gc.store[0] : gc.store
        if (!gcStoreId || gcStoreId !== storeId) continue
      }
      items.push(gc)
    }
    res.json({ items, total: items.length })
  } catch (err) {
    console.error('[giftcard] list error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── GET /codes — Listar códigos de gift card (vendor/admin) ──────────────────
app.get('/codes', requireVendorOrAdmin, async (req, res) => {
  try {
    const token   = await getAdminToken()
    const userId  = req.userId
    const role    = req.userRole
    const storeId = safeId(req.query.storeId || '')
    const status  = String(req.query.status || '')
    const page    = Math.max(1, Number(req.query.page) || 1)
    const perPage = Math.min(50, Math.max(1, Number(req.query.perPage) || 20))

    let filter = ''

    if (role === 'admin') {
      if (storeId) filter = `store="${storeId}"`
      if (status)  filter = filter ? `${filter} && status="${status}"` : `status="${status}"`
    } else {
      // vendor: solo puede ver códigos de sus tiendas
      if (!storeId) return res.status(400).json({ error: 'bad_request', message: 'storeId requerido para vendor' })

      // Verificar que la tienda pertenece al vendor
      const storeRes = await fetch(
        `${PB_URL}/api/collections/stores/records/${storeId}`,
        { headers: pbHeaders(token) }
      )
      if (!storeRes.ok) return res.status(404).json({ error: 'store_not_found' })
      const store = await storeRes.json()
      const owners = Array.isArray(store.owner) ? store.owner : [store.owner]
      if (!owners.includes(userId)) return res.status(403).json({ error: 'forbidden' })

      filter = `store="${storeId}"`
      if (status) filter += ` && status="${status}"`
    }

    const params = new URLSearchParams({
      sort:    '-created',
      expand:  'store,created_by',
      page:    String(page),
      perPage: String(perPage),
    })
    if (filter) params.set('filter', filter)

    const pbRes = await fetch(
      `${PB_URL}/api/collections/giftcard_codes/records?${params}`,
      { headers: pbHeaders(token) }
    )

    if (!pbRes.ok) {
      const details = await readJsonSafe(pbRes)
      return res.status(pbRes.status).json({ error: 'pb_error', details })
    }

    const data = await pbRes.json()
    res.json({ items: data.items || [], total: data.totalItems || 0, page, perPage })
  } catch (err) {
    console.error('[giftcard] list codes error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── POST /codes — Crear código de gift card (vendor/admin) ───────────────────
app.post('/codes', requireVendorOrAdmin, async (req, res) => {
  try {
    const token  = await getAdminToken()
    const userId = req.userId
    const role   = req.userRole

    const { code, amount, currency, usage_type, max_redemptions, expires_at, storeId } = req.body

    const cleanCode = safeCode(code || '')
    if (!cleanCode || cleanCode.length < 6) {
      return res.status(400).json({ error: 'bad_request', message: 'Código inválido (min 6 chars, solo A-Z 0-9 _ -)' })
    }
    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ error: 'bad_request', message: 'amount debe ser mayor a 0' })
    }
    if (!storeId) {
      return res.status(400).json({ error: 'bad_request', message: 'storeId es requerido' })
    }

    // Verificar propiedad de tienda si es vendor
    if (role !== 'admin') {
      const storeRes = await fetch(
        `${PB_URL}/api/collections/stores/records/${safeId(storeId)}`,
        { headers: pbHeaders(token) }
      )
      if (!storeRes.ok) return res.status(404).json({ error: 'store_not_found' })
      const store = await storeRes.json()
      const owners = Array.isArray(store.owner) ? store.owner : [store.owner]
      if (!owners.includes(userId)) return res.status(403).json({ error: 'forbidden' })
    }

    const payload = {
      code:             cleanCode,
      amount:           Number(amount),
      currency:         currency || 'BS',
      status:           'active',
      usage_type:       usage_type || 'single_use',
      max_redemptions:  max_redemptions ? Number(max_redemptions) : null,
      redeemed_count:   0,
      expires_at:       expires_at || null,
      store:            safeId(storeId),
      created_by:       userId,
    }

    const pbRes = await fetch(`${PB_URL}/api/collections/giftcard_codes/records`, {
      method:  'POST',
      headers: pbHeaders(token),
      body:    JSON.stringify(payload),
    })

    if (!pbRes.ok) {
      const details = await readJsonSafe(pbRes)
      return res.status(pbRes.status).json({ error: 'pb_error', details })
    }

    const record = await pbRes.json()
    res.status(201).json({ ok: true, item: record })
  } catch (err) {
    console.error('[giftcard] create code error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── PATCH /codes/:id — Actualizar código (vendor/admin) ──────────────────────
app.patch('/codes/:id', requireVendorOrAdmin, async (req, res) => {
  try {
    const token  = await getAdminToken()
    const userId = req.userId
    const role   = req.userRole
    const codeId = safeId(req.params.id)

    // Obtener el código existente
    const getRes = await fetch(
      `${PB_URL}/api/collections/giftcard_codes/records/${codeId}?expand=store`,
      { headers: pbHeaders(token) }
    )
    if (!getRes.ok) return res.status(404).json({ error: 'not_found' })
    const existing = await getRes.json()

    if (role !== 'admin') {
      const store  = existing.expand?.store
      const owners = Array.isArray(store?.owner) ? store.owner : [store?.owner]
      if (!owners.includes(userId)) return res.status(403).json({ error: 'forbidden' })
    }

    const allowed = ['status', 'expires_at', 'max_redemptions']
    const patch   = {}
    for (const key of allowed) {
      if (req.body[key] !== undefined) patch[key] = req.body[key]
    }

    // Si se fija expiración en el pasado, forzar estado expirado.
    if (patch.expires_at && new Date(patch.expires_at) < new Date()) {
      patch.status = 'expired'
    }

    const pbRes = await fetch(`${PB_URL}/api/collections/giftcard_codes/records/${codeId}`, {
      method:  'PATCH',
      headers: pbHeaders(token),
      body:    JSON.stringify(patch),
    })

    if (!pbRes.ok) {
      const details = await readJsonSafe(pbRes)
      return res.status(pbRes.status).json({ error: 'pb_error', details })
    }

    const record = await pbRes.json()

    // Solo los códigos single_use invalidan giftcards emitidas al cancelar/expirar.
    await propagateCodeStatusToGiftcards(token, codeId, record.status, record.usage_type)

    res.json({ ok: true, item: record })
  } catch (err) {
    console.error('[giftcard] update code error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── DELETE /codes/:id — Eliminar código (admin) ──────────────────────────────
app.delete('/codes/:id', requireVendorOrAdmin, async (req, res) => {
  try {
    const token  = await getAdminToken()
    const role   = req.userRole
    if (role !== 'admin') return res.status(403).json({ error: 'forbidden', message: 'Solo admin puede eliminar códigos' })

    const codeId = safeId(req.params.id)
    const delRes = await fetch(
      `${PB_URL}/api/collections/giftcard_codes/records/${codeId}`,
      { method: 'DELETE', headers: pbHeaders(token) }
    )

    if (!delRes.ok && delRes.status !== 204) {
      const details = await readJsonSafe(delRes)
      return res.status(delRes.status).json({ error: 'pb_error', details })
    }

    res.json({ ok: true })
  } catch (err) {
    console.error('[giftcard] delete code error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── POST /redeem — El usuario canjea un código y obtiene una gift card ────────
app.post('/redeem', requireUser, async (req, res) => {
  try {
    const token  = await getAdminToken()
    const userId = safeId(req.userId)
    const code   = safeCode(req.body?.code || '')

    if (!code) return res.status(400).json({ error: 'bad_request', message: 'code es requerido' })

    // Buscar el código en el pool
    const findParams = new URLSearchParams({
      filter:  `code="${code}" && status="active"`,
      perPage: '1',
    })
    const findRes = await fetch(
      `${PB_URL}/api/collections/giftcard_codes/records?${findParams}`,
      { headers: pbHeaders(token) }
    )
    if (!findRes.ok) {
      const details = await readJsonSafe(findRes)
      return res.status(findRes.status).json({ error: 'pb_error', details })
    }
    const findData = await findRes.json()
    if (!findData.items?.length) {
      return res.status(404).json({ error: 'code_not_found', message: 'Código no válido o ya utilizado' })
    }

    const poolCode = findData.items[0]

    // El código debe estar asociado a una tienda; si no, no se puede usar.
    if (!poolCode.store) {
      return res.status(400).json({ error: 'code_no_store', message: 'Este código no está asociado a ninguna tienda.' })
    }

    // Verificar expiración
    if (poolCode.expires_at && new Date(poolCode.expires_at) < new Date()) {
      await fetch(`${PB_URL}/api/collections/giftcard_codes/records/${poolCode.id}`, {
        method:  'PATCH',
        headers: pbHeaders(token),
        body:    JSON.stringify({ status: 'expired' }),
      })
      await propagateCodeStatusToGiftcards(token, poolCode.id, 'expired', poolCode.usage_type)
      return res.status(400).json({ error: 'code_expired', message: 'Este código ha expirado' })
    }

    // Verificar si el usuario ya tiene una gift card con este código fuente
    const dupParams = new URLSearchParams({
      filter:  `owner="${userId}" && source_code="${poolCode.id}"`,
      fields:  'id',
      perPage: '1',
    })
    const dupRes = await fetch(
      `${PB_URL}/api/collections/giftcards/records?${dupParams}`,
      { headers: pbHeaders(token) }
    )
    if (dupRes.ok) {
      const dupData = await dupRes.json()
      if (dupData.items?.length > 0) {
        return res.status(409).json({ error: 'already_redeemed', message: 'Ya canjeaste este código' })
      }
    }

    // Verificar límite de usos si aplica
    if (poolCode.usage_type === 'single_use') {
      if (poolCode.redeemed_count >= 1) {
        return res.status(400).json({ error: 'code_exhausted', message: 'Este código ya fue utilizado' })
      }
    } else if (poolCode.max_redemptions) {
      if ((poolCode.redeemed_count || 0) >= poolCode.max_redemptions) {
        return res.status(400).json({ error: 'code_exhausted', message: 'Este código alcanzó su límite de usos' })
      }
    }

    // Crear la gift card del usuario
    const gcPayload = {
      code:        poolCode.code,
      owner:       userId,
      store:       poolCode.store || null,
      balance:     poolCode.amount,
      currency:    poolCode.currency,
      status:      'active',
      expires_at:  poolCode.expires_at || null,
      created_by:  userId,
      source_code: poolCode.id,
    }

    const createRes = await fetch(`${PB_URL}/api/collections/giftcards/records`, {
      method:  'POST',
      headers: pbHeaders(token),
      body:    JSON.stringify(gcPayload),
    })

    if (!createRes.ok) {
      const details = await readJsonSafe(createRes)
      return res.status(createRes.status).json({ error: 'pb_error', details })
    }

    const giftcard = await createRes.json()

    // Actualizar contador en el pool de códigos
    const newCount = (poolCode.redeemed_count || 0) + 1
    const isSingleUse = poolCode.usage_type === 'single_use'
    const reachedMax  = newCount >= (poolCode.max_redemptions || Infinity)
    const newStatus = (isSingleUse || reachedMax) ? 'redeemed' : poolCode.status

    await fetch(`${PB_URL}/api/collections/giftcard_codes/records/${poolCode.id}`, {
      method:  'PATCH',
      headers: pbHeaders(token),
      body:    JSON.stringify({ redeemed_count: newCount, status: newStatus }),
    })

    res.status(201).json({ ok: true, giftcard })
  } catch (err) {
    console.error('[giftcard] redeem error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── POST /validate — Validar gift card para usar en checkout ─────────────────
// Devuelve el saldo disponible sin consumirlo
app.post('/validate', requireUser, async (req, res) => {
  try {
    const token  = await getAdminToken()
    const userId = safeId(req.userId)
    const code   = safeCode(req.body?.code || '')
    const storeId = safeId(req.body?.storeId || '')

    if (!code) return res.status(400).json({ error: 'bad_request', message: 'code es requerido' })

    const params = new URLSearchParams({
      filter:  `owner="${userId}" && code="${code}" && status="active"`,
      expand:  'store',
      perPage: '1',
    })

    const pbRes = await fetch(
      `${PB_URL}/api/collections/giftcards/records?${params}`,
      { headers: pbHeaders(token) }
    )

    if (!pbRes.ok) {
      const details = await readJsonSafe(pbRes)
      return res.status(pbRes.status).json({ error: 'pb_error', details })
    }

    const data = await pbRes.json()
    if (!data.items?.length) {
      return res.status(404).json({ error: 'not_found', message: 'Gift card no encontrada o inactiva' })
    }

    const gc = data.items[0]

    // Las giftcards SIEMPRE deben estar asociadas a una tienda. Si no, no se permiten.
    const gcStoreId = Array.isArray(gc.store) ? gc.store[0] : gc.store
    if (!gcStoreId) {
      return res.status(400).json({
        error: 'store_mismatch',
        message: 'Esta gift card no tiene tienda asignada y no puede usarse.',
      })
    }

    if (Number(gc.balance || 0) <= 0) {
      await fetch(`${PB_URL}/api/collections/giftcards/records/${gc.id}`, {
        method:  'PATCH',
        headers: pbHeaders(token),
        body:    JSON.stringify({ status: 'redeemed', balance: 0 }),
      })
      return res.status(400).json({ error: 'empty', message: 'Esta gift card ya no tiene saldo disponible' })
    }

    // Si se envía tienda, validar que la gift card pertenezca a esa tienda.
    if (storeId && gcStoreId !== storeId) {
      return res.status(400).json({
        error: 'store_mismatch',
        message: 'La gift card solo se puede usar en la tienda que la emitió',
      })
    }

    // Verificar expiración
    if (gc.expires_at && new Date(gc.expires_at) < new Date()) {
      // Marcar como expirada
      await fetch(`${PB_URL}/api/collections/giftcards/records/${gc.id}`, {
        method:  'PATCH',
        headers: pbHeaders(token),
        body:    JSON.stringify({ status: 'expired' }),
      })
      return res.status(400).json({ error: 'expired', message: 'Esta gift card ha expirado' })
    }

    res.json({
      ok:       true,
      id:       gc.id,
      code:     gc.code,
      balance:  gc.balance,
      currency: gc.currency,
      store:    gc.store || null,
    })
  } catch (err) {
    console.error('[giftcard] validate error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.listen(PORT, () => {
  console.log(`giftcard-service running on port ${PORT}`)
})
