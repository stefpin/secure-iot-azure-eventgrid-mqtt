import { hasCosmos, runtime } from '../config.js';
import * as memory from './memory.js';
import * as cosmos from './cosmos.js';

/**
 * History facade.
 *   live readings (MQTT)       -> memory (hot cache, instant charts)
 *   routed readings (Kafka)    -> Cosmos DB (durable history, 7-day TTL)
 * Both paths carry the device's own timestamp, so a chart merges them by timestamp and the
 * same reading never counts twice.
 */
const COSMOS_INIT_TIMEOUT_MS = 45_000;
const SEED_CHUNK = 100;
let active = false;
const seedGeneration = new Map();

export const RANGES = {
  hourly: { windowMs: 60 * 60 * 1000, bucketMs: 60 * 1000, label: 'Hourly' },
  daily: { windowMs: 24 * 60 * 60 * 1000, bucketMs: 15 * 60 * 1000, label: 'Daily' },
  weekly: { windowMs: 7 * 24 * 60 * 60 * 1000, bucketMs: 60 * 60 * 1000, label: 'Weekly' },
};

const NON_METRIC_KEYS = new Set([
  'deviceId', 'ts', 'timestamp', 'template', 'id', 'ttl', 'site',
  '_rid', '_self', '_etag', '_attachments', '_ts', 'enqueuedTime', 'source',
]);

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function init() {
  await memory.init();
  if (!hasCosmos) {
    runtime.history = 'in-memory';
    return;
  }
  try {
    await withTimeout(cosmos.init(), COSMOS_INIT_TIMEOUT_MS, 'Cosmos DB did not answer within 45 s');
    active = true;
    runtime.history = 'cosmos db';
    runtime.historyError = null;
    console.log('[store] history backend: Cosmos DB (keyless, private endpoint)');
  } catch (err) {
    runtime.history = 'in-memory (cosmos db unavailable)';
    runtime.historyError = err.message;
    console.error('[store] Cosmos init failed, falling back to memory:', err.message);
  }
}

export function isCosmosActive() {
  return active;
}

export function status() {
  return { backend: runtime.history, configured: hasCosmos ? 'cosmos db' : 'in-memory', error: runtime.historyError,
    ...(active ? cosmos.status() : {}) };
}

/** A live reading straight from the MQTT broker. */
export async function appendLive(reading) {
  await memory.append(reading);
}

/** A reading that came through Event Grid routing -> Event Hubs (Kafka): persist it. */
export async function persist(reading) {
  if (active) await cosmos.append(reading).catch(() => {});
  else await memory.append(reading);
}

export async function seed(readings, { persist: keep = false } = {}) {
  await memory.appendMany(readings);
  const persisting = Boolean(keep && active && readings.length);
  if (persisting) {
    const deviceId = readings[0].deviceId;
    const generation = (seedGeneration.get(deviceId) || 0) + 1;
    seedGeneration.set(deviceId, generation);
    (async () => {
      for (let i = 0; i < readings.length; i += SEED_CHUNK) {
        if (seedGeneration.get(deviceId) !== generation) return;
        await cosmos.appendMany(readings.slice(i, i + SEED_CHUNK));
      }
    })().catch((err) => console.warn('[store] background seed stopped:', err.message));
  }
  return { seeded: readings.length, persisting };
}

export async function latest(deviceId) {
  const hot = await memory.latest(deviceId);
  if (hot) return hot;
  if (active) return cosmos.latest(deviceId);
  return null;
}

async function readRaw(deviceId, fromTs, toTs) {
  const hot = await memory.query(deviceId, fromTs, toTs);
  if (!active) return { points: hot, counts: { memory: hot.length } };
  const cold = await cosmos.query(deviceId, fromTs, toTs).catch(() => []);
  const byTs = new Map();
  for (const point of [...cold, ...hot]) byTs.set(point.ts, point);
  // Counts BEFORE merging: Cosmos holds what arrived through routing/Kafka, memory what arrived live.
  return { points: [...byTs.values()].sort((a, b) => a.ts - b.ts), counts: { cosmos: cold.length, memory: hot.length } };
}

export function metricsOf(readings) {
  const found = new Set();
  for (const reading of readings) {
    for (const [key, value] of Object.entries(reading)) {
      if (NON_METRIC_KEYS.has(key)) continue;
      if (typeof value === 'number' || typeof value === 'boolean') found.add(key);
    }
  }
  return [...found];
}

export async function history(deviceId, rangeKey = 'hourly', endTs = Date.now()) {
  const range = RANGES[rangeKey] || RANGES.hourly;
  const fromTs = endTs - range.windowMs;
  const { points: raw, counts } = await readRaw(deviceId, fromTs, endTs);
  const metrics = metricsOf(raw);
  const buckets = new Map();
  for (const reading of raw) {
    const bucketTs = Math.floor(reading.ts / range.bucketMs) * range.bucketMs;
    if (!buckets.has(bucketTs)) buckets.set(bucketTs, { ts: bucketTs, _count: {}, _sum: {} });
    const bucket = buckets.get(bucketTs);
    for (const metric of metrics) {
      const value = reading[metric];
      if (value === undefined || value === null) continue;
      const numeric = typeof value === 'boolean' ? (value ? 1 : 0) : Number(value);
      if (Number.isNaN(numeric)) continue;
      bucket._sum[metric] = (bucket._sum[metric] || 0) + numeric;
      bucket._count[metric] = (bucket._count[metric] || 0) + 1;
    }
  }
  const points = [...buckets.values()].sort((a, b) => a.ts - b.ts).map((bucket) => {
    const point = { ts: bucket.ts, label: formatLabel(bucket.ts, rangeKey) };
    for (const metric of metrics) {
      if (bucket._count[metric]) point[metric] = Math.round((bucket._sum[metric] / bucket._count[metric]) * 100) / 100;
    }
    return point;
  });
  return { deviceId, range: rangeKey, bucketMs: range.bucketMs, from: fromTs, to: endTs, metrics, points,
    sampleCount: raw.length, sources: counts };
}

const LABEL_FORMAT = new Intl.DateTimeFormat('en-GB', {
  // Operators read charts in local time: WIB by default; IOT_TIME_ZONE=Asia/Makassar for WITA sites.
  timeZone: process.env.IOT_TIME_ZONE || 'Asia/Jakarta',
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});

function formatLabel(ts, rangeKey) {
  const p = Object.fromEntries(LABEL_FORMAT.formatToParts(new Date(ts)).map((part) => [part.type, part.value]));
  const hh = p.hour === '24' ? '00' : p.hour;
  return rangeKey === 'weekly' ? `${p.day}/${p.month} ${hh}:00` : `${hh}:${p.minute}`;
}

export async function clear(deviceId) {
  await memory.clear(deviceId);
  seedGeneration.set(deviceId, (seedGeneration.get(deviceId) || 0) + 1);
  if (active) cosmos.clear(deviceId).catch((err) => console.warn('[store] purge failed:', err.message));
}
