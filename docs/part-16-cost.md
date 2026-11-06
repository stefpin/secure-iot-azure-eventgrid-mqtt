# Part 16 — What it costs

[Documentation index](README.md) · [← Part 15 — Best practices for the Event Grid MQTT broker](part-15-best-practices.md) · [Part 17 — What we found while building it →](part-17-findings.md)

Prices are Azure retail pay-as-you-go prices in USD for Indonesia Central, checked against the Azure Retail Prices API on 4 November 2026. Every line was priced from the Azure Retail Prices API; device count, message rate and hours are the inputs.

| Scenario | USD / month | Notes |
|---|---|---|
| Demo running 24 x 7 | 317.58 | All deployed demo resources for 730 h/month: 5 simulated machines + 1 site gateway, telemetry every 5 s (~1 KB, QoS 1), routed to Event Hubs and Cosmos DB. |
| Demo with both VMs deallocated | 255.09 | VM compute stops (saves 62.49 USD); OS disks, public IPs, VPN gateway, private endpoints, Grafana, Front Door and all other resources keep billing. The 28.12 USD of usage charges included here also falls away while no telemetry flows. |
| Production pilot | 1,369.82 | 500 machines, 1 msg every 10 s; 1 Event Grid TU, Event Hubs Standard, VpnGw1AZ, 2 x D2as_v5, Cosmos DB provisioned, DNS Private Resolver inbound endpoint, Managed Grafana Standard. |
| Production at scale | 13,090.32 | 5,000 machines, 1 msg every 5 s; 2 Event Grid TU, Event Hubs Premium (1 PU), 3 x D4as_v5; Event Grid charges 8,965 USD/month, almost all per-operation. |

| Service (demo running 24 × 7) | USD / month | Basis |
|---|---|---|
| Event Grid namespace (1 TU, MQTT broker) | 36.59 | 0.04 USD/h x 730 h x 1 TU + 4.83 M MQTT ops x 1.00 USD/M + 4.28 M event ops x 0.60 USD/M (first 1 M of each free) |
| Event Hubs Standard (1 TU) | 21.97 | 0.03 USD/h x 730 h x 1 TU + 2.63 M ingress events x 0.028 USD/M; Kafka endpoint modelled as included |
| Virtual machines (2 x B2als_v2) | 62.49 | 0.0428 USD/h x 730 h x 2 |
| Managed disks (2 x Standard SSD E4 32 GiB) | 6.80 | 2.40 USD/month x 2 + est. 5 M transactions per disk x 0.002 USD/10K |
| Public IP addresses (3 x Standard static) | 10.95 | 0.005 USD/h x 730 h x 3 |
| VPN Gateway (Basic) | 26.28 | 0.036 USD/h x 730 h |
| Private endpoints (4) | 29.30 | 0.01 USD/h x 730 h x 4 + 5.01 GB x 0.01 USD/GB in and out |
| Key Vault Premium (HSM keys, operations, certificates) | 20.16 | 2 x 1.00 USD RSA 2048 HSM key + 1 x 5.00 USD RSA 3072 key + operations 0.16 USD + 4.33 certificate renewals x 3.00 USD (if billed) |
| Cosmos DB serverless | 4.97 | 15.77 M RU x 0.2565 USD/M + 3.71 GB x 0.25 USD/GB-month |
| Log Analytics / Application Insights | 13.45 | (10 GB - 5 GB free) x 2.691 USD/GB |
| Azure Managed Grafana Standard | 41.21 | 0.040014 USD/h x 730 h + 2 users x 6.00 USD |
| Azure Front Door Standard | 35.89 | 35.00 USD base fee + requests and data transfer 0.89 USD |
| Azure DNS (6 hosted zones) | 3.00 | 0.50 USD x 6 zones (1 public + 5 private) |
| Azure Monitor alerts (6 metric + 3 log) | 4.50 | 3 log alert rules (5-min) x 1.50 USD; 6 metric time series within the 10 free |

> [!TIP]
> **Assumptions checked against the first bills**
>
> **Kafka endpoint — confirmed included.** The billing data of the first days showed only the Event Hubs *Standard Throughput Unit* and *Standard Ingress Events* meters for the namespace; no Kafka meter appeared.
>
> **Server-certificate rotation:** counted as a billed Key Vault certificate renewal (USD 3 each).
>
> **MQTT keep-alives** are counted as billable operations (conservative); **log alerts** run every 5 minutes (USD 1.50 per rule); the first 10 metric time series are free.
>
> Azure retail prices checked on 2026-11-04 for Indonesia Central (private endpoints, Front Door and DNS are priced globally or by zone). Data transfer and taxes are excluded.
>
> **Not in the totals: Microsoft Defender for Servers.** If your organisation's policy enables Defender for Servers Plan 2 on every VM, add about USD 0.027 per VM-hour (roughly USD 40 a month for the two VMs while they run). Deallocated VMs are not charged.

> [!NOTE]
> **What drives the bill**
>
> In the demo, **fixed** items dominate: the two VMs, Front Door's base fee, Managed Grafana, the private endpoints, the VPN gateway and the Event Grid and Event Hubs throughput units. The per-message cost of a handful of simulated machines is a few dollars.
>
> In production the picture changes: MQTT operations (each publish and each delivery), routed event operations and the number of Event Grid throughput units grow with the fleet; network (VpnGw1AZ or ExpressRoute) and DNS Private Resolver replace the demo shortcuts.

> [!TIP]
> **Saving money between demos**
>
> Deallocate the two VMs: `az vm deallocate -g rg-iotmqtt-demo -n vm-ops` and the same for `vm-site1`. Everything else keeps running (certificates in devices then expire; the machines re-enrol within 24 hours when started again, or need a new token after that).

---

[Documentation index](README.md) · [← Part 15 — Best practices for the Event Grid MQTT broker](part-15-best-practices.md) · [Part 17 — What we found while building it →](part-17-findings.md)
