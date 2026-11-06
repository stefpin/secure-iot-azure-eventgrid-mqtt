import { EventEmitter } from 'node:events';

/*
 * Power-loss episodes - so the operator can see exactly when a machine is back.
 *
 *   requested  the powerLoss command was accepted; the machine is about to drop its connection
 *   offline    the broker published the machine's Last Will (retained "offline")
 *   online     the machine reconnected with its certificate and published a retained "online"
 *   overdue    no Last Will within 30 s, or not back within the planned outage + 60 s
 *
 * One episode per device, fed by the broker's status and telemetry events. An episode is kept for
 * 10 minutes after the machine is back (so a page reload still shows the outcome), and an unresolved
 * one for 30 minutes after it became overdue.
 */
export const updates = new EventEmitter();

const episodes = new Map();
const NO_WILL_MS = 30_000;
const GRACE_MS = 60_000;
const KEEP_MS = 10 * 60_000;
const STALE_MS = 30 * 60_000;
let seq = 0;

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

function view(e) {
  return {
    deviceId: e.deviceId,
    phase: e.phase,
    seq: e.seq,
    offlineSeconds: e.offlineSeconds,
    requestedAt: iso(e.requestedAt),
    offlineAt: iso(e.offlineAt),
    expectedBackAt: iso(e.offlineAt ? e.offlineAt + e.offlineSeconds * 1000 : null),
    onlineAt: iso(e.onlineAt),
    firstTelemetryAt: iso(e.firstTelemetryAt),
    overdueAt: iso(e.overdueAt),
    willAfterSeconds: e.offlineAt ? Math.round((e.offlineAt - e.requestedAt) / 100) / 10 : null,
    outageSeconds: e.onlineAt && e.offlineAt ? Math.round((e.onlineAt - e.offlineAt) / 100) / 10 : null,
    reason: e.reason,
    detail: e.detail,
    late: Boolean(e.late),
    now: new Date().toISOString(),
  };
}

function changed(e) {
  e.seq = ++seq;
  updates.emit('update', view(e));
}

function arm(e, ms, fn) {
  clearTimeout(e.timer);
  e.timer = setTimeout(fn, ms);
  e.timer.unref?.();
}

function overdue(e, detail) {
  e.phase = 'overdue';
  e.overdueAt = Date.now();
  e.detail = detail;
  // Still reported if the machine comes back later; forgotten after 30 minutes.
  arm(e, STALE_MS, () => episodes.delete(e.deviceId));
  changed(e);
}

export function begin(deviceId, offlineSeconds) {
  clearTimeout(episodes.get(deviceId)?.timer);
  const e = { deviceId, offlineSeconds, phase: 'requested', requestedAt: Date.now(), reason: null, detail: null };
  episodes.set(deviceId, e);
  arm(e, NO_WILL_MS, () => {
    if (e.phase === 'requested') overdue(e, 'No Last Will within 30 s - the machine may not have dropped its connection.');
  });
  changed(e);
  return view(e);
}

export function cancel(deviceId, detail) {
  const e = episodes.get(deviceId);
  if (!e) return;
  clearTimeout(e.timer);
  episodes.delete(deviceId);
  e.phase = 'cancelled';
  e.detail = detail;
  changed(e);
}

export function onStatus(s) {
  const e = episodes.get(s?.deviceId);
  if (!e || e.phase === 'online') return;
  if (s.cleared) return cancel(s.deviceId, 'The device was deleted.');
  const now = Date.now();
  if (s.online === false && !e.offlineAt) {
    e.phase = 'offline';
    e.offlineAt = now;
    e.reason = s.reason || null;
    e.detail = null;
    arm(e, e.offlineSeconds * 1000 + GRACE_MS, () => {
      if (e.phase === 'offline') overdue(e, `Not back ${GRACE_MS / 1000} s after power was due to return.`);
    });
    changed(e);
  } else if (s.online === true && (e.offlineAt || (s.since && Date.parse(s.since) > e.requestedAt + 1000))) {
    // The second case covers a Last Will that this app missed (for example while it was reconnecting).
    e.late = e.phase === 'overdue';
    e.phase = 'online';
    e.onlineAt = now;
    e.detail = null;
    arm(e, KEEP_MS, () => episodes.delete(e.deviceId));
    changed(e);
  }
}

export function onReading(reading) {
  const e = episodes.get(reading?.deviceId);
  if (!e || e.phase !== 'online' || e.firstTelemetryAt) return;
  e.firstTelemetryAt = Date.now();
  changed(e);
}

/** Wire the episodes to the broker's status (retained online/offline) and telemetry events. */
export function attach(bus) {
  bus.on('status', onStatus);
  bus.on('reading', onReading);
}

export const get = (deviceId) => (episodes.has(deviceId) ? view(episodes.get(deviceId)) : null);
export const list = () => [...episodes.values()].map(view);
