import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { TokenVerifier, TrackSource } from 'livekit-server-sdk'
import {
  createModeratorToken,
  createApp,
  participantPermission,
  secretsMatch,
  verifyModeratorToken,
} from './app.js'

const API_KEY = 'testkey'
const API_SECRET = 'testsecret_which_is_at_least_32_chars_long'
const HOST_CODE = 'host-code-for-tests'
const servers = []

function testEnv() {
  return {
    LIVEKIT_API_KEY: API_KEY,
    LIVEKIT_API_SECRET: API_SECRET,
    LIVEKIT_WS_URL: 'wss://rtc.example.test',
    LIVEKIT_API_URL: 'http://rtc.internal.test:7880',
    HOST_ACCESS_CODE: HOST_CODE,
    NODE_ENV: 'production',
  }
}

async function startServer(
  roomService = { updateParticipant: async () => ({}) },
  options = {},
) {
  const app = createApp({
    env: testEnv(),
    roomService,
    serveStatic: false,
    ...options,
  })
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  servers.push(server)
  return `http://127.0.0.1:${server.address().port}`
}

async function post(url, body, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(
    (server) => new Promise((resolve) => server.close(resolve)),
  ))
})

test('secret comparison rejects empty and mismatched values', () => {
  assert.equal(secretsMatch('', ''), false)
  assert.equal(secretsMatch('one', 'two'), false)
  assert.equal(secretsMatch(HOST_CODE, HOST_CODE), true)
})

test('moderator tokens are short-lived and scoped to one room', () => {
  const token = createModeratorToken('room-a', API_SECRET, Date.now() + 60_000)
  assert.equal(verifyModeratorToken(token, 'room-a', API_SECRET), true)
  assert.equal(verifyModeratorToken(token, 'room-b', API_SECRET), false)
  assert.equal(verifyModeratorToken(token, 'room-a', 'wrong-secret'), false)

  const expired = createModeratorToken('room-a', API_SECRET, Date.now() - 1_000)
  assert.equal(verifyModeratorToken(expired, 'room-a', API_SECRET), false)
})

test('participant tokens are listen-only and cannot publish camera', async () => {
  const baseUrl = await startServer()
  const response = await post(`${baseUrl}/token`, {
    room: 'Sunday Service',
    identity: 'Viewer One',
    role: 'participant',
  })
  assert.equal(response.status, 200)

  const payload = await response.json()
  const claims = await new TokenVerifier(API_KEY, API_SECRET).verify(payload.token)

  assert.equal(payload.room, 'Sunday-Service')
  assert.equal(claims.name, 'Viewer One')
  assert.equal(claims.video.roomJoin, true)
  assert.equal(claims.video.canSubscribe, true)
  assert.equal(claims.video.canPublish, false)
  assert.equal(claims.video.canPublishData, true)
  assert.deepEqual(claims.video.canPublishSources, [])
})

test('caster token requires the configured host code', async () => {
  const baseUrl = await startServer()
  const denied = await post(`${baseUrl}/token`, {
    room: 'main',
    identity: 'Host',
    role: 'caster',
    hostCode: 'wrong',
  })
  assert.equal(denied.status, 403)

  const allowed = await post(`${baseUrl}/token`, {
    room: 'main',
    identity: 'Host',
    role: 'caster',
    hostCode: HOST_CODE,
  })
  assert.equal(allowed.status, 200)

  const payload = await allowed.json()
  const claims = await new TokenVerifier(API_KEY, API_SECRET).verify(payload.token)
  assert.equal(claims.video.canPublish, true)
  assert.equal(claims.video.canSubscribe, true)
  assert.equal(
    verifyModeratorToken(payload.moderatorToken, 'main', API_SECRET),
    true,
  )
})

test('host can grant microphone-only publishing and revoke it', async () => {
  const calls = []
  const roomService = {
    updateParticipant: async (...args) => {
      calls.push(args)
      return {}
    },
  }
  const baseUrl = await startServer(roomService)
  const endpoint = `${baseUrl}/rooms/main/participants/viewer-abc123/speaking`
  const casterResponse = await post(`${baseUrl}/token`, {
    room: 'main',
    identity: 'Host',
    role: 'caster',
    hostCode: HOST_CODE,
  })
  const { moderatorToken } = await casterResponse.json()

  const denied = await post(endpoint, { allowed: true }, {
    Authorization: `Bearer ${HOST_CODE}`,
  })
  assert.equal(denied.status, 403)
  assert.equal(calls.length, 0)

  const granted = await post(endpoint, { allowed: true }, {
    Authorization: `Bearer ${moderatorToken}`,
  })
  assert.equal(granted.status, 200)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'main')
  assert.equal(calls[0][1], 'viewer-abc123')
  assert.deepEqual(calls[0][2].permission, participantPermission(true))
  assert.deepEqual(
    calls[0][2].permission.canPublishSources,
    [TrackSource.MICROPHONE],
  )

  const revoked = await post(endpoint, { allowed: false }, {
    Authorization: `Bearer ${moderatorToken}`,
  })
  assert.equal(revoked.status, 200)
  assert.equal(calls.length, 2)
  assert.equal(calls[1][2].permission.canPublish, false)
  assert.deepEqual(calls[1][2].permission.canPublishSources, [])
})

test('moderation maps LiveKit not-found errors to 404', async () => {
  const roomService = {
    updateParticipant: async () => {
      const error = new Error('rpc failed')
      error.code = 5
      throw error
    },
  }
  const baseUrl = await startServer(roomService)
  const casterResponse = await post(`${baseUrl}/token`, {
    room: 'main',
    identity: 'Host',
    role: 'caster',
    hostCode: HOST_CODE,
  })
  const { moderatorToken } = await casterResponse.json()

  const response = await post(
    `${baseUrl}/rooms/main/participants/missing/speaking`,
    { allowed: true },
    { Authorization: `Bearer ${moderatorToken}` },
  )
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'participant_not_found' })
})

test('malformed and oversized JSON use stable errors and count toward limits', async () => {
  const baseUrl = await startServer(
    undefined,
    { tokenRateLimit: { max: 2, windowMs: 60_000 } },
  )

  const malformed = await fetch(`${baseUrl}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  })
  assert.equal(malformed.status, 400)
  assert.deepEqual(await malformed.json(), { error: 'invalid_json' })

  const oversized = await fetch(`${baseUrl}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ padding: 'x'.repeat(20_000) }),
  })
  assert.equal(oversized.status, 413)
  assert.deepEqual(await oversized.json(), { error: 'payload_too_large' })

  const limited = await post(`${baseUrl}/token`, {
    room: 'main',
    identity: 'Viewer',
    role: 'participant',
  })
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.has('retry-after'), true)
})

test('responses include browser security headers', async () => {
  const baseUrl = await startServer()
  const response = await fetch(`${baseUrl}/config`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-frame-options'), 'DENY')
  assert.match(
    response.headers.get('content-security-policy'),
    /frame-ancestors 'none'/,
  )
  assert.match(
    response.headers.get('content-security-policy'),
    /img-src 'self' data: blob:/,
  )
  assert.match(
    response.headers.get('permissions-policy'),
    /camera=\(self\)/,
  )
  assert.match(
    response.headers.get('strict-transport-security'),
    /max-age=31536000/,
  )
})
