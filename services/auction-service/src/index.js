const express = require('express')
const cors    = require('cors')
const multer  = require('multer')

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
    if (req.query.search)  filters.push(`title~"${req.query.search.replace(/"/g, '')}"`)

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

      const { title, description, store, product, start_price, reserve_price,
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
      if (reserve_price) formData.append('reserve_price', reserve_price)
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

    const ALLOWED = ['title', 'description', 'start_price', 'reserve_price',
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

app.listen(PORT, () => console.log(`auction-service running on port ${PORT}`))
