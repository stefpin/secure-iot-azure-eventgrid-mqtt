<#
    Step 12 - the two virtual machines.

    vm-ops   hub VNet, 10.40.1.10, B2als_v2, Ubuntu 24.04, Trusted Launch,
             user-assigned identities id-iotmq-app + id-iotmq-certsvc,
             public IP only as the Front Door origin (port 80, Front Door only)
    vm-site1 site VNet, 10.50.1.10, B2als_v2, Ubuntu 24.04, Trusted Launch,
             no Azure identity at all - the devices it simulates authenticate
             with X.509 certificates only. It takes over the PoC site VM's
             public IP (the VPN peer address) in step 13.

    NSG rules (nsg-app, subnet level):
      Allow-Site-DNS        10.50.0.0/16 -> 10.40.1.10 TCP/UDP 53  (hub DNS forwarder)
      Allow-Site-Enroll     10.50.0.0/16 -> 10.40.1.10 TCP 443     (certificate enrolment)
      Allow-FrontDoor-HTTP  AzureFrontDoor.Backend -> 10.40.1.10 TCP 80
#>
. "$PSScriptRoot\env.ps1"

$rg = $Demo.ResourceGroup
$loc = $Demo.Location
$image = 'Canonical:ubuntu-24_04-lts:server:latest'
$size = 'Standard_B2als_v2'

Write-Step 'NSG rules on nsg-app'
$rules = @(
    @{ n = 'Allow-Site-DNS';       p = 200; src = $Demo.SitePrefix;          proto = '*';   port = '53' },
    @{ n = 'Allow-Site-Enroll';    p = 210; src = $Demo.SitePrefix;          proto = 'Tcp'; port = '443' },
    @{ n = 'Allow-FrontDoor-HTTP'; p = 220; src = 'AzureFrontDoor.Backend'; proto = 'Tcp'; port = '80' }
)
foreach ($r in $rules) {
    Invoke-Az network nsg rule create -g $rg --nsg-name nsg-app -n $r.n --priority $r.p --direction Inbound --access Allow `
        --protocol $r.proto --source-address-prefixes $r.src --source-port-ranges '*' `
        --destination-address-prefixes $Demo.OpsVmIp --destination-port-ranges $r.port -o none | Out-Null
    Write-Ok "$($r.n)  $($r.src) -> $($Demo.OpsVmIp):$($r.port)/$($r.proto)"
}

Write-Step 'Public IP for the Front Door origin (vm-ops)'
& az network public-ip show -g $rg -n pip-ops -o none 2>$null
if ($LASTEXITCODE -ne 0) {
    Invoke-Az network public-ip create -g $rg -n pip-ops -l $loc --sku Standard --allocation-method Static `
        --dns-name "ops-iotmq-$($Demo.Suffix)" --tags @($Demo.Tags) -o none | Out-Null
}
$pip = Invoke-Az network public-ip show -g $rg -n pip-ops -o json
Write-Ok "pip-ops  $($pip.ipAddress)  $($pip.dnsSettings.fqdn)"

Write-Step 'vm-ops'
& az network nic show -g $rg -n nic-vm-ops -o none 2>$null
if ($LASTEXITCODE -ne 0) {
    Invoke-Az network nic create -g $rg -n nic-vm-ops -l $loc --vnet-name $Demo.HubVnet --subnet $Demo.AppSubnet `
        --private-ip-address $Demo.OpsVmIp --public-ip-address pip-ops --tags @($Demo.Tags) -o none | Out-Null
}
$appId  = (Invoke-Az identity show -g $rg -n $Demo.AppIdentity -o json).id
$certId = (Invoke-Az identity show -g $rg -n $Demo.CertIdentity -o json).id
& az vm show -g $rg -n $Demo.OpsVm -o none 2>$null
if ($LASTEXITCODE -ne 0) {
    Invoke-Az vm create -g $rg -n $Demo.OpsVm -l $loc --image $image --size $size --nics nic-vm-ops `
        --admin-username azureuser --generate-ssh-keys --authentication-type ssh `
        --security-type TrustedLaunch --enable-secure-boot true --enable-vtpm true `
        --storage-sku StandardSSD_LRS --os-disk-name osdisk-vm-ops --os-disk-size-gb 32 `
        --assign-identity $appId $certId --custom-data "$PSScriptRoot\cloud-init-ops.yaml" `
        --tags @($Demo.Tags) -o none | Out-Null
}
Write-Ok "$($Demo.OpsVm) created ($size, $($Demo.OpsVmIp))"

Write-Step 'vm-site1 (no public IP yet - it takes over pip-site in step 13)'
& az network nic show -g $rg -n nic-vm-site1 -o none 2>$null
if ($LASTEXITCODE -ne 0) {
    Invoke-Az network nic create -g $rg -n nic-vm-site1 -l $loc --vnet-name $Demo.SiteVnet --subnet $Demo.SiteSubnet `
        --private-ip-address $Demo.SiteVmIp --tags @($Demo.Tags) -o none | Out-Null
}
& az vm show -g $rg -n $Demo.SiteVm -o none 2>$null
if ($LASTEXITCODE -ne 0) {
    Invoke-Az vm create -g $rg -n $Demo.SiteVm -l $loc --image $image --size $size --nics nic-vm-site1 `
        --admin-username azureuser --generate-ssh-keys --authentication-type ssh `
        --security-type TrustedLaunch --enable-secure-boot true --enable-vtpm true `
        --storage-sku StandardSSD_LRS --os-disk-name osdisk-vm-site1 --os-disk-size-gb 32 `
        --custom-data "$PSScriptRoot\cloud-init-site.yaml" --tags @($Demo.Tags) -o none | Out-Null
}
Write-Ok "$($Demo.SiteVm) created ($size, $($Demo.SiteVmIp))"

Write-Step "Private DNS: enroll.$($Demo.Zone) -> $($Demo.OpsVmIp)"
& az network private-dns record-set a show -g $rg -z $Demo.Zone -n enroll -o none 2>$null
if ($LASTEXITCODE -ne 0) {
    Invoke-Az network private-dns record-set a add-record -g $rg -z $Demo.Zone -n enroll -a $Demo.OpsVmIp -o none | Out-Null
}
Write-Ok "enroll.$($Demo.Zone) A $($Demo.OpsVmIp) (private zone only - never published)"
