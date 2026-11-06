import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import { ROOT, config, describeMode } from './src/config.js';
import { router } from './src/routes.js';
import * as broker from './src/broker.js';
import * as devices from './src/devices.js';
import * as kafka from './src/kafka.js';
import * as outages from './src/outages.js';
import * as store from './src/store/index.js';

const app = express();
app.disable('x-powered-by');

// KafkaJS computes a negative throttle delay in RequestQueue.scheduleCheckPendingRequests; Node 23+
// clamps it to 1 ms and prints TimeoutNegativeWarning. Harmless - silence only that warning.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name !== 'TimeoutNegativeWarning') console.warn(warning);
});
app.use(express.json({ limit: '256kb' }));

// Optional "Behind the scenes" view (src/trace). Loaded on its own: if it is turned off (IOT_TRACE=off)
// or fails to load, the app runs exactly as before without it.
const trace = await loadTrace();
if (trace) {
  app.use('/api/devices', trace.httpContext);
  app.use('/api/trace', trace.router);
}

app.use('/api', router);
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

const server = http.createServer(app);
const io = new SocketServer(server, { cors: { origin: false } });

async function main() {
  await store.init();

  // Live path: MQTT -> browser (and the hot cache for instant charts).
  broker.bus.on('reading', (reading) => {
    if (!devices.admit(reading.deviceId)) return;
    store.appendLive(reading).catch(() => {});
    io.emit('telemetry', reading);
  });
  broker.bus.on('status', (s) => io.emit('status', s));
  broker.bus.on('state', (s) => io.emit('state', s));
  broker.bus.on('config', (c) => io.emit('config', c));

  // Power-loss episodes: requested -> Last Will (offline) -> back online, pushed to every browser.
  outages.attach(broker.bus);
  outages.updates.on('update', (e) => io.emit('powerloss', e));

  // Durable path: Event Grid routing -> Event Hubs -> Kafka -> Cosmos DB.
  kafka.pipeline.on('reading', (reading) => {
    if (devices.admit(reading.deviceId)) store.persist(reading).catch(() => {});
  });
  kafka.pipeline.on('event', (e) => io.emit('kafka', { ...e, quarantined: !devices.isAllowed(e.enrichments?.client) }));
  kafka.pipeline.on('alert', (a) => { if (devices.admit(a.deviceId)) io.emit('alert', a); });

  // Which clients may contribute data (registered and not revoked) - refreshed every minute.
  await devices.refreshAllowed().catch((err) => console.warn('[quarantine] initial load failed:', err.message));
  setInterval(() => devices.refreshAllowed().catch(() => {}), 60_000).unref();

  await broker.start();
  kafka.start().catch((err) => {
    kafka.kafkaStats.lastError = err.message;
    console.error('[kafka] start failed:', err.message);
  });

  io.on('connection', (socket) => socket.emit('hello', { mode: describeMode(), ui: config.ui }));

  server.listen(config.port, '127.0.0.1', () => {
    const mode = describeMode();
    console.log(`\n  ${config.ui.title}\n  ${config.publicUrl || `http://127.0.0.1:${config.port}`}`);
    console.log(`  Broker    : ${mode.broker}\n  Telemetry : ${mode.telemetry}\n  History   : ${mode.history}\n`);
  });
}

async function loadTrace() {
  if (String(process.env.IOT_TRACE || 'on').trim().toLowerCase() === 'off') {
    console.log('[trace] IOT_TRACE=off - Behind the scenes view disabled');
    return null;
  }
  try {
    const mod = await import('./src/trace/index.js');
    mod.install();
    return mod;
  } catch (err) {
    console.warn('[trace] Behind the scenes view disabled - the module failed to load:', err.message);
    return null;
  }
}

async function shutdown(signal) {
  console.log(`[server] ${signal} - shutting down`);
  await kafka.stop().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  console.error('[server] fatal:', err);
  process.exit(1);
});
