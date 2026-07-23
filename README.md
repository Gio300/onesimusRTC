# OnesimusRTC

Low-bandwidth, one-way-video + voice-back meetings for rural and constrained
networks. One caster projects live video to everyone; participants join by
**voice only**, can **raise a hand**, and **speak when allowed** — no upstream
video required. Built on [LiveKit](https://livekit.io) (open-source WebRTC SFU),
so each viewer automatically gets the best quality their connection can carry.

## Why it exists

Zoom-style meetings assume everyone can send video. Out in rural / low-speed
areas that breaks. OnesimusRTC flips it: the expensive direction (video) is
one-to-many from a single caster; everyone else contributes only audio (tiny)
and control signals (hand raise). WebRTC's per-viewer adaptive bitrate means a
weak connection drops video quality gracefully instead of freezing the room.

## What's in the box

- **`server/`** — a token service (Node + `livekit-server-sdk`) that mints scoped
  LiveKit access tokens and serves the web client. Casters get camera+mic publish
  rights; participants get microphone-only + data (raise hand).
- **`web/`** — the browser client (LiveKit JS, no build step). Two roles:
  - **Caster** — publishes camera + mic, sees the roster and raised hands.
  - **Participant** — watches the caster's video, push-to-talk mic, raise hand.
- **`infra/`** — one-command AWS deploy: an EC2 box running LiveKit + Redis +
  Caddy (automatic HTTPS via sslip.io) with docker-compose, reachable from any
  phone browser.

## Quick start (local)

```bash
cd server
cp .env.example .env      # fill LIVEKIT_API_KEY / SECRET / WS URL
npm install
npm start                 # serves web + /token on http://localhost:8080
```
You still need a LiveKit server to connect to — see `infra/` for the deploy, or
run LiveKit locally with `livekit-server --dev`.

## Deploy to AWS (phone-testable)

```powershell
cd infra
./deploy-aws.ps1          # creates the security group + EC2, prints the URL
```
Open the printed `https://<ip>.sslip.io` on your phone. One tab = caster, another
device = participant. See `infra/README.md` for details and the manual gate
(an active AWS session).

## Roadmap

- Host dashboard: per-participant "allow video" toggle → opt-in two-way (full
  Zoom mode) under host control.
- Automatic connection test → offer quality options without dropping the feed.
- Optional local-GPU deployment (run the SFU on a 24GB box, AWS as overflow).

## License

MIT — see [LICENSE](LICENSE).
