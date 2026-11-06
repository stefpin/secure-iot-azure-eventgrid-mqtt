<#
    Step 20 - observability for the IT / platform team.

      * diagnostic settings -> law-iotmq-<suffix> for Event Grid, Event Hubs, Key Vault,
        Cosmos DB, VPN gateway and Front Door (resource-specific tables where supported)
      * Azure Managed Grafana (Standard) with a system-assigned identity that can only READ
        monitoring data of this resource group (Monitoring Reader); Grafana Admin for -AdminObjectId
      * action group (email) + metric and log alert rules
#>
param(
    [Parameter(Mandatory)][string]$AlertEmail,
    [Parameter(Mandatory)][string]$AdminObjectId
)
. "$PSScriptRoot\env.ps1"
$rg = $Demo.ResourceGroup
$p = "$($Demo.RgId)/providers"
$law = Invoke-Az monitor log-analytics workspace show -g $rg -n $Demo.LogAnalytics -o json
$tags = @{}; foreach ($t in $Demo.Tags) { $k, $v = $t -split '=', 2; $tags[$k] = $v }

Write-Step 'Diagnostic settings -> Log Analytics'
$targets = @(
    @{ n = 'Event Grid namespace'; id = "$p/Microsoft.EventGrid/namespaces/$($Demo.EventGrid)";
       logs = @('SuccessfulMqttConnections', 'FailedMqttConnections', 'MqttDisconnections', 'FailedMqttPublishedMessages', 'FailedMqttSubscriptionOperations') },
    @{ n = 'Event Hubs'; id = "$p/Microsoft.EventHub/namespaces/$($Demo.EventHubs)"; group = 'allLogs' },
    @{ n = 'Key Vault'; id = "$p/Microsoft.KeyVault/vaults/$($Demo.KeyVault)"; group = 'audit' },
    @{ n = 'Cosmos DB'; id = "$p/Microsoft.DocumentDB/databaseAccounts/$($Demo.Cosmos)"; logs = @('ControlPlaneRequests') },
    @{ n = 'VPN gateway'; id = "$p/Microsoft.Network/virtualNetworkGateways/vgw-hub"; group = 'allLogs' },
    @{ n = 'Front Door'; id = "$p/Microsoft.Cdn/profiles/$($Demo.FrontDoor)"; group = 'allLogs' }
)
foreach ($t in $targets) {
    $logs = @(if ($t.group) { @{ categoryGroup = $t.group; enabled = $true } } else { $t.logs | ForEach-Object { @{ category = $_; enabled = $true } } })
    $body = @{ properties = @{ workspaceId = $law.id; logAnalyticsDestinationType = 'Dedicated'; logs = $logs;
                               metrics = @(@{ category = 'AllMetrics'; enabled = $true }) } }
    $file = New-JsonFile $body
    Invoke-Az rest --method put --url "https://management.azure.com$($t.id)/providers/Microsoft.Insights/diagnosticSettings/to-law?api-version=2021-05-01-preview" --body "@$file" -o none | Out-Null
    Remove-Item $file
    Write-Ok "$($t.n)  ($(if ($t.group) { $t.group } else { $t.logs -join ', ' }) + metrics)"
}

Write-Step "Azure Managed Grafana $($Demo.Grafana) (Standard)"
$gid = "$p/Microsoft.Dashboard/grafana/$($Demo.Grafana)"
$body = @{
    location   = $Demo.Location
    tags       = $tags
    sku        = @{ name = 'Standard' }
    identity   = @{ type = 'SystemAssigned' }
    properties = @{ publicNetworkAccess = 'Enabled'; zoneRedundancy = 'Disabled'; apiKey = 'Disabled'; deterministicOutboundIP = 'Disabled' }
}
$file = New-JsonFile $body
Invoke-Az rest --method put --url "https://management.azure.com$($gid)?api-version=2026-09-01" --body "@$file" -o none | Out-Null
Remove-Item $file
for ($i = 0; $i -lt 60; $i++) {
    $g = Invoke-Az rest --method get --url "https://management.azure.com$($gid)?api-version=2026-09-01" -o json
    if ($g.properties.provisioningState -in 'Succeeded', 'Failed') { break }
    Start-Sleep 15
}
if ($g.properties.provisioningState -ne 'Succeeded') { throw "Grafana provisioning: $($g.properties.provisioningState)" }
Write-Ok "$($g.properties.endpoint)  Grafana $($g.properties.grafanaVersion)"

Write-Step 'Grafana roles'
Invoke-Az role assignment create --assignee-object-id $g.identity.principalId --assignee-principal-type ServicePrincipal `
    --role 'Monitoring Reader' --scope $Demo.RgId -o none | Out-Null
Write-Ok 'Grafana identity -> Monitoring Reader on the resource group (read-only metrics and logs)'
Invoke-Az role assignment create --assignee-object-id $AdminObjectId --assignee-principal-type User `
    --role 'Grafana Admin' --scope $gid -o none | Out-Null
Write-Ok 'you -> Grafana Admin on this Grafana instance only'

Write-Step "Action group (email $AlertEmail)"
$agId = "$p/Microsoft.Insights/actionGroups/ag-iotmq-ops"
$body = @{ location = 'Global'; tags = $tags; properties = @{ groupShortName = 'iotmq-ops'; enabled = $true;
    emailReceivers = @(@{ name = 'platform-team'; emailAddress = $AlertEmail; useCommonAlertSchema = $true }) } }
$file = New-JsonFile $body
Invoke-Az rest --method put --url "https://management.azure.com$($agId)?api-version=2023-01-01" --body "@$file" -o none | Out-Null
Remove-Item $file
Write-Ok 'ag-iotmq-ops'

Write-Step 'Metric alert rules'
$metricAlerts = @(
    @{ n = 'iotmq-routing-failures';  res = "$p/Microsoft.EventGrid/namespaces/$($Demo.EventGrid)"; ns = 'Microsoft.EventGrid/namespaces'; m = 'Mqtt.FailedRoutedMessages'; agg = 'Total'; op = 'GreaterThan'; th = 0; sev = 2; d = 'MQTT messages failed to route to the namespace topic' },
    @{ n = 'iotmq-mqtt-throttling';   res = "$p/Microsoft.EventGrid/namespaces/$($Demo.EventGrid)"; ns = 'Microsoft.EventGrid/namespaces'; m = 'Mqtt.ThrottlingEnforcements'; agg = 'Total'; op = 'GreaterThan'; th = 0; sev = 2; d = 'The MQTT broker is throttling clients - check throughput units' },
    @{ n = 'iotmq-publish-failures';  res = "$p/Microsoft.EventGrid/namespaces/$($Demo.EventGrid)"; ns = 'Microsoft.EventGrid/namespaces'; m = 'Mqtt.FailedPublishedMessages'; agg = 'Total'; op = 'GreaterThan'; th = 10; sev = 3; d = 'More than 10 failed MQTT publishes in 5 minutes (authorisation or quota)' },
    @{ n = 'iotmq-eventhubs-throttled'; res = "$p/Microsoft.EventHub/namespaces/$($Demo.EventHubs)"; ns = 'Microsoft.EventHub/namespaces'; m = 'ThrottledRequests'; agg = 'Total'; op = 'GreaterThan'; th = 0; sev = 2; d = 'Event Hubs is throttling - the Kafka path may lag' },
    @{ n = 'iotmq-vpn-tunnel-idle';   res = "$p/Microsoft.Network/virtualNetworkGateways/vgw-hub"; ns = 'Microsoft.Network/virtualNetworkGateways'; m = 'TunnelIngressBytes'; agg = 'Total'; op = 'LessThan'; th = 1; sev = 1; d = 'No traffic from the mine site through the VPN for 15 minutes - tunnel down?'; win = 'PT15M' },
    @{ n = 'iotmq-frontdoor-origin';  res = "$p/Microsoft.Cdn/profiles/$($Demo.FrontDoor)"; ns = 'Microsoft.Cdn/profiles'; m = 'OriginHealthPercentage'; agg = 'Average'; op = 'LessThan'; th = 100; sev = 2; d = 'The operator app origin (vm-ops) is unhealthy behind Front Door' }
)
foreach ($a in $metricAlerts) {
    $win = if ($a.win) { $a.win } else { 'PT5M' }
    $body = @{ location = 'global'; tags = $tags; properties = @{
        description = $a.d; severity = $a.sev; enabled = $true; scopes = @($a.res); evaluationFrequency = 'PT5M'; windowSize = $win
        criteria = @{ 'odata.type' = 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'; allOf = @(@{
            criterionType = 'StaticThresholdCriterion'; name = 'c1'; metricName = $a.m; metricNamespace = $a.ns
            operator = $a.op; threshold = $a.th; timeAggregation = $a.agg }) }
        autoMitigate = $true; actions = @(@{ actionGroupId = $agId }) } }
    $file = New-JsonFile $body
    Invoke-Az rest --method put --url "https://management.azure.com$p/Microsoft.Insights/metricAlerts/$($a.n)?api-version=2018-03-01" --body "@$file" -o none | Out-Null
    Remove-Item $file
    Write-Ok "$($a.n)  ($($a.m) $($a.op) $($a.th), sev $($a.sev))"
}

Write-Step 'Log alert rules (certificate service telemetry, workspace-based Application Insights tables)'
$logAlerts = @(
    @{ n = 'iotmq-cert-refusals'; sev = 2; d = 'More than 5 certificate requests refused in 15 minutes (revoked device, bad token or attack)';
       q = "AppTraces | where Message == 'cert.refused' | summarize n = count()"; op = 'GreaterThan'; th = 5 },
    @{ n = 'iotmq-server-cert-expiring'; sev = 1; d = 'The MQTT endpoint certificate served by Event Grid has less than 2 days left - automatic rotation is not working';
       q = "AppMetrics | where Name == 'iot_server_cert_days_left' | summarize days = min(Min)"; op = 'LessThan'; th = 2; metric = 'days' },
    @{ n = 'iotmq-certsvc-silent'; sev = 2; d = 'The certificate service sent no telemetry for 30 minutes - is iot-certsvc running on vm-ops?';
       q = "AppMetrics | where AppRoleName == 'iot-certsvc' | summarize n = count()"; op = 'LessThan'; th = 1; win = 'PT30M' }
)
foreach ($a in $logAlerts) {
    $win = if ($a.win) { $a.win } else { 'PT15M' }
    $crit = @{ query = $a.q; timeAggregation = 'Count'; operator = $a.op; threshold = $a.th;
               failingPeriods = @{ numberOfEvaluationPeriods = 1; minFailingPeriodsToAlert = 1 } }
    if ($a.metric) { $crit.timeAggregation = 'Minimum'; $crit.metricMeasureColumn = $a.metric }
    elseif ($a.q -match 'n = count') { $crit.timeAggregation = 'Total'; $crit.metricMeasureColumn = 'n' }
    $body = @{ location = $Demo.Location; tags = $tags; kind = 'LogAlert'; properties = @{
        displayName = $a.n; description = $a.d; severity = $a.sev; enabled = $true; scopes = @($law.id)
        evaluationFrequency = 'PT5M'; windowSize = $win; criteria = @{ allOf = @($crit) }; autoMitigate = $true
        actions = @{ actionGroups = @($agId) } } }
    $file = New-JsonFile $body
    Invoke-Az rest --method put --url "https://management.azure.com$p/Microsoft.Insights/scheduledQueryRules/$($a.n)?api-version=2023-12-01" --body "@$file" -o none | Out-Null
    Remove-Item $file
    Write-Ok "$($a.n)  (sev $($a.sev))"
}
