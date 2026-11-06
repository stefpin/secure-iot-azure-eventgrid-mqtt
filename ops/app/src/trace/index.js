import { AsyncLocalStorage } from 'node:async_hooks';
import { Router } from 'express';
import { config } from '../config.js';
import * as broker from '../broker.js';
import * as devices from '../devices.js';
import * as store from '../store/index.js';
import { setSink } from '../trace-hooks.js';
import { TraceEngine } from './engine.js';
import { resources } from './resources.js';

/*
 * "Behind the scenes" view - follows one reading from a machine to Cosmos DB, and one command from the
 * operator's browser to the machine and back, with the real timestamps of every Azure service on the way.
 *
 * Loaded by server.js only when IOT_TRACE is not "off", and on its own: if this module fails, the rest of
 * the app runs exactly as before. It adds no MQTT subscriptions, no Kafka consumers and no Cosmos DB
 * requests; it only observes the app's existing traffic through the hooks in ../trace-hooks.js.
 */
export const VERSION = '1.0';
const startedAt = new Date().toISOString();
const als = new AsyncLocalStorage();
const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const engine = new TraceEngine({
  isAllowed: (deviceId) => devices.isAllowed(deviceId),
  historyBackend: () => (store.isCosmosActive() ? 'cosmos db' : 'memory'),
});

function sink(kind, data) {
  switch (kind) {
    case 'mqtt.message': engine.onMqttMessage(data); break;
    case 'mqtt.request': engine.onRequest({ ...data, http: als.getStore() || null }); break;
    case 'mqtt.puback': engine.onPuback(data); break;
    case 'kafka.message': engine.onKafkaMessage(data); break;
    case 'cosmos.queued': engine.onCosmosQueued(data); break;
    case 'cosmos.written': engine.onCosmosWritten(data); break;
    default: break;
  }
}

export function install() {
  setSink(sink);
  console.log(`[trace] Behind the scenes view ${VERSION} enabled (IOT_TRACE=off disables it)`);
}

/**
 * Remembers which HTTP request (and which Front Door request, X-Azure-Ref) sent a command, so the
 * command trace can show it. Only marks the request - it always passes it on unchanged.
 */
export function httpContext(req, res, next) {
  if (req.method !== 'POST') return next();
  let ctx = null;
  try {
    ctx = {
      arrivedAt: Date.now(),
      method: req.method,
      path: String(req.originalUrl || req.url || '').split('?')[0].slice(0, 120),
      azureRef: req.get('x-azure-ref') || null,
      viaFrontDoor: Boolean(req.get('x-azure-fdid')),
      finishedAt: null,
      statusCode: null,
    };
    res.on('finish', () => { ctx.finishedAt = Date.now(); ctx.statusCode = res.statusCode; });
  } catch {
    ctx = null;
  }
  if (!ctx) return next();
  return als.run(ctx, next);
}

export const router = Router();
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

router.get('/health', (req, res) => {
  res.json({ enabled: true, version: VERSION, since: startedAt, traces: engine.size(), site: config.site });
});

router.get('/resources', (req, res) => {
  res.json(resources());
});

// Follow the next reading of one device (device -> broker -> app, and routing -> Event Hubs -> Kafka -> Cosmos DB).
router.post('/readings', (req, res) => {
  const deviceId = String(req.body?.deviceId || '');
  if (!DEVICE_ID.test(deviceId)) return res.status(400).json({ error: 'Invalid device ID.' });
  const presence = broker.presenceOf(deviceId);
  if (!presence?.online) return res.status(409).json({ error: `${deviceId} is not connected - connect it first.` });
  try {
    const t = engine.armReading(deviceId, { site: presence.site || config.site });
    return res.status(201).json(engine.view(t));
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/runs/:id', (req, res) => {
  const t = engine.get(String(req.params.id));
  if (!t) return res.status(404).json({ error: 'Unknown or expired trace.' });
  return res.json(engine.view(t));
});

// Commands are traced as they happen - whether sent from the dashboard or from this view.
router.get('/commands', (req, res) => {
  const deviceId = req.query.deviceId ? String(req.query.deviceId) : null;
  if (deviceId && !DEVICE_ID.test(deviceId)) return res.status(400).json({ error: 'Invalid device ID.' });
  const limit = Math.min(Math.max(Number(req.query.limit || 5), 1), 20);
  res.json(engine.latestCommands(deviceId, limit).map((t) => engine.view(t)));
});

// The machine's own log, fetched through the site gateway (existing request/response channel).
router.post('/commands/:id/device-log', wrap(async (req, res) => {
  const t = engine.get(String(req.params.id));
  if (!t || t.kind !== 'command') return res.status(404).json({ error: 'Unknown or expired command trace.' });
  const response = await devices.siteRequest('logs', { deviceId: t.deviceId, lines: 40 }, { site: t.site || config.site, timeoutMs: 10_000 });
  engine.attachDeviceLog(t.id, response.body?.lines || []);
  return res.json(engine.view(t));
}));

router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  res.status(err.statusCode || 500).json({ error: err.message });
});
