const express = require('express')
const cors    = require('cors')

const app  = express()
const PORT = Number(process.env.PORT || 9013)

app.use(cors())
app.use(express.json())

const PB_URL      = (process.env.POCKETBASE_URL || '').replace(/\/$/, '')
const PB_IDENTITY = process.env.POCKETBASE_AUTH_IDENTITY || ''
const PB_PASSWORD = process.env.POCKETBASE_AUTH_PASSWORD || ''

// Estados que disparan creación de transacción.
// approved = pago confirmado por el vendor/admin, es cuando la venta se concreta.
// Se incluyen también los estados posteriores (shipped/delivered) por si se aprueba
// y se envía rápido antes de que el cron alcance a procesar.
const ORDER_FINAL_STATUSES     = ['approved', 'shipped', 'delivered']
const BID_ORDER_FINAL_STATUSES = ['approved', 'shipped', 'delivered']

let _adminToken = null
let _adminTokenExpiry = 0

async function readJsonSafe(res) {
  const text = await res.text()
  if (!text) return null
  try { return JSON.parse(text) } catch { return { raw: text } }
}

function pbHeaders(token) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
}

async function getAdminToken() {
  if (_adminToken && Date.now() < _adminTokenExpiry) return _adminToken
  const res = await fetch(`${PB_URL}/api/collections/_superusers/auth-with-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: PB_IDENTITY, password: PB_PASSWORD }),
  })
  if (!res.ok) {
    const details = await readJsonSafe(res)
    throw new Error(`PB admin auth failed: ${res.status} ${JSON.stringify(details)}`)
  }
  const { token } = await res.json()
  _adminToken = token
  _adminTokenExpiry = Date.now() + 55 * 60 * 1000
  return token
}

async function listAll(token, collection, { filter, fields, perPage = 200, sort = '-created' } = {}) {
  const items = []
  let page = 1
  let totalPages = 1
  do {
    const params = new URLSearchParams({ page: String(page), perPage: String(perPage), sort })
    if (filter) params.set('filter', filter)
    if (fields) params.set('fields', fields)
    const res = await fetch(
      `${PB_URL}/api/collections/${collection}/records?${params}`,
      { headers: pbHeaders(token) }
    )
    if (!res.ok) {
      const details = await readJsonSafe(res)
      throw new Error(`${collection} list failed: ${res.status} ${JSON.stringify(details)}`)
    }
    const data = await res.json()
    items.push(...(data.items || []))
    totalPages = Number(data.totalPages || 1)
    page += 1
  } while (page <= totalPages)
  return items
}

function relValue(field) {
  if (Array.isArray(field)) return field[0] || null
  return field || null
}

async function getExistingOrderTxIds(token) {
  const filter = ORDER_FINAL_STATUSES.map(s => `status="${s}"`).join(' || ')
  const items = await listAll(token, 'transactions', {
    filter: `type="order_payment" && order!=""`,
    fields: 'id,order',
  })
  const set = new Set()
  for (const tx of items) {
    const orderId = relValue(tx.order)
    if (orderId) set.add(orderId)
  }
  return set
}

async function getExistingAuctionTxIds(token) {
  const items = await listAll(token, 'transactions', {
    filter: `type="auction_payment"`,
    fields: 'id,auction',
  })
  const set = new Set()
  for (const tx of items) {
    const auctionId = relValue(tx.auction)
    if (auctionId) set.add(auctionId)
  }
  return set
}

async function createTransaction(token, payload) {
  const res = await fetch(`${PB_URL}/api/collections/transactions/records`, {
    method: 'POST',
    headers: pbHeaders(token),
    body: JSON.stringify(payload),
  })
  const data = await readJsonSafe(res)
  if (!res.ok) throw new Error(`transaction_create_failed:${res.status}:${JSON.stringify(data)}`)
  return data
}

// Sincroniza órdenes regulares: por cada orden con status approved/shipped/delivered
// que aún no tenga una transacción asociada, crea una.
async function syncOrders() {
  const token = await getAdminToken()
  const orderFilter = ORDER_FINAL_STATUSES.map(s => `status="${s}"`).join(' || ')
  const orders = await listAll(token, 'orders', {
    filter: `(${orderFilter})`,
    fields: 'id,buyer,store,total,currency,approved_by,status',
  })
  const existing = await getExistingOrderTxIds(token)

  let created = 0
  const errors = []

  for (const order of orders) {
    if (existing.has(order.id)) continue

    const payload = {
      type:        'order_payment',
      status:      'completed',
      amount:      Number(order.total || 0),
      currency:    order.currency || 'BS',
      order:       order.id,
      user:        relValue(order.buyer) || null,
      store:       relValue(order.store) || null,
      approved_by: relValue(order.approved_by) || null,
      external_ref: `order:${order.id}`,
      notes:       `Pago de orden ${order.id}`,
    }

    try {
      await createTransaction(token, payload)
      created += 1
    } catch (err) {
      console.error(`[transaction-service] order ${order.id}:`, err.message)
      errors.push({ id: order.id, error: err.message })
    }
  }

  return { scanned: orders.length, created, errors }
}

// Sincroniza órdenes de subasta: por cada orders_bid con status approved/shipped/delivered
// que aún no tenga una transacción de tipo auction_payment, crea una.
async function syncBidOrders() {
  const token = await getAdminToken()
  const filter = BID_ORDER_FINAL_STATUSES.map(s => `status="${s}"`).join(' || ')
  const bidOrders = await listAll(token, 'orders_bid', {
    filter: `(${filter})`,
    fields: 'id,buyer,store,total,currency,approved_by,bid,status',
  })
  const existing = await getExistingAuctionTxIds(token)

  let created = 0
  const errors = []

  for (const order of bidOrders) {
    const auctionId = relValue(order.bid)
    if (!auctionId) continue
    if (existing.has(auctionId)) continue

    const payload = {
      type:         'auction_payment',
      status:       'completed',
      amount:       Number(order.total || 0),
      currency:     order.currency || 'BS',
      auction:      auctionId,
      user:         relValue(order.buyer) || null,
      store:        relValue(order.store) || null,
      approved_by:  relValue(order.approved_by) || null,
      external_ref: `orders_bid:${order.id}`,
      notes:        `Pago de subasta ${auctionId} (orden ${order.id})`,
    }

    try {
      await createTransaction(token, payload)
      // Evita duplicar si el mismo auctionId apareciera dos veces en el batch
      existing.add(auctionId)
      created += 1
    } catch (err) {
      console.error(`[transaction-service] orders_bid ${order.id}:`, err.message)
      errors.push({ id: order.id, error: err.message })
    }
  }

  return { scanned: bidOrders.length, created, errors }
}

async function runFullSync() {
  const orders = await syncOrders()
  const bids   = await syncBidOrders()
  return { orders, bids, ts: new Date().toISOString() }
}

// Crea la transacción de una sola orden si aún no existe. Llamado por order-service
// al aprobar/entregar. Idempotente: si ya hay transacción para esa orden, no hace nada.
async function ensureOrderTransaction(orderId) {
  if (!orderId) throw new Error('orderId requerido')
  const token = await getAdminToken()

  const checkRes = await fetch(
    `${PB_URL}/api/collections/transactions/records?perPage=1&fields=id&filter=${encodeURIComponent(`type="order_payment" && order="${orderId}"`)}`,
    { headers: pbHeaders(token) }
  )
  const checkData = await readJsonSafe(checkRes)
  if (checkData?.items?.length) return { created: false, existing: checkData.items[0].id }

  const orderRes = await fetch(
    `${PB_URL}/api/collections/orders/records/${orderId}?fields=id,buyer,store,total,currency,approved_by,status`,
    { headers: pbHeaders(token) }
  )
  if (!orderRes.ok) throw new Error(`order ${orderId} not found`)
  const order = await readJsonSafe(orderRes)

  const tx = await createTransaction(token, {
    type:         'order_payment',
    status:       'completed',
    amount:       Number(order.total || 0),
    currency:     order.currency || 'BS',
    order:        order.id,
    user:         relValue(order.buyer) || null,
    store:        relValue(order.store) || null,
    approved_by:  relValue(order.approved_by) || null,
    external_ref: `order:${order.id}`,
    notes:        `Pago de orden ${order.id}`,
  })
  return { created: true, id: tx.id }
}

// Igual que ensureOrderTransaction pero para orders_bid. La transacción se asocia
// al auction (campo `bid` de orders_bid → campo `auction` de transactions).
async function ensureBidOrderTransaction(bidOrderId) {
  if (!bidOrderId) throw new Error('bidOrderId requerido')
  const token = await getAdminToken()

  const orderRes = await fetch(
    `${PB_URL}/api/collections/orders_bid/records/${bidOrderId}?fields=id,buyer,store,total,currency,approved_by,bid,status`,
    { headers: pbHeaders(token) }
  )
  if (!orderRes.ok) throw new Error(`orders_bid ${bidOrderId} not found`)
  const order = await readJsonSafe(orderRes)

  const auctionId = relValue(order.bid)
  if (!auctionId) throw new Error(`orders_bid ${bidOrderId} sin auction`)

  const checkRes = await fetch(
    `${PB_URL}/api/collections/transactions/records?perPage=1&fields=id&filter=${encodeURIComponent(`type="auction_payment" && auction="${auctionId}"`)}`,
    { headers: pbHeaders(token) }
  )
  const checkData = await readJsonSafe(checkRes)
  if (checkData?.items?.length) return { created: false, existing: checkData.items[0].id }

  const tx = await createTransaction(token, {
    type:         'auction_payment',
    status:       'completed',
    amount:       Number(order.total || 0),
    currency:     order.currency || 'BS',
    auction:      auctionId,
    user:         relValue(order.buyer) || null,
    store:        relValue(order.store) || null,
    approved_by:  relValue(order.approved_by) || null,
    external_ref: `orders_bid:${order.id}`,
    notes:        `Pago de subasta ${auctionId} (orden ${order.id})`,
  })
  return { created: true, id: tx.id }
}

// ── Rutas ─────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ service: 'transaction-service', ok: true, port: PORT })
})

// Disparado por order-service al aprobar/entregar.
app.post('/hooks/order/:id', async (req, res) => {
  try {
    const result = await ensureOrderTransaction(req.params.id)
    res.json({ ok: true, ...result })
  } catch (err) {
    console.error('hook order error', err.message)
    res.status(500).json({ ok: false, error: err.message })
  }
})

// Disparado por bid-order-service al aprobar/entregar.
app.post('/hooks/bid-order/:id', async (req, res) => {
  try {
    const result = await ensureBidOrderTransaction(req.params.id)
    res.json({ ok: true, ...result })
  } catch (err) {
    console.error('hook bid-order error', err.message)
    res.status(500).json({ ok: false, error: err.message })
  }
})

// Backfill manual (admin). Útil si el servicio estuvo caído mientras se aprobaron órdenes.
app.post('/sync', async (_req, res) => {
  try {
    const result = await runFullSync()
    res.json({ ok: true, ...result })
  } catch (err) {
    console.error('sync error', err.message)
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.post('/sync/orders', async (_req, res) => {
  try {
    const result = await syncOrders()
    res.json({ ok: true, ...result })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.post('/sync/bids', async (_req, res) => {
  try {
    const result = await syncBidOrders()
    res.json({ ok: true, ...result })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.listen(PORT, () => {
  console.log(`transaction-service running on port ${PORT}`)
})
