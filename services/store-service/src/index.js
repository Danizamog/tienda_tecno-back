const express = require('express')
const cors    = require('cors')
const multer  = require('multer')

const app = express()
const PORT = Number(process.env.PORT || 9002)

const upload = multer({ storage: multer.memoryStorage() })

app.use(cors())
app.use(express.json())

const PB_URL = (process.env.POCKETBASE_URL || '').replace(/\/$/, '')
const PB_IDENTITY = process.env.POCKETBASE_AUTH_IDENTITY || ''
const PB_PASSWORD = process.env.POCKETBASE_AUTH_PASSWORD || ''

// ── Token de admin cacheado (válido 55 min) ──────────────────────────────────
let _adminToken = null
let _adminTokenExpiry = 0

async function readJsonSafe(res) {
  const text = await res.text()
  if (!text) return null
  try { return JSON.parse(text) } catch { return { raw: text } }
}

function compactDetails(details) {
  if (!details) return ''
  const raw = typeof details === 'string' ? details : JSON.stringify(details)
  const normalized = raw.replace(/\s+/g, ' ').trim()
  return normalized.length > 220 ? `${normalized.slice(0, 220)}...` : normalized
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
    throw new Error(`PocketBase admin auth failed (${res.status}): ${compactDetails(details)}`)
  }

  const { token } = await res.json()
  _adminToken = token
  _adminTokenExpiry = Date.now() + 55 * 60 * 1000
  return token
}

function pbHeaders(token) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
}

function safeFilterValue(value) {
  return String(value || '').replace(/"/g, '')
}

function userOwnsStore(store, userId) {
  const owners = Array.isArray(store?.owner)
    ? store.owner
    : (store?.owner ? [store.owner] : [])
  return owners.includes(userId)
}

async function listCollection(token, collection, params = {}) {
  const searchParams = new URLSearchParams()

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      searchParams.set(key, String(value))
    }
  }

  const res = await fetch(`${PB_URL}/api/collections/${collection}/records?${searchParams}`, {
    headers: pbHeaders(token),
  })

  if (!res.ok) {
    const details = await readJsonSafe(res)
    throw new Error(`${collection}_list_failed:${res.status}:${JSON.stringify(details)}`)
  }

  return res.json()
}

async function countCollection(token, collection, filter = '') {
  const data = await listCollection(token, collection, {
    page: 1,
    perPage: 1,
    sort: '-created',
    fields: 'id',
    ...(filter ? { filter } : {}),
  })

  return Number(data?.totalItems || 0)
}

// ── Middleware de rol ─────────────────────────────────────────────────────────
function requireRole(...roles) {
  return (req, res, next) => {
    const role = (req.headers['x-user-role'] || '').trim()
    if (!roles.includes(role)) {
      return res.status(403).json({ error: 'forbidden', required: roles })
    }
    next()
  }
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ service: 'store-service', ok: true, port: PORT })
})

// ── Listar tiendas ────────────────────────────────────────────────────────────
// GET /  ?page=1&perPage=20&status=active&search=texto&verified=true&sort=-id
app.get('/', async (req, res) => {
  try {
    const token = await getAdminToken()

    const page    = Math.max(1, parseInt(req.query.page)    || 1)
    const perPage = Math.min(100, parseInt(req.query.perPage) || 20)

    const filters = []
    if (req.query.status)   filters.push(`status="${req.query.status}"`)
    if (req.query.search)   filters.push(`(name~"${req.query.search.replace(/"/g, '')}" || slug~"${req.query.search.replace(/"/g, '')}")`)
    if (req.query.verified === 'true')  filters.push('verified=true')
    if (req.query.verified === 'false') filters.push('verified=false')

    const allowedSorts = new Set(['id', '-id', 'name', '-name', 'rating', '-rating'])
    const requestedSort = String(req.query.sort || '-id')
    const safeSort = allowedSorts.has(requestedSort) ? requestedSort : '-id'

    const params = new URLSearchParams({
      page,
      perPage,
      expand: 'owner',
      sort: safeSort,
    })
    if (filters.length) params.set('filter', filters.join(' && '))

    const pbRes = await fetch(`${PB_URL}/api/collections/stores/records?${params}`, {
      headers: pbHeaders(token),
    })

    if (!pbRes.ok) {
      const details = await readJsonSafe(pbRes)
      return res.status(pbRes.status).json({ error: 'pb_error', details })
    }

    res.json(await pbRes.json())
  } catch (err) {
    console.error('list stores error', err)
    res.status(500).json({ error: err.message })
  }
})

// ── Tiendas destacadas (público) ──────────────────────────────────────────────
app.get('/featured', async (_req, res) => {
  try {
    const token = await getAdminToken()
    const params = new URLSearchParams({
      page: 1, perPage: 6,
      filter: 'status="active" && verified=true',
      sort: '-rating',
      expand: 'owner',
    })
    const pbRes = await fetch(`${PB_URL}/api/collections/stores/records?${params}`, {
      headers: pbHeaders(token),
    })
    const data = pbRes.ok ? await pbRes.json() : { items: [] }
    res.json({ items: data.items || [] })
  } catch (err) {
    console.error('featured stores error', err)
    res.json({ items: [] })
  }
})

// ── Proxy de archivos de tiendas (logo/banner) ───────────────────────────────
app.get('/files/stores/:id/:filename', async (req, res) => {
  try {
    const { id, filename } = req.params
    const url = `${PB_URL}/api/files/stores/${encodeURIComponent(id)}/${encodeURIComponent(filename)}`

    const fileRes = await fetch(url)
    if (!fileRes.ok) {
      return res.status(fileRes.status).send('file_not_found')
    }

    const contentType = fileRes.headers.get('content-type')
    if (contentType) res.setHeader('Content-Type', contentType)

    const buffer = Buffer.from(await fileRes.arrayBuffer())
    return res.send(buffer)
  } catch (err) {
    console.error('store file proxy error', err)
    return res.status(500).send('file_proxy_error')
  }
})

// ── Proxy de avatar de usuarios ──────────────────────────────────────────────
app.get('/files/users/:id/:filename', async (req, res) => {
  try {
    const { id, filename } = req.params
    const url = `${PB_URL}/api/files/users/${encodeURIComponent(id)}/${encodeURIComponent(filename)}`

    const fileRes = await fetch(url)
    if (!fileRes.ok) {
      return res.status(fileRes.status).send('file_not_found')
    }

    const contentType = fileRes.headers.get('content-type')
    if (contentType) res.setHeader('Content-Type', contentType)

    const buffer = Buffer.from(await fileRes.arrayBuffer())
    return res.send(buffer)
  } catch (err) {
    console.error('user file proxy error', err)
    return res.status(500).send('file_proxy_error')
  }
})

// ── Obtener tienda por slug ───────────────────────────────────────────────────
app.get('/by-slug/:slug', async (req, res) => {
  try {
    const token = await getAdminToken()
    const slug  = safeFilterValue(req.params.slug)
    const params = new URLSearchParams({
      filter:  `slug="${slug}"`,
      perPage: 1,
      expand:  'owner',
    })
    const pbRes = await fetch(
      `${PB_URL}/api/collections/stores/records?${params}`,
      { headers: pbHeaders(token) }
    )
    if (!pbRes.ok) return res.status(pbRes.status).json({ error: 'pb_error' })
    const data  = await pbRes.json()
    const store = data.items?.[0]
    if (!store) return res.status(404).json({ error: 'not_found' })
    res.json(store)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Obtener tienda por ID ─────────────────────────────────────────────────────
app.get('/:id', async (req, res) => {
  try {
    const token = await getAdminToken()
    const pbRes = await fetch(
      `${PB_URL}/api/collections/stores/records/${req.params.id}?expand=owner`,
      { headers: pbHeaders(token) }
    )
    if (pbRes.status === 404) return res.status(404).json({ error: 'not_found' })
    if (!pbRes.ok) return res.status(pbRes.status).json({ error: 'pb_error' })
    res.json(await pbRes.json())
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Crear tienda (solo admin) ─────────────────────────────────────────────────
app.post(
  '/',
  requireRole('admin'),
  upload.fields([
    { name: 'logo', maxCount: 1 },
    { name: 'banner', maxCount: 1 },
  ]),
  async (req, res) => {
  try {
    const token = await getAdminToken()
    const { name, slug, description, owner, status, location, whatsapp, instagram } = req.body

    if (!name || !slug || !owner) {
      return res.status(400).json({ error: 'name, slug y owner son obligatorios' })
    }

    const logoFile = req.files?.logo?.[0]
    const bannerFile = req.files?.banner?.[0]

    let pbRes
    if (logoFile || bannerFile) {
      const formData = new FormData()
      formData.append('name', name)
      formData.append('slug', slug)
      formData.append('description', description || '')
      formData.append('owner', owner)
      formData.append('status', status || 'pending')
      formData.append('verified', 'false')
      formData.append('location', location || '')
      formData.append('whatsapp', whatsapp || '')
      formData.append('instagram', instagram || '')
      formData.append('rating', '0')
      formData.append('reviews_count', '0')
      formData.append('rating_sum', '0')

      if (logoFile) {
        formData.append('logo', new Blob([logoFile.buffer], { type: logoFile.mimetype }), logoFile.originalname)
      }
      if (bannerFile) {
        formData.append('banner', new Blob([bannerFile.buffer], { type: bannerFile.mimetype }), bannerFile.originalname)
      }

      pbRes = await fetch(`${PB_URL}/api/collections/stores/records`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      })
    } else {
      pbRes = await fetch(`${PB_URL}/api/collections/stores/records`, {
        method: 'POST',
        headers: pbHeaders(token),
        body: JSON.stringify({
          name,
          slug,
          description: description || '',
          owner,
          status: status || 'pending',
          verified: false,
          location: location || '',
          whatsapp: whatsapp || '',
          instagram: instagram || '',
          rating: 0,
          reviews_count: 0,
          rating_sum: 0,
        }),
      })
    }

    if (!pbRes.ok) {
      const details = await readJsonSafe(pbRes)
      return res.status(pbRes.status).json({ error: 'create_failed', details })
    }

    res.status(201).json(await pbRes.json())
  } catch (err) {
    console.error('create store error', err)
    res.status(500).json({ error: err.message })
  }
})

// ── Subir imágenes (logo / banner) — solo admin ───────────────────────────────
app.patch(
  '/:id/images',
  requireRole('admin'),
  upload.fields([
    { name: 'logo',   maxCount: 1 },
    { name: 'banner', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const token = await getAdminToken()
      const formData = new FormData()

      const logoFile   = req.files?.logo?.[0]
      const bannerFile = req.files?.banner?.[0]

      if (logoFile) {
        formData.append('logo',   new Blob([logoFile.buffer],   { type: logoFile.mimetype }),   logoFile.originalname)
      }
      if (bannerFile) {
        formData.append('banner', new Blob([bannerFile.buffer], { type: bannerFile.mimetype }), bannerFile.originalname)
      }

      if (!logoFile && !bannerFile) {
        return res.status(400).json({ error: 'No se envió ningún archivo' })
      }

      const pbRes = await fetch(
        `${PB_URL}/api/collections/stores/records/${req.params.id}`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}` }, // sin Content-Type; fetch lo pone solo con FormData
          body: formData,
        }
      )

      if (pbRes.status === 404) return res.status(404).json({ error: 'not_found' })
      if (!pbRes.ok) {
        const details = await readJsonSafe(pbRes)
        return res.status(pbRes.status).json({ error: 'upload_failed', details })
      }

      res.json(await pbRes.json())
    } catch (err) {
      console.error('upload images error', err)
      res.status(500).json({ error: err.message })
    }
  }
)

// ── Actualizar tienda (solo admin) ────────────────────────────────────────────
app.patch('/:id', requireRole('admin'), async (req, res) => {
  try {
    const token = await getAdminToken()

    const ALLOWED = ['name', 'slug', 'description', 'status', 'verified',
                     'location', 'whatsapp', 'instagram', 'payment_instructions']
    const body = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => ALLOWED.includes(k))
    )

    if (!Object.keys(body).length) {
      return res.status(400).json({ error: 'No hay campos válidos para actualizar' })
    }

    const pbRes = await fetch(`${PB_URL}/api/collections/stores/records/${req.params.id}`, {
      method: 'PATCH',
      headers: pbHeaders(token),
      body: JSON.stringify(body),
    })

    if (pbRes.status === 404) return res.status(404).json({ error: 'not_found' })
    if (!pbRes.ok) {
      const details = await readJsonSafe(pbRes)
      return res.status(pbRes.status).json({ error: 'update_failed', details })
    }

    res.json(await pbRes.json())
  } catch (err) {
    console.error('update store error', err)
    res.status(500).json({ error: err.message })
  }
})

// ── Eliminar tienda (solo admin) ──────────────────────────────────────────────
app.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    const token = await getAdminToken()
    const pbRes = await fetch(`${PB_URL}/api/collections/stores/records/${req.params.id}`, {
      method: 'DELETE',
      headers: pbHeaders(token),
    })

    if (pbRes.status === 404) return res.status(404).json({ error: 'not_found' })
    if (!pbRes.ok && pbRes.status !== 204) {
      return res.status(pbRes.status).json({ error: 'delete_failed' })
    }

    res.status(204).send()
  } catch (err) {
    console.error('delete store error', err)
    res.status(500).json({ error: err.message })
  }
})

// ── Ver usuario (solo admin) ────────────────────────────────────────────────
app.get('/admin/users/:id', requireRole('admin'), async (req, res) => {
  try {
    const token = await getAdminToken()
    const pbRes = await fetch(`${PB_URL}/api/collections/users/records/${req.params.id}?fields=id,name,email,role,verified,emailVisibility,avatar,created,updated`, {
      headers: pbHeaders(token),
    })

    if (pbRes.status === 404) return res.status(404).json({ error: 'not_found' })
    if (!pbRes.ok) {
      const details = await readJsonSafe(pbRes)
      return res.status(pbRes.status).json({ error: 'user_fetch_failed', details })
    }

    res.json(await pbRes.json())
  } catch (err) {
    console.error('admin user detail error', err)
    res.status(500).json({ error: err.message })
  }
})

// ── Actualizar usuario (solo admin) ─────────────────────────────────────────
app.patch('/admin/users/:id', requireRole('admin'), async (req, res) => {
  try {
    const token = await getAdminToken()
    const allowedRoles = new Set(['admin', 'vendor', 'user'])
    const payload = {}

    if (typeof req.body.name === 'string') {
      payload.name = req.body.name.trim()
    }
    if (typeof req.body.role === 'string') {
      const role = req.body.role.trim()
      if (!allowedRoles.has(role)) {
        return res.status(400).json({ error: 'invalid_role' })
      }
      payload.role = role
    }
    if (typeof req.body.verified === 'boolean') {
      payload.verified = req.body.verified
    }
    if (typeof req.body.emailVisibility === 'boolean') {
      payload.emailVisibility = req.body.emailVisibility
    }

    if (Object.keys(payload).length === 0) {
      return res.status(400).json({ error: 'empty_payload' })
    }

    const pbRes = await fetch(`${PB_URL}/api/collections/users/records/${req.params.id}`, {
      method: 'PATCH',
      headers: pbHeaders(token),
      body: JSON.stringify(payload),
    })

    if (pbRes.status === 404) return res.status(404).json({ error: 'not_found' })
    if (!pbRes.ok) {
      const details = await readJsonSafe(pbRes)
      return res.status(pbRes.status).json({ error: 'user_update_failed', details })
    }

    res.json(await pbRes.json())
  } catch (err) {
    console.error('admin user update error', err)
    res.status(500).json({ error: err.message })
  }
})

// ── Overview de marketplace (solo admin) ────────────────────────────────────
app.get('/admin/overview', requireRole('admin'), async (_req, res) => {
  try {
    const token = await getAdminToken()

    const [
      usersTotal,
      usersAdmin,
      usersVendor,
      usersCustomer,
      usersVerified,
      storesTotal,
      storesActive,
      storesPending,
      storesSuspended,
      storesVerified,
      productsTotal,
      productsActive,
      productsSold,
      productsDraft,
      productsFeatured,
      ordersTotal,
      ordersCompleted,
      ordersPending,
      ordersCancelled,
      auctionsTotal,
      auctionsActive,
      auctionsEnded,
      reviewsTotal,
      categoriesTotal,
      storesAllResponse,
    ] = await Promise.all([
      countCollection(token, 'users'),
      countCollection(token, 'users', 'role="admin"'),
      countCollection(token, 'users', 'role="vendor"'),
      countCollection(token, 'users', 'role="user"'),
      countCollection(token, 'users', 'verified=true'),
      countCollection(token, 'stores'),
      countCollection(token, 'stores', 'status="active"'),
      countCollection(token, 'stores', 'status="pending"'),
      countCollection(token, 'stores', 'status="suspended"'),
      countCollection(token, 'stores', 'verified=true'),
      countCollection(token, 'products'),
      countCollection(token, 'products', 'status="active"'),
      countCollection(token, 'products', 'status="sold"'),
      countCollection(token, 'products', 'status="draft"'),
      countCollection(token, 'products', 'featured=true'),
      countCollection(token, 'orders'),
      countCollection(token, 'orders', 'status="delivered" || status="approved"'),
      countCollection(token, 'orders', 'status="reserved" || status="payment_uploaded"'),
      countCollection(token, 'orders', 'status="cancelled" || status="rejected"'),
      countCollection(token, 'auctions'),
      countCollection(token, 'auctions', 'status="active"'),
      countCollection(token, 'auctions', 'status="ended"'),
      countCollection(token, 'reviews'),
      countCollection(token, 'categories'),
      listCollection(token, 'stores', {
        page: 1,
        perPage: 100,
        sort: '-rating',
        fields: 'id,name,status,verified,rating,reviews_count,rating_sum',
      }),
    ])

    const storesAll = storesAllResponse?.items || []
    const storesTop = storesAll.slice(0, 8)
    const ratedStores = storesAll.filter((store) => Number(store.reviews_count || 0) > 0)
    const totalRatingSum = ratedStores.reduce((acc, store) => acc + Number(store.rating_sum || 0), 0)
    const totalRatingCount = ratedStores.reduce((acc, store) => acc + Number(store.reviews_count || 0), 0)
    const avgStoreRating = totalRatingCount > 0 ? totalRatingSum / totalRatingCount : 0

    res.json({
      summary: {
        users_total: usersTotal,
        users_admin: usersAdmin,
        users_vendor: usersVendor,
        users_customer: usersCustomer,
        users_verified: usersVerified,
        stores_total: storesTotal,
        stores_active: storesActive,
        stores_pending: storesPending,
        stores_suspended: storesSuspended,
        stores_verified: storesVerified,
        products_total: productsTotal,
        products_active: productsActive,
        products_sold: productsSold,
        products_draft: productsDraft,
        products_featured: productsFeatured,
        orders_total: ordersTotal,
        orders_completed: ordersCompleted,
        orders_pending: ordersPending,
        orders_cancelled: ordersCancelled,
        auctions_total: auctionsTotal,
        auctions_active: auctionsActive,
        auctions_ended: auctionsEnded,
        reviews_total: reviewsTotal,
        categories_total: categoriesTotal,
        avg_store_rating: avgStoreRating,
        reviewed_stores: ratedStores.length,
        top_stores: storesTop,
      },
    })
  } catch (err) {
    console.error('admin overview error', err)
    res.status(500).json({ error: err.message })
  }
})

// ── Buscar usuarios por email (para el selector de owner) ─────────────────────
app.get('/admin/users', requireRole('admin'), async (req, res) => {
  try {
    const token = await getAdminToken()
    const page = Math.max(1, parseInt(req.query.page) || 1)
    const perPage = Math.min(100, parseInt(req.query.perPage) || 20)
    const q = safeFilterValue(req.query.q)
    const role = String(req.query.role || '').trim()

    const allowedSorts = new Set(['id', '-id', 'name', '-name', 'email', '-email', 'created', '-created'])
    const sort = allowedSorts.has(String(req.query.sort || '-id')) ? String(req.query.sort || '-id') : '-id'

    const params = new URLSearchParams({
      page,
      perPage,
      sort,
      fields: 'id,name,email,role,verified,created,updated',
    })

    if (q) params.set('filter', `(email~"${q}" || name~"${q}")`)
    if (role && ['admin', 'vendor', 'user'].includes(role)) {
      params.set('filter', params.has('filter') ? `${params.get('filter')} && role="${role}"` : `role="${role}"`)
    }

    const pbRes = await fetch(`${PB_URL}/api/collections/users/records?${params}`, {
      headers: pbHeaders(token),
    })

    if (!pbRes.ok) {
      const details = await readJsonSafe(pbRes)
      return res.status(pbRes.status).json({ error: 'users_list_failed', details })
    }

    const data = await pbRes.json()
    return res.json(data)
  } catch (err) {
    console.error('admin users list error', err)
    return res.status(500).json({ error: err.message })
  }
})

// ── MIS TIENDAS (vendor) ──────────────────────────────────────────────────────
// GET /vendor/my-stores  — tiendas donde owner = X-User-Id
app.get('/vendor/my-stores', async (req, res) => {
  try {
    const token  = await getAdminToken()
    const userId = (req.headers['x-user-id'] || '').trim()
    const role   = (req.headers['x-user-role'] || '').trim()

    if (!userId || !['vendor', 'admin'].includes(role)) {
      return res.status(403).json({ error: 'forbidden' })
    }

    const params = new URLSearchParams({ perPage: 200, sort: 'name', fields: 'id,name,logo,status,verified,rating,owner' })

    const pbRes = await fetch(`${PB_URL}/api/collections/stores/records?${params}`, {
      headers: pbHeaders(token),
    })
    if (!pbRes.ok) {
      const details = await readJsonSafe(pbRes)
      return res.status(pbRes.status).json({ error: 'pb_error', details })
    }
    const data = await pbRes.json()
    const items = (data.items || []).filter((store) => userOwnsStore(store, userId))
    res.json({ items })
  } catch (err) {
    console.error('vendor my-stores error', err)
    res.status(500).json({ error: err.message })
  }
})

// ── Actualizar QR de la tienda (vendor owner) ─────────────────────────────────
// PATCH /vendor/:id/qr  — multipart con campo "payment_qr"
app.patch(
  '/vendor/:id/qr',
  upload.single('payment_qr'),
  async (req, res) => {
    try {
      const token  = await getAdminToken()
      const userId = (req.headers['x-user-id'] || '').trim()
      const role   = (req.headers['x-user-role'] || '').trim()

      if (!userId || !['vendor', 'admin'].includes(role)) {
        return res.status(403).json({ error: 'forbidden' })
      }

      // Verificar ownership
      const storeRes = await fetch(
        `${PB_URL}/api/collections/stores/records/${req.params.id}?fields=id,owner`,
        { headers: pbHeaders(token) }
      )
      if (storeRes.status === 404) return res.status(404).json({ error: 'not_found' })
      const storeData = await readJsonSafe(storeRes)
      if (role === 'vendor' && !userOwnsStore(storeData, userId)) {
        return res.status(403).json({ error: 'forbidden' })
      }

      if (!req.file) return res.status(400).json({ error: 'Debes adjuntar el archivo payment_qr' })

      const formData = new FormData()
      formData.append(
        'payment_qr',
        new Blob([req.file.buffer], { type: req.file.mimetype }),
        req.file.originalname
      )
      if (req.body.payment_instructions) {
        formData.append('payment_instructions', req.body.payment_instructions)
      }

      const pbRes = await fetch(
        `${PB_URL}/api/collections/stores/records/${req.params.id}`,
        { method: 'PATCH', headers: { Authorization: `Bearer ${token}` }, body: formData }
      )
      if (!pbRes.ok) {
        const details = await readJsonSafe(pbRes)
        return res.status(pbRes.status).json({ error: 'qr_upload_failed', details })
      }
      res.json(await pbRes.json())
    } catch (err) {
      console.error('vendor qr upload error', err)
      res.status(500).json({ error: err.message })
    }
  }
)

// ── Dashboard del vendedor para una tienda ────────────────────────────────────
app.get('/vendor/dashboard/:storeId', async (req, res) => {
  try {
    const token  = await getAdminToken()
    const userId = (req.headers['x-user-id'] || '').trim()
    const role   = (req.headers['x-user-role'] || '').trim()

    if (!userId || !['vendor', 'admin'].includes(role)) {
      return res.status(403).json({ error: 'forbidden' })
    }

    const sid = safeFilterValue(req.params.storeId)
    const enc = encodeURIComponent

    // Verificar ownership
    const storeRes = await fetch(
      `${PB_URL}/api/collections/stores/records/${sid}`,
      { headers: pbHeaders(token) }
    )
    if (!storeRes.ok) return res.status(404).json({ error: 'not_found' })
    const store = await readJsonSafe(storeRes)
    if (role === 'vendor' && !userOwnsStore(store, userId)) {
      return res.status(403).json({ error: 'forbidden' })
    }

    const [
      productsActive, productsDraft,
      ordersPaymentUploaded, ordersApprovedCurrent, ordersApprovedTotal, ordersShipped, ordersDelivered,
      auctionsActive, auctionsEnded,
      reviewsTotal,
    ] = await Promise.all([
      countCollection(token, 'products',      `store="${sid}" && status="active"`),
      countCollection(token, 'products',      `store="${sid}" && status="draft"`),
      countCollection(token, 'orders',        `store="${sid}" && status="payment_uploaded"`),
      countCollection(token, 'orders',        `store="${sid}" && status="approved"`),
      countCollection(token, 'orders',        `store="${sid}" && (status="approved" || status="shipped" || status="delivered")`),
      countCollection(token, 'orders',        `store="${sid}" && status="shipped"`),
      countCollection(token, 'orders',        `store="${sid}" && status="delivered"`),
      countCollection(token, 'auctions',      `store="${sid}" && status="active"`),
      countCollection(token, 'auctions',      `store="${sid}" && (status="ended" || status="closed")`),
      countCollection(token, 'reviews',       `store="${sid}"`),
    ])

    // Unidades vendidas de esta tienda en ordenes completadas
    const soldItemsRes = await fetch(
      `${PB_URL}/api/collections/order_items/records?filter=${enc(`store="${sid}" && (order.status="delivered" || order.status="shipped")`)}&fields=quantity&perPage=500`,
      { headers: pbHeaders(token) }
    )
    const soldItemsData = soldItemsRes.ok ? await readJsonSafe(soldItemsRes) : null
    const productsSold = (soldItemsData?.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0)

    // Ingresos brutos de órdenes completadas
    const completedOrdersRes = await fetch(
      `${PB_URL}/api/collections/orders/records?filter=${enc(`store="${sid}" && (status="delivered" || status="shipped")`)}&fields=total&perPage=200`,
      { headers: pbHeaders(token) }
    )
    const completedOrders = completedOrdersRes.ok ? await readJsonSafe(completedOrdersRes) : null
    const grossRevenue = (completedOrders?.items || []).reduce((sum, o) => sum + Number(o.total || 0), 0)

    res.json({
      store,
      summary: {
        products_active: productsActive,
        products_draft: productsDraft,
        products_sold: productsSold,
        orders_pending: ordersPaymentUploaded,
        orders_approved: ordersApprovedTotal,
        orders_approved_current: ordersApprovedCurrent,
        orders_shipped: ordersShipped,
        orders_delivered: ordersDelivered,
        auctions_active: auctionsActive,
        auctions_ended: auctionsEnded,
        reviews_total: reviewsTotal,
        gross_revenue: grossRevenue,
        store_rating: Number(store?.rating || 0),
        reviews_count: Number(store?.reviews_count || 0),
      },
    })
  } catch (err) {
    console.error('vendor dashboard error', err)
    res.status(500).json({ error: err.message })
  }
})

// ── Actualizar info de tienda (vendor owner puede actualizar algunos campos) ──
app.patch('/vendor/:id', async (req, res) => {
  try {
    const token  = await getAdminToken()
    const userId = (req.headers['x-user-id'] || '').trim()
    const role   = (req.headers['x-user-role'] || '').trim()

    if (!userId || !['vendor', 'admin'].includes(role)) {
      return res.status(403).json({ error: 'forbidden' })
    }

    // Verificar ownership
    const storeRes = await fetch(
      `${PB_URL}/api/collections/stores/records/${req.params.id}?fields=id,owner`,
      { headers: pbHeaders(token) }
    )
    if (storeRes.status === 404) return res.status(404).json({ error: 'not_found' })
    const storeData = await readJsonSafe(storeRes)
    if (role === 'vendor' && !userOwnsStore(storeData, userId)) {
      return res.status(403).json({ error: 'forbidden' })
    }

    const ALLOWED_VENDOR = ['description', 'location', 'whatsapp', 'instagram', 'payment_instructions', 'shipping_cost', 'free_shipping']
    const body = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => ALLOWED_VENDOR.includes(k))
    )
    if (!Object.keys(body).length) {
      return res.status(400).json({ error: 'No hay campos válidos' })
    }

    const pbRes = await fetch(`${PB_URL}/api/collections/stores/records/${req.params.id}`, {
      method: 'PATCH',
      headers: pbHeaders(token),
      body: JSON.stringify(body),
    })
    const data = await readJsonSafe(pbRes)
    if (!pbRes.ok) return res.status(pbRes.status).json({ error: 'update_failed', details: data })
    res.json(data)
  } catch (err) {
    console.error('vendor store update error', err)
    res.status(500).json({ error: err.message })
  }
})

app.get('/admin/users-search', requireRole('admin'), async (req, res) => {
  try {
    const token = await getAdminToken()
    const q = safeFilterValue(req.query.q)
    if (!q) return res.json({ items: [] })

    const params = new URLSearchParams({
      perPage: 10,
      filter: `(email~"${q}" || name~"${q}")`,
      fields: 'id,name,email,role',
    })

    const pbRes = await fetch(`${PB_URL}/api/collections/users/records?${params}`, {
      headers: pbHeaders(token),
    })

    if (!pbRes.ok) return res.json({ items: [] })
    const data = await pbRes.json()
    res.json({ items: data.items || [] })
  } catch (err) {
    res.json({ items: [] })
  }
})

app.listen(PORT, () => {
  console.log(`store-service running on port ${PORT}`)
})
