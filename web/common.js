// Shared helpers for both roles. LiveKit is loaded from the CDN UMD bundle and
// exposed as the global `LivekitClient`.
/* global LivekitClient */

export const LK = () => window.LivekitClient

export function qs() {
  const p = new URLSearchParams(location.search)
  return {
    room: (p.get('room') || 'main').slice(0, 64),
    name: (p.get('name') || '').slice(0, 64),
  }
}

// Ask the server where LiveKit lives + mint a scoped token for this role.
export async function getToken(role, room, name, options = {}) {
  const identity = (name || '').trim() || `${role}-${Math.random().toString(36).slice(2, 7)}`
  const res = await fetch('/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      room,
      role,
      identity,
      hostCode: options.hostCode || undefined,
    }),
  })
  const payload = await res.json().catch(() => ({}))
  if (!res.ok) {
    const messages = {
      invalid_host_code: 'The host access code is not correct.',
      host_access_not_configured: 'Host access has not been configured on the server.',
      too_many_requests: 'Too many connection attempts. Wait a moment and retry.',
    }
    throw new Error(messages[payload.error] || `Connection request failed (${res.status}).`)
  }
  return payload
}

// One Room, tuned for weak networks: adaptiveStream downshifts video per viewer,
// dynacast stops sending layers nobody is watching.
export function makeRoom(role = 'participant') {
  const L = LK()
  const options = {
    adaptiveStream: true,
    dynacast: true,
    disconnectOnPageLeave: true,
  }

  if (role === 'caster') {
    options.videoCaptureDefaults = {
      resolution: L.VideoPresets.h360,
    }
    options.publishDefaults = {
      videoEncoding: L.VideoPresets.h360.encoding,
      videoSimulcastLayers: [L.VideoPresets.h180],
      dtx: true,
      red: true,
    }
  }

  return new L.Room(options)
}

export async function setSpeakerPermission(room, identity, allowed, hostCode) {
  const res = await fetch(
    `/rooms/${encodeURIComponent(room)}/participants/${encodeURIComponent(identity)}/speaking`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${hostCode}`,
      },
      body: JSON.stringify({ allowed }),
    },
  )
  const payload = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(payload.error || `Microphone update failed (${res.status}).`)
  }
  return payload
}

export function syncAudioButton(room, button) {
  if (!room || !button) return
  button.hidden = room.canPlaybackAudio
}

export function encode(obj) {
  return new TextEncoder().encode(JSON.stringify(obj))
}
export function decode(bytes) {
  try { return JSON.parse(new TextDecoder().decode(bytes)) } catch { return null }
}

export function setStatus(text) {
  const el = document.getElementById('status')
  if (el) el.textContent = text
}
