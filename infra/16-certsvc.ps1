<#
    Step 16 - deploy the certificate service on vm-ops.

      * code -> /opt/iot/certsvc/src, settings -> /etc/iot/certsvc.env (no secrets except the
        local internal-API token, generated on the VM and never leaving it)
      * systemd unit iot-certsvc (hardened), nginx enrolment vhost (10.40.1.10:443),
        path unit that reloads nginx when the enrolment certificate is renewed
      * on start-up the service issues the first MQTT server certificate under a new
        Key Vault name and switches the custom domain to it
      * registers the mine-site gateway (gw-site1) and prints its one-time token location
#>
. "$PSScriptRoot\env.ps1"
. "$PSScriptRoot\lib-vm.ps1"

$rg = $Demo.ResourceGroup
$vm = $Demo.OpsVm
$root = Split-Path $PSScriptRoot -Parent
$cert = Invoke-Az identity show -g $rg -n $Demo.CertIdentity -o json
$ns = Invoke-Az rest --method get --url "https://management.azure.com$($Demo.RgId)/providers/Microsoft.EventGrid/namespaces/$($Demo.EventGrid)?api-version=2025-02-15" -o json
$appi = Invoke-Az rest --method get --url "https://management.azure.com$($Demo.RgId)/providers/Microsoft.Insights/components/$($Demo.AppInsights)?api-version=2020-02-02" -o json
$cosmos = Invoke-Az cosmosdb show -g $rg -n $Demo.Cosmos -o json

Write-Step 'Ship code and configuration'
Write-Ok (Send-VmFolder -Vm $vm -LocalDir "$root\ops\certsvc" -RemoteDir /opt/iot/certsvc/src -Exclude @('__pycache__', '*.pyc'))
Write-Ok (Send-VmFolder -Vm $vm -LocalDir "$root\ops\config" -RemoteDir /opt/iot/config)

Write-Step 'Settings, permissions, systemd and nginx'
$envFile = @"
AZURE_CLIENT_ID=$($cert.clientId)
IOT_VAULT_URL=https://$($Demo.KeyVault).vault.azure.net/
IOT_NAMESPACE_ID=$($ns.id)
IOT_BROKER_HOST=$($ns.properties.topicSpacesConfiguration.hostname)
IOT_MQTT_HOST=$($Demo.MqttHost)
IOT_ENROLL_HOST=$($Demo.EnrollHost)
IOT_COSMOS_ENDPOINT=$($cosmos.documentEndpoint)
IOT_COSMOS_DB=$($Demo.CosmosDb)
IOT_DEVICE_CERT_MINUTES=60
IOT_REENROLL_GRACE_HOURS=24
IOT_TOKEN_HOURS=24
IOT_SERVER_CERT_DAYS=7
IOT_SERVER_RENEW_DAYS_LEFT=3
APPLICATIONINSIGHTS_CONNECTION_STRING=$($appi.properties.ConnectionString)
OTEL_SERVICE_NAME=iot-certsvc
"@
$out = Invoke-VmScript $vm @"
set -e
[ -s /etc/iot/internal.token ] || (head -c 32 /dev/urandom | base64 | tr -d '/+=' > /etc/iot/internal.token)
chmod 640 /etc/iot/internal.token && chgrp iotcert /etc/iot/internal.token
cat > /etc/iot/certsvc.env <<'EOF'
$envFile
EOF
echo "IOT_INTERNAL_TOKEN=`$(cat /etc/iot/internal.token)" >> /etc/iot/certsvc.env
chown root:iotcert /etc/iot/certsvc.env && chmod 640 /etc/iot/certsvc.env
chown root:iotcert /etc/iot/pki && chmod 750 /etc/iot/pki && chmod 644 /etc/iot/pki/*.pem
chown -R iotcert:iotcert /etc/iot/tls && chmod 750 /etc/iot/tls && chmod 640 /etc/iot/tls/enroll.key
install -m 644 /opt/iot/config/iot-certsvc.service /etc/systemd/system/iot-certsvc.service
install -m 644 /opt/iot/config/iot-enroll-tls.path /etc/systemd/system/iot-enroll-tls.path
install -m 644 /opt/iot/config/iot-enroll-tls.service /etc/systemd/system/iot-enroll-tls.service
install -m 644 /opt/iot/config/nginx-enroll.conf /etc/nginx/sites-available/iot-enroll
ln -sf /etc/nginx/sites-available/iot-enroll /etc/nginx/sites-enabled/iot-enroll
nginx -t -q
systemctl daemon-reload
systemctl enable --now iot-enroll-tls.path >/dev/null 2>&1
systemctl reload nginx || systemctl restart nginx
systemctl enable iot-certsvc >/dev/null 2>&1
systemctl restart iot-certsvc
echo IOT-OK
"@
if ($out -notmatch 'IOT-OK') { throw "configuration failed:`n$out" }
Write-Ok 'iot-certsvc started; nginx enrolment vhost on 10.40.1.10:443'

Write-Step 'Wait for the service (first start issues the MQTT server certificate - up to ~3 minutes)'
$probe = @'
T=$(cat /etc/iot/internal.token)
for i in $(seq 1 36); do
  h=$(curl -s -H "X-IOT-Internal: $T" http://127.0.0.1:8081/internal/health)
  echo "$h" | grep -q '"tick"' && break
  sleep 5
done
echo "HEALTH $h"
echo "SERVER $(curl -s -H "X-IOT-Internal: $T" http://127.0.0.1:8081/internal/server-cert)"
echo "ENROLL $(curl -s --cacert /etc/iot/pki/root-ca.pem --resolve enroll.iot.example.com:443:10.40.1.10 https://enroll.iot.example.com/v1/health)"
journalctl -u iot-certsvc --since -10min --no-pager | grep -iE 'error|exception|refused|rotat' | tail -5
'@
$out = Get-StdOut (Invoke-VmScript $vm $probe)
$out -split "`n" | ForEach-Object { Write-Info $_.Trim() }

Write-Step 'Custom domain ownership (first build only)'
$nsUrl = "https://management.azure.com$($ns.id)?api-version=2025-02-15"
$cd = (Invoke-Az rest --method get --url $nsUrl -o json).properties.topicSpacesConfiguration.customDomains | Select-Object -First 1
if (-not $cd) {
    Write-Warning 'No custom domain yet - the certificate service creates it with its first certificate; re-run this script in a few minutes.'
} elseif ($cd.validationState -eq 'Approved') {
    Write-Ok "$($cd.fullyQualifiedDomainName) already Approved"
} else {
    # Event Grid proves ownership with a TXT record in the PUBLIC zone (_eg.<custom domain>).
    $label = $cd.expectedTxtRecordName -replace "\.$([regex]::Escape($Demo.Zone))$", ''
    & az network dns record-set txt delete -g $rg -z $Demo.Zone -n $label --yes -o none 2>$null
    Invoke-Az network dns record-set txt add-record -g $rg -z $Demo.Zone -n $label -v $cd.expectedTxtRecordValue -o none | Out-Null
    Write-Ok "TXT $($cd.expectedTxtRecordName) created; asking Event Grid to validate"
    Start-Sleep 30
    Invoke-Az rest --method post --url "https://management.azure.com$($ns.id)/validateCustomDomainOwnership?api-version=2025-02-15" -o none | Out-Null
    $state = (Invoke-Az rest --method get --url $nsUrl -o json).properties.topicSpacesConfiguration.customDomains[0].validationState
    Write-Ok "validation state: $state (if Pending: wait for DNS propagation and re-run this script)"
}
