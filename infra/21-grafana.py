"""Step 21 - publish the Azure Managed Grafana dashboards for the IT / platform team.

    python 21-grafana.py            (uses 'az' for the Grafana endpoint and an Entra ID token)

Dashboards (folder "Contoso IoT - Event Grid MQTT"):
  1. MQTT broker & routing    connections, publishes, deliveries, routing, retained, throttling,
                              connection failures / disconnections (Event Grid resource logs)
  2. Certificates             issued per method, refusals, server-certificate days left, events
  3. Platform health          Kafka/Event Hubs, VPN tunnel, Cosmos DB, Key Vault, Front Door, VMs
Every query is read-only and runs as the Grafana managed identity (Monitoring Reader on the RG).
Each dashboard starts with a banner: a Contoso Mining (fictional) card on the left and a "Powered by
Azure Event Grid and Event Hubs" card on the right (PNG cards in the brand folder, embedded as data
URIs; rebuild them with brand/make-grafana-cards.py).
"""
import base64
import hashlib
import json
import os
import struct
import subprocess
import sys
import urllib.request
from pathlib import Path

RG = os.environ.get("IOT_RESOURCE_GROUP", "rg-iotmqtt-demo")
SUB = os.environ.get("IOT_SUBSCRIPTION_ID") or subprocess.run(
    "az account show --query id -o tsv", capture_output=True, text=True, shell=True).stdout.strip()
# Same rule as infra\env.ps1: $env:IOT_SUFFIX, or derived from the subscription and resource group.
SFX = os.environ.get("IOT_SUFFIX") or hashlib.sha256(f"{SUB}/{RG}".lower().encode()).hexdigest()[:5]
GRAFANA = f"amg-iotmq-{SFX}"
LAW = f"/subscriptions/{SUB}/resourceGroups/{RG}/providers/Microsoft.OperationalInsights/workspaces/law-iotmq-{SFX}"
GRAFANA_AAD_APP = "ce34e7e5-485f-4d76-964f-b3d2b16d1e4f"


def az(*args):
    out = subprocess.run(["az", *args, "-o", "tsv"], capture_output=True, text=True, shell=True)
    if out.returncode != 0:
        sys.exit(out.stderr)
    return out.stdout.strip()


endpoint = az("rest", "--method", "get", "--url",
              f"https://management.azure.com/subscriptions/{SUB}/resourceGroups/{RG}/providers/Microsoft.Dashboard/grafana/{GRAFANA}?api-version=2026-09-01",
              "--query", "properties.endpoint")
token = az("account", "get-access-token", "--resource", GRAFANA_AAD_APP, "--query", "accessToken")


def grafana(method, path, body=None):
    req = urllib.request.Request(f"{endpoint}{path}", method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"{}")


ds = next(d for d in grafana("GET", "/api/datasources") if d["type"] == "grafana-azure-monitor-datasource")
DS = {"type": ds["type"], "uid": ds["uid"]}
print("Azure Monitor data source:", ds["name"], ds["uid"])


def metric(ref, ns, name, metric_name, agg="Total", legend=None, dims=None, grain="auto"):
    q = {
        "refId": ref, "datasource": DS, "queryType": "Azure Monitor", "subscription": SUB,
        "azureMonitor": {
            "resources": [{"subscription": SUB, "resourceGroup": RG, "metricNamespace": ns, "resourceName": name,
                           "region": "indonesiacentral"}],
            "metricNamespace": ns, "metricName": metric_name, "aggregation": agg, "timeGrain": grain,
            "dimensionFilters": dims or [],
        },
    }
    if legend:
        q["azureMonitor"]["customNamespace"] = ""
        q["azureMonitor"]["alias"] = legend
    return q


def logs(ref, query, fmt="time_series"):
    return {"refId": ref, "datasource": DS, "queryType": "Azure Log Analytics",
            "azureLogAnalytics": {"query": query, "resources": [LAW], "resultFormat": fmt}}


_id = [0]


def panel(kind, title, targets, x, y, w, h, unit=None, desc=None, extra=None):
    _id[0] += 1
    p = {"id": _id[0], "type": kind, "title": title, "datasource": DS, "targets": targets,
         "gridPos": {"x": x, "y": y, "w": w, "h": h}, "fieldConfig": {"defaults": {}, "overrides": []}, "options": {}}
    if unit:
        p["fieldConfig"]["defaults"]["unit"] = unit
    if desc:
        p["description"] = desc
    if kind == "stat":
        p["options"] = {"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False}, "colorMode": "value",
                        "graphMode": "area", "textMode": "auto"}
    if kind == "timeseries":
        p["fieldConfig"]["defaults"]["custom"] = {"drawStyle": "line", "lineWidth": 2, "fillOpacity": 12, "showPoints": "never"}
    if extra:
        for k, v in extra.items():
            p[k] = v
    return p


def thresholds(steps):
    return {"mode": "absolute", "steps": [{"color": c, "value": v} for v, c in steps]}


BRAND = Path(__file__).resolve().parent / "brand"
BANNER_H = 2  # grid rows (about 68 px)


def logo_img(name, alt):
    """<img> with the PNG inlined; the cards are drawn at 2x, so show them at half size."""
    data = (BRAND / name).read_bytes()
    w, h = struct.unpack(">II", data[16:24])
    return (f'<img src="data:image/png;base64,{base64.b64encode(data).decode()}" width="{w // 2}" height="{h // 2}" '
            f'alt="{alt}" title="{alt}" style="max-width:100%;height:auto">')


def banner():
    html = ('<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;height:100%">'
            + logo_img("grafana-iot-card.png", "Contoso Mining (fictional demo company)")
            + logo_img("grafana-powered-card.png", "Powered by Azure Event Grid and Event Hubs")
            + "</div>")
    return {"id": 100, "type": "text", "title": "", "transparent": True,
            "gridPos": {"x": 0, "y": 0, "w": 24, "h": BANNER_H},
            "options": {"mode": "html", "content": html,
                        "code": {"language": "plaintext", "showLineNumbers": False, "showMiniMap": False}}}


def with_banner(panels):
    return [banner()] + [dict(p, gridPos=dict(p["gridPos"], y=p["gridPos"]["y"] + BANNER_H)) for p in panels]


def dashboard(uid, title, panels, desc):
    return {"uid": uid, "title": title, "description": desc, "tags": ["iot", "event-grid", "mqtt"], "timezone": "browser",
            "schemaVersion": 39, "refresh": "30s", "time": {"from": "now-3h", "to": "now"}, "panels": panels}


EG, EGN = "microsoft.eventgrid/namespaces", f"egns-iotmq-{SFX}"
EH, EHN = "microsoft.eventhub/namespaces", f"ehns-iotmq-{SFX}"
# Plain counts are not good or bad: one neutral colour instead of Grafana's default red above 80.
NEUTRAL = {"defaults": {"noValue": "0", "thresholds": thresholds([(None, "blue")])}, "overrides": []}

# ------------------------------------------------------------ 1. broker & routing
p1 = [
    panel("stat", "Connected MQTT clients", [metric("A", EG, EGN, "Mqtt.Connections", "Maximum")], 0, 0, 4, 4,
          desc="Devices, the site gateway, the operator app and the certificate service."),
    panel("stat", "Messages published (range)", [metric("A", EG, EGN, "Mqtt.SuccessfulPublishedMessages", "Total")], 4, 0, 4, 4,
          extra={"options": {"reduceOptions": {"calcs": ["sum"]}, "graphMode": "area"}, "fieldConfig": NEUTRAL}),
    panel("stat", "Routed to namespace topic", [metric("A", EG, EGN, "Mqtt.SuccessfulRoutedMessages", "Total")], 8, 0, 4, 4,
          extra={"options": {"reduceOptions": {"calcs": ["sum"]}, "graphMode": "area"}, "fieldConfig": NEUTRAL}),
    panel("stat", "Routing failures", [metric("A", EG, EGN, "Mqtt.FailedRoutedMessages", "Total")], 12, 0, 4, 4,
          extra={"options": {"reduceOptions": {"calcs": ["sum"]}, "colorMode": "background"},
                 "fieldConfig": {"defaults": {"noValue": "0", "thresholds": thresholds([(None, "green"), (1, "red")])}, "overrides": []}}),
    # Maximum of this gauge always reads 0 in Azure Monitor; Average is the real count.
    panel("stat", "Retained messages", [metric("A", EG, EGN, "Mqtt.RetainedMessagesCount", "Average")], 16, 0, 4, 4,
          desc="Retained status + state per machine and gateway, plus the fleet configuration - the broker keeps them for late joiners."),
    panel("stat", "Throttling enforcements", [metric("A", EG, EGN, "Mqtt.ThrottlingEnforcements", "Total")], 20, 0, 4, 4,
          extra={"options": {"reduceOptions": {"calcs": ["sum"]}, "colorMode": "background"},
                 "fieldConfig": {"defaults": {"noValue": "0", "thresholds": thresholds([(None, "green"), (1, "orange")])}, "overrides": []}}),
    panel("timeseries", "Publish vs deliver (per interval)", [
        metric("A", EG, EGN, "Mqtt.SuccessfulPublishedMessages", "Total"),
        metric("B", EG, EGN, "Mqtt.SuccessfulDeliveredMessages", "Total"),
        metric("C", EG, EGN, "Mqtt.SuccessfulRoutedMessages", "Total")], 0, 4, 12, 8),
    panel("timeseries", "Connections & publish latency", [
        metric("A", EG, EGN, "Mqtt.Connections", "Maximum"),
        metric("B", EG, EGN, "Mqtt.SuccessfulPublishLatencyInMilliseconds", "Average")], 12, 4, 12, 8),
    panel("table", "Connection failures (resource log)", [logs("A",
        "EGNFailedMqttConnections | where $__timeFilter(TimeGenerated) "
        "| project Time = TimeGenerated, Session = SessionName, Result = ResultSignature, Detail = ResultDescription, "
        "Identity = ClientIdentity, Auth = AuthenticationType, Protocol "
        "| order by Time desc | take 50", "table")], 0, 12, 12, 8,
        desc="Refused connects: a revoked client (Client is disabled), a deleted one (Client does not exist), bad certificates, blocked IPs."),
    panel("table", "Disconnections (resource log)", [logs("A",
        "EGNMqttDisconnections | where $__timeFilter(TimeGenerated) "
        "| project Time = TimeGenerated, Session = SessionName, Result = ResultSignature, Detail = ResultDescription, Identity = ClientIdentity "
        "| order by Time desc | take 50", "table")], 12, 12, 12, 8,
        desc="Best effort: the broker does not log every disconnect. ClientInitiatedDisconnect = clean goodbye (renewal reconnects, "
             "and the simulated power loss, which sends MQTT 5 reason 0x04); KeepAliveTimeout = a real power or network loss."),
]

# ------------------------------------------------------------ 2. certificates
CERT_ISSUED = ("AppTraces | where $__timeFilter(TimeGenerated) and Message == 'cert.issued' "
               "| project TimeGenerated = bin(TimeGenerated, 5m), method = tostring(Properties['iot.method']) "
               "| evaluate pivot(method, count(), TimeGenerated) | order by TimeGenerated asc")
p2 = [
    panel("stat", "MQTT endpoint certificate - days left", [logs("A",
        "AppMetrics | where $__timeFilter(TimeGenerated) and Name == 'iot_server_cert_days_left' "
        "| summarize days = min(Min) by bin(TimeGenerated, 5m) | order by TimeGenerated asc")], 0, 0, 6, 5, unit="none",
        extra={"fieldConfig": {"defaults": {"decimals": 2, "thresholds": thresholds([(None, "red"), (2, "orange"), (3.5, "green")])}, "overrides": []},
               "options": {"reduceOptions": {"calcs": ["lastNotNull"]}, "colorMode": "background"}},
        desc="7-day certificate, rotated automatically on day 4 (3 days left)."),
    panel("stat", "Certificates issued (range)", [logs("A",
        "AppTraces | where $__timeFilter(TimeGenerated) and Message == 'cert.issued' | summarize n = count()", "table")], 6, 0, 6, 5,
        extra={"fieldConfig": NEUTRAL}),
    panel("stat", "Requests refused (range)", [logs("A",
        "AppTraces | where $__timeFilter(TimeGenerated) and Message == 'cert.refused' | summarize n = count()", "table")], 12, 0, 6, 5,
        extra={"fieldConfig": {"defaults": {"thresholds": thresholds([(None, "green"), (1, "orange"), (6, "red")])}, "overrides": []},
               "options": {"reduceOptions": {"calcs": ["lastNotNull"]}, "colorMode": "background"}}),
    panel("stat", "Server certificate rotations (range)", [logs("A",
        "AppTraces | where $__timeFilter(TimeGenerated) and Message == 'servercert.rotated' | summarize n = count()", "table")], 18, 0, 6, 5,
        extra={"fieldConfig": NEUTRAL}),
    panel("timeseries", "Device certificates issued per method (enrol / renew over MQTT / re-enrol)", [logs("A", CERT_ISSUED)], 0, 5, 24, 8,
          extra={"fieldConfig": {"defaults": {"custom": {"drawStyle": "bars", "fillOpacity": 70, "stacking": {"mode": "normal"}}}, "overrides": []}}),
    panel("table", "Certificate events", [logs("A",
        "AppTraces | where $__timeFilter(TimeGenerated) and Message in ('cert.issued','cert.refused','device.registered','device.revoked',"
        "'device.restored','device.deleted','servercert.rotated','enrollcert.renewed') "
        "| project Time = TimeGenerated, Event = Message, Client = tostring(Properties['iot.deviceId']), Method = tostring(Properties['iot.method']), "
        "Reason = tostring(Properties['iot.reason']), Serial = tostring(Properties['iot.serial']), Expires = tostring(Properties['iot.notAfter']) "
        "| order by Time desc | take 100", "table")], 0, 13, 24, 10),
]

# ------------------------------------------------------------ 3. platform health
p3 = [
    panel("timeseries", "Event Hubs (Kafka) - in vs out", [
        metric("A", EH, EHN, "IncomingMessages", "Total"), metric("B", EH, EHN, "OutgoingMessages", "Total")], 0, 0, 12, 7,
        desc="In = routed CloudEvents from Event Grid; out = read by Kafka consumers."),
    panel("timeseries", "VPN tunnel (mine site <-> hub)", [
        metric("A", "microsoft.network/virtualnetworkgateways", "vgw-hub", "TunnelIngressBytes", "Total", grain="PT5M"),
        metric("B", "microsoft.network/virtualnetworkgateways", "vgw-hub", "TunnelEgressBytes", "Total", grain="PT5M")], 12, 0, 12, 7, unit="bytes",
        desc="VPN gateway metrics have a 5-minute minimum grain."),
    panel("timeseries", "Cosmos DB request units", [
        metric("A", "microsoft.documentdb/databaseaccounts", f"cosmos-iotmq-{SFX}", "TotalRequestUnits", "Total")], 0, 7, 8, 7),
    panel("timeseries", "Key Vault API hits (HSM signing + certificates)", [
        metric("A", "microsoft.keyvault/vaults", f"kv-iotmq-{SFX}", "ServiceApiHit", "Count")], 8, 7, 8, 7),
    panel("timeseries", "Front Door - requests & origin health", [
        metric("A", "microsoft.cdn/profiles", f"afd-iotmq-{SFX}", "RequestCount", "Total"),
        # Health probes run every 60 s; a 1-minute bucket without a sample reads 0 %, a 5-minute bucket never does.
        metric("B", "microsoft.cdn/profiles", f"afd-iotmq-{SFX}", "OriginHealthPercentage", "Average", grain="PT5M")], 16, 7, 8, 7,
        desc="Requests to ops.iot.example.com and the share of successful health probes to vm-ops (5-minute grain)."),
    panel("timeseries", "VM CPU (vm-ops, vm-site1)", [
        metric("A", "microsoft.compute/virtualmachines", "vm-ops", "Percentage CPU", "Average"),
        metric("B", "microsoft.compute/virtualmachines", "vm-site1", "Percentage CPU", "Average")], 0, 14, 12, 7, unit="percent"),
    panel("timeseries", "VM available memory", [
        metric("A", "microsoft.compute/virtualmachines", "vm-ops", "Available Memory Bytes", "Average"),
        metric("B", "microsoft.compute/virtualmachines", "vm-site1", "Available Memory Bytes", "Average")], 12, 14, 12, 7, unit="bytes"),
]

folder = None
for f in grafana("GET", "/api/folders"):
    if f["title"] == "Contoso IoT - Event Grid MQTT":
        folder = f
if not folder:
    folder = grafana("POST", "/api/folders", {"title": "Contoso IoT - Event Grid MQTT"})

for uid, title, panels, desc in (
        ("iot-mqtt-broker", "Contoso - MQTT broker & routing", p1, "Event Grid namespace MQTT broker: connections, publishes, routing, retained messages, throttling."),
        ("iot-certificates", "Contoso - Certificates", p2, "Automatic certificate lifecycle: device 1-hour certificates, server 7-day certificate, refusals."),
        ("iot-platform", "Contoso - Platform health", p3, "Kafka/Event Hubs, VPN, Cosmos DB, Key Vault, Front Door and VMs.")):
    _id[0] = 0
    r = grafana("POST", "/api/dashboards/db", {"dashboard": dashboard(uid, title, with_banner(panels), desc), "folderUid": folder["uid"],
                                                "overwrite": True, "message": "published by 21-grafana.py"})
    print(f"{r.get('status')}: {title} -> {endpoint}{r.get('url')}")
