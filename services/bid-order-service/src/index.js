const express = require('express')
const cors    = require('cors')
const multer  = require('multer')
const cron    = require('node-cron')

const app    = express()
const PORT   = Number(process.env.PORT || 9012)
const upload = multer({ storage: multer.memoryStorage() })

app.use(cors())
app.use(express.json())

const PB_URL      = (process.env.POCKETBASE_URL || '').replace(/\/$/, '')
const PB_IDENTITY = process.env.POCKETBASE_AUTH_IDENTITY || ''
const PB_PASSWORD = process.env.POCKETBASE_AUTH_PASSWORD || ''

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

function requireBuyer(req, res, next) {
  const userId = (req.headers['x-user-id'] || '').trim()
  if (!userId) return res.status(401).json({ error: 'no_auth' })
  next()
}

function userOwnsStore(store, userId) {
  const owners = Array.isArray(store?.owner)
    ? store.owner
    : (store?.owner ? [store.owner] : [])
  return owners.includes(userId)
}

async function checkBidOrderOwnership(token, orderId, userId) {
  const res = await fetch(
    `${PB_URL}/api/collections/orders_bid/records/${orderId}?expand=store`,
    { headers: pbHeaders(token) }
  )
  if (!res.ok) return null
  const order = await res.json()
  const isOwner = userOwnsStore(order?.expand?.store, userId)
  return { order, isOwner }
}

// ── Re-listar subasta tras cancelación/rechazo ─────────────────────────────────
async function relistAuction(token, auctionId) {
  if (!auctionId) return
  const newEndDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  await fetch(`${PB_URL}/api/collections/auctions/records/${auctionId}`, {
    method: 'PATCH',
    headers: pbHeaders(token),
    body: JSON.stringify({
      status:   'active',
      winner:   null,
      end_date: newEndDate,
    }),
  })
}

// ── Health ─────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ service: 'bid-order-service', ok: true, port: PORT }))

// ── Listar órdenes de subasta (vendor/admin) ───────────────────────────────────
app.get('/', requireAuth, async (req, res) => {
  try {
    const token   = await getAdminToken()
    const userId  = req.headers['x-user-id']
    const role    = req.headers['x-user-role']
    const page    = Math.max(1, parseInt(req.query.page) || 1)
    const perPage = Math.min(100, parseInt(req.query.perPage) || 20)

    const filters = []
    if (req.query.storeId) {
      filters.push(`store="${req.query.storeId.replace(/"/g, '')}"`)
    } else if (role === 'vendor') {
      const storesRes = await fetch(
        `${PB_URL}/api/collections/stores/records?fields=id,owner&perPage=200`,
        { headers: pbHeaders(token) }
      )
      const storesData = storesRes.ok ? await readJsonSafe(storesRes) : null
      const storeIds = (storesData?.items || [])
        .filter(s => userOwnsStore(s, userId))
        .map(s => s.id)
      if (!storeIds.length) return res.json({ items: [], totalItems: 0, totalPages: 0 })
      filters.push(`(${storeIds.map(id => `store="${id}"`).join(' || ')})`)
    }

    if (req.query.status) filters.push(`status="${req.query.status.replace(/"/g, '')}"`)

    const params = new URLSearchParams({
      page, perPage,
      sort:   req.query.sort || '-created',
      expand: 'buyer,store,bid,approved_by',
    })
    if (filters.length) params.set('filter', filters.join(' && '))

    const pbRes = await fetch(
      `${PB_URL}/api/collections/orders_bid/records?${params}`,
      { headers: pbHeaders(token) }
    )
    const data = await readJsonSafe(pbRes)
    if (!pbRes.ok) return res.status(pbRes.status).json(data)
    res.json(data)
  } catch (err) {
    console.error('list bid orders error', err)
    res.status(500).json({ error: err.message })
  }
})

// ── Obtener orden de subasta (vendor/admin) ────────────────────────────────────
app.get('/:id([a-z0-9]{15})', requireAuth, async (req, res) => {
  try {
    const token  = await getAdminToken()
    const userId = req.headers['x-user-id']
    const role   = req.headers['x-user-role']

    const pbRes = await fetch(
      `${PB_URL}/api/collections/orders_bid/records/${req.params.id}?expand=buyer,store,bid,approved_by,shipping`,
      { headers: pbHeaders(token) }
    )
    if (pbRes.status === 404) return res.status(404).json({ error: 'not_found' })
    const order = await readJsonSafe(pbRes)
    if (!pbRes.ok) return res.status(pbRes.status).json(order)

    if (role === 'vendor' && !userOwnsStore(order?.expand?.store, userId)) {
      return res.status(403).json({ error: 'forbidden' })
    }

    res.json(order)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Proxy seguro de comprobante de pago (vendor/admin) ─────────────────────────
app.get('/files/orders-bid/:id/:filename', requireAuth, async (req, res) => {
  try {
    const token  = await getAdminToken()
    const userId = (req.headers['x-user-id'] || '').trim()
    const role   = (req.headers['x-user-role'] || '').trim()

    const ownership = await checkBidOrderOwnership(token, req.params.id, userId)
    if (!ownership?.order) return res.status(404).json({ error: 'not_found' })
    if (role === 'vendor' && !ownership.isOwner) return res.status(403).json({ error: 'forbidden' })

    const order = ownership.order
    if (!order.payment_proof) return res.status(404).json({ error: 'proof_not_found' })

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
    } catch { fileToken = '' }

    const encodedId = encodeURIComponent(order.id)
    const encodedFn = encodeURIComponent(req.params.filename)

    let fileRes = null
    if (fileToken) {
      const r = await fetch(`${PB_URL}/api/files/orders_bid/${encodedId}/${encodedFn}?token=${encodeURIComponent(fileToken)}`)
      if (r.ok) fileRes = r
    }
    if (!fileRes) {
      const r = await fetch(`${PB_URL}/api/files/orders_bid/${encodedId}/${encodedFn}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (r.ok) fileRes = r
    }

    if (!fileRes?.ok) return res.status(404).json({ error: 'proof_fetch_failed' })

    const ct = fileRes.headers.get('content-type')
    if (ct) res.setHeader('Content-Type', ct)
    res.send(Buffer.from(await fileRes.arrayBuffer()))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Aprobar orden (vendor/admin) ───────────────────────────────────────────────
app.patch('/:id/approve', requireAuth, async (req, res) => {
  try {
    const token  = await getAdminToken()
    const userId = req.headers['x-user-id']
    const role   = req.headers['x-user-role']

    const result = await checkBidOrderOwnership(token, req.params.id, userId)
    if (!result) return res.status(404).json({ error: 'not_found' })
    if (role === 'vendor' && !result.isOwner) return res.status(403).json({ error: 'forbidden' })

    const pbRes = await fetch(
      `${PB_URL}/api/collections/orders_bid/records/${req.params.id}`,
      {
        method: 'PATCH',
        headers: pbHeaders(token),
        body: JSON.stringify({
          status:        'approved',
          approved_by:   userId,
          approval_note: req.body.approval_note || '',
        }),
      }
    )
    const data = await readJsonSafe(pbRes)
    if (!pbRes.ok) return res.status(pbRes.status).json({ error: 'approve_failed', details: data })
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Rechazar orden (vendor/admin) — re-lista la subasta ────────────────────────
app.patch('/:id/reject', requireAuth, async (req, res) => {
  try {
    const token  = await getAdminToken()
    const userId = req.headers['x-user-id']
    const role   = req.headers['x-user-role']

    const result = await checkBidOrderOwnership(token, req.params.id, userId)
    if (!result) return res.status(404).json({ error: 'not_found' })
    if (role === 'vendor' && !result.isOwner) return res.status(403).json({ error: 'forbidden' })

    const pbRes = await fetch(
      `${PB_URL}/api/collections/orders_bid/records/${req.params.id}`,
      {
        method: 'PATCH',
        headers: pbHeaders(token),
        body: JSON.stringify({
          status:        'rejected',
          approved_by:   userId,
          approval_note: req.body.reason || '',
        }),
      }
    )
    const data = await readJsonSafe(pbRes)
    if (!pbRes.ok) return res.status(pbRes.status).json({ error: 'reject_failed', details: data })

    // Re-listar la subasta
    const auctionId = Array.isArray(result.order.bid) ? result.order.bid[0] : result.order.bid
    await relistAuction(token, auctionId)

    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Marcar como enviado (vendor/admin) ────────────────────────────────────────
app.patch('/:id/ship', requireAuth, async (req, res) => {
  try {
    const token  = await getAdminToken()
    const userId = req.headers['x-user-id']
    const role   = req.headers['x-user-role']

    const result = await checkBidOrderOwnership(token, req.params.id, userId)
    if (!result) return res.status(404).json({ error: 'not_found' })
    if (role === 'vendor' && !result.isOwner) return res.status(403).json({ error: 'forbidden' })

    const pbRes = await fetch(
      `${PB_URL}/api/collections/orders_bid/records/${req.params.id}`,
      { method: 'PATCH', headers: pbHeaders(token), body: JSON.stringify({ status: 'shipped' }) }
    )
    const data = await readJsonSafe(pbRes)
    if (!pbRes.ok) return res.status(pbRes.status).json({ error: 'ship_failed', details: data })
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Marcar como entregado (vendor/admin) ──────────────────────────────────────
app.patch('/:id/deliver', requireAuth, async (req, res) => {
  try {
    const token  = await getAdminToken()
    const userId = req.headers['x-user-id']
    const role   = req.headers['x-user-role']

    const result = await checkBidOrderOwnership(token, req.params.id, userId)
    if (!result) return res.status(404).json({ error: 'not_found' })
    if (role === 'vendor' && !result.isOwner) return res.status(403).json({ error: 'forbidden' })

    const pbRes = await fetch(
      `${PB_URL}/api/collections/orders_bid/records/${req.params.id}`,
      { method: 'PATCH', headers: pbHeaders(token), body: JSON.stringify({ status: 'delivered' }) }
    )
    const data = await readJsonSafe(pbRes)
    if (!pbRes.ok) return res.status(pbRes.status).json({ error: 'deliver_failed', details: data })
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Stats por tienda (vendor/admin) ───────────────────────────────────────────
app.get('/vendor/stats/:storeId', requireAuth, async (req, res) => {
  try {
    const token = await getAdminToken()
    const sid   = req.params.storeId.replace(/"/g, '')
    const enc   = encodeURIComponent

    const countStatus = async (statusFilter) => {
      const r = await fetch(
        `${PB_URL}/api/collections/orders_bid/records?page=1&perPage=1&fields=id&filter=${enc(statusFilter)}`,
        { headers: pbHeaders(token) }
      )
      const d = await readJsonSafe(r)
      return Number(d?.totalItems || 0)
    }

    const [pending, approved, shipped, delivered, rejected, cancelled] = await Promise.all([
      countStatus(`store="${sid}" && status="pending"`),
      countStatus(`store="${sid}" && status="approved"`),
      countStatus(`store="${sid}" && status="shipped"`),
      countStatus(`store="${sid}" && status="delivered"`),
      countStatus(`store="${sid}" && status="rejected"`),
      countStatus(`store="${sid}" && status="calcelled"`),
    ])

    res.json({ pending, approved, shipped, delivered, rejected, cancelled,
               total: pending + approved + shipped + delivered + rejected + cancelled })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Mis pedidos de subasta (comprador) ────────────────────────────────────────
app.get('/buyer/my', requireBuyer, async (req, res) => {
  try {
    const token   = await getAdminToken()
    const buyerId = req.headers['x-user-id']
    const page    = Math.max(1, parseInt(req.query.page) || 1)
    const perPage = Math.min(50, parseInt(req.query.perPage) || 20)

    const filters = [`buyer="${buyerId.replace(/"/g, '')}"`]
    // Excluir cancelados por vencimiento de pago
    filters.push('status!="calcelled"')
    filters.push('status!="cancelled"')

    if (req.query.status) filters.push(`status="${req.query.status.replace(/"/g, '')}"`)

    const params = new URLSearchParams({
      page, perPage,
      sort:   '-created',
      expand: 'store,bid',
      filter: filters.join(' && '),
    })

    const pbRes = await fetch(
      `${PB_URL}/api/collections/orders_bid/records?${params}`,
      { headers: pbHeaders(token) }
    )
    const data = await readJsonSafe(pbRes)
    if (!pbRes.ok) return res.status(pbRes.status).json(data)
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Mis pujas en subastas (comprador) ─────────────────────────────────────────
app.get('/buyer/my/bids', requireBuyer, async (req, res) => {
  try {
    const token   = await getAdminToken()
    const buyerId = req.headers['x-user-id']
    const page    = Math.max(1, parseInt(req.query.page) || 1)
    const perPage = Math.min(50, parseInt(req.query.perPage) || 20)

    // Traer auction_bids del usuario, agrupando por auction (la más alta por subasta)
    const bidsRes = await fetch(
      `${PB_URL}/api/collections/auction_bids/records?filter=${encodeURIComponent(`bidder="${buyerId}"`)}&sort=-amount&perPage=200&expand=auction,auction.store`,
      { headers: pbHeaders(token) }
    )
    const bidsData = bidsRes.ok ? await readJsonSafe(bidsRes) : null
    const allBids = bidsData?.items || []

    // Dedup por auction: quedarse con la puja más alta por subasta
    const byAuction = new Map()
    for (const bid of allBids) {
      if (!byAuction.has(bid.auction)) byAuction.set(bid.auction, bid)
    }
    const uniqueBids = Array.from(byAuction.values())

    // Para subastas terminadas donde soy el ganador, buscar la orders_bid
    const wonAuctionIds = uniqueBids
      .filter(b => b.expand?.auction?.winner === buyerId)
      .map(b => b.auction)

    let ordersByAuction = {}
    if (wonAuctionIds.length) {
      const ordersFilter = wonAuctionIds.map(id => `bid="${id}"`).join(' || ')
      const ordersRes = await fetch(
        `${PB_URL}/api/collections/orders_bid/records?filter=${encodeURIComponent(`buyer="${buyerId}" && (${ordersFilter})`)}&perPage=100`,
        { headers: pbHeaders(token) }
      )
      if (ordersRes.ok) {
        const ordersData = await readJsonSafe(ordersRes)
        for (const order of (ordersData?.items || [])) {
          const aId = Array.isArray(order.bid) ? order.bid[0] : order.bid
          ordersByAuction[aId] = order
        }
      }
    }

    const result = uniqueBids.map(bid => ({
      ...bid,
      bid_order: ordersByAuction[bid.auction] || null,
    }))

    // Paginación manual simple
    const start  = (page - 1) * perPage
    const paged  = result.slice(start, start + perPage)

    res.json({
      items:      paged,
      totalItems: result.length,
      totalPages: Math.ceil(result.length / perPage),
      page,
      perPage,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Detalle de orden de subasta (comprador) ────────────────────────────────────
app.get('/buyer/:id', requireBuyer, async (req, res) => {
  try {
    const token   = await getAdminToken()
    const buyerId = req.headers['x-user-id']

    const pbRes = await fetch(
      `${PB_URL}/api/collections/orders_bid/records/${req.params.id}?expand=store,bid,approved_by,shipping`,
      { headers: pbHeaders(token) }
    )
    if (pbRes.status === 404) return res.status(404).json({ error: 'not_found' })
    const order = await readJsonSafe(pbRes)
    if (!pbRes.ok) return res.status(pbRes.status).json(order)

    if (order.buyer !== buyerId) return res.status(403).json({ error: 'forbidden' })

    res.json(order)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Subir comprobante de pago (comprador) ──────────────────────────────────────
app.post('/buyer/:id/proof', requireBuyer, upload.single('payment_proof'), async (req, res) => {
  try {
    const token   = await getAdminToken()
    const buyerId = req.headers['x-user-id']

    if (!req.file) return res.status(400).json({ error: 'payment_proof requerido' })

    const pbRes = await fetch(
      `${PB_URL}/api/collections/orders_bid/records/${req.params.id}`,
      { headers: pbHeaders(token) }
    )
    if (pbRes.status === 404) return res.status(404).json({ error: 'not_found' })
    const order = await readJsonSafe(pbRes)
    if (!pbRes.ok) return res.status(pbRes.status).json(order)

    if (order.buyer !== buyerId) return res.status(403).json({ error: 'forbidden' })

    // Solo puede subir si el pago no ha vencido y no está cancelado/rechazado
    if (['calcelled', 'cancelled', 'rejected', 'delivered'].includes(order.status)) {
      return res.status(400).json({ error: 'orden_no_permite_comprobante' })
    }
    if (order.payment_until && new Date(order.payment_until) < new Date()) {
      return res.status(400).json({ error: 'plazo_de_pago_vencido' })
    }

    const form = new FormData()
    form.append(
      'payment_proof',
      new Blob([req.file.buffer], { type: req.file.mimetype }),
      req.file.originalname || 'comprobante.jpg'
    )

    const patchRes = await fetch(
      `${PB_URL}/api/collections/orders_bid/records/${req.params.id}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
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

// ── Cron: cancelar órdenes con pago vencido ────────────────────────────────────
// Se ejecuta cada 30 minutos. Busca órdenes sin status (pendiente) y sin comprobante
// cuyo payment_until ya venció, las cancela y re-lista la subasta.
async function cancelExpiredBidOrders() {
  try {
    const token = await getAdminToken()
    const now   = new Date().toISOString()

    // status="pending" y payment_until < now
    const filter = encodeURIComponent(`status="pending" && payment_until<="${now}"`)
    const res = await fetch(
      `${PB_URL}/api/collections/orders_bid/records?filter=${filter}&perPage=200&fields=id,bid,payment_until,status`,
      { headers: pbHeaders(token) }
    )
    if (!res.ok) return
    const data = await readJsonSafe(res)
    const expired = data?.items || []

    for (const order of expired) {
      // Cancelar la orden
      await fetch(`${PB_URL}/api/collections/orders_bid/records/${order.id}`, {
        method: 'PATCH',
        headers: pbHeaders(token),
        body: JSON.stringify({ status: 'calcelled' }),
      })

      // Re-listar la subasta
      const auctionId = Array.isArray(order.bid) ? order.bid[0] : order.bid
      await relistAuction(token, auctionId)

      console.log(`[bid-order] Cancelled expired order ${order.id}, re-listed auction ${auctionId}`)
    }
  } catch (err) {
    console.error('[bid-order] cron cancel error:', err.message)
  }
}

// Correr al iniciar y luego cada 30 minutos
cancelExpiredBidOrders()
cron.schedule('*/30 * * * *', cancelExpiredBidOrders, { timezone: 'UTC' })

app.listen(PORT, () => console.log(`bid-order-service running on port ${PORT}`))
