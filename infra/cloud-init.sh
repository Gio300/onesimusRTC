#!/usr/bin/env bash
# EC2 user-data: install docker, clone the repo, template the config with the
# instance's public IP + fresh LiveKit keys, and bring the stack up.
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl git openssl

# --- Docker + compose plugin ---
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# --- Fetch the app ---
cd /opt
rm -rf onesimusRTC
git clone https://github.com/Gio300/onesimusRTC.git
cd onesimusRTC/infra

# --- Discover public IP (IMDSv2) + generate keys ---
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
IP=$(curl -s -H "X-aws-ec2-metadata-token: ${TOKEN}" \
  http://169.254.169.254/latest/meta-data/public-ipv4)
DASH=${IP//./-}
KEY=$(openssl rand -hex 16)
SECRET=$(openssl rand -hex 32)

cat > .env <<EOF
WEB_HOST=${DASH}.sslip.io
LK_HOST=lk.${DASH}.sslip.io
LIVEKIT_API_KEY=${KEY}
LIVEKIT_API_SECRET=${SECRET}
LIVEKIT_WS_URL=wss://lk.${DASH}.sslip.io
PORT=8080
EOF

sed -e "s/__API_KEY__/${KEY}/" -e "s/__API_SECRET__/${SECRET}/" \
  livekit.yaml > livekit.generated.yaml

docker compose up -d --build

echo "OnesimusRTC is starting at https://${DASH}.sslip.io"
