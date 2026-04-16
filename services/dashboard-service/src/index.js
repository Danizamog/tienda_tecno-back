const express = require('express')
const cors    = require('cors')
const cron    = require('node-cron')

const app  = express()
const PORT = Number(process.env.PORT || 9010)

app.use(cors())
app.use(express.json())

const PB_URL      = (process.env.POCKETBASE_URL || '').replace(/\/$/, '')
const PB_IDENTITY = process.env.POCKETBASE_AUTH_IDENTITY || ''
const PB_PASSWORD = process.env.POCKETBASE_AUTH_PASSWORD || ''

// ── Token de admin cacheado (válido 55 min) ───────────────────────────────────
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
  if (!res.ok) throw new Error(`PB admin auth failed: ${res.status}`)
  const { token } = await res.json()
  _adminToken = token
  _adminTokenExpiry = Date.now() + 55 * 60 * 1000
  return token
}

function pbHeaders(token) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
}

// ── Middlewares de rol ─────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if ((req.headers['x-user-role'] || '').trim() !== 'admin') {
    return res.status(403).json({ error: 'forbidden' })
  }
  next()
}

function requireVendorOrAdmin(req, res, next) {
  const role = (req.headers['x-user-role'] || '').trim()
  if (!['vendor', 'admin'].includes(role)) {
    return res.status(403).json({ error: 'forbidden' })
  }
  next()
}

// ── Utilidades de fecha ────────────────────────────────────────────────────────
function formatDate(date) {
  return date.toISOString().slice(0, 10)
}

function yesterday() {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - 1)
  return formatDate(d)
}

function fromDateStr(days) {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  return `${formatDate(d)} 00:00:00.000Z`
}

// ── Lógica de sincronización ───────────────────────────────────────────────────
// Calcula y escribe (upsert) dashboard_metrics para una fecha específica.
// La tabla tiene reglas only-admin, así que usamos el token de admin de PB.
async function syncMetricsForDate(dateStr) {
  const token = await getAdminToken()

  // Obtener todas las tiendas
  const storesRes = await fetch(
    `${PB_URL}/api/collections/stores/records?perPage=200&fields=id,name`,
    { headers: pbHeaders(token) }
  )
  const storesData = await readJsonSafe(storesRes)
  const stores = storesData?.items || []

  if (!stores.length) {
    console.log(`[sync] no stores found for ${dateStr}`)
    return { synced: 0, total: 0, date: dateStr, errors: [] }
  }

  const dayStart = `${dateStr} 00:00:00.000Z`
  const dayEnd   = `${dateStr} 23:59:59.999Z`

  let synced = 0
  const errors = []

  for (const store of stores) {
    try {
      const storeId = store.id

      // ── Órdenes entregadas en el día ─────────────────────────────────────
      const ordersFilter = encodeURIComponent(
        `store="${storeId}" && status="delivered" && updated>="${dayStart}" && updated<="${dayEnd}"`
      )
      const ordersRes = await fetch(
        `${PB_URL}/api/collections/orders/records?perPage=200&filter=${ordersFilter}&fields=id,total,discount_total`,
        { headers: pbHeaders(token) }
      )
      const ordersData = await readJsonSafe(ordersRes)
      const orders = ordersData?.items || []

      let sales_total     = 0
      let discounts_total = 0
      for (const order of orders) {
        sales_total     += Number(order.total          || 0)
        discounts_total += Number(order.discount_total || 0)
      }

      // ── Gift cards emitidas en el día ─────────────────────────────────────
      const gcFilter = encodeURIComponent(
        `store="${storeId}" && created>="${dayStart}" && created<="${dayEnd}"`
      )
      const gcRes = await fetch(
        `${PB_URL}/api/collections/giftcards/records?perPage=1&filter=${gcFilter}&fields=id`,
        { headers: pbHeaders(token) }
      )
      const gcData         = await readJsonSafe(gcRes)
      const giftcards_total = Number(gcData?.totalItems || 0)

      // ── Subastas finalizadas en el día ────────────────────────────────────
      const auctionFilter = encodeURIComponent(
        `store="${storeId}" && (status="ended" || status="closed") && end_time>="${dayStart}" && end_time<="${dayEnd}"`
      )
      const auctionRes = await fetch(
        `${PB_URL}/api/collections/auctions/records?perPage=1&filter=${auctionFilter}&fields=id`,
        { headers: pbHeaders(token) }
      )
      const auctionData    = await readJsonSafe(auctionRes)
      const auctions_total = Number(auctionData?.totalItems || 0)

      // ── Upsert en dashboard_metrics ───────────────────────────────────────
      const payload = {
        metric_date:        dayStart,
        store:              storeId,
        sales_total:        Math.round(sales_total * 100) / 100,
        transactions_count: orders.length,
        discounts_total:    Math.round(discounts_total * 100) / 100,
        giftcards_total,
        auctions_total,
      }

      const existFilter = encodeURIComponent(
        `store="${storeId}" && metric_date="${dayStart}"`
      )
      const existRes  = await fetch(
        `${PB_URL}/api/collections/dashboard_metrics/records?perPage=1&filter=${existFilter}&fields=id`,
        { headers: pbHeaders(token) }
      )
      const existData = await readJsonSafe(existRes)
      const existing  = existData?.items?.[0]

      if (existing) {
        await fetch(
          `${PB_URL}/api/collections/dashboard_metrics/records/${existing.id}`,
          { method: 'PATCH', headers: pbHeaders(token), body: JSON.stringify(payload) }
        )
      } else {
        await fetch(
          `${PB_URL}/api/collections/dashboard_metrics/records`,
          { method: 'POST', headers: pbHeaders(token), body: JSON.stringify(payload) }
        )
      }

      synced++
    } catch (err) {
      console.error(`[sync] store ${store.id} error:`, err.message)
      errors.push({ store_id: store.id, store_name: store.name, error: err.message })
    }
  }

  return { synced, total: stores.length, date: dateStr, errors }
}

// ── Cron: cada día a la 01:00 UTC sincroniza el día anterior ──────────────────
cron.schedule('0 1 * * *', async () => {
  const date = yesterday()
  console.log(`[cron] iniciando sync dashboard_metrics para ${date}`)
  try {
    const result = await syncMetricsForDate(date)
    console.log(`[cron] sync completado:`, JSON.stringify(result))
  } catch (err) {
    console.error('[cron] sync fallido:', err.message)
  }
}, { timezone: 'UTC' })

// ── Health ─────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ service: 'dashboard-service', ok: true, port: PORT }))

// ── GET /vendor/:storeId  ──────────────────────────────────────────────────────
// Últimos N días de métricas para una tienda. Vendedor debe ser dueño.
app.get('/vendor/:storeId', requireVendorOrAdmin, async (req, res) => {
  try {
    const token   = await getAdminToken()
    const storeId = req.params.storeId.replace(/"/g, '')
    const userId  = (req.headers['x-user-id'] || '').trim()
    const role    = (req.headers['x-user-role'] || '').trim()
    const days    = Math.min(90, Math.max(7, parseInt(req.query.days) || 30))

    // Verificar ownership si es vendor
    if (role === 'vendor') {
      const storeRes = await fetch(
        `${PB_URL}/api/collections/stores/records/${storeId}?fields=id,owner`,
        { headers: pbHeaders(token) }
      )
      if (!storeRes.ok) return res.status(404).json({ error: 'store_not_found' })
      const store  = await readJsonSafe(storeRes)
      const owners = Array.isArray(store.owner) ? store.owner : [store.owner].filter(Boolean)
      if (!owners.includes(userId)) return res.status(403).json({ error: 'forbidden' })
    }

    const filter = encodeURIComponent(`store="${storeId}" && metric_date>="${fromDateStr(days)}"`)
    const pbRes  = await fetch(
      `${PB_URL}/api/collections/dashboard_metrics/records?perPage=200&filter=${filter}&sort=metric_date`,
      { headers: pbHeaders(token) }
    )
    const data  = await readJsonSafe(pbRes)
    const items = data?.items || []

    // Calcular resumen del período
    const summary = { sales_total: 0, transactions_count: 0, giftcards_total: 0, discounts_total: 0, auctions_total: 0, days_with_sales: 0 }
    for (const item of items) {
      summary.sales_total        += Number(item.sales_total        || 0)
      summary.transactions_count += Number(item.transactions_count || 0)
      summary.giftcards_total    += Number(item.giftcards_total    || 0)
      summary.discounts_total    += Number(item.discounts_total    || 0)
      summary.auctions_total     += Number(item.auctions_total     || 0)
      if (Number(item.transactions_count || 0) > 0) summary.days_with_sales++
    }
    summary.sales_total        = Math.round(summary.sales_total * 100) / 100
    summary.discounts_total    = Math.round(summary.discounts_total * 100) / 100
    summary.avg_daily_sales    = summary.days_with_sales
      ? Math.round((summary.sales_total / summary.days_with_sales) * 100) / 100
      : 0

    res.json({ items, summary, days })
  } catch (err) {
    console.error('vendor metrics error', err)
    res.status(500).json({ error: err.message })
  }
})

// ── GET /admin/overview  ───────────────────────────────────────────────────────
// Métricas globales diarias agregadas de todas las tiendas.
app.get('/admin/overview', requireAdmin, async (req, res) => {
  try {
    const token = await getAdminToken()
    const days  = Math.min(90, Math.max(7, parseInt(req.query.days) || 30))

    const filter = encodeURIComponent(`metric_date>="${fromDateStr(days)}"`)
    const pbRes  = await fetch(
      `${PB_URL}/api/collections/dashboard_metrics/records?perPage=500&filter=${filter}&sort=metric_date`,
      { headers: pbHeaders(token) }
    )
    const data  = await readJsonSafe(pbRes)
    const items = data?.items || []

    // Agrupar por fecha
    const byDate = {}
    for (const item of items) {
      const d = (item.metric_date || '').slice(0, 10)
      if (!d) continue
      if (!byDate[d]) {
        byDate[d] = { metric_date: d, sales_total: 0, transactions_count: 0, giftcards_total: 0, discounts_total: 0, auctions_total: 0 }
      }
      byDate[d].sales_total        += Number(item.sales_total        || 0)
      byDate[d].transactions_count += Number(item.transactions_count || 0)
      byDate[d].giftcards_total    += Number(item.giftcards_total    || 0)
      byDate[d].discounts_total    += Number(item.discounts_total    || 0)
      byDate[d].auctions_total     += Number(item.auctions_total     || 0)
    }

    const daily = Object.values(byDate)
      .map(d => ({
        ...d,
        sales_total:     Math.round(d.sales_total * 100) / 100,
        discounts_total: Math.round(d.discounts_total * 100) / 100,
      }))
      .sort((a, b) => a.metric_date.localeCompare(b.metric_date))

    // Resumen global del período
    const summary = { sales_total: 0, transactions_count: 0, giftcards_total: 0, discounts_total: 0, auctions_total: 0 }
    for (const d of daily) {
      summary.sales_total        += d.sales_total
      summary.transactions_count += d.transactions_count
      summary.giftcards_total    += d.giftcards_total
      summary.discounts_total    += d.discounts_total
      summary.auctions_total     += d.auctions_total
    }
    summary.sales_total     = Math.round(summary.sales_total * 100) / 100
    summary.discounts_total = Math.round(summary.discounts_total * 100) / 100

    res.json({ daily, summary, days })
  } catch (err) {
    console.error('admin overview error', err)
    res.status(500).json({ error: err.message })
  }
})

// ── GET /admin/stores  ────────────────────────────────────────────────────────
// Totales por tienda en el período.
app.get('/admin/stores', requireAdmin, async (req, res) => {
  try {
    const token = await getAdminToken()
    const days  = Math.min(90, Math.max(7, parseInt(req.query.days) || 30))

    const filter = encodeURIComponent(`metric_date>="${fromDateStr(days)}"`)
    const pbRes  = await fetch(
      `${PB_URL}/api/collections/dashboard_metrics/records?perPage=500&filter=${filter}&expand=store&sort=-metric_date`,
      { headers: pbHeaders(token) }
    )
    const data  = await readJsonSafe(pbRes)
    const items = data?.items || []

    // Agrupar por tienda
    const byStore = {}
    for (const item of items) {
      const sid = item.store
      if (!sid) continue
      if (!byStore[sid]) {
        byStore[sid] = {
          store_id:           sid,
          store_name:         item.expand?.store?.name || sid,
          sales_total:        0,
          transactions_count: 0,
          giftcards_total:    0,
          discounts_total:    0,
          auctions_total:     0,
        }
      }
      byStore[sid].sales_total        += Number(item.sales_total        || 0)
      byStore[sid].transactions_count += Number(item.transactions_count || 0)
      byStore[sid].giftcards_total    += Number(item.giftcards_total    || 0)
      byStore[sid].discounts_total    += Number(item.discounts_total    || 0)
      byStore[sid].auctions_total     += Number(item.auctions_total     || 0)
    }

    const stores = Object.values(byStore)
      .map(s => ({
        ...s,
        sales_total:     Math.round(s.sales_total * 100) / 100,
        discounts_total: Math.round(s.discounts_total * 100) / 100,
      }))
      .sort((a, b) => b.sales_total - a.sales_total)

    res.json({ stores, days })
  } catch (err) {
    console.error('admin stores metrics error', err)
    res.status(500).json({ error: err.message })
  }
})

// ── POST /sync  ────────────────────────────────────────────────────────────────
// Sincronización manual (admin). Body: { date?: "YYYY-MM-DD" }
app.post('/sync', requireAdmin, async (req, res) => {
  try {
    const date = req.body?.date || yesterday()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' })
    }
    console.log(`[manual sync] iniciando para ${date}`)
    const result = await syncMetricsForDate(date)
    res.json(result)
  } catch (err) {
    console.error('manual sync error', err)
    res.status(500).json({ error: err.message })
  }
})

app.listen(PORT, () => console.log(`dashboard-service running on port ${PORT}`))
