# Part 4 — Build the broker, routing and Kafka

[Documentation index](README.md) · [← Part 3 — Build the networks and the VPN](part-03-networks-and-vpn.md) · [Part 5 — Key Vault and DNS →](part-05-key-vault-and-dns.md)

#### Do it with the script

*PowerShell — about 10 minutes*

```powershell
.\02-messaging.ps1
```

This creates the Event Grid namespace with its MQTT broker, the namespace topic for routing, the Event Hubs namespace with the Kafka endpoint, the two routing subscriptions and the two private endpoints.

#### Do it in the Azure Portal — Event Grid namespace

1. Search **Event Grid Namespaces** → **+ Create** → name `egns-iotmq-xxxxx`, region Indonesia Central, **Throughput units** 1 → **Networking** tab: **Public access** = *Selected IP addresses* and add `192.0.2.1/32` (a documentation address: nothing real can use the public endpoint) → **Tags** → **Create**.
2. Open the namespace → **Settings → Identity** → **System assigned** → **On** → **Save**.
3. **MQTT broker → Configuration**: tick **Enable MQTT broker**, **Maximum session expiry** 1 hour, **Maximum client sessions per authentication name** 2 → **Apply**.
4. **Event Grid → Topics → + Topic**: name `mqtt-routed`, event retention 7 days.
5. **MQTT broker → Routing**: **Enable routing** → topic type **Namespace topic** → topic `mqtt-routed`. Under **Message enrichments** add three *dynamic* enrichments: `site` = `${client.attributes.site}`, `profile` = `${client.attributes.profile}`, `client` = `${client.authenticationName}` → **Apply**.

#### Do it in the Azure Portal — Event Hubs and the routing subscriptions

1. Search **Event Hubs** → **+ Create** → namespace `ehns-iotmq-xxxxx`, pricing tier **Standard** (Kafka needs Standard or higher) → **Advanced** tab: **Local Authentication** *Disabled* → **Networking** tab: *Private access* → **Create**.
2. In the namespace: **Settings → Networking** → allow **trusted Microsoft services** to bypass the firewall → **Save**. Then **Entities → Event Hubs → + Event Hub**: `telemetry` and `alerts`, 2 partitions, retention 1 day.
3. Back in the Event Grid namespace: **Access control (IAM)** of the *Event Hubs namespace* → **+ Add role assignment** → **Azure Event Hubs Data Sender** → *Managed identity* → the Event Grid namespace.
4. Open topic `mqtt-routed` → **+ Subscription** → name `es-telemetry`, delivery mode **Push**, endpoint type **Event Hub** → `telemetry`, **Delivery** with **system-assigned identity** → **Filters** tab: *subject begins with* `iot/telemetry/` → **Create**.
5. Repeat as `es-alerts` → event hub `alerts`, plus an **advanced filter** `data.temperature` *Number is greater than* `75`.

#### Do it in the Azure Portal — private endpoints

1. Event Grid namespace → **Settings → Networking → Private endpoint connections → + Private endpoint** → name `pe-eg-mqtt` → **Resource** tab: target sub-resource **topicSpace** (the MQTT side) → **Virtual Network**: `vnet-hub` / `snet-pe` → **DNS**: integrate with private DNS zone **privatelink.ts.eventgrid.azure.net** → **Create**.
2. Event Hubs namespace → **Networking → Private endpoint connections → + Private endpoint** → `pe-eh`, sub-resource **namespace**, zone **privatelink.servicebus.windows.net**.

> [!NOTE]
> **Why the public endpoint stays *enabled* with one fake IP**
>
> In earlier Event Grid releases, MQTT routing did not work when public network access was **Disabled**. In our proof of concept routing *did* work with access disabled, but Microsoft's documentation still states the limitation, so the demo uses **Selected IP addresses** with a placeholder: functionally private, and supported. Re-test before relying on *Disabled* in production.

> [!IMPORTANT]
> **Checkpoint — do not continue until this is true**
>
> `.\02-messaging.ps1 -VerifyOnly` ends with **0 missing item(s)**.

---

[Documentation index](README.md) · [← Part 3 — Build the networks and the VPN](part-03-networks-and-vpn.md) · [Part 5 — Key Vault and DNS →](part-05-key-vault-and-dns.md)
