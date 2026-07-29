import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import express from 'express'
import {
  AccessToken,
  RoomServiceClient,
  TrackSource,
} from 'livekit-server-sdk'

const __dirname = dirname(fileURLToPath(import.meta.url))

function cleanText(value, fallback = '', maxLength = 64) {
  const cleaned = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLength)
  return cleaned || fallback
}

function cleanRoom(value, fallback = 'main') {
  const cleaned = cleanText(value, fallback)
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return cleaned || fallback
}

function identityPrefix(value, fallback) {
  const cleaned = cleanText(value, fallback, 40)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned || fallback
}

export function secretsMatch(provided, expected) {
  const left = Buffer.from(String(provided ?? ''), 'utf8')
  const right = Buffer.from(String(expected ?? ''), 'utf8')
  return left.length === right.length
    && left.length > 0
    && timingSafeEqual(left, right)
}

function signValue(value, secret) {
  return createHmac('sha256', secret).update(value).digest('base64url')
}

export function createModeratorToken(
  room,
  secret,
  expiresAt = Date.now() + 4 * 60 * 60 * 1000,
) {
  const payload = Buffer.from(JSON.stringify({
    room,
    exp: Math.floor(expiresAt / 1000),
    nonce: randomBytes(8).toString('hex'),
  })).toString('base64url')
  return `${payload}.${signValue(payload, secret)}`
}

export function verifyModeratorToken(token, room, secret, now = Date.now()) {
  const [payload, signature, extra] = String(token || '').split('.')
  if (!payload || !signature || extra) return false
  if (!secretsMatch(signature, signValue(payload, secret))) return false

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return parsed.room === room
      && Number.isFinite(parsed.exp)
      && parsed.exp >= Math.floor(now / 1000)
  } catch {
    return false
  }
}

export function participantPermission(canSpeak) {
  return {
    canSubscribe: true,
    canPublish: Boolean(canSpeak),
    canPublishData: true,
    canPublishSources: canSpeak ? [TrackSource.MICROPHONE] : [],
  }
}

export function videoGrant(role, room) {
  if (role === 'caster') {
    return {
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    }
  }

  return {
    room,
    roomJoin: true,
    ...participantPermission(false),
  }
}

function makeRateLimiter({ max, windowMs }) {
  const clients = new Map()
  let lastSweepAt = 0

  return (req, res, next) => {
    const now = Date.now()
    if (now - lastSweepAt >= windowMs) {
      for (const [key, client] of clients) {
        if (now >= client.resetAt) clients.delete(key)
      }
      lastSweepAt = now
    }

    const key = req.ip || req.socket.remoteAddress || 'unknown'
    const current = clients.get(key)

    if (!current || now >= current.resetAt) {
      clients.set(key, { count: 1, resetAt: now + windowMs })
      next()
      return
    }

    current.count += 1
    if (current.count > max) {
      res.set('Retry-After', String(Math.ceil((current.resetAt - now) / 1000)))
      res.status(429).json({ error: 'too_many_requests' })
      return
    }

    next()
  }
}

function readBearer(req) {
  const value = String(req.get('authorization') || '')
  return value.startsWith('Bearer ') ? value.slice(7).trim() : ''
}

export function createApp(options = {}) {
  const env = options.env || process.env
  const apiKey = env.LIVEKIT_API_KEY || 'devkey'
  const apiSecret = env.LIVEKIT_API_SECRET || 'devsecret_change_me_min_32_chars_long'
  const livekitWsUrl = env.LIVEKIT_WS_URL || 'ws://localhost:7880'
  const livekitApiUrl = env.LIVEKIT_API_URL || 'http://localhost:7880'
  const hostAccessCode = cleanText(env.HOST_ACCESS_CODE, '', 256)
  const production = env.NODE_ENV === 'production'
  const moderatorSigningSecret = env.MODERATOR_SIGNING_SECRET || apiSecret
  const roomService = options.roomService
    || new RoomServiceClient(livekitApiUrl, apiKey, apiSecret)

  const app = express()
  app.disable('x-powered-by')
  if (env.TRUST_PROXY === '1') app.set('trust proxy', 1)
  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff')
    res.set('X-Frame-Options', 'DENY')
    res.set('Referrer-Policy', 'no-referrer')
    res.set('Cross-Origin-Resource-Policy', 'same-origin')
    res.set(
      'Permissions-Policy',
      'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()',
    )
    res.set(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "base-uri 'none'",
        "connect-src 'self' " + livekitWsUrl,
        "frame-ancestors 'none'",
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
        "object-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
      ].join('; '),
    )
    if (production) {
      res.set(
        'Strict-Transport-Security',
        'max-age=31536000; includeSubDomains',
      )
    }
    next()
  })
  app.use(['/config', '/token', '/rooms'], (_req, res, next) => {
    res.set('Cache-Control', 'no-store')
    next()
  })
  const tokenLimiter = makeRateLimiter(
    options.tokenRateLimit || { max: 40, windowMs: 60_000 },
  )
  const moderationLimiter = makeRateLimiter(
    options.moderationRateLimit || { max: 120, windowMs: 60_000 },
  )
  app.use('/token', tokenLimiter)
  app.use('/rooms', moderationLimiter)
  app.use(express.json({ limit: '16kb', strict: true }))

  const hostAuthorized = (provided) => {
    if (!hostAccessCode) return !production
    return secretsMatch(provided, hostAccessCode)
  }

  app.get('/config', (_req, res) => {
    res.json({
      livekitUrl: livekitWsUrl,
      hostCodeRequired: Boolean(hostAccessCode) || production,
      videoMode: 'caster-only',
    })
  })

  app.get('/healthz', (_req, res) => {
    res.json({
      ok: true,
      hostConfigured: Boolean(hostAccessCode),
    })
  })

  app.post('/token', async (req, res) => {
    try {
      const role = req.body?.role === 'caster' ? 'caster' : 'participant'
      if (role === 'caster' && !hostAccessCode && production) {
        res.status(503).json({ error: 'host_access_not_configured' })
        return
      }
      if (role === 'caster' && !hostAuthorized(req.body?.hostCode)) {
        res.status(403).json({ error: 'invalid_host_code' })
        return
      }

      const room = cleanRoom(req.body?.room)
      const displayName = cleanText(
        req.body?.identity,
        role === 'caster' ? 'Caster' : 'Viewer',
      )
      const prefix = identityPrefix(displayName, role)
      const identity = `${prefix}-${randomBytes(3).toString('hex')}`
      const token = new AccessToken(apiKey, apiSecret, {
        identity,
        name: displayName,
        ttl: '4h',
      })
      token.addGrant(videoGrant(role, room))

      const response = {
        token: await token.toJwt(),
        identity,
        name: displayName,
        role,
        room,
        livekitUrl: livekitWsUrl,
      }
      if (role === 'caster') {
        response.moderatorToken = createModeratorToken(
          room,
          moderatorSigningSecret,
        )
      }
      res.json(response)
    } catch (error) {
      console.error('[token] error', error)
      res.status(500).json({ error: 'token_failed' })
    }
  })

  app.post(
    '/rooms/:room/participants/:identity/speaking',
    async (req, res) => {
      if (!hostAccessCode && production) {
        res.status(503).json({ error: 'host_access_not_configured' })
        return
      }
      if (typeof req.body?.allowed !== 'boolean') {
        res.status(400).json({ error: 'allowed_must_be_boolean' })
        return
      }

      const room = cleanRoom(req.params.room, '')
      const identity = cleanText(req.params.identity, '')
      if (!room || !/^[a-zA-Z0-9_.-]{1,64}$/.test(identity)) {
        res.status(400).json({ error: 'invalid_participant' })
        return
      }
      if (!verifyModeratorToken(
        readBearer(req),
        room,
        moderatorSigningSecret,
      )) {
        res.status(403).json({ error: 'invalid_moderator_token' })
        return
      }

      try {
        const permission = participantPermission(req.body.allowed)
        await roomService.updateParticipant(room, identity, { permission })
        res.json({
          ok: true,
          identity,
          canSpeak: req.body.allowed,
        })
      } catch (error) {
        console.error('[moderation] error', error)
        const message = String(error?.message || '')
        const code = error?.code ?? error?.status ?? error?.statusCode
        const notFound = code === 5
          || code === 404
          || code === 'NOT_FOUND'
          || /not found|does not exist|unknown participant/i.test(message)
        const status = notFound ? 404 : 502
        res.status(status).json({
          error: status === 404 ? 'participant_not_found' : 'moderation_failed',
        })
      }
    },
  )

  if (options.serveStatic !== false) {
    app.get('/vendor/livekit-client.umd.min.js', (_req, res) => {
      res.sendFile(join(
        __dirname,
        'node_modules',
        'livekit-client',
        'dist',
        'livekit-client.umd.js',
      ))
    })
    app.use(express.static(options.publicDir || join(__dirname, '..', 'web')))
  }

  app.use((error, _req, res, next) => {
    if (error?.type === 'entity.too.large') {
      res.status(413).json({ error: 'payload_too_large' })
      return
    }
    if (error instanceof SyntaxError && error.status === 400) {
      res.status(400).json({ error: 'invalid_json' })
      return
    }
    if (res.headersSent) {
      next(error)
      return
    }
    console.error('[http] unhandled error', error)
    res.status(500).json({ error: 'internal_error' })
  })

  return app
}
