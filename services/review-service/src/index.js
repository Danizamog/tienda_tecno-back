const express = require('express')
const cors    = require('cors')

const app  = express()
const PORT = Number(process.env.PORT || 9008)

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

// ── Middleware: usuario autenticado ───────────────────────────────────────────
function requireUser(req, res, next) {
  const userId = (req.headers['x-user-id'] || '').trim()
  if (!userId || userId.length < 5) {
    return res.status(401).json({ error: 'unauthorized', message: 'x-user-id header required' })
  }
  req.userId = userId
  req.userRole = (req.headers['x-user-role'] || 'user').trim()
  next()
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ service: 'review-service', ok: true, port: PORT })
})

// ── GET /product/:productId — Reseñas de un producto ─────────────────────────
app.get('/product/:productId', async (req, res) => {
  try {
    const token     = await getAdminToken()
    const productId = safeId(req.params.productId)
    const page      = Number(req.query.page    || 1)
    const perPage   = Number(req.query.perPage || 10)

    const params = new URLSearchParams({
      filter:  `product="${productId}"`,
      expand:  'reviewer',
      sort:    '-created',
      page:    String(page),
      perPage: String(perPage),
    })

    const pbRes = await fetch(
      `${PB_URL}/api/collections/reviews/records?${params}`,
      { headers: pbHeaders(token) }
    )

    if (!pbRes.ok) {
      const details = await readJsonSafe(pbRes)
      return res.status(pbRes.status).json({ error: 'pb_error', details })
    }

    const data = await pbRes.json()

    // Calcular promedio con TODAS las reseñas (no solo la página actual)
    const allRatingsParams = new URLSearchParams({
      filter:  `product="${productId}"`,
      fields:  'rating',
      perPage: '500',
      page:    '1',
    })
    const allRatingsRes = await fetch(
      `${PB_URL}/api/collections/reviews/records?${allRatingsParams}`,
      { headers: pbHeaders(token) }
    )
    let avgRating = null
    if (allRatingsRes.ok) {
      const allData  = await allRatingsRes.json()
      const allItems = allData.items || []
      if (allItems.length > 0) {
        const sum = allItems.reduce((s, r) => s + Number(r.rating || 0), 0)
        avgRating = Math.round((sum / allItems.length) * 10) / 10
      }
    }

    res.json({
      items:      data.items || [],
      total:      data.totalItems || 0,
      totalPages: data.totalPages || 1,
      avgRating,
    })
  } catch (err) {
    console.error('[review] product list error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── GET /store/:storeId — Reseñas de una tienda ───────────────────────────────
app.get('/store/:storeId', async (req, res) => {
  try {
    const token   = await getAdminToken()
    const storeId = safeId(req.params.storeId)
    const page    = Number(req.query.page    || 1)
    const perPage = Number(req.query.perPage || 10)

    const params = new URLSearchParams({
      filter:  `store="${storeId}"`,
      expand:  'reviewer,product',
      sort:    '-created',
      page:    String(page),
      perPage: String(perPage),
    })

    const pbRes = await fetch(
      `${PB_URL}/api/collections/reviews/records?${params}`,
      { headers: pbHeaders(token) }
    )

    if (!pbRes.ok) {
      const details = await readJsonSafe(pbRes)
      return res.status(pbRes.status).json({ error: 'pb_error', details })
    }

    const data = await pbRes.json()
    res.json({
      items:      data.items      || [],
      total:      data.totalItems || 0,
      totalPages: data.totalPages || 1,
    })
  } catch (err) {
    console.error('[review] store list error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── GET /check — Verificar si el usuario ya reseñó un producto/tienda ─────────
// Query: ?productId=X o ?storeId=X
app.get('/check', requireUser, async (req, res) => {
  try {
    const token     = await getAdminToken()
    const userId    = safeId(req.userId)
    const productId = safeId(String(req.query.productId || ''))
    const storeId   = safeId(String(req.query.storeId   || ''))

    if (!productId && !storeId) {
      return res.status(400).json({ error: 'bad_request', message: 'productId o storeId requerido' })
    }

    const filterParts = [`reviewer="${userId}"`]
    if (productId) filterParts.push(`product="${productId}"`)
    if (storeId)   filterParts.push(`store="${storeId}"`)

    const params = new URLSearchParams({
      filter:  filterParts.join(' && '),
      fields:  'id,rating',
      perPage: '1',
    })

    const pbRes = await fetch(
      `${PB_URL}/api/collections/reviews/records?${params}`,
      { headers: pbHeaders(token) }
    )

    if (!pbRes.ok) {
      return res.json({ hasReview: false, review: null })
    }

    const data = await pbRes.json()
    const existing = data.items?.[0] || null
    res.json({ hasReview: !!existing, review: existing })
  } catch (err) {
    console.error('[review] check error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── GET /my — Reseñas del usuario autenticado ─────────────────────────────────
app.get('/my', requireUser, async (req, res) => {
  try {
    const token   = await getAdminToken()
    const userId  = safeId(req.userId)
    const page    = Number(req.query.page    || 1)
    const perPage = Number(req.query.perPage || 20)

    const params = new URLSearchParams({
      filter:  `reviewer="${userId}"`,
      expand:  'product,store',
      sort:    '-created',
      page:    String(page),
      perPage: String(perPage),
    })

    const pbRes = await fetch(
      `${PB_URL}/api/collections/reviews/records?${params}`,
      { headers: pbHeaders(token) }
    )

    if (!pbRes.ok) {
      const details = await readJsonSafe(pbRes)
      return res.status(pbRes.status).json({ error: 'pb_error', details })
    }

    const data = await pbRes.json()
    res.json({
      items:      data.items      || [],
      total:      data.totalItems || 0,
      totalPages: data.totalPages || 1,
    })
  } catch (err) {
    console.error('[review] my list error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── POST / — Crear reseña ─────────────────────────────────────────────────────
// Body: { productId, orderId, rating, title, comment }
// Solo se permite crear una reseña desde un pedido con status "delivered"
app.post('/', requireUser, async (req, res) => {
  try {
    const token     = await getAdminToken()
    const userId    = safeId(req.userId)
    const productId = safeId(String(req.body?.productId || ''))
    const orderId   = safeId(String(req.body?.orderId   || ''))
    const rating    = Number(req.body?.rating || 0)
    const title     = String(req.body?.title   || '').trim().slice(0, 100)
    const comment   = String(req.body?.comment || '').trim()

    if (!productId) {
      return res.status(400).json({ error: 'bad_request', message: 'productId requerido' })
    }
    if (!orderId) {
      return res.status(400).json({ error: 'bad_request', message: 'Debes reseñar desde un pedido entregado' })
    }
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'bad_request', message: 'rating debe estar entre 1 y 5' })
    }

    // Verificar que el pedido pertenece al usuario, está entregado y contiene el producto
    const orderRes = await fetch(
      `${PB_URL}/api/collections/orders/records/${orderId}?expand=items`,
      { headers: pbHeaders(token) }
    )
    if (!orderRes.ok) {
      return res.status(403).json({ error: 'forbidden', message: 'Pedido no encontrado' })
    }
    const order = await orderRes.json()

    if (order.buyer !== userId) {
      return res.status(403).json({ error: 'forbidden', message: 'Este pedido no te pertenece' })
    }
    if (order.status !== 'delivered') {
      return res.status(403).json({ error: 'forbidden', message: 'Solo puedes reseñar pedidos entregados' })
    }

    const orderItems = order.expand?.items || []
    let hasProduct = orderItems.some(item => item.product === productId)

    // Fallback: algunos pedidos no expanden items; validar contra order_items.
    if (!hasProduct) {
      const orderItemsParams = new URLSearchParams({
        filter: `order="${orderId}" && product="${productId}"`,
        fields: 'id',
        perPage: '1',
        page: '1',
      })
      const orderItemsRes = await fetch(
        `${PB_URL}/api/collections/order_items/records?${orderItemsParams}`,
        { headers: pbHeaders(token) }
      )
      if (orderItemsRes.ok) {
        const orderItemsData = await orderItemsRes.json()
        hasProduct = Number(orderItemsData?.totalItems || 0) > 0 || (orderItemsData?.items || []).length > 0
      }
    }

    if (!hasProduct) {
      return res.status(403).json({ error: 'forbidden', message: 'El producto no está en este pedido' })
    }

    // Obtener la tienda del pedido
    const storeId = safeId(String(order.store || ''))

    // Verificar que no exista ya una reseña del mismo usuario para el mismo producto
    const dupParams = new URLSearchParams({
      filter:  `reviewer="${userId}" && product="${productId}"`,
      fields:  'id',
      perPage: '1',
    })
    const dupRes = await fetch(
      `${PB_URL}/api/collections/reviews/records?${dupParams}`,
      { headers: pbHeaders(token) }
    )
    if (dupRes.ok) {
      const dupData = await dupRes.json()
      if (dupData.items?.length > 0) {
        return res.status(409).json({ error: 'already_reviewed', message: 'Ya reseñaste este producto' })
      }
    }

    // Crear la reseña
    const body = {
      reviewer:          userId,
      product:           productId,
      rating,
      verified_purchase: true,
    }
    if (storeId) body.store = storeId
    if (title)   body.title   = title
    if (comment) body.comment = comment

    const createRes = await fetch(`${PB_URL}/api/collections/reviews/records`, {
      method:  'POST',
      headers: pbHeaders(token),
      body:    JSON.stringify(body),
    })

    if (!createRes.ok) {
      const details = await readJsonSafe(createRes)
      return res.status(createRes.status).json({ error: 'pb_error', details })
    }

    const review = await createRes.json()

    // Actualizar rating de la tienda
    if (storeId) {
      await updateStoreRating(token, storeId)
    } else {
      // Buscar tienda en el producto como fallback
      const prodRes = await fetch(
        `${PB_URL}/api/collections/products/records/${productId}?fields=store`,
        { headers: pbHeaders(token) }
      )
      if (prodRes.ok) {
        const prod = await prodRes.json()
        if (prod.store) await updateStoreRating(token, prod.store)
      }
    }

    res.status(201).json({ ok: true, id: review.id, review })
  } catch (err) {
    console.error('[review] create error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── DELETE /:id — Eliminar reseña propia ──────────────────────────────────────
app.delete('/:id', requireUser, async (req, res) => {
  try {
    const token    = await getAdminToken()
    const userId   = safeId(req.userId)
    const reviewId = req.params.id

    // Obtener la reseña y verificar propiedad
    const getRes = await fetch(
      `${PB_URL}/api/collections/reviews/records/${reviewId}`,
      { headers: pbHeaders(token) }
    )

    if (getRes.status === 404) {
      return res.status(404).json({ error: 'not_found' })
    }
    if (!getRes.ok) {
      return res.status(getRes.status).json({ error: 'pb_error' })
    }

    const review = await getRes.json()
    if (review.reviewer !== userId && req.userRole !== 'admin') {
      return res.status(403).json({ error: 'forbidden', message: 'No tienes permiso para eliminar esta reseña' })
    }

    const storeId   = review.store   || null
    const productId = review.product || null

    const delRes = await fetch(
      `${PB_URL}/api/collections/reviews/records/${reviewId}`,
      { method: 'DELETE', headers: pbHeaders(token) }
    )

    if (!delRes.ok && delRes.status !== 204) {
      const details = await readJsonSafe(delRes)
      return res.status(delRes.status).json({ error: 'pb_error', details })
    }

    // Recalcular rating de la tienda
    if (storeId) {
      await updateStoreRating(token, storeId)
    } else if (productId) {
      const prodRes = await fetch(
        `${PB_URL}/api/collections/products/records/${productId}?fields=store`,
        { headers: pbHeaders(token) }
      )
      if (prodRes.ok) {
        const prod = await prodRes.json()
        if (prod.store) await updateStoreRating(token, prod.store)
      }
    }

    res.json({ ok: true })
  } catch (err) {
    console.error('[review] delete error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Helpers: recalcular rating de tienda ──────────────────────────────────────
async function updateStoreRating(token, storeId) {
  try {
    // Obtener reseñas de la tienda y deduplicar por id para evitar doble conteo.
    const params = new URLSearchParams({
      filter:  `store="${storeId}"`,
      fields:  'id,rating,store',
      perPage: '500',
      page:    '1',
    })

    const res = await fetch(
      `${PB_URL}/api/collections/reviews/records?${params}`,
      { headers: pbHeaders(token) }
    )
    if (!res.ok) return

    const data = await res.json()
    const uniqueById = new Map()
    for (const rev of (data.items || [])) {
      if (rev?.id) uniqueById.set(rev.id, rev)
    }

    // También reseñas hechas a productos de esta tienda
    // Obtener productos de la tienda
    const storeProdsRes = await fetch(
      `${PB_URL}/api/collections/products/records?filter=store="${storeId}"&fields=id&perPage=200`,
      { headers: pbHeaders(token) }
    )

    if (storeProdsRes.ok) {
      const prods = await storeProdsRes.json()
      const prodIds = (prods.items || []).map(p => p.id)

      // Reseñas directamente ligadas a productos de esta tienda
      if (prodIds.length > 0) {
        const chunk = prodIds.slice(0, 30) // PB tiene límite en filtros largos
        const filterIds = chunk.map(id => `product="${id}"`).join(' || ')
        const prRevParams = new URLSearchParams({
          filter:  `(${filterIds}) && (store="" || store = null)`,
          fields:  'id,rating,store',
          perPage: '500',
          page: '1',
        })
        const prRevRes = await fetch(
          `${PB_URL}/api/collections/reviews/records?${prRevParams}`,
          { headers: pbHeaders(token) }
        )
        if (prRevRes.ok) {
          const prRevData = await prRevRes.json()
          for (const rev of (prRevData.items || [])) {
            if (rev?.id && !uniqueById.has(rev.id)) uniqueById.set(rev.id, rev)
          }
        }
      }
    }

    const allRatings = Array.from(uniqueById.values()).map(r => Number(r.rating || 0))

    const count  = allRatings.length
    const sum    = allRatings.reduce((a, b) => a + b, 0)
    const avg    = count > 0 ? Math.round((sum / count) * 10) / 10 : 0

    await fetch(`${PB_URL}/api/collections/stores/records/${storeId}`, {
      method:  'PATCH',
      headers: pbHeaders(token),
      body:    JSON.stringify({
        rating:        avg,
        reviews_count: count,
        rating_sum:    sum,
      }),
    })
  } catch (err) {
    console.error('[review] updateStoreRating error:', err.message)
  }
}

app.listen(PORT, () => {
  console.log(`review-service running on port ${PORT}`)
})
