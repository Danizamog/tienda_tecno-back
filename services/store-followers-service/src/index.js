const express = require('express')
const cors    = require('cors')

const app  = express()
const PORT = Number(process.env.PORT || 9011)

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

function requireUser(req, res, next) {
  const userId = (req.headers['x-user-id'] || '').trim()
  if (!userId || userId.length < 5) {
    return res.status(401).json({ error: 'unauthorized', message: 'x-user-id header required' })
  }
  req.userId = userId
  next()
}

app.get('/health', (_req, res) => {
  res.json({ service: 'store-followers-service', ok: true, port: PORT })
})

// GET /status/:storeId — ¿el usuario actual sigue esta tienda?
app.get('/status/:storeId', requireUser, async (req, res) => {
  try {
    const token   = await getAdminToken()
    const userId  = safeId(req.userId)
    const storeId = safeId(req.params.storeId)

    const params = new URLSearchParams({
      filter:  `user="${userId}" && store="${storeId}"`,
      fields:  'id',
      perPage: '1',
    })

    const pbRes = await fetch(
      `${PB_URL}/api/collections/store_followers/records?${params}`,
      { headers: pbHeaders(token) }
    )

    if (!pbRes.ok) {
      const details = await readJsonSafe(pbRes)
      return res.status(pbRes.status).json({ error: 'pb_error', details })
    }

    const data = await pbRes.json()
    const following = data.items?.length > 0
    res.json({ following, id: following ? data.items[0].id : null })
  } catch (err) {
    console.error('[followers] status error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// POST / — Seguir una tienda
app.post('/', requireUser, async (req, res) => {
  try {
    const token   = await getAdminToken()
    const userId  = safeId(req.userId)
    const storeId = safeId(String(req.body?.storeId || ''))

    if (!storeId) {
      return res.status(400).json({ error: 'bad_request', message: 'storeId es requerido' })
    }

    // Verificar duplicado
    const dupParams = new URLSearchParams({
      filter:  `user="${userId}" && store="${storeId}"`,
      fields:  'id',
      perPage: '1',
    })
    const dupRes = await fetch(
      `${PB_URL}/api/collections/store_followers/records?${dupParams}`,
      { headers: pbHeaders(token) }
    )

    if (dupRes.ok) {
      const dupData = await dupRes.json()
      if (dupData.items?.length > 0) {
        return res.status(409).json({
          error:   'already_following',
          message: 'Ya sigues esta tienda',
          id:      dupData.items[0].id,
        })
      }
    }

    const pbRes = await fetch(`${PB_URL}/api/collections/store_followers/records`, {
      method:  'POST',
      headers: pbHeaders(token),
      body:    JSON.stringify({ user: userId, store: storeId, notifications: false }),
    })

    if (!pbRes.ok) {
      const details = await readJsonSafe(pbRes)
      return res.status(pbRes.status).json({ error: 'pb_error', details })
    }

    const record = await pbRes.json()
    res.status(201).json({ ok: true, id: record.id })
  } catch (err) {
    console.error('[followers] follow error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// DELETE /by-store/:storeId — Dejar de seguir por storeId
app.delete('/by-store/:storeId', requireUser, async (req, res) => {
  try {
    const token   = await getAdminToken()
    const userId  = safeId(req.userId)
    const storeId = safeId(req.params.storeId)

    const findParams = new URLSearchParams({
      filter:  `user="${userId}" && store="${storeId}"`,
      fields:  'id',
      perPage: '1',
    })
    const findRes = await fetch(
      `${PB_URL}/api/collections/store_followers/records?${findParams}`,
      { headers: pbHeaders(token) }
    )

    if (!findRes.ok) {
      return res.status(404).json({ error: 'not_found' })
    }

    const findData = await findRes.json()
    if (!findData.items?.length) {
      return res.status(404).json({ error: 'not_found', message: 'No sigues esta tienda' })
    }

    const followId = findData.items[0].id
    const delRes = await fetch(
      `${PB_URL}/api/collections/store_followers/records/${followId}`,
      { method: 'DELETE', headers: pbHeaders(token) }
    )

    if (!delRes.ok && delRes.status !== 204) {
      const details = await readJsonSafe(delRes)
      return res.status(delRes.status).json({ error: 'pb_error', details })
    }

    res.json({ ok: true })
  } catch (err) {
    console.error('[followers] unfollow error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.listen(PORT, () => {
  console.log(`store-followers-service running on port ${PORT}`)
})
