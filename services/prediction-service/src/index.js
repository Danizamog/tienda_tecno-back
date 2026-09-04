const express = require('express')
const cors = require('cors')
const tf = require('@tensorflow/tfjs')

const app = express()
const PORT = Number(process.env.PORT || 9015)
const PB_URL = (process.env.POCKETBASE_URL || '').replace(/\/$/, '')
const PB_IDENTITY = process.env.POCKETBASE_AUTH_IDENTITY || ''
const PB_PASSWORD = process.env.POCKETBASE_AUTH_PASSWORD || ''

app.use(cors())
app.use(express.json())

let adminToken = null
let adminTokenExpiry = 0
const forecastCache = new Map()

async function readJsonSafe(res) {
  const text = await res.text()
  if (!text) return null
  try { return JSON.parse(text) } catch { return { raw: text } }
}

function pbHeaders(token) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
}

async function getAdminToken() {
  if (adminToken && Date.now() < adminTokenExpiry) return adminToken
  const res = await fetch(`${PB_URL}/api/collections/_superusers/auth-with-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: PB_IDENTITY, password: PB_PASSWORD }),
  })
  if (!res.ok) throw new Error(`PB admin auth failed: ${res.status}`)
  adminToken = (await res.json()).token
  adminTokenExpiry = Date.now() + 55 * 60 * 1000
  return adminToken
}

async function listAll(token, collection, params = {}) {
  const items = []
  let page = 1
  let totalPages = 1
  do {
    const query = new URLSearchParams({ page: String(page), perPage: '200', ...params })
    const res = await fetch(`${PB_URL}/api/collections/${collection}/records?${query}`, { headers: pbHeaders(token) })
    const data = await readJsonSafe(res)
    if (!res.ok) throw new Error(`${collection}_list_failed:${res.status}:${JSON.stringify(data)}`)
    items.push(...(data?.items || []))
    totalPages = Number(data?.totalPages || 1)
    page += 1
  } while (page <= totalPages)
  return items
}

function dateKey(date) {
  return date.toISOString().slice(0, 10)
}

function addDays(date, amount) {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + amount)
  return next
}

function historyStart(days) {
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  return dateKey(addDays(today, -(days - 1)))
}

function makeDailySeries(orders, days) {
  const end = new Date()
  end.setUTCHours(0, 0, 0, 0)
  const start = addDays(end, -(days - 1))
  const values = new Map()
  for (let index = 0; index < days; index += 1) {
    values.set(dateKey(addDays(start, index)), { date: dateKey(addDays(start, index)), orders: 0, revenue: 0, cost: 0 })
  }
  for (const order of orders) {
    const key = String(order.updated || order.created || '').slice(0, 10)
    const value = values.get(key)
    if (!value) continue
    value.orders += Number(order.orders_count ?? 1)
    value.revenue += Number(order.total || 0)
    value.cost += Number(order.cost_total || 0)
  }
  return [...values.values()].map((value) => ({
    ...value,
    orders: Number(value.orders.toFixed(4)),
    revenue: Number(value.revenue.toFixed(2)),
    cost: Number(value.cost.toFixed(2)),
  }))
}

function featureRow(series, index) {
  const lag = (offset) => series[Math.max(0, index - offset)]
  const rolling = (size, field) => {
    const start = Math.max(0, index - size)
    const values = series.slice(start, index).map((item) => item[field])
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
  }
  const date = new Date(`${series[index].date}T00:00:00Z`)
  return [
    lag(1).orders, lag(7).orders, lag(14).orders, lag(28).orders,
    lag(1).revenue, lag(7).revenue, lag(14).revenue, lag(28).revenue,
    rolling(7, 'orders'), rolling(28, 'orders'), rolling(7, 'revenue'), rolling(28, 'revenue'),
    date.getUTCDay() / 6, date.getUTCDate() / 31, (date.getUTCMonth() + 1) / 12,
  ]
}

function normalizeColumns(rows) {
  const columns = rows[0].map((_, column) => rows.map((row) => row[column]))
  const stats = columns.map((column) => {
    const mean = column.reduce((sum, value) => sum + value, 0) / column.length
    const deviation = Math.sqrt(column.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / column.length) || 1
    return { mean, deviation }
  })
  return {
    stats,
    transform: (row) => row.map((value, column) => (value - stats[column].mean) / stats[column].deviation),
  }
}

function scaleTarget(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const deviation = Math.sqrt(values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length) || 1
  return { mean, deviation, transform: (value) => (value - mean) / deviation, restore: (value) => value * deviation + mean }
}

function mae(actual, predicted) {
  return actual.reduce((sum, value, index) => sum + Math.abs(value - predicted[index]), 0) / actual.length
}

async function trainForecast(series, horizon) {
  const warmup = 28
  const rows = []
  const targets = []
  for (let index = warmup; index < series.length; index += 1) {
    rows.push(featureRow(series, index))
    targets.push([series[index].orders, series[index].revenue])
  }
  const inputScaler = normalizeColumns(rows)
  const orderScaler = scaleTarget(targets.map((target) => target[0]))
  const revenueScaler = scaleTarget(targets.map((target) => target[1]))
  const normalizedTargets = targets.map(([orders, revenue]) => [orderScaler.transform(orders), revenueScaler.transform(revenue)])
  const split = Math.max(1, Math.floor(rows.length * 0.8))
  const trainInputs = rows.slice(0, split).map(inputScaler.transform)
  const trainTargets = normalizedTargets.slice(0, split)
  const testInputs = rows.slice(split).map(inputScaler.transform)
  const testTargets = targets.slice(split)

  const model = tf.sequential()
  model.add(tf.layers.dense({ inputShape: [rows[0].length], units: 32, activation: 'relu' }))
  model.add(tf.layers.dense({ units: 16, activation: 'relu' }))
  model.add(tf.layers.dense({ units: 2 }))
  model.compile({ optimizer: tf.train.adam(0.01), loss: 'meanSquaredError' })
  const inputTensor = tf.tensor2d(trainInputs)
  const targetTensor = tf.tensor2d(trainTargets)
  await model.fit(inputTensor, targetTensor, { epochs: 25, batchSize: Math.min(32, trainInputs.length), verbose: 0, shuffle: false })
  inputTensor.dispose()
  targetTensor.dispose()

  let testPredictions = []
  if (testInputs.length) {
    const tensor = model.predict(tf.tensor2d(testInputs))
    testPredictions = tensor.arraySync().map(([orders, revenue]) => [
      Math.max(0, orderScaler.restore(orders)),
      Math.max(0, revenueScaler.restore(revenue)),
    ])
    tensor.dispose()
  }
  const actualOrders = testTargets.map((target) => target[0])
  const actualRevenue = testTargets.map((target) => target[1])
  const orderError = testPredictions.length ? mae(actualOrders, testPredictions.map((item) => item[0])) : 0
  const revenueError = testPredictions.length ? mae(actualRevenue, testPredictions.map((item) => item[1])) : 0

  const recursiveSeries = series.map((item) => ({ ...item }))
  const forecast = []
  for (let step = 1; step <= horizon; step += 1) {
    const date = addDays(new Date(`${series[series.length - 1].date}T00:00:00Z`), step)
    const item = { date: dateKey(date), orders: 0, revenue: 0, cost: 0 }
    const input = inputScaler.transform(featureRow([...recursiveSeries, item], recursiveSeries.length))
    const tensor = model.predict(tf.tensor2d([input]))
    const [orders, revenue] = tensor.arraySync()[0]
    tensor.dispose()
    item.orders = Number(Math.max(0, orderScaler.restore(orders)).toFixed(2))
    item.revenue = Number(Math.max(0, revenueScaler.restore(revenue)).toFixed(2))
    item.cost = 0
    recursiveSeries.push(item)
    forecast.push(item)
  }
  model.dispose()

  const confidence = series.length < 90 || series.filter((item) => item.orders > 0).length < 10
    ? 'low'
    : (orderError <= 1.5 ? 'high' : 'medium')
  const margin = series.reduce((sum, item) => sum + item.revenue, 0) > 0
    ? Math.max(0, 1 - series.reduce((sum, item) => sum + item.cost, 0) / series.reduce((sum, item) => sum + item.revenue, 0))
    : null
  return {
    forecast: forecast.map((item) => ({
      ...item,
      profit: margin == null ? null : Number((item.revenue * margin).toFixed(2)),
      lower_bound: Number(Math.max(0, item.orders - orderError).toFixed(2)),
      upper_bound: Number((item.orders + orderError).toFixed(2)),
    })),
    model: { name: 'MLPRegressor', version: '1.0', training_days: series.length, training_sales_days: series.filter((item) => item.orders > 0).length, mae_orders: Number(orderError.toFixed(2)), mae_revenue: Number(revenueError.toFixed(2)), confidence },
  }
}

async function buildForecast(storeId, historyDays, horizonDays, userId, role) {
  const token = await getAdminToken()
  const storeRes = await fetch(`${PB_URL}/api/collections/stores/records/${storeId}?fields=id,owner`, { headers: pbHeaders(token) })
  const store = await readJsonSafe(storeRes)
  if (!storeRes.ok) { const error = new Error('store_not_found'); error.status = 404; throw error }
  const owners = Array.isArray(store.owner) ? store.owner : [store.owner].filter(Boolean)
  if (role === 'vendor' && !owners.includes(userId)) { const error = new Error('forbidden'); error.status = 403; throw error }

  const cutoff = `${historyStart(historyDays)}T00:00:00.000Z`
  const orders = await listAll(token, 'orders', { filter: `store="${storeId}" && status="delivered"` })
  const metrics = (await listAll(token, 'dashboard_metrics', { filter: `store="${storeId}"` }))
    .filter((metric) => String(metric.metric_date || '') >= cutoff)
  const items = await listAll(token, 'order_items', { filter: `store="${storeId}"` })
  const costsByOrder = new Map()
  for (const item of items) costsByOrder.set(item.order, (costsByOrder.get(item.order) || 0) + Number(item.cost_total || 0))
  const deliveredOrders = orders.filter((order) => String(order.updated || order.created || '') >= cutoff)
  const revenueTotal = deliveredOrders.reduce((sum, order) => sum + Number(order.total || 0), 0)
  const costTotal = deliveredOrders.reduce((sum, order) => sum + Number(costsByOrder.get(order.id) || 0), 0)
  const costRatio = revenueTotal > 0 ? costTotal / revenueTotal : 0
  const series = makeDailySeries(metrics.map((metric) => ({
    updated: metric.metric_date,
    orders_count: Number(metric.transactions_count || 0),
    total: Number(metric.sales_total || 0),
    cost_total: Number(metric.sales_total || 0) * costRatio,
  })), historyDays)
  const result = await trainForecast(series, horizonDays)
  return {
    store_id: storeId,
    generated_at: new Date().toISOString(),
    historical: series,
    ...result,
    summary: {
      forecast_orders: Number(result.forecast.reduce((sum, item) => sum + item.orders, 0).toFixed(2)),
      forecast_revenue: Number(result.forecast.reduce((sum, item) => sum + item.revenue, 0).toFixed(2)),
      forecast_profit: result.forecast.every((item) => item.profit == null) ? null : Number(result.forecast.reduce((sum, item) => sum + item.profit, 0).toFixed(2)),
    },
    warnings: result.model.confidence === 'low' ? ['Hay pocos días con ventas históricas; la proyección tiene baja confiabilidad.'] : [],
  }
}

app.get('/health', (_req, res) => res.json({ service: 'prediction-service', ok: true, port: PORT }))
app.get('/vendor/:storeId', async (req, res) => {
  try {
    const storeId = String(req.params.storeId).replace(/"/g, '')
    const historyDays = Math.min(730, Math.max(60, Number.parseInt(req.query.historyDays, 10) || 365))
    const horizonDays = Math.min(90, Math.max(7, Number.parseInt(req.query.horizonDays, 10) || 30))
    const userId = (req.headers['x-user-id'] || '').trim()
    const role = (req.headers['x-user-role'] || '').trim()
    if (!userId || !['vendor', 'admin'].includes(role)) return res.status(403).json({ error: 'forbidden' })
    const cacheKey = `${storeId}:${historyDays}:${horizonDays}:${role}:${userId}`
    const cached = forecastCache.get(cacheKey)
    if (cached && cached.expires > Date.now()) return res.json(cached.value)
    const value = await buildForecast(storeId, historyDays, horizonDays, userId, role)
    forecastCache.set(cacheKey, { value, expires: Date.now() + 5 * 60 * 1000 })
    res.json(value)
  } catch (error) {
    console.error('forecast error', error)
    res.status(error.status || 500).json({ error: error.message })
  }
})

app.listen(PORT, () => console.log(`prediction-service running on port ${PORT}`))
