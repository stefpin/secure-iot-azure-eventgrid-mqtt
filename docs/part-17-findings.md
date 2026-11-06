# Part 17 — What we found while building it

[Documentation index](README.md) · [← Part 16 — What it costs](part-16-cost.md) · [Part 18 — Troubleshooting →](part-18-troubleshooting.md)

Each finding below was observed and verified in this environment between 3 and 6 November 2026. Several are not (or not clearly) documented; re-test them before you rely on them in production.

| # | Finding | Evidence | What the demo does |
|---|---|---|---|
| 1 | A **new version** of the custom-domain certificate is not picked up; versioned URLs are rejected; a **new certificate name** is served in 30–90 s; returning to an old name serves the cached old version | Served serial polled every minute for 8 h; ARM error "Only unversioned URL are supported" | Rotation under a new name, served-serial check |
| 2 | The custom domain presents **only the leaf** certificate | TLS capture; root-only clients fail with *unable to get local issuer certificate* | Trust bundle = root + server issuing CA |
| 3 | Disabling, re-grouping or **deleting** a client does **not** end a session that is already open; neither does certificate expiry. The broker refuses the next connect ("Client is disabled", AuthenticationError) | Revoked machines kept publishing 15+ minutes after expiry; deleted client's messages kept being routed; Event Grid resource logs show only client-initiated disconnects | Renewals refused, app quarantines data from non-registered clients, revocation is bounded by the next reconnect |
| 4 | The site must forward the Event Grid zone too | After the CNAME target's 10-second TTL it resolved publicly; TLS EOF from the IP filter | Site resolver forwards `~ts.eventgrid.azure.net` |
| 5 | MQTT routing worked with public access **Disabled** (contrary to the documentation) | PoC test, routed messages counted | Selected IPs with a placeholder, as documented |
| 6 | The CA certificate API wants a single-line base64 body with CRLF | "must be in valid PEM format" for standard PEM | Script formats it |
| 7 | A freshly created client can be refused for ~20 s | CONNACK *Not authorized*, then success | 10-second retries after enrolment |
| 8 | Event Hubs with public access disabled still receives routed events | PoC + this build | Trusted-service delivery with managed identity |
| 9 | The Event Grid **disconnection** and **connection-failure** resource logs are best effort: only some events are recorded | One machine: 4 rows for about 40 reconnects in a day; a 20-second simulated power loss: no row; a revoked machine retrying for 7 minutes: 2 rows *Client is disabled* (5 Nov) | Grafana describes these tables as evidence, not counters; the power-loss banner is driven by the retained status messages |
| 10 | `Mqtt.RetainedMessagesCount`: the **Maximum** aggregation always returns 0; **Average** returns the real count | Metrics API, 1-minute to 1-hour grains: Maximum 0, Average 9 with three machines | Grafana *Retained messages* uses Average |
| 11 | `Mqtt.Connections` (1-minute maximum and minimum) did not show a 20-second outage | Metrics around a simulated power loss at 08:43 UTC | Grafana shows joins and deletions; outages are shown by the app's banner |
| 12 | A just-connected client's subscriptions were not always active when it announced *online*: a command sent at that moment could be lost (HTTP 504) | End-to-end check O11 failed once on 5 Nov | Agents publish *online* only after the broker's SUBACK; three immediate commands to new machines were all answered |
| 13 | Front Door *Origin health percentage* reads **0 %** in a 1-minute bucket that has no health-probe sample | 6 empty minutes in 75; every 5-minute bucket over 6 hours 100 % | Grafana panel pinned to 5 minutes |
| 14 | Data latency: metrics within about 1 minute; Application Insights traces 6–8 s; Event Grid resource logs 26–31 s (median / 90th percentile) | `ingestion_time()` in Log Analytics, 5 Nov | Story timings in [Part 14.3](part-14-run-the-demo.md) |
| 15 | For a few minutes at a time, **one** client's messages reached the subscriber and the routing path about **0.6 s** later than usual (normally 65–90 ms and 40–90 ms). The broker's *publish latency* metric did not show it | Behind the Scenes traces, 6 Nov: PUMP-07 about 0.6 s on both paths in 11 traces over about 10 minutes, PUMP-01 71–94 ms at the same time; metric average 41–44 ms in every 5-minute bucket | Nothing is lost; the presenter script says how to handle it ([Part 14.10](part-14-run-the-demo.md)). For production latency targets, measure end to end, not with the publish metric |

---

[Documentation index](README.md) · [← Part 16 — What it costs](part-16-cost.md) · [Part 18 — Troubleshooting →](part-18-troubleshooting.md)
