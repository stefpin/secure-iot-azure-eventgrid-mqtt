<#
    Step 24 - deploy the OPERATOR APP ONLY (vm-ops), with a backup and an automatic restore.

    Unlike 22-update-code.ps1 -Ops, this never touches the certificate service, the site agent, nginx
    or any Azure resource: it restarts iot-app and nothing else.

      .\24-deploy-app.ps1              check locally, back up the running app, deploy, health-gate;
                                       if the app is not healthy within 120 s the backup is restored
      .\24-deploy-app.ps1 -Rollback    restore the most recent backup (or -Backup <name>) and restart
      .\24-deploy-app.ps1 -TraceOff    turn the "Behind the Scenes" view off (IOT_TRACE=off) - level 0 fallback
      .\24-deploy-app.ps1 -TraceOn     turn it back on
      .\24-deploy-app.ps1 -ListBackups

    Backups: /opt/iot/backup/app-<UTC stamp>.tgz (app incl. node_modules) + app.env-<stamp>; the 5 newest are kept.
    Health gate: MQTT (Entra ID) connected, Kafka consumer in its group, Cosmos DB history, certificate service ok.
#>
param([switch]$Rollback, [string]$Backup, [switch]$TraceOff, [switch]$TraceOn, [switch]$ListBackups, [switch]$SkipLocalChecks)
. "$PSScriptRoot\env.ps1"
. "$PSScriptRoot\lib-vm.ps1"
$root = Split-Path $PSScriptRoot -Parent
$appDir = Join-Path $root 'ops\app'
$vm = $Demo.OpsVm

# Health gate, shared by every action. Prints HEALTH-OK or HEALTH-BAD <reason>.
$healthGate = @'
health_gate() {
  local deadline=$(( $(date +%s) + ${1:-120} )) last=""
  while [ $(date +%s) -lt $deadline ]; do
    last=$(curl -s --max-time 5 http://127.0.0.1:3000/api/health || true)
    if echo "$last" | python3 -c '
import sys, json
d = json.load(sys.stdin)
ok = d["mqtt"]["connected"] and d["kafka"]["connected"] and d["history"]["backend"] == "cosmos db" and d["certificateService"]["status"] == "ok"
sys.exit(0 if ok else 1)' 2>/dev/null; then
      echo "HEALTH-OK $(echo "$last" | python3 -c 'import sys,json; d=json.load(sys.stdin); print("mqtt", d["mqtt"]["connected"], "| kafka", d["kafka"]["connected"], "| history", d["history"]["backend"], "| certsvc", d["certificateService"]["status"], "| uptime", d["uptimeSeconds"], "s")')"
      return 0
    fi
    sleep 3
  done
  echo "HEALTH-BAD $(echo "$last" | head -c 300)"
  return 1
}
trace_state() {
  echo "TRACE $(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/api/trace/health)"
}
'@

function Show-Out([string]$Out) {
    foreach ($line in ((Get-StdOut $Out) -split "`n")) {
        $t = $line.Trim()
        if (-not $t) { continue }
        if ($t -match '^(HEALTH-BAD|IOT-FAIL|ROLLED-BACK)') { Write-Host "   !!  $t" -ForegroundColor Yellow } else { Write-Ok $t }
    }
}

if ($ListBackups) {
    Write-Step 'Backups on vm-ops'
    Show-Out (Invoke-VmScript $vm 'ls -1t /opt/iot/backup/app-*.tgz 2>/dev/null | while read f; do echo "$(basename $f) $(du -h $f | cut -f1) $(date -r $f -u +%FT%TZ)"; done; echo "LATEST $(cat /opt/iot/backup/LATEST 2>/dev/null)"')
    return
}

if ($TraceOff -or $TraceOn) {
    $value = if ($TraceOff) { 'off' } else { 'on' }
    Write-Step "Behind the Scenes view -> $value (restarts iot-app only)"
    $out = Invoke-VmScript $vm -AllowFail @"
$healthGate
set -e
cp -p /etc/iot/app.env /etc/iot/app.env.pre-trace-switch
sed -i '/^IOT_TRACE=/d' /etc/iot/app.env
$(if ($TraceOff) { "echo 'IOT_TRACE=off' >> /etc/iot/app.env" })
chown root:iotapp /etc/iot/app.env && chmod 640 /etc/iot/app.env
systemctl restart iot-app
set +e
health_gate 120 || echo IOT-FAIL app not healthy after the switch
trace_state
"@
    Show-Out $out
    if ($out -match 'IOT-FAIL') { throw 'iot-app is not healthy after the switch - see the output above' }
    return
}

if ($Rollback) {
    Write-Step "Restore the operator app from $(if ($Backup) { $Backup } else { 'the most recent backup' })"
    $name = if ($Backup) { $Backup } else { '' }
    $out = Invoke-VmScript $vm -AllowFail @"
$healthGate
set -e
B="$name"
[ -n "`$B" ] || B=`$(cat /opt/iot/backup/LATEST)
[ -f "/opt/iot/backup/`$B.tgz" ] || { echo "IOT-FAIL no backup /opt/iot/backup/`$B.tgz"; exit 0; }
systemctl stop iot-app
rm -rf /opt/iot/app
tar -xzf "/opt/iot/backup/`$B.tgz" -C /opt/iot
[ -f "/opt/iot/backup/`$B.env" ] && cp -p "/opt/iot/backup/`$B.env" /etc/iot/app.env
systemctl start iot-app
echo "restored `$B"
set +e
health_gate 120 || echo IOT-FAIL app not healthy after the restore
trace_state
"@
    Show-Out $out
    if ($out -match 'IOT-FAIL') { throw 'Restore did not end healthy - see the output above (level 2: restore the vm-ops OS disk snapshot)' }
    return
}

# ------------------------------------------------------------------ deploy
if (-not $SkipLocalChecks) {
    Write-Step 'Local checks (syntax of every file, unit tests)'
    $files = Get-ChildItem $appDir -Recurse -Filter *.js | Where-Object { $_.FullName -notmatch '\\node_modules\\' }
    foreach ($f in $files) {
        & node --check $f.FullName 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Syntax error in $($f.FullName) - nothing was deployed" }
    }
    Write-Ok "$($files.Count) JavaScript files parse"
    Push-Location $appDir
    try {
        $tests = & node --test 'test/trace-engine.test.js' 2>&1
        if ($LASTEXITCODE -ne 0) { $tests | Select-Object -Last 20 | ForEach-Object { Write-Host $_ }; throw 'Unit tests failed - nothing was deployed' }
        Write-Ok (($tests | Where-Object { $_ -match '^\S*\s*(tests|pass|fail) ' }) -join ' | ')
    } finally { Pop-Location }
}

$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
Write-Step "Back up the running app on vm-ops (app-$stamp)"
Show-Out (Invoke-VmScript $vm @"
set -e
mkdir -p /opt/iot/backup && chmod 700 /opt/iot/backup
avail=`$(df -Pm /opt | awk 'NR==2 {print `$4}')
[ "`$avail" -gt 500 ] || { echo "IOT-FAIL only `${avail} MB free on /opt"; exit 0; }
tar -czf /opt/iot/backup/app-$stamp.tgz -C /opt/iot app
cp -p /etc/iot/app.env /opt/iot/backup/app-$stamp.env
echo app-$stamp > /opt/iot/backup/LATEST
ls -1t /opt/iot/backup/app-*.tgz | tail -n +6 | while read f; do rm -f "`$f" "`${f%.tgz}.env"; done
echo "backup app-$stamp.tgz `$(du -h /opt/iot/backup/app-$stamp.tgz | cut -f1), `${avail} MB free before"
"@)

Write-Step 'Ship the new app code (staging folder first)'
Invoke-VmScript $vm 'rm -rf /opt/iot/app-staging' | Out-Null
Write-Ok (Send-VmFolder -Vm $vm -LocalDir $appDir -RemoteDir /opt/iot/app-staging -Exclude @('node_modules', '.env', 'package-lock.json', 'test'))

$manifest = Get-ChildItem $appDir -Recurse -File | Where-Object { $_.FullName -notmatch '\\(node_modules|test)\\' -and $_.Name -notin '.env', 'package-lock.json' } | ForEach-Object {
    $rel = $_.FullName.Substring($appDir.Length + 1).Replace('\', '/')
    "$((Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower())  $rel"
}
$manifestText = ($manifest -join "`n") + "`n"

Write-Step 'Switch to the new code, restart iot-app only, health gate (auto-restore on failure)'
$out = Invoke-VmScript $vm -AllowFail @"
$healthGate
set -e
cd /opt/iot/app-staging
cat > /tmp/iot-manifest.txt <<'EOF'
$manifestText
EOF
sha256sum -c --quiet /tmp/iot-manifest.txt || { echo "IOT-FAIL shipped files do not match the local manifest - nothing switched"; exit 0; }
echo "manifest ok: `$(grep -c . /tmp/iot-manifest.txt) files match"
if ! cmp -s /opt/iot/app-staging/package.json /opt/iot/app/package.json; then
  echo "package.json changed - npm install"
  cp /opt/iot/app-staging/package.json /opt/iot/app/package.json
  (cd /opt/iot/app && npm install --omit=dev --no-audit --no-fund --loglevel=error >/tmp/npm.log 2>&1) || { tail -5 /tmp/npm.log; }
fi
cp -a /opt/iot/app-staging/. /opt/iot/app/
chown -R root:root /opt/iot/app
rm -rf /opt/iot/app-staging
systemctl restart iot-app
set +e
if health_gate 120; then
  trace_state
  journalctl -u iot-app --since -3min --no-pager -o cat | grep -E '^\[trace\]' | tail -2
else
  echo "ROLLED-BACK the new code was not healthy - restoring app-$stamp"
  systemctl stop iot-app
  rm -rf /opt/iot/app
  tar -xzf /opt/iot/backup/app-$stamp.tgz -C /opt/iot
  cp -p /opt/iot/backup/app-$stamp.env /etc/iot/app.env
  systemctl start iot-app
  health_gate 120
  journalctl -u iot-app --since -5min --no-pager -o cat | tail -15
  echo "IOT-FAIL deployment rolled back"
fi
"@
Show-Out $out
if ($out -match 'IOT-FAIL') { throw 'Deployment failed - the previous app was restored (see the output above)' }
Write-Ok "deployed; backup app-$stamp kept on vm-ops (.\24-deploy-app.ps1 -Rollback restores it)"
