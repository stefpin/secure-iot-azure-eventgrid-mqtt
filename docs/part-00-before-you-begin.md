# Part 0 — Before you begin

[Documentation index](README.md) · [Part 1 — How the demo works →](part-01-how-the-demo-works.md)

This guide builds, runs and presents a complete Internet of Things (IoT) demonstration for Contoso Mining on the **Azure Event Grid MQTT broker**. It is written so that someone who has never used Azure IoT can follow it from an empty subscription to a working demo, and so that a presenter can run the demo with confidence.

## 0.1 What the demo shows

| Customer requirement | Where it is shown | Status |
|---|---|---|
| Same capabilities as the IoT Hub demo: device registry, profiles, live telemetry, history, cloud-to-device commands | Operator app: Device Visibility, Monitoring Dashboard ([Part 14](part-14-run-the-demo.md), scenes 1–4) | Built and tested |
| Custom web app for operators (live view and commands) | `https://ops.iot.example.com` behind Azure Front Door ([Part 11](part-11-operator-app-and-front-door.md)) | Built and tested |
| Azure Managed Grafana for the IT / platform team | Three dashboards + nine alert rules ([Part 12](part-12-monitoring-for-it.md)) and a demo story for each dashboard ([Part 14.3](part-14-run-the-demo.md)–14.7) | Built and tested |
| Certificates on every device, generated and renewed automatically | Private CA in Key Vault HSM, 1-hour device certificates renewed over MQTT (Parts 9–10, scenes 5–7) | Built and tested |
| Private link and a custom domain between devices and the broker | `mqtt.iot.example.com` → private endpoint 10.40.2.4 over a site-to-site VPN (Parts 3–5) | Built and tested |
| A realistic remote site | Mine-site VM in its own network, IPsec VPN to the hub, no Azure identity | Built and tested |
| Routing in the Event Grid MQTT broker | Namespace topic with enrichments and a payload filter for alerts (scene 9) | Built and tested |
| Retained messages | Device status with Last Will, device state, fleet configuration, late-joiner test (scenes 8, 10) | Built and tested |
| Clear notification when a machine is back after a power loss | Monitoring Dashboard power-loss banner and online / offline status ([Part 14.2](part-14-run-the-demo.md), scene 8) | Built and tested |
| Integration with a Kafka-compatible system | Event Hubs Kafka endpoint consumed by the app with Entra ID (scene 9) | Built and tested |
| Show the inner workings of the Azure services, end to end in both directions | **Behind the Scenes** page and act: one reading from the machine to Cosmos DB, one command from the browser to the machine and back, plus the Azure portal and Log Analytics evidence ([Part 14.9](part-14-run-the-demo.md)–14.14) | Built and tested (1.2) |
| Best practices for the Event Grid MQTT broker | [Part 15](part-15-best-practices.md) | Written |
| Cost of the overall solution | [Part 16](part-16-cost.md) and the Excel cost model | Written |

## 0.2 What you need

| Item | Why | How to check |
|---|---|---|
| An Azure subscription where you are **Owner** of a resource group | The scripts create about 60 resources and assign roles | Portal → **Subscriptions** → your subscription → **Access control (IAM)** → **View my access** |
| A DNS domain you control (this guide uses **example.com** on Cloudflare) | The custom MQTT domain and the operator URL need public DNS records | You can log in to the DNS provider and add records |
| A Windows PC with PowerShell 5.1 or 7, Azure CLI 2.60+ and Python 3.10+ | All scripts run from this PC; nothing needs SSH | `az version`, `python --version` |
| About 3 hours the first time (the VPN gateway alone takes 30–45 minutes) |  |  |
| About USD 318 a month while everything runs | See [Part 16](part-16-cost.md); stopping the two VMs between demos saves about USD 62 a month |  |

## 0.3 Words used in this guide

| Term | Meaning in plain words |
|---|---|
| MQTT | A small, fast publish/subscribe protocol for devices. A device **publishes** a message on a **topic** (like `iot/telemetry/site1/PUMP-01`); anyone **subscribed** to that topic receives it. |
| Event Grid namespace / MQTT broker | The Azure service that receives and forwards the MQTT messages. One namespace = one broker. |
| Client | Anything that connects to the broker: a machine, the site gateway, the operator app. Each client has an **authentication name**. |
| Topic space / permission binding | A topic space is a named set of topic patterns; a permission binding lets a **client group** publish or subscribe on it. |
| Retained message | The last message on a topic that the broker keeps and gives to every new subscriber at once. |
| Last Will | A message a client leaves with the broker at connect time; the broker publishes it if the connection drops without a goodbye. |
| Routing | Copies every MQTT message into an Event Grid **namespace topic**, from where **subscriptions** deliver them, filtered, to other services. |
| Kafka | A popular streaming protocol. **Event Hubs** speaks it on port 9093, so any Kafka tool can read the routed data. |
| X.509 certificate | A digital ID card for a device, signed by a **certificate authority (CA)**. The device proves it owns the card with its **private key**, which never leaves it. |
| HSM | Hardware security module. Key Vault **Premium** keeps the CA keys in one; they can sign but can never be exported. |
| Private endpoint | A private IP address in your own network that leads to an Azure service, so traffic never crosses the internet. |
| Managed identity | An identity Azure gives to a VM or service so it can sign in to other Azure services without any password or key. |

> [!WARNING]
> **Read this before you start: built for a governed subscription**
>
> The demo was built in a subscription with strict automatic governance — the kind many enterprises run: untagged resources can be stopped or downgraded, Key Vault and Cosmos DB are forced to **public network access Disabled**, endpoint protection is installed on every VM, an empty network security group is attached to any subnet without one, and **inbound SSH rules are removed** within minutes. (`CostControl=Ignore` in `infra\env.ps1` is that subscription's example tag; use your own.)
>
> Every script in this guide therefore tags what it creates, uses private endpoints instead of public access, and never needs SSH: all VM work goes through `az vm run-command`.

## 0.4 Names and addresses used throughout

| What | Value in this guide |
|---|---|
| Subscription / region | your-subscription · **Indonesia Central** (`indonesiacentral`) |
| Resource group | `rg-iotmqtt-demo` (suffix for globally unique names: `xxxxx`) |
| Event Grid namespace | `egns-iotmq-xxxxx` — default MQTT host `egns-iotmq-xxxxx.indonesiacentral-1.ts.eventgrid.azure.net` |
| Device-facing MQTT host | `mqtt.iot.example.com` (custom domain, port 8883) |
| Enrolment endpoint (private) | `https://enroll.iot.example.com/v1` → 10.40.1.10 |
| Operator URL | `https://ops.iot.example.com` (user `iot-operator`) |
| Grafana | `https://amg-iotmq-xxxxx-<hash>.<region>.grafana.azure.com` |
| Hub network | `vnet-hub` 10.40.0.0/16 — snet-app 10.40.1.0/24, snet-pe 10.40.2.0/27, GatewaySubnet 10.40.255.0/27 |
| Mine-site network | `vnet-site` 10.50.0.0/16 — snet-site 10.50.1.0/24 |
| VMs | `vm-ops` 10.40.1.10 (app, certificate service, DNS forwarder) · `vm-site1` 10.50.1.10 (simulated mine site) |

If you build your own copy, change the suffix and the domain in `infra\env.ps1` once; every script reads them from there.

---

[Documentation index](README.md) · [Part 1 — How the demo works →](part-01-how-the-demo-works.md)
