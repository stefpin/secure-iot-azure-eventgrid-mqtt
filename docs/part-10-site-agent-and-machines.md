# Part 10 — The mine-site agent and the machines

[Documentation index](README.md) · [← Part 9 — Contoso's own certificate authority](part-09-certificate-authority.md) · [Part 11 — The operator app and Azure Front Door →](part-11-operator-app-and-front-door.md)

#### Do it with the script

*PowerShell — 3 minutes*

```powershell
.\17-site.ps1
```

The script registers the site gateway `gw-site1` (Event Grid client with `type=gateway`), passes its one-time token to vm-site1 together with the public trust bundle, and starts the systemd service `iot-site`. The gateway generates its key, enrols over the VPN and connects. Expected tail of the output:

```json
[site] site agent gw-site1 starting (site site1, broker mqtt.iot.example.com)
[site] enrolled with the one-time token
[site] gateway certificate ready (enroll)
[site] gateway gw-site1 connected (certificate valid to 2026-11-04T01:09:37Z)
```

## 10.1 What a machine does

| When | What the machine agent does |
|---|---|
| First start | Generates an EC P-256 key **on the machine**, sends a CSR + one-time token to `/v1/enroll`, stores key (mode 0600) and 1-hour certificate |
| Connect | MQTT 5 over TLS to `mqtt.iot.example.com:8883`, client ID = user name = certificate CN; **Last Will** = retained `{online:false}`; clean start, so no stale commands are delivered after an outage |
| Once connected | Subscribes to its command, certificate-response and fleet-configuration topics and **waits for the broker's SUBACK**; only then publishes its retained `{online:true}` status, so the operator app never sends a command before the machine can receive it |
| Every 5 s | Publishes telemetry (QoS 1, `contentType application/json`, payload-format indicator 1 so routing filters can read `data.*`) |
| On a command | Validates and answers on the MQTT 5 response topic with the correlation data and a `status` user property (200, 202, 400, 404) |
| Minute 40 of 60 | New key + CSR over MQTT to `iot/cert/site1/<id>/req`, verifies the answer matches the new key, swaps files atomically, reconnects |
| After an outage longer than the certificate | Re-enrols with `/v1/reenroll` by signing the new CSR with the **previous** key (accepted for 24 h) |

> [!NOTE]
> **A brand-new client needs a few seconds**
>
> Right after the certificate service creates an Event Grid client, the broker refused the first CONNECT for up to about 20 seconds with *Not authorized* while the new client propagated. The machine agent retries every 10 seconds for the first 3 minutes after enrolment, then backs off.

---

[Documentation index](README.md) · [← Part 9 — Contoso's own certificate authority](part-09-certificate-authority.md) · [Part 11 — The operator app and Azure Front Door →](part-11-operator-app-and-front-door.md)
