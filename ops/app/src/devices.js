import * as broker from './broker.js';
import * as certsvc from './certsvc.js';
import { config } from './config.js';

/**
 * One device, as the operator sees it, assembled from three sources of truth:
 *   certificate service  registration, profile, certificate inventory, revoked or not
 *   retained MQTT status online/offline - published by the device, or by the broker's Last Will
 *   site agent           whether the simulator process for it is running at the mine site
 */
const GRACE_MS = 24 * 60 * 60 * 1000;
const recentTokens = new Map(); // deviceId -> { token, expires } - shown once in the onboarding script

/*
 * Quarantine. Event Grid refuses a disabled or deleted client at its NEXT connect, but in our tests
 * it did not end a session that was already open (it kept publishing, and its messages kept being
 * routed). So consumers must not trust the broker alone: readings from clients that are not
 * registered-and-enabled are dropped here, on both the MQTT and the Kafka path.
 */
const allowed = new Set();
let allowedLoadedAt = 0;
export const quarantine = { dropped: 0, byDevice: {} };

export async function refreshAllowed() {
  const docs = await certsvc.listDevices();
  allowed.clear();
  for (const d of docs) if (d.state !== 'revoked' && d.state !== 'deleted') allowed.add(d.deviceId);
  allowedLoadedAt = Date.now();
}

/** True if a reading from this client may be shown and stored. */
export function admit(deviceId) {
  if (isAllowed(deviceId)) return true;
  quarantine.dropped += 1;
  quarantine.byDevice[deviceId] = (quarantine.byDevice[deviceId] || 0) + 1;
  return false;
}

/** Same test, without counting - for labelling events on the pipeline page. */
export function isAllowed(deviceId) {
  return !allowedLoadedAt || allowed.has(deviceId);
}

function httpError(status, message) {
  return Object.assign(new Error(message), { statusCode: status });
}

export function shape(doc) {
  const presence = broker.presenceOf(doc.deviceId);
  const online = Boolean(presence?.online);
  const revoked = doc.state === 'revoked';
  const cert = doc.cert || null;
  let status = 'Offline';
  if (revoked) status = 'Revoked';
  else if (online) status = 'Connected';
  else if (doc.state === 'registered') status = 'Not enrolled';
  return {
    deviceId: doc.deviceId,
    type: doc.type || 'device',
    site: doc.site || config.site,
    template: doc.profile || (doc.type === 'gateway' ? 'gateway' : 'raspberry-pi'),
    createdAt: doc.createdAt || null,
    state: doc.state,
    enabled: !revoked,
    status,
    presence: presence ? { online, since: presence.since || null, reason: presence.reason || null, receivedAt: presence.receivedAt } : null,
    certificate: cert ? {
      serial: cert.serial, notBefore: cert.notBefore, notAfter: cert.notAfter, issuedAt: cert.issuedAt,
      method: cert.method, keyType: cert.keyType, previousSerial: cert.previousSerial || null,
    } : null,
    counts: doc.counts || {},
    messages: broker.telemetryCount(doc.deviceId),
    revokedAt: doc.revokedAt || null,
  };
}

export async function list({ includeGateways = false } = {}) {
  const docs = await certsvc.listDevices();
  return docs
    .filter((d) => includeGateways || (d.type || 'device') === 'device')
    .map(shape)
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

export async function get(deviceId) {
  try {
    const doc = await certsvc.getDevice(deviceId);
    return { ...shape(doc), eventGrid: doc.eventGrid ? { state: doc.eventGrid.state, attributes: doc.eventGrid.attributes,
      authenticationName: doc.eventGrid.authenticationName,
      validationScheme: doc.eventGrid.clientCertificateAuthentication?.validationScheme } : null };
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

export async function create({ deviceId, template = 'raspberry-pi', certMinutes }) {
  const result = await certsvc.register({ deviceId, type: 'device', site: config.site, profile: template, createdBy: config.ui.user,
    ...(certMinutes ? { certMinutes } : {}) });
  allowed.add(deviceId);
  rememberToken(deviceId, result.token, result.tokenExpiresInHours);
  return { ...shape(result.device), token: result.token, tokenExpiresInHours: result.tokenExpiresInHours, enrollUrl: result.enrollUrl };
}

function rememberToken(deviceId, token, hours = 24) {
  recentTokens.set(deviceId, { token, expires: Date.now() + hours * 3600 * 1000 });
}

export function rememberedToken(deviceId) {
  const entry = recentTokens.get(deviceId);
  if (!entry || entry.expires < Date.now()) return null;
  return entry.token;
}

export async function issueToken(deviceId) {
  const result = await certsvc.newToken(deviceId);
  rememberToken(deviceId, result.token, result.tokenExpiresInHours);
  return result;
}

export function siteRequest(action, body = {}, { site = config.site, timeoutMs = 20_000 } = {}) {
  return broker.request(`iot/site/${site}/sim/req`, { action, ...body }, `iot/site/${site}/sim/res`, { timeoutMs, expirySeconds: 30 })
    .catch((err) => {
      if (err.code === 'TIMEOUT') throw httpError(504, `The site agent at ${site} did not answer - is gw-${site} online?`);
      throw err;
    });
}

export async function connect(deviceId) {
  const doc = await certsvc.getDevice(deviceId).catch((err) => {
    if (err.statusCode === 404) throw httpError(404, `Device '${deviceId}' is not registered.`);
    throw err;
  });
  if (doc.state === 'revoked') throw httpError(409, `Device '${deviceId}' is revoked - restore it first.`);
  const notAfter = doc.cert?.notAfter ? Date.parse(doc.cert.notAfter) : 0;
  // A token is needed only for a first enrolment, or when the last certificate expired
  // longer ago than the re-enrolment grace period.
  const needsToken = doc.state === 'registered' || !doc.cert || Date.now() - notAfter > GRACE_MS;
  const token = needsToken ? (await issueToken(deviceId)).token : undefined;
  const response = await siteRequest('start', { deviceId, profile: doc.profile || 'raspberry-pi', token }, { site: doc.site });
  if (response.status !== 200) throw httpError(502, response.body?.error || `site agent answered ${response.status}`);
  return { ...response.body, enrolment: needsToken ? 'one-time token sent with the start request' : 'existing certificate' };
}

export async function disconnect(deviceId) {
  const response = await siteRequest('stop', { deviceId });
  return response.body;
}

export async function remove(deviceId) {
  const steps = {};
  try { steps.site = (await siteRequest('purge', { deviceId })).body; } catch (err) { steps.site = { error: err.message }; }
  await certsvc.remove(deviceId);
  allowed.delete(deviceId);
  steps.registry = 'Event Grid client deleted';
  // An empty retained message deletes the retained value on the broker.
  for (const kind of ['status', 'state']) {
    await broker.publish(`iot/${kind}/${config.site}/${deviceId}`, '', { retain: true }).catch(() => {});
  }
  steps.retained = 'cleared';
  recentTokens.delete(deviceId);
  return steps;
}

export async function setEnabled(deviceId, enabled) {
  const doc = enabled ? await certsvc.restore(deviceId) : await certsvc.revoke(deviceId, 'operator');
  if (enabled) allowed.add(deviceId); else allowed.delete(deviceId);
  return doc;
}

/** Cloud-to-device command over MQTT 5 request/response. */
export async function command(deviceId, method, payload = {}, { timeoutMs } = {}) {
  const presence = broker.presenceOf(deviceId);
  if (!presence?.online) {
    throw httpError(409, `Device '${deviceId}' is not connected (its retained status says offline). `
      + 'A command needs a live session - press Connect and try again.');
  }
  const site = presence.site || config.site;
  try {
    return await broker.request(`iot/cmd/${site}/${deviceId}/${method}`, payload,
      `iot/cmdres/${site}/${deviceId}`, { timeoutMs, expirySeconds: 30 });
  } catch (err) {
    if (err.code === 'TIMEOUT') throw httpError(504, `${deviceId} did not answer ${method} in time.`);
    throw err;
  }
}
