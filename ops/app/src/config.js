import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');

export const config = {
  port: Number(process.env.PORT || 3000),
  publicUrl: process.env.PUBLIC_URL || '',

  // User-assigned managed identity of the operator app (id-iotmq-app).
  clientId: process.env.AZURE_CLIENT_ID || '',

  broker: {
    // The namespace's own hostname (Microsoft-managed certificate) through the private
    // endpoint; devices use the custom domain mqtt.iot.example.com instead.
    host: process.env.IOT_BROKER_HOST || '',
    namespace: process.env.IOT_NAMESPACE || '',
    customDomain: process.env.IOT_MQTT_HOST || 'mqtt.iot.example.com',
    clientId: process.env.IOT_APP_CLIENT_ID || 'iot-operator-app',
  },

  site: process.env.IOT_SITE || 'site1',

  kafka: {
    // Event Hubs Kafka endpoint (port 9093), private endpoint, Entra ID (OAUTHBEARER).
    namespace: process.env.IOT_EVENTHUBS_NAMESPACE || '',
    topics: (process.env.IOT_KAFKA_TOPICS || 'telemetry,alerts').split(',').map((t) => t.trim()).filter(Boolean),
    groupId: process.env.IOT_KAFKA_GROUP || 'iot-operator-app',
  },

  cosmos: {
    endpoint: process.env.IOT_COSMOS_ENDPOINT || '',
    database: process.env.IOT_COSMOS_DB || 'iotmq',
    container: process.env.IOT_COSMOS_CONTAINER || 'telemetry',
  },

  certsvc: {
    url: process.env.IOT_CERTSVC_URL || 'http://127.0.0.1:8081',
    token: process.env.IOT_INTERNAL_TOKEN || '',
  },

  commandTimeoutMs: Number(process.env.IOT_COMMAND_TIMEOUT_MS || 15000),

  ui: {
    user: process.env.UI_USER || 'iot-operator',
    role: process.env.UI_ROLE || 'Operator',
    title: process.env.UI_TITLE || 'Contoso IoT Operations - Event Grid MQTT',
  },
};

export const hasCosmos = Boolean(config.cosmos.endpoint);

export const runtime = {
  history: hasCosmos ? 'connecting to cosmos db' : 'in-memory',
  historyError: null,
};

export function describeMode() {
  return {
    broker: config.broker.namespace || config.broker.host,
    telemetry: 'MQTT (live) + Kafka/Event Hubs (history)',
    history: runtime.history,
  };
}
