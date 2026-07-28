# OnesimusRTC

Low-bandwidth, one-way-video meetings with moderated voice participation.
One caster sends camera video and audio. Viewers receive that stream, raise a
hand, and can publish microphone audio only after the caster approves them.
Viewer camera publishing is blocked by the server token.

The system uses LiveKit's open-source WebRTC SFU. The SFU forwards media rather
than transcoding it, so the server can run on a normal CPU. The browser client
publishes a 360p caster stream with a lower simulcast layer for weak networks.

## Components

- `server/`: Express API for scoped LiveKit tokens and host moderation.
- `web/`: install-free caster and viewer browser screens.
- `infra/`: Docker Compose deployment for LiveKit, Redis, Caddy, and the app.

## Local start

```powershell
cd server
Copy-Item .env.example .env
npm ci
npm test
npm start
```

A LiveKit server must also be available at the URLs configured in `.env`.

## Production behavior

- `HOST_ACCESS_CODE` is required to mint a caster token.
- Viewer tokens start with subscribe and data permissions only.
- The caster can grant or revoke microphone-only publishing per viewer.
- The host code stays in browser session storage and is sent only over HTTPS.
- `TURN/UDP` is exposed on port 443 for restrictive mobile networks.

## Deploy

```powershell
cd infra
.\deploy-aws.ps1
```

The script launches a single AWS EC2 instance and prints its HTTPS URL. See
`infra/README.md` for ports, operations, and verification.

## Test

```powershell
cd server
npm test
```

Tests verify caster authentication, viewer camera blocking, and host-controlled
microphone grants.

## License

MIT. See `LICENSE`.
