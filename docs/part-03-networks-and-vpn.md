# Part 3 — Build the networks and the VPN

[Documentation index](README.md) · [← Part 2 — Prepare your computer](part-02-prepare-your-computer.md) · [Part 4 — Build the broker, routing and Kafka →](part-04-broker-routing-and-kafka.md)

Two virtual networks stand for the two places in the story: **vnet-hub** is Contoso's Azure landing zone, **vnet-site** is a mine site. They are connected only through an IPsec VPN, exactly as a real site would be.

#### Do it with the script

*PowerShell — 35 to 50 minutes*

```powershell
cd secure-iot-azure-eventgrid-mqtt\infra
.\01-network.ps1 -PskFile C:\iot-secrets\vpn-psk.txt
```

The script creates the resource group, the two networks and subnets, the network security groups, two public IP addresses, the VPN gateway, the local network gateway that describes the site, and the IPsec connection. Re-running it changes nothing; `-VerifyOnly` only reports.

#### Do it in the Azure Portal

1. **Resource group**: search **Resource groups** → **+ Create** → name `rg-iotmqtt-demo`, region **Indonesia Central** → **Tags** tab: `CostControl` = `Ignore` → **Review + create**.
2. **Hub network**: search **Virtual networks** → **+ Create** → name `vnet-hub`, region Indonesia Central → **IP addresses** tab: address space `10.40.0.0/16`; add subnets `snet-app` 10.40.1.0/24, `snet-pe` 10.40.2.0/27 and `GatewaySubnet` 10.40.255.0/27 (the name must be exactly *GatewaySubnet*) → **Tags** → **Create**.
3. **Site network**: same steps with `vnet-site` 10.50.0.0/16 and subnet `snet-site` 10.50.1.0/24. In the subnet dialog set **Enable private subnet (no default outbound access)** to on — a real site has no free internet path.
4. **NSGs**: search **Network security groups** → create `nsg-app` and `nsg-site`; on each, **Settings → Subnets → + Associate** with snet-app and snet-site respectively.
5. **Public IPs**: create `pip-vpngw` and `pip-site` (SKU Standard, static).
6. **VPN gateway**: the Basic SKU used here can only be created with the CLI or PowerShell (see the CLI band). In the Portal you would create **Virtual network gateways → + Create** with SKU **VpnGw1AZ** — the production choice.
7. **Local network gateway**: search **Local network gateways** → **+ Create** → name `lng-site`, IP address = the address of `pip-site`, address space `10.50.0.0/16`.
8. **Connection**: open `vgw-hub` → **Settings → Connections → + Add** → type **Site-to-site (IPsec)**, local network gateway `lng-site`, IKE protocol **IKEv2**, shared key = the content of your PSK file.

#### Do it in the Azure CLI (the key commands)

```powershell
az network vnet-gateway create -g rg-iotmqtt-demo -n vgw-hub `
  --vnet vnet-hub --public-ip-addresses pip-vpngw `
  --gateway-type Vpn --vpn-type RouteBased --sku Basic --tags CostControl=Ignore
az network local-gateway create -g rg-iotmqtt-demo -n lng-site `
  --gateway-ip-address <pip-site address> --local-address-prefixes 10.50.0.0/16
az network vpn-connection create -g rg-iotmqtt-demo -n cn-hub-site `
  --vnet-gateway1 vgw-hub --local-gateway2 lng-site --shared-key <your key>
```

> [!WARNING]
> **Basic VPN gateways are for demos only**
>
> Microsoft retired the non-zone-redundant VPN SKUs on 30 September 2026 except Basic, which has no zone redundancy, no BGP and no custom IPsec policy. For a real mine site use **VpnGw1AZ** or larger, or ExpressRoute (Jakarta peering partners include Telin, XL Axiata, NTT Indonesia and Equinix).

> [!IMPORTANT]
> **Checkpoint — do not continue until this is true**
>
> `.\01-network.ps1 -PskFile ... -VerifyOnly` ends with **0 missing item(s)**. The connection shows **Connected** only after [Part 7](part-07-vms-and-the-remote-site.md), when the site VM brings up its side of the tunnel.

---

[Documentation index](README.md) · [← Part 2 — Prepare your computer](part-02-prepare-your-computer.md) · [Part 4 — Build the broker, routing and Kafka →](part-04-broker-routing-and-kafka.md)
