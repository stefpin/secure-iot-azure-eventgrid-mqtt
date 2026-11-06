import { EventEmitter } from 'node:events';
import { Kafka, logLevel } from 'kafkajs';
import { config } from './config.js';
import { credential } from './identity.js';
import { emit as traceEmit } from './trace-hooks.js';

/**
 * Kafka consumer on the Event Hubs Kafka endpoint (port 9093) - the "Kafka-compatible system"
 * that Event Grid MQTT routing delivers to:
 *
 *   device --MQTT--> Event Grid namespace --routing--> namespace topic "mqtt-routed"
 *     --(enrichments: site, profile, client)--> push subscriptions es-telemetry / es-alerts
 *     --> Event Hubs "telemetry" / "alerts"  <--Kafka protocol-- this consumer
 *
 * Authentication is Microsoft Entra ID (SASL OAUTHBEARER) with the app's managed identity;
 * the namespace has local (SAS) auth and public network access disabled.
 */
export const pipeline = new EventEmitter();
pipeline.setMaxListeners(50);

export const kafkaStats = {
  connected: false, topics: config.kafka.topics, groupId: config.kafka.groupId,
  received: {}, lastEventAt: null, lastError: null,
  bootstrap: config.kafka.namespace ? `${config.kafka.namespace}.servicebus.windows.net:9093` : null,
  authentication: 'Microsoft Entra ID (SASL OAUTHBEARER)',
};

const recent = []; // newest first, for the pipeline page
const recentAlerts = []; // alerts are rare - kept separately so telemetry never pushes them out
const MAX_RECENT = 60;
let consumer = null;

function headerMap(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = Buffer.isBuffer(value) ? value.toString() : Array.isArray(value) ? value.map(String).join(',') : String(value);
  }
  return out;
}

/** CloudEvent from either structured (JSON body) or binary (attributes in headers) mode. */
export function parseCloudEvent(message) {
  const headers = headerMap(message.headers);
  const text = message.value ? message.value.toString() : '';
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  if (body && typeof body === 'object' && body.specversion) {
    return { mode: 'structured', ...body };
  }
  const event = { mode: 'binary', data: body };
  for (const [key, value] of Object.entries(headers)) {
    const match = /^(?:ce[_-]|cloudEvents[:_])(.+)$/i.exec(key);
    if (match) event[match[1]] = value;
  }
  return event;
}

function toReading(event) {
  const data = event.data && typeof event.data === 'object' ? event.data : null;
  if (!data) return null;
  const deviceId = data.deviceId || event.client || (event.subject || '').split('/')[3];
  if (!deviceId) return null;
  const ts = data.timestamp ? Date.parse(data.timestamp) : (event.time ? Date.parse(event.time) : Date.now());
  const reading = { deviceId, ts, timestamp: new Date(ts).toISOString(), source: 'kafka' };
  for (const [key, value] of Object.entries(data)) {
    if (['timestamp', 'deviceId', 'seq'].includes(key)) continue;
    if (['number', 'boolean', 'string'].includes(typeof value)) reading[key] = value;
  }
  return reading;
}

export async function start() {
  if (!config.kafka.namespace) {
    console.warn('[kafka] IOT_EVENTHUBS_NAMESPACE not set - Kafka consumer disabled');
    return;
  }
  const scope = `https://${config.kafka.namespace}.servicebus.windows.net/.default`;
  const kafka = new Kafka({
    clientId: 'iot-operator-app',
    brokers: [kafkaStats.bootstrap],
    ssl: true,
    sasl: {
      mechanism: 'oauthbearer',
      oauthBearerProvider: async () => ({ value: (await credential.getToken(scope)).token }),
    },
    connectionTimeout: 15_000,
    authenticationTimeout: 15_000,
    requestTimeout: 30_000,
    logLevel: logLevel.WARN,
  });
  consumer = kafka.consumer({ groupId: config.kafka.groupId, sessionTimeout: 30_000, heartbeatInterval: 3_000, maxWaitTimeInMs: 1_000 });
  consumer.on(consumer.events.CRASH, (e) => {
    kafkaStats.connected = false;
    kafkaStats.lastError = e.payload?.error?.message || 'consumer crashed';
  });
  consumer.on(consumer.events.GROUP_JOIN, () => { kafkaStats.connected = true; kafkaStats.lastError = null; });

  await consumer.connect();
  await consumer.subscribe({ topics: config.kafka.topics, fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      kafkaStats.received[topic] = (kafkaStats.received[topic] || 0) + 1;
      kafkaStats.lastEventAt = new Date().toISOString();
      const event = parseCloudEvent(message);
      traceEmit('kafka.message', { topic, partition, offset: message.offset, timestamp: message.timestamp, headers: message.headers, event, at: Date.now() });
      const summary = {
        topic, partition, offset: message.offset, receivedAt: kafkaStats.lastEventAt,
        mode: event.mode, id: event.id, type: event.type, source: event.source, subject: event.subject, time: event.time,
        enrichments: { site: event.site, profile: event.profile, client: event.client },
        data: event.data,
      };
      recent.unshift(summary);
      if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
      if (topic === 'alerts') {
        recentAlerts.unshift(summary);
        if (recentAlerts.length > 20) recentAlerts.length = 20;
      }
      pipeline.emit('event', summary);
      const reading = toReading(event);
      if (reading && topic === 'telemetry') pipeline.emit('reading', reading);
      if (reading && topic === 'alerts') pipeline.emit('alert', { ...reading, subject: event.subject });
    },
  });
  console.log(`[kafka] consuming ${config.kafka.topics.join(', ')} from ${kafkaStats.bootstrap} (group ${config.kafka.groupId})`);
}

export function recentEvents(limit = 30) {
  return recent.slice(0, limit);
}

export function recentAlertEvents(limit = 20) {
  return recentAlerts.slice(0, limit);
}

export async function stop() {
  if (consumer) await consumer.disconnect().catch(() => {});
}
