# Part 7 — The two VMs and the mine site

[Documentation index](README.md) · [← Part 6 — Identities, monitoring data and Cosmos DB](part-06-identities-monitoring-and-cosmos-db.md) · [Part 8 — Who may connect and publish what →](part-08-mqtt-authorisation.md)

#### Do it with the script

*PowerShell — about 20 minutes*

```powershell
.\12-vms.ps1
.\14-site-vpn.ps1 -PskFile C:\iot-secrets\vpn-psk.txt
```

| VM | Size / image | Settings that matter |
|---|---|---|
| `vm-ops` | Standard_B2als_v2 (2 vCPU, 4 GiB), Ubuntu 24.04, Trusted Launch | Static IP 10.40.1.10; both user-assigned identities; public IP `pip-ops` used only as the Front Door origin; cloud-init installs nginx, dnsmasq, Node.js 24 and the Python packages |
| `vm-site1` | Standard_B2als_v2, Ubuntu 24.04, Trusted Launch | Static IP 10.50.1.10; **no identity**; takes over `pip-site` (the VPN peer address); private subnet, so packages install only after the public IP is attached |

`12-vms.ps1` also adds three rules to `nsg-app` and the private DNS record `enroll` → 10.40.1.10:

| Rule | From | To | Why |
|---|---|---|---|
| Allow-Site-DNS | 10.50.0.0/16 | 10.40.1.10:53 | the site's resolver asks the hub forwarder |
| Allow-Site-Enroll | 10.50.0.0/16 | 10.40.1.10:443 | machines enrol over private HTTPS |
| Allow-FrontDoor-HTTP | AzureFrontDoor.Backend | 10.40.1.10:80 | only Front Door reaches the operator app |

#### Do it in the Azure Portal

1. Search **Virtual machines → + Create → Azure virtual machine** → name `vm-ops`, region Indonesia Central, **Security type** *Trusted launch*, image **Ubuntu Server 24.04 LTS**, size **Standard_B2als_v2**, authentication *SSH public key* (it is never used — management goes through **Run command**) → **Disks**: Standard SSD → **Networking**: `vnet-hub/snet-app`, NIC network security group *None* (the subnet NSG applies) → **Management**: identity → **User assigned** → add both identities → **Advanced**: paste `infra\cloud-init-ops.yaml` into **Custom data** → **Tags** → **Create**. Then **Networking → Network settings → IP configuration** → private IP **Static** 10.40.1.10.
2. Create `vm-site1` the same way in `vnet-site/snet-site`, no identity, custom data `infra\cloud-init-site.yaml`, private IP 10.50.1.10, then attach `pip-site` (**Network settings → IP configuration → Public IP**).

## 7.1 What 14-site-vpn.ps1 does on the mine site

1. Moves `pip-site` to vm-site1 (the local network gateway already expects that address).
2. Installs strongSwan and writes `/etc/swanctl/conf.d/azure.conf`: IKEv2, `aes256-sha256-modp1024` (what the Basic gateway offers), `encap = yes`, local ID = the site's public IP, traffic selectors 10.50.0.0/16 ↔ 10.40.0.0/16.
3. Unlinks every private DNS zone from vnet-site. From now on the site resolves the IoT names **only** through its conditional forwarder and the VPN — like a real site.
4. Checks: `mqtt.iot.example.com` → 10.40.2.4 and a TLS handshake through the tunnel.

> [!WARNING]
> **Forward the Event Grid zone too, not only your own domain**
>
> The site resolver (`/etc/systemd/resolved.conf.d/iot-site.conf`) must forward **both** `~iot.example.com` **and** `~ts.eventgrid.azure.net` to 10.40.1.10.
>
> `mqtt.iot.example.com` is a CNAME to `egns-iotmq-xxxxx.indonesiacentral-1.ts.eventgrid.azure.net`, and the resolver looks that target up separately. With only the first domain forwarded it worked for a few minutes from cache, then resolved the target **publicly** — and the namespace's IP filter cut every TLS handshake. This is the same rule Microsoft documents for on-premises DNS with private endpoints: forward the service's public zone.

> [!IMPORTANT]
> **Checkpoint — do not continue until this is true**
>
> `14-site-vpn.ps1` prints **ESTABLISHED** and **INSTALLED** for the tunnel, `mqtt.iot.example.com -> 10.40.2.4` and a certificate serial.

---

[Documentation index](README.md) · [← Part 6 — Identities, monitoring data and Cosmos DB](part-06-identities-monitoring-and-cosmos-db.md) · [Part 8 — Who may connect and publish what →](part-08-mqtt-authorisation.md)
