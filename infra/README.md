# Deploying OnesimusRTC to AWS

One EC2 instance runs the whole stack via docker-compose:

- **Caddy** — automatic HTTPS (Let's Encrypt) for two `sslip.io` hostnames that
  resolve to the box, so no DNS setup is needed.
- **server** — the Node token service + static web client.
- **livekit** — the WebRTC SFU (host networking for UDP media).
- **redis** — LiveKit's state store.

## Prerequisites

- An **active AWS session** (`aws sts get-caller-identity` must succeed). If it
  says the session expired, run your usual `aws login` / `aws sso login`.
- A default VPC in the target region (standard on most accounts).

## Deploy

```powershell
./deploy-aws.ps1
```

It prints a URL like `https://54-123-45-67.sslip.io`. Wait ~3–4 minutes for
docker to build and Let's Encrypt to issue certs, then open it on your phone:

- One device / tab → **Start as caster** (allow camera + mic).
- Other devices → **Join as viewer** (they watch, tap **Talk** to speak, **Raise
  hand** to signal).

## Ports opened

`tcp 22, 80, 443, 7881` and `udp 50000–60000` (LiveKit media). Media flows
directly to the instance's public IP; only signaling goes through Caddy's 443.

## Cost

`t3.small` is a few cents/hour. The real variable cost is data egress
(~$0.09/GB) — at a rural-friendly ~400 kbps video that's roughly 1.6¢ per
viewer-hour. Bump `-InstanceType c5.large` for larger rooms.

## Teardown

```powershell
$s = Get-Content .deploy-state.json | ConvertFrom-Json
aws ec2 terminate-instances --region $s.region --instance-ids $s.instanceId
```

## Notes / hardening for later

- Swap `sslip.io` for a real domain (you own several) — point an A record at the
  IP and change `WEB_HOST`/`LK_HOST` in `.env`.
- For big rooms or strict-NAT phones, add a TURN/TLS listener.
- Move LiveKit keys into AWS Secrets Manager instead of generating on-box.
