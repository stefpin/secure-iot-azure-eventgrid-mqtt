# Part 18 — Troubleshooting

[Documentation index](README.md) · [← Part 17 — What we found while building it](part-17-findings.md) · [Part 19 — Day-2 operations and clean-up →](part-19-day-2-operations.md)

| Symptom | Likely cause | Fix |
|---|---|---|
| Machine log: `connect failed: TLS/TCP ... UNEXPECTED_EOF` | The name resolved to the **public** IP (IP filter closes the handshake) | On vm-site1: `getent hosts mqtt.iot.example.com` must give 10.40.2.4; check the resolver forwards both zones; check the VPN |
| `connect failed: CONNACK Not authorized` | Client disabled/revoked, or created seconds ago | Certificates page: state; wait 20 s after creation |
| `enroll refused (403): Unknown, used or expired enrolment token` | Token already used, older than 24 h, or for another device | Device Visibility → **Script** → **New token** |
| `re-enrolment refused ... expired more than 24 h ago` | The machine was off longer than the grace period | Issue a new token (as above) |
| Command answers 409 | The device's retained status says offline | Press **Connect**; check the machine's log (**Connect Summary**) |
| Command answers 504 | Device online but did not answer within 15 s | Check the machine log; the command expires after 30 s on the broker. (A 504 right after a machine connected was fixed in 1.1 — see [Part 17](part-17-findings.md), finding 12.) |
| Power-loss banner turns red: *has not come back* | The machine was revoked or deleted during the outage, or the site agent or VPN is down | **Device Visibility** status; Grafana → *Connection failures*; **Connect Summary**; VPN row below |
| A Grafana panel shows *No data* | Data not ingested yet, wrong time range or sign-in | [Part 14.8](part-14-run-the-demo.md) |
| Pipeline page shows no Kafka events | Consumer not connected or routing disabled | `/api/health` → `kafka.lastError`; Event Grid **Routing** page; Grafana *Routed* panel |
| Endpoint certificate not issued by the Contoso CA | Rotation pending or failed | Certificates page → **Rotate Now**; `journalctl -u iot-certsvc` via Run command |
| VPN connection *Not connected* | strongSwan down or IP changed | Run command on vm-site1: `swanctl --list-sas`; `systemctl restart strongswan` |
| Front Door 403 / 401 | 403: request not from Front Door; 401: password | Use the custom domain; check the password file |
| Behind the Scenes: *The view is turned off on this server* | `IOT_TRACE=off` was set | `.\24-deploy-app.ps1 -TraceOn` (restarts only the operator app) |
| Behind the Scenes: *no reading within 30 s* | The machine is not sending (offline, revoked, or the fleet interval is long) | Device Visibility → **Connected**? Fleet Config interval ≤ 10 s? Pick another machine |
| Behind the Scenes: Kafka and Cosmos DB boxes stay grey or turn red | The Kafka consumer is not connected, or the machine is revoked (its data is quarantined) | Left menu pill *Kafka: consuming*?; `/api/health` → `kafka.lastError`; Device Visibility status |
| Behind the Scenes: **Show device log** fails | The site gateway `gw-site1` is offline or the VPN is down | **Connect Summary** on Device Visibility; VPN row above |
| The operator app does not start after a deployment | A code problem in the new version | `24-deploy-app.ps1` restores the previous version by itself; otherwise `.\24-deploy-app.ps1 -Rollback`; last resort: [Part 19](part-19-day-2-operations.md), vm-ops disk snapshot |

## 18.1 Looking inside a VM without SSH

```powershell
az vm run-command invoke -g rg-iotmqtt-demo -n vm-ops `
  --command-id RunShellScript `
  --scripts "systemctl status iot-app iot-certsvc --no-pager | head -20"
```

---

[Documentation index](README.md) · [← Part 17 — What we found while building it](part-17-findings.md) · [Part 19 — Day-2 operations and clean-up →](part-19-day-2-operations.md)
