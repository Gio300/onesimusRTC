// =============================================================================
// OnesimusRTC token + static server.
//
// - Serves the browser client from ../web
// - GET  /config           -> { livekitUrl }  (so the client knows where to dial)
// - POST /token {room, identity, role}  -> { token }
//
// Roles:
//   caster       -> may publish camera + mic + screen + data; subscribes to all
//   participant  -> may publish MICROPHONE ONLY + data (raise hand); subscribes
//
// The participant grant deliberately withholds camera publish. That is the whole
// point: voice-back only, one-way video from the caster. A future "allow video"
// host control will re-mint / update a participant to add camera rights.
// =============================================================================
import express from 'express'
import { AccessToken } from 'livekit-server-sdk'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

const API_KEY = process.env.LIVEKIT_API_KEY || 'devkey'
const API_SECRET = process.env.LIVEKIT_API_SECRET || 'devsecret_change_me_min_32_chars_long'
const LIVEKIT_WS_URL = process.env.LIVEKIT_WS_URL || 'ws://localhost:7880'
const PORT = Number(process.env.PORT || 8080)

const app = express()
app.use(express.json())

// The client asks where to dial before it connects.
app.get('/config', (_req, res) => {
  res.json({ livekitUrl: LIVEKIT_WS_URL })
})

app.get('/healthz', (_req, res) => res.json({ ok: true }))

function sanitize(s, fallback) {
  const v = String(s ?? '').trim().slice(0, 64)
  return v || fallback
}

app.post('/token', async (req, res) => {
  try {
    const room = sanitize(req.body?.room, 'main')
    const role = req.body?.role === 'caster' ? 'caster' : 'participant'
    const identity = sanitize(
      req.body?.identity,
      `${role}-${Math.random().toString(36).slice(2, 8)}`,
    )

    const at = new AccessToken(API_KEY, API_SECRET, { identity, ttl: '4h' })

    if (role === 'caster') {
      at.addGrant({
        room,
        roomJoin: true,
        canPublish: true,          // camera + mic + screenshare
        canSubscribe: true,
        canPublishData: true,
      })
    } else {
      at.addGrant({
        room,
        roomJoin: true,
        canSubscribe: true,        // watch the caster's video
        canPublish: true,
        canPublishData: true,      // raise hand
        // The key restriction: audio only, no camera. One-way video design.
        canPublishSources: ['microphone'],
      })
    }

    const token = await at.toJwt()
    res.json({ token, identity, role, room, livekitUrl: LIVEKIT_WS_URL })
  } catch (err) {
    console.error('[token] error', err)
    res.status(500).json({ error: 'token_failed' })
  }
})

// Static web client last, so the API routes above win.
app.use(express.static(join(__dirname, '..', 'web')))

app.listen(PORT, () => {
  console.log(`[onesimusRTC] server on :${PORT}  (LiveKit at ${LIVEKIT_WS_URL})`)
})
