# Part 6 — Identities, monitoring data and Cosmos DB

[Documentation index](README.md) · [← Part 5 — Key Vault and DNS](part-05-key-vault-and-dns.md) · [Part 7 — The two VMs and the mine site →](part-07-vms-and-the-remote-site.md)

#### Do it with the script

*PowerShell — about 15 minutes*

```powershell
.\10-identities-observability.ps1
.\11-cosmos.ps1
```

## 6.1 Two identities, two jobs

Each workload on vm-ops has its **own** user-assigned managed identity, so neither can do the other's job:

| Identity | Used by | May do |
|---|---|---|
| `id-iotmq-app` | operator web app | Publish on `ts-app-pub`, subscribe on `ts-app-sub` (Entra ID MQTT); read the namespace; read Event Hubs (Kafka); write the Cosmos `telemetry` container only; send telemetry to Application Insights |
| `id-iotmq-certsvc` | certificate service | Sign with the two issuing-CA keys only; manage MQTT server certificates; read the three CA certificates; manage Event Grid clients; publish and subscribe on `ts-certsvc`; write the Cosmos `devices`, `tokens` and `certevents` containers |

#### Do it in the Azure Portal

1. Search **Managed Identities** → **+ Create** → `id-iotmq-app`, region Indonesia Central, tag → **Create**. Repeat for `id-iotmq-certsvc`.
2. Search **Log Analytics workspaces** → **+ Create** → `law-iotmq-xxxxx`. Then **Application Insights → + Create** → `appi-iotmq-xxxxx`, **Resource mode** workspace-based → `law-iotmq-xxxxx`.
3. In Application Insights → **Settings → Properties** → **Local Authentication** → *Disabled*. Telemetry is then accepted only with an Entra ID token, so the connection string is no longer a secret. Give both identities **Monitoring Metrics Publisher** on it (**Access control (IAM)**).

## 6.2 Cosmos DB: serverless, keyless and private

#### Do it in the Azure Portal

1. Search **Azure Cosmos DB** → **+ Create** → **Azure Cosmos DB for NoSQL** → account `cosmos-iotmq-xxxxx`, region Indonesia Central, **Capacity mode** *Serverless* → **Networking**: *Private endpoint* `pe-cosmos` in `vnet-hub/snet-pe` with zone **privatelink.documents.azure.com** → **Security**: *Key-based authentication* **Disable** → **Create**.
2. The Portal's Data Explorer cannot open a private, keyless account from your PC. Create the database and containers with the CLI below (it works over the Azure control plane).

#### Do it in the Azure CLI

```powershell
az cosmosdb sql database create -g rg-iotmqtt-demo -a cosmos-iotmq-xxxxx -n iotmq
az cosmosdb sql container create -g rg-iotmqtt-demo -a cosmos-iotmq-xxxxx `
  -d iotmq -n telemetry -p /deviceId --ttl 604800
# also: devices (/deviceId, no TTL), tokens (/id, --ttl 86400),
#       certevents (/deviceId, --ttl 2592000)
az cosmosdb sql role assignment create -g rg-iotmqtt-demo -a cosmos-iotmq-xxxxx `
  --role-definition-id 00000000-0000-0000-0000-000000000002 `
  --principal-id <id-iotmq-app principalId> --scope /dbs/iotmq/colls/telemetry
```

> [!WARNING]
> **Check the private DNS zone group**
>
> A private endpoint without its **DNS zone group** creates no A records, and the VM then cannot resolve `cosmos-iotmq-xxxxx.documents.azure.com` at all. In this build the CLI's `dns-zone-group show` returned success for a group that did not exist; the script now checks with `list`. In the Portal: **Private endpoint → DNS configuration** must show two FQDNs with 10.40.2.x addresses.

> [!IMPORTANT]
> **Checkpoint — do not continue until this is true**
>
> `.\11-cosmos.ps1` lists `cosmos-iotmq-xxxxx -> 10.40.2.7` and `...-indonesiacentral -> 10.40.2.8` and five data-role lines.

---

[Documentation index](README.md) · [← Part 5 — Key Vault and DNS](part-05-key-vault-and-dns.md) · [Part 7 — The two VMs and the mine site →](part-07-vms-and-the-remote-site.md)
