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
export async function getToken(role, room, name) {
  const identity = (name || '').trim() || `${role}-${Math.random().toString(36).slice(2, 7)}`
  const res = await fetch('/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room, role, identity }),
  })
  if (!res.ok) throw new Error(`token request failed (${res.status})`)
  return res.json() // { token, identity, role, room, livekitUrl }
}

// One Room, tuned for weak networks: adaptiveStream downshifts video per viewer,
// dynacast stops sending layers nobody is watching.
export function makeRoom() {
  const L = LK()
  return new L.Room({
    adaptiveStream: true,
    dynacast: true,
    disconnectOnPageLeave: true,
  })
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
