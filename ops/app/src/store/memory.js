/**
 * In-memory telemetry history.
 * Used when Cosmos DB is not configured, and as a hot cache in front of Cosmos
 * so the live dashboard never waits on a database round trip.
 */
const MAX_POINTS_PER_DEVICE = 50_000;

const series = new Map(); // deviceId -> array of readings, ascending by ts

function bucketFor(deviceId) {
  if (!series.has(deviceId)) series.set(deviceId, []);
  return series.get(deviceId);
}

export const name = 'memory';

export async function init() {
  return true;
}

export async function append(reading) {
  const points = bucketFor(reading.deviceId);
  points.push(reading);
  if (points.length > MAX_POINTS_PER_DEVICE) {
    points.splice(0, points.length - MAX_POINTS_PER_DEVICE);
  }
}

export async function appendMany(readings) {
  for (const reading of readings) await append(reading);
}

export async function query(deviceId, fromTs, toTs) {
  const points = series.get(deviceId) || [];
  // Points arrive in time order, so a filter is fine at demo volumes.
  return points.filter((p) => p.ts >= fromTs && p.ts <= toTs);
}

export async function latest(deviceId) {
  const points = series.get(deviceId) || [];
  return points.length ? points[points.length - 1] : null;
}

export async function devicesWithData() {
  return [...series.keys()];
}

export async function clear(deviceId) {
  if (deviceId) series.delete(deviceId);
  else series.clear();
}
