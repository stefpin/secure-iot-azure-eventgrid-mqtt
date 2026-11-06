# Part 5 — Key Vault and DNS

[Documentation index](README.md) · [← Part 4 — Build the broker, routing and Kafka](part-04-broker-routing-and-kafka.md) · [Part 6 — Identities, monitoring data and Cosmos DB →](part-06-identities-monitoring-and-cosmos-db.md)

#### Do it with the script

*PowerShell — 5 minutes*

```powershell
.\03-keyvault-dns.ps1
```

Key Vault Premium will hold the CA keys in its HSM. The public DNS zone `iot.example.com` lives in Azure DNS so that Event Grid and Front Door can validate the custom domains; the private zone of the same name answers inside the hub network.

#### Do it in the Azure Portal

1. Search **Key vaults** → **+ Create** → name `kv-iotmq-xxxxx`, pricing tier **Premium**, **Purge protection** on → **Access configuration**: **Azure role-based access control** → **Networking**: disable public access and add private endpoint `pe-kv` (zone **privatelink.vaultcore.azure.net**) → **Create**.
2. Key vault → **Access control (IAM)** → **+ Add role assignment** → **Key Vault Certificate User** → *Managed identity* → the Event Grid namespace. Event Grid reads the custom-domain certificate with this right.
3. Search **DNS zones** → **+ Create** → name `iot.example.com` → **Create**. Open it and note the four **Name servers**.
4. Search **Private DNS zones** → **+ Create** → `iot.example.com` → **Virtual network links → + Add** → `vnet-hub` (do **not** link vnet-site). Add record set `mqtt`, type **CNAME**, alias `egns-iotmq-xxxxx.indonesiacentral-1.ts.eventgrid.azure.net`.

## 5.1 Delegate the subdomain from Cloudflare

1. Sign in to Cloudflare → select **example.com** → **DNS → Records → Add record**.
2. Type **NS**, name `iotdemo`, nameserver = the first Azure name server, TTL **Auto** → **Save**.
3. Repeat for the other three name servers (four NS records in total). Do not touch any other record.
4. Wait 5–10 minutes, then run `Resolve-DnsName iot.example.com -Type NS -Server 1.1.1.1`. You should see the four `azure-dns` servers.

> [!TIP]
> **Only the subdomain moves**
>
> The four NS records hand **only** `iot.example.com` to Azure DNS. Every other name under example.com stays in Cloudflare.

> [!IMPORTANT]
> **Checkpoint — do not continue until this is true**
>
> The script's last line says **delegated** and lists the four Azure name servers.

---

[Documentation index](README.md) · [← Part 4 — Build the broker, routing and Kafka](part-04-broker-routing-and-kafka.md) · [Part 6 — Identities, monitoring data and Cosmos DB →](part-06-identities-monitoring-and-cosmos-db.md)
