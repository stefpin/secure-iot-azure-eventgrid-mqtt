<#
    Step 01 - resource group and networks (hub + mine site + site-to-site VPN).

      rg-iotmqtt-demo (Indonesia Central, CostControl=Ignore)
      vnet-hub  10.40.0.0/16   snet-app 10.40.1.0/24 (nsg-app) · snet-pe 10.40.2.0/27 · GatewaySubnet 10.40.255.0/27
      vnet-site 10.50.0.0/16   snet-site 10.50.1.0/24 (nsg-site, NO default outbound access - like a real site)
      pip-vpngw + vgw-hub      Basic, route-based VPN gateway (CLI only - Basic is not offered in the Portal;
                               creation takes 30-45 minutes)
      pip-site                 the mine site's public address = IPsec peer (later attached to vm-site1)
      lng-site + cn-hub-site   local network gateway (10.50.0.0/16) and IKEv2 connection with a pre-shared key

    -PskFile      file holding the IPsec pre-shared key (created with a random key if missing)
    -VerifyOnly   change nothing; report what exists and whether it matches
#>
param([Parameter(Mandatory)][string]$PskFile, [switch]$VerifyOnly)
. "$PSScriptRoot\env.ps1"
$rg = $Demo.ResourceGroup; $loc = $Demo.Location
$script:diffs = 0
function Ensure([string]$What, [scriptblock]$Exists, [scriptblock]$Create) {
    if (& $Exists) { Write-Ok "$What (exists)"; return }
    if ($VerifyOnly) { Write-Host "   !!  $What MISSING" -ForegroundColor Yellow; $script:diffs++; return }
    & $Create | Out-Null
    Write-Ok "$What (created)"
}
function Exists([string[]]$ShowArgs) { & az @ShowArgs -o none 2>$null; return ($LASTEXITCODE -eq 0) }

Write-Step 'Resource group'
Ensure $rg { (& az group exists -n $rg) -eq 'true' } { Invoke-Az group create -n $rg -l $loc --tags @($Demo.Tags) -o none }

Write-Step 'Network security groups'
foreach ($n in 'nsg-app', 'nsg-pe', 'nsg-site') {
    $found = Exists @('network', 'nsg', 'show', '-g', $rg, '-n', $n)
    # Governance may already have attached its own NSG to snet-pe (vnet-hub-snet-pe-nsg-<region>); accept it.
    if (-not $found -and $n -eq 'nsg-pe') {
        $found = [bool](& az network vnet subnet show -g $rg --vnet-name $Demo.HubVnet -n snet-pe --query networkSecurityGroup.id -o tsv 2>$null)
    }
    Ensure $n { $found } { Invoke-Az network nsg create -g $rg -n $n -l $loc --tags @($Demo.Tags) -o none }
}

Write-Step 'Hub VNet'
Ensure 'vnet-hub 10.40.0.0/16' { Exists @('network', 'vnet', 'show', '-g', $rg, '-n', $Demo.HubVnet) } {
    Invoke-Az network vnet create -g $rg -n $Demo.HubVnet -l $loc --address-prefixes 10.40.0.0/16 --tags @($Demo.Tags) -o none }
$subnets = @(
    @{ v = $Demo.HubVnet; n = 'snet-app'; p = '10.40.1.0/24'; nsg = 'nsg-app' },
    @{ v = $Demo.HubVnet; n = 'snet-pe'; p = '10.40.2.0/27'; nsg = 'nsg-pe' },
    @{ v = $Demo.HubVnet; n = 'GatewaySubnet'; p = '10.40.255.0/27'; nsg = $null }
)
Write-Step 'Site VNet'
Ensure 'vnet-site 10.50.0.0/16' { Exists @('network', 'vnet', 'show', '-g', $rg, '-n', $Demo.SiteVnet) } {
    Invoke-Az network vnet create -g $rg -n $Demo.SiteVnet -l $loc --address-prefixes $Demo.SitePrefix --tags @($Demo.Tags) -o none }
$subnets += @{ v = $Demo.SiteVnet; n = 'snet-site'; p = '10.50.1.0/24'; nsg = 'nsg-site'; private = $true }
foreach ($s in $subnets) {
    Ensure "$($s.v)/$($s.n) $($s.p)" { Exists @('network', 'vnet', 'subnet', 'show', '-g', $rg, '--vnet-name', $s.v, '-n', $s.n) } {
        $a = @('network', 'vnet', 'subnet', 'create', '-g', $rg, '--vnet-name', $s.v, '-n', $s.n, '--address-prefixes', $s.p, '-o', 'none')
        if ($s.nsg) { $a += @('--nsg', $s.nsg) }
        if ($s.private) { $a += @('--default-outbound', 'false') }
        Invoke-Az @a
    }
}

Write-Step 'Public IPs'
foreach ($n in 'pip-vpngw', 'pip-site') {
    Ensure $n { Exists @('network', 'public-ip', 'show', '-g', $rg, '-n', $n) } {
        Invoke-Az network public-ip create -g $rg -n $n -l $loc --sku Standard --allocation-method Static --tags @($Demo.Tags) -o none }
}
$gwIp = (Invoke-Az network public-ip show -g $rg -n pip-vpngw -o json).ipAddress
$siteIp = (Invoke-Az network public-ip show -g $rg -n pip-site -o json).ipAddress
Write-Info "VPN gateway address $gwIp   mine-site address $siteIp"

Write-Step 'Site NSG: allow IPsec only from the Azure VPN gateway'
Ensure 'nsg-site rule Allow-IPsec-From-AzureVpnGw' { Exists @('network', 'nsg', 'rule', 'show', '-g', $rg, '--nsg-name', 'nsg-site', '-n', 'Allow-IPsec-From-AzureVpnGw') } {
    Invoke-Az network nsg rule create -g $rg --nsg-name nsg-site -n Allow-IPsec-From-AzureVpnGw --priority 100 --direction Inbound `
        --access Allow --protocol Udp --source-address-prefixes $gwIp --destination-port-ranges 500 4500 -o none }

Write-Step 'VPN gateway (Basic, route-based) - 30 to 45 minutes when created'
Ensure 'vgw-hub' { Exists @('network', 'vnet-gateway', 'show', '-g', $rg, '-n', 'vgw-hub') } {
    Invoke-Az network vnet-gateway create -g $rg -n vgw-hub -l $loc --vnet $Demo.HubVnet --public-ip-addresses pip-vpngw `
        --gateway-type Vpn --vpn-type RouteBased --sku Basic --tags @($Demo.Tags) -o none }

Write-Step 'Local network gateway + IPsec connection'
Ensure "lng-site ($siteIp, $($Demo.SitePrefix))" { Exists @('network', 'local-gateway', 'show', '-g', $rg, '-n', 'lng-site') } {
    Invoke-Az network local-gateway create -g $rg -n lng-site -l $loc --gateway-ip-address $siteIp `
        --local-address-prefixes $Demo.SitePrefix --tags @($Demo.Tags) -o none }
if (-not (Test-Path $PskFile) -and -not $VerifyOnly) {
    $b = New-Object byte[] 30; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
    Set-Content -Path $PskFile -Value ([Convert]::ToBase64String($b) -replace '[+/=]', 'x') -NoNewline
    Write-Ok "pre-shared key generated -> $PskFile (keep it out of source control)"
}
Ensure 'cn-hub-site (IKEv2)' { Exists @('network', 'vpn-connection', 'show', '-g', $rg, '-n', 'cn-hub-site') } {
    Invoke-Az network vpn-connection create -g $rg -n cn-hub-site -l $loc --vnet-gateway1 vgw-hub --local-gateway2 lng-site `
        --shared-key (Get-Content $PskFile -Raw).Trim() --tags @($Demo.Tags) -o none }

if ($VerifyOnly) {
    $c = Invoke-Az network vpn-connection show -g $rg -n cn-hub-site -o json
    Write-Info "connection status: $($c.connectionStatus)  protocol: $($c.connectionProtocol)"
    Write-Host "`nVerify-only: $script:diffs missing item(s)" -ForegroundColor $(if ($script:diffs) { 'Yellow' } else { 'Green' })
}
