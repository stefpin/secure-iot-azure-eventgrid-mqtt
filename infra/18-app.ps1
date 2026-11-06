<#
    Step 18 - deploy the operator web app on vm-ops.

      * Node 24 app -> /opt/iot/app (npm install on the VM), runs as iotapp with the
        user-assigned identity id-iotmq-app (MQTT via Entra ID, Kafka via Entra ID, Cosmos keyless)
      * nginx :80 vhost = Azure Front Door origin: basic auth for operators, WebSockets,
        X-Azure-FDID check (filled in by step 19 once the Front Door profile exists)
      * the operator password is generated here, stored ONLY in -PasswordFile (outside the
        project) and as a bcrypt hash on the VM
#>
param([Parameter(Mandatory)][string]$PasswordFile, [string]$OperatorUser = 'iot-operator')
. "$PSScriptRoot\env.ps1"
. "$PSScriptRoot\lib-vm.ps1"

$rg = $Demo.ResourceGroup
$vm = $Demo.OpsVm
$root = Split-Path $PSScriptRoot -Parent
$appId = Invoke-Az identity show -g $rg -n $Demo.AppIdentity -o json
$ns = Invoke-Az rest --method get --url "https://management.azure.com$($Demo.RgId)/providers/Microsoft.EventGrid/namespaces/$($Demo.EventGrid)?api-version=2025-02-15" -o json
$cosmos = Invoke-Az cosmosdb show -g $rg -n $Demo.Cosmos -o json

if (-not (Test-Path $PasswordFile)) {
    $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'.ToCharArray()
    $bytes = New-Object byte[] 20
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $pw = -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
    Set-Content -Path $PasswordFile -Value "$OperatorUser`n$pw" -NoNewline
    Write-Ok "operator password generated -> $PasswordFile"
}
$pw = (Get-Content $PasswordFile)[1].Trim()

Write-Step 'Ship the app and configuration'
Write-Ok (Send-VmFolder -Vm $vm -LocalDir "$root\ops\app" -RemoteDir /opt/iot/app -Exclude @('node_modules', '.env'))
Write-Ok (Send-VmFolder -Vm $vm -LocalDir "$root\ops\config" -RemoteDir /opt/iot/config)

Write-Step 'npm install, settings, systemd, nginx'
$envFile = @"
AZURE_CLIENT_ID=$($appId.clientId)
IOT_BROKER_HOST=$($ns.properties.topicSpacesConfiguration.hostname)
IOT_NAMESPACE=$($Demo.EventGrid)
IOT_MQTT_HOST=$($Demo.MqttHost)
IOT_SITE=$($Demo.Site)
IOT_EVENTHUBS_NAMESPACE=$($Demo.EventHubs)
IOT_COSMOS_ENDPOINT=$($cosmos.documentEndpoint)
IOT_COSMOS_DB=$($Demo.CosmosDb)
IOT_CERTSVC_URL=http://127.0.0.1:8081
IOT_TIME_ZONE=Asia/Jakarta
IOT_SUBSCRIPTION_ID=$($Demo.SubscriptionId)
IOT_RESOURCE_GROUP=$($Demo.ResourceGroup)
IOT_TENANT_ID=$((Invoke-Az account show -o json).tenantId)
PORT=3000
PUBLIC_URL=https://$($Demo.OpsHost)
UI_USER=$OperatorUser
UI_ROLE=Operator
UI_TITLE=Contoso IoT Operations - Event Grid MQTT
"@
$out = Invoke-VmScript $vm @"
set -e
cd /opt/iot/app
npm install --omit=dev --no-audit --no-fund --loglevel=error >/tmp/npm.log 2>&1 || { tail -20 /tmp/npm.log; echo IOT-FAIL npm; exit 0; }
chown -R root:root /opt/iot/app
cat > /etc/iot/app.env <<'EOF'
$envFile
EOF
echo "IOT_INTERNAL_TOKEN=`$(cat /etc/iot/internal.token)" >> /etc/iot/app.env
chown root:iotapp /etc/iot/app.env && chmod 640 /etc/iot/app.env
install -m 644 /opt/iot/config/iot-app.service /etc/systemd/system/iot-app.service
install -m 644 /opt/iot/config/nginx-ops.conf /etc/nginx/sites-available/iot-ops
[ -f /etc/nginx/iot-fdid.conf ] || echo '# X-Azure-FDID check is added by 19-frontdoor.ps1' > /etc/nginx/iot-fdid.conf
htpasswd -bcB /etc/nginx/iot-ops.htpasswd '$OperatorUser' '$pw' >/dev/null 2>&1
chown root:www-data /etc/nginx/iot-ops.htpasswd && chmod 640 /etc/nginx/iot-ops.htpasswd
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/iot-ops /etc/nginx/sites-enabled/iot-ops
nginx -t -q
systemctl reload nginx
systemctl daemon-reload
systemctl enable iot-app >/dev/null 2>&1
systemctl restart iot-app
sleep 12
echo "NODE `$(node -v)  MODULES `$(ls node_modules | wc -l)"
curl -s http://127.0.0.1:3000/api/health | head -c 1500; echo
echo "AUTH-NO `$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/)"
echo "AUTH-YES `$(curl -s -o /dev/null -w '%{http_code}' -u '$OperatorUser':'$pw' http://127.0.0.1/)"
journalctl -u iot-app --since -1min --no-pager -o cat | tail -8
"@
(Get-StdOut $out) -split "`n" | ForEach-Object { Write-Info $_ }
if ($out -match 'IOT-FAIL') { throw 'npm install failed' }
