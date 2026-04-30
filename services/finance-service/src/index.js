const express = require('express')
const cors = require('cors')

const app = express()
const PORT = Number(process.env.PORT || 9006)

const PB_URL = (process.env.POCKETBASE_URL || '').replace(/\/$/, '')
const PB_IDENTITY = process.env.POCKETBASE_AUTH_IDENTITY || ''
const PB_PASSWORD = process.env.POCKETBASE_AUTH_PASSWORD || ''

app.use(cors())
app.use(express.json())

let _adminToken = null
let _adminTokenExpiry = 0

async function readJsonSafe(res) {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
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
    throw new Error(`PocketBase admin auth failed: ${res.status} ${JSON.stringify(details)}`)
  }

  const { token } = await res.json()
  _adminToken = token
  _adminTokenExpiry = Date.now() + 55 * 60 * 1000
  return token
}

async function listAllRecords(token, collection, { fields, expand, filter, sort = '-created' } = {}) {
  const items = []
  let page = 1
  let totalPages = 1

  do {
    const params = new URLSearchParams({ page, perPage: 100, sort })
    if (fields) params.set('fields', fields)
    if (expand) params.set('expand', expand)
    if (filter) params.set('filter', filter)

    const res = await fetch(`${PB_URL}/api/collections/${collection}/records?${params}`, {
      headers: pbHeaders(token),
    })

    if (!res.ok) {
      const details = await readJsonSafe(res)
      throw new Error(`${collection}_list_failed:${res.status}:${JSON.stringify(details)}`)
    }

    const data = await res.json()
    items.push(...(data.items || []))
    totalPages = Number(data.totalPages || 1)
    page += 1
  } while (page <= totalPages)

  return items
}

function normalizeTransaction(record) {
  const expandedStore = record?.expand?.store || null
  const expandedOrder = record?.expand?.order || null
  const expandedAuction = record?.expand?.auction || null
  const expandedGiftcard = record?.expand?.giftcard || null

  const storeName = expandedStore?.name || record?.store_name || 'Sin tienda'
  const storeId = expandedStore?.id || record?.store || null
  const notes = record?.notes || expandedOrder?.notes || expandedAuction?.title || expandedGiftcard?.code || record?.external_ref || ''

  return {
    id: record.id,
    type: record.type,
    status: record.status,
    amount: Number(record.amount || 0),
    currency: record.currency || 'BS',
    store_id: storeId,
    store_name: storeName,
    notes,
    external_ref: record.external_ref || null,
    created: record.created,
    updated: record.updated,
    expand: record.expand,
  }
}

function normalizeGiftcard(record) {
  const expandedStore = record?.expand?.store || null
  return {
    id: record.id,
    code: record.code,
    balance: Number(record.balance || 0),
    currency: record.currency || 'BS',
    status: record.status,
    expires_at: record.expires_at || null,
    store_id: expandedStore?.id || record?.store || null,
    store_name: expandedStore?.name || 'Sin tienda',
    created: record.created,
    updated: record.updated,
  }
}

function groupTransactionsByStore(items) {
  const map = new Map()

  for (const tx of items) {
    const key = tx.store_id || 'sin-tienda'
    const current = map.get(key) || {
      store_id: tx.store_id || null,
      store_name: tx.store_name || 'Sin tienda',
      transactions_count: 0,
      completed_count: 0,
      pending_count: 0,
      gross_amount: 0,
      completed_amount: 0,
      pending_amount: 0,
      transactions: [],
    }

    current.transactions_count += 1
    current.transactions.push(tx)
    current.gross_amount += Number(tx.amount || 0)

    if (tx.status === 'completed') {
      current.completed_count += 1
      current.completed_amount += Number(tx.amount || 0)
    } else if (tx.status === 'pending' || tx.status === 'reserved' || tx.status === 'payment_uploaded') {
      current.pending_count += 1
      current.pending_amount += Number(tx.amount || 0)
    }

    map.set(key, current)
  }

  return [...map.values()].sort((a, b) => b.gross_amount - a.gross_amount)
}

function filterRecordsByStore(items, storeId) {
  if (!storeId) return items
  return items.filter((item) => item.store_id === storeId)
}

async function loadFinanceData({ storeId } = {}) {
  const token = await getAdminToken()

  const [transactionsRaw, giftcardsRaw] = await Promise.all([
    listAllRecords(token, 'transactions', {
      fields: 'id,type,status,amount,currency,order,auction,giftcard,user,notes,external_ref,store,approved_by,created,updated',
      expand: 'store,order,auction,giftcard,user,approved_by',
      sort: '-created',
    }),
    listAllRecords(token, 'giftcards', {
      fields: 'id,code,balance,currency,status,expires_at,store,owner,created,updated',
      expand: 'store,owner',
      sort: '-created',
    }),
  ])

  const transactions = filterRecordsByStore(transactionsRaw.map(normalizeTransaction), storeId)
  const giftcards = filterRecordsByStore(giftcardsRaw.map(normalizeGiftcard), storeId)

  return { transactions, giftcards }
}

app.get('/health', (_req, res) => {
  res.json({ service: 'finance-service', ok: true, port: PORT })
})

app.get('/giftcards', async (_req, res) => {
  try {
    const { giftcards } = await loadFinanceData()
    res.json({ items: giftcards })
  } catch (err) {
    console.error('giftcards error', err)
    res.status(500).json({ error: err.message })
  }
})

app.get('/transactions', async (req, res) => {
  try {
    const { storeId } = req.query
    const { transactions } = await loadFinanceData({ storeId })

    const gananciaTotal = transactions
      .filter((t) => t.status === 'completed')
      .reduce((acc, t) => acc + Number(t.amount || 0), 0)

    const chartMap = {}
    transactions.forEach((t) => {
      if (t.status === 'completed' && t.created) {
        const date = t.created.split('T')[0]
        chartMap[date] = (chartMap[date] || 0) + Number(t.amount || 0)
      }
    })

    const chartDaily = Object.keys(chartMap).sort().map((date) => ({
      date,
      amount: chartMap[date]
    }))

    res.json({ items: transactions, gananciaTotal, chartDaily })
  } catch (err) {
    console.error('transactions error', err)
    res.status(500).json({ error: err.message })
  }
})

app.get('/transactions/by-store', async (req, res) => {
  try {
    const { storeId } = req.query
    const { transactions } = await loadFinanceData({ storeId })
    res.json({ items: groupTransactionsByStore(transactions) })
  } catch (err) {
    console.error('transactions by store error', err)
    res.status(500).json({ error: err.message })
  }
})

app.get('/dashboard/summary', async (req, res) => {
  try {
    const { storeId } = req.query
    const { transactions, giftcards } = await loadFinanceData({ storeId })
    const completedTransactions = transactions.filter((tx) => tx.status === 'completed')
    const grossTransactions = completedTransactions.reduce((acc, tx) => acc + Number(tx.amount || 0), 0)
    const discountFromGiftcards = completedTransactions
      .filter((tx) => tx.type === 'giftcard_redeem')
      .reduce((acc, tx) => acc + Number(tx.amount || 0), 0)

    const activeGiftcards = giftcards.filter((g) => g.status === 'active').length
    const giftcardOutstanding = giftcards
      .filter((g) => g.status === 'active')
      .reduce((acc, g) => acc + Number(g.balance || 0), 0)

    res.json({
      summary: {
        transactions_count: transactions.length,
        completed_transactions: completedTransactions.length,
        gross_transactions: grossTransactions,
        discounts_total: discountFromGiftcards,
        net_revenue_estimate: grossTransactions - discountFromGiftcards,
        active_giftcards: activeGiftcards,
        giftcards_outstanding_balance: giftcardOutstanding,
        by_store: groupTransactionsByStore(transactions),
      },
    })
  } catch (err) {
    console.error('dashboard summary error', err)
    res.status(500).json({ error: err.message })
  }
})

app.listen(PORT, () => {
  console.log(`finance-service running on port ${PORT}`)
})