<#
    Redeploy code only (no infrastructure or settings changes) and restart the services.
      -Ops   certificate service + operator app on vm-ops
      -Site  site agent + device agents on vm-site1 (running machines are restarted with it)
#>
param([switch]$Ops, [switch]$Site)
. "$PSScriptRoot\env.ps1"
. "$PSScriptRoot\lib-vm.ps1"
$root = Split-Path $PSScriptRoot -Parent
if (-not $Ops -and -not $Site) { $Ops = $true; $Site = $true }

if ($Ops) {
    Write-Step 'vm-ops: certificate service + operator app'
    Write-Ok (Send-VmFolder -Vm $Demo.OpsVm -LocalDir "$root\ops\certsvc" -RemoteDir /opt/iot/certsvc/src -Exclude @('__pycache__', '*.pyc'))
    Write-Ok (Send-VmFolder -Vm $Demo.OpsVm -LocalDir "$root\ops\app" -RemoteDir /opt/iot/app -Exclude @('node_modules', '.env', 'package-lock.json'))
    $out = Invoke-VmScript $Demo.OpsVm @'
cd /opt/iot/app && npm install --omit=dev --no-audit --no-fund --loglevel=error >/tmp/npm.log 2>&1 || tail -5 /tmp/npm.log
systemctl restart iot-certsvc && sleep 8 && systemctl restart iot-app && sleep 10
echo "certsvc $(systemctl is-active iot-certsvc)  app $(systemctl is-active iot-app)"
curl -s http://127.0.0.1:3000/api/health | python3 -c 'import sys,json; d=json.load(sys.stdin); print("mqtt", d["mqtt"]["connected"], "| kafka", d["kafka"]["connected"], "| history", d["history"]["backend"], "| certsvc", d["certificateService"]["status"])'
'@
    (Get-StdOut $out) -split "`n" | ForEach-Object { Write-Ok $_.Trim() }
}
if ($Site) {
    Write-Step 'vm-site1: site agent + device agents'
    Write-Ok (Send-VmFolder -Vm $Demo.SiteVm -LocalDir "$root\site\agent" -RemoteDir /opt/iot/agent -Exclude @('__pycache__', '*.pyc'))
    $out = Invoke-VmScript $Demo.SiteVm 'systemctl restart iot-site && sleep 10 && echo "site $(systemctl is-active iot-site)" && journalctl -u iot-site --since -20s --no-pager -o cat | tail -4'
    (Get-StdOut $out) -split "`n" | ForEach-Object { Write-Ok $_.Trim() }
}
