# =============================================================================
# deploy-aws.ps1 - stand up OnesimusRTC on a single EC2 box, phone-testable.
# Creates a security group + launches an Ubuntu instance whose user-data
# (cloud-init.sh) installs docker and brings up LiveKit + Caddy + the app with
# automatic HTTPS. Prints the URL to open on your phone.
#
#   ./deploy-aws.ps1                       # us-east-1, t3.small
#   ./deploy-aws.ps1 -Region us-west-2 -InstanceType c5.large
#
# Requires an ACTIVE aws session (aws sts get-caller-identity must succeed).
# No secrets live in this file; LiveKit keys are generated on the box at boot.
# =============================================================================
param(
  [string]$Region       = "us-east-1",
  [string]$InstanceType = "t3.small",
  [string]$Name         = "onesimusrtc",
  [string]$SgName       = "onesimusrtc-sg",
  [string]$Profile      = ""
)
$ErrorActionPreference = "Stop"
if ($Profile) { $env:AWS_PROFILE = $Profile }
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$userData = Join-Path $here "cloud-init.sh"

Write-Host "== Checking AWS session ==" -ForegroundColor Cyan
try { aws sts get-caller-identity --output json | Out-Null }
catch {
  Write-Host "AWS session is not active. Run your usual 'aws login' / 'aws sso login' and retry." -ForegroundColor Red
  exit 1
}

Write-Host "== Resolving Ubuntu 22.04 AMI ==" -ForegroundColor Cyan
$ami = aws ec2 describe-images --region $Region --owners 099720109477 `
  --filters "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*" "Name=state,Values=available" `
  --query "sort_by(Images,&CreationDate)[-1].ImageId" --output text
Write-Host "  AMI = $ami"

Write-Host "== Security group ==" -ForegroundColor Cyan
$sgId = (aws ec2 describe-security-groups --region $Region `
  --filters "Name=group-name,Values=$SgName" `
  --query "SecurityGroups[0].GroupId" --output text) 2>$null
if (-not $sgId -or $sgId -eq "None") {
  $sgId = aws ec2 create-security-group --region $Region `
    --group-name $SgName --description "OnesimusRTC RTC + web" `
    --query "GroupId" --output text
  Write-Host "  created $sgId"
  foreach ($p in 22,80,443,7881) {
    aws ec2 authorize-security-group-ingress --region $Region --group-id $sgId `
      --protocol tcp --port $p --cidr 0.0.0.0/0 | Out-Null
  }
  aws ec2 authorize-security-group-ingress --region $Region --group-id $sgId `
    --protocol udp --port 50000-60000 --cidr 0.0.0.0/0 | Out-Null
  Write-Host "  ingress: tcp 22/80/443/7881, udp 50000-60000"
} else {
  Write-Host "  reusing $sgId"
}

Write-Host "== Launching instance ==" -ForegroundColor Cyan
$iid = aws ec2 run-instances --region $Region `
  --image-id $ami --instance-type $InstanceType `
  --security-group-ids $sgId `
  --user-data "file://$userData" `
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$Name}]" `
  --query "Instances[0].InstanceId" --output text
Write-Host "  instance $iid - waiting for running..."
aws ec2 wait instance-running --region $Region --instance-ids $iid

$ip = aws ec2 describe-instances --region $Region --instance-ids $iid `
  --query "Reservations[0].Instances[0].PublicIpAddress" --output text
$dash = $ip.Replace(".", "-")
$url = "https://$dash.sslip.io"

@{ instanceId=$iid; ip=$ip; url=$url; region=$Region; sg=$sgId } |
  ConvertTo-Json | Set-Content (Join-Path $here ".deploy-state.json")

Write-Host ""
Write-Host "==============================================================" -ForegroundColor Green
Write-Host " OnesimusRTC deploying to: $url" -ForegroundColor Green
Write-Host " Give it ~3-4 min for docker build + TLS certs, then open on your phone." -ForegroundColor Green
Write-Host " Instance: $iid   IP: $ip   Region: $Region" -ForegroundColor Green
Write-Host "==============================================================" -ForegroundColor Green
