<#
    Step 90 - end-to-end test of the whole demo.

      A. Azure configuration    tags, private-only data planes, IP filter, offline root key, scope
      B. Mine site (vm-site1)   tests\e2e_site.sh  - VPN, DNS, private TLS, public path blocked
      C. Operations (vm-ops)    tests\e2e_ops.py   - onboarding, telemetry, Kafka, commands, retained,
                                                     Last Will, routing, renewal, expiry, revoke, delete
      D. Internet               Front Door + custom domain, origin lock, Grafana sign-in
    -Quick skips the ~6-minute expiry / re-enrolment checks.
#>
param([switch]$Quick, [string]$PasswordFile)
. "$PSScriptRoot\env.ps1"
. "$PSScriptRoot\lib-vm.ps1"
$rg = $Demo.ResourceGroup
$root = Split-Path $PSScriptRoot -Parent
$results = New-Object System.Collections.Generic.List[object]
function Add-Result([string]$Id, [bool]$Ok, [string]$Detail) {
    $results.Add([pscustomobject]@{ Id = $Id; Ok = $Ok; Detail = $Detail })
    Write-Host ("{0} {1} :: {2}" -f $(if ($Ok) { 'PASS' } else { 'FAIL' }), $Id, $Detail) -ForegroundColor $(if ($Ok) { 'Green' } else { 'Red' })
}
$started = Get-Date

Write-Step 'A. Azure configuration'
$res = @(Invoke-Az resource list -g $rg -o json)
$untagged = @($res | Where-Object { -not $_.tags -or $_.tags.CostControl -ne 'Ignore' } | Where-Object { $_.type -notmatch 'extensions|runCommands' })
Add-Result 'A01 every resource tagged CostControl=Ignore' ($untagged.Count -eq 0) "$($res.Count) resources, untagged: $(($untagged | ForEach-Object { $_.name }) -join ', ')"
$ns = Invoke-Az rest --method get --url "https://management.azure.com$($Demo.RgId)/providers/Microsoft.EventGrid/namespaces/$($Demo.EventGrid)?api-version=2025-02-15" -o json
$ips = @($ns.properties.inboundIpRules | ForEach-Object { $_.ipMask })
Add-Result 'A02 Event Grid public access = selected IPs only' ($ns.properties.publicNetworkAccess -eq 'Enabled' -and $ips.Count -eq 1 -and $ips[0] -eq '192.0.2.1/32') "publicNetworkAccess=$($ns.properties.publicNetworkAccess) allow=$($ips -join ',') (TEST-NET placeholder)"
$cd = $ns.properties.topicSpacesConfiguration.customDomains[0]
Add-Result 'A03 custom domain approved, Key Vault certificate by name' ($cd.validationState -eq 'Approved' -and $cd.certificateUrl -match '/certificates/mqtt-srv-') "$($cd.fullyQualifiedDomainName) -> $($cd.certificateUrl.Split('/')[-1])"
$eh = Invoke-Az eventhubs namespace show -g $rg -n $Demo.EventHubs -o json
$kv = Invoke-Az keyvault show -g $rg -n $Demo.KeyVault -o json
$co = Invoke-Az cosmosdb show -g $rg -n $Demo.Cosmos -o json
$priv = ($eh.publicNetworkAccess -eq 'Disabled') -and ($kv.properties.publicNetworkAccess -eq 'Disabled') -and ($co.publicNetworkAccess -eq 'Disabled')
Add-Result 'A04 Event Hubs, Key Vault, Cosmos DB: public network access disabled' $priv "EH=$($eh.publicNetworkAccess) KV=$($kv.properties.publicNetworkAccess) Cosmos=$($co.publicNetworkAccess)"
$keyless = ($eh.disableLocalAuth -eq $true) -and ($co.disableLocalAuth -eq $true)
Add-Result 'A05 keyless: Event Hubs SAS and Cosmos keys disabled' $keyless "EH disableLocalAuth=$($eh.disableLocalAuth) Cosmos disableLocalAuth=$($co.disableLocalAuth)"
$out = Get-StdOut (Invoke-VmScript $Demo.OpsVm @"
/opt/iot/certsvc/venv/bin/python - <<'EOF'
from azure.identity import ManagedIdentityCredential
from azure.keyvault.keys import KeyClient
import os
c = ManagedIdentityCredential(client_id=[l.split('=',1)[1].strip() for l in open('/etc/iot/certsvc.env') if l.startswith('AZURE_CLIENT_ID=')][0])
k = KeyClient('https://$($Demo.KeyVault).vault.azure.net/', c)
for n in ('iot-device-ca','iot-server-ca'):
    p = k.get_key(n)
    print('KEY', n, p.key_type, p.properties.enabled, ','.join(o for o in p.key_operations))
try:
    k.get_key('iot-root-ca'); print('ROOT readable')
except Exception as e:
    print('ROOT not readable by the service:', type(e).__name__)
EOF
"@)
$hsm = ($out -match 'KEY iot-device-ca .*RSA[-_]HSM True') -and ($out -match 'KEY iot-server-ca .*RSA[-_]HSM True') -and ($out -match 'ROOT not readable')
Add-Result 'A06 CA keys are HSM keys; root key out of the service''s reach' $hsm (($out -split "`n" | Where-Object { $_ -match 'KEY|ROOT' }) -join ' | ')
$roles = @(Invoke-Az role assignment list --assignee (Invoke-Az identity show -g $rg -n $Demo.AppIdentity -o json).principalId --all -o json)
$wide = @($roles | Where-Object { $_.scope -notlike "$($Demo.RgId)/*" })
Add-Result 'A07 app identity: no role outside the resource group' ($wide.Count -eq 0) "$($roles.Count) role assignments: $(($roles | ForEach-Object { $_.roleDefinitionName }) -join ', ')"

Write-Step 'B. Mine site (vm-site1)'
Send-VmFile -Vm $Demo.SiteVm -LocalPath "$root\tests\e2e_site.sh" -RemotePath /opt/iot/tests/e2e_site.sh -Mode 0755 | Out-Null
$egHost = $ns.properties.topicSpacesConfiguration.hostname
$out = Get-StdOut (Invoke-VmScript $Demo.SiteVm "MQTT_HOST=$($Demo.MqttHost) ENROLL_HOST=$($Demo.EnrollHost) EG_HOST=$egHost bash /opt/iot/tests/e2e_site.sh")
foreach ($line in $out -split "`n") { if ($line -match '^(PASS|FAIL) (\S+) :: (.*)$') { Add-Result $Matches[2] ($Matches[1] -eq 'PASS') $Matches[3] } }

Write-Step "C. Operations (vm-ops) - $(if ($Quick) { 'quick' } else { 'full, ~12 minutes' })"
Send-VmFile -Vm $Demo.OpsVm -LocalPath "$root\tests\e2e_ops.py" -RemotePath /opt/iot/tests/e2e_ops.py | Out-Null
$out = Get-StdOut (Invoke-VmScript $Demo.OpsVm "cd /opt/iot/tests && /opt/iot/certsvc/venv/bin/python e2e_ops.py $(if ($Quick) { '--quick' }) 2>&1 | grep -E '^(PASS|FAIL|SUMMARY)'")
foreach ($line in $out -split "`n") { if ($line -match '^(PASS|FAIL) (\S+) (.*?) :: (.*)$') { Add-Result $Matches[2] ($Matches[1] -eq 'PASS') "$($Matches[3]) - $($Matches[4])" } }

Write-Step 'D. Internet (this computer)'
$ops = "https://$($Demo.OpsHost)"
$code = & curl.exe -s -o NUL -w '%{http_code}' --max-time 20 "$ops/"
Add-Result 'D01 operator URL needs sign-in' ($code -eq '401') "$ops -> $code"
if ($PasswordFile -and (Test-Path $PasswordFile)) {
    $u, $pw = (Get-Content $PasswordFile)
    $h = & curl.exe -s --max-time 20 -u "$($u.Trim()):$($pw.Trim())" "$ops/api/health"
    $hj = try { $h | ConvertFrom-Json } catch { $null }
    Add-Result 'D02 operator app through Front Door (TLS, custom domain)' ($hj -and $hj.mqtt.connected) "health via Front Door: mqtt=$($hj.mqtt.connected) kafka=$($hj.kafka.connected)"
}
$pip = Invoke-Az network public-ip show -g $rg -n pip-ops -o json
$code = & curl.exe -s -o NUL -w '%{http_code}' --max-time 8 "http://$($pip.ipAddress)/"
Add-Result 'D03 origin not reachable directly (NSG: Front Door only)' ($code -eq '000') "http://$($pip.ipAddress)/ -> $code"
$hostName = $Demo.OpsHost
try {
    $tcp = New-Object Net.Sockets.TcpClient($hostName, 443)
    $ssl = New-Object Net.Security.SslStream($tcp.GetStream(), $false, { $true })
    $ssl.AuthenticateAsClient($hostName)
    $c = New-Object Security.Cryptography.X509Certificates.X509Certificate2($ssl.RemoteCertificate)
    $chainOk = (New-Object Security.Cryptography.X509Certificates.X509Chain).Build($c)
    $ssl.Dispose(); $tcp.Dispose()
    $nameOk = ($c.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::DnsFromAlternativeName, $false) -eq $hostName) -or ($c.Subject -match [regex]::Escape($hostName))
    Add-Result 'D04 Front Door managed certificate on ops.iot.example.com' ($chainOk -and $nameOk) "issuer: $($c.Issuer -replace ',.*$', ''), valid to $($c.NotAfter.ToString('yyyy-MM-dd')), publicly trusted=$chainOk, name match=$nameOk"
} catch { Add-Result 'D04 Front Door managed certificate on ops.iot.example.com' $false $_.Exception.Message }
$g = Invoke-Az rest --method get --url "https://management.azure.com$($Demo.RgId)/providers/Microsoft.Dashboard/grafana/$($Demo.Grafana)?api-version=2026-09-01" -o json
$code = & curl.exe -s -o NUL -w '%{http_code}' --max-time 20 "$($g.properties.endpoint)/api/health"
Add-Result 'D05 Managed Grafana reachable, sign-in enforced' ($code -in '401', '302') "$($g.properties.endpoint) -> $code without a token (Entra ID sign-in required)"

$passed = @($results | Where-Object Ok).Count
$minutes = [math]::Round(((Get-Date) - $started).TotalMinutes, 1)
Write-Host "`nRESULT: $passed of $($results.Count) checks passed in $minutes min" -ForegroundColor $(if ($passed -eq $results.Count) { 'Green' } else { 'Yellow' })
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$results | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $root "tests\results-$stamp.json")
