# Deploying OnesimusRTC to AWS

One EC2 instance runs:

- Caddy for HTTPS and WebSocket proxying.
- The Express token/moderation API and static browser client.
- LiveKit as the WebRTC SFU.
- Redis for LiveKit state.

## Prerequisites

- An active AWS CLI session: `aws sts get-caller-identity`.
- A default VPC in the selected region.

## Deploy

```powershell
.\deploy-aws.ps1
```

Without `-Domain`, the script uses an automatic `sslip.io` hostname. It
generates LiveKit credentials and a separate host access code on the instance.

## Network ports

- TCP 80 and 443: HTTP redirect and HTTPS.
- TCP 7881: LiveKit ICE/TCP fallback.
- UDP 443: embedded TURN for restrictive mobile networks.
- UDP 50000-60000: direct WebRTC media.
- TCP 22: instance administration.

## Meeting flow

1. Open the site and enter the generated host access code.
2. Start as caster and allow camera and microphone access.
3. Copy the viewer link.
4. Viewers join without camera permission.
5. A viewer raises a hand.
6. The caster selects `Allow mic`; the viewer can then tap to talk.
7. The caster can revoke the microphone at any time.

## Verify

```powershell
Invoke-RestMethod https://YOUR_HOST/healthz
Invoke-RestMethod https://YOUR_HOST/config
```

`healthz` should report `hostConfigured: true`. A participant request to
`POST /token` should succeed, while a caster request with a wrong code should
return HTTP 403.

## Teardown

```powershell
$s = Get-Content .deploy-state.json | ConvertFrom-Json
aws ec2 terminate-instances --region $s.region --instance-ids $s.instanceId
```
