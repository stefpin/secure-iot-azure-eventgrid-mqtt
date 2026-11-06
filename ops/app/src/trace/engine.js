/*
 * Trace engine - the correlation logic behind the "Behind the scenes" view.
 * Pure JavaScript: no network, no Azure SDK, no timers - so it can be unit-tested on its own.
 *
 * Reading trace (device -> cloud), armed for one device; follows its NEXT telemetry message:
 *   device publish -> broker (CloudEvent time) -> live MQTT delivery to the app
 *   -> routing (namespace topic, enrichments) -> Event Hubs (Kafka record) -> app Kafka consumer -> Cosmos DB
 *   matched by device + sequence number (seq); the Cosmos DB write by device + device timestamp.
 *
 * Command trace (cloud -> device), recorded for every MQTT 5 command the app sends:
 *   HTTP request (Front Door headers) -> MQTT publish -> PUBACK -> device response (correlation data)
 *   -> retained state -> next reading.
 *
 * Timestamps come from three clocks (device VM, Event Grid / Event Hubs, operator VM); differences of a
 * few milliseconds between them are normal.
 */

export const LIMITS = {
  maxTraces: 30,
  maxActiveReadings: 5,
  readingWaitMs: 30_000, // armed -> first reading must arrive within this time
  readingFollowMs: 45_000, // first reading -> Kafka + Cosmos DB within this time
  alertGraceMs: 10_000, // after the Kafka telemetry record, how long an expected alert may lag
  commandFollowMs: 20_000, // response -> retained state and next reading within this time
  commandLifeMs: 60_000,
};

const MAX_TEXT = 4000;

/** ISO 8601 -> epoch milliseconds, keeping sub-millisecond digits (device: microseconds, Event Grid: 100 ns). */
export function isoToMs(value) {
  if (typeof value !== 'string' || !value) return null;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/.exec(value.trim());
  if (!m) {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  const base = Date.parse(`${m[1]}${m[3] || 'Z'}`);
  if (!Number.isFinite(base)) return null;
  return base + (m[2] ? Number(`0.${m[2]}`) * 1000 : 0);
}

function parseBody(payload) {
  if (payload === null || payload === undefined) return null;
  const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 200) }; }
}

function small(value) {
  if (value === undefined) return null;
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return null;
    return text.length > MAX_TEXT ? { truncated: text.slice(0, MAX_TEXT) } : JSON.parse(text);
  } catch {
    return null;
  }
}

function headerList(headers) {
  const out = [];
  if (!headers || typeof headers !== 'object') return out;
  for (const [name, value] of Object.entries(headers)) {
    let text = '';
    if (Buffer.isBuffer(value)) text = value.toString('utf8');
    else if (Array.isArray(value)) text = value.map((v) => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v))).join(',');
    else text = String(value);
    out.push({ name, value: text.length > 120 ? `${text.slice(0, 120)}…` : text });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function userStatus(packet) {
  const value = packet?.properties?.userProperties?.status;
  const n = Number(Array.isArray(value) ? value[0] : value);
  return Number.isFinite(n) && n > 0 ? n : 200;
}

const VALUE_KEYS = ['rpm', 'targetRpm', 'temperature', 'lux', 'humidity', 'buzzer', 'alarm', 'thermalAlarm'];
function pickValues(body) {
  const out = {};
  if (!body || typeof body !== 'object') return out;
  for (const key of VALUE_KEYS) if (key in body && ['number', 'boolean', 'string'].includes(typeof body[key])) out[key] = body[key];
  return out;
}

const round = (ms) => (ms === null || ms === undefined || !Number.isFinite(ms) ? null : Math.round(ms * 10) / 10);

export class TraceEngine {
  constructor({ now = () => Date.now(), isAllowed = () => true, historyBackend = () => 'cosmos db' } = {}) {
    this.now = now;
    this.isAllowed = isAllowed;
    this.historyBackend = historyBackend;
    this.traces = new Map(); // id -> trace, oldest first
    this.byCorrelation = new Map(); // correlation hex -> command trace awaiting its response
    this.counter = 0;
  }

  // ------------------------------------------------------------------ bookkeeping
  newId(prefix) {
    this.counter += 1;
    return `${prefix}${this.now().toString(36)}${this.counter.toString(36)}`;
  }

  remember(trace) {
    this.traces.set(trace.id, trace);
    while (this.traces.size > LIMITS.maxTraces) {
      const oldestId = this.traces.keys().next().value;
      const oldest = this.traces.get(oldestId);
      if (oldest?.mqtt?.correlation) this.byCorrelation.delete(oldest.mqtt.correlation);
      this.traces.delete(oldestId);
    }
  }

  get(id) {
    return this.traces.get(id) || null;
  }

  size() {
    return this.traces.size;
  }

  // ------------------------------------------------------------------ reading traces (device -> cloud)
  armReading(deviceId, { site = null } = {}) {
    const running = [...this.traces.values()].filter((t) => t.kind === 'reading' && !this.isDone(t));
    if (running.length >= LIMITS.maxActiveReadings) {
      throw Object.assign(new Error('Too many traces are running - wait a few seconds and try again.'), { statusCode: 429 });
    }
    const trace = {
      id: this.newId('r'), kind: 'reading', deviceId, site, armedAt: this.now(),
      mqtt: null, cloudEvent: null, kafka: { telemetry: null, alerts: null }, cosmos: null,
      alertExpected: false, temperature: null, quarantined: !this.isAllowed(deviceId), historyBackend: this.historyBackend(),
    };
    this.remember(trace);
    return trace;
  }

  onMqttMessage({ topic, payload, packet, at } = {}) {
    if (typeof topic !== 'string' || this.traces.size === 0) return;
    const parts = topic.split('/');
    const kind = parts[1];
    const when = Number.isFinite(at) ? at : this.now();
    if (kind === 'telemetry' && parts.length >= 4) this.onTelemetry(parts, topic, payload, packet, when);
    else if (kind === 'cmdres') this.onResponse(topic, payload, packet, when);
    else if (kind === 'state' && parts.length >= 4) this.onState(parts, topic, payload, packet, when);
  }

  onTelemetry(parts, topic, payload, packet, at) {
    const deviceId = parts[3];
    let body;
    for (const t of this.traces.values()) {
      if (t.deviceId !== deviceId) continue;
      if (t.kind === 'reading' && !t.mqtt && !this.isExpired(t)) {
        if (body === undefined) body = parseBody(payload);
        if (!body || typeof body !== 'object' || body.raw) continue;
        const tsKey = typeof body.timestamp === 'string' ? Date.parse(body.timestamp) : NaN;
        t.site = t.site || parts[2];
        t.mqtt = {
          topic,
          receivedAt: at,
          qos: packet?.qos ?? null,
          retain: Boolean(packet?.retain),
          bytes: Buffer.isBuffer(payload) ? payload.length : (payload ? String(payload).length : 0),
          contentType: packet?.properties?.contentType ?? null,
          payloadFormatIndicator: packet?.properties?.payloadFormatIndicator ?? null,
          payload: small(body),
          seq: Number.isFinite(body.seq) ? body.seq : null,
          deviceTimeIso: typeof body.timestamp === 'string' ? body.timestamp : null,
          deviceTime: isoToMs(body.timestamp),
          tsKey: Number.isFinite(tsKey) ? tsKey : null,
        };
        t.temperature = typeof body.temperature === 'number' ? body.temperature : null;
        t.alertExpected = t.temperature !== null && t.temperature > 75;
        t.quarantined = !this.isAllowed(deviceId);
        t.historyBackend = this.historyBackend();
      } else if (t.kind === 'command' && t.response && !t.nextReading
        && at >= t.response.receivedAt && at - t.response.receivedAt <= LIMITS.commandFollowMs) {
        if (body === undefined) body = parseBody(payload);
        if (!body || typeof body !== 'object') continue;
        t.nextReading = { receivedAt: at, seq: Number.isFinite(body.seq) ? body.seq : null, values: pickValues(body) };
      }
    }
  }

  onKafkaMessage({ topic, partition, offset, timestamp, headers, event, at } = {}) {
    if (!event || typeof event !== 'object' || this.traces.size === 0) return;
    const subject = typeof event.subject === 'string' ? event.subject : null;
    const data = event.data && typeof event.data === 'object' ? event.data : null;
    if (!subject || !data) return;
    const when = Number.isFinite(at) ? at : this.now();
    for (const t of this.traces.values()) {
      if (t.kind !== 'reading' || !t.mqtt || subject !== t.mqtt.topic || this.isExpired(t)) continue;
      const same = t.mqtt.seq !== null
        ? data.seq === t.mqtt.seq
        : (typeof data.timestamp === 'string' && Date.parse(data.timestamp) === t.mqtt.tsKey);
      if (!same) continue;
      const record = {
        topic,
        partition: Number.isFinite(Number(partition)) ? Number(partition) : null,
        offset: offset === undefined || offset === null ? null : String(offset),
        enqueuedAt: Number.isFinite(Number(timestamp)) && Number(timestamp) > 0 ? Number(timestamp) : null,
        receivedAt: when,
        mode: event.mode || null,
        headers: headerList(headers),
      };
      if (topic === 'alerts') { if (!t.kafka.alerts) t.kafka.alerts = record; } else if (!t.kafka.telemetry) t.kafka.telemetry = record;
      if (!t.cloudEvent) {
        const attributes = {};
        for (const [key, value] of Object.entries(event)) {
          if (key === 'data' || key === 'mode' || key === 'data_base64') continue;
          if (['string', 'number', 'boolean'].includes(typeof value)) attributes[key] = value;
        }
        t.cloudEvent = {
          id: event.id || null, type: event.type || null, source: event.source || null, subject,
          specversion: event.specversion || null, time: event.time || null, timeMs: isoToMs(event.time),
          datacontenttype: event.datacontenttype || null,
          enrichments: { site: event.site ?? null, profile: event.profile ?? null, client: event.client ?? null },
          attributes, data: small(data),
        };
      }
    }
  }

  onCosmosQueued({ deviceId, ts, at } = {}) {
    if (this.traces.size === 0) return;
    for (const t of this.traces.values()) {
      if (t.kind !== 'reading' || !t.mqtt || t.deviceId !== deviceId || t.mqtt.tsKey !== ts) continue;
      t.cosmos = t.cosmos || {};
      if (!t.cosmos.queuedAt) t.cosmos.queuedAt = Number.isFinite(at) ? at : this.now();
    }
  }

  onCosmosWritten({ doc, startedAt, at, requestCharge, statusCode, activityId, serverTs, error } = {}) {
    if (!doc || this.traces.size === 0) return;
    for (const t of this.traces.values()) {
      if (t.kind !== 'reading' || !t.mqtt || t.deviceId !== doc.deviceId || t.mqtt.tsKey !== doc.ts) continue;
      t.cosmos = t.cosmos || {};
      if (t.cosmos.writtenAt) continue;
      Object.assign(t.cosmos, {
        startedAt: Number.isFinite(startedAt) ? startedAt : null,
        writtenAt: Number.isFinite(at) ? at : this.now(),
        requestCharge: Number.isFinite(requestCharge) ? Math.round(requestCharge * 100) / 100 : null,
        statusCode: statusCode ?? null,
        activityId: activityId || null,
        serverTs: Number.isFinite(serverTs) ? serverTs : null,
        error: error || null,
        document: small(doc),
      });
    }
  }

  // ------------------------------------------------------------------ command traces (cloud -> device)
  onRequest({ topic, body, responseTopic, correlation, expirySeconds, at, http } = {}) {
    if (typeof topic !== 'string' || !topic.startsWith('iot/cmd/') || !correlation) return;
    const [, , site, deviceId, ...rest] = topic.split('/');
    const when = Number.isFinite(at) ? at : this.now();
    const trace = {
      id: this.newId('c'), kind: 'command', deviceId, site, method: rest.join('/'), body: small(body ?? {}),
      startedAt: when, http: http || null,
      mqtt: { topic, correlation, publishedAt: when, pubackAt: null, pubackError: null, responseTopic: responseTopic || null,
        expirySeconds: expirySeconds ?? null, qos: 1, contentType: 'application/json' },
      response: null, state: null, nextReading: null, deviceLog: null,
    };
    this.remember(trace);
    this.byCorrelation.set(correlation, trace);
    // Forget requests that never got an answer.
    for (const [key, t] of this.byCorrelation) {
      if (this.now() - t.startedAt > LIMITS.commandLifeMs) this.byCorrelation.delete(key);
    }
  }

  onPuback({ correlation, at, error } = {}) {
    const t = this.byCorrelation.get(correlation);
    if (!t || t.mqtt.pubackAt) return;
    t.mqtt.pubackAt = Number.isFinite(at) ? at : this.now();
    t.mqtt.pubackError = error || null;
  }

  onResponse(topic, payload, packet, at) {
    const corr = packet?.properties?.correlationData;
    if (!corr || this.byCorrelation.size === 0) return;
    const key = Buffer.from(corr).toString('hex');
    const t = this.byCorrelation.get(key);
    if (!t) return;
    this.byCorrelation.delete(key);
    const userProperties = packet?.properties?.userProperties || {};
    t.response = { receivedAt: at, topic, status: userStatus(packet), body: small(parseBody(payload) || {}), userProperties: small(userProperties) };
  }

  onState(parts, topic, payload, packet, at) {
    const deviceId = parts[3];
    let body;
    for (const t of this.traces.values()) {
      if (t.kind !== 'command' || t.deviceId !== deviceId || !t.response || t.state) continue;
      if (at < t.mqtt.publishedAt || at - t.response.receivedAt > LIMITS.commandFollowMs) continue;
      if (body === undefined) body = parseBody(payload);
      if (!body || typeof body !== 'object') continue;
      t.state = { receivedAt: at, topic, retainFlagOnDelivery: Boolean(packet?.retain), values: pickValues(body),
        updatedAt: typeof body.updatedAt === 'string' ? body.updatedAt : null };
    }
  }

  attachDeviceLog(id, lines, fetchedAt = this.now()) {
    const t = this.get(id);
    if (!t || t.kind !== 'command') return null;
    const list = Array.isArray(lines) ? lines.map(String).slice(-60) : [];
    const needle = `<- command ${t.method}`;
    const match = [...list].reverse().find((line) => line.includes(needle)) || null;
    t.deviceLog = { fetchedAt, lines: list, match, deviceTime: match ? isoToMs(match.split(' ')[0]) : null };
    return t.deviceLog;
  }

  latestCommands(deviceId = null, limit = 10) {
    return [...this.traces.values()]
      .filter((t) => t.kind === 'command' && (!deviceId || t.deviceId === deviceId))
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit);
  }

  // ------------------------------------------------------------------ state
  isExpired(t) {
    const now = this.now();
    if (t.kind === 'reading') return t.mqtt ? now - t.mqtt.receivedAt > LIMITS.readingFollowMs : now - t.armedAt > LIMITS.readingWaitMs;
    return now - t.startedAt > LIMITS.commandLifeMs;
  }

  isDone(t) {
    if (t.kind === 'reading') {
      if (!t.mqtt) return this.isExpired(t);
      return this.readingComplete(t) || this.isExpired(t);
    }
    return Boolean(t.response && this.commandSettled(t)) || this.isExpired(t);
  }

  /** A command is settled when its visible effects arrived: for an accepted speed change the retained state and the next reading. */
  commandSettled(t) {
    if (!t.response) return false;
    const expectsEffects = t.method === 'setMotorSpeed' && t.response.status === 200;
    return !expectsEffects || Boolean(t.state && t.nextReading);
  }

  readingComplete(t) {
    if (!t.mqtt || !t.kafka.telemetry) return false;
    const stored = t.historyBackend !== 'cosmos db' || t.quarantined || Boolean(t.cosmos?.writtenAt);
    const alertsSettled = !t.alertExpected || Boolean(t.kafka.alerts)
      || this.now() - t.kafka.telemetry.receivedAt > LIMITS.alertGraceMs;
    return stored && alertsSettled;
  }

  status(t) {
    if (t.kind === 'reading') {
      if (!t.mqtt) return this.isExpired(t) ? 'no-reading' : 'waiting';
      if (this.readingComplete(t)) return 'complete';
      return this.isExpired(t) ? 'partial' : 'running';
    }
    if (t.response && this.commandSettled(t)) return 'complete';
    if (this.isExpired(t)) return t.response ? 'complete' : 'no-response';
    return t.response ? 'finishing' : 'running';
  }

  // ------------------------------------------------------------------ views
  view(t) {
    if (!t) return null;
    return t.kind === 'reading' ? this.readingView(t) : this.commandView(t);
  }

  readingView(t) {
    const st = this.status(t);
    const over = st !== 'running' && st !== 'waiting';
    const pending = (has) => (has ? 'done' : over ? 'missed' : 'waiting');
    const m = t.mqtt;
    const ce = t.cloudEvent;
    const kt = t.kafka.telemetry;
    const ka = t.kafka.alerts;
    const steps = [];

    steps.push({
      key: 'device', title: `${t.deviceId} publishes a reading`, where: 'device', clock: 'device', at: m?.deviceTime ?? null,
      state: pending(m),
      facts: m ? [
        ['Topic', m.topic], ['QoS', '1 (at least once)'], ['Sequence number', m.seq ?? '—'],
        ['Payload', `${m.bytes} bytes of JSON, MQTT 5 content type ${m.contentType || 'application/json'}`],
        ['Device time', m.deviceTimeIso || '—'],
      ] : [['Waiting for', `the next reading from ${t.deviceId} (one every few seconds)`]],
    });
    steps.push({
      key: 'network', title: 'Private network path', where: 'network', clock: null, at: null, state: m ? 'info' : pending(false),
      facts: [['Broker name', 'mqtt.iot.example.com -> 10.40.2.4 (private endpoint pe-eg-mqtt)'],
        ['Path', 'mine site -> site-to-site IPsec VPN -> hub network'], ['Transport', 'MQTT 5 over TLS 1.2+, port 8883, mutual TLS']],
    });
    steps.push({
      key: 'broker', title: 'Event Grid MQTT broker accepts it', where: 'eventgrid', clock: 'broker', at: ce?.timeMs ?? null,
      from: 'device', state: pending(ce),
      facts: [['Authenticated as', `${t.deviceId} - X.509 certificate chain to the Contoso device issuing CA`],
        ['Authorised by', 'client group cg-devices -> permission binding pb-dev-pub -> topic space ts-dev-pub'],
        ['Topic template', 'iot/telemetry/${client.attributes.site}/${client.authenticationName}'],
        ...(ce ? [['Broker time', `${ce.time} (when Event Grid received it)`]] : [])],
    });
    steps.push({
      key: 'live', title: 'Delivered live to the operator app (MQTT)', where: 'opsvm', clock: 'app', at: m?.receivedAt ?? null,
      from: 'broker', state: pending(m),
      facts: m ? [['Subscriber', 'iot-operator-app - Microsoft Entra ID token (managed identity id-iotmq-app)'],
        ['Subscription', `iot/telemetry/# - delivered at QoS ${m.qos ?? 0} (live view)`],
        ['Authorised by', 'Azure RBAC: EventGrid TopicSpaces Subscriber on ts-app-sub'],
        ['Next hop', 'browser, over WebSocket (socket.io) through Front Door']] : [],
    });
    steps.push({
      key: 'routing', title: 'Routed as a CloudEvent to the namespace topic', where: 'eventgrid', clock: 'broker', at: null,
      state: pending(ce),
      facts: ce ? [['CloudEvent id', ce.id], ['type / source', `${ce.type} / ${ce.source}`], ['subject', ce.subject],
        ['Enrichments', `site=${ce.enrichments.site ?? '—'}, profile=${ce.enrichments.profile ?? '—'}, client=${ce.enrichments.client ?? '—'}`],
        ['Namespace topic', 'mqtt-routed (CloudEvents 1.0, 7-day retention)']] : [['Namespace topic', 'mqtt-routed']],
    });
    const alertFact = t.temperature === null
      ? ['es-alerts', 'filter data.temperature > 75 - no temperature in this reading: not matched']
      : ['es-alerts', `filter data.temperature > 75 - temperature ${t.temperature}: ${t.alertExpected ? (ka ? 'MATCHED' : 'should match') : 'not matched'}`];
    steps.push({
      key: 'subscriptions', title: 'Event subscriptions filter and push it', where: 'eventgrid', clock: null, at: null,
      state: kt ? 'info' : pending(false),
      facts: [['es-telemetry', "filter subject begins with 'iot/telemetry/' - matched"], alertFact,
        ['Delivery', "push to Event Hubs with the namespace's managed identity (Azure Event Hubs Data Sender)"]],
    });
    steps.push({
      key: 'eventhubs', title: 'Stored in Event Hubs: telemetry', where: 'eventhubs', clock: 'event hubs', at: kt?.enqueuedAt ?? null,
      from: 'broker', state: pending(kt),
      facts: kt ? [['Event hub (Kafka topic)', `${kt.topic}, partition ${kt.partition ?? '—'}, offset ${kt.offset ?? '—'}`],
        ['Enqueued', kt.enqueuedAt ? new Date(kt.enqueuedAt).toISOString() : '—']] : [],
    });
    if (t.alertExpected || ka) {
      steps.push({
        key: 'alerts', title: 'Also stored in Event Hubs: alerts', where: 'eventhubs', clock: 'event hubs', at: ka?.enqueuedAt ?? null,
        from: 'broker', state: pending(ka),
        facts: ka ? [['Event hub (Kafka topic)', `${ka.topic}, partition ${ka.partition ?? '—'}, offset ${ka.offset ?? '—'}`]] : [],
      });
    }
    steps.push({
      key: 'kafka', title: 'Operator app reads it over Kafka', where: 'opsvm', clock: 'app', at: kt?.receivedAt ?? null,
      from: 'eventhubs', state: pending(kt),
      facts: kt ? [['Endpoint', 'Event Hubs Kafka endpoint :9093 through private endpoint pe-eh'],
        ['Consumer', 'group iot-operator-app - SASL OAUTHBEARER (Microsoft Entra ID)'],
        ['CloudEvent mode', `${kt.mode || '—'}${kt.headers.length ? ` (${kt.headers.length} Kafka headers)` : ''}`]] : [],
    });
    let cosmosState = pending(t.cosmos?.writtenAt);
    const cosmosFacts = [];
    if (t.quarantined) {
      cosmosState = 'skipped';
      cosmosFacts.push(['Not stored', `${t.deviceId} is not registered or is revoked - its data is quarantined`]);
    } else if (t.historyBackend !== 'cosmos db') {
      cosmosState = 'skipped';
      cosmosFacts.push(['History backend', t.historyBackend]);
    } else {
      cosmosFacts.push(['Container', 'iotmq / telemetry, partition key /deviceId']);
      if (t.cosmos?.writtenAt) {
        cosmosFacts.push(['Request charge', t.cosmos.requestCharge !== null ? `${t.cosmos.requestCharge} RU` : '—']);
        if (t.cosmos.startedAt) cosmosFacts.push(['Write latency', `${round(t.cosmos.writtenAt - t.cosmos.startedAt)} ms`]);
        if (t.cosmos.queuedAt && t.cosmos.startedAt) cosmosFacts.push(['Batched for', `${round(t.cosmos.startedAt - t.cosmos.queuedAt)} ms (writes are flushed every 2 s)`]);
        cosmosFacts.push(['Document id', t.cosmos.document?.id || '—']);
      }
      cosmosFacts.push(['Access', 'keyless: Entra ID, Cosmos DB Built-in Data Contributor, private endpoint']);
    }
    steps.push({ key: 'cosmos', title: 'Written to Cosmos DB (history)', where: 'cosmos', clock: 'app', at: t.cosmos?.writtenAt ?? null,
      from: 'kafka', state: cosmosState, facts: cosmosFacts });

    addDeltas(steps);
    const startAt = m?.deviceTime ?? null;
    const endAt = t.cosmos?.writtenAt ?? kt?.receivedAt ?? null;
    return {
      id: t.id, kind: 'reading', deviceId: t.deviceId, site: t.site, status: st, armedAt: t.armedAt,
      summary: {
        deviceToBrokerMs: m && ce?.timeMs ? round(ce.timeMs - m.deviceTime) : null,
        deviceToAppLiveMs: m?.deviceTime ? round(m.receivedAt - m.deviceTime) : null,
        brokerToEventHubsMs: ce?.timeMs && kt?.enqueuedAt ? round(kt.enqueuedAt - ce.timeMs) : null,
        deviceToKafkaMs: m?.deviceTime && kt ? round(kt.receivedAt - m.deviceTime) : null,
        endToEndMs: startAt && endAt ? round(endAt - startAt) : null,
        requestCharge: t.cosmos?.requestCharge ?? null,
      },
      steps,
      raw: { mqttPayload: m?.payload ?? null, cloudEvent: ce ? { ...ce.attributes, data: ce.data } : null,
        kafkaHeaders: kt?.headers ?? [], cosmosDocument: t.cosmos?.document ?? null },
    };
  }

  commandView(t) {
    const st = this.status(t);
    const over = st === 'complete' || st === 'no-response';
    const pending = (has) => (has ? 'done' : over ? 'missed' : 'waiting');
    const h = t.http;
    const steps = [];
    steps.push({
      key: 'frontdoor', title: h?.viaFrontDoor ? 'Request arrives through Azure Front Door' : 'Request arrives (not through Front Door)',
      where: 'frontdoor', clock: null, at: null, state: h ? 'info' : 'skipped',
      facts: h ? [
        ['X-Azure-Ref', h.azureRef || '—'],
        ['Origin lock', h.viaFrontDoor ? 'X-Azure-FDID of this Front Door profile, checked by nginx on vm-ops' : 'direct call on the VM (for example a test)'],
        ['TLS', h.viaFrontDoor ? 'terminated at Front Door - managed certificate for ops.iot.example.com' : '—'],
      ] : [['Source', 'no HTTP request (sent by the app itself)']],
    });
    steps.push({
      key: 'app', title: `Operator app receives ${h ? `${h.method} ${h.path}` : 'the command'}`, where: 'opsvm', clock: 'app',
      at: h?.arrivedAt ?? null, state: h ? 'done' : 'skipped', facts: [['Command', `${t.method} ${JSON.stringify(t.body)}`]],
    });
    steps.push({
      key: 'publish', title: 'App publishes an MQTT 5 request', where: 'eventgrid', clock: 'app', at: t.mqtt.publishedAt, from: 'app', state: 'done',
      facts: [['Topic', t.mqtt.topic], ['QoS', '1'], ['Response topic', t.mqtt.responseTopic || '—'],
        ['Correlation data', `${t.mqtt.correlation.slice(0, 16)}… (16 bytes)`], ['Message expiry', `${t.mqtt.expirySeconds ?? '—'} s`],
        ['Identity', 'Microsoft Entra ID token (managed identity id-iotmq-app) - RBAC: EventGrid TopicSpaces Publisher on ts-app-pub']],
    });
    steps.push({
      key: 'puback', title: 'Broker accepts it (PUBACK)', where: 'eventgrid', clock: 'app', at: t.mqtt.pubackAt, from: 'publish',
      state: t.mqtt.pubackError ? 'missed' : pending(t.mqtt.pubackAt),
      facts: t.mqtt.pubackError ? [['Error', t.mqtt.pubackError]] : [['Meaning', 'stored by the broker and forwarded to matching subscribers']],
    });
    const log = t.deviceLog;
    steps.push({
      key: 'device', title: `${t.deviceId} receives and executes it`, where: 'device', clock: 'device', at: log?.deviceTime ?? null, noDelta: true,
      secondsOnly: true,
      state: log?.match ? 'done' : (t.response ? 'info' : pending(false)),
      facts: [['Subscription', `iot/cmd/${t.site}/${t.deviceId}/# - topic space ts-dev-sub (permission binding pb-dev-sub)`],
        ['Device log', log?.match || (log ? 'no matching line in the last lines of the device log' : 'press "Show device log"')]],
      note: log?.match ? 'device log lines have 1-second resolution' : null,
    });
    steps.push({
      key: 'response', title: `${t.deviceId} answers on its response topic`, where: 'eventgrid', clock: 'app',
      at: t.response?.receivedAt ?? null, from: 'publish', state: pending(t.response),
      facts: t.response ? [['Topic', t.response.topic], ['Status (MQTT 5 user property)', String(t.response.status)],
        ['Correlation data', 'matches the request'], ['Body', JSON.stringify(t.response.body)]] : [],
    });
    const effects = t.method === 'setMotorSpeed' && (!t.response || t.response.status === 200);
    steps.push({
      key: 'state', title: 'New state retained on the broker', where: 'eventgrid', clock: 'app', at: t.state?.receivedAt ?? null, from: 'response',
      state: t.state ? 'done' : (effects ? pending(false) : 'skipped'),
      facts: t.state ? [['Topic', `${t.state.topic} (published with RETAIN)`], ['Values', JSON.stringify(t.state.values)]]
        : [['Note', effects ? 'the device republishes its retained state after a speed change' : 'not expected for this command']],
    });
    steps.push({
      key: 'http', title: 'App answers the browser', where: 'frontdoor', clock: 'app', at: h?.finishedAt ?? null, from: 'app',
      state: h ? pending(h.finishedAt) : 'skipped', facts: h?.statusCode ? [['HTTP status', String(h.statusCode)]] : [],
    });
    steps.push({
      key: 'reading', title: 'Next reading shows the change', where: 'device', clock: 'app', at: t.nextReading?.receivedAt ?? null, from: 'response',
      state: t.nextReading ? 'done' : (!effects ? 'skipped' : t.response ? pending(false) : over ? 'missed' : 'waiting'),
      facts: t.nextReading ? [['Values', JSON.stringify(t.nextReading.values)], ['Sequence number', t.nextReading.seq ?? '—']] : [],
    });
    addDeltas(steps);
    return {
      id: t.id, kind: 'command', deviceId: t.deviceId, site: t.site, method: t.method, body: t.body, status: st,
      startedAt: t.startedAt,
      summary: {
        brokerAckMs: t.mqtt.pubackAt ? round(t.mqtt.pubackAt - t.mqtt.publishedAt) : null,
        roundTripMs: t.response ? round(t.response.receivedAt - t.mqtt.publishedAt) : null,
        appTotalMs: h?.finishedAt ? round(h.finishedAt - h.arrivedAt) : null,
        responseStatus: t.response?.status ?? null,
        azureRef: h?.azureRef ?? null,
        viaFrontDoor: Boolean(h?.viaFrontDoor),
      },
      steps,
      deviceLog: log || null,
    };
  }
}

/**
 * Delta of each timed step to the step it follows from ("from"), or else to the previous timed step.
 * Deltas between different clocks are flagged (crossClock) so the UI can mark them as approximate.
 */
function addDeltas(steps) {
  const byKey = new Map(steps.map((s) => [s.key, s]));
  let prev = null;
  for (const step of steps) {
    step.deltaMs = null;
    step.crossClock = false;
    step.deltaFrom = null;
    if (step.at === null || step.at === undefined) continue;
    if (!step.noDelta) {
      const base = step.from ? byKey.get(step.from) : prev;
      if (base && base.at !== null && base.at !== undefined) {
        step.deltaMs = round(step.at - base.at);
        step.crossClock = base.clock !== step.clock;
        step.deltaFrom = base.key;
      }
    }
    prev = step;
  }
}
