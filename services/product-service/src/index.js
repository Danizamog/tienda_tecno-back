const express = require('express')
const cors    = require('cors')
const multer  = require('multer')

const app    = express()
const PORT   = Number(process.env.PORT || 9003)
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

// Verifica que el producto pertenezca a una tienda del usuario
async function checkProductOwner(token, productId, userId) {
  const res = await fetch(
    `${PB_URL}/api/collections/products/records/${productId}?expand=store`,
    { headers: pbHeaders(token) }
  )
  if (!res.ok) return false
  const product = await res.json()
  return userOwnsStore(product?.expand?.store, userId)
}

// Verifica que la tienda pertenezca al usuario
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
app.get('/health', (_req, res) => res.json({ service: 'product-service', ok: true, port: PORT }))

// ── Categorías (público) ───────────────────────────────────────────────────────
app.get('/categories', async (_req, res) => {
  try {
    const token = await getAdminToken()
    const pbRes = await fetch(
      `${PB_URL}/api/collections/categories/records?perPage=100&sort=name&fields=id,name,slug`,
      { headers: pbHeaders(token) }
    )
    const data = await readJsonSafe(pbRes)
    res.json(pbRes.ok ? data : { items: [] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Listar productos ───────────────────────────────────────────────────────────
// GET /?storeId=X&status=active&search=texto&page=1&perPage=20
app.get('/', async (req, res) => {
  try {
    const token   = await getAdminToken()
    const page    = Math.max(1, parseInt(req.query.page) || 1)
    const perPage = Math.min(100, parseInt(req.query.perPage) || 20)

    const filters = []
    if (req.query.storeId)    filters.push(`store="${req.query.storeId.replace(/"/g, '')}"`)
    if (req.query.categoryId) filters.push(`category="${req.query.categoryId.replace(/"/g, '')}"`)
    if (req.query.status)     filters.push(`status="${req.query.status.replace(/"/g, '')}"`)
    if (req.query.condition)  filters.push(`condition="${req.query.condition.replace(/"/g, '')}"`)
    if (req.query.search)     filters.push(`name~"${req.query.search.replace(/"/g, '')}"`)

    const params = new URLSearchParams({
      page, perPage,
      sort: req.query.sort || '-created',
      expand: 'category,store',
    })
    if (filters.length) params.set('filter', filters.join(' && '))

    const pbRes = await fetch(
      `${PB_URL}/api/collections/products/records?${params}`,
      { headers: pbHeaders(token) }
    )
    const data = await readJsonSafe(pbRes)
    if (!pbRes.ok) return res.status(pbRes.status).json(data)
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Obtener producto ───────────────────────────────────────────────────────────
app.get('/:id', async (req, res) => {
  try {
    const token = await getAdminToken()
    const pbRes = await fetch(
      `${PB_URL}/api/collections/products/records/${req.params.id}?expand=category,store`,
      { headers: pbHeaders(token) }
    )
    if (pbRes.status === 404) return res.status(404).json({ error: 'not_found' })
    const data = await readJsonSafe(pbRes)
    if (!pbRes.ok) return res.status(pbRes.status).json(data)
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Crear producto (vendor) ────────────────────────────────────────────────────
app.post(
  '/',
  requireAuth,
  upload.array('images', 5),
  async (req, res) => {
    try {
      const token  = await getAdminToken()
      const userId = req.headers['x-user-id']
      const role   = req.headers['x-user-role']

      const { name, description, price, store, category, stock, status,
              condition, featured, discount_percent, discount_amount,
              discount_starts_at, discount_ends_at } = req.body

      if (!name || !price || !store) {
        return res.status(400).json({ error: 'name, price y store son obligatorios' })
      }

      // Solo admin puede crear en cualquier tienda; vendor debe ser owner
      if (role === 'vendor') {
        const owns = await checkStoreOwner(token, store, userId)
        if (!owns) return res.status(403).json({ error: 'no_eres_owner_de_esta_tienda' })
      }

      const formData = new FormData()
      formData.append('name', name)
      formData.append('description', description || '')
      formData.append('price', price)
      formData.append('store', store)
      if (category) formData.append('category', category)
      formData.append('stock', stock ?? 1)
      formData.append('status', status || 'active')
      formData.append('condition', condition || 'new')
      formData.append('featured', featured === 'true' || featured === true ? 'true' : 'false')
      if (discount_percent) formData.append('discount_percent', discount_percent)
      if (discount_amount)  formData.append('discount_amount',  discount_amount)
      if (discount_starts_at) formData.append('discount_starts_at', discount_starts_at)
      if (discount_ends_at)   formData.append('discount_ends_at',   discount_ends_at)

      if (req.files?.length) {
        for (const file of req.files) {
          formData.append('images', new Blob([file.buffer], { type: file.mimetype }), file.originalname)
        }
      }

      const pbRes = await fetch(`${PB_URL}/api/collections/products/records`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      })

      const data = await readJsonSafe(pbRes)
      if (!pbRes.ok) return res.status(pbRes.status).json({ error: 'create_failed', details: data })
      res.status(201).json(data)
    } catch (err) {
      console.error('create product error', err)
      res.status(500).json({ error: err.message })
    }
  }
)

// ── Actualizar producto ────────────────────────────────────────────────────────
app.patch(
  '/:id',
  requireAuth,
  upload.array('images', 5),
  async (req, res) => {
    try {
      const token  = await getAdminToken()
      const userId = req.headers['x-user-id']
      const role   = req.headers['x-user-role']

      if (role === 'vendor') {
        const owns = await checkProductOwner(token, req.params.id, userId)
        if (!owns) return res.status(403).json({ error: 'forbidden' })
      }

      const formData = new FormData()
      const ALLOWED = ['name', 'description', 'price', 'category', 'stock', 'status',
                       'condition', 'featured', 'discount_percent', 'discount_amount',
                       'discount_starts_at', 'discount_ends_at']

      for (const key of ALLOWED) {
        if (req.body[key] !== undefined) {
          formData.append(key, req.body[key])
        }
      }

      if (req.files?.length) {
        for (const file of req.files) {
          formData.append('images', new Blob([file.buffer], { type: file.mimetype }), file.originalname)
        }
      }

      // Si quiere eliminar imágenes: body.remove_images = 'filename1,filename2'
      if (req.body.remove_images) {
        for (const fname of req.body.remove_images.split(',')) {
          if (fname.trim()) formData.append('images-', fname.trim())
        }
      }

      const pbRes = await fetch(
        `${PB_URL}/api/collections/products/records/${req.params.id}`,
        { method: 'PATCH', headers: { Authorization: `Bearer ${token}` }, body: formData }
      )

      const data = await readJsonSafe(pbRes)
      if (pbRes.status === 404) return res.status(404).json({ error: 'not_found' })
      if (!pbRes.ok) return res.status(pbRes.status).json({ error: 'update_failed', details: data })
      res.json(data)
    } catch (err) {
      console.error('update product error', err)
      res.status(500).json({ error: err.message })
    }
  }
)

// ── Cambio rápido de estado/stock (sin multipart) ────────────────────────────
app.patch('/:id/status', requireAuth, async (req, res) => {
  try {
    const token  = await getAdminToken()
    const userId = req.headers['x-user-id']
    const role   = req.headers['x-user-role']

    if (role === 'vendor') {
      const owns = await checkProductOwner(token, req.params.id, userId)
      if (!owns) return res.status(403).json({ error: 'forbidden' })
    }

    const allowedStatuses = new Set(['active', 'reserved', 'sold', 'draft', 'out_of_stock', 'archived'])
    const nextStatus = typeof req.body.status === 'string' ? req.body.status : undefined
    const hasStock = req.body.stock !== undefined && req.body.stock !== null && req.body.stock !== ''

    if (!nextStatus && !hasStock) {
      return res.status(400).json({ error: 'status_or_stock_required' })
    }

    const payload = {}
    if (nextStatus) {
      if (!allowedStatuses.has(nextStatus)) {
        return res.status(400).json({ error: 'invalid_status' })
      }
      payload.status = nextStatus
    }

    if (hasStock) {
      const parsedStock = Number(req.body.stock)
      if (Number.isNaN(parsedStock) || parsedStock < 0) {
        return res.status(400).json({ error: 'invalid_stock' })
      }
      payload.stock = parsedStock
    }

    // Reglas automáticas de estado según stock.
    if (hasStock) {
      if (payload.stock === 0) payload.status = 'out_of_stock'
      else if (!payload.status || payload.status === 'out_of_stock') payload.status = 'draft'
    }

    // PocketBase maneja mejor updates numéricos por FormData en este flujo.
    const formData = new FormData()
    if (payload.status !== undefined) formData.append('status', String(payload.status))
    if (payload.stock !== undefined) formData.append('stock', String(payload.stock))

    let pbRes = await fetch(
      `${PB_URL}/api/collections/products/records/${req.params.id}`,
      { method: 'PATCH', headers: { Authorization: `Bearer ${token}` }, body: formData }
    )

    let data = await readJsonSafe(pbRes)
    if (!pbRes.ok && payload.stock === 0) {
      const stockValidationError = data?.data?.stock?.code === 'validation_required'
      if (stockValidationError) {
        // Fallback para esquemas donde PocketBase rechaza 0 en number required.
        const fallbackForm = new FormData()
        if (payload.status !== undefined) fallbackForm.append('status', String(payload.status))
        pbRes = await fetch(
          `${PB_URL}/api/collections/products/records/${req.params.id}`,
          { method: 'PATCH', headers: { Authorization: `Bearer ${token}` }, body: fallbackForm }
        )
        data = await readJsonSafe(pbRes)
      }
    }

    if (pbRes.status === 404) return res.status(404).json({ error: 'not_found' })
    if (!pbRes.ok) return res.status(pbRes.status).json({ error: 'status_update_failed', details: data })

    return res.json(data)
  } catch (err) {
    console.error('quick status product error', err)
    return res.status(500).json({ error: err.message })
  }
})

// ── Eliminar producto ──────────────────────────────────────────────────────────
app.delete('/:id', requireAuth, async (req, res) => {
  try {
    const token  = await getAdminToken()
    const userId = req.headers['x-user-id']
    const role   = req.headers['x-user-role']

    if (role === 'vendor') {
      const owns = await checkProductOwner(token, req.params.id, userId)
      if (!owns) return res.status(403).json({ error: 'forbidden' })
    }

    const pbRes = await fetch(
      `${PB_URL}/api/collections/products/records/${req.params.id}`,
      { method: 'DELETE', headers: pbHeaders(token) }
    )

    if (pbRes.status === 404) return res.status(404).json({ error: 'not_found' })
    if (!pbRes.ok && pbRes.status !== 204) {
      return res.status(pbRes.status).json({ error: 'delete_failed' })
    }
    res.status(204).send()
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Stats de productos por tienda ──────────────────────────────────────────────
app.get('/vendor/stats/:storeId', requireAuth, async (req, res) => {
  try {
    const token  = await getAdminToken()
    const userId = req.headers['x-user-id']
    const role   = req.headers['x-user-role']
    const { storeId } = req.params

    if (role === 'vendor') {
      const owns = await checkStoreOwner(token, storeId, userId)
      if (!owns) return res.status(403).json({ error: 'forbidden' })
    }

    const sid = storeId.replace(/"/g, '')
    const countByStatus = async (status) => {
      const r = await fetch(
        `${PB_URL}/api/collections/products/records?page=1&perPage=1&fields=id&filter=store%3D%22${sid}%22%20%26%26%20status%3D%22${status}%22`,
        { headers: pbHeaders(token) }
      )
      const d = await readJsonSafe(r)
      return Number(d?.totalItems || 0)
    }

    const [active, draft, sold, out_of_stock, total] = await Promise.all([
      countByStatus('active'),
      countByStatus('draft'),
      countByStatus('sold'),
      countByStatus('out_of_stock'),
      (async () => {
        const r = await fetch(
          `${PB_URL}/api/collections/products/records?page=1&perPage=1&fields=id&filter=store%3D%22${sid}%22`,
          { headers: pbHeaders(token) }
        )
        const d = await readJsonSafe(r)
        return Number(d?.totalItems || 0)
      })(),
    ])

    res.json({ active, draft, sold, out_of_stock, total })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.listen(PORT, () => console.log(`product-service running on port ${PORT}`))
