<#
    Step 11 - Cosmos DB for NoSQL (serverless, keyless, private).

    Creates:
      * account cosmos-iotmq-<suffix>: serverless, local (key) auth disabled,
        public network access disabled (Azure Policy enforces both anyway)
      * database iotmq with four containers
          telemetry   /deviceId  TTL 7 days   history written from the Kafka path
          devices     /deviceId  no TTL       device + certificate inventory
          tokens      /id        TTL 1 day    one-time enrolment tokens (hash only)
          certevents  /deviceId  TTL 30 days  issue / renew / revoke audit trail
      * private endpoint pe-cosmos in snet-pe + privatelink.documents.azure.com
        (linked to the hub VNet only)
      * data-plane roles scoped per container (least privilege)
          id-iotmq-app      -> telemetry (read/write), devices (read)
          id-iotmq-certsvc  -> devices, tokens, certevents (read/write)
#>
. "$PSScriptRoot\env.ps1"

$rg = $Demo.ResourceGroup
$account = $Demo.Cosmos
$db = $Demo.CosmosDb

Write-Step "Cosmos DB account $account (serverless, keyless, private) - takes 5-10 minutes"
$existing = & az cosmosdb show -g $rg -n $account --query id -o tsv 2>$null
if (-not $existing) {
    Invoke-Az cosmosdb create -g $rg -n $account `
        --locations regionName=$($Demo.Location) failoverPriority=0 isZoneRedundant=false `
        --capabilities EnableServerless --default-consistency-level Session `
        --disable-local-auth true --public-network-access DISABLED `
        --minimal-tls-version Tls12 --tags @($Demo.Tags) -o none | Out-Null
}
$acct = Invoke-Az cosmosdb show -g $rg -n $account -o json
Write-Ok "$account  localAuthDisabled=$($acct.disableLocalAuth)  publicNetworkAccess=$($acct.publicNetworkAccess)"

Write-Step "Database $db and containers"
& az cosmosdb sql database show -g $rg -a $account -n $db -o none 2>$null
if ($LASTEXITCODE -ne 0) { Invoke-Az cosmosdb sql database create -g $rg -a $account -n $db -o none | Out-Null }
$containers = @(
    @{ name = 'telemetry';  pk = '/deviceId'; ttl = 604800 },
    @{ name = 'devices';    pk = '/deviceId'; ttl = $null },
    @{ name = 'tokens';     pk = '/id';       ttl = 86400 },
    @{ name = 'certevents'; pk = '/deviceId'; ttl = 2592000 }
)
foreach ($c in $containers) {
    & az cosmosdb sql container show -g $rg -a $account -d $db -n $c.name -o none 2>$null
    if ($LASTEXITCODE -ne 0) {
        $azArgs = @('cosmosdb', 'sql', 'container', 'create', '-g', $rg, '-a', $account, '-d', $db, '-n', $c.name, '-p', $c.pk, '-o', 'none')
        if ($c.ttl) { $azArgs += @('--ttl', "$($c.ttl)") }
        Invoke-Az @azArgs | Out-Null
    }
    Write-Ok "$($c.name)  partition $($c.pk)  ttl $(if ($c.ttl) { "$($c.ttl) s" } else { 'none' })"
}

Write-Step 'Private endpoint + private DNS zone (hub VNet only)'
$zone = 'privatelink.documents.azure.com'
& az network private-dns zone show -g $rg -n $zone -o none 2>$null
if ($LASTEXITCODE -ne 0) { Invoke-Az network private-dns zone create -g $rg -n $zone --tags @($Demo.Tags) -o none | Out-Null }
& az network private-dns link vnet show -g $rg -z $zone -n link-hub -o none 2>$null
if ($LASTEXITCODE -ne 0) {
    Invoke-Az network private-dns link vnet create -g $rg -z $zone -n link-hub -v $Demo.HubVnet -e false --tags @($Demo.Tags) -o none | Out-Null
}
& az network private-endpoint show -g $rg -n pe-cosmos -o none 2>$null
if ($LASTEXITCODE -ne 0) {
    Invoke-Az network private-endpoint create -g $rg -n pe-cosmos -l $Demo.Location `
        --vnet-name $Demo.HubVnet --subnet $Demo.PeSubnet --private-connection-resource-id $acct.id `
        --group-id Sql --connection-name pe-cosmos-conn --nic-name pe-cosmos-nic --tags @($Demo.Tags) -o none | Out-Null
}
# 'dns-zone-group show' exits 0 even when the group does not exist, so check with 'list'.
$groups = @(Invoke-Az network private-endpoint dns-zone-group list -g $rg --endpoint-name pe-cosmos -o json)
if (-not ($groups | Where-Object { $_.name -eq 'default' })) {
    Invoke-Az network private-endpoint dns-zone-group create -g $rg --endpoint-name pe-cosmos -n default `
        --private-dns-zone $zone --zone-name documents -o none | Out-Null
}
$records = Invoke-Az network private-dns record-set a list -g $rg -z $zone -o json
foreach ($r in $records) { Write-Ok "$($r.name).$zone -> $($r.aRecords[0].ipv4Address)" }

Write-Step 'Data-plane roles (Cosmos DB Built-in Data Contributor / Reader), scoped per container'
$contributor = '00000000-0000-0000-0000-000000000002'
$reader      = '00000000-0000-0000-0000-000000000001'
$app  = (Invoke-Az identity show -g $rg -n $Demo.AppIdentity -o json).principalId
$cert = (Invoke-Az identity show -g $rg -n $Demo.CertIdentity -o json).principalId
$grants = @(
    @{ who = $app;  label = $Demo.AppIdentity;  role = $contributor; scope = "/dbs/$db/colls/telemetry" },
    @{ who = $app;  label = $Demo.AppIdentity;  role = $reader;      scope = "/dbs/$db/colls/devices" },
    @{ who = $cert; label = $Demo.CertIdentity; role = $contributor; scope = "/dbs/$db/colls/devices" },
    @{ who = $cert; label = $Demo.CertIdentity; role = $contributor; scope = "/dbs/$db/colls/tokens" },
    @{ who = $cert; label = $Demo.CertIdentity; role = $contributor; scope = "/dbs/$db/colls/certevents" }
)
$current = Invoke-Az cosmosdb sql role assignment list -g $rg -a $account -o json
foreach ($g in $grants) {
    $have = $current | Where-Object { $_.principalId -eq $g.who -and $_.scope -like "*$($g.scope)" -and $_.roleDefinitionId -like "*$($g.role)" }
    if (-not $have) {
        Invoke-Az cosmosdb sql role assignment create -g $rg -a $account --role-definition-id $g.role `
            --principal-id $g.who --scope $g.scope -o none | Out-Null
    }
    $roleName = if ($g.role -eq $contributor) { 'Data Contributor' } else { 'Data Reader' }
    Write-Ok "$($g.label) -> $roleName on $($g.scope)"
}
