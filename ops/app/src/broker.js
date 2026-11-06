import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import mqtt from 'mqtt';
import { config } from './config.js';
import { credential } from './identity.js';
import { emit as traceEmit } from './trace-hooks.js';

/**
 * The operator app's MQTT 5 connection to the Event Grid namespace.
 *
 * Authentication: Microsoft Entra ID JWT of the app's managed identity (CONNECT
 * "Authentication Method" OAUTH2-JWT). Authorisation: Azure RBAC - EventGrid TopicSpaces
 * Publisher on ts-app-pub and Subscriber on ts-app-sub.
 *
 * Clean start on purpose: live data comes from MQTT, durable history from the Kafka path,
 * and the current state of every device arrives as RETAINED messages on subscribe.
 */
export const bus = new EventEmitter();
bus.setMaxListeners(50);

const AUDIENCE = 'https://eventgrid.azure.net/.default';
const presence = new Map(); // deviceId -> latest status payload (+ meta)
const states = new Map(); // deviceId -> latest state payload
const lastValues = new Map(); // topic -> { topic, payload, retain, receivedAt } for status/state/config topics
const pending = new Map(); // correlation hex -> { resolve, reject, timer }
const counters = new Map(); // deviceId -> telemetry messages received
let client = null;
let tokenExpires = 0;
let fleetConfig = null;

export const stats = {
  connected: false, connects: 0, received: 0, lastMessageAt: null, lastError: null,
  host: config.broker.host, authentication: 'Microsoft Entra ID (OAUTH2-JWT)',
};

async function freshToken() {
  const token = await credential.getToken(AUDIENCE);
  tokenExpires = token.expiresOnTimestamp;
  return token.token;
}

function connectOptions(token, clientId) {
  return {
    protocolVersion: 5,
    clientId,
    clean: true,
    keepalive: 60,
    connectTimeout: 20_000,
    reconnectPeriod: 5_000,
    properties: {
      authenticationMethod: 'OAUTH2-JWT',
      authenticationData: Buffer.from(token),
      sessionExpiryInterval: 0,
    },
  };
}

function parseJson(buffer) {
  if (!buffer || !buffer.length) return null;
  try { return JSON.parse(buffer.toString()); } catch { return { raw: buffer.toString() }; }
}

function userStatus(packet) {
  const value = packet.properties?.userProperties?.status;
  return Number(Array.isArray(value) ? value[0] : value) || 200;
}

function onMessage(topic, payload, packet) {
  traceEmit('mqtt.message', { topic, payload, packet, at: Date.now() });
  stats.received += 1;
  stats.lastMessageAt = new Date().toISOString();
  const parts = topic.split('/');
  const kind = parts[1];

  const corr = packet.properties?.correlationData;
  if (corr && (kind === 'cmdres' || (kind === 'site' && parts[3] === 'sim'))) {
    const key = Buffer.from(corr).toString('hex');
    const waiter = pending.get(key);
    if (waiter) {
      pending.delete(key);
      clearTimeout(waiter.timer);
      waiter.resolve({ status: userStatus(packet), body: parseJson(payload) || {}, ms: Date.now() - waiter.sentAt });
    }
    return;
  }

  if (kind === 'telemetry' && parts.length >= 4) {
    const body = parseJson(payload);
    if (!body || typeof body !== 'object') return;
    const deviceId = parts[3];
    counters.set(deviceId, (counters.get(deviceId) || 0) + 1);
    const ts = body.timestamp ? Date.parse(body.timestamp) : Date.now();
    const reading = { deviceId, site: parts[2], ts, timestamp: new Date(ts).toISOString(), source: 'mqtt' };
    for (const [key, value] of Object.entries(body)) {
      if (['timestamp', 'deviceId', 'site', 'seq'].includes(key)) continue;
      if (['number', 'boolean', 'string'].includes(typeof value)) reading[key] = value;
    }
    bus.emit('reading', reading);
    return;
  }

  if (kind === 'status' || kind === 'state' || kind === 'config') {
    const body = parseJson(payload);
    const entry = { topic, payload: body, retain: Boolean(packet.retain), receivedAt: new Date().toISOString() };
    if (body === null) lastValues.delete(topic); else lastValues.set(topic, entry);
    if (kind === 'config' && parts[2] === 'fleet') {
      fleetConfig = body;
      bus.emit('config', body);
      return;
    }
    const deviceId = parts[3];
    if (!deviceId) return;
    const map = kind === 'status' ? presence : states;
    if (body === null) map.delete(deviceId);
    else map.set(deviceId, { ...body, site: parts[2], retainedDelivery: Boolean(packet.retain), receivedAt: entry.receivedAt });
    bus.emit(kind, { deviceId, site: parts[2], ...(body || { cleared: true }) });
  }
}

export async function start() {
  if (!config.broker.host) {
    console.warn('[broker] IOT_BROKER_HOST not set - MQTT disabled');
    return;
  }
  const token = await freshToken();
  client = mqtt.connect(`mqtts://${config.broker.host}:8883`, connectOptions(token, config.broker.clientId));
  client.on('connect', () => {
    stats.connected = true;
    stats.connects += 1;
    stats.lastError = null;
    client.subscribe([
      'iot/telemetry/#',
    ], { qos: 0 });
    client.subscribe(['iot/status/#', 'iot/state/#', 'iot/cmdres/#', 'iot/site/+/sim/res', 'iot/config/#'], { qos: 1 });
    console.log(`[broker] connected to ${config.broker.host} with Entra ID`);
  });
  client.on('message', onMessage);
  client.on('close', () => { stats.connected = false; });
  client.on('error', (err) => {
    stats.lastError = err.message;
    console.error('[broker]', err.message);
  });

  // The broker disconnects a client whose JWT expires. Keep the reconnect token fresh and
  // reconnect proactively 10 minutes before the current one runs out.
  setInterval(async () => {
    try {
      const fresh = await freshToken();
      client.options.properties.authenticationData = Buffer.from(fresh);
      if (stats.connected && tokenExpires - Date.now() < 10 * 60 * 1000) {
        client.end(false, {}, () => client.reconnect());
      }
    } catch (err) {
      stats.lastError = `token refresh: ${err.message}`;
    }
  }, 5 * 60 * 1000).unref();
}

export function isConnected() {
  return stats.connected;
}

export function publish(topic, payload, { qos = 1, retain = false, properties = {} } = {}) {
  return new Promise((resolve, reject) => {
    if (!client) return reject(new Error('MQTT not started'));
    const data = payload === null || payload === undefined ? ''
      : (typeof payload === 'string' ? payload : JSON.stringify(payload));
    const props = data ? { contentType: 'application/json', payloadFormatIndicator: true, ...properties } : properties;
    client.publish(topic, data, { qos, retain, properties: props }, (err) => (err ? reject(err) : resolve()));
  });
}

/** MQTT 5 request/response: response topic + correlation data, with a message expiry. */
export function request(topic, body, responseTopic, { timeoutMs = config.commandTimeoutMs, expirySeconds = 30 } = {}) {
  return new Promise((resolve, reject) => {
    if (!client || !stats.connected) return reject(Object.assign(new Error('The app is not connected to the MQTT broker.'), { code: 'NOT_CONNECTED' }));
    const corr = randomBytes(16);
    const key = corr.toString('hex');
    const timer = setTimeout(() => {
      pending.delete(key);
      reject(Object.assign(new Error(`No response on ${responseTopic} within ${Math.round(timeoutMs / 1000)} s.`), { code: 'TIMEOUT' }));
    }, timeoutMs);
    pending.set(key, { resolve, reject, timer, sentAt: Date.now() });
    traceEmit('mqtt.request', { topic, body, responseTopic, correlation: key, expirySeconds, at: Date.now() });
    client.publish(topic, JSON.stringify(body ?? {}), {
      qos: 1,
      properties: {
        responseTopic,
        correlationData: corr,
        contentType: 'application/json',
        payloadFormatIndicator: true,
        // A command that cannot be delivered within this time is dropped by the broker
        // instead of executing late.
        messageExpiryInterval: expirySeconds,
      },
    }, (err) => {
      traceEmit('mqtt.puback', { correlation: key, at: Date.now(), error: err ? err.message : null });
      if (err) {
        clearTimeout(timer);
        pending.delete(key);
        reject(err);
      }
    });
  });
}

export function presenceOf(deviceId) {
  return presence.get(deviceId) || null;
}

export function stateOf(deviceId) {
  return states.get(deviceId) || null;
}

export function allPresence() {
  return Object.fromEntries(presence);
}

export function telemetryCount(deviceId) {
  return counters.get(deviceId) || 0;
}

export function currentFleetConfig() {
  return fleetConfig;
}

export function retainedSnapshot() {
  return [...lastValues.values()].sort((a, b) => a.topic.localeCompare(b.topic));
}

/**
 * Late-joiner test: a brand-new MQTT session subscribes and records what the broker
 * hands over immediately. Only RETAINED messages arrive this fast - that is the point.
 */
export async function lateJoiner({ filters = ['iot/status/#', 'iot/state/#', 'iot/config/#'], listenMs = 3000 } = {}) {
  const token = await freshToken();
  const started = Date.now();
  const probe = mqtt.connect(`mqtts://${config.broker.host}:8883`,
    { ...connectOptions(token, `iot-latejoiner-${randomBytes(3).toString('hex')}`), reconnectPeriod: 0 });
  const received = [];
  let connectedMs = null;
  let subscribedAt = null;
  await new Promise((resolve, reject) => {
    const fail = setTimeout(() => reject(new Error('late-joiner session did not connect')), 20_000);
    probe.on('connect', () => {
      connectedMs = Date.now() - started;
      probe.subscribe(filters, { qos: 1 }, () => {
        subscribedAt = Date.now();
        clearTimeout(fail);
        resolve();
      });
    });
    probe.on('error', (err) => { clearTimeout(fail); reject(err); });
    probe.on('message', (topic, payload, packet) => {
      received.push({
        topic,
        retain: Boolean(packet.retain),
        afterMs: Date.now() - (subscribedAt || Date.now()),
        payload: parseJson(payload),
      });
    });
  });
  await new Promise((r) => setTimeout(r, listenMs));
  await new Promise((r) => probe.end(false, {}, r));
  return {
    clientId: probe.options.clientId,
    connectMs: connectedMs,
    listenMs,
    filters,
    retainedCount: received.filter((m) => m.retain).length,
    liveCount: received.filter((m) => !m.retain).length,
    messages: received,
  };
}
