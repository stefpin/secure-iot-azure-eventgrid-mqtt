# Part 12 — Monitoring for the IT team

[Documentation index](README.md) · [← Part 11 — The operator app and Azure Front Door](part-11-operator-app-and-front-door.md) · [Part 13 — Test everything →](part-13-test-everything.md)

#### Do it with the script

*PowerShell — about 15 minutes*

```powershell
$me = az ad signed-in-user show --query id -o tsv
.\20-observability.ps1 -AlertEmail you@company.com -AdminObjectId $me
python .\21-grafana.py
```

| What | Detail |
|---|---|
| Diagnostic settings → `law-iotmq-xxxxx` | Event Grid (MQTT connections, failures, disconnections, failed publishes and subscriptions), Event Hubs, Key Vault (audit), Cosmos DB (control plane), VPN gateway, Front Door, plus all metrics |
| Azure Managed Grafana `amg-iotmq-xxxxx` | Standard tier, Grafana 12; its identity has **Monitoring Reader** on the resource group only; you get **Grafana Admin** on the instance |
| Dashboards (folder *Contoso IoT - Event Grid MQTT*) | **MQTT broker & routing** · **Certificates** · **Platform health** (Kafka, VPN, Cosmos DB, Key Vault, Front Door, VMs) — each starts with the Contoso Mining banner; [Part 14.3](part-14-run-the-demo.md)–14.7 tells the story of each one |
| Action group `ag-iotmq-ops` | e-mail to the platform team |
| Metric alerts | routing failures > 0 · throttling > 0 · failed publishes > 10/5 min · Event Hubs throttled · no VPN traffic for 15 min · Front Door origin unhealthy |
| Log alerts | > 5 certificate refusals in 15 min · MQTT endpoint certificate &lt; 2 days left · certificate service silent for 30 min |

#### Do it in the Azure Portal

1. For each service: open it → **Monitoring → Diagnostic settings → + Add diagnostic setting** → tick the log categories and **AllMetrics** → **Send to Log Analytics workspace** `law-iotmq-xxxxx`, destination table **Resource specific**.
2. Search **Azure Managed Grafana → + Create** → `amg-iotmq-xxxxx`, pricing plan **Standard** → **Permission**: *Add role assignment to grant Grafana Admin to me* → **Create**. Then on the **resource group** → **Access control (IAM)** → **Monitoring Reader** → *Managed identity* → the Grafana instance.
3. Open the Grafana endpoint → **Dashboards → New → Import** if you prefer to paste dashboard JSON; `21-grafana.py` does it through the Grafana API with your Entra ID token.
4. **Monitor → Alerts → Action groups → + Create** (e-mail), then **Alert rules → + Create** for each rule in the table.

> [!NOTE]
> **Practical details**
>
> VPN gateway metrics only exist at a **5-minute** grain; a Grafana panel with an automatic 1-minute grain fails. The VPN panel is pinned to 5 minutes, and so is Front Door's origin health (a 1-minute bucket without a health-probe sample reads 0 %).
>
> Log alerts on Application Insights data must target the **Log Analytics workspace** (tables `AppTraces`, `AppMetrics`); targeting the Application Insights resource uses the classic table names and fails.
>
> *Retained messages* uses the **Average** aggregation: the metric's *Maximum* always reads 0 ([Part 17](part-17-findings.md), finding 10).

---

[Documentation index](README.md) · [← Part 11 — The operator app and Azure Front Door](part-11-operator-app-and-front-door.md) · [Part 13 — Test everything →](part-13-test-everything.md)
