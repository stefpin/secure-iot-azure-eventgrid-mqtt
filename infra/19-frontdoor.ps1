<#
    Step 19 - publish the operator app through Azure Front Door Standard.

      profile  afd-iotmq-<suffix> (Standard_AzureFrontDoor, global)
      endpoint ops-iotmq-<suffix>.<hash>.z01.azurefd.net
      origin   vm-ops public IP DNS name, HTTP 80 (NSG: AzureFrontDoor.Backend only)
      domain   ops.iot.example.com, Front Door managed TLS certificate
               (TXT _dnsauth.ops + CNAME ops in the Azure public DNS zone)
      route    HTTPS only (HTTP redirects), no caching
    nginx on vm-ops then accepts only requests carrying this profile's X-Azure-FDID.
#>
. "$PSScriptRoot\env.ps1"
. "$PSScriptRoot\lib-vm.ps1"

$rg = $Demo.ResourceGroup
$afd = $Demo.FrontDoor
$ep = "ops-iotmq-$($Demo.Suffix)"
$domainRes = 'ops-iotdemo'
$label = ($Demo.OpsHost -split '\.')[0]
$pip = Invoke-Az network public-ip show -g $rg -n pip-ops -o json
$originHost = $pip.dnsSettings.fqdn

Write-Step "Front Door profile $afd + endpoint $ep"
& az afd profile show -g $rg --profile-name $afd -o none 2>$null
if ($LASTEXITCODE -ne 0) { Invoke-Az afd profile create -g $rg --profile-name $afd --sku Standard_AzureFrontDoor --tags @($Demo.Tags) -o none | Out-Null }
& az afd endpoint show -g $rg --profile-name $afd --endpoint-name $ep -o none 2>$null
if ($LASTEXITCODE -ne 0) { Invoke-Az afd endpoint create -g $rg --profile-name $afd --endpoint-name $ep --enabled-state Enabled --tags @($Demo.Tags) -o none | Out-Null }
$endpoint = Invoke-Az afd endpoint show -g $rg --profile-name $afd --endpoint-name $ep -o json
$profile = Invoke-Az afd profile show -g $rg --profile-name $afd -o json
Write-Ok "endpoint $($endpoint.hostName)  frontDoorId $($profile.frontDoorId)"

Write-Step "Origin group + origin ($($originHost):80)"
& az afd origin-group show -g $rg --profile-name $afd --origin-group-name og-ops -o none 2>$null
if ($LASTEXITCODE -ne 0) {
    Invoke-Az afd origin-group create -g $rg --profile-name $afd --origin-group-name og-ops `
        --probe-request-type GET --probe-protocol Http --probe-interval-in-seconds 60 --probe-path /healthz `
        --sample-size 4 --successful-samples-required 3 --additional-latency-in-milliseconds 50 -o none | Out-Null
}
& az afd origin show -g $rg --profile-name $afd --origin-group-name og-ops --origin-name vm-ops -o none 2>$null
if ($LASTEXITCODE -ne 0) {
    Invoke-Az afd origin create -g $rg --profile-name $afd --origin-group-name og-ops --origin-name vm-ops `
        --host-name $originHost --origin-host-header $originHost --http-port 80 --https-port 443 `
        --priority 1 --weight 1000 --enabled-state Enabled --enforce-certificate-name-check true -o none | Out-Null
}
Write-Ok 'origin vm-ops'

Write-Step "Custom domain $($Demo.OpsHost) (managed certificate)"
$zoneId = "$($Demo.RgId)/providers/Microsoft.Network/dnszones/$($Demo.Zone)"
& az afd custom-domain show -g $rg --profile-name $afd --custom-domain-name $domainRes -o none 2>$null
if ($LASTEXITCODE -ne 0) {
    Invoke-Az afd custom-domain create -g $rg --profile-name $afd --custom-domain-name $domainRes `
        --host-name $Demo.OpsHost --certificate-type ManagedCertificate --minimum-tls-version TLS12 `
        --azure-dns-zone $zoneId -o none | Out-Null
}
$cd = Invoke-Az afd custom-domain show -g $rg --profile-name $afd --custom-domain-name $domainRes -o json
$token = $cd.validationProperties.validationToken
if ($token) {
    $txtName = "_dnsauth.$label"
    $existing = & az network dns record-set txt show -g $rg -z $Demo.Zone -n $txtName --query "TXTRecords[0].value[0]" -o tsv 2>$null
    if ($existing -ne $token) {
        & az network dns record-set txt delete -g $rg -z $Demo.Zone -n $txtName --yes -o none 2>$null
        Invoke-Az network dns record-set txt create -g $rg -z $Demo.Zone -n $txtName --ttl 3600 -o none | Out-Null
        Invoke-Az network dns record-set txt add-record -g $rg -z $Demo.Zone -n $txtName -v $token -o none | Out-Null
    }
    Write-Ok "TXT $txtName.$($Demo.Zone) = validation token"
}
& az network dns record-set cname show -g $rg -z $Demo.Zone -n $label -o none 2>$null
if ($LASTEXITCODE -ne 0) {
    Invoke-Az network dns record-set cname set-record -g $rg -z $Demo.Zone -n $label -c $endpoint.hostName --ttl 300 -o none | Out-Null
}
Write-Ok "CNAME $($Demo.OpsHost) -> $($endpoint.hostName)"

Write-Step 'Route (HTTPS only, HTTP redirects, no caching)'
& az afd route show -g $rg --profile-name $afd --endpoint-name $ep --route-name rt-ops -o none 2>$null
if ($LASTEXITCODE -ne 0) {
    Invoke-Az afd route create -g $rg --profile-name $afd --endpoint-name $ep --route-name rt-ops `
        --origin-group og-ops --supported-protocols Http Https --https-redirect Enabled `
        --forwarding-protocol HttpOnly --patterns-to-match '/*' --link-to-default-domain Enabled `
        --custom-domains $domainRes --enabled-state Enabled -o none | Out-Null
}
Write-Ok 'rt-ops'

Write-Step 'Lock the origin to this Front Door profile (X-Azure-FDID)'
$fdid = $profile.frontDoorId
$out = Invoke-VmScript $Demo.OpsVm @"
cat > /etc/nginx/iot-fdid.conf <<'EOF'
# Only requests forwarded by Front Door profile $afd
if (`$http_x_azure_fdid != "$fdid") { return 403; }
EOF
nginx -t -q && systemctl reload nginx && echo IOT-OK
echo "direct-to-origin without FDID: `$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/)"
"@
(Get-StdOut $out) -split "`n" | ForEach-Object { Write-Ok $_.Trim() }

$cd = Invoke-Az afd custom-domain show -g $rg --profile-name $afd --custom-domain-name $domainRes -o json
Write-Info "domain validation: $($cd.domainValidationState)  (managed certificate issuance can take 5-30 minutes)"
Write-Info "operator URL: https://$($Demo.OpsHost)   (until the certificate is ready: https://$($endpoint.hostName))"
