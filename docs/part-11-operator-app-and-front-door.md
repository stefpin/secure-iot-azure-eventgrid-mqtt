# Part 11 — The operator app and Azure Front Door

[Documentation index](README.md) · [← Part 10 — The mine-site agent and the machines](part-10-site-agent-and-machines.md) · [Part 12 — Monitoring for the IT team →](part-12-monitoring-for-it.md)

#### Do it with the script

*PowerShell — about 15 minutes (the managed certificate can take up to 30)*

```powershell
.\18-app.ps1 -PasswordFile C:\iot-secrets\ops-ui-password.txt
.\19-frontdoor.ps1
```

`18-app.ps1` installs the Node.js app as the systemd service `iot-app` and puts nginx in front of it. The operator password is generated into your password file (line 1 user, line 2 password) and stored on the VM only as a bcrypt hash. `19-frontdoor.ps1` publishes it:

| Front Door object | Value |
|---|---|
| Profile | `afd-iotmq-xxxxx`, **Standard_AzureFrontDoor** (global) |
| Endpoint | `ops-iotmq-xxxxx-<hash>.b02.azurefd.net` |
| Origin group / origin | `og-ops` → `vm-ops` = `ops-iotmq-xxxxx.indonesiacentral.cloudapp.azure.com`, HTTP 80, health probe `GET /healthz` every 60 s |
| Custom domain | `ops.iot.example.com`, **Front Door managed certificate**, TLS 1.2 minimum; validation TXT `_dnsauth.ops` and CNAME `ops` in the Azure public zone |
| Route | `rt-ops`: HTTPS only (HTTP redirects), forwarding HTTP, no caching |
| Origin lock | NSG: port 80 from `AzureFrontDoor.Backend` only; nginx: 403 unless `X-Azure-FDID` = this profile's ID |

#### Do it in the Azure Portal

1. Search **Front Door and CDN profiles → + Create → Azure Front Door → Custom create** → name `afd-iotmq-xxxxx`, tier **Standard** → **Endpoint** tab: add endpoint `ops-iotmq-xxxxx` → **Add a route**: origin group `og-ops` with origin type **Custom**, host name = the DNS name of `pip-ops`, HTTP port 80; health probe path `/healthz`; accepted protocols HTTP and HTTPS, **Redirect all traffic to HTTPS**, forwarding protocol **HTTP only**, caching off → **Create**.
2. Profile → **Settings → Domains → + Add** → DNS management **Azure managed DNS**, zone `iot.example.com`, custom domain `ops`, certificate **AFD managed** → **Add**. Click **Pending** → **Add** to create the TXT record, then associate the domain with the endpoint and route.
3. Profile → **Overview** → copy **Front Door ID**; on vm-ops put it into `/etc/nginx/iot-fdid.conf` (the script does this).

> [!TIP]
> **Sign-in for operators**
>
> The demo uses nginx basic authentication so that no change is needed outside the resource group. For production, put Microsoft Entra ID sign-in in front of the app (App Service authentication or an Entra-protected reverse proxy); that needs an app registration in the tenant.

> [!IMPORTANT]
> **Checkpoint — do not continue until this is true**
>
> From any browser `https://ops.iot.example.com` asks for a user name and password, and shows the app after sign-in. `http://<pip-ops address>/` does not answer at all.

## 11.1 The app's pages

| Page | What it shows | Event Grid feature |
|---|---|---|
| Device Visibility | Machines, profile, certificate serial and live countdown, status; Create, Connect, Script, Revoke/Restore, Delete | Clients, retained status + Last Will |
| Device Onboarding | The onboarding script per profile with the one-time token and trust bundle | Certificate enrolment |
| Monitoring Dashboard | Gauge, motor setpoint, thermal alarm, message counter, certificate widget, history chart; the machine's **online / offline status** next to the timestamp and the **power-loss banner** ([Part 14.2](part-14-run-the-demo.md)) | MQTT pub/sub, request/response, retained status + Last Will |
| Certificates | CA hierarchy, MQTT endpoint certificate + Rotate Now, every client's certificate, audit trail | Custom domain, CA-chain auth |
| Retained Messages | Every retained topic, Clear, **Late-Joiner Test** | Retained messages |
| Message Pipeline | Routing subscriptions, routed alerts, live CloudEvents from Kafka with enrichments | Routing, Kafka |
| Fleet Config | Telemetry interval and renewal point, published retained | Retained messages |
| Behind the Scenes (new in 1.2) | Follows one real reading from a machine to Cosmos DB and one command from the browser to the machine and back, with the time every Azure service gave it; the machine's own log ([Part 14.9](part-14-run-the-demo.md)–14.14) | Routing, CloudEvents, Kafka, MQTT 5 request/response, Front Door |

---

[Documentation index](README.md) · [← Part 10 — The mine-site agent and the machines](part-10-site-agent-and-machines.md) · [Part 12 — Monitoring for the IT team →](part-12-monitoring-for-it.md)
