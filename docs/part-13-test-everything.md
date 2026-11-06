# Part 13 — Test everything

[Documentation index](README.md) · [← Part 12 — Monitoring for the IT team](part-12-monitoring-for-it.md) · [Part 14 — Run the demo (presenter script) →](part-14-run-the-demo.md)

#### Do it with the script

*PowerShell — about 13 minutes (add -Quick to skip the 6-minute expiry checks)*

```powershell
.\23-tag-sweep.ps1
.\90-test.ps1 -PasswordFile C:\iot-secrets\ops-ui-password.txt
```

The suite runs 44 checks in four groups and uses temporary machines (`E2E-RPI`, `E2E-ESP` with a 3-minute certificate, `E2E-TOK`) that it deletes afterwards. On 6 November 2026, with the version 1.2 app and the Behind the Scenes view switched on, the full run passed **44 of 44** in 12.8 minutes.

| Group | Checks |
|---|---|
| A — Azure configuration (7) | tags; Event Grid public access = selected IPs; custom domain approved; Event Hubs / Key Vault / Cosmos private; no SAS or Cosmos keys; CA keys are HSM keys and the root is out of reach; the app identity has no role outside the resource group |
| S — Mine site (10) | IPsec up; DNS through the VPN for the name **and** its CNAME target past the TTL; enrol host private-only; TLS verifies with the Contoso bundle and **not** with the public store; the public endpoint refuses the site; enrolment endpoint reachable, internal API not; gateway certificate valid; private keys 0600 |
| O — Operations (22) | health; CA; server certificate; register; enrol + connect; MQTT telemetry; Kafka → Cosmos history; commands 200/400/404; ESP32 404 right after it connects; renewal over MQTT; late joiner; retained fleet config; Last Will **and the back-online notification**; routed alert with enrichments; scheduled renewal; re-enrolment after expiry; revoke + quarantine; restore; token single-use; delete |
| D — Internet (5) | operator URL demands sign-in; app works through Front Door; origin not reachable directly; publicly trusted managed certificate; Grafana demands Entra ID |

*Excerpt of the final run (6 November 2026, details shortened)*

```text
PASS O11 :: ESP32 ... connected; setMotorSpeed -> 404 'This device has no motor ...'
PASS O15 :: Last Will 3.2 s after the cut; back online; operator notified
PASS O16 :: routing filter data.temperature > 75 -> Kafka alerts - temperature 75.56
PASS O19 :: revoke: client disabled, data quarantined, renewals refused
PASS D04 Front Door managed certificate :: issuer: CN=GeoTrust TLS RSA CA G1

RESULT: 44 of 44 checks passed in 12.8 min
```

### Checks of the Behind the Scenes view (new in 1.2)

*PowerShell — about 1 minute*

```powershell
.\91-test-trace.ps1
```

A separate set of 7 checks (`tests\e2e_trace.py`, run on vm-ops) proves that the view follows real traffic: it follows one reading of a running machine and checks that every service handled it (Event Grid broker, live delivery, routing with the enrichments, Event Hubs, Kafka and Cosmos DB), follows one command (a speed change to the speed the machine already has), finds the command in the machine's own log, traces a refused command (ESP32 → 404), checks input validation and that the app is still healthy. It creates and deletes nothing. The 44 regression checks above do not depend on the view and pass with it switched on or off.

*Excerpt of the run on the final build (6 November 2026)*

```text
PASS T02 follow one reading :: live 545 ms, broker->EH 51.6 ms, device->Kafka 932 ms,
     end-to-end 1439 ms, 10.86 RU, EH telemetry, partition 1
PASS T03 follow one command :: setMotorSpeed 4500 (unchanged): PUBACK 83 ms,
     round trip 184 ms, app 185 ms
PASS T05 refused command (ESP32 has no motor) is traced as 404 :: 404 in 133 ms
SUMMARY 7/7 trace checks passed
```

The live time in this run (545 ms instead of the usual 65–90 ms) is one of the occasional slow spells described in [Part 14.10](part-14-run-the-demo.md); the check accepts up to 3 seconds. Your own numbers will differ a little from run to run.

---

[Documentation index](README.md) · [← Part 12 — Monitoring for the IT team](part-12-monitoring-for-it.md) · [Part 14 — Run the demo (presenter script) →](part-14-run-the-demo.md)
