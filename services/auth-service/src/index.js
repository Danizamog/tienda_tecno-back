const express = require('express')
const cors = require('cors')

const app = express()
const PORT = Number(process.env.PORT || 9001)

app.use(cors())
app.use(express.json())

const POCKETBASE_URL = (process.env.POCKETBASE_URL || '').replace(/\/$/, '')
const POCKETBASE_AUTH_IDENTITY = process.env.POCKETBASE_AUTH_IDENTITY || ''
const POCKETBASE_AUTH_PASSWORD = process.env.POCKETBASE_AUTH_PASSWORD || ''
const POCKETBASE_USERS_COLLECTION = process.env.POCKETBASE_USERS_COLLECTION || 'users'
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || process.env.OAUTH_CLIENT_ID || ''

function normalizeRole(value) {
  if (typeof value === 'string' && value) return value
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0]) return value[0]
  return 'user'
}

function createRandomPassword() {
  return `Ggl_${Math.random().toString(36).slice(2, 12)}_A1!`
}

async function readJsonSafe(response) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

async function pocketBaseAdminAuth() {
  if (!POCKETBASE_URL || !POCKETBASE_AUTH_IDENTITY || !POCKETBASE_AUTH_PASSWORD) {
    throw new Error('PocketBase credentials are not configured')
  }

  const response = await fetch(`${POCKETBASE_URL}/api/collections/_superusers/auth-with-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      identity: POCKETBASE_AUTH_IDENTITY,
      password: POCKETBASE_AUTH_PASSWORD,
    }),
  })

  if (!response.ok) {
    const details = await readJsonSafe(response)
    throw new Error(`PocketBase admin auth failed: ${response.status} ${JSON.stringify(details)}`)
  }

  const payload = await response.json()
  return payload?.token
}

async function getGoogleProfile(accessToken) {
  const tokenInfoResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`)
  if (!tokenInfoResponse.ok) {
    throw new Error('Invalid Google access token')
  }

  const tokenInfo = await tokenInfoResponse.json()
  const tokenAudience = tokenInfo.aud || tokenInfo.audience || tokenInfo.issued_to || ''
  if (GOOGLE_CLIENT_ID && tokenAudience && tokenAudience !== GOOGLE_CLIENT_ID) {
    throw new Error('Google token audience does not match configured client id')
  }

  const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!userInfoResponse.ok) {
    throw new Error('Could not read Google user profile')
  }

  const user = await userInfoResponse.json()
  if (!user?.email) {
    throw new Error('Google profile does not include email')
  }

  return user
}

async function upsertPocketBaseUser(adminToken, googleUser) {
  const encodedEmail = String(googleUser.email).replace(/"/g, '\\"')
  const listUrl = `${POCKETBASE_URL}/api/collections/${encodeURIComponent(POCKETBASE_USERS_COLLECTION)}/records?perPage=1&filter=${encodeURIComponent(`email=\"${encodedEmail}\"`)}`

  const listResponse = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })

  if (!listResponse.ok) {
    const details = await readJsonSafe(listResponse)
    throw new Error(`PocketBase list users failed: ${listResponse.status} ${JSON.stringify(details)}`)
  }

  const listPayload = await listResponse.json()
  const existing = Array.isArray(listPayload?.items) ? listPayload.items[0] : null
  if (existing) {
    const shouldUpdateName = !existing.name && googleUser.name
    if (shouldUpdateName) {
      await fetch(`${POCKETBASE_URL}/api/collections/${encodeURIComponent(POCKETBASE_USERS_COLLECTION)}/records/${existing.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ name: String(googleUser.name || '') }),
      })
    }
    return existing
  }

  const password = createRandomPassword()
  const createResponse = await fetch(`${POCKETBASE_URL}/api/collections/${encodeURIComponent(POCKETBASE_USERS_COLLECTION)}/records`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({
      email: String(googleUser.email),
      password,
      passwordConfirm: password,
      name: String(googleUser.name || ''),
      verified: true,
      role: 'user',
    }),
  })

  if (!createResponse.ok) {
    const details = await readJsonSafe(createResponse)
    throw new Error(`PocketBase create user failed: ${createResponse.status} ${JSON.stringify(details)}`)
  }

  return createResponse.json()
}

function resolveDefaultRedirect() {
  const raw = process.env.FRONTEND_URLS || ''
  const first = raw.split(',').map((v) => v.trim()).filter(Boolean)[0]
  if (!first) return null
  return `${first.replace(/\/$/, '')}/auth/callback`
}

app.get('/health', (_req, res) => {
  res.json({ service: 'auth-service', ok: true, port: PORT })
})

app.post('/login', (req, res) => {
  const { email } = req.body || {}
  res.json({
    token: 'mock-token',
    user: {
      id: 'u_demo',
      name: 'Usuario Demo',
      email: email || 'demo@modatienda.com',
      role: 'user',
    },
  })
})

app.get('/me', (_req, res) => {
  res.json({ id: 'u_demo', name: 'Usuario Demo', email: 'demo@modatienda.com', role: 'user' })
})

app.get('/google', (req, res) => {
  const redirect = typeof req.query.redirect === 'string' && req.query.redirect
    ? req.query.redirect
    : resolveDefaultRedirect()

  if (!redirect) {
    return res.status(400).json({ error: 'Missing redirect and FRONTEND_URLS is not configured' })
  }

  const callbackUrl = new URL(redirect)
  callbackUrl.searchParams.set('provider', 'google')
  callbackUrl.searchParams.set('token', 'mock-google-token')
  callbackUrl.searchParams.set('email', 'demo@modatienda.com')
  callbackUrl.searchParams.set('name', 'Usuario Demo')

  return res.redirect(callbackUrl.toString())
})

app.post('/google/sync', async (req, res) => {
  try {
    const accessToken = typeof req.body?.accessToken === 'string' ? req.body.accessToken.trim() : ''
    if (!accessToken) {
      return res.status(400).json({ error: 'accessToken is required' })
    }

    const googleUser = await getGoogleProfile(accessToken)
    const adminToken = await pocketBaseAdminAuth()
    const userRecord = await upsertPocketBaseUser(adminToken, googleUser)

    return res.json({
      ok: true,
      provider: 'google',
      user: {
        id: userRecord.id,
        email: googleUser.email,
        name: googleUser.name || userRecord.name || '',
        picture: googleUser.picture || null,
        role: normalizeRole(userRecord.role),
      },
    })
  } catch (error) {
    console.error('google sync error', error)
    const message = error instanceof Error ? error.message : 'Unknown error'
    const statusCode = /PocketBase/.test(message) ? 502 : 401
    return res.status(statusCode).json({
      error: 'google_sync_failed',
      message,
    })
  }
})

app.post('/refresh-role', async (req, res) => {
  try {
    const { email, userId } = req.body || {}
    if (!email && !userId) {
      return res.status(400).json({ error: 'email or userId is required' })
    }

    const adminToken = await pocketBaseAdminAuth()
    let userRecord = null

    if (userId) {
      const r = await fetch(
        `${POCKETBASE_URL}/api/collections/${encodeURIComponent(POCKETBASE_USERS_COLLECTION)}/records/${encodeURIComponent(userId)}`,
        { headers: { Authorization: `Bearer ${adminToken}` } }
      )
      if (r.ok) userRecord = await r.json()
    }

    if (!userRecord && email) {
      const encodedEmail = String(email).replace(/"/g, '\\"')
      const r = await fetch(
        `${POCKETBASE_URL}/api/collections/${encodeURIComponent(POCKETBASE_USERS_COLLECTION)}/records?perPage=1&filter=${encodeURIComponent(`email="${encodedEmail}"`)}`,
        { headers: { Authorization: `Bearer ${adminToken}` } }
      )
      if (r.ok) {
        const data = await r.json()
        userRecord = data?.items?.[0] || null
      }
    }

    if (!userRecord) {
      return res.status(404).json({ error: 'user_not_found' })
    }

    return res.json({
      ok: true,
      user: {
        id: userRecord.id,
        email: userRecord.email,
        role: normalizeRole(userRecord.role),
      },
    })
  } catch (error) {
    console.error('refresh-role error', error)
    return res.status(502).json({ error: 'refresh_role_failed', message: error instanceof Error ? error.message : 'Unknown error' })
  }
})

app.post('/logout', (_req, res) => {
  res.status(204).send()
})

app.listen(PORT, () => {
  console.log(`auth-service running on port ${PORT}`)
})
