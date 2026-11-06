# Part 8 — Who may connect and publish what

[Documentation index](README.md) · [← Part 7 — The two VMs and the mine site](part-07-vms-and-the-remote-site.md) · [Part 9 — Contoso's own certificate authority →](part-09-certificate-authority.md)

#### Do it with the script

*PowerShell — 3 minutes*

```powershell
.\13-eventgrid.ps1
```

Event Grid has two independent ways to authorise a client. The demo uses both, deliberately:

| Clients | Authentication | Authorisation |
|---|---|---|
| Machines and the site gateway | X.509 certificate chained to the registered CA `iot-device-ca`; the certificate's common name must equal the client's authentication name | **Client groups** (by attribute `type`) + **permission bindings** to **topic spaces** |
| Operator app and certificate service | Microsoft Entra ID token (MQTT 5 *enhanced authentication*, method `OAUTH2-JWT`, audience `https://eventgrid.azure.net/`) | **Azure RBAC** roles *EventGrid TopicSpaces Publisher* / *Subscriber* on individual topic spaces |

#### Do it in the Azure Portal

1. Namespace → **MQTT broker → Client groups → + Client group**: `cg-devices`, query `attributes.type = 'device'`; `cg-gateways`, query `attributes.type = 'gateway'`.
2. **Topic spaces → + Topic space**: create the seven spaces of the table below. Templates use `${client.attributes.site}` and `${client.authenticationName}` so a client can only reach its own topics.
3. **Permission bindings → + Permission binding**: `pb-dev-pub` (cg-devices → ts-dev-pub, *Publisher*), `pb-dev-sub` (cg-devices → ts-dev-sub, *Subscriber*), `pb-gw-pub`, `pb-gw-sub` likewise for cg-gateways.
4. For the Entra ID clients open a topic space (for example `ts-app-pub`) → **Access control (IAM)** → **+ Add role assignment** → **EventGrid TopicSpaces Publisher** → *Managed identity* → `id-iotmq-app`. Repeat as in the identities table of [Part 6](part-06-identities-monitoring-and-cosmos-db.md).

| Topic space | Topic templates |
|---|---|
| ts-dev-pub | `iot/telemetry/${site}/${name}` · `iot/status/…` · `iot/state/…` · `iot/cmdres/…` · `iot/cert/${site}/${name}/req` |
| ts-dev-sub | `iot/cmd/${site}/${name}/#` · `iot/cert/${site}/${name}/res` · `iot/config/fleet` |
| ts-gw-pub | `iot/site/${site}/sim/res` · `iot/status/…` · `iot/state/…` · `iot/cert/${site}/${name}/req` |
| ts-gw-sub | `iot/site/${site}/sim/req` · `iot/config/fleet` · `iot/cert/${site}/${name}/res` |
| ts-app-pub | `iot/cmd/#` · `iot/config/#` · `iot/site/+/sim/req` · `iot/status/#` · `iot/state/#` |
| ts-app-sub | `iot/telemetry/#` · `iot/status/#` · `iot/state/#` · `iot/cmdres/#` · `iot/site/+/sim/res` · `iot/config/#` |
| ts-certsvc | `iot/cert/+/+/req` · `iot/cert/+/+/res` |

In the table `${site}` stands for `${client.attributes.site}` and `${name}` for `${client.authenticationName}`.

---

[Documentation index](README.md) · [← Part 7 — The two VMs and the mine site](part-07-vms-and-the-remote-site.md) · [Part 9 — Contoso's own certificate authority →](part-09-certificate-authority.md)
