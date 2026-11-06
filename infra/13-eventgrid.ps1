<#
    Step 13 - Event Grid MQTT broker: authorisation model.

    Devices and the site gateway authenticate with X.509 certificates and are
    authorised through client groups + permission bindings. The two cloud
    workloads authenticate with Microsoft Entra ID tokens (MQTT 5 enhanced
    authentication) and are authorised with Azure RBAC on topic spaces.

    Topic map ({site} = client attribute "site", {id} = authentication name)
      iot/telemetry/{site}/{id}          device -> cloud      QoS 1, routed to Event Hubs (Kafka)
      iot/status/{site}/{id}             device, RETAINED     online/offline + Last Will
      iot/state/{site}/{id}              device, RETAINED     profile, setpoint, certificate expiry
      iot/cmd/{site}/{id}/{method}       cloud  -> device     MQTT 5 request (response topic + correlation data)
      iot/cmdres/{site}/{id}             device -> cloud      MQTT 5 response
      iot/cert/{site}/{id}/req|res       device <-> certsvc   certificate renewal over MQTT
      iot/config/fleet                   cloud, RETAINED      fleet-wide settings every device gets on connect
      iot/site/{site}/sim/req|res        cloud <-> gateway    simulator control (demo only)

    Client groups:   cg-devices  (attributes.type = 'device')
                     cg-gateways (attributes.type = 'gateway')
    Topic spaces:    ts-dev-pub, ts-dev-sub, ts-gw-pub, ts-gw-sub   (certificate clients)
                     ts-app-pub, ts-app-sub, ts-certsvc             (Entra ID clients, RBAC)
#>
. "$PSScriptRoot\env.ps1"

$rg = $Demo.ResourceGroup
$ns = $Demo.EventGrid
$nsId = "$($Demo.RgId)/providers/Microsoft.EventGrid/namespaces/$ns"
$api = 'api-version=2025-02-15'
$base = "https://management.azure.com$nsId"

function Put-Child([string]$Path, $Properties) {
    $file = New-JsonFile @{ properties = $Properties }
    try { Invoke-Az rest --method put --url "$base/$($Path)?$api" --body "@$file" -o json }
    finally { Remove-Item $file -ErrorAction SilentlyContinue }
}

Write-Step 'Namespace: at most 2 sessions per authentication name'
# PATCH must re-send routing, enrichments and custom domains or they are dropped.
$current = Invoke-Az rest --method get --url "$($base)?$api" -o json
$tsc = $current.properties.topicSpacesConfiguration
$patch = @{ properties = @{ topicSpacesConfiguration = @{
    maximumClientSessionsPerAuthenticationName = 2
    maximumSessionExpiryInHours                = $tsc.maximumSessionExpiryInHours
    routeTopicResourceId                       = $tsc.routeTopicResourceId
    routingEnrichments                         = $tsc.routingEnrichments
    customDomains                              = @($tsc.customDomains | ForEach-Object {
        @{ fullyQualifiedDomainName = $_.fullyQualifiedDomainName; certificateUrl = $_.certificateUrl; identity = $_.identity }
    })
} } }
$file = New-JsonFile $patch
Invoke-Az rest --method patch --url "$($base)?$api" --body "@$file" -o none | Out-Null
Remove-Item $file
$after = (Invoke-Az rest --method get --url "$($base)?$api" -o json).properties.topicSpacesConfiguration
Write-Ok "sessions/auth name=$($after.maximumClientSessionsPerAuthenticationName)  session expiry=$($after.maximumSessionExpiryInHours) h  customDomain=$($after.customDomains[0].validationState)  enrichments=$($after.routingEnrichments.dynamic.Count)"

Write-Step 'Client groups'
$groups = @(
    @{ n = 'cg-devices';  q = "attributes.type = 'device'";  d = 'Simulated machines (X.509, one certificate per device)' },
    @{ n = 'cg-gateways'; q = "attributes.type = 'gateway'"; d = 'Site gateways / simulator controllers (X.509)' }
)
foreach ($g in $groups) {
    Put-Child "clientGroups/$($g.n)" @{ query = $g.q; description = $g.d } | Out-Null
    Write-Ok "$($g.n)  ($($g.q))"
}

Write-Step 'Topic spaces'
$c = '${client.attributes.site}/${client.authenticationName}'
$spaces = [ordered]@{
    'ts-dev-pub' = @("iot/telemetry/$c", "iot/status/$c", "iot/state/$c", "iot/cmdres/$c", "iot/cert/$c/req")
    'ts-dev-sub' = @("iot/cmd/$c/#", "iot/cert/$c/res", 'iot/config/fleet')
    'ts-gw-pub'  = @('iot/site/${client.attributes.site}/sim/res', "iot/status/$c", "iot/state/$c", "iot/cert/$c/req")
    'ts-gw-sub'  = @('iot/site/${client.attributes.site}/sim/req', 'iot/config/fleet', "iot/cert/$c/res")
    'ts-app-pub' = @('iot/cmd/#', 'iot/config/#', 'iot/site/+/sim/req', 'iot/status/#', 'iot/state/#')
    'ts-app-sub' = @('iot/telemetry/#', 'iot/status/#', 'iot/state/#', 'iot/cmdres/#', 'iot/site/+/sim/res', 'iot/config/#')
    'ts-certsvc' = @('iot/cert/+/+/req', 'iot/cert/+/+/res')
}
foreach ($name in $spaces.Keys) {
    $desc = switch -Wildcard ($name) {
        'ts-dev-*' { 'Devices (certificate auth, client group cg-devices)' }
        'ts-gw-*'  { 'Site gateways (certificate auth, client group cg-gateways)' }
        'ts-app-*' { 'Operator app (Entra ID auth, Azure RBAC)' }
        default    { 'Certificate service (Entra ID auth, Azure RBAC)' }
    }
    Put-Child "topicSpaces/$name" @{ topicTemplates = @($spaces[$name]); description = $desc } | Out-Null
    Write-Ok "$name  $($spaces[$name] -join '  ')"
}

Write-Step 'Permission bindings (certificate clients)'
$bindings = @(
    @{ n = 'pb-dev-pub'; g = 'cg-devices';  t = 'ts-dev-pub'; p = 'Publisher' },
    @{ n = 'pb-dev-sub'; g = 'cg-devices';  t = 'ts-dev-sub'; p = 'Subscriber' },
    @{ n = 'pb-gw-pub';  g = 'cg-gateways'; t = 'ts-gw-pub';  p = 'Publisher' },
    @{ n = 'pb-gw-sub';  g = 'cg-gateways'; t = 'ts-gw-sub';  p = 'Subscriber' }
)
foreach ($b in $bindings) {
    Put-Child "permissionBindings/$($b.n)" @{ clientGroupName = $b.g; topicSpaceName = $b.t; permission = $b.p } | Out-Null
    Write-Ok "$($b.n)  $($b.g) -> $($b.t) ($($b.p))"
}

Write-Step 'Azure RBAC for the Entra ID clients'
$app  = (Invoke-Az identity show -g $rg -n $Demo.AppIdentity -o json).principalId
$cert = (Invoke-Az identity show -g $rg -n $Demo.CertIdentity -o json).principalId
$kvId = "$($Demo.RgId)/providers/Microsoft.KeyVault/vaults/$($Demo.KeyVault)"
$ehId = "$($Demo.RgId)/providers/Microsoft.EventHub/namespaces/$($Demo.EventHubs)"
$grants = @(
    @{ who = $app;  l = $Demo.AppIdentity;  r = 'EventGrid TopicSpaces Publisher';  s = "$nsId/topicSpaces/ts-app-pub" },
    @{ who = $app;  l = $Demo.AppIdentity;  r = 'EventGrid TopicSpaces Subscriber'; s = "$nsId/topicSpaces/ts-app-sub" },
    @{ who = $app;  l = $Demo.AppIdentity;  r = 'Reader';                           s = $nsId },
    @{ who = $app;  l = $Demo.AppIdentity;  r = 'Azure Event Hubs Data Receiver';   s = $ehId },
    @{ who = $cert; l = $Demo.CertIdentity; r = 'EventGrid TopicSpaces Publisher';  s = "$nsId/topicSpaces/ts-certsvc" },
    @{ who = $cert; l = $Demo.CertIdentity; r = 'EventGrid TopicSpaces Subscriber'; s = "$nsId/topicSpaces/ts-certsvc" },
    @{ who = $cert; l = $Demo.CertIdentity; r = 'EventGrid Contributor';            s = $nsId }
)
foreach ($g in $grants) {
    Assert-DemoScope $g.s
    Invoke-Az role assignment create --assignee-object-id $g.who --assignee-principal-type ServicePrincipal `
        --role $g.r --scope $g.s -o none | Out-Null
    Write-Ok "$($g.l) -> $($g.r) on $(($g.s -split '/')[-1])"
}
