<#
    Step 17 - deploy the mine-site agent on vm-site1.

      1. Register the site gateway gw-site1 with the certificate service (Event Grid client
         with attributes type=gateway, site=site1) and get its one-time enrolment token.
      2. Ship the agent code, the PUBLIC trust bundle (root CA + server issuing CA) and the
         token to vm-site1; install the systemd unit.
      3. The agent generates its own key, enrols over private HTTPS through the VPN, then
         connects to mqtt.iot.example.com (private endpoint) with mutual TLS.
#>
. "$PSScriptRoot\env.ps1"
. "$PSScriptRoot\lib-vm.ps1"

$root = Split-Path $PSScriptRoot -Parent
$gw = "gw-$($Demo.Site)"

Write-Step "Register $gw with the certificate service"
$out = Get-StdOut (Invoke-VmScript $Demo.OpsVm @"
T=`$(cat /etc/iot/internal.token)
r=`$(curl -s -H "X-IOT-Internal: `$T" -H 'Content-Type: application/json' -d '{"deviceId":"$gw","type":"gateway","site":"$($Demo.Site)","createdBy":"17-site.ps1"}' http://127.0.0.1:8081/internal/devices)
if echo "`$r" | grep -q 'already exists'; then
  r=`$(curl -s -X POST -H "X-IOT-Internal: `$T" http://127.0.0.1:8081/internal/devices/$gw/token)
fi
echo "`$r" | python3 -c 'import sys,json; d=json.load(sys.stdin); print("TOKEN", d["token"])'
"@)
if ($out -notmatch 'TOKEN (\S+)') { throw "could not register ${gw}:`n$out" }
$token = $Matches[1]
Write-Ok "$gw registered (one-time token received, valid 24 h)"

Write-Step 'Ship agent code, trust bundle and configuration to vm-site1'
Write-Ok (Send-VmFolder -Vm $Demo.SiteVm -LocalDir "$root\site\agent" -RemoteDir /opt/iot/agent -Exclude @('__pycache__', '*.pyc'))
Send-VmFile -Vm $Demo.SiteVm -LocalPath "$root\pki\trust-bundle.pem" -RemotePath /etc/iot/trust-bundle.pem | Out-Null
Send-VmFile -Vm $Demo.SiteVm -LocalPath "$root\site\config\iot-site.service" -RemotePath /etc/systemd/system/iot-site.service | Out-Null
Write-Ok 'trust-bundle.pem (public CA certificates only) and iot-site.service'

$out = Invoke-VmScript $Demo.SiteVm @"
set -e
cat > /etc/iot/site.env <<'EOF'
IOT_SITE=$($Demo.Site)
IOT_GATEWAY_ID=$gw
IOT_MQTT_HOST=$($Demo.MqttHost)
IOT_ENROLL_URL=https://$($Demo.EnrollHost)/v1
IOT_TRUST_BUNDLE=/etc/iot/trust-bundle.pem
IOT_STATE_ROOT=/var/lib/iot
IOT_GATEWAY_TOKEN_FILE=/etc/iot/gateway.token
EOF
umask 077
printf '%s' '$token' > /etc/iot/gateway.token
chown iotsite:iotsite /etc/iot/gateway.token
chmod 644 /etc/iot/site.env /etc/iot/trust-bundle.pem
chown -R iotsite:iotsite /var/lib/iot
systemctl daemon-reload
systemctl enable iot-site >/dev/null 2>&1
systemctl restart iot-site
sleep 15
journalctl -u iot-site --since -1min --no-pager -o cat | tail -6
"@
(Get-StdOut $out) -split "`n" | ForEach-Object { Write-Info $_.Trim() }
if ((Get-StdOut $out) -notmatch 'connected') { Write-Warning 'gateway not connected yet - check: journalctl -u iot-site' }
