const express = require('express')
const cors    = require('cors')

const app  = express()
const PORT = Number(process.env.PORT || 9014)

app.use(cors())
app.use(express.json())

const PB_URL      = (process.env.POCKETBASE_URL || '').replace(/\/$/, '')
const PB_IDENTITY = process.env.POCKETBASE_AUTH_IDENTITY || ''
const PB_PASSWORD = process.env.POCKETBASE_AUTH_PASSWORD || ''

const TTL_DAYS = 10
const TTL_MS   = TTL_DAYS * 24 * 60 * 60 * 1000

// ── Admin token cache ────────────────────────────────────────────────────────
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

function nextExpiryIso() {
  return new Date(Date.now() + TTL_MS).toISOString().replace('T', ' ').replace('Z', 'Z')
}

function nowPbIso() {
  return new Date().toISOString().replace('T', ' ').replace('Z', 'Z')
}

function computeDiscountedPrice(product) {
  const base = Number(product.price || 0)
  const pct  = Number(product.discount_percent || 0)
  const amt  = Number(product.discount_amount  || 0)
  let price = base
  const now = Date.now()
  const startsAt = product.discount_starts_at ? Date.parse(product.discount_starts_at) : null
  const endsAt   = product.discount_ends_at   ? Date.parse(product.discount_ends_at)   : null
  const startsOk = !startsAt || now >= startsAt
  const endsOk   = !endsAt   || now <= endsAt
  if (startsOk && endsOk) {
    if (pct > 0)      price = base * (1 - pct / 100)
    else if (amt > 0) price = Math.max(0, base - amt)
  }
  return Math.round(price * 100) / 100
}

function requireUser(req, res, next) {
  const userId = (req.headers['x-user-id'] || '').trim()
  if (!userId || userId.length < 5) {
    return res.status(401).json({ error: 'unauthorized', message: 'x-user-id header required' })
  }
  req.userId = userId
  next()
}

// Borra los ítems expirados del usuario antes de listar/operar
async function purgeExpiredForUser(token, userId) {
  const params = new URLSearchParams({
    filter:  `user="${userId}" && expires_at<"${nowPbIso()}"`,
    fields:  'id',
    perPage: '200',
  })
  const findRes = await fetch(
    `${PB_URL}/api/collections/cart_items/records?${params}`,
    { headers: pbHeaders(token) }
  )
  if (!findRes.ok) return
  const data = await findRes.json()
  const items = data.items || []
  await Promise.all(items.map((it) =>
    fetch(`${PB_URL}/api/collections/cart_items/records/${it.id}`, {
      method: 'DELETE', headers: pbHeaders(token),
    }).catch(() => null)
  ))
}

async function fetchProduct(token, productId) {
  const res = await fetch(
    `${PB_URL}/api/collections/products/records/${productId}?expand=store`,
    { headers: pbHeaders(token) }
  )
  if (!res.ok) return null
  return res.json()
}

async function findCartItem(token, userId, productId) {
  const params = new URLSearchParams({
    filter:  `user="${userId}" && product="${productId}"`,
    perPage: '1',
  })
  const res = await fetch(
    `${PB_URL}/api/collections/cart_items/records?${params}`,
    { headers: pbHeaders(token) }
  )
  if (!res.ok) return null
  const data = await res.json()
  return data.items?.[0] || null
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ service: 'cart-service', ok: true, port: PORT })
})

// ── GET / — listar carrito del usuario ───────────────────────────────────────
app.get('/', requireUser, async (req, res) => {
  try {
    const token  = await getAdminToken()
    const userId = safeId(req.userId)

    await purgeExpiredForUser(token, userId)

    const params = new URLSearchParams({
      filter:  `user="${userId}"`,
      expand:  'product,product.store,product.category',
      sort:    '-updated',
      perPage: '200',
    })

    const pbRes = await fetch(
      `${PB_URL}/api/collections/cart_items/records?${params}`,
      { headers: pbHeaders(token) }
    )

    if (!pbRes.ok) {
      const details = await readJsonSafe(pbRes)
      return res.status(pbRes.status).json({ error: 'pb_error', details })
    }

    const data = await pbRes.json()
    res.json({ items: data.items || [], total: data.totalItems || 0, ttl_days: TTL_DAYS })
  } catch (err) {
    console.error('[cart] list error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── POST / — agregar producto (o incrementar cantidad) ───────────────────────
app.post('/', requireUser, async (req, res) => {
  try {
    const token     = await getAdminToken()
    const userId    = safeId(req.userId)
    const productId = safeId(String(req.body?.productId || ''))
    const qtyDelta  = Math.max(1, Number(req.body?.quantity || 1))

    if (!productId) {
      return res.status(400).json({ error: 'bad_request', message: 'productId requerido' })
    }

    const product = await fetchProduct(token, productId)
    if (!product) {
      return res.status(404).json({ error: 'product_not_found' })
    }
    if (product.status !== 'active') {
      return res.status(409).json({ error: 'product_not_available' })
    }

    const stock = Number(product.stock || 0)
    if (stock <= 0) {
      return res.status(409).json({ error: 'out_of_stock' })
    }

    const priceSnapshot = computeDiscountedPrice(product)
    const existing = await findCartItem(token, userId, productId)

    let record
    if (existing) {
      const newQty = Math.min(existing.quantity + qtyDelta, stock)
      const upRes = await fetch(
        `${PB_URL}/api/collections/cart_items/records/${existing.id}`,
        {
          method:  'PATCH',
          headers: pbHeaders(token),
          body:    JSON.stringify({
            quantity:       newQty,
            price_snapshot: priceSnapshot,
            expires_at:     nextExpiryIso(),
          }),
        }
      )
      if (!upRes.ok) {
        const details = await readJsonSafe(upRes)
        return res.status(upRes.status).json({ error: 'pb_error', details })
      }
      record = await upRes.json()
    } else {
      const createRes = await fetch(`${PB_URL}/api/collections/cart_items/records`, {
        method:  'POST',
        headers: pbHeaders(token),
        body:    JSON.stringify({
          user:           userId,
          product:        productId,
          quantity:       Math.min(qtyDelta, stock),
          price_snapshot: priceSnapshot,
          expires_at:     nextExpiryIso(),
        }),
      })
      if (!createRes.ok) {
        const details = await readJsonSafe(createRes)
        return res.status(createRes.status).json({ error: 'pb_error', details })
      }
      record = await createRes.json()
    }

    res.status(existing ? 200 : 201).json({ ok: true, id: record.id, quantity: record.quantity })
  } catch (err) {
    console.error('[cart] add error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── PATCH /by-product/:productId — actualizar cantidad ───────────────────────
app.patch('/by-product/:productId', requireUser, async (req, res) => {
  try {
    const token     = await getAdminToken()
    const userId    = safeId(req.userId)
    const productId = safeId(req.params.productId)
    const quantity  = Number(req.body?.quantity)

    if (!Number.isFinite(quantity)) {
      return res.status(400).json({ error: 'bad_request', message: 'quantity inválida' })
    }

    const existing = await findCartItem(token, userId, productId)
    if (!existing) {
      return res.status(404).json({ error: 'not_found' })
    }

    if (quantity <= 0) {
      const delRes = await fetch(
        `${PB_URL}/api/collections/cart_items/records/${existing.id}`,
        { method: 'DELETE', headers: pbHeaders(token) }
      )
      if (!delRes.ok && delRes.status !== 204) {
        const details = await readJsonSafe(delRes)
        return res.status(delRes.status).json({ error: 'pb_error', details })
      }
      return res.json({ ok: true, deleted: true })
    }

    const product = await fetchProduct(token, productId)
    const stock = Number(product?.stock || existing.quantity)
    const newQty = Math.min(quantity, stock)

    const upRes = await fetch(
      `${PB_URL}/api/collections/cart_items/records/${existing.id}`,
      {
        method:  'PATCH',
        headers: pbHeaders(token),
        body:    JSON.stringify({ quantity: newQty, expires_at: nextExpiryIso() }),
      }
    )
    if (!upRes.ok) {
      const details = await readJsonSafe(upRes)
      return res.status(upRes.status).json({ error: 'pb_error', details })
    }
    const record = await upRes.json()
    res.json({ ok: true, id: record.id, quantity: record.quantity })
  } catch (err) {
    console.error('[cart] update error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── DELETE /by-product/:productId — eliminar un ítem por producto ─────────────
app.delete('/by-product/:productId', requireUser, async (req, res) => {
  try {
    const token     = await getAdminToken()
    const userId    = safeId(req.userId)
    const productId = safeId(req.params.productId)

    const existing = await findCartItem(token, userId, productId)
    if (!existing) {
      return res.status(404).json({ error: 'not_found' })
    }

    const delRes = await fetch(
      `${PB_URL}/api/collections/cart_items/records/${existing.id}`,
      { method: 'DELETE', headers: pbHeaders(token) }
    )
    if (!delRes.ok && delRes.status !== 204) {
      const details = await readJsonSafe(delRes)
      return res.status(delRes.status).json({ error: 'pb_error', details })
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('[cart] remove error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── DELETE /store/:storeId — vaciar carrito de una tienda ────────────────────
app.delete('/store/:storeId', requireUser, async (req, res) => {
  try {
    const token   = await getAdminToken()
    const userId  = safeId(req.userId)
    const storeId = safeId(req.params.storeId)

    const params = new URLSearchParams({
      filter:  `user="${userId}" && product.store="${storeId}"`,
      fields:  'id',
      perPage: '200',
    })
    const findRes = await fetch(
      `${PB_URL}/api/collections/cart_items/records?${params}`,
      { headers: pbHeaders(token) }
    )
    if (!findRes.ok) {
      const details = await readJsonSafe(findRes)
      return res.status(findRes.status).json({ error: 'pb_error', details })
    }
    const data = await findRes.json()
    const items = data.items || []

    await Promise.all(items.map((it) =>
      fetch(`${PB_URL}/api/collections/cart_items/records/${it.id}`, {
        method: 'DELETE', headers: pbHeaders(token),
      }).catch(() => null)
    ))

    res.json({ ok: true, removed: items.length })
  } catch (err) {
    console.error('[cart] clear-store error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── DELETE / — vaciar carrito completo del usuario ───────────────────────────
app.delete('/', requireUser, async (req, res) => {
  try {
    const token  = await getAdminToken()
    const userId = safeId(req.userId)

    const params = new URLSearchParams({
      filter:  `user="${userId}"`,
      fields:  'id',
      perPage: '200',
    })
    const findRes = await fetch(
      `${PB_URL}/api/collections/cart_items/records?${params}`,
      { headers: pbHeaders(token) }
    )
    if (!findRes.ok) {
      const details = await readJsonSafe(findRes)
      return res.status(findRes.status).json({ error: 'pb_error', details })
    }
    const data = await findRes.json()
    const items = data.items || []

    await Promise.all(items.map((it) =>
      fetch(`${PB_URL}/api/collections/cart_items/records/${it.id}`, {
        method: 'DELETE', headers: pbHeaders(token),
      }).catch(() => null)
    ))

    res.json({ ok: true, removed: items.length })
  } catch (err) {
    console.error('[cart] clear-all error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── POST /merge — fusionar carrito de invitado al loguearse ──────────────────
// body: { items: [{ productId, quantity }, ...] }
app.post('/merge', requireUser, async (req, res) => {
  try {
    const token  = await getAdminToken()
    const userId = safeId(req.userId)
    const incoming = Array.isArray(req.body?.items) ? req.body.items : []

    let merged = 0
    for (const raw of incoming) {
      const productId = safeId(String(raw?.productId || ''))
      const qty       = Math.max(1, Number(raw?.quantity || 1))
      if (!productId) continue

      const product = await fetchProduct(token, productId)
      if (!product || product.status !== 'active') continue
      const stock = Number(product.stock || 0)
      if (stock <= 0) continue

      const priceSnapshot = computeDiscountedPrice(product)
      const existing = await findCartItem(token, userId, productId)

      if (existing) {
        const newQty = Math.min(existing.quantity + qty, stock)
        await fetch(`${PB_URL}/api/collections/cart_items/records/${existing.id}`, {
          method:  'PATCH',
          headers: pbHeaders(token),
          body:    JSON.stringify({
            quantity:       newQty,
            price_snapshot: priceSnapshot,
            expires_at:     nextExpiryIso(),
          }),
        })
      } else {
        await fetch(`${PB_URL}/api/collections/cart_items/records`, {
          method:  'POST',
          headers: pbHeaders(token),
          body:    JSON.stringify({
            user:           userId,
            product:        productId,
            quantity:       Math.min(qty, stock),
            price_snapshot: priceSnapshot,
            expires_at:     nextExpiryIso(),
          }),
        })
      }
      merged++
    }

    res.json({ ok: true, merged })
  } catch (err) {
    console.error('[cart] merge error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.listen(PORT, () => {
  console.log(`cart-service running on port ${PORT}`)
})
