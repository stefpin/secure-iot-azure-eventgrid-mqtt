#!/usr/bin/env bash
# End-to-end tests, mine-site side - runs ON vm-site1 (as root, via run-command).
# Network path, DNS and TLS exactly as a machine at the remote site experiences them.
set -u
pass=0; fail=0
ok()  { echo "PASS $1 :: $2"; pass=$((pass+1)); }
bad() { echo "FAIL $1 :: $2"; fail=$((fail+1)); }
MQTT=${MQTT_HOST:?set MQTT_HOST - the custom MQTT host name}
ENROLL=${ENROLL_HOST:?set ENROLL_HOST - the private enrolment host name}
EG_HOST=${EG_HOST:?set EG_HOST - the namespace MQTT host name in ts.eventgrid.azure.net}
TRUST=/etc/iot/trust-bundle.pem

# S01 IPsec tunnel to the Azure VPN gateway
sa=$(swanctl --list-sas 2>/dev/null)
if echo "$sa" | grep -q 'ESTABLISHED' && echo "$sa" | grep -q 'azure-net.*INSTALLED'; then
  ok S01 "IKEv2 SA established, child SA installed ($(echo "$sa" | grep -o 'ESP:[^ ]*' | head -1))"
else bad S01 "tunnel not up"; fi

# S02 the site has NO private DNS zone: names resolve only through the conditional forwarder over the VPN.
# Both the custom name AND its CNAME target in ts.eventgrid.azure.net must be forwarded (checked
# repeatedly, past the 10-second TTL of the private A record).
okdns=1
for i in 1 2 3; do
  for h in $MQTT $EG_HOST; do
    [ "$(getent hosts $h | awk '{print $1}')" = "10.40.2.4" ] || okdns=0
  done
  sleep 11
done
[ $okdns = 1 ] && ok S02 "$MQTT and its CNAME target -> 10.40.2.4 (private endpoint) via hub DNS forwarder, stable past TTL" || bad S02 "$MQTT -> $(getent hosts $MQTT | awk '{print $1}')"

# S03 the enrolment endpoint exists only in the private zone
eip=$(getent hosts $ENROLL | awk '{print $1}')
pub=$(dig +short $ENROLL @1.1.1.1 | head -1)
[ "$eip" = "10.40.1.10" ] && [ -z "$pub" ] && ok S03 "$ENROLL -> $eip privately; public DNS: no record" || bad S03 "private='$eip' public='$pub'"

# S04 MQTT TLS through the private endpoint verifies against the Contoso trust bundle (custom domain, Contoso server CA)
v=$(timeout 15 openssl s_client -connect $MQTT:8883 -servername $MQTT -CAfile $TRUST -verify_hostname $MQTT </dev/null 2>/dev/null)
code=$(echo "$v" | grep -o 'Verify return code: [0-9]* ([^)]*)' | head -1)
issuer=$(echo "$v" | openssl x509 -noout -issuer 2>/dev/null | sed 's/.*CN *= *//')
echo "$code" | grep -q ': 0 (ok)' && ok S04 "TLS verified ($issuer)" || bad S04 "$code"

# S05 a client that trusts only the public web PKI is rejected - the endpoint uses the private Contoso CA
code2=$(timeout 15 openssl s_client -connect $MQTT:8883 -servername $MQTT -CApath /etc/ssl/certs </dev/null 2>/dev/null | grep -o 'Verify return code: [0-9]*' | head -1)
[ "$code2" != "Verify return code: 0" ] && ok S05 "public trust store does not trust the endpoint ($code2) - private CA only" || bad S05 "unexpectedly trusted by the public store"

# S06 the namespace's PUBLIC endpoint refuses the site (IP filter: selected IPs only)
pubip=$(dig +short $EG_HOST @1.1.1.1 | tail -1)
hs=$(timeout 12 openssl s_client -connect $pubip:8883 -servername $EG_HOST </dev/null 2>&1)
echo "$hs" | grep -q 'no peer certificate available' && ok S06 "public endpoint $pubip: TLS handshake refused (IP filter)" || bad S06 "public endpoint answered"

# S07 the enrolment endpoint is reachable from the site over the VPN with the Contoso trust bundle
h=$(curl -s --max-time 10 --cacert $TRUST https://$ENROLL/v1/health)
echo "$h" | grep -q '"status":"ok"' && ok S07 "https://$ENROLL/v1/health -> $h" || bad S07 "'$h'"

# S08 only the enrolment routes are exposed - the internal API is not reachable from the site
c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --cacert $TRUST https://$ENROLL/internal/devices)
[ "$c" = "404" ] && ok S08 "/internal/* from the site -> 404" || bad S08 "got $c"

# S09 the gateway (site agent) is connected with its own short-lived certificate
na=$(openssl x509 -in /var/lib/iot/gateway/device.crt -noout -enddate 2>/dev/null | cut -d= -f2)
left=$(( $(date -d "$na" +%s) - $(date +%s) ))
systemctl is-active -q iot-site && [ $left -gt 0 ] && ok S09 "iot-site active; gateway certificate valid $((left/60)) more minutes" || bad S09 "agent or certificate problem (left=${left}s)"

# S10 device keys never leave the device: 0600, owned by the agent user
perm=$(find /var/lib/iot -name device.key -printf '%m %u\n' | sort -u)
[ "$(echo "$perm" | grep -vc '^600 iotsite$')" = "0" ] && ok S10 "all private keys 0600 iotsite ($(echo "$perm" | wc -l) distinct)" || bad S10 "$perm"

echo "SUMMARY $pass/$((pass+fail)) passed"
