const express = require('express')
const cors    = require('cors')
const multer  = require('multer')

const app    = express()
const PORT   = Number(process.env.PORT || 9005)
const upload = multer({ storage: multer.memoryStorage() })

app.use(cors())
app.use(express.json())

const PB_URL      = (process.env.POCKETBASE_URL || '').replace(/\/$/, '')
const PB_IDENTITY = process.env.POCKETBASE_AUTH_IDENTITY || ''
const PB_PASSWORD = process.env.POCKETBASE_AUTH_PASSWORD || ''
const TRANSACTION_SERVICE_URL = (process.env.TRANSACTION_SERVICE_URL || 'http://transaction-service:9013').replace(/\/$/, '')

// Fire-and-forget: notifica al transaction-service para que cree la transacción
// asociada a la orden. No bloquea ni falla la request principal si el hook falla.
function notifyOrderTransaction(orderId) {
  if (!orderId) return
  fetch(`${TRANSACTION_SERVICE_URL}/hooks/order/${orderId}`, { method: 'POST' })
    .then(async (r) => {
      if (!r.ok) console.error(`[order] tx hook ${orderId} failed: ${r.status}`)
    })
    .catch((err) => console.error(`[order] tx hook ${orderId} error:`, err.message))
}

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
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: PB_IDENTITY, password: PB_PASSWORD }),
  })
  if (!res.ok) throw new Error(`PB admin auth failed: ${res.status}`)
  const { token } = await res.json()
  _adminToken = token
  _adminTokenExpiry = Date.now() + 55 * 60 * 1000
  return token
}

function pbHeaders(token) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
}

function requireAuth(req, res, next) {
  const userId = (req.headers['x-user-id'] || '').trim()
  const role   = (req.headers['x-user-role'] || '').trim()
  if (!userId || !['vendor', 'admin'].includes(role)) {
    return res.status(403).json({ error: 'forbidden' })
  }
  next()
}

function userOwnsStore(store, userId) {
  const owners = Array.isArray(store?.owner)
    ? store.owner
    : (store?.owner ? [store.owner] : [])
  return owners.includes(userId)
}

async function checkOrderOwnership(token, orderId, userId) {
  // Vendedor puede gestionar si es owner de la tienda del pedido
  const res = await fetch(
    `${PB_URL}/api/collections/orders/records/${orderId}?expand=store`,
    { headers: pbHeaders(token) }
  )
  if (!res.ok) return null
  const order = await res.json()
  const isOwner = userOwnsStore(order?.expand?.store, userId)
  return { order, isOwner }
}

// ── Health ─────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ service: 'order-service', ok: true, port: PORT }))

// ── Listar órdenes ─────────────────────────────────────────────────────────────
// GET /?storeId=X&status=&page=1&perPage=20
app.get('/', requireAuth, async (req, res) => {
  try {
    const token   = await getAdminToken()
    const userId  = req.headers['x-user-id']
    const role    = req.headers['x-user-role']
    const page    = Math.max(1, parseInt(req.query.page) || 1)
    const perPage = Math.min(100, parseInt(req.query.perPage) || 20)

    const filters = []

    // Para vendors, siempre cargamos sus tiendas para validar ownership.
    // Si pasan ?storeId=X, debe pertenecerle; si no pasan nada, filtramos por todas las suyas.
    let vendorStoreIds = null
    if (role === 'vendor') {
      const storesRes = await fetch(
        `${PB_URL}/api/collections/stores/records?fields=id,owner&perPage=200`,
        { headers: pbHeaders(token) }
      )
      const storesData = storesRes.ok ? await readJsonSafe(storesRes) : null
      vendorStoreIds = (storesData?.items || [])
        .filter((store) => userOwnsStore(store, userId))
        .map((store) => store.id)
    }

    if (req.query.storeId) {
      const requestedStoreId = String(req.query.storeId).replace(/"/g, '')
      if (role === 'vendor' && !vendorStoreIds.includes(requestedStoreId)) {
        return res.status(403).json({ error: 'forbidden' })
      }
      filters.push(`store="${requestedStoreId}"`)
    } else if (role === 'vendor') {
      if (!vendorStoreIds.length) return res.json({ items: [], totalItems: 0, totalPages: 0 })
      filters.push(`(${vendorStoreIds.map(id => `store="${id}"`).join(' || ')})`)
    }

    if (req.query.status) filters.push(`status="${req.query.status.replace(/"/g, '')}"`)
    if (req.query.search) filters.push(`payment_reference~"${req.query.search.replace(/"/g, '')}"`)

    const params = new URLSearchParams({
      page, perPage,
      sort: req.query.sort || '-created',
      expand: 'buyer,store,shipping_address_ref',
    })
    if (filters.length) params.set('filter', filters.join(' && '))

    const pbRes = await fetch(
      `${PB_URL}/api/collections/orders/records?${params}`,
      { headers: pbHeaders(token) }
    )
    const data = await readJsonSafe(pbRes)
    if (!pbRes.ok) return res.status(pbRes.status).json(data)

    // Enriquecer con items de cada orden
    if (data?.items?.length) {
      const orderIds = data.items.map(o => `order="${o.id}"`).join(' || ')
      const itemsRes = await fetch(
        `${PB_URL}/api/collections/order_items/records?filter=${encodeURIComponent(orderIds)}&perPage=200&expand=product`,
        { headers: pbHeaders(token) }
      )
      if (itemsRes.ok) {
        const itemsData = await readJsonSafe(itemsRes)
        const itemsByOrder = {}
        for (const item of (itemsData?.items || [])) {
          if (!itemsByOrder[item.order]) itemsByOrder[item.order] = []
          itemsByOrder[item.order].push(item)
        }
        for (const order of data.items) {
          order.items = itemsByOrder[order.id] || []
        }
      }
    }

    res.json(data)
  } catch (err) {
    console.error('list orders error', err)
    res.status(500).json({ error: err.message })
  }
})

// ── Obtener orden ──────────────────────────────────────────────────────────────
app.get('/:id([a-z0-9]{15})', requireAuth, async (req, res) => {
  try {
    const token  = await getAdminToken()
    const userId = req.headers['x-user-id']
    const role   = req.headers['x-user-role']

    const pbRes = await fetch(
      `${PB_URL}/api/collections/orders/records/${req.params.id}?expand=buyer,store,approved_by,shipping_address_ref`,
      { headers: pbHeaders(token) }
    )
    if (pbRes.status === 404) return res.status(404).json({ error: 'not_found' })
    const order = await readJsonSafe(pbRes)
    if (!pbRes.ok) return res.status(pbRes.status).json(order)

    if (role === 'vendor' && !userOwnsStore(order?.expand?.store, userId)) {
      return res.status(403).json({ error: 'forbidden' })
    }

    // Items de la orden
    const itemsRes = await fetch(
      `${PB_URL}/api/collections/order_items/records?filter=order%3D%22${req.params.id}%22&perPage=50&expand=product`,
      { headers: pbHeaders(token) }
    )
    if (itemsRes.ok) {
      const itemsData = await readJsonSafe(itemsRes)
      order.items = itemsData?.items || []
    }

    res.json(order)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Proxy seguro de comprobante de pago (vendor/admin) ──────────────────────
app.get('/files/orders/:id/:filename', requireAuth, async (req, res) => {
  try {
    const token  = await getAdminToken()
    const userId = (req.headers['x-user-id'] || '').trim()
    const role   = (req.headers['x-user-role'] || '').trim()

    const ownership = await checkOrderOwnership(token, req.params.id, userId)
    if (!ownership?.order) return res.status(404).json({ error: 'not_found' })
    if (role === 'vendor' && !ownership.isOwner) return res.status(403).json({ error: 'forbidden' })

    const order = ownership.order
    if (!order.payment_proof) return res.status(404).json({ error: 'proof_not_found' })

    const fromOrder = Array.isArray(order.payment_proof)
      ? order.payment_proof.filter(Boolean)
      : [order.payment_proof].filter(Boolean)
    const fromParam = [req.params.filename].filter(Boolean)
    const candidateNames = [...new Set([...fromOrder, ...fromParam])]
    if (!candidateNames.length) return res.status(404).json({ error: 'proof_not_found' })

    let fileToken = ''
    try {
      const tokenRes = await fetch(`${PB_URL}/api/files/token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (tokenRes.ok) {
        const tokenData = await readJsonSafe(tokenRes)
        fileToken = tokenData?.token || ''
      }
    } catch {
      fileToken = ''
    }

    let fileRes = null
    for (const filename of candidateNames) {
      const encodedOrderId = encodeURIComponent(order.id)
      const encodedFilename = encodeURIComponent(filename)

      if (fileToken) {
        const withTokenUrl = `${PB_URL}/api/files/orders/${encodedOrderId}/${encodedFilename}?token=${encodeURIComponent(fileToken)}`
        const withTokenRes = await fetch(withTokenUrl)
        if (withTokenRes.ok) {
          fileRes = withTokenRes
          break
        }
      }

      const withAuthUrl = `${PB_URL}/api/files/orders/${encodedOrderId}/${encodedFilename}`
      const withAuthRes = await fetch(withAuthUrl, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (withAuthRes.ok) {
        fileRes = withAuthRes
        break
      }
    }

    if (!fileRes?.ok) {
      return res.status(404).json({ error: 'proof_fetch_failed' })
    }

    const contentType = fileRes.headers.get('content-type')
    if (contentType) res.setHeader('Content-Type', contentType)

    const buffer = Buffer.from(await fileRes.arrayBuffer())
    return res.send(buffer)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// ── Aprobar orden ──────────────────────────────────────────────────────────────
// PATCH /:id/approve  body: { approval_note }
app.patch('/:id/approve', requireAuth, async (req, res) => {
  try {
    const token  = await getAdminToken()
    const userId = req.headers['x-user-id']
    const role   = req.headers['x-user-role']

    const result = await checkOrderOwnership(token, req.params.id, userId)
    if (!result) return res.status(404).json({ error: 'not_found' })
    if (role === 'vendor' && !result.isOwner) return res.status(403).json({ error: 'forbidden' })

    const { approval_note, shipping_address, lat, lng } = req.body

    const currentShipping = (result.order?.shipping_address && typeof result.order.shipping_address === 'object')
      ? result.order.shipping_address
      : {}
    const normalizedShipping = (shipping_address && typeof shipping_address === 'object')
      ? {
          name: sanitizeText(shipping_address.name ?? currentShipping.name, 120),
          phone: sanitizeText(shipping_address.phone ?? currentShipping.phone, 30),
          address: sanitizeText(shipping_address.address ?? currentShipping.address, 240),
          city: sanitizeText(shipping_address.city ?? currentShipping.city, 100),
          notes: sanitizeText(shipping_address.notes ?? currentShipping.notes, 240),
          lat: null,
          lng: null,
        }
      : null

    if (normalizedShipping) {
      const fromShipping = parseGeoPoint(shipping_address)
      const fromLegacy = parseGeoPoint({ lat, lng })
      const geo = fromShipping || fromLegacy || parseGeoPoint(currentShipping)
      normalizedShipping.lat = geo?.lat ?? null
      normalizedShipping.lng = geo?.lng ?? null
    }

    const payload = {
      status: 'approved',
      approved_by: userId,
      approved_at: new Date().toISOString(),
    }
    if (approval_note)     payload.approval_note = approval_note
    if (normalizedShipping) payload.shipping_address = normalizedShipping

    const pbRes = await fetch(
      `${PB_URL}/api/collections/orders/records/${req.params.id}`,
      { method: 'PATCH', headers: pbHeaders(token), body: JSON.stringify(payload) }
    )
    const data = await readJsonSafe(pbRes)
    if (!pbRes.ok) return res.status(pbRes.status).json({ error: 'approve_failed', details: data })
    notifyOrderTransaction(req.params.id)
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Rechazar orden ─────────────────────────────────────────────────────────────
app.patch('/:id/reject', requireAuth, async (req, res) => {
  try {
    const token  = await getAdminToken()
    const userId = req.headers['x-user-id']
    const role   = req.headers['x-user-role']

    const result = await checkOrderOwnership(token, req.params.id, userId)
    if (!result) return res.status(404).json({ error: 'not_found' })
    if (role === 'vendor' && !result.isOwner) return res.status(403).json({ error: 'forbidden' })

    const pbRes = await fetch(
      `${PB_URL}/api/collections/orders/records/${req.params.id}`,
      {
        method: 'PATCH',
        headers: pbHeaders(token),
        body: JSON.stringify({
          status: 'rejected',
          approved_by: userId,
          approved_at: new Date().toISOString(),
          approval_note: req.body.reason || '',
        }),
      }
    )
    const data = await readJsonSafe(pbRes)
    if (!pbRes.ok) return res.status(pbRes.status).json({ error: 'reject_failed', details: data })
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Marcar como enviado ────────────────────────────────────────────────────────
app.patch('/:id/ship', requireAuth, async (req, res) => {
  try {
    const token  = await getAdminToken()
    const userId = req.headers['x-user-id']
    const role   = req.headers['x-user-role']

    const result = await checkOrderOwnership(token, req.params.id, userId)
    if (!result) return res.status(404).json({ error: 'not_found' })
    if (role === 'vendor' && !result.isOwner) return res.status(403).json({ error: 'forbidden' })

    const pbRes = await fetch(
      `${PB_URL}/api/collections/orders/records/${req.params.id}`,
      {
        method: 'PATCH',
        headers: pbHeaders(token),
        body: JSON.stringify({ status: 'shipped' }),
      }
    )
    const data = await readJsonSafe(pbRes)
    if (!pbRes.ok) return res.status(pbRes.status).json({ error: 'ship_failed', details: data })
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Marcar como entregado ──────────────────────────────────────────────────────
app.patch('/:id/deliver', requireAuth, async (req, res) => {
  try {
    const token  = await getAdminToken()
    const userId = req.headers['x-user-id']
    const role   = req.headers['x-user-role']

    const result = await checkOrderOwnership(token, req.params.id, userId)
    if (!result) return res.status(404).json({ error: 'not_found' })
    if (role === 'vendor' && !result.isOwner) return res.status(403).json({ error: 'forbidden' })

    const pbRes = await fetch(
      `${PB_URL}/api/collections/orders/records/${req.params.id}`,
      { method: 'PATCH', headers: pbHeaders(token), body: JSON.stringify({ status: 'delivered' }) }
    )
    const data = await readJsonSafe(pbRes)
    if (!pbRes.ok) return res.status(pbRes.status).json({ error: 'deliver_failed', details: data })
    notifyOrderTransaction(req.params.id)
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Stats de órdenes por tienda ────────────────────────────────────────────────
app.get('/vendor/stats/:storeId', requireAuth, async (req, res) => {
  try {
    const token = await getAdminToken()
    const userId = req.headers['x-user-id']
    const role   = req.headers['x-user-role']
    const sid   = req.params.storeId.replace(/"/g, '')
    const enc   = encodeURIComponent

    if (role === 'vendor') {
      const storeRes = await fetch(
        `${PB_URL}/api/collections/stores/records/${sid}?fields=id,owner`,
        { headers: pbHeaders(token) }
      )
      if (!storeRes.ok) return res.status(404).json({ error: 'store_not_found' })
      const store = await readJsonSafe(storeRes)
      if (!userOwnsStore(store, userId)) return res.status(403).json({ error: 'forbidden' })
    }

    const countStatus = async (status) => {
      const r = await fetch(
        `${PB_URL}/api/collections/orders/records?page=1&perPage=1&fields=id&filter=${enc(`store="${sid}" && status="${status}"`)}`,
        { headers: pbHeaders(token) }
      )
      const d = await readJsonSafe(r)
      return Number(d?.totalItems || 0)
    }

    const [pending, approved, shipped, delivered, rejected, cancelled] = await Promise.all([
      countStatus('payment_uploaded'),
      countStatus('approved'),
      countStatus('shipped'),
      countStatus('delivered'),
      countStatus('rejected'),
      countStatus('cancelled'),
    ])

    res.json({ pending, approved, shipped, delivered, rejected, cancelled,
               total: pending + approved + shipped + delivered + rejected + cancelled })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Middleware para compradores (cualquier usuario autenticado) ────────────────
function requireBuyer(req, res, next) {
  const userId = (req.headers['x-user-id'] || '').trim()
  if (!userId) return res.status(401).json({ error: 'no_auth' })
  next()
}

function sanitizeText(value, max = 0) {
  const text = String(value ?? '').trim()
  if (!max) return text
  return text.slice(0, max)
}

function toOptionalNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

const BOLIVIA_CITIES = new Set([
  'La Paz',
  'Cochabamba',
  'Santa Cruz',
  'Oruro',
  'Potosi',
  'Chuquisaca',
  'Tarija',
  'Beni',
  'Pando',
])

function isValidLatLng(lat, lng) {
  if (lat == null || lng == null) return false
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
}

function parseGeoPoint(value) {
  if (value == null) return null

  let lat = null
  let lng = null

  if (Array.isArray(value)) {
    lat = toOptionalNumber(value[0])
    lng = toOptionalNumber(value[1])
  } else if (typeof value === 'object') {
    lat = toOptionalNumber(value.lat ?? value.latitude ?? value[0])
    lng = toOptionalNumber(value.lng ?? value.lon ?? value.longitude ?? value[1])
  }

  if (!isValidLatLng(lat, lng)) return null
  return { lat, lng }
}

async function getBuyerAddressById(token, addressId) {
  const res = await fetch(
    `${PB_URL}/api/collections/shipping_addresses/records/${addressId}`,
    { headers: pbHeaders(token) }
  )
  if (!res.ok) return null
  return readJsonSafe(res)
}

async function ensureDefaultAddressState(token, buyerId, currentAddressId, wantsDefault) {
  if (!wantsDefault) return

  const listRes = await fetch(
    `${PB_URL}/api/collections/shipping_addresses/records?perPage=200&fields=id,is_default&filter=${encodeURIComponent(`buyer="${buyerId}"`)}`,
    { headers: pbHeaders(token) }
  )
  if (!listRes.ok) return
  const listData = await readJsonSafe(listRes)
  for (const item of (listData?.items || [])) {
    if (item.id === currentAddressId || !item.is_default) continue
    await fetch(
      `${PB_URL}/api/collections/shipping_addresses/records/${item.id}`,
      {
        method: 'PATCH',
        headers: pbHeaders(token),
        body: JSON.stringify({ is_default: false }),
      }
    )
  }
}

function buildAddressPayload(body, buyerId, partial = false) {
  const fromGeoPoint = parseGeoPoint(body.address)
  const fromLegacy = parseGeoPoint({ lat: body.lat, lng: body.lng })
  const geoPoint = fromGeoPoint || fromLegacy

  const payload = {
    buyer: buyerId,
    label: sanitizeText(body.label, 60),
    recipient_name: sanitizeText(body.recipient_name, 120),
    phone: sanitizeText(body.phone, 30),
    address_line_1: sanitizeText(body.address_line_1 ?? body.line1, 200),
    address_line_2: sanitizeText(body.address_line_2 ?? body.line2, 200),
    city: sanitizeText(body.city, 100),
    state: sanitizeText(body.state, 100),
    postal_code: sanitizeText(body.postal_code, 30),
    country: sanitizeText(body.country || 'Bolivia', 80),
    // PocketBase geoPoint espera { lat, lon } (no lng)
    address: geoPoint ? { lat: geoPoint.lat, lon: geoPoint.lng } : null,
    is_default: Boolean(body.is_default),
  }

  if (partial) {
    const partialPayload = {}
    for (const [key, value] of Object.entries(payload)) {
      if (value !== '' && value !== null && value !== undefined) partialPayload[key] = value
    }
    if ('is_default' in body) partialPayload.is_default = Boolean(body.is_default)
    return partialPayload
  }

  return payload
}

// ── Direcciones de envío (comprador) ─────────────────────────────────────────
app.get('/buyer/addresses', requireBuyer, async (req, res) => {
  try {
    const token = await getAdminToken()
    const buyerId = req.headers['x-user-id']

    const params = new URLSearchParams({
      page: 1,
      perPage: 200,
      sort: '-is_default,-updated',
      filter: `buyer="${buyerId.replace(/"/g, '')}"`,
    })

    const pbRes = await fetch(
      `${PB_URL}/api/collections/shipping_addresses/records?${params}`,
      { headers: pbHeaders(token) }
    )
    const data = await readJsonSafe(pbRes)
    if (!pbRes.ok) return res.status(pbRes.status).json(data)
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/buyer/addresses', requireBuyer, async (req, res) => {
  try {
    const token = await getAdminToken()
    const buyerId = req.headers['x-user-id']
    const payload = buildAddressPayload(req.body, buyerId)

    if (!payload.recipient_name || !payload.address_line_1 || !payload.city) {
      return res.status(400).json({ error: 'recipient_name, address_line_1 y city son requeridos' })
    }
    if (!payload.phone) {
      return res.status(400).json({ error: 'phone es requerido' })
    }
    if (!BOLIVIA_CITIES.has(payload.city)) {
      return res.status(400).json({ error: 'city invalida, debe ser una de Bolivia' })
    }
    if (!payload.address) {
      return res.status(400).json({ error: 'address (geoPoint) requerido' })
    }

    const createRes = await fetch(
      `${PB_URL}/api/collections/shipping_addresses/records`,
      {
        method: 'POST',
        headers: pbHeaders(token),
        body: JSON.stringify(payload),
      }
    )
    const created = await readJsonSafe(createRes)
    if (!createRes.ok) return res.status(createRes.status).json(created)

    await ensureDefaultAddressState(token, buyerId, created.id, payload.is_default)
    res.status(201).json(created)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.patch('/buyer/addresses/:id', requireBuyer, async (req, res) => {
  try {
    const token = await getAdminToken()
    const buyerId = req.headers['x-user-id']
    const address = await getBuyerAddressById(token, req.params.id)

    if (!address) return res.status(404).json({ error: 'not_found' })
    if (address.buyer !== buyerId) return res.status(403).json({ error: 'forbidden' })

    const payload = buildAddressPayload(req.body, buyerId, true)
    if (!Object.keys(payload).length) return res.status(400).json({ error: 'no_changes' })

    const patchRes = await fetch(
      `${PB_URL}/api/collections/shipping_addresses/records/${req.params.id}`,
      {
        method: 'PATCH',
        headers: pbHeaders(token),
        body: JSON.stringify(payload),
      }
    )
    const updated = await readJsonSafe(patchRes)
    if (!patchRes.ok) return res.status(patchRes.status).json(updated)

    await ensureDefaultAddressState(token, buyerId, req.params.id, payload.is_default)
    res.json(updated)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.delete('/buyer/addresses/:id', requireBuyer, async (req, res) => {
  try {
    const token = await getAdminToken()
    const buyerId = req.headers['x-user-id']
    const address = await getBuyerAddressById(token, req.params.id)

    if (!address) return res.status(404).json({ error: 'not_found' })
    if (address.buyer !== buyerId) return res.status(403).json({ error: 'forbidden' })

    const delRes = await fetch(
      `${PB_URL}/api/collections/shipping_addresses/records/${req.params.id}`,
      { method: 'DELETE', headers: pbHeaders(token) }
    )
    if (!delRes.ok) {
      const errData = await readJsonSafe(delRes)
      return res.status(delRes.status).json(errData)
    }
    res.status(204).send()
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Debita la gift card de forma atómica con CAS + reintentos.
// Tras el PATCH, releemos y verificamos que el balance final es exactamente el que
// escribimos. Si no coincide, otro proceso modificó el saldo en paralelo → revertimos
// nuestro débito y reintentamos. Sin esta verificación, dos compras simultáneas
// podrían leer el mismo balance y sobre-consumir la tarjeta.
async function reserveGiftcardBalance(token, giftcardId, debitAmount, usageType) {
  const MAX_RETRIES = 5
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const r = await fetch(
      `${PB_URL}/api/collections/giftcards/records/${giftcardId}`,
      { headers: pbHeaders(token) }
    )
    if (!r.ok) { const e = new Error('giftcard_fetch_failed'); e.status = 500; throw e }
    const gc = await r.json()
    const currentBalance = Number(gc.balance || 0)

    if (gc.status !== 'active') {
      const e = new Error('giftcard_not_active'); e.status = 400; e.code = 'giftcard_not_active'; throw e
    }
    if (currentBalance < debitAmount) {
      const e = new Error('giftcard_insufficient_balance'); e.status = 400; e.code = 'giftcard_insufficient_balance'; throw e
    }

    const isSingle   = usageType === 'single_use'
    const newBalance = isSingle ? 0 : Math.round((currentBalance - debitAmount) * 100) / 100
    const newStatus  = (isSingle || newBalance <= 0) ? 'redeemed' : 'active'

    const p = await fetch(
      `${PB_URL}/api/collections/giftcards/records/${giftcardId}`,
      { method: 'PATCH', headers: pbHeaders(token),
        body: JSON.stringify({ balance: newBalance, status: newStatus }) }
    )
    if (!p.ok) continue

    const v = await fetch(
      `${PB_URL}/api/collections/giftcards/records/${giftcardId}`,
      { headers: pbHeaders(token) }
    )
    if (!v.ok) continue
    const verified = await v.json()
    if (Number(verified.balance) !== newBalance) {
      const revertBalance = Math.round((Number(verified.balance) + debitAmount) * 100) / 100
      await fetch(
        `${PB_URL}/api/collections/giftcards/records/${giftcardId}`,
        { method: 'PATCH', headers: pbHeaders(token),
          body: JSON.stringify({ balance: revertBalance, status: 'active' }) }
      ).catch(() => null)
      continue
    }
    return { previousBalance: currentBalance, newBalance, newStatus, isSingle }
  }
  const e = new Error('giftcard_concurrent_modification')
  e.status = 409; e.code = 'giftcard_concurrent_modification'
  throw e
}

async function refundGiftcardBalance(token, giftcardId, refundAmount) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(
      `${PB_URL}/api/collections/giftcards/records/${giftcardId}`,
      { headers: pbHeaders(token) }
    )
    if (!r.ok) continue
    const gc = await r.json()
    const newBalance = Math.round((Number(gc.balance || 0) + refundAmount) * 100) / 100
    const p = await fetch(
      `${PB_URL}/api/collections/giftcards/records/${giftcardId}`,
      { method: 'PATCH', headers: pbHeaders(token),
        body: JSON.stringify({ balance: newBalance, status: 'active' }) }
    )
    if (p.ok) return true
  }
  console.error(`[order] giftcard refund failed gc=${giftcardId} amount=${refundAmount}`)
  return false
}

// ── Crear orden (comprador) ────────────────────────────────────────────────────
// POST /buyer/create
// Body: { storeId, shipping_address_id|shipping_address, items: [{ productId, quantity, unit_price }], notes?, payment_method? }
app.post('/buyer/create', requireBuyer, async (req, res) => {
  // Declarados aquí para que el catch general pueda revertir el débito de la
  // gift card si cualquier excepción no anticipada ocurre tras la reserva.
  let token = null
  let appliedGiftcard = null
  let discountTotal = 0
  try {
    token  = await getAdminToken()
    const buyerId = req.headers['x-user-id']

    const { storeId, items, notes = '', shipping_address_id, shipping_address, giftcard_code } = req.body

    if (!storeId || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'storeId y items requeridos' })
    }

    let shippingAddressId = sanitizeText(shipping_address_id, 15)
    if (!shippingAddressId && shipping_address && typeof shipping_address === 'object') {
      const addrPayload = buildAddressPayload(shipping_address, buyerId)
      if (!addrPayload.recipient_name || !addrPayload.address_line_1 || !addrPayload.city) {
        return res.status(400).json({ error: 'shipping_address_invalida' })
      }
      if (!addrPayload.phone || !BOLIVIA_CITIES.has(addrPayload.city)) {
        return res.status(400).json({ error: 'shipping_address_invalida' })
      }

      const addrRes = await fetch(
        `${PB_URL}/api/collections/shipping_addresses/records`,
        {
          method: 'POST',
          headers: pbHeaders(token),
          body: JSON.stringify(addrPayload),
        }
      )
      const addrData = await readJsonSafe(addrRes)
      if (!addrRes.ok) return res.status(addrRes.status).json({ error: 'shipping_address_create_failed', details: addrData })
      shippingAddressId = addrData.id
      await ensureDefaultAddressState(token, buyerId, addrData.id, addrPayload.is_default)
    }

    if (!shippingAddressId) {
      return res.status(400).json({ error: 'shipping_address_required' })
    }

    const selectedAddress = await getBuyerAddressById(token, shippingAddressId)
    if (!selectedAddress) return res.status(404).json({ error: 'shipping_address_not_found' })
    if (selectedAddress.buyer !== buyerId) return res.status(403).json({ error: 'shipping_address_forbidden' })
    const selectedGeoPoint = parseGeoPoint(selectedAddress.address) || parseGeoPoint({ lat: selectedAddress.lat, lng: selectedAddress.lng })

    // Verificar que la tienda existe y obtener configuración de envío
    const storeRes = await fetch(
      `${PB_URL}/api/collections/stores/records/${storeId}?fields=id,name,status,shipping_cost,free_shipping`,
      { headers: pbHeaders(token) }
    )
    if (!storeRes.ok) {
      return res.status(404).json({ error: 'tienda_no_encontrada' })
    }
    const store = await readJsonSafe(storeRes)
    // Solo rechazar tiendas explícitamente suspendidas
    if (store.status === 'suspended') {
      return res.status(400).json({ error: 'tienda_suspendida' })
    }

    // Validar productos y calcular totales
    const validatedItems = []
    let subtotal = 0

    for (const item of items) {
      if (!item.productId || !item.quantity || item.quantity < 1) {
        return res.status(400).json({ error: `item_invalido: ${item.productId}` })
      }

      const prodRes = await fetch(
        `${PB_URL}/api/collections/products/records/${item.productId}?fields=id,name,price,cost_price,stock,store,status,discount_percent,discount_amount`,
        { headers: pbHeaders(token) }
      )
      if (!prodRes.ok) return res.status(404).json({ error: `producto_no_encontrado: ${item.productId}` })
      const prod = await readJsonSafe(prodRes)

      // Normalizar store: puede ser string ID o array
      const prodStoreId = Array.isArray(prod.store) ? prod.store[0] : prod.store
      if (prodStoreId !== storeId) {
        return res.status(400).json({ error: `producto_no_pertenece_a_tienda: ${item.productId}` })
      }
      // Aceptar productos activos y reservados
      const ALLOWED_STATUSES = ['active', 'reserved']
      if (!ALLOWED_STATUSES.includes(prod.status)) {
        return res.status(400).json({ error: `producto_no_disponible: ${prod.name} (estado: ${prod.status})` })
      }
      if (Number(prod.stock) < item.quantity) {
        return res.status(400).json({ error: `stock_insuficiente: ${prod.name} (disponible: ${prod.stock})` })
      }

      // Calcular precio final con descuento
      const base = Number(prod.price || 0)
      const pct  = Number(prod.discount_percent || 0)
      const amt  = Number(prod.discount_amount  || 0)
      let unit_price = base
      if (pct > 0)      unit_price = base * (1 - pct / 100)
      else if (amt > 0) unit_price = Math.max(0, base - amt)
      unit_price = Math.round(unit_price * 100) / 100

      const total = Math.round(unit_price * item.quantity * 100) / 100
      subtotal += total

      validatedItems.push({
        productId: item.productId,
        quantity:  item.quantity,
        unit_price,
        total,
        unit_cost: Number.isFinite(Number(prod.cost_price)) ? Math.max(0, Number(prod.cost_price)) : null,
        cost_total: Number.isFinite(Number(prod.cost_price))
          ? Math.round(Math.max(0, Number(prod.cost_price)) * item.quantity * 100) / 100
          : null,
      })
    }

    subtotal = Math.round(subtotal * 100) / 100

    // Calcular costo de envío según configuración de la tienda
    const freeShippingThreshold = (store.free_shipping != null && store.free_shipping !== '') ? Number(store.free_shipping) : 200
    const baseShippingCost      = (store.shipping_cost != null && store.shipping_cost !== '') ? Number(store.shipping_cost) : 30
    const shippingCost = subtotal >= freeShippingThreshold ? 0 : baseShippingCost
    let total = Math.round((subtotal + shippingCost) * 100) / 100

    // ── Validar gift card si se proporcionó ────────────────────────────────────
    const cleanGcCode    = giftcard_code ? String(giftcard_code).replace(/[^A-Z0-9_-]/g, '').slice(0, 32).toUpperCase() : ''

    if (cleanGcCode) {
      const gcParams = new URLSearchParams({
        filter:  `owner="${buyerId}" && code="${cleanGcCode}" && status="active"`,
        expand:  'source_code',
        perPage: '1',
      })
      const gcRes = await fetch(
        `${PB_URL}/api/collections/giftcards/records?${gcParams}`,
        { headers: pbHeaders(token) }
      )
      if (!gcRes.ok) {
        return res.status(400).json({ error: 'giftcard_invalid', message: 'No se pudo validar la gift card' })
      }
      const gcData = await readJsonSafe(gcRes)
      if (!gcData?.items?.length) {
        return res.status(400).json({ error: 'giftcard_not_found', message: 'Gift card no encontrada o inactiva' })
      }
      const gc = gcData.items[0]

      if (Number(gc.balance || 0) <= 0) {
        await fetch(`${PB_URL}/api/collections/giftcards/records/${gc.id}`, {
          method: 'PATCH',
          headers: pbHeaders(token),
          body: JSON.stringify({ status: 'redeemed', balance: 0 }),
        })
        return res.status(400).json({ error: 'giftcard_empty', message: 'La gift card ya no tiene saldo disponible' })
      }

      // La gift card solo puede usarse en la tienda que la emitió.
      const giftcardStoreId = Array.isArray(gc.store) ? gc.store[0] : gc.store
      if (!giftcardStoreId || giftcardStoreId !== storeId) {
        return res.status(400).json({
          error: 'giftcard_store_mismatch',
          message: 'La gift card solo se puede usar en la tienda que la emitió',
        })
      }

      // Verificar expiración
      if (gc.expires_at && new Date(gc.expires_at) < new Date()) {
        await fetch(`${PB_URL}/api/collections/giftcards/records/${gc.id}`, {
          method: 'PATCH', headers: pbHeaders(token),
          body: JSON.stringify({ status: 'expired' }),
        })
        return res.status(400).json({ error: 'giftcard_expired', message: 'La gift card ha expirado' })
      }

      let giftcardUsageType = gc?.expand?.source_code?.usage_type || null
      if (!giftcardUsageType && Array.isArray(gc?.expand?.source_code) && gc.expand.source_code.length) {
        giftcardUsageType = gc.expand.source_code[0]?.usage_type || null
      }
      if (!giftcardUsageType && gc.source_code) {
        const sourceId = Array.isArray(gc.source_code) ? gc.source_code[0] : gc.source_code
        if (sourceId) {
          const sourceRes = await fetch(
            `${PB_URL}/api/collections/giftcard_codes/records/${sourceId}?fields=usage_type,status`,
            { headers: pbHeaders(token) }
          )
          if (sourceRes.ok) {
            const sourceData = await readJsonSafe(sourceRes)
            giftcardUsageType = sourceData?.usage_type || null
          }
        }
      }

      // Si no se pudo determinar, asumir single_use (más seguro, no permite reusar).
      if (!giftcardUsageType) giftcardUsageType = 'single_use'
      appliedGiftcard = { ...gc, _usage_type: giftcardUsageType }
      // Descuento = mínimo entre el saldo de la gift card y el total a pagar
      discountTotal = Math.min(Number(gc.balance), total)
      discountTotal = Math.round(discountTotal * 100) / 100
      total = Math.max(0, Math.round((total - discountTotal) * 100) / 100)

      // Debitar la giftcard ATÓMICAMENTE antes de crear la orden.
      // Si dos compras con la misma gift card llegan a la vez, sólo una pasa el CAS.
      try {
        await reserveGiftcardBalance(token, appliedGiftcard.id, discountTotal, giftcardUsageType)
      } catch (gcErr) {
        const status = gcErr.status || 500
        return res.status(status).json({
          error:   gcErr.code || 'giftcard_reserve_failed',
          message: gcErr.message,
        })
      }
    }

    // Helper para revertir el débito de la gift card si la orden falla aguas abajo.
    const rollbackGiftcard = async () => {
      if (appliedGiftcard && discountTotal > 0) {
        await refundGiftcardBalance(token, appliedGiftcard.id, discountTotal)
      }
    }

    // Crear la orden (estado inicial: reserved, cambia a payment_uploaded al subir comprobante)
    const orderPayload = {
      buyer:          buyerId,
      store:          storeId,
      status:         'reserved',
      subtotal,
      shipping_cost:  shippingCost,
      total,
      discount_total: discountTotal,
      giftcard_code:  cleanGcCode || '',
      currency:       'BS',
      shipping_address_ref: shippingAddressId,
      shipping_address: {
        name: selectedAddress.recipient_name || '',
        phone: selectedAddress.phone || '',
        address: selectedAddress.address_line_1 || selectedAddress.line1 || '',
        city: selectedAddress.city || '',
        notes: selectedAddress.address_line_2 || selectedAddress.line2 || '',
        lat: selectedGeoPoint?.lat ?? null,
        lng: selectedGeoPoint?.lng ?? null,
      },
      notes,
    }

    const orderRes = await fetch(
      `${PB_URL}/api/collections/orders/records`,
      { method: 'POST', headers: pbHeaders(token), body: JSON.stringify(orderPayload) }
    )
    const order = await readJsonSafe(orderRes)
    if (!orderRes.ok) {
      await rollbackGiftcard()
      return res.status(orderRes.status).json({ error: 'order_create_failed', details: order })
    }

    // Crear los order_items
    const createdItems = []
    for (const item of validatedItems) {
      const itemPayload = {
        order:      order.id,
        product:    item.productId,
        store:      storeId,
        quantity:   item.quantity,
        unit_price: item.unit_price,
        total:      item.total,
        ...(item.unit_cost !== null ? { unit_cost: item.unit_cost, cost_total: item.cost_total } : {}),
      }
      const itemRes = await fetch(
        `${PB_URL}/api/collections/order_items/records`,
        { method: 'POST', headers: pbHeaders(token), body: JSON.stringify(itemPayload) }
      )
      const createdItem = await readJsonSafe(itemRes)
      if (!itemRes.ok) {
        // Cleanup: borrar la orden y revertir débito de gift card
        await fetch(`${PB_URL}/api/collections/orders/records/${order.id}`, {
          method: 'DELETE', headers: pbHeaders(token)
        })
        await rollbackGiftcard()
        return res.status(500).json({ error: 'item_create_failed', details: createdItem })
      }
      createdItems.push(createdItem)
    }

    // Propagar al código fuente: marca el pool como redeemed para single_use,
    // así nadie más puede canjear el mismo código. El débito del balance ya se hizo arriba.
    if (appliedGiftcard && appliedGiftcard._usage_type === 'single_use') {
      const sourceCodeId = Array.isArray(appliedGiftcard.source_code)
        ? appliedGiftcard.source_code[0]
        : appliedGiftcard.source_code
      if (sourceCodeId) {
        await fetch(`${PB_URL}/api/collections/giftcard_codes/records/${sourceCodeId}`, {
          method:  'PATCH',
          headers: pbHeaders(token),
          body:    JSON.stringify({ status: 'redeemed' }),
        }).catch(() => null)
      }
    }

    res.status(201).json({ ...order, items: createdItems, discount_total: discountTotal, giftcard_code: cleanGcCode })
  } catch (err) {
    if (token && appliedGiftcard && discountTotal > 0) {
      await refundGiftcardBalance(token, appliedGiftcard.id, discountTotal).catch(() => null)
    }
    res.status(500).json({ error: err.message })
  }
})

// ── Mis pedidos (comprador) ────────────────────────────────────────────────────
// GET /buyer/my?page=1&perPage=20&status=
app.get('/buyer/my', requireBuyer, async (req, res) => {
  try {
    const token   = await getAdminToken()
    const buyerId = req.headers['x-user-id']
    const page    = Math.max(1, parseInt(req.query.page) || 1)
    const perPage = Math.min(50, parseInt(req.query.perPage) || 20)

    const filters = [`buyer="${buyerId.replace(/"/g, '')}"`]
    if (req.query.status) filters.push(`status="${req.query.status.replace(/"/g, '')}"`)

    const params = new URLSearchParams({
      page, perPage,
      sort:   '-created',
      expand: 'store,shipping_address_ref',
      filter: filters.join(' && '),
    })

    const pbRes = await fetch(
      `${PB_URL}/api/collections/orders/records?${params}`,
      { headers: pbHeaders(token) }
    )
    const data = await readJsonSafe(pbRes)
    if (!pbRes.ok) return res.status(pbRes.status).json(data)

    // Enriquecer con items
    if (data?.items?.length) {
      const orderIds = data.items.map(o => `order="${o.id}"`).join(' || ')
      const itemsRes = await fetch(
        `${PB_URL}/api/collections/order_items/records?filter=${encodeURIComponent(orderIds)}&perPage=200&expand=product`,
        { headers: pbHeaders(token) }
      )
      if (itemsRes.ok) {
        const itemsData = await readJsonSafe(itemsRes)
        const itemsByOrder = {}
        for (const item of (itemsData?.items || [])) {
          if (!itemsByOrder[item.order]) itemsByOrder[item.order] = []
          itemsByOrder[item.order].push(item)
        }
        for (const order of data.items) {
          order.items = itemsByOrder[order.id] || []
        }
      }
    }

    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Detalle de orden (comprador) ───────────────────────────────────────────────
app.get('/buyer/order/:id', requireBuyer, async (req, res) => {
  try {
    const token   = await getAdminToken()
    const buyerId = req.headers['x-user-id']

    const pbRes = await fetch(
      `${PB_URL}/api/collections/orders/records/${req.params.id}?expand=store,shipping_address_ref`,
      { headers: pbHeaders(token) }
    )
    if (pbRes.status === 404) return res.status(404).json({ error: 'not_found' })
    const order = await readJsonSafe(pbRes)
    if (!pbRes.ok) return res.status(pbRes.status).json(order)

    // Solo el comprador puede ver su propia orden
    if (order.buyer !== buyerId) return res.status(403).json({ error: 'forbidden' })

    const itemsRes = await fetch(
      `${PB_URL}/api/collections/order_items/records?filter=${encodeURIComponent(`order="${req.params.id}"`)}&perPage=50&expand=product`,
      { headers: pbHeaders(token) }
    )
    if (itemsRes.ok) {
      const itemsData = await readJsonSafe(itemsRes)
      order.items = itemsData?.items || []
    }

    res.json(order)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Subir comprobante de pago (comprador) ──────────────────────────────────────
// POST /buyer/order/:id/proof   body: multipart con campo payment_proof
app.post('/buyer/order/:id/proof', requireBuyer, upload.single('payment_proof'), async (req, res) => {
  try {
    const token   = await getAdminToken()
    const buyerId = req.headers['x-user-id']
    const orderId = req.params.id

    if (!req.file) return res.status(400).json({ error: 'payment_proof requerido' })

    // Verificar que la orden pertenece al comprador y está en estado reserved
    const orderRes = await fetch(
      `${PB_URL}/api/collections/orders/records/${orderId}`,
      { headers: pbHeaders(token) }
    )
    if (orderRes.status === 404) return res.status(404).json({ error: 'not_found' })
    const order = await readJsonSafe(orderRes)
    if (!orderRes.ok) return res.status(orderRes.status).json(order)
    if (order.buyer !== buyerId) return res.status(403).json({ error: 'forbidden' })
    if (order.status !== 'reserved') return res.status(400).json({ error: 'La orden no está en estado reservado' })

    // Subir comprobante a PocketBase como multipart
    const form = new FormData()
    form.append(
      'payment_proof',
      new Blob([req.file.buffer], { type: req.file.mimetype }),
      req.file.originalname || 'comprobante.jpg'
    )
    form.append('status', 'payment_uploaded')
    form.append('payment_uploaded_at', new Date().toISOString())

    const patchRes = await fetch(
      `${PB_URL}/api/collections/orders/records/${orderId}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` }, // sin Content-Type; FormData lo pone automáticamente
        body: form,
      }
    )
    const updated = await readJsonSafe(patchRes)
    if (!patchRes.ok) return res.status(patchRes.status).json({ error: 'proof_upload_failed', details: updated })

    res.json(updated)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.listen(PORT, () => console.log(`order-service running on port ${PORT}`))
