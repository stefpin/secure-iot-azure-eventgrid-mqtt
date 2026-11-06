import { config } from '../config.js';

/*
 * Azure resources of this demo, for the "See it in Azure" links of the Behind the scenes view.
 * Names follow infra\env.ps1; the subscription, resource group and tenant can be overridden with
 * IOT_SUBSCRIPTION_ID, IOT_RESOURCE_GROUP and IOT_TENANT_ID. Identifiers only - nothing secret.
 */
const SUBSCRIPTION = process.env.IOT_SUBSCRIPTION_ID || '';
const RESOURCE_GROUP = process.env.IOT_RESOURCE_GROUP || 'rg-iotmqtt-demo';
const TENANT = process.env.IOT_TENANT_ID || '';

function suffix() {
  const m = /-([a-z0-9]+)$/.exec(config.broker.namespace || '');
  return m ? m[1] : 'xxxxx';
}

function cosmosAccount(sfx) {
  const m = /^https:\/\/([^.]+)\./.exec(config.cosmos.endpoint || '');
  return m ? m[1] : `cosmos-iotmq-${sfx}`;
}

function link(type, name, blade = 'overview') {
  const id = `/subscriptions/${SUBSCRIPTION}/resourceGroups/${RESOURCE_GROUP}/providers/${type}/${name}`;
  return `https://portal.azure.com/#${TENANT ? `@${TENANT}/` : ''}resource${id}/${blade}`;
}

export function resources() {
  const sfx = suffix();
  const eg = config.broker.namespace || `egns-iotmq-${sfx}`;
  const eh = config.kafka.namespace || `ehns-iotmq-${sfx}`;
  const law = `law-iotmq-${sfx}`;
  return {
    resourceGroup: RESOURCE_GROUP,
    items: {
      device: { label: `Mine site simulator (vm-site1)`, name: 'vm-site1', url: link('Microsoft.Compute/virtualMachines', 'vm-site1'),
        menu: 'Virtual machine vm-site1 > Overview' },
      network: { label: 'VPN gateway + private endpoint', name: 'vgw-hub / pe-eg-mqtt', url: link('Microsoft.Network/privateEndpoints', 'pe-eg-mqtt'),
        menu: 'Private endpoint pe-eg-mqtt > DNS configuration (10.40.2.4); VPN gateway vgw-hub > Connections' },
      eventgrid: { label: 'Event Grid namespace', name: eg, url: link('Microsoft.EventGrid/namespaces', eg),
        menu: `Event Grid namespace ${eg} > MQTT broker: Clients, Client groups, Topic spaces, Permission bindings; Routing; Metrics` },
      opsvm: { label: 'Operator app (vm-ops)', name: 'vm-ops', url: link('Microsoft.Compute/virtualMachines', 'vm-ops'),
        menu: 'Virtual machine vm-ops > Overview' },
      eventhubs: { label: 'Event Hubs namespace', name: eh, url: link('Microsoft.EventHub/namespaces', eh),
        menu: `Event Hubs namespace ${eh} > Entities: Event Hubs > telemetry / alerts > Metrics` },
      cosmos: { label: 'Cosmos DB account', name: cosmosAccount(sfx), url: link('Microsoft.DocumentDB/databaseAccounts', cosmosAccount(sfx)),
        menu: `Cosmos DB ${cosmosAccount(sfx)} > Metrics (Total Request Units)` },
      frontdoor: { label: 'Front Door profile', name: `afd-iotmq-${sfx}`, url: link('Microsoft.Cdn/profiles', `afd-iotmq-${sfx}`),
        menu: `Front Door afd-iotmq-${sfx} > Logs (or Log Analytics workspace ${law})` },
      keyvault: { label: 'Key Vault (HSM keys)', name: `kv-iotmq-${sfx}`, url: link('Microsoft.KeyVault/vaults', `kv-iotmq-${sfx}`),
        menu: `Key Vault kv-iotmq-${sfx} > Keys; Log Analytics: AZKVAuditLogs` },
      logs: { label: 'Log Analytics workspace', name: law, url: link('Microsoft.OperationalInsights/workspaces', law, 'logs'),
        menu: `Log Analytics workspace ${law} > Logs` },
    },
  };
}
