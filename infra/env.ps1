<#
    Shared settings for every build script of the Contoso Event Grid MQTT demo.
    Dot-source it:  . .\env.ps1

    Every resource lives in ONE resource group. The scripts never touch any
    other resource group.
#>

# 'Continue' because Windows PowerShell turns any az warning on stderr into a terminating
# error under 'Stop'. Failures are still fatal: Invoke-Az throws on a non-zero exit code.
$ErrorActionPreference = 'Continue'

$Demo = [ordered]@{
    # The subscription to deploy into: $env:IOT_SUBSCRIPTION_ID, or the one 'az login' selected.
    SubscriptionId = $(if ($env:IOT_SUBSCRIPTION_ID) { $env:IOT_SUBSCRIPTION_ID } else { (& az account show --query id -o tsv 2>$null) })
    ResourceGroup  = 'rg-iotmqtt-demo'
    Location       = 'indonesiacentral'   # any region with the Event Grid MQTT broker and Key Vault Premium
    # Five characters that make the global names (Key Vault, Cosmos DB, Event Grid, ...) unique: set
    # $env:IOT_SUFFIX, or leave it empty and it is derived from the subscription and resource group.
    Suffix         = $env:IOT_SUFFIX
    Site           = 'site1'

    # Tags written on every resource the scripts create. CostControl=Ignore is an example governance
    # tag (23-tag-sweep.ps1 and test A01 check it); adapt the list to your organisation.
    Tags           = @('CostControl=Ignore', 'purpose=iot-eventgrid-mqtt-demo')

    # A public DNS zone you control (03-keyvault-dns.ps1 creates it in Azure DNS; delegate it from your
    # registrar - this build used a subdomain delegated from Cloudflare). Change all four names.
    Zone           = 'iot.example.com'
    MqttHost       = 'mqtt.iot.example.com'
    EnrollHost     = 'enroll.iot.example.com'
    OpsHost        = 'ops.iot.example.com'

    # Networks
    HubVnet        = 'vnet-hub'
    SiteVnet       = 'vnet-site'
    AppSubnet      = 'snet-app'
    PeSubnet       = 'snet-pe'
    SiteSubnet     = 'snet-site'
    SitePrefix     = '10.50.0.0/16'
    OpsVmIp        = '10.40.1.10'
    SiteVmIp       = '10.50.1.10'
}

if (-not $Demo.SubscriptionId) { throw "Sign in with 'az login' or set `$env:IOT_SUBSCRIPTION_ID." }
if (-not $Demo.Suffix) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $hash = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes("$($Demo.SubscriptionId)/$($Demo.ResourceGroup)".ToLowerInvariant()))
    $Demo.Suffix = (-join ($hash[0..2] | ForEach-Object { $_.ToString('x2') })).Substring(0, 5)
}

$Demo.EventGrid   = "egns-iotmq-$($Demo.Suffix)"
$Demo.EventHubs   = "ehns-iotmq-$($Demo.Suffix)"
$Demo.KeyVault    = "kv-iotmq-$($Demo.Suffix)"
$Demo.Cosmos      = "cosmos-iotmq-$($Demo.Suffix)"
$Demo.LogAnalytics = "law-iotmq-$($Demo.Suffix)"
$Demo.AppInsights = "appi-iotmq-$($Demo.Suffix)"
$Demo.Grafana     = "amg-iotmq-$($Demo.Suffix)"
$Demo.FrontDoor   = "afd-iotmq-$($Demo.Suffix)"
$Demo.AppIdentity = 'id-iotmq-app'
$Demo.CertIdentity = 'id-iotmq-certsvc'
$Demo.OpsVm       = 'vm-ops'
$Demo.SiteVm      = 'vm-site1'
$Demo.CosmosDb    = 'iotmq'

$Demo.RgId = "/subscriptions/$($Demo.SubscriptionId)/resourceGroups/$($Demo.ResourceGroup)"

function Write-Step([string]$Text) { Write-Host "`n== $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text)   { Write-Host "   OK  $Text" -ForegroundColor Green }
function Write-Info([string]$Text) { Write-Host "   ..  $Text" -ForegroundColor Gray }

<#
    Runs az, returns parsed JSON (or raw text with -Raw) and throws on failure.
    Arguments are passed as an array, so nothing is re-parsed by cmd.exe.
#>
function Invoke-Az {
    # No param block on purpose: every token (including -g, -o) is passed to az untouched.
    $AzArgs = @($args | ForEach-Object { $_ })
    $raw = $false
    if ($AzArgs[0] -eq '-Raw') { $raw = $true; $AzArgs = $AzArgs[1..($AzArgs.Count - 1)] }
    # Windows PowerShell turns native stderr lines into terminating errors under 'Stop';
    # az writes warnings there, so collect them and decide on the exit code instead.
    $ErrorActionPreference = 'Continue'
    $output = & az @AzArgs 2>&1
    $code = $LASTEXITCODE
    $stdout = ($output | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n"
    $stderr = ($output | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] }) -join "`n"
    if ($code -ne 0) { throw "az $($AzArgs -join ' ') failed ($code):`n$stderr" }
    if ($raw -or -not $stdout.Trim()) { return $stdout }
    # Assign first: Windows PowerShell's ConvertFrom-Json emits a JSON array as ONE
    # object; returning the variable lets PowerShell unroll it for the caller.
    try { $parsed = $stdout | ConvertFrom-Json } catch { return $stdout }
    return $parsed
}

<# True if a resource of the given type/name already exists in the demo resource group. #>
function Test-DemoResource([string]$Type, [string]$Name) {
    $found = & az resource list -g $Demo.ResourceGroup --resource-type $Type --query "[?name=='$Name'].id" -o tsv 2>$null
    return [bool]$found
}

<# Writes a JSON body to a temp file (UTF-8, no BOM) and returns the path for az --body @file. #>
function New-JsonFile($Object, [int]$Depth = 20) {
    $path = Join-Path $env:TEMP ("iotmq-" + [guid]::NewGuid().ToString('N') + '.json')
    $json = if ($Object -is [string]) { $Object } else { $Object | ConvertTo-Json -Depth $Depth }
    [IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
    return $path
}

<# Guard: refuse to run against any other resource group. #>
function Assert-DemoScope([string]$ResourceId) {
    if ($ResourceId -and ($ResourceId -notlike "$($Demo.RgId)/*") -and ($ResourceId -ne $Demo.RgId)) {
        throw "Refusing to touch $ResourceId - it is outside $($Demo.ResourceGroup)."
    }
}

& az account set --subscription $Demo.SubscriptionId | Out-Null
