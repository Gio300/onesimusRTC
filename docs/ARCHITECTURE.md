# Architecture

## The core idea

Video is expensive; audio is cheap. Conferencing tools that ask everyone to send
video fall over on slow rural links. OnesimusRTC sends video in **one direction
only** — from a single caster to everyone — while participants send just audio
and small control messages. Each viewer's video quality adapts to their own
connection, so a weak link degrades gracefully instead of stalling the room.

## Components

```
                 wss (signaling)            direct UDP media
   phone/browser ───────────────► Caddy(443) ───► LiveKit(7880)
        │  fetch /token, /config        │           ▲   ▲
        ▼                               ▼           │   │ redis
   Node server (8080) ◄── reverse_proxy ┘        media  state
   (mints scoped LiveKit JWTs, serves web client)  (UDP 50000-60000 / TCP 7881)
```

- **Token server** (`server/index.js`) issues LiveKit access tokens with grants
  scoped by role. Casters get full publish; participants get
  `canPublishSources: ['microphone']` — audio only, no camera. That single grant
  is what enforces the one-way-video model server-side.
- **LiveKit** (SFU) forwards the caster's video to every subscriber, choosing the
  right simulcast layer per viewer (`adaptiveStream` + `dynacast`). It also
  relays participant audio and data (raise-hand) messages.
- **Web client** (`web/`) is plain LiveKit JS from a CDN — no build step. Caster
  and participant are two small pages sharing `common.js`.

## Why LiveKit

It gives us, out of the box, the two things this product lives or dies on:
per-viewer adaptive bitrate (the "works on slow internet" requirement) and
selective forwarding (send each device only what it can use). Self-hostable and
open-source, so it can run on AWS today and on a local 24 GB GPU box later with
AWS as overflow.

## Extension points (roadmap)

- **Opt-in two-way video.** A host action re-mints or updates a participant's
  grant to add camera rights → full Zoom mode, under host control. LiveKit's
  server API `updateParticipant` changes permissions live.
- **Connection test → quality options.** WebRTC already does per-viewer
  congestion control; surface it as a manual quality toggle + an automatic probe
  that never interrupts the caster feed.
- **Recording / one-way broadcast to many.** For audiences beyond interactive
  size, add LiveKit Egress to push an HLS stream (cheap fan-out) while keeping
  the interactive room small.
