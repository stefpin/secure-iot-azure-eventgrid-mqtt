# Part 19 — Day-2 operations and clean-up

[Documentation index](README.md) · [← Part 18 — Troubleshooting](part-18-troubleshooting.md) · [Appendix — Scripts and files →](appendix-scripts-and-files.md)

| Task | How |
|---|---|
| Change app or agent code | `.\22-update-code.ps1` (`-Ops`, `-Site` or both); then `.\90-test.ps1 -Quick` |
| Deploy only the operator app, safely | `.\24-deploy-app.ps1` — checks the code locally (syntax, unit tests), backs up the running app on vm-ops (`/opt/iot/backup`, the 5 newest are kept), ships and verifies the files, restarts **only** `iot-app` and restores the backup by itself if the app is not healthy within 2 minutes. Unlike `22-update-code.ps1 -Ops` it never restarts the certificate service |
| Go back to the previous operator app | `.\24-deploy-app.ps1 -Rollback` (latest backup) or `-Rollback -Backup app-<stamp>`; `-ListBackups` shows them |
| Switch the Behind the Scenes view off / on | `.\24-deploy-app.ps1 -TraceOff` / `-TraceOn` — about 15 seconds; everything else is unchanged |
| Last resort: restore vm-ops from its disk snapshot | Snapshot `snap-vm-ops-pre-trace-20261106` (taken before version 1.2). Portal → the snapshot → **+ Create disk**; then **vm-ops → Stop** → **Disks → Swap OS disk** → the new disk → **Start**. About 15 minutes; the app then runs version 1.1 |
| Delete the safety snapshot when it is no longer needed | `az snapshot delete -g rg-iotmqtt-demo -n snap-vm-ops-pre-trace-20261106` (about USD 1–2 a month while it exists) |
| Change a Grafana dashboard | Edit `infra\21-grafana.py`, then `python .\21-grafana.py` — it overwrites the three dashboards, so edits made in the Grafana UI are lost |
| Stop / start for the night | `az vm deallocate` / `az vm start` for vm-ops and vm-site1 |
| Tag anything Azure created by itself | `.\23-tag-sweep.ps1` |
| Renew the MQTT endpoint certificate now | Certificates page → **Rotate Now** (or wait — it happens on day 4) |
| Rotate the issuing CAs (every 2 years) | Re-enable `iot-root-ca` for the ceremony, issue new issuing CAs, add the new device CA to Event Grid **before** removing the old one, distribute the new trust bundle through the enrolment response, disable the root again |
| Remove everything | `az group delete -n rg-iotmqtt-demo` — then delete the four NS records `iotdemo` in Cloudflare. Key Vault keeps the soft-deleted vault (purge protection) for 90 days. |

> [!WARNING]
> **Before deleting**
>
> Deleting the resource group destroys the demo CA keys for good — which is what you want for a demo CA. Never delete a production CA vault this way.

---

[Documentation index](README.md) · [← Part 18 — Troubleshooting](part-18-troubleshooting.md) · [Appendix — Scripts and files →](appendix-scripts-and-files.md)
