import { Router } from 'express';
import { config, describeMode } from './config.js';
import * as broker from './broker.js';
import * as certsvc from './certsvc.js';
import * as devices from './devices.js';
import * as kafka from './kafka.js';
import * as outages from './outages.js';
import * as store from './store/index.js';
import { TEMPLATES, templateFor, generateHistory } from './device-model.js';

export const router = Router();
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;

// ------------------------------------------------------------------ metadata
router.get('/health', wrap(async (req, res) => {
  const cs = await certsvc.health().catch((err) => ({ status: 'unreachable', error: err.message }));
  res.json({
    status: broker.isConnected() ? 'ok' : 'degraded',
    uptimeSeconds: Math.round(process.uptime()),
    mode: describeMode(),
    mqtt: broker.stats,
    kafka: kafka.kafkaStats,
    history: store.status(),
    quarantine: devices.quarantine,
    certificateService: cs,
  });
}));

router.get('/config', (req, res) => {
  res.json({
    ui: config.ui,
    broker: config.broker.namespace,
    mqttHost: config.broker.customDomain,
    site: config.site,
    features: { mqtt: broker.isConnected(), kafka: kafka.kafkaStats.connected, history: store.isCosmosActive() ? 'cosmos' : 'memory' },
    ranges: Object.entries(store.RANGES).map(([key, value]) => ({ key, label: value.label })),
  });
});

// ------------------------------------------------------------------- devices
router.get('/devices', wrap(async (req, res) => {
  res.json(await devices.list({ includeGateways: req.query.all === '1' }));
}));

router.get('/devices/connect-summary', wrap(async (req, res) => {
  const list = await devices.list();
  let site = null;
  try { site = (await devices.siteRequest('list')).body; } catch (err) { site = { error: err.message }; }
  const running = new Map((site?.devices || []).map((d) => [d.deviceId, d]));
  res.json({
    totalRegistered: list.length,
    totalConnected: list.filter((d) => d.status === 'Connected').length,
    totalMessagesSent: list.reduce((sum, d) => sum + d.messages, 0),
    telemetryPipeline: 'MQTT (Event Grid namespace) -> routing -> Event Hubs (Kafka) -> Cosmos DB',
    gateway: site?.gateway || null,
    siteError: site?.error || null,
    sessions: list.filter((d) => running.has(d.deviceId)).map((d) => ({
      deviceId: d.deviceId,
      template: d.template,
      uptimeSeconds: running.get(d.deviceId).startedAt
        ? Math.round((Date.now() - Date.parse(running.get(d.deviceId).startedAt)) / 1000) : null,
      messagesSent: d.messages,
      lastError: running.get(d.deviceId).running ? null : 'process not running',
      mode: d.status === 'Connected' ? 'mqtt 5 + mTLS via private endpoint' : 'starting / offline',
      certificate: running.get(d.deviceId).certificate,
    })),
  });
}));

router.post('/devices/disconnect-all', wrap(async (req, res) => {
  const site = (await devices.siteRequest('list')).body;
  const disconnected = [];
  for (const d of site.devices || []) {
    if (d.running) { await devices.disconnect(d.deviceId); disconnected.push(d.deviceId); }
  }
  res.json({ disconnected });
}));

router.post('/devices/connect-all', wrap(async (req, res) => {
  const results = [];
  for (const device of await devices.list()) {
    if (device.status === 'Connected' || device.status === 'Revoked') continue;
    try {
      await devices.connect(device.deviceId);
      results.push({ deviceId: device.deviceId, connected: true });
    } catch (err) {
      results.push({ deviceId: device.deviceId, connected: false, error: err.message });
    }
  }
  res.json({ results });
}));

router.post('/devices', wrap(async (req, res) => {
  const deviceId = String(req.body?.deviceId || '').trim();
  const template = String(req.body?.template || 'raspberry-pi');
  if (!DEVICE_ID.test(deviceId)) {
    return res.status(400).json({ error: 'Device ID must be 1-64 letters, digits, - or _ (it becomes the certificate CN and MQTT client ID).' });
  }
  if (!TEMPLATES[template]) return res.status(400).json({ error: `Unknown profile '${template}'.` });
  // certMinutes: optional short certificate lifetime for test devices (API only, not in the UI).
  const certMinutes = req.body?.certMinutes ? Number(req.body.certMinutes) : undefined;
  res.status(201).json(await devices.create({ deviceId, template, certMinutes }));
}));

router.get('/devices/:deviceId', wrap(async (req, res) => {
  const device = await devices.get(req.params.deviceId);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  res.json({ ...device, retainedState: broker.stateOf(req.params.deviceId) });
}));

router.delete('/devices/:deviceId', wrap(async (req, res) => {
  const steps = await devices.remove(req.params.deviceId);
  await store.clear(req.params.deviceId);
  res.json({ deleted: req.params.deviceId, steps });
}));

router.post('/devices/:deviceId/connect', wrap(async (req, res) => {
  res.json({ connected: true, session: await devices.connect(req.params.deviceId) });
}));

router.post('/devices/:deviceId/disconnect', wrap(async (req, res) => {
  res.json({ connected: false, ...(await devices.disconnect(req.params.deviceId)) });
}));

router.get('/devices/:deviceId/logs', wrap(async (req, res) => {
  res.json((await devices.siteRequest('logs', { deviceId: req.params.deviceId, lines: Number(req.query.lines || 40) })).body);
}));

router.post('/devices/:deviceId/motor', wrap(async (req, res) => {
  const { deviceId } = req.params;
  const targetRpm = req.body?.targetRpm;
  // No local shortcut: the setpoint moves only if the broker delivers the command and the
  // device accepts it, so the dashboard shows exactly what the device decided.
  let result;
  try {
    result = await devices.command(deviceId, 'setMotorSpeed', { targetRpm });
  } catch (err) {
    const status = err.statusCode || 502;
    return res.status(status).json({ deviceId, requestedRpm: targetRpm ?? null, accepted: false, error: err.message, detail: err.message });
  }
  const payload = result.body || {};
  res.json({
    deviceId,
    requestedRpm: targetRpm ?? null,
    accepted: result.status === 200 && payload.accepted !== false,
    status: result.status,
    response: payload,
    reason: payload.error || null,
    roundTripMs: result.ms,
  });
}));

router.post('/devices/:deviceId/buzzer', wrap(async (req, res) => {
  const on = req.body?.on === null ? null : Boolean(req.body?.on);
  const result = await devices.command(req.params.deviceId, on === null ? 'clearBuzzerOverride' : 'setBuzzer', { on });
  res.json({ deviceId: req.params.deviceId, buzzer: on, command: result });
}));

router.post('/devices/:deviceId/command', wrap(async (req, res) => {
  const method = String(req.body?.method || '');
  if (!/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(method)) return res.status(400).json({ error: 'method must be a simple name' });
  const result = await devices.command(req.params.deviceId, method, req.body?.payload || {});
  res.status(200).json({ deviceId: req.params.deviceId, method, status: result.status, response: result.body, roundTripMs: result.ms });
}));

router.post('/devices/:deviceId/renew', wrap(async (req, res) => {
  const result = await devices.command(req.params.deviceId, 'renewCertificate', {});
  res.json({ deviceId: req.params.deviceId, status: result.status, response: result.body });
}));

router.post('/devices/:deviceId/power-loss', wrap(async (req, res) => {
  const { deviceId } = req.params;
  if (!DEVICE_ID.test(deviceId)) return res.status(400).json({ error: 'Invalid device ID.' });
  const seconds = Math.min(Math.max(Number(req.body?.seconds || 20), 5), 600);
  // Registered before the command is sent: the Last Will can follow the command response within a second.
  outages.begin(deviceId, seconds);
  let result;
  try {
    result = await devices.command(deviceId, 'powerLoss', { seconds });
  } catch (err) {
    outages.cancel(deviceId, err.message);
    throw err;
  }
  if (result.status !== 200) outages.cancel(deviceId, `The device answered ${result.status}.`);
  res.json({ deviceId, status: result.status, response: result.body, episode: outages.get(deviceId) });
}));

router.get('/power-loss', (req, res) => {
  res.json(outages.list());
});

router.post('/devices/:deviceId/enabled', wrap(async (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  const doc = await devices.setEnabled(req.params.deviceId, enabled);
  res.json({ deviceId: req.params.deviceId, enabled, state: doc.state });
}));

router.post('/devices/:deviceId/token', wrap(async (req, res) => {
  res.json(await devices.issueToken(req.params.deviceId));
}));

// ----------------------------------------------------------------- templates
router.get('/templates', (req, res) => {
  res.json(Object.values(TEMPLATES).sort((a, b) => (a.order || 99) - (b.order || 99)).map((t) => ({
    id: t.id, name: t.name, description: t.description, metrics: t.metrics,
    fields: Object.fromEntries(Object.entries(t.fields).map(([k, s]) => [k, { min: s.min, max: s.max, unit: s.unit }])),
  })));
});

router.get('/templates/:id/script', wrap(async (req, res) => {
  const template = TEMPLATES[req.params.id];
  if (!template) return res.status(404).json({ error: 'Unknown template' });
  const deviceId = String(req.query.deviceId || '') || null;
  const token = deviceId ? devices.rememberedToken(deviceId) : null;
  const bundle = await certsvc.trustBundle();
  res.type('text/plain').send(onboardingScript({ template, deviceId, token, bundle }));
}));

function onboardingScript({ template, deviceId, token, bundle }) {
  const id = deviceId || '<DEVICE-ID>';
  const tokenLine = token
    ? `export IOT_ENROLL_TOKEN='${token}'   # one-time, valid 24 h - used once, then worthless`
    : "export IOT_ENROLL_TOKEN='<paste a one-time enrolment token>'   # Device Visibility > Script > New token";
  return `#!/usr/bin/env bash
# Contoso device onboarding - ${id} (${template.name} profile)
#
# What happens when this runs on the machine:
#   1. the agent generates the device's private key LOCALLY (EC P-256) - it never leaves the device
#   2. it enrols over private HTTPS (${'enroll.iot.example.com'}, via the site VPN) with the
#      one-time token and receives a 1-hour certificate signed by the Contoso device CA (Key Vault HSM)
#   3. it connects to mqtt.iot.example.com:8883 (private endpoint) with mutual TLS,
#      MQTT 5, client ID = certificate CN = ${id}
#   4. it renews its certificate over MQTT at minute 40 of 60 - no token, no files to copy, ever again
#
# Prerequisite: the Contoso agent package in /opt/iot/agent (Python 3.10+, paho-mqtt 2.1, cryptography,
# requests) - pre-installed on every Contoso edge image. No connection string, no shared key.
set -euo pipefail

export IOT_DEVICE_ID='${id}'
export IOT_PROFILE='${template.id}'
export IOT_SITE='${config.site}'
${tokenLine}
export IOT_ENROLL_URL='https://enroll.iot.example.com/v1'
export IOT_MQTT_HOST='${config.broker.customDomain}'
export IOT_STATE_DIR="\${HOME}/.iot/\${IOT_DEVICE_ID}"
mkdir -p "\${IOT_STATE_DIR}" && chmod 700 "\${IOT_STATE_DIR}"

# Trust anchors (PUBLIC certificates): Contoso root CA + server issuing CA. Event Grid presents only
# its leaf certificate, so the issuing CA must be here too.
cat > "\${IOT_STATE_DIR}/trust-bundle.pem" <<'PEM'
${bundle.trim()}
PEM
export IOT_TRUST_BUNDLE="\${IOT_STATE_DIR}/trust-bundle.pem"

exec python3 /opt/iot/agent/iot_device.py
`;
}

// ----------------------------------------------------------------- telemetry
router.get('/telemetry/:deviceId/latest', wrap(async (req, res) => {
  res.json((await store.latest(req.params.deviceId)) || null);
}));

router.get('/telemetry/:deviceId/history', wrap(async (req, res) => {
  res.json(await store.history(req.params.deviceId, String(req.query.range || 'hourly')));
}));

router.post('/telemetry/:deviceId/seed', wrap(async (req, res) => {
  const { deviceId } = req.params;
  const days = Math.min(Number(req.body?.days || 7), 30);
  const device = await devices.get(deviceId);
  const template = req.body?.template || device?.template || 'raspberry-pi';
  const readings = generateHistory(deviceId, templateFor(template).id, { days, everyMs: 60_000 });
  const { seeded, persisting } = await store.seed(readings, { persist: Boolean(req.body?.persist) });
  res.json({ deviceId, days, seeded, persisted: persisting, persistence: persisting ? 'writing to cosmos db in the background' : 'memory only' });
}));

// ---------------------------------------------------------- retained messages
router.get('/retained', (req, res) => {
  res.json({ fetchedAt: new Date().toISOString(), messages: broker.retainedSnapshot() });
});

router.post('/retained/late-joiner', wrap(async (req, res) => {
  res.json(await broker.lateJoiner({ listenMs: Math.min(Math.max(Number(req.body?.listenMs || 3000), 1000), 10000) }));
}));

router.delete('/retained', wrap(async (req, res) => {
  const topic = String(req.query.topic || '');
  if (!/^iot\/(status|state|config)\//.test(topic)) return res.status(400).json({ error: 'Only iot/status, iot/state and iot/config topics.' });
  await broker.publish(topic, '', { retain: true });
  res.json({ cleared: topic });
}));

// --------------------------------------------------------------- fleet config
router.get('/fleet-config', (req, res) => {
  res.json(broker.currentFleetConfig() || { version: 0, telemetryIntervalSeconds: 5, renewAtFraction: 0.67, note: 'not published yet' });
});

router.post('/fleet-config', wrap(async (req, res) => {
  const current = broker.currentFleetConfig() || { version: 0 };
  const next = {
    version: Number(current.version || 0) + 1,
    telemetryIntervalSeconds: Math.min(Math.max(Number(req.body?.telemetryIntervalSeconds ?? current.telemetryIntervalSeconds ?? 5), 1), 300),
    renewAtFraction: Math.min(Math.max(Number(req.body?.renewAtFraction ?? current.renewAtFraction ?? 0.67), 0.3), 0.9),
    updatedAt: new Date().toISOString(),
    updatedBy: config.ui.user,
  };
  // Retained: every device gets it the moment it subscribes, even if it was offline now.
  await broker.publish('iot/config/fleet', next, { retain: true });
  res.json(next);
}));

// --------------------------------------------------------------- certificates
router.get('/certificates', wrap(async (req, res) => {
  const [ca, server, inventory, events] = await Promise.all([
    certsvc.caInfo(), certsvc.serverCert(), devices.list({ includeGateways: true }), certsvc.events(null, 40),
  ]);
  res.json({ ca, server, inventory, events });
}));

router.post('/certificates/server/rotate', wrap(async (req, res) => {
  res.json(await certsvc.rotateServerCert());
}));

// ---------------------------------------------------------------- pipeline
router.get('/pipeline', (req, res) => {
  res.json({
    kafka: kafka.kafkaStats,
    quarantine: devices.quarantine,
    recent: kafka.recentEvents(Number(req.query.limit || 30)).map((e) => ({ ...e, quarantined: !devices.isAllowed(e.enrichments?.client) })),
    alerts: kafka.recentAlertEvents(),
    routing: {
      namespaceTopic: 'mqtt-routed (CloudEvents 1.0, 7-day retention)',
      enrichments: { site: '${client.attributes.site}', profile: '${client.attributes.profile}', client: '${client.authenticationName}' },
      subscriptions: [
        { name: 'es-telemetry', filter: "subject begins with 'iot/telemetry/'", destination: 'Event Hubs topic telemetry' },
        { name: 'es-alerts', filter: "subject begins with 'iot/telemetry/' AND data.temperature > 75", destination: 'Event Hubs topic alerts' },
      ],
    },
  });
});

router.use((err, req, res, next) => {
  const status = err.statusCode || 500;
  if (status >= 500) console.error('[api]', err.message);
  res.status(status).json({ error: err.message || 'Internal error' });
});
