# Appendix — Scripts and files

[Documentation index](README.md) · [← Part 19 — Day-2 operations and clean-up](part-19-day-2-operations.md)

| Script | Does | Typical time |
|---|---|---|
| `01-network.ps1` | Resource group, networks, NSGs, public IPs, VPN gateway and connection | 35–50 min |
| `02-messaging.ps1` | Event Grid namespace (MQTT, routing), Event Hubs (Kafka), routing subscriptions, private endpoints | 10 min |
| `03-keyvault-dns.ps1` | Key Vault Premium + private endpoint, public and private DNS zones | 5 min |
| `10-identities-observability.ps1` | Two managed identities, Log Analytics, Application Insights (Entra-only) | 3 min |
| `11-cosmos.ps1` | Cosmos DB serverless, keyless, private; containers; data roles | 10 min |
| `12-vms.ps1` | vm-ops, vm-site1, NSG rules, `enroll` record | 8 min |
| `13-eventgrid.ps1` | Client groups, topic spaces, permission bindings, RBAC | 3 min |
| `14-site-vpn.ps1` | Mine site: public IP, strongSwan, DNS isolation | 8 min |
| `15-pki.ps1` | CA ceremony in the HSM, trust bundle, CA in Event Grid, least privilege | 5 min |
| `16-certsvc.ps1` | Certificate service, nginx, first server certificate, domain validation | 5 min |
| `17-site.ps1` | Site gateway registration and site agent | 3 min |
| `18-app.ps1` | Operator app, nginx, operator password | 6 min |
| `19-frontdoor.ps1` | Front Door, custom domain, origin lock | 5–30 min |
| `20-observability.ps1` | Diagnostic settings, Managed Grafana, action group, alerts | 10 min |
| `21-grafana.py` | Three Grafana dashboards with the Contoso Mining banner | 1 min |
| `brand\make-grafana-cards.py` | Rebuild the banner's logo cards from the source logos in `infra\brand` | seconds |
| `22-update-code.ps1` | Redeploy code only | 3 min |
| `23-tag-sweep.ps1` | Tag resources Azure created implicitly | 1 min |
| `24-deploy-app.ps1` | Operator app only: local checks, backup, verified deploy, health gate with automatic restore; `-Rollback`, `-TraceOff` / `-TraceOn`, `-ListBackups` | 2–3 min |
| `90-test.ps1` | 44-check end-to-end test | 13 min |
| `91-test-trace.ps1` | 7 checks of the Behind the Scenes view (`tests\e2e_trace.py`) | 1 min |
| `ops\app\src\trace\` · `public\trace.*` | The Behind the Scenes view: correlation engine (unit tests in `ops\app\test`), API `/api/trace`, page `trace.html` | — |
| `backups\ops-app-pre-trace-20261106.zip` | Source of the operator app as it was before version 1.2 | — |

---

[Documentation index](README.md) · [← Part 19 — Day-2 operations and clean-up](part-19-day-2-operations.md)
