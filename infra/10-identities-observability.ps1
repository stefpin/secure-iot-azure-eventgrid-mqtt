<#
    Step 10 - identities and observability.

    Creates:
      * two user-assigned managed identities (least privilege, one per workload)
          id-iotmq-app      operator web app (MQTT, Kafka, Cosmos telemetry)
          id-iotmq-certsvc  certificate service (Key Vault CA keys, Cosmos registry, MQTT renewals)
      * Log Analytics workspace (30-day retention)
      * workspace-based Application Insights with local (key) auth disabled,
        so telemetry is accepted only from Entra ID identities
      * Monitoring Metrics Publisher on Application Insights for both identities
#>
. "$PSScriptRoot\env.ps1"

$rg = $Demo.ResourceGroup

Write-Step 'Managed identities'
$ids = @{}
foreach ($name in $Demo.AppIdentity, $Demo.CertIdentity) {
    $id = Invoke-Az identity create -g $rg -n $name -l $Demo.Location --tags @($Demo.Tags) -o json
    $ids[$name] = $id
    Write-Ok "$name  principal $($id.principalId)  client $($id.clientId)"
}

Write-Step 'Log Analytics workspace'
$law = Invoke-Az monitor log-analytics workspace create -g $rg -n $Demo.LogAnalytics -l $Demo.Location `
    --retention-time 30 --sku PerGB2018 --tags @($Demo.Tags) -o json
Write-Ok "$($law.name)  customerId $($law.customerId)"

Write-Step 'Application Insights (workspace-based, Entra-only ingestion)'
$appiId = "$($Demo.RgId)/providers/Microsoft.Insights/components/$($Demo.AppInsights)"
$tags = @{}; foreach ($t in $Demo.Tags) { $k, $v = $t -split '=', 2; $tags[$k] = $v }
$body = @{
    location   = $Demo.Location
    kind       = 'web'
    tags       = $tags
    properties = @{
        Application_Type    = 'web'
        WorkspaceResourceId = $law.id
        IngestionMode       = 'LogAnalytics'
        DisableLocalAuth    = $true
        RetentionInDays     = 30
    }
}
$file = New-JsonFile $body
$appi = Invoke-Az rest --method put --url "https://management.azure.com$($appiId)?api-version=2020-02-02" --body "@$file" -o json
Remove-Item $file
Write-Ok "$($appi.name)  disableLocalAuth=$($appi.properties.DisableLocalAuth)"

Write-Step 'Monitoring Metrics Publisher for both identities on Application Insights'
foreach ($name in $ids.Keys) {
    Invoke-Az role assignment create --assignee-object-id $ids[$name].principalId --assignee-principal-type ServicePrincipal `
        --role 'Monitoring Metrics Publisher' --scope $appiId -o none | Out-Null
    Write-Ok "$name -> Monitoring Metrics Publisher"
}

Write-Host "`nConnection string (no key - Entra auth): $($appi.properties.ConnectionString)"
