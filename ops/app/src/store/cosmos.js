import { CosmosClient } from '@azure/cosmos';
import { config } from '../config.js';
import { credential } from '../identity.js';
import { emit as traceEmit } from '../trace-hooks.js';

/**
 * Cosmos DB for NoSQL telemetry history (container "telemetry", partition key /deviceId,
 * 7-day TTL). Keyless and private: Entra ID with the app's managed identity, which holds
 * the "Cosmos DB Built-in Data Contributor" role on THIS container only, over a private endpoint.
 */
let container = null;
let pending = [];
const FLUSH_INTERVAL_MS = 2000;
const DELETE_CONCURRENCY = 20;
const stats = { auth: 'entra (managed identity)', written: 0, failed: 0, lastError: null, lastWriteAt: null };

export async function init() {
  const client = new CosmosClient({ endpoint: config.cosmos.endpoint, aadCredentials: credential });
  const candidate = client.database(config.cosmos.database).container(config.cosmos.container);
  await candidate.read();
  container = candidate;
  setInterval(() => { flush().catch(() => {}); }, FLUSH_INTERVAL_MS).unref();
}

export function status() {
  return { ...stats, pending: pending.length };
}

async function flush() {
  if (!container || pending.length === 0) return;
  const batch = pending;
  pending = [];
  const startedAt = Date.now();
  await Promise.all(batch.map((doc) => container.items.create(doc)
    .then((res) => {
      stats.written += 1; stats.lastWriteAt = new Date().toISOString();
      traceEmit('cosmos.written', { doc, startedAt, at: Date.now(), requestCharge: res?.requestCharge, statusCode: res?.statusCode,
        activityId: res?.activityId, serverTs: res?.resource?._ts });
    })
    .catch((err) => { stats.failed += 1; stats.lastError = err.message; })));
}

export async function append(reading) {
  pending.push({ id: `${reading.deviceId}-${reading.ts}-${Math.random().toString(36).slice(2, 8)}`, ...reading });
  traceEmit('cosmos.queued', { deviceId: reading.deviceId, ts: reading.ts, at: Date.now() });
  if (pending.length >= 100) await flush();
}

export async function appendMany(readings) {
  for (const reading of readings) await append(reading);
}

export async function query(deviceId, fromTs, toTs) {
  if (!container) return [];
  await flush();
  const { resources } = await container.items.query({
    query: 'SELECT * FROM c WHERE c.deviceId = @d AND c.ts >= @from AND c.ts <= @to ORDER BY c.ts ASC',
    parameters: [{ name: '@d', value: deviceId }, { name: '@from', value: fromTs }, { name: '@to', value: toTs }],
  }, { partitionKey: deviceId, maxItemCount: 5000 }).fetchAll();
  return resources;
}

export async function latest(deviceId) {
  if (!container) return null;
  const { resources } = await container.items.query({
    query: 'SELECT TOP 1 * FROM c WHERE c.deviceId = @d ORDER BY c.ts DESC',
    parameters: [{ name: '@d', value: deviceId }],
  }, { partitionKey: deviceId }).fetchAll();
  return resources[0] || null;
}

export async function clear(deviceId) {
  if (!container || !deviceId) return 0;
  pending = pending.filter((doc) => doc.deviceId !== deviceId);
  const { resources } = await container.items.query({
    query: 'SELECT c.id FROM c WHERE c.deviceId = @d', parameters: [{ name: '@d', value: deviceId }],
  }, { partitionKey: deviceId }).fetchAll();
  for (let i = 0; i < resources.length; i += DELETE_CONCURRENCY) {
    await Promise.all(resources.slice(i, i + DELETE_CONCURRENCY)
      .map((doc) => container.item(doc.id, deviceId).delete().catch(() => {})));
  }
  return resources.length;
}
