import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { TokenVerifier, TrackSource } from 'livekit-server-sdk'
import {
  createApp,
  participantPermission,
  secretsMatch,
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

async function startServer(roomService = { updateParticipant: async () => ({}) }) {
  const app = createApp({
    env: testEnv(),
    roomService,
    serveStatic: false,
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

  const denied = await post(endpoint, { allowed: true }, {
    Authorization: 'Bearer wrong',
  })
  assert.equal(denied.status, 403)
  assert.equal(calls.length, 0)

  const granted = await post(endpoint, { allowed: true }, {
    Authorization: `Bearer ${HOST_CODE}`,
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
    Authorization: `Bearer ${HOST_CODE}`,
  })
  assert.equal(revoked.status, 200)
  assert.equal(calls.length, 2)
  assert.equal(calls[1][2].permission.canPublish, false)
  assert.deepEqual(calls[1][2].permission.canPublishSources, [])
})
