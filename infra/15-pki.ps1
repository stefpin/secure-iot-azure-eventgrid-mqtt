<#
    Step 15 - the CA "key ceremony" (run once) and least-privilege roles.

      1. Grant the certificate-service identity TEMPORARY rights to create keys and secrets.
      2. Ship the CA code to vm-ops and run bootstrap.py as id-iotmq-certsvc:
           - 3 RSA-HSM keys in Key Vault Premium: iot-root-ca (3072), iot-device-ca, iot-server-ca (2048)
           - root CA (self-signed, 10 y), device issuing CA and server issuing CA (2 y, the server CA is
             name-constrained to iot.example.com), all signed INSIDE the HSM
           - the root key is then DISABLED (an "offline" root)
           - the 7-day TLS certificate for the private enrolment endpoint (nginx)
         The MQTT custom-domain certificate is issued later by the service itself (step 16), and
         re-issued under a new Key Vault name on every rotation.
      3. Save the PUBLIC CA certificates to ..\pki and build trust-bundle.pem (root + server CA - Event
         Grid presents only its leaf certificate, so devices need the issuing CA too).
      4. Register the device issuing CA with Event Grid (CA-chain client authentication).
      5. Replace the temporary rights with narrow, per-object roles.
    -SkipCeremony  keys and CAs already exist: only steps 3-5.
#>
param([switch]$SkipCeremony)
. "$PSScriptRoot\env.ps1"
. "$PSScriptRoot\lib-vm.ps1"

<# run-command output can re-flow long lines; rebuild a strict PEM (64-character lines). #>
function ConvertTo-CanonicalPem([string]$Text) {
    $b64 = ($Text -replace '-----[A-Z ]+-----', '' -replace '\s', '')
    $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(, [Convert]::FromBase64String($b64))
    $body = [Convert]::ToBase64String($cert.RawData)
    $lines = for ($i = 0; $i -lt $body.Length; $i += 64) { $body.Substring($i, [math]::Min(64, $body.Length - $i)) }
    return "-----BEGIN CERTIFICATE-----`n" + ($lines -join "`n") + "`n-----END CERTIFICATE-----`n"
}

$rg = $Demo.ResourceGroup
$vm = $Demo.OpsVm
$nsId = "$($Demo.RgId)/providers/Microsoft.EventGrid/namespaces/$($Demo.EventGrid)"
$kvId = "$($Demo.RgId)/providers/Microsoft.KeyVault/vaults/$($Demo.KeyVault)"
$vault = "https://$($Demo.KeyVault).vault.azure.net/"
$certId = Invoke-Az identity show -g $rg -n $Demo.CertIdentity -o json
$p = $certId.principalId
$pkiDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'pki'
New-Item -ItemType Directory -Force -Path $pkiDir | Out-Null

if (-not $SkipCeremony) {
    Write-Step 'Temporary ceremony rights for id-iotmq-certsvc'
    foreach ($r in 'Key Vault Crypto Officer', 'Key Vault Secrets Officer', 'Key Vault Certificates Officer') {
        Invoke-Az role assignment create --assignee-object-id $p --assignee-principal-type ServicePrincipal --role $r --scope $kvId -o none | Out-Null
        Write-Ok "+ $r (vault)"
    }
    Write-Step 'Ship CA code to vm-ops'
    Write-Ok (Send-VmFolder -Vm $vm -LocalDir (Join-Path (Split-Path $PSScriptRoot -Parent) 'ops\certsvc') -RemoteDir /opt/iot/certsvc/src -Exclude @('__pycache__', '*.pyc'))

    Write-Step 'CA ceremony (bootstrap.py) - retried while new role assignments propagate'
    for ($try = 1; $try -le 5; $try++) {
        $json = Get-StdOut (Invoke-VmScript $vm @"
cd /opt/iot/certsvc/src
AZURE_CLIENT_ID=$($certId.clientId) IOT_VAULT_URL=$vault /opt/iot/certsvc/venv/bin/python bootstrap.py 2>&1 | tail -30
"@)
        if ($json -match '"enroll-cert"') { break }
        Write-Info "attempt $try did not finish (role propagation?) - waiting 60 s"
        Start-Sleep 60
    }
    if ($json -notmatch '"enroll-cert"') { throw "bootstrap did not complete:`n$json" }
    Write-Host $json
}

Write-Step 'Fetch the public CA certificates'
foreach ($name in 'root-ca', 'device-ca', 'server-ca') {
    $raw = Get-StdOut (Invoke-VmScript $vm "cat /etc/iot/pki/$name.pem")
    if ($raw -notmatch 'BEGIN CERTIFICATE') { throw "could not read $name.pem" }
    [IO.File]::WriteAllText((Join-Path $pkiDir "$name.pem"), (ConvertTo-CanonicalPem $raw))
    Write-Ok "$name.pem"
}
$bundle = (Get-Content (Join-Path $pkiDir 'root-ca.pem') -Raw) + (Get-Content (Join-Path $pkiDir 'server-ca.pem') -Raw)
[IO.File]::WriteAllText((Join-Path $pkiDir 'trust-bundle.pem'), $bundle.Replace("`r`n", "`n"))
Write-Ok 'trust-bundle.pem = root CA + server issuing CA'

Write-Step 'Register the device issuing CA with Event Grid'
# Event Grid accepts the certificate body as ONE base64 line between CRLF-separated header and
# footer; standard 64-character PEM lines are rejected as "not valid PEM".
$deviceB64 = ((Get-Content (Join-Path $pkiDir 'device-ca.pem') -Raw) -replace '-----[A-Z ]+-----', '' -replace '\s', '')
$file = New-JsonFile @{ properties = @{ encodedCertificate = "-----BEGIN CERTIFICATE-----`r`n$deviceB64`r`n-----END CERTIFICATE-----"
                                        description = 'Contoso IoT Demo Device Issuing CA (Key Vault HSM key iot-device-ca)' } }
$ca = Invoke-Az rest --method put --url "https://management.azure.com$nsId/caCertificates/iot-device-ca?api-version=2025-02-15" --body "@$file" -o json
Remove-Item $file
Write-Ok "iot-device-ca registered, expires $($ca.properties.expiryTimeInUtc)"

Write-Step 'Least privilege for the certificate service'
# Certificates Officer stays vault-wide: every MQTT server-certificate rotation creates a NEW certificate
# name (Event Grid caches per name), so it cannot be scoped to one object in advance.
$narrow = @(
    @{ r = 'Key Vault Crypto User';          s = "$kvId/keys/iot-device-ca" },
    @{ r = 'Key Vault Crypto User';          s = "$kvId/keys/iot-server-ca" },
    @{ r = 'Key Vault Certificates Officer'; s = $kvId },
    @{ r = 'Key Vault Secrets User';         s = "$kvId/secrets/iot-device-ca-cert" },
    @{ r = 'Key Vault Secrets User';         s = "$kvId/secrets/iot-server-ca-cert" },
    @{ r = 'Key Vault Secrets User';         s = "$kvId/secrets/iot-root-ca-cert" }
)
foreach ($n in $narrow) {
    Invoke-Az role assignment create --assignee-object-id $p --assignee-principal-type ServicePrincipal --role $n.r --scope $n.s -o none | Out-Null
    Write-Ok "+ $($n.r) on $(if ($n.s -eq $kvId) { 'the vault (certificates)' } else { ($n.s -split '/vaults/')[1] })"
}
foreach ($stale in 'Key Vault Crypto Officer', 'Key Vault Secrets Officer') {
    $have = @(Invoke-Az role assignment list --assignee $p --role $stale --scope $kvId -o json | Where-Object { $_.scope -eq $kvId })
    if ($have.Count) {
        Invoke-Az role assignment delete --assignee $p --role $stale --scope $kvId -o none | Out-Null
        Write-Ok "- $stale (vault) - ceremony rights removed; nobody can use the root key now"
    }
}
