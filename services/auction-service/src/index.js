const express = require('express')
const cors    = require('cors')
const multer  = require('multer')
const cron    = require('node-cron')

const app    = express()
const PORT   = Number(process.env.PORT || 9004)
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

function userOwnsStore(store, userId) {
  const owners = Array.isArray(store?.owner)
    ? store.owner
    : (store?.owner ? [store.owner] : [])
  return owners.includes(userId)
}

async function checkAuctionOwner(token, auctionId, userId) {
  const res = await fetch(
    `${PB_URL}/api/collections/auctions/records/${auctionId}?expand=store`,
    { headers: pbHeaders(token) }
  )
  if (!res.ok) return false
  const auction = await res.json()
  return userOwnsStore(auction?.expand?.store, userId)
}

async function checkStoreOwner(token, storeId, userId) {
  const res = await fetch(
    `${PB_URL}/api/collections/stores/records/${storeId}?fields=id,owner`,
    { headers: pbHeaders(token) }
  )
  if (!res.ok) return false
  const store = await res.json()
  return userOwnsStore(store, userId)
}

// ── Health ─────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ service: 'auction-service', ok: true, port: PORT }))

// ── Listar subastas ────────────────────────────────────────────────────────────
// GET /?storeId=X&status=active|ended|draft|cancelled&page=1&perPage=20
app.get('/', async (req, res) => {
  try {
    const token   = await getAdminToken()
    const page    = Math.max(1, parseInt(req.query.page) || 1)
    const perPage = Math.min(100, parseInt(req.query.perPage) || 20)

    const filters = []
    if (req.query.storeId) filters.push(`store="${req.query.storeId.replace(/"/g, '')}"`)
    if (req.query.status)  filters.push(`status="${req.query.status.replace(/"/g, '')}"`)
    if (req.query.hasBuyNow === 'true') filters.push('buy_now_price > 0')

    const minCurrentPrice = Number(req.query.minCurrentPrice)
    const maxCurrentPrice = Number(req.query.maxCurrentPrice)
    if (Number.isFinite(minCurrentPrice) && minCurrentPrice >= 0) {
      filters.push(`current_price >= ${minCurrentPrice}`)
    }
    if (Number.isFinite(maxCurrentPrice) && maxCurrentPrice >= 0) {
      filters.push(`current_price <= ${maxCurrentPrice}`)
    }

    if (req.query.search) {
      const safeSearch = req.query.search.replace(/"/g, '')
      filters.push(`(title~"${safeSearch}" || description~"${safeSearch}")`)
    }

    const allowedSorts = new Set(['-created', 'created', 'end_date', '-end_date', 'start_price', '-start_price', 'current_price', '-current_price'])
    const safeSort = allowedSorts.has(req.query.sort) ? req.query.sort : '-created'

    const params = new URLSearchParams({
      page, perPage,
      sort: safeSort,
      expand: 'store,winner,product',
    })
    if (filters.length) params.set('filter', filters.join(' && '))

    const pbRes = await fetch(
      `${PB_URL}/api/collections/auctions/records?${params}`,
      { headers: pbHeaders(token) }
    )
    const data = await readJsonSafe(pbRes)
    if (!pbRes.ok) return res.status(pbRes.status).json(data)
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Subastas activas (público) ─────────────────────────────────────────────────
app.get('/active', async (_req, res) => {
  try {
    const token = await getAdminToken()
    const params = new URLSearchParams({
      page: 1, perPage: 20,
      filter: 'status="active"',
      sort: 'end_date',
      expand: 'store',
    })
    const pbRes = await fetch(
      `${PB_URL}/api/collections/auctions/records?${params}`,
      { headers: pbHeaders(token) }
    )
    const data = await readJsonSafe(pbRes)
    res.json(pbRes.ok ? data : { items: [] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Obtener subasta ────────────────────────────────────────────────────────────
app.get('/:id', async (req, res) => {
  try {
    const token = await getAdminToken()
    const pbRes = await fetch(
      `${PB_URL}/api/collections/auctions/records/${req.params.id}?expand=store,winner,product`,
      { headers: pbHeaders(token) }
    )
    if (pbRes.status === 404) return res.status(404).json({ error: 'not_found' })
    const data = await readJsonSafe(pbRes)
    if (!pbRes.ok) return res.status(pbRes.status).json(data)

    // Incluir las últimas pujas
    const bidsRes = await fetch(
      `${PB_URL}/api/collections/auction_bids/records?filter=auction%3D%22${req.params.id}%22&sort=-amount&perPage=10&expand=bidder`,
      { headers: pbHeaders(token) }
    )
    const bidsData = bidsRes.ok ? await readJsonSafe(bidsRes) : null
    data.bids = bidsData?.items || []

    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Crear subasta (vendor) ─────────────────────────────────────────────────────
app.post(
  '/',
  requireAuth,
  upload.array('images', 5),
  async (req, res) => {
    try {
      const token  = await getAdminToken()
      const userId = req.headers['x-user-id']
      const role   = req.headers['x-user-role']

      const { title, description, store, product, start_price,
              buy_now_price, start_date, end_date, status,
              discount_percent, discount_amount } = req.body

      if (!title || !store || !start_price || !start_date || !end_date) {
        return res.status(400).json({ error: 'title, store, start_price, start_date y end_date son obligatorios' })
      }

      if (role === 'vendor') {
        const owns = await checkStoreOwner(token, store, userId)
        if (!owns) return res.status(403).json({ error: 'no_eres_owner_de_esta_tienda' })
      }

      const formData = new FormData()
      formData.append('title', title)
      formData.append('description', description || '')
      formData.append('store', store)
      if (product) formData.append('product', product)
      formData.append('start_price', start_price)
      formData.append('current_price', start_price)
      if (buy_now_price) formData.append('buy_now_price', buy_now_price)
      formData.append('start_date', start_date)
      formData.append('end_date', end_date)
      formData.append('status', status || 'draft')
      formData.append('bids_count', '0')
      if (discount_percent) formData.append('discount_percent', discount_percent)
      if (discount_amount)  formData.append('discount_amount',  discount_amount)

      if (req.files?.length) {
        for (const file of req.files) {
          formData.append('images', new Blob([file.buffer], { type: file.mimetype }), file.originalname)
        }
      }

      const pbRes = await fetch(`${PB_URL}/api/collections/auctions/records`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      })

      const data = await readJsonSafe(pbRes)
      if (!pbRes.ok) return res.status(pbRes.status).json({ error: 'create_failed', details: data })
      res.status(201).json(data)
    } catch (err) {
      console.error('create auction error', err)
      res.status(500).json({ error: err.message })
    }
  }
)

// ── Actualizar subasta ─────────────────────────────────────────────────────────
app.patch('/:id', requireAuth, upload.array('images', 5), async (req, res) => {
  try {
    const token  = await getAdminToken()
    const userId = req.headers['x-user-id']
    const role   = req.headers['x-user-role']

    if (role === 'vendor') {
      const owns = await checkAuctionOwner(token, req.params.id, userId)
      if (!owns) return res.status(403).json({ error: 'forbidden' })
    }

    const ALLOWED = ['title', 'description', 'start_price',
                     'buy_now_price', 'start_date', 'end_date', 'status',
                     'discount_percent', 'discount_amount']

    const formData = new FormData()
    for (const key of ALLOWED) {
      if (req.body[key] !== undefined) formData.append(key, req.body[key])
    }
    if (req.files?.length) {
      for (const file of req.files) {
        formData.append('images', new Blob([file.buffer], { type: file.mimetype }), file.originalname)
      }
    }
    if (req.body.remove_images) {
      for (const fname of req.body.remove_images.split(',')) {
        if (fname.trim()) formData.append('images-', fname.trim())
      }
    }

    const pbRes = await fetch(
      `${PB_URL}/api/collections/auctions/records/${req.params.id}`,
      { method: 'PATCH', headers: { Authorization: `Bearer ${token}` }, body: formData }
    )
    const data = await readJsonSafe(pbRes)
    if (pbRes.status === 404) return res.status(404).json({ error: 'not_found' })
    if (!pbRes.ok) return res.status(pbRes.status).json({ error: 'update_failed', details: data })
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Listar pujas de una subasta (público) ─────────────────────────────────────
app.get('/:id/bids', async (req, res) => {
  try {
    const token = await getAdminToken()
    const page    = Math.max(1, parseInt(req.query.page) || 1)
    const perPage = Math.min(100, parseInt(req.query.perPage) || 50)
    const params = new URLSearchParams({
      page, perPage,
      filter: `auction="${req.params.id.replace(/"/g, '')}"`,
      sort:   '-amount',
      expand: 'bidder',
    })
    const pbRes = await fetch(
      `${PB_URL}/api/collections/auction_bids/records?${params}`,
      { headers: pbHeaders(token) }
    )
    const data = await readJsonSafe(pbRes)
    if (!pbRes.ok) return res.status(pbRes.status).json(data)
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Helper: crear orders_bid cuando hay ganador ────────────────────────────────
async function createBidOrder(token, auction, winnerId, winningAmount) {
  try {
    const auctionId = auction.id
    // Evitar duplicados
    const existRes = await fetch(
      `${PB_URL}/api/collections/orders_bid/records?filter=${encodeURIComponent(`bid="${auctionId}"`)}&perPage=1&fields=id`,
      { headers: pbHeaders(token) }
    )
    if (existRes.ok) {
      const existData = await readJsonSafe(existRes)
      if (existData?.items?.length > 0) return
    }

    const storeId = Array.isArray(auction.store) ? auction.store[0] : auction.store
    const paymentUntil = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()

    await fetch(`${PB_URL}/api/collections/orders_bid/records`, {
      method: 'POST',
      headers: pbHeaders(token),
      body: JSON.stringify({
        buyer:         winnerId,
        store:         storeId,
        bid:           auctionId,
        total:         winningAmount,
        currency:      'BS',
        status:        'pending',
        payment_until: paymentUntil,
      }),
    })
  } catch (err) {
    console.error('[auction] createBidOrder error:', err.message)
  }
}

// ── Helper: cargar subasta completa ───────────────────────────────────────────
async function loadAuction(token, auctionId) {
  const pbRes = await fetch(
    `${PB_URL}/api/collections/auctions/records/${auctionId}?expand=store`,
    { headers: pbHeaders(token) }
  )
  if (!pbRes.ok) return null
  return pbRes.json()
}

function minIncrement(currentPrice) {
  const price = Number(currentPrice || 0)
  if (price < 100)    return 1
  if (price < 1000)   return 10
  if (price < 10000)  return 50
  return 100
}

// ── Pujar ─────────────────────────────────────────────────────────────────────
// POST /:id/bids  { amount, is_auto_bid, auto_bid_max }
app.post('/:id/bids', async (req, res) => {
  try {
    const userId = (req.headers['x-user-id'] || '').trim()
    if (!userId) return res.status(401).json({ error: 'unauthorized' })

    const token   = await getAdminToken()
    const auction = await loadAuction(token, req.params.id)
    if (!auction) return res.status(404).json({ error: 'not_found' })

    if (auction.status !== 'active') {
      return res.status(400).json({ error: 'auction_not_active' })
    }
    const now = Date.now()
    if (new Date(auction.start_date).getTime() > now) {
      return res.status(400).json({ error: 'auction_not_started' })
    }
    if (new Date(auction.end_date).getTime() <= now) {
      return res.status(400).json({ error: 'auction_ended' })
    }

    // Vendedor no puede pujar en su propia subasta
    if (userOwnsStore(auction?.expand?.store, userId)) {
      return res.status(403).json({ error: 'cannot_bid_own_auction' })
    }

    // No puedes pujarte a ti mismo: si ya eres el top bidder, esperá que alguien te supere
    if (Number(auction.bids_count || 0) > 0) {
      const lastBidParams = new URLSearchParams({
        filter:  `auction="${req.params.id}"`,
        sort:    '-amount,-created',
        perPage: '1',
        fields:  'id,bidder',
      })
      const lastBidRes  = await fetch(
        `${PB_URL}/api/collections/auction_bids/records?${lastBidParams}`,
        { headers: pbHeaders(token) }
      )
      const lastBidData  = await readJsonSafe(lastBidRes)
      const lastBidder   = lastBidData?.items?.[0]?.bidder
      const lastBidderId = Array.isArray(lastBidder) ? lastBidder[0] : lastBidder
      if (lastBidderId && lastBidderId === userId) {
        return res.status(403).json({ error: 'already_top_bidder' })
      }
    }

    const amount = Number(req.body?.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'invalid_amount' })
    }

    const currentPrice = Number(auction.current_price || auction.start_price || 0)
    const hasBids      = Number(auction.bids_count || 0) > 0
    const minRequired  = hasBids ? currentPrice + minIncrement(currentPrice) : currentPrice
    if (amount < minRequired) {
      return res.status(400).json({
        error: 'amount_too_low',
        min_required: minRequired,
        current_price: currentPrice,
      })
    }

    const isAutoBid  = Boolean(req.body?.is_auto_bid)
    const autoBidMax = Number(req.body?.auto_bid_max || 0)
    if (isAutoBid && autoBidMax < amount) {
      return res.status(400).json({ error: 'auto_bid_max_below_amount' })
    }

    // Cap al buy_now_price: si la puja lo alcanza o supera, se tope exactamente ahí
    const buyNowPrice    = Number(auction.buy_now_price || 0)
    const reachesBuyNow  = buyNowPrice > 0 && amount >= buyNowPrice
    const finalAmount    = reachesBuyNow ? buyNowPrice : amount
    const finalAutoMax   = isAutoBid ? Math.min(autoBidMax, reachesBuyNow ? buyNowPrice : autoBidMax) : 0

    // Crear puja
    const createRes = await fetch(`${PB_URL}/api/collections/auction_bids/records`, {
      method:  'POST',
      headers: pbHeaders(token),
      body:    JSON.stringify({
        auction:      req.params.id,
        bidder:       userId,
        amount:       finalAmount,
        is_auto_bid:  isAutoBid,
        auto_bid_max: finalAutoMax,
      }),
    })
    const bidData = await readJsonSafe(createRes)
    if (!createRes.ok) return res.status(createRes.status).json({ error: 'bid_failed', details: bidData })

    // Actualizar subasta (current_price, bids_count)
    const patchBody = {
      current_price: finalAmount,
      bids_count:    Number(auction.bids_count || 0) + 1,
    }
    if (reachesBuyNow) {
      patchBody.status = 'ended'
      patchBody.winner = userId
    }

    await fetch(`${PB_URL}/api/collections/auctions/records/${req.params.id}`, {
      method:  'PATCH',
      headers: pbHeaders(token),
      body:    JSON.stringify(patchBody),
    })

    if (reachesBuyNow) {
      await createBidOrder(token, auction, userId, finalAmount)
    }

    res.status(201).json({
      ok: true,
      bid: bidData,
      final_amount: finalAmount,
      capped: reachesBuyNow && amount > buyNowPrice,
      won_auction: reachesBuyNow,
      ...patchBody,
    })
  } catch (err) {
    console.error('bid error', err)
    res.status(500).json({ error: err.message })
  }
})

// ── Comprar ahora ─────────────────────────────────────────────────────────────
// POST /:id/buy-now
app.post('/:id/buy-now', async (req, res) => {
  try {
    const userId = (req.headers['x-user-id'] || '').trim()
    if (!userId) return res.status(401).json({ error: 'unauthorized' })

    const token   = await getAdminToken()
    const auction = await loadAuction(token, req.params.id)
    if (!auction) return res.status(404).json({ error: 'not_found' })

    if (auction.status !== 'active') return res.status(400).json({ error: 'auction_not_active' })
    if (!auction.buy_now_price || Number(auction.buy_now_price) <= 0) {
      return res.status(400).json({ error: 'buy_now_not_available' })
    }
    if (userOwnsStore(auction?.expand?.store, userId)) {
      return res.status(403).json({ error: 'cannot_bid_own_auction' })
    }

    const amount = Number(auction.buy_now_price)

    const createRes = await fetch(`${PB_URL}/api/collections/auction_bids/records`, {
      method:  'POST',
      headers: pbHeaders(token),
      body:    JSON.stringify({ auction: req.params.id, bidder: userId, amount }),
    })
    const bidData = await readJsonSafe(createRes)
    if (!createRes.ok) return res.status(createRes.status).json({ error: 'buy_now_failed', details: bidData })

    await fetch(`${PB_URL}/api/collections/auctions/records/${req.params.id}`, {
      method:  'PATCH',
      headers: pbHeaders(token),
      body:    JSON.stringify({
        current_price: amount,
        bids_count:    Number(auction.bids_count || 0) + 1,
        status:        'ended',
        winner:        userId,
      }),
    })

    await createBidOrder(token, auction, userId, amount)

    res.status(200).json({ ok: true, bid: bidData, status: 'ended', winner: userId })
  } catch (err) {
    console.error('buy-now error', err)
    res.status(500).json({ error: err.message })
  }
})

// ── Cerrar subasta manualmente (vendor) ───────────────────────────────────────
// POST /:id/end
app.post('/:id/end', requireAuth, async (req, res) => {
  try {
    const token  = await getAdminToken()
    const userId = req.headers['x-user-id']
    const role   = req.headers['x-user-role']

    if (role === 'vendor') {
      const owns = await checkAuctionOwner(token, req.params.id, userId)
      if (!owns) return res.status(403).json({ error: 'forbidden' })
    }

    // Buscar la puja ganadora
    const bidParams = new URLSearchParams({
      filter:  `auction="${req.params.id}"`,
      sort:    '-amount',
      perPage: '1',
    })
    const bidRes = await fetch(
      `${PB_URL}/api/collections/auction_bids/records?${bidParams}`,
      { headers: pbHeaders(token) }
    )
    const bidData = bidRes.ok ? await readJsonSafe(bidRes) : null
    const winningBid = bidData?.items?.[0] || null

    const patchBody = { status: 'ended' }
    if (winningBid) {
      patchBody.winner        = winningBid.bidder
      patchBody.current_price = winningBid.amount
    }

    const pbRes = await fetch(
      `${PB_URL}/api/collections/auctions/records/${req.params.id}`,
      { method: 'PATCH', headers: pbHeaders(token), body: JSON.stringify(patchBody) }
    )
    const data = await readJsonSafe(pbRes)
    if (!pbRes.ok) return res.status(pbRes.status).json({ error: 'end_failed', details: data })

    if (winningBid) {
      const auctionForOrder = { id: req.params.id, store: data.store }
      await createBidOrder(token, auctionForOrder, winningBid.bidder, winningBid.amount)
    }

    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Eliminar subasta ───────────────────────────────────────────────────────────
app.delete('/:id', requireAuth, async (req, res) => {
  try {
    const token  = await getAdminToken()
    const userId = req.headers['x-user-id']
    const role   = req.headers['x-user-role']

    if (role === 'vendor') {
      const owns = await checkAuctionOwner(token, req.params.id, userId)
      if (!owns) return res.status(403).json({ error: 'forbidden' })
    }

    const pbRes = await fetch(
      `${PB_URL}/api/collections/auctions/records/${req.params.id}`,
      { method: 'DELETE', headers: pbHeaders(token) }
    )
    if (pbRes.status === 404) return res.status(404).json({ error: 'not_found' })
    if (!pbRes.ok && pbRes.status !== 204) return res.status(pbRes.status).json({ error: 'delete_failed' })
    res.status(204).send()
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Cron: expirar subastas cuyo end_date ya pasó ─────────────────────────────
// Se ejecuta cada minuto. Busca subastas con status='active' y end_date <= ahora,
// las marca como 'ended', asigna el ganador (puja más alta) y crea el orders_bid.
// Mismo flujo que POST /:id/end, pero automático.
async function expireAuctions() {
  try {
    const token = await getAdminToken()
    const now   = new Date()

    // Traer todas las activas (hasta 200) y filtrar por end_date en JS
    // para evitar problemas de formato de fecha en el filtro de PocketBase.
    const params = new URLSearchParams({
      filter:  'status="active"',
      perPage: '200',
      fields:  'id,end_date,store,current_price',
    })
    const listRes = await fetch(
      `${PB_URL}/api/collections/auctions/records?${params}`,
      { headers: pbHeaders(token) }
    )
    if (!listRes.ok) return

    const listData = await readJsonSafe(listRes)
    const expired  = (listData?.items || []).filter(a => new Date(a.end_date) <= now)
    if (!expired.length) return

    console.log(`[auction-cron] Expirando ${expired.length} subasta(s)...`)

    for (const auction of expired) {
      try {
        // Buscar la puja ganadora (monto más alto)
        const bidParams = new URLSearchParams({
          filter:  `auction="${auction.id}"`,
          sort:    '-amount',
          perPage: '1',
        })
        const bidRes  = await fetch(
          `${PB_URL}/api/collections/auction_bids/records?${bidParams}`,
          { headers: pbHeaders(token) }
        )
        const bidData    = bidRes.ok ? await readJsonSafe(bidRes) : null
        const winningBid = bidData?.items?.[0] || null

        // Actualizar estado de la subasta
        const patchBody = { status: 'ended' }
        if (winningBid) {
          patchBody.winner        = winningBid.bidder
          patchBody.current_price = winningBid.amount
        }

        const patchRes = await fetch(
          `${PB_URL}/api/collections/auctions/records/${auction.id}`,
          { method: 'PATCH', headers: pbHeaders(token), body: JSON.stringify(patchBody) }
        )
        if (!patchRes.ok) {
          console.error(`[auction-cron] Error al expirar ${auction.id}: ${patchRes.status}`)
          continue
        }

        // Crear orden de puja para el ganador
        if (winningBid) {
          await createBidOrder(token, auction, winningBid.bidder, winningBid.amount)
        }

        console.log(
          `[auction-cron] Expirada: ${auction.id}` +
          (winningBid ? ` → ganador: ${winningBid.bidder}` : ' (sin pujas)')
        )
      } catch (err) {
        console.error(`[auction-cron] Error procesando ${auction.id}:`, err.message)
      }
    }
  } catch (err) {
    console.error('[auction-cron] Error general:', err.message)
  }
}

// Ejecutar al arrancar (para expirar inmediatamente las pendientes)
// y luego cada minuto.
expireAuctions()
cron.schedule('* * * * *', expireAuctions, { timezone: 'UTC' })

app.listen(PORT, () => console.log(`auction-service running on port ${PORT}`))
