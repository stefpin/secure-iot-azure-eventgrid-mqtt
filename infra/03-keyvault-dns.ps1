<#
    Step 03 - Key Vault and DNS.

      kv-iotmq-<sfx>   Premium (HSM-backed keys), Azure RBAC, purge protection, public network access
                       disabled (Azure Policy enforces it anyway) -> reachable only through pe-kv
                       The Event Grid namespace identity gets "Key Vault Certificate User" so it can read
                       the custom-domain certificate (Event Grid is a trusted service for this).
      public zone      iot.example.com in Azure DNS. Afterwards, in Cloudflare (example.com),
                       add the 4 NS records this script prints (name: iotdemo, TTL Auto) - the delegation.
      private zone     iot.example.com linked to the HUB VNet only:
                         mqtt   CNAME <namespace>.indonesiacentral-1.ts.eventgrid.azure.net
                         enroll A     10.40.1.10   (added by step 12)
    -VerifyOnly  change nothing; report what exists
#>
param([switch]$VerifyOnly)
. "$PSScriptRoot\env.ps1"
$rg = $Demo.ResourceGroup; $loc = $Demo.Location
$script:diffs = 0
function Exists([string[]]$ShowArgs) { & az @ShowArgs -o none 2>$null; return ($LASTEXITCODE -eq 0) }
function Ensure([string]$What, [scriptblock]$Test, [scriptblock]$Create) {
    if (& $Test) { Write-Ok "$What (exists)"; return }
    if ($VerifyOnly) { Write-Host "   !!  $What MISSING" -ForegroundColor Yellow; $script:diffs++; return }
    & $Create | Out-Null; Write-Ok "$What (created)"
}

Write-Step "Key Vault $($Demo.KeyVault)"
Ensure 'vault (Premium, RBAC, purge protection, private)' { Exists @('keyvault', 'show', '-g', $rg, '-n', $Demo.KeyVault) } {
    Invoke-Az keyvault create -g $rg -n $Demo.KeyVault -l $loc --sku premium --enable-rbac-authorization true `
        --enable-purge-protection true --public-network-access Disabled --tags @($Demo.Tags) -o none }
$kvId = "$($Demo.RgId)/providers/Microsoft.KeyVault/vaults/$($Demo.KeyVault)"
Ensure 'private DNS zone privatelink.vaultcore.azure.net' { Exists @('network', 'private-dns', 'zone', 'show', '-g', $rg, '-n', 'privatelink.vaultcore.azure.net') } {
    Invoke-Az network private-dns zone create -g $rg -n privatelink.vaultcore.azure.net --tags @($Demo.Tags) -o none
    Invoke-Az network private-dns link vnet create -g $rg -z privatelink.vaultcore.azure.net -n link-hub -v $Demo.HubVnet -e false --tags @($Demo.Tags) -o none }
Ensure 'pe-kv (vault)' { Exists @('network', 'private-endpoint', 'show', '-g', $rg, '-n', 'pe-kv') } {
    Invoke-Az network private-endpoint create -g $rg -n pe-kv -l $loc --vnet-name $Demo.HubVnet --subnet $Demo.PeSubnet `
        --private-connection-resource-id $kvId --group-id vault --connection-name pe-kv-conn --tags @($Demo.Tags) -o none
    Invoke-Az network private-endpoint dns-zone-group create -g $rg --endpoint-name pe-kv -n default --private-dns-zone privatelink.vaultcore.azure.net --zone-name vault -o none }
$nsPrincipal = (Invoke-Az rest --method get --url "https://management.azure.com$($Demo.RgId)/providers/Microsoft.EventGrid/namespaces/$($Demo.EventGrid)?api-version=2025-02-15" -o json).identity.principalId
if (-not $VerifyOnly) {
    Invoke-Az role assignment create --assignee-object-id $nsPrincipal --assignee-principal-type ServicePrincipal `
        --role 'Key Vault Certificate User' --scope $kvId -o none | Out-Null
    Write-Ok 'Event Grid namespace identity -> Key Vault Certificate User'
}

Write-Step "Public DNS zone $($Demo.Zone)"
Ensure 'public zone' { Exists @('network', 'dns', 'zone', 'show', '-g', $rg, '-n', $Demo.Zone) } {
    Invoke-Az network dns zone create -g $rg -n $Demo.Zone --tags @($Demo.Tags) -o none }
$ns = @(& az network dns zone show -g $rg -n $Demo.Zone --query nameServers -o tsv 2>$null)
Write-Info 'Delegate it from Cloudflare: zone example.com > DNS > Add record, type NS, name iotdemo, TTL Auto, one record per server:'
foreach ($s in $ns) { Write-Info "    NS  iotdemo  ->  $($s.TrimEnd('.'))" }
$delegated = @(Resolve-DnsName -Name $Demo.Zone -Type NS -Server 1.1.1.1 -ErrorAction SilentlyContinue | Where-Object { $_.Type -eq 'NS' })
Write-Info "public delegation check (1.1.1.1): $(if ($delegated.Count) { 'delegated - ' + (($delegated | ForEach-Object { $_.NameHost }) -join ', ') } else { 'NOT delegated yet' })"

Write-Step "Private DNS zone $($Demo.Zone) (hub VNet only)"
Ensure 'private zone + hub link' { Exists @('network', 'private-dns', 'zone', 'show', '-g', $rg, '-n', $Demo.Zone) } {
    Invoke-Az network private-dns zone create -g $rg -n $Demo.Zone --tags @($Demo.Tags) -o none
    Invoke-Az network private-dns link vnet create -g $rg -z $Demo.Zone -n link-hub -v $Demo.HubVnet -e false --tags @($Demo.Tags) -o none }
$mqttTarget = (Invoke-Az rest --method get --url "https://management.azure.com$($Demo.RgId)/providers/Microsoft.EventGrid/namespaces/$($Demo.EventGrid)?api-version=2025-02-15" -o json).properties.topicSpacesConfiguration.hostname
Ensure "CNAME mqtt -> $mqttTarget" { Exists @('network', 'private-dns', 'record-set', 'cname', 'show', '-g', $rg, '-z', $Demo.Zone, '-n', 'mqtt') } {
    Invoke-Az network private-dns record-set cname set-record -g $rg -z $Demo.Zone -n mqtt -c $mqttTarget -o none }
Ensure "public CNAME mqtt -> $mqttTarget" { Exists @('network', 'dns', 'record-set', 'cname', 'show', '-g', $rg, '-z', $Demo.Zone, '-n', 'mqtt') } {
    Invoke-Az network dns record-set cname set-record -g $rg -z $Demo.Zone -n mqtt -c $mqttTarget --ttl 3600 -o none }
if ($VerifyOnly) { Write-Host "`nVerify-only: $script:diffs missing item(s)" -ForegroundColor $(if ($script:diffs) { 'Yellow' } else { 'Green' }) }
