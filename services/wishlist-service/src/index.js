const express = require('express')
const cors    = require('cors')

const app  = express()
const PORT = Number(process.env.PORT || 9007)

app.use(cors())
app.use(express.json())

const PB_URL      = (process.env.POCKETBASE_URL || '').replace(/\/$/, '')
const PB_IDENTITY = process.env.POCKETBASE_AUTH_IDENTITY || ''
const PB_PASSWORD = process.env.POCKETBASE_AUTH_PASSWORD || ''

// ── Admin token cache (renovado cada 55 min) ─────────────────────────────────
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

// Sanitizar valores para filtros de PocketBase (prevenir injection)
function safeId(value) {
  return String(value || '').replace(/[^a-z0-9_]/gi, '').slice(0, 30)
}

// ── Middleware: requerir usuario autenticado ────────────────────────────────
function requireUser(req, res, next) {
  const userId = (req.headers['x-user-id'] || '').trim()
  if (!userId || userId.length < 5) {
    return res.status(401).json({ error: 'unauthorized', message: 'x-user-id header required' })
  }
  req.userId = userId
  next()
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ service: 'wishlist-service', ok: true, port: PORT })
})

// ── GET / — Listar wishlist del usuario (con expand de producto y tienda) ────
app.get('/', requireUser, async (req, res) => {
  try {
    const token  = await getAdminToken()
    const userId = safeId(req.userId)

    const params = new URLSearchParams({
      filter:  `user="${userId}"`,
      expand:  'product,product.store,product.category',
      sort:    '-created',
      perPage: '200',
      page:    '1',
    })

    const pbRes = await fetch(
      `${PB_URL}/api/collections/wishlists/records?${params}`,
      { headers: pbHeaders(token) }
    )

    if (!pbRes.ok) {
      const details = await readJsonSafe(pbRes)
      return res.status(pbRes.status).json({ error: 'pb_error', details })
    }

    const data = await pbRes.json()
    res.json({ items: data.items || [], total: data.totalItems || 0 })
  } catch (err) {
    console.error('[wishlist] list error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── POST / — Añadir producto a wishlist (evita duplicados) ───────────────────
app.post('/', requireUser, async (req, res) => {
  try {
    const token     = await getAdminToken()
    const userId    = safeId(req.userId)
    const productId = safeId(String(req.body?.productId || ''))

    if (!productId) {
      return res.status(400).json({ error: 'bad_request', message: 'productId es requerido' })
    }

    // Verificar duplicado antes de crear
    const dupParams = new URLSearchParams({
      filter:  `user="${userId}" && product="${productId}"`,
      fields:  'id',
      perPage: '1',
    })
    const dupRes = await fetch(
      `${PB_URL}/api/collections/wishlists/records?${dupParams}`,
      { headers: pbHeaders(token) }
    )

    if (dupRes.ok) {
      const dupData = await dupRes.json()
      if (dupData.items?.length > 0) {
        return res.status(409).json({
          error:   'already_in_wishlist',
          message: 'El producto ya está en la wishlist',
          id:      dupData.items[0].id,
        })
      }
    }

    // Crear registro
    const pbRes = await fetch(`${PB_URL}/api/collections/wishlists/records`, {
      method:  'POST',
      headers: pbHeaders(token),
      body:    JSON.stringify({ user: userId, product: productId }),
    })

    if (!pbRes.ok) {
      const details = await readJsonSafe(pbRes)
      return res.status(pbRes.status).json({ error: 'pb_error', details })
    }

    const record = await pbRes.json()
    res.status(201).json({ ok: true, id: record.id })
  } catch (err) {
    console.error('[wishlist] add error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── DELETE /by-product/:productId — Eliminar por productId ──────────────────
app.delete('/by-product/:productId', requireUser, async (req, res) => {
  try {
    const token     = await getAdminToken()
    const userId    = safeId(req.userId)
    const productId = safeId(req.params.productId)

    if (!productId) {
      return res.status(400).json({ error: 'bad_request', message: 'productId inválido' })
    }

    // Buscar el registro de la wishlist
    const findParams = new URLSearchParams({
      filter:  `user="${userId}" && product="${productId}"`,
      fields:  'id',
      perPage: '1',
    })
    const findRes = await fetch(
      `${PB_URL}/api/collections/wishlists/records?${findParams}`,
      { headers: pbHeaders(token) }
    )

    if (!findRes.ok) {
      return res.status(404).json({ error: 'not_found' })
    }

    const findData = await findRes.json()
    if (!findData.items?.length) {
      return res.status(404).json({ error: 'not_found', message: 'Producto no encontrado en wishlist' })
    }

    const wishlistId = findData.items[0].id
    const delRes = await fetch(
      `${PB_URL}/api/collections/wishlists/records/${wishlistId}`,
      { method: 'DELETE', headers: pbHeaders(token) }
    )

    if (!delRes.ok && delRes.status !== 204) {
      const details = await readJsonSafe(delRes)
      return res.status(delRes.status).json({ error: 'pb_error', details })
    }

    res.json({ ok: true })
  } catch (err) {
    console.error('[wishlist] remove by-product error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── DELETE /:id — Eliminar por ID de registro wishlist ──────────────────────
app.delete('/:id', requireUser, async (req, res) => {
  try {
    const token      = await getAdminToken()
    const userId     = safeId(req.userId)
    const wishlistId = req.params.id

    // Verificar propiedad antes de eliminar
    const getRes = await fetch(
      `${PB_URL}/api/collections/wishlists/records/${wishlistId}`,
      { headers: pbHeaders(token) }
    )

    if (getRes.status === 404) {
      return res.status(404).json({ error: 'not_found' })
    }
    if (!getRes.ok) {
      return res.status(getRes.status).json({ error: 'pb_error' })
    }

    const record = await getRes.json()
    if (record.user !== userId) {
      return res.status(403).json({ error: 'forbidden', message: 'No tienes permiso para eliminar este registro' })
    }

    const delRes = await fetch(
      `${PB_URL}/api/collections/wishlists/records/${wishlistId}`,
      { method: 'DELETE', headers: pbHeaders(token) }
    )

    if (!delRes.ok && delRes.status !== 204) {
      const details = await readJsonSafe(delRes)
      return res.status(delRes.status).json({ error: 'pb_error', details })
    }

    res.json({ ok: true })
  } catch (err) {
    console.error('[wishlist] remove error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.listen(PORT, () => {
  console.log(`wishlist-service running on port ${PORT}`)
})
