# Part 15 — Best practices for the Event Grid MQTT broker

[Documentation index](README.md) · [← Part 14 — Run the demo (presenter script)](part-14-run-the-demo.md) · [Part 16 — What it costs →](part-16-cost.md)

## 15.1 Identity and certificates

| Practice | How the demo applies it |
|---|---|
| Prefer CA-chain authentication over thumbprints | One registered issuing CA authenticates every device; renewals need no change in Event Grid |
| Short-lived device certificates with automatic renewal | 1 hour, renewed over MQTT at 2/3 of the lifetime; re-enrolment with proof of possession within 24 h |
| Generate keys on the device; never ship a key | EC P-256 key created by the agent; enrolment uses a single-use token bound to one device |
| Protect the CA keys in an HSM; keep the root offline | Key Vault Premium RSA-HSM keys; root key disabled after signing; issuing CAs name-constrained |
| Use a separate production CA | The demo CA is never reused; production repeats the ceremony (or uses a managed PKI with this service as the registration authority) |
| Use Entra ID for cloud workloads | App and certificate service authenticate with managed-identity tokens; no shared secrets anywhere |
| Plan server-certificate rotation around Event Grid's caching | New Key Vault certificate **name** per rotation, served-serial check, rotation 3 days before expiry, alert at &lt; 2 days |

## 15.2 Authorisation and topics

| Practice | How the demo applies it |
|---|---|
| Put identity into the topic, not the payload | Topic templates use `${client.authenticationName}` and `${client.attributes.site}` — a client can only use its own topics |
| Separate publish and subscribe spaces per role | Seven topic spaces; devices cannot read telemetry or send commands; the app cannot answer certificate requests |
| Least-privilege RBAC at topic-space scope | Entra clients get Publisher / Subscriber on individual topic spaces, not on the namespace |
| Limit sessions per authentication name | 2 (namespace setting) — enough for one client plus a diagnostic session |
| Use MQTT 5 request/response for commands | Response topic + correlation data, status in a user property, message expiry 30 s so late commands are dropped, clean-start sessions on devices |
| Use retained messages for state, Last Will for presence | Status, state and fleet configuration are retained; the broker publishes *offline* on abnormal disconnects |
| Do not trust revocation to cut live sessions | Disabled or deleted clients are refused at the next connect; consumers quarantine data from non-registered clients ([Part 17](part-17-findings.md)) |

## 15.3 Networking

| Practice | How the demo applies it |
|---|---|
| Private endpoints for the broker and every data service | Event Grid (topicSpace), Event Hubs, Key Vault, Cosmos DB — all on 10.40.2.0/27 |
| Keep the broker's public endpoint closed | Selected IPs with a documentation placeholder; devices only use the private endpoint |
| Forward the service zone from remote sites | Sites forward `iot.example.com` **and** `ts.eventgrid.azure.net` to the hub resolver; production: Azure DNS Private Resolver |
| Use a resilient site connection | Demo: Basic VPN; production: VpnGw1AZ+ (zone-redundant) or ExpressRoute |
| Custom domain for devices, namespace host for cloud workloads | Devices use `mqtt.iot.example.com` (Contoso CA); cloud apps use the namespace host (Microsoft certificate), so operations keep working if the custom certificate fails |

## 15.4 Routing, Kafka and operations

| Practice | How the demo applies it |
|---|---|
| Route to a namespace topic, filter in subscriptions | One namespace topic; `es-telemetry` by subject, `es-alerts` by `data.temperature > 75` |
| Send JSON with content type and payload-format indicator | Required for filters on `data.*` fields and for structured CloudEvents |
| Add enrichments instead of trusting payload fields | `site`, `profile`, `client` come from the client registry, not from the device's JSON |
| Consume with Kafka and Entra ID | SASL OAUTHBEARER with managed identity; Event Hubs SAS disabled; history in Cosmos DB |
| Separate live and durable paths | MQTT for live views; Kafka/Event Hubs (retention, consumer groups, replay) for history and integrations |
| Size throughput units from measured load | Watch *Mqtt.Throttling enforcements* and publish rates in Grafana; add TUs before limits are reached |
| Monitor the broker and the PKI together | Resource logs + metrics + certificate-service telemetry in one workspace; Grafana + alerts |

---

[Documentation index](README.md) · [← Part 14 — Run the demo (presenter script)](part-14-run-the-demo.md) · [Part 16 — What it costs →](part-16-cost.md)
