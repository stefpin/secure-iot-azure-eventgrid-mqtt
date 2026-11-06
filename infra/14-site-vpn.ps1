<#
    Step 14 - make vm-site1 the mine site (VPN, packages, DNS isolation).

    Safe on a fresh build too: if pip-site is not attached anywhere it is simply attached to vm-site1,
    and if no private DNS zone is linked to the site VNet there is nothing to unlink.

      1. Move the site's public IP (the VPN peer address the Azure local network
         gateway expects) from the PoC VM to vm-site1. snet-site is a private
         subnet (no default outbound access), so this is also what gives the
         site VM its internet path for packages.
      2. Install strongSwan and the Python runtime on vm-site1.
      3. Configure the IPsec tunnel to the hub's Azure VPN gateway.
      4. Unlink every private DNS zone from the site VNet. From now on the site
         resolves iot.example.com ONLY through its conditional forwarder
         -> hub DNS forwarder (10.40.1.10) -> over the VPN, like a real remote site.
      5. Verify DNS, the tunnel and the MQTT TLS endpoint from the site.

    The pre-shared key is read from -PskFile (kept outside the project folder).
#>
param(
    [Parameter(Mandatory)][string]$PskFile,
    [string]$OldNic = 'vm-site-pocVMNic',
    [string]$OldIpConfig = 'ipconfigvm-site-poc'
)
. "$PSScriptRoot\env.ps1"
$rg = $Demo.ResourceGroup

function Invoke-VmScript([string]$Vm, [string]$Script) {
    $file = Join-Path $env:TEMP ("iotmq-" + [guid]::NewGuid().ToString('N') + '.sh')
    [IO.File]::WriteAllText($file, $Script.Replace("`r`n", "`n"), (New-Object System.Text.UTF8Encoding($false)))
    try { return Invoke-Az -Raw vm run-command invoke -g $rg -n $Vm --command-id RunShellScript --scripts "@$file" --query 'value[0].message' -o tsv }
    finally { Remove-Item $file -ErrorAction SilentlyContinue }
}

$pip = Invoke-Az network public-ip show -g $rg -n pip-site -o json
$gw  = Invoke-Az network public-ip show -g $rg -n pip-vpngw -o json
$psk = (Get-Content $PskFile -Raw).Trim()

Write-Step "Move pip-site ($($pip.ipAddress)) to vm-site1"
$attachedTo = $pip.ipConfiguration.id
if ($attachedTo -and $attachedTo -notlike '*nic-vm-site1*') {
    Invoke-Az network nic ip-config update -g $rg --nic-name $OldNic -n $OldIpConfig --remove publicIpAddress -o none | Out-Null
    Write-Ok "detached from $OldNic"
}
if (-not $attachedTo -or $attachedTo -notlike '*nic-vm-site1*') {
    Invoke-Az network nic ip-config update -g $rg --nic-name nic-vm-site1 -n ipconfig1 --public-ip-address pip-site -o none | Out-Null
}
Write-Ok "pip-site now on nic-vm-site1"

Write-Step 'Install strongSwan + Python runtime on vm-site1'
$out = Invoke-VmScript $Demo.SiteVm @'
set -e
export DEBIAN_FRONTEND=noninteractive
for i in 1 2 3 4 5 6; do apt-get update -qq && break; sleep 10; done
apt-get install -y -qq strongswan-swanctl charon-systemd python3-venv openssl dnsutils jq >/dev/null
rm -rf /opt/iot/venv && python3 -m venv /opt/iot/venv
/opt/iot/venv/bin/pip install --quiet --upgrade pip
/opt/iot/venv/bin/pip install --quiet 'paho-mqtt==2.1.0' cryptography requests
touch /opt/iot/.ready
echo "strongswan $(dpkg-query -W -f='${Version}' strongswan-swanctl)"; /opt/iot/venv/bin/pip list 2>/dev/null | grep -iE 'paho|cryptography|requests'
'@
$out -split "`n" | Where-Object { $_ -match 'strongswan|paho|cryptography|requests' } | ForEach-Object { Write-Ok $_.Trim() }

Write-Step 'IPsec tunnel to the Azure VPN gateway'
$swan = @"
set -e
cat > /etc/swanctl/conf.d/azure.conf <<'EOF'
connections {
  azure {
    version = 2
    local_addrs = $($Demo.SiteVmIp)
    remote_addrs = $($gw.ipAddress)
    proposals = aes256-sha256-modp1024,aes256-sha1-modp1024
    encap = yes
    dpd_delay = 30s
    rekey_time = 7h
    local {
      auth = psk
      id = $($pip.ipAddress)
    }
    remote {
      auth = psk
      id = $($gw.ipAddress)
    }
    children {
      azure-net {
        local_ts = $($Demo.SitePrefix)
        remote_ts = 10.40.0.0/16
        esp_proposals = aes256-sha256,aes256-sha1
        rekey_time = 6h
        start_action = start
        dpd_action = restart
        close_action = start
      }
    }
  }
}
secrets {
  ike-azure {
    id-azure = $($gw.ipAddress)
    secret = "$psk"
  }
}
EOF
chmod 600 /etc/swanctl/conf.d/azure.conf
systemctl enable --now strongswan >/dev/null 2>&1 || true
systemctl restart strongswan
sleep 3
swanctl --load-all >/dev/null 2>&1 || true
swanctl --initiate --child azure-net >/dev/null 2>&1 || true
for i in `$(seq 1 20); do swanctl --list-sas 2>/dev/null | grep -q 'azure-net.*INSTALLED' && break; sleep 3; done
swanctl --list-sas 2>/dev/null | grep -E 'azure:|azure-net|ESTABLISHED|INSTALLED' | head -4
"@
$out = Invoke-VmScript $Demo.SiteVm $swan
$out -split "`n" | Where-Object { $_ -match 'ESTABLISHED|INSTALLED' } | ForEach-Object { Write-Ok $_.Trim() }
if ($out -notmatch 'INSTALLED') { throw "IPsec child SA not installed:`n$out" }

Write-Step 'Unlink private DNS zones from the site VNet'
$zones = @(Invoke-Az network private-dns zone list -g $rg --query '[].name' -o json)
foreach ($z in $zones) {
    $links = @(Invoke-Az network private-dns link vnet list -g $rg -z $z -o json)
    foreach ($l in $links | Where-Object { $_.virtualNetwork.id -like "*/virtualNetworks/$($Demo.SiteVnet)" }) {
        Invoke-Az network private-dns link vnet delete -g $rg -z $z -n $l.name --yes -o none | Out-Null
        Write-Ok "$z : removed $($l.name)"
    }
}

Write-Step 'Verify from the site: DNS through the VPN, then TLS to the private MQTT endpoint'
$out = Invoke-VmScript $Demo.SiteVm @"
resolvectl flush-caches
for h in $($Demo.MqttHost) $($Demo.EnrollHost); do
  echo "dns `$h -> `$(getent hosts `$h | awk '{print `$1}' | head -1)"
done
echo "serial `$(timeout 15 openssl s_client -connect $($Demo.MqttHost):8883 -servername $($Demo.MqttHost) </dev/null 2>/dev/null | openssl x509 -noout -serial 2>/dev/null | cut -d= -f2)"
"@
$out -split "`n" | Where-Object { $_ -match '^(dns|serial)' } | ForEach-Object { Write-Ok $_.Trim() }
