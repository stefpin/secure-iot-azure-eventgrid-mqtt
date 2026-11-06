<#
    Helpers to run scripts on, and copy files to, the demo VMs WITHOUT SSH.

    Everything goes through 'az vm run-command invoke' (Azure control plane over
    HTTPS), so no inbound management port is ever opened on the VMs. Files are
    streamed as base64 in chunks because run-command has no file channel.
    Dot-source after env.ps1:   . .\lib-vm.ps1
#>

function Invoke-VmScript {
    param([Parameter(Mandatory)][string]$Vm, [Parameter(Mandatory)][string]$Script, [switch]$AllowFail)
    $file = Join-Path $env:TEMP ("iotmq-" + [guid]::NewGuid().ToString('N') + '.sh')
    [IO.File]::WriteAllText($file, $Script.Replace("`r`n", "`n"), (New-Object System.Text.UTF8Encoding($false)))
    try {
        $out = Invoke-Az -Raw vm run-command invoke -g $Demo.ResourceGroup -n $Vm --command-id RunShellScript `
            --scripts "@$file" --query 'value[0].message' -o tsv
    } finally { Remove-Item $file -ErrorAction SilentlyContinue }
    if (-not $AllowFail -and $out -match '(?m)^IOT-FAIL') { throw "Script on $Vm reported failure:`n$out" }
    return $out
}

<# Returns only the [stdout] part of a run-command message. #>
function Get-StdOut([string]$Message) {
    if ($Message -match '(?s)\[stdout\]\s*(.*?)\s*\[stderr\]') { return $Matches[1] }
    return $Message
}

function Send-VmFile {
    param([Parameter(Mandatory)][string]$Vm, [Parameter(Mandatory)][string]$LocalPath,
          [Parameter(Mandatory)][string]$RemotePath, [string]$Mode = '0644', [string]$Owner = 'root:root')
    $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($LocalPath))
    $chunk = 60000
    $count = [math]::Max(1, [math]::Ceiling($b64.Length / $chunk))
    $tmp = "/tmp/iot-upload-$([guid]::NewGuid().ToString('N')).b64"
    for ($i = 0; $i -lt $count; $i++) {
        $part = $b64.Substring($i * $chunk, [math]::Min($chunk, $b64.Length - $i * $chunk))
        $op = if ($i -eq 0) { '>' } else { '>>' }
        Invoke-VmScript $Vm "printf '%s' '$part' $op $tmp" | Out-Null
    }
    $out = Invoke-VmScript $Vm @"
set -e
mkdir -p "`$(dirname '$RemotePath')"
base64 -d $tmp > '$RemotePath'
rm -f $tmp
chown $Owner '$RemotePath'
chmod $Mode '$RemotePath'
echo "IOT-OK `$(sha256sum '$RemotePath' | cut -c1-16) `$(stat -c %s '$RemotePath')"
"@
    $local = (Get-FileHash $LocalPath -Algorithm SHA256).Hash.Substring(0, 16).ToLower()
    if ($out -notmatch "IOT-OK $local") { throw "Upload of $LocalPath to ${Vm}:$RemotePath failed or hash mismatch:`n$out" }
    return $count
}

<#
    Packs a local folder (tar.gz), ships it and unpacks it into RemoteDir.
    -Exclude takes tar --exclude patterns (e.g. node_modules).
#>
function Send-VmFolder {
    param([Parameter(Mandatory)][string]$Vm, [Parameter(Mandatory)][string]$LocalDir,
          [Parameter(Mandatory)][string]$RemoteDir, [string[]]$Exclude = @(), [string]$Owner = 'root:root')
    $tgz = Join-Path $env:TEMP ("iotmq-" + [guid]::NewGuid().ToString('N') + '.tgz')
    $tarArgs = @('-czf', $tgz)
    foreach ($e in $Exclude) { $tarArgs += "--exclude=$e" }
    $tarArgs += @('-C', $LocalDir, '.')
    & "$env:SystemRoot\System32\tar.exe" @tarArgs
    if ($LASTEXITCODE -ne 0) { throw "tar failed for $LocalDir" }
    try {
        $remoteTgz = "/tmp/iot-$([guid]::NewGuid().ToString('N')).tgz"
        $chunks = Send-VmFile -Vm $Vm -LocalPath $tgz -RemotePath $remoteTgz
        $out = Invoke-VmScript $Vm @"
set -e
mkdir -p '$RemoteDir'
tar -xzf $remoteTgz -C '$RemoteDir' --no-same-owner
rm -f $remoteTgz
chown -R $Owner '$RemoteDir'
echo "IOT-OK `$(find '$RemoteDir' -type f | wc -l) files"
"@
        return "$((Get-StdOut $out).Trim()) ($chunks chunk(s))"
    } finally { Remove-Item $tgz -ErrorAction SilentlyContinue }
}
