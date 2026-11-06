/* Unit tests for the Behind the scenes trace engine - run with:  node --test test/trace-engine.test.js  (no packages needed) */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TraceEngine, LIMITS, isoToMs } from '../src/trace/engine.js';
import * as hooks from '../src/trace-hooks.js';

const T0 = Date.parse('2026-11-06T05:00:00.000Z');

function clock(start = T0) {
  let now = start;
  return { now: () => now, set: (v) => { now = v; }, add: (ms) => { now += ms; } };
}

function telemetry(deviceId, seq, { tsIso = '2026-11-06T05:00:00.123456Z', temperature = 61.2, rpm = 4500 } = {}) {
  return {
    topic: `iot/telemetry/site1/${deviceId}`,
    payload: Buffer.from(JSON.stringify({ deviceId, site: 'site1', seq, timestamp: tsIso, temperature, rpm, targetRpm: 4500 })),
    packet: { qos: 0, retain: false, properties: { contentType: 'application/json', payloadFormatIndicator: true } },
  };
}

function kafkaEvent(deviceId, seq, { topic = 'telemetry', time = '2026-11-06T05:00:00.1301234Z', temperature = 61.2, tsIso = '2026-11-06T05:00:00.123456Z' } = {}) {
  return {
    topic, partition: 1, offset: '4711', timestamp: String(T0 + 450),
    headers: { ce_id: Buffer.from('abc-123'), ce_source: Buffer.from('egns-iotmq-xxxxx') },
    event: {
      mode: 'binary', id: 'abc-123', type: 'MQTT.EventPublished', source: 'egns-iotmq-xxxxx', specversion: '1.0',
      subject: `iot/telemetry/site1/${deviceId}`, time, site: 'site1', profile: 'raspberry-pi', client: deviceId,
      data: { deviceId, site: 'site1', seq, timestamp: tsIso, temperature, rpm: 4500 },
    },
  };
}

test('isoToMs keeps sub-millisecond digits', () => {
  assert.equal(isoToMs('2026-11-06T05:00:00.123456Z'), T0 + 123.456);
  assert.ok(Math.abs(isoToMs('2026-11-06T05:00:00.1301234Z') - (T0 + 130.1234)) < 1e-6);
  assert.equal(isoToMs('2026-11-06T05:00:00Z'), T0);
  assert.equal(isoToMs('not a date'), null);
  assert.equal(isoToMs(null), null);
});

test('hooks are no-ops without a sink and never throw', () => {
  hooks.setSink(null);
  assert.equal(hooks.isActive(), false);
  hooks.emit('mqtt.message', { topic: 'x' });
  hooks.setSink(() => { throw new Error('boom'); });
  assert.doesNotThrow(() => hooks.emit('mqtt.message', { topic: 'x' }));
  hooks.setSink(null);
});

test('reading trace: device -> broker -> live + routing -> Event Hubs -> Kafka -> Cosmos DB', () => {
  const c = clock();
  const e = new TraceEngine({ now: c.now });
  const t = e.armReading('PUMP-07', { site: 'site1' });
  assert.equal(e.status(t), 'waiting');

  e.onMqttMessage({ ...telemetry('PUMP-08', 7), at: T0 + 140 }); // other device: ignored
  assert.equal(t.mqtt, null);
  e.onMqttMessage({ ...telemetry('PUMP-07', 42), at: T0 + 160 });
  assert.equal(t.mqtt.seq, 42);
  assert.equal(e.status(t), 'running');

  e.onKafkaMessage({ ...kafkaEvent('PUMP-07', 41), at: T0 + 900 }); // older reading: ignored
  assert.equal(t.kafka.telemetry, null);
  e.onKafkaMessage({ ...kafkaEvent('PUMP-07', 42), at: T0 + 980 });
  assert.equal(t.kafka.telemetry.offset, '4711');
  assert.equal(t.cloudEvent.enrichments.client, 'PUMP-07');

  const ts = Date.parse('2026-11-06T05:00:00.123456Z');
  e.onCosmosQueued({ deviceId: 'PUMP-07', ts, at: T0 + 985 });
  assert.equal(e.status(t), 'running');
  e.onCosmosWritten({ doc: { id: 'PUMP-07-x', deviceId: 'PUMP-07', ts }, startedAt: T0 + 2000, at: T0 + 2018, requestCharge: 6.86 });
  assert.equal(e.status(t), 'complete');

  const v = e.view(t);
  assert.equal(v.status, 'complete');
  assert.equal(v.summary.deviceToBrokerMs, 6.7);
  assert.equal(v.summary.deviceToAppLiveMs, 36.5);
  assert.equal(v.summary.requestCharge, 6.86);
  const byKey = Object.fromEntries(v.steps.map((s) => [s.key, s]));
  assert.equal(byKey.device.state, 'done');
  assert.equal(byKey.broker.state, 'done');
  assert.equal(byKey.eventhubs.at, T0 + 450);
  assert.equal(byKey.cosmos.state, 'done');
  assert.equal(byKey.alerts, undefined, 'no alerts step below 75 °C');
  assert.ok(v.raw.cloudEvent && v.raw.cloudEvent.id === 'abc-123');
  assert.ok(v.raw.kafkaHeaders.some((h) => h.name === 'ce_id' && h.value === 'abc-123'));
});

test('reading trace above 75 °C waits for the alerts record', () => {
  const c = clock();
  const e = new TraceEngine({ now: c.now });
  const t = e.armReading('PUMP-07');
  e.onMqttMessage({ ...telemetry('PUMP-07', 5, { temperature: 78.4 }), at: T0 + 100 });
  assert.equal(t.alertExpected, true);
  e.onKafkaMessage({ ...kafkaEvent('PUMP-07', 5, { temperature: 78.4 }), at: T0 + 700 });
  const ts = Date.parse('2026-11-06T05:00:00.123456Z');
  e.onCosmosWritten({ doc: { deviceId: 'PUMP-07', ts }, startedAt: T0 + 1000, at: T0 + 1010, requestCharge: 6.9 });
  c.set(T0 + 1500);
  assert.equal(e.status(t), 'running', 'alert still expected');
  e.onKafkaMessage({ ...kafkaEvent('PUMP-07', 5, { topic: 'alerts', temperature: 78.4 }), at: T0 + 1600 });
  assert.equal(e.status(t), 'complete');
  const v = e.view(t);
  assert.ok(v.steps.find((s) => s.key === 'alerts' && s.state === 'done'));
});

test('reading trace times out when no reading arrives', () => {
  const c = clock();
  const e = new TraceEngine({ now: c.now });
  const t = e.armReading('PUMP-07');
  c.add(LIMITS.readingWaitMs + 1);
  assert.equal(e.status(t), 'no-reading');
  e.onMqttMessage({ ...telemetry('PUMP-07', 1), at: c.now() });
  assert.equal(t.mqtt, null, 'an expired trace does not pick up later readings');
});

test('quarantined device: Cosmos DB step is skipped, trace completes after Kafka', () => {
  const c = clock();
  const e = new TraceEngine({ now: c.now, isAllowed: () => false });
  const t = e.armReading('PUMP-99');
  e.onMqttMessage({ ...telemetry('PUMP-99', 3), at: T0 + 100 });
  e.onKafkaMessage({ ...kafkaEvent('PUMP-99', 3), at: T0 + 600 });
  assert.equal(e.status(t), 'complete');
  assert.equal(e.view(t).steps.find((s) => s.key === 'cosmos').state, 'skipped');
});

test('limits the number of running reading traces', () => {
  const e = new TraceEngine({ now: clock().now });
  for (let i = 0; i < LIMITS.maxActiveReadings; i += 1) e.armReading(`D${i}`);
  assert.throws(() => e.armReading('D-extra'), /Too many traces/);
});

test('command trace: HTTP -> MQTT 5 request -> PUBACK -> response -> retained state -> next reading', () => {
  const c = clock();
  const e = new TraceEngine({ now: c.now });
  const http = { arrivedAt: T0, method: 'POST', path: '/api/devices/PUMP-07/motor', azureRef: '20261106T050000Z-abc', viaFrontDoor: true, finishedAt: null, statusCode: null };
  const corr = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  e.onRequest({ topic: 'iot/site/site1/sim/req', body: {}, responseTopic: 'iot/site/site1/sim/res', correlation: 'ffff', at: T0 });
  assert.equal(e.size(), 0, 'site-agent requests are not traced');
  e.onRequest({ topic: 'iot/cmd/site1/PUMP-07/setMotorSpeed', body: { targetRpm: 5900 }, responseTopic: 'iot/cmdres/site1/PUMP-07',
    correlation: corr.toString('hex'), expirySeconds: 30, at: T0 + 3, http });
  const [t] = e.latestCommands('PUMP-07');
  assert.equal(t.method, 'setMotorSpeed');
  e.onPuback({ correlation: corr.toString('hex'), at: T0 + 41 });
  e.onMqttMessage({ topic: 'iot/cmdres/site1/PUMP-07', payload: Buffer.from('{"accepted":true,"targetRpm":5900}'),
    packet: { qos: 1, properties: { correlationData: corr, userProperties: { status: '200' } } }, at: T0 + 180 });
  assert.equal(t.response.status, 200);
  http.finishedAt = T0 + 186; http.statusCode = 200;
  e.onMqttMessage({ topic: 'iot/state/site1/PUMP-07', payload: Buffer.from('{"targetRpm":5900,"updatedAt":"2026-11-06T05:00:00Z"}'),
    packet: { qos: 1, retain: false, properties: {} }, at: T0 + 220 });
  assert.equal(e.status(t), 'finishing');
  e.onMqttMessage({ ...telemetry('PUMP-07', 99, { rpm: 4620 }), at: T0 + 2500 });
  assert.equal(e.status(t), 'complete');
  const v = e.view(t);
  assert.equal(v.summary.brokerAckMs, 38);
  assert.equal(v.summary.roundTripMs, 177);
  assert.equal(v.summary.appTotalMs, 186);
  assert.equal(v.summary.azureRef, '20261106T050000Z-abc');
  assert.equal(v.steps.find((s) => s.key === 'state').state, 'done');

  const log = e.attachDeviceLog(t.id, ['2026-11-06T05:00:00Z connected', "2026-11-06T05:00:00Z <- command setMotorSpeed {'targetRpm': 5900} -> 200"]);
  assert.ok(log.match.includes('setMotorSpeed'));
  assert.equal(log.deviceTime, T0);
  assert.equal(e.view(t).steps.find((s) => s.key === 'device').state, 'done');
});

test('refused command (404) completes at once - no state or reading expected', () => {
  const c = clock();
  const e = new TraceEngine({ now: c.now });
  const corr = Buffer.from('0a0b', 'hex');
  e.onRequest({ topic: 'iot/cmd/site1/SENSOR-01/setMotorSpeed', body: { targetRpm: 3000 }, responseTopic: 'iot/cmdres/site1/SENSOR-01',
    correlation: corr.toString('hex'), expirySeconds: 30, at: T0 });
  e.onMqttMessage({ topic: 'iot/cmdres/site1/SENSOR-01', payload: Buffer.from('{"error":"This device has no motor."}'),
    packet: { qos: 1, properties: { correlationData: corr, userProperties: { status: '404' } } }, at: T0 + 150 });
  const [t] = e.latestCommands('SENSOR-01');
  assert.equal(e.status(t), 'complete');
  const v = e.view(t);
  assert.equal(v.summary.responseStatus, 404);
  assert.equal(v.steps.find((s) => s.key === 'state').state, 'skipped');
  assert.equal(v.steps.find((s) => s.key === 'reading').state, 'skipped');
  assert.equal(v.steps.find((s) => s.key === 'response').deltaMs, 150);
});

test('command without an answer ends as no-response', () => {
  const c = clock();
  const e = new TraceEngine({ now: c.now });
  e.onRequest({ topic: 'iot/cmd/site1/PUMP-07/selfDestruct', body: {}, responseTopic: 'iot/cmdres/site1/PUMP-07', correlation: 'aa', at: T0 });
  c.add(LIMITS.commandLifeMs + 1);
  const [t] = e.latestCommands();
  assert.equal(e.status(t), 'no-response');
});

test('keeps at most LIMITS.maxTraces traces', () => {
  const c = clock();
  const e = new TraceEngine({ now: c.now });
  for (let i = 0; i < LIMITS.maxTraces + 12; i += 1) {
    e.onRequest({ topic: `iot/cmd/site1/D${i}/ping`, body: {}, responseTopic: 'r', correlation: `c${i}`, at: T0 + i });
    c.add(1);
  }
  assert.equal(e.size(), LIMITS.maxTraces);
});
