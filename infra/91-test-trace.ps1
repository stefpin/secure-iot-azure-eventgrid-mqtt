<#
    Step 91 - checks of the "Behind the Scenes" view (tests\e2e_trace.py on vm-ops).
    Separate from 90-test.ps1 (the 44 regression checks): creates and deletes nothing, and its only command
    sets a machine's speed to the speed it already has.
#>
. "$PSScriptRoot\env.ps1"
. "$PSScriptRoot\lib-vm.ps1"
$root = Split-Path $PSScriptRoot -Parent
Write-Step 'Behind the Scenes checks on vm-ops'
Send-VmFile -Vm $Demo.OpsVm -LocalPath "$root\tests\e2e_trace.py" -RemotePath /opt/iot/tests/e2e_trace.py | Out-Null
$out = Get-StdOut (Invoke-VmScript $Demo.OpsVm -AllowFail 'cd /opt/iot/tests && /opt/iot/certsvc/venv/bin/python e2e_trace.py 2>&1 | grep -E "^(PASS|FAIL|SUMMARY|JSON)"')
foreach ($line in $out -split "`n") {
    $t = $line.Trim()
    if ($t -match '^PASS') { Write-Host $t -ForegroundColor Green }
    elseif ($t -match '^FAIL') { Write-Host $t -ForegroundColor Red }
    elseif ($t) { Write-Host $t }
}
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$out | Set-Content (Join-Path $root "tests\trace-results-$stamp.txt")
