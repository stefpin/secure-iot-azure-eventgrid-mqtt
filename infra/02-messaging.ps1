<#
    Step 02 - messaging: Event Grid namespace (MQTT broker + routing) and Event Hubs (Kafka).

      egns-iotmq-<sfx>  Standard, 1 TU, MQTT enabled, system identity, public access = selected IPs
                        (placeholder 192.0.2.1/32: devices never use the public endpoint), max session
                        expiry 1 h; namespace topic mqtt-routed (CloudEvents 1.0, 7 days); MQTT routing to
                        it with dynamic enrichments site / profile / client
      ehns-iotmq-<sfx>  Standard, 1 TU, Kafka endpoint, local (SAS) auth disabled, public access disabled
                        (trusted Microsoft services allowed), hubs telemetry + alerts (2 partitions, 1 day)
      push subscriptions es-telemetry (subject begins with iot/telemetry/) and es-alerts (+ data.temperature
                        > 75) deliver to Event Hubs with the namespace's managed identity
      private endpoints pe-eg-mqtt (topicSpace) and pe-eh (namespace) in snet-pe + their private DNS zones
    -VerifyOnly  change nothing; report what exists
#>
param([switch]$VerifyOnly)
. "$PSScriptRoot\env.ps1"
$rg = $Demo.ResourceGroup; $loc = $Demo.Location; $api = 'api-version=2025-02-15'
$nsId = "$($Demo.RgId)/providers/Microsoft.EventGrid/namespaces/$($Demo.EventGrid)"
$ehId = "$($Demo.RgId)/providers/Microsoft.EventHub/namespaces/$($Demo.EventHubs)"
$tags = @{}; foreach ($t in $Demo.Tags) { $k, $v = $t -split '=', 2; $tags[$k] = $v }
$script:diffs = 0
function Put([string]$Url, $Body) { $f = New-JsonFile $Body; try { Invoke-Az rest --method put --url $Url --body "@$f" -o json } finally { Remove-Item $f } }
function Get-Arm([string]$Url) { $r = & az rest --method get --url $Url -o json 2>$null; if ($LASTEXITCODE -eq 0) { $r | ConvertFrom-Json } }
function Step([string]$What, $Current, [scriptblock]$Create) {
    if ($Current) { Write-Ok "$What (exists)"; return }
    if ($VerifyOnly) { Write-Host "   !!  $What MISSING" -ForegroundColor Yellow; $script:diffs++; return }
    & $Create | Out-Null; Write-Ok "$What (created)"
}

Write-Step "Event Grid namespace $($Demo.EventGrid)"
Step 'namespace (Standard 1 TU, MQTT, selected IPs)' (Get-Arm "https://management.azure.com$($nsId)?$api") {
    Put "https://management.azure.com$($nsId)?$api" @{ location = $loc; tags = $tags; sku = @{ name = 'Standard'; capacity = 1 }
        identity = @{ type = 'SystemAssigned' }
        properties = @{ publicNetworkAccess = 'Enabled'; inboundIpRules = @(@{ ipMask = '192.0.2.1/32'; action = 'Allow' })
            topicSpacesConfiguration = @{ state = 'Enabled'; maximumSessionExpiryInHours = 1; maximumClientSessionsPerAuthenticationName = 2 } } }
}
Step 'namespace topic mqtt-routed' (Get-Arm "https://management.azure.com$nsId/topics/mqtt-routed?$api") {
    Put "https://management.azure.com$nsId/topics/mqtt-routed?$api" @{ properties = @{ inputSchema = 'CloudEventSchemaV1_0'; publisherType = 'Custom'; eventRetentionInDays = 7 } }
}
$ns = Get-Arm "https://management.azure.com$($nsId)?$api"
Step 'MQTT routing -> mqtt-routed with enrichments' ($ns -and $ns.properties.topicSpacesConfiguration.routeTopicResourceId) {
    $f = New-JsonFile @{ properties = @{ topicSpacesConfiguration = @{ routeTopicResourceId = "$nsId/topics/mqtt-routed"
        routingEnrichments = @{ dynamic = @(@{ key = 'site'; value = '${client.attributes.site}' }, @{ key = 'profile'; value = '${client.attributes.profile}' },
                                            @{ key = 'client'; value = '${client.authenticationName}' }) } } } }
    Invoke-Az rest --method patch --url "https://management.azure.com$($nsId)?$api" --body "@$f" -o none; Remove-Item $f
}

Write-Step "Event Hubs $($Demo.EventHubs) (Kafka)"
Step 'namespace (Standard, Kafka, no SAS, private)' (Get-Arm "https://management.azure.com$($ehId)?api-version=2024-01-01") {
    Put "https://management.azure.com$($ehId)?api-version=2024-01-01" @{ location = $loc; tags = $tags; sku = @{ name = 'Standard'; tier = 'Standard'; capacity = 1 }
        properties = @{ kafkaEnabled = $true; disableLocalAuth = $true; publicNetworkAccess = 'Disabled'; minimumTlsVersion = '1.2' } }
    Put "https://management.azure.com$ehId/networkRuleSets/default?api-version=2024-01-01" @{ properties = @{ defaultAction = 'Deny'; publicNetworkAccess = 'Disabled'; trustedServiceAccessEnabled = $true } }
}
foreach ($hub in 'telemetry', 'alerts') {
    Step "event hub / Kafka topic $hub" (Get-Arm "https://management.azure.com$ehId/eventhubs/$($hub)?api-version=2024-01-01") {
        Put "https://management.azure.com$ehId/eventhubs/$($hub)?api-version=2024-01-01" @{ properties = @{ partitionCount = 2; messageRetentionInDays = 1 } }
    }
}
$nsPrincipal = (Get-Arm "https://management.azure.com$($nsId)?$api").identity.principalId
if (-not $VerifyOnly -and $nsPrincipal) {
    Invoke-Az role assignment create --assignee-object-id $nsPrincipal --assignee-principal-type ServicePrincipal `
        --role 'Azure Event Hubs Data Sender' --scope $ehId -o none | Out-Null
    Write-Ok 'namespace identity -> Azure Event Hubs Data Sender'
}

Write-Step 'Push subscriptions (managed identity delivery to Event Hubs)'
$subs = @(
    @{ n = 'es-telemetry'; hub = 'telemetry'; filters = @(@{ key = 'subject'; operatorType = 'StringBeginsWith'; values = @('iot/telemetry/') }) },
    @{ n = 'es-alerts'; hub = 'alerts'; filters = @(@{ key = 'subject'; operatorType = 'StringBeginsWith'; values = @('iot/telemetry/') },
                                                    @{ key = 'data.temperature'; operatorType = 'NumberGreaterThan'; value = 75 }) }
)
foreach ($s in $subs) {
    Step "$($s.n) -> $($s.hub)" (Get-Arm "https://management.azure.com$nsId/topics/mqtt-routed/eventSubscriptions/$($s.n)?$api") {
        Put "https://management.azure.com$nsId/topics/mqtt-routed/eventSubscriptions/$($s.n)?$api" @{ properties = @{
            eventDeliverySchema = 'CloudEventSchemaV1_0'; filtersConfiguration = @{ filters = $s.filters }
            deliveryConfiguration = @{ deliveryMode = 'Push'; push = @{ maxDeliveryCount = 10; eventTimeToLive = 'P1D'
                deliveryWithResourceIdentity = @{ identity = @{ type = 'SystemAssigned' }
                    destination = @{ endpointType = 'EventHub'; properties = @{ resourceId = "$ehId/eventhubs/$($s.hub)" } } } } } } }
    }
}

Write-Step 'Private endpoints + private DNS zones (hub VNet only)'
$pes = @(
    @{ n = 'pe-eg-mqtt'; id = $nsId; g = 'topicSpace'; zone = 'privatelink.ts.eventgrid.azure.net' },
    @{ n = 'pe-eh'; id = $ehId; g = 'namespace'; zone = 'privatelink.servicebus.windows.net' }
)
foreach ($pe in $pes) {
    Step "private DNS zone $($pe.zone)" (Get-Arm "https://management.azure.com$($Demo.RgId)/providers/Microsoft.Network/privateDnsZones/$($pe.zone)?api-version=2024-06-01") {
        Invoke-Az network private-dns zone create -g $rg -n $pe.zone --tags @($Demo.Tags) -o none
        Invoke-Az network private-dns link vnet create -g $rg -z $pe.zone -n link-hub -v $Demo.HubVnet -e false --tags @($Demo.Tags) -o none
    }
    Step "$($pe.n) ($($pe.g))" (Get-Arm "https://management.azure.com$($Demo.RgId)/providers/Microsoft.Network/privateEndpoints/$($pe.n)?api-version=2024-05-01") {
        Invoke-Az network private-endpoint create -g $rg -n $pe.n -l $loc --vnet-name $Demo.HubVnet --subnet $Demo.PeSubnet `
            --private-connection-resource-id $pe.id --group-id $pe.g --connection-name "$($pe.n)-conn" --tags @($Demo.Tags) -o none
        Invoke-Az network private-endpoint dns-zone-group create -g $rg --endpoint-name $pe.n -n default --private-dns-zone $pe.zone --zone-name ($pe.zone -replace '\.', '-') -o none
    }
}
if ($VerifyOnly) { Write-Host "`nVerify-only: $script:diffs missing item(s)" -ForegroundColor $(if ($script:diffs) { 'Yellow' } else { 'Green' }) }
