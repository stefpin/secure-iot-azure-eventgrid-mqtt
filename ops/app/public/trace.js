/* Contoso IoT Operations - "Behind the Scenes" view.
   Standalone on purpose: it shares no code with app.js, so a problem here cannot affect the other pages. */

const $ = (id) => document.getElementById(id);

const state = {
  mode: 'reading',
  deviceId: null,
  devices: [],
  resources: null,
  enabled: true,
  readingRun: 0,
  commandRun: 0,
  consoleTimer: null,
  lastReading: null,
  lastCommand: null,
  browser: null, // { traceAfter, clickedAt, browserMs, rpm } for a command sent from this page
};

const NODE_INFO = {
  device: { icon: 'img/azure/industrial-iot.svg', title: 'Machine' },
  network: { icon: 'img/azure/private-endpoint.svg', title: 'VPN + private endpoint' },
  eventgrid: { icon: 'img/azure/event-grid.svg', title: 'Event Grid MQTT broker' },
  routing: { icon: 'img/azure/event-grid-subs.svg', title: 'Routing: namespace topic' },
  eventhubs: { icon: 'img/azure/event-hubs.svg', title: 'Event Hubs (Kafka)' },
  opsvm: { icon: 'img/azure/vm.svg', title: 'Operator app (vm-ops)' },
  cosmos: { icon: 'img/azure/cosmos.svg', title: 'Cosmos DB' },
  frontdoor: { icon: 'img/azure/front-door.svg', title: 'Azure Front Door' },
  browser: { icon: 'img/trace-browser.svg', title: 'Operator browser' },
};

/* ---------------------------------------------------------------- helpers */
async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let data = text;
  try { data = text.trim() ? JSON.parse(text) : null; } catch { /* plain text */ }
  if (!response.ok) throw Object.assign(new Error(data?.error || `HTTP ${response.status}`), { status: response.status, data });
  return data;
}

let toastTimer = null;
function toast(message, kind = '', ms = 3600) {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtClock(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function fmtMs(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(2)} s`;
  if (Math.abs(v) < 10) return `${v.toFixed(1)} ms`;
  return `${Math.round(v)} ms`;
}

function fmtDelta(step) {
  if (!step || step.deltaMs === null || step.deltaMs === undefined) return '';
  if (step.crossClock) return step.deltaMs < 1 ? '≈ 0 ms' : `≈ +${fmtMs(step.deltaMs)}`;
  return `+${fmtMs(step.deltaMs)}`;
}

const STATUS = {
  waiting: ['waiting for the next reading…', 'warn'],
  running: ['following the reading…', 'warn'],
  complete: ['complete', 'ok'],
  partial: ['partly seen - see the red steps', 'err'],
  'no-reading': ['no reading within 30 s', 'err'],
  finishing: ['answered - waiting for the new state', 'warn'],
  'no-response': ['no answer from the machine', 'err'],
};

function setBadge(el, status) {
  const [text, cls] = STATUS[status] || [status || 'ready', 'muted'];
  el.textContent = text;
  el.className = `badge ${cls}`;
}

function resourceFor(where) {
  return state.resources?.items?.[where] || null;
}

/* ---------------------------------------------------------------- shell */
async function loadShell() {
  $('navToggle').addEventListener('click', () => $('sidenav').classList.toggle('collapsed'));
  try {
    const c = await api('/config');
    $('appTitle').textContent = c.ui.title;
    $('userLabel').textContent = `${c.ui.user} (${c.ui.role})`;
    $('modeBroker').textContent = `Broker: ${c.broker || '—'}${c.features.mqtt ? '' : ' (offline)'}`;
    $('modeKafka').textContent = `Kafka: ${c.features.kafka ? 'consuming' : 'not connected'}`;
    $('modeHistory').textContent = `History: ${c.features.history}`;
  } catch (err) {
    toast(`API unreachable: ${err.message}`, 'err');
  }
  try {
    await api('/trace/health');
    state.resources = await api('/trace/resources').catch(() => null);
  } catch (err) {
    state.enabled = false;
    $('trOff').hidden = false;
    document.querySelectorAll('#panelReading button, #panelCommand button').forEach((b) => { b.disabled = true; });
  }
}

async function loadDevices() {
  try {
    state.devices = await api('/devices');
  } catch (err) {
    state.devices = [];
    toast(`Could not load machines: ${err.message}`, 'err');
  }
  const select = $('trDevice');
  const connected = state.devices.filter((d) => d.status === 'Connected');
  const others = state.devices.filter((d) => d.status !== 'Connected');
  const wanted = new URLSearchParams(location.search).get('device');
  const pick = (wanted && state.devices.find((d) => d.deviceId === wanted)?.deviceId)
    || connected.find((d) => d.deviceId === 'PUMP-07')?.deviceId || connected[0]?.deviceId || state.devices[0]?.deviceId || '';
  select.innerHTML = [...connected, ...others].map((d) => `<option value="${esc(d.deviceId)}" ${d.deviceId === pick ? 'selected' : ''}>`
    + `${esc(d.deviceId)} · ${esc(d.template)} · ${esc(d.status)}</option>`).join('') || '<option value="">no machines</option>';
  setDevice(pick);
}

function setDevice(deviceId) {
  state.deviceId = deviceId || null;
  for (const id of ['rdTitleDevice', 'cmTitleDevice', 'dcDevice']) $(id).textContent = deviceId || '—';
  updateCommandButtons();
  $('dcLines').textContent = 'Press Refresh to load the last lines of the machine\'s log.';
}

function updateCommandButtons() {
  const device = state.devices.find((d) => d.deviceId === state.deviceId);
  const motor = device ? device.template !== 'esp32' : true;
  document.querySelectorAll('#panelCommand [data-rpm]').forEach((b) => {
    b.disabled = !state.enabled || !motor;
    b.title = motor ? '' : 'This profile has no motor - the machine would answer 404';
  });
}

function setMode(mode) {
  state.mode = mode === 'command' ? 'command' : 'reading';
  $('panelReading').hidden = state.mode !== 'reading';
  $('panelCommand').hidden = state.mode !== 'command';
  for (const tab of document.querySelectorAll('.tr-tab')) {
    const active = tab.dataset.mode === state.mode;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  if (location.hash !== `#${state.mode}`) history.replaceState(null, '', `#${state.mode}`);
}

/* ---------------------------------------------------------------- flow diagrams */
const ARROW = '<svg viewBox="0 0 24 24"><path d="M4 12h14M13 6l6 6-6 6" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const BRANCH = '<svg viewBox="0 0 24 24"><path d="M5 3v9a4 4 0 0 0 4 4h10M15 12l4 4-4 4" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const BACK = '<svg viewBox="0 0 24 24"><path d="M20 12H6M11 6l-6 6 6 6" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function node({ where, title, name, time, delta, cls }) {
  const info = NODE_INFO[where] || {};
  return `<div class="tr-node ${cls || 'waiting'}">
    <div class="tr-node-top"><img src="${esc(info.icon || '')}" alt="" /><div class="tr-node-title">${esc(title || info.title || where)}</div></div>
    <div class="tr-node-name" title="${esc(name || '')}">${esc(name || '')}</div>
    <div class="tr-node-time">${esc(time || '')}</div>
    <div class="tr-node-delta">${esc(delta || '')}</div>
  </div>`;
}

function lane(label, cells) {
  const out = [`<div class="tr-lane"><div class="tr-lane-label">${esc(label)}</div>`];
  cells.forEach((cell, i) => {
    if (i > 0) {
      const prev = cells[i - 1];
      if (cell === null || prev === null) out.push(cell && cell.branch ? `<div class="tr-arrow ${cell.cls === 'done' ? 'done' : ''}">${BRANCH}</div>` : '<div class="tr-spacer narrow"></div>');
      else out.push(`<div class="tr-arrow ${cell.cls === 'done' ? 'done' : ''}">${ARROW}</div>`);
    }
    out.push(cell === null ? '<div class="tr-spacer"></div>' : node(cell));
  });
  out.push('</div>');
  return out.join('');
}

const stepOf = (view, key) => view?.steps?.find((s) => s.key === key) || null;
const clsOf = (step) => (step ? step.state : 'waiting');

function renderReadingFlow(view) {
  const s = (k) => stepOf(view, k);
  const dev = view?.deviceId || state.deviceId || 'Machine';
  const routing = s('routing');
  const eh = s('eventhubs');
  const alerts = s('alerts');
  const cosmos = s('cosmos');
  const cells1 = [
    { where: 'device', title: dev, name: 'mine site (vm-site1)', time: fmtClock(s('device')?.at), cls: clsOf(s('device')) },
    { where: 'network', name: '10.40.2.4 · pe-eg-mqtt · VPN', time: '', cls: clsOf(s('network')) },
    { where: 'eventgrid', name: resourceFor('eventgrid')?.name || 'Event Grid namespace', time: fmtClock(s('broker')?.at), delta: fmtDelta(s('broker')), cls: clsOf(s('broker')) },
    { where: 'opsvm', title: 'Operator app · live (MQTT)', name: 'iot-operator-app', time: fmtClock(s('live')?.at), delta: fmtDelta(s('live')), cls: clsOf(s('live')) },
    null,
    null,
  ];
  const cells2 = [
    null,
    null,
    { where: 'routing', name: 'mqtt-routed + enrichments', time: routing?.state === 'done' ? 'CloudEvent' : '', cls: clsOf(routing), branch: true },
    { where: 'eventhubs', title: alerts ? 'Event Hubs: telemetry + alerts' : 'Event Hubs: telemetry', name: resourceFor('eventhubs')?.name || '', time: fmtClock(eh?.at), delta: fmtDelta(eh), cls: alerts && alerts.state !== 'done' && eh?.state === 'done' ? 'info' : clsOf(eh) },
    { where: 'opsvm', title: 'Operator app · Kafka consumer', name: 'group iot-operator-app', time: fmtClock(s('kafka')?.at), delta: fmtDelta(s('kafka')), cls: clsOf(s('kafka')) },
    { where: 'cosmos', title: 'Cosmos DB · history', name: resourceFor('cosmos')?.name || '', time: fmtClock(cosmos?.at), delta: cosmos?.state === 'skipped' ? 'not stored' : fmtDelta(cosmos), cls: clsOf(cosmos) },
  ];
  $('rdFlow').innerHTML = lane('Live · MQTT', cells1) + lane('Durable · Kafka', cells2);
}

function renderCommandFlow(view) {
  const s = (k) => stepOf(view, k);
  const dev = view?.deviceId || state.deviceId || 'Machine';
  const fd = s('frontdoor');
  const viaFd = Boolean(view?.summary?.viaFrontDoor);
  const fromHere = state.browser && view && state.browser.traceId === view.id;
  const cells = [
    { where: 'browser', name: fromHere ? `clicked ${state.browser.label}` : 'Monitoring Dashboard or this page', time: '', delta: fromHere ? `answer after ${fmtMs(state.browser.browserMs)}` : '', cls: view ? (fromHere ? 'done' : 'info') : 'waiting' },
    { where: 'frontdoor', name: viaFd ? 'ops.iot.example.com' : 'not used (direct call)', time: '', cls: view ? (viaFd ? 'info' : 'skipped') : clsOf(fd) },
    { where: 'opsvm', title: 'Operator app', name: 'POST /api/devices/…', time: fmtClock(s('app')?.at), cls: clsOf(s('app')) },
    { where: 'eventgrid', name: 'MQTT 5 request · PUBACK', time: fmtClock(s('publish')?.at), delta: s('puback')?.deltaMs !== null && s('puback')?.deltaMs !== undefined ? `PUBACK +${fmtMs(s('puback').deltaMs)}` : '', cls: clsOf(s('puback')) },
    { where: 'device', title: dev, name: 'executes the command', time: s('device')?.at ? `${fmtClock(s('device').at).slice(0, 8)} (log)` : '', delta: s('response')?.deltaMs !== null && s('response')?.deltaMs !== undefined ? `answered +${fmtMs(s('response').deltaMs)}` : '', cls: s('response') ? (s('response').state === 'done' ? 'done' : clsOf(s('response'))) : 'waiting' },
  ];
  let back = '';
  if (view) {
    const r = view.summary || {};
    const st = s('state');
    const parts = [];
    if (r.responseStatus) parts.push(`answer <b>${esc(r.responseStatus)}</b> on <code>iot/cmdres/…</code> (same correlation data)`);
    if (r.roundTripMs !== null && r.roundTripMs !== undefined) parts.push(`round trip app → machine → app <b>${esc(fmtMs(r.roundTripMs))}</b>`);
    if (st?.state === 'done') parts.push(`retained state <b>${esc(st.facts?.[1]?.[1] || '')}</b>`);
    if (r.appTotalMs !== null && r.appTotalMs !== undefined) parts.push(`HTTP answer after <b>${esc(fmtMs(r.appTotalMs))}</b> in the app`);
    if (fromHere && state.browser.browserMs) parts.push(`browser saw the answer after <b>${esc(fmtMs(state.browser.browserMs))}</b>`);
    back = `<div class="tr-return">${BACK}<span>${parts.join(' · ') || 'waiting for the answer…'}</span></div>`;
  }
  $('cmFlow').innerHTML = lane('Command', cells) + back;
}

/* ---------------------------------------------------------------- step table */
function renderSteps(table, view) {
  if (!view) { table.innerHTML = ''; return; }
  const rows = view.steps.map((step, i) => {
    const info = NODE_INFO[step.where] || {};
    const res = resourceFor(step.where);
    const facts = (step.facts || []).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    const delta = fmtDelta(step);
    return `<tr>
      <td class="tr-n">${i + 1}</td>
      <td class="tr-step"><span class="tr-state ${esc(step.state)}"></span><b style="display:inline">${esc(step.title)}</b>
        <div class="tr-where"><img src="${esc(info.icon || '')}" alt="" />${esc(info.title || step.where)}${res?.name ? ` · ${esc(res.name)}` : ''}</div></td>
      <td class="tr-time">${esc(step.secondsOnly && Number.isFinite(step.at) ? `${fmtClock(step.at).slice(0, 8)} (log)` : fmtClock(step.at))}${delta ? `<small title="${step.crossClock ? 'crosses from one clock to another' : 'same clock'}">${esc(delta)}</small>` : ''}</td>
      <td class="tr-facts"><dl>${facts}</dl>${step.note ? `<div class="tr-note">${esc(step.note)}</div>` : ''}</td>
      <td class="tr-link">${res?.url ? `<a href="${esc(res.url)}" target="_blank" rel="noopener" title="${esc(res.menu || '')}">Open in Azure ↗</a>` : ''}</td>
    </tr>`;
  });
  table.innerHTML = `<thead><tr><th>#</th><th>STEP</th><th>TIME</th><th>WHAT HAPPENED - EVIDENCE</th><th></th></tr></thead><tbody>${rows.join('')}</tbody>`;
}

function chip(value, label) {
  return `<div class="tr-chip"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
}

function renderReading(view) {
  state.lastReading = view;
  setBadge($('rdStatus'), view?.status);
  renderReadingFlow(view);
  renderSteps($('rdSteps'), view);
  const s = view?.summary || {};
  $('rdSummary').innerHTML = view && view.status !== 'waiting' ? [
    chip(fmtMs(s.deviceToBrokerMs), 'machine → Event Grid (≈)'),
    chip(fmtMs(s.deviceToAppLiveMs), 'machine → operator app, live (≈)'),
    chip(fmtMs(s.brokerToEventHubsMs), 'Event Grid → Event Hubs'),
    chip(fmtMs(s.deviceToKafkaMs), 'machine → app over Kafka (≈)'),
    chip(fmtMs(s.endToEndMs), 'machine → Cosmos DB (≈)'),
    chip(s.requestCharge !== null && s.requestCharge !== undefined ? `${s.requestCharge} RU` : '—', 'Cosmos DB write cost'),
  ].join('') : '';
  const raw = view?.raw;
  if (raw) {
    const headers = (raw.kafkaHeaders || []).map((h) => `${h.name}: ${h.value}`).join('\n');
    $('rdRawGrid').innerHTML = `
      <div><h4>1 · MQTT payload, as the machine published it</h4><pre>${esc(JSON.stringify(raw.mqttPayload, null, 2) || '—')}</pre></div>
      <div><h4>2 · CloudEvent, as the app read it from Kafka</h4><pre>${esc(JSON.stringify(raw.cloudEvent, null, 2) || '—')}${headers ? `\n\n// Kafka headers\n${esc(headers)}` : ''}</pre></div>
      <div><h4>3 · Cosmos DB document, as written</h4><pre>${esc(JSON.stringify(raw.cosmosDocument, null, 2) || '—')}</pre></div>`;
  }
}

function renderCommand(view) {
  state.lastCommand = view;
  setBadge($('cmStatus'), view?.status);
  renderCommandFlow(view);
  renderSteps($('cmSteps'), view);
  const s = view?.summary || {};
  const fromHere = state.browser && view && state.browser.traceId === view.id;
  $('cmSummary').innerHTML = view ? [
    chip(fmtMs(s.brokerAckMs), 'app → Event Grid → PUBACK'),
    chip(fmtMs(s.roundTripMs), 'round trip app → machine → app'),
    chip(fmtMs(s.appTotalMs), 'request handled in the app'),
    chip(fromHere ? fmtMs(state.browser.browserMs) : '—', 'click → answer, in the browser'),
    chip(s.responseStatus ?? '—', 'machine answered (status)'),
  ].join('') : '';
  renderEvidence(view);
}

function renderEvidence(view) {
  const box = $('cmEvidence');
  if (!view) { box.hidden = true; return; }
  const ref = view.summary?.azureRef;
  const kql = ref
    ? `AzureDiagnostics\n| where Category == "FrontDoorAccessLog"\n| where trackingReference_s == "${ref}"\n| project TimeGenerated, httpMethod_s, requestUri_s, httpStatusCode_s, timeTaken_s, pop_s, originName_s`
    : null;
  const logs = resourceFor('logs');
  const log = view.deviceLog;
  // The newest lines, ending with the command's own line, so the highlighted line is always in view.
  let shown = log?.lines || [];
  if (log?.match) {
    const at = shown.lastIndexOf(log.match);
    if (at >= 0) shown = shown.slice(Math.max(0, at - 9), at + 3);
  } else {
    shown = shown.slice(-12);
  }
  const lines = shown.length
    ? shown.map((l) => (log.match && l === log.match ? `<mark>${esc(l)}</mark>` : esc(l))).join('\n')
    : 'Press "Show device log" to fetch the machine\'s own log lines through the site gateway.';
  box.innerHTML = `
    <div><h4>Find this click in the Front Door log ${kql ? '<button class="btn-xs" id="btnCopyKql">Copy query</button>' : ''}</h4>
      <pre>${esc(kql || 'This command did not come through Front Door (for example a test on the VM), so there is no Front Door log entry.')}</pre>
      <p class="tr-ev-note">Run it in ${logs?.url ? `<a href="${esc(logs.url)}" target="_blank" rel="noopener">Log Analytics ${esc(logs.name)} ↗</a>` : 'Log Analytics'}.
        Front Door writes its access log within a few minutes; X-Azure-Ref is the request's tracking reference.</p></div>
    <div><h4>The machine's own log <button class="btn-xs" id="btnCmdLog">Show device log</button></h4><pre class="tr-console">${lines}</pre>
      <p class="tr-ev-note">The lines around the command, fetched on demand over MQTT through the site gateway (iot/site/site1/sim/req → gw-site1 → reply); the full log is in the Device console below. Lines have 1-second resolution.</p></div>`;
  box.hidden = false;
  $('btnCopyKql')?.addEventListener('click', () => copy(kql));
  $('btnCmdLog')?.addEventListener('click', () => fetchCommandLog(view.id, true));
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Query copied', 'ok'); } catch { toast('Copy failed - select the text instead', 'err'); }
}

/* ---------------------------------------------------------------- reading trace */
async function followReading() {
  if (!state.deviceId) return toast('Pick a connected machine first', 'err');
  const run = ++state.readingRun;
  const button = $('btnFollowReading');
  button.disabled = true;
  try {
    let view = await api('/trace/readings', { method: 'POST', body: { deviceId: state.deviceId } });
    renderReading(view);
    const started = Date.now();
    while (run === state.readingRun && ['waiting', 'running'].includes(view.status) && Date.now() - started < 80_000) {
      await sleep(view.status === 'waiting' ? 500 : 350);
      view = await api(`/trace/runs/${encodeURIComponent(view.id)}`);
      if (run === state.readingRun) renderReading(view);
    }
  } catch (err) {
    toast(err.message, 'err', 5000);
  } finally {
    if (run === state.readingRun) button.disabled = !state.enabled;
  }
}

/* ---------------------------------------------------------------- command trace */
async function latestCommandId() {
  const list = await api(`/trace/commands?deviceId=${encodeURIComponent(state.deviceId)}&limit=1`).catch(() => []);
  return list[0]?.id || null;
}

async function sendCommand(rpm, label) {
  if (!state.deviceId) return toast('Pick a connected machine first', 'err');
  const run = ++state.commandRun;
  const buttons = document.querySelectorAll('#panelCommand [data-rpm]');
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const before = await latestCommandId();
    const clickedAt = Date.now();
    const t0 = performance.now();
    let result = null;
    try {
      result = await api(`/devices/${encodeURIComponent(state.deviceId)}/motor`, { method: 'POST', body: { targetRpm: rpm } });
    } catch (err) {
      toast(`Command failed: ${err.message}`, 'err', 5000);
    }
    const browserMs = performance.now() - t0;
    if (result && result.accepted === false) toast(`${state.deviceId} refused it: ${result.reason || result.status}`, 'err', 5000);
    let id = null;
    for (let i = 0; i < 10 && !id; i += 1) {
      const list = await api(`/trace/commands?deviceId=${encodeURIComponent(state.deviceId)}&limit=3`).catch(() => []);
      id = list.find((c) => c.id !== before && c.startedAt >= clickedAt - 60_000)?.id || null;
      if (!id) await sleep(300);
    }
    if (!id) return;
    state.browser = { traceId: id, clickedAt, browserMs, label };
    await followCommand(id, run);
  } finally {
    if (run === state.commandRun) updateCommandButtons();
  }
}

async function followCommand(id, run = ++state.commandRun) {
  let view = await api(`/trace/runs/${encodeURIComponent(id)}`);
  renderCommand(view);
  let logFetched = Boolean(view.deviceLog);
  const started = Date.now();
  while (run === state.commandRun && Date.now() - started < 30_000) {
    if (view.summary?.responseStatus && !logFetched) {
      logFetched = true;
      view = (await fetchCommandLog(id, false)) || view;
    }
    if (['complete', 'no-response'].includes(view.status) && logFetched) break;
    if (view.status === 'no-response') break;
    await sleep(500);
    view = await api(`/trace/runs/${encodeURIComponent(id)}`);
    if (run === state.commandRun) renderCommand(view);
  }
}

async function fetchCommandLog(id, announce) {
  try {
    const view = await api(`/trace/commands/${encodeURIComponent(id)}/device-log`, { method: 'POST' });
    renderCommand(view);
    if (announce) toast(view.deviceLog?.match ? 'Found the command in the machine\'s log' : 'Device log fetched', 'ok');
    return view;
  } catch (err) {
    if (announce) toast(`Device log: ${err.message}`, 'err');
    return null;
  }
}

async function showLatestCommand() {
  if (!state.deviceId) return;
  const id = await latestCommandId();
  if (!id) return toast(`No command has been sent to ${state.deviceId} recently - use the buttons above or the Monitoring Dashboard`, '', 5000);
  state.browser = null;
  await followCommand(id).catch((err) => toast(err.message, 'err'));
}

/* ---------------------------------------------------------------- device console */
async function refreshConsole() {
  if (!state.deviceId) return;
  try {
    const data = await api(`/devices/${encodeURIComponent(state.deviceId)}/logs?lines=40`);
    const lines = Array.isArray(data?.lines) ? data.lines : [];
    $('dcLines').innerHTML = lines.length
      ? lines.map((l) => (/<- command|renewed|certificate ready|Last Will|connected to/.test(l) ? `<mark>${esc(l)}</mark>` : esc(l))).join('\n')
      : 'No log lines yet for this machine.';
    $('dcLines').scrollTop = $('dcLines').scrollHeight;
  } catch (err) {
    $('dcLines').textContent = `Could not fetch the log: ${err.message}`;
  }
}

function setConsoleAuto(on) {
  clearInterval(state.consoleTimer);
  state.consoleTimer = on ? setInterval(() => { if (document.visibilityState === 'visible') refreshConsole(); }, 5000) : null;
  if (on) refreshConsole();
}

/* ---------------------------------------------------------------- start */
async function main() {
  await loadShell();
  for (const tab of document.querySelectorAll('.tr-tab')) tab.addEventListener('click', () => setMode(tab.dataset.mode));
  setMode(location.hash === '#command' ? 'command' : 'reading');
  window.addEventListener('hashchange', () => setMode(location.hash === '#command' ? 'command' : 'reading'));
  $('trDevice').addEventListener('change', (e) => { setDevice(e.target.value); renderReading(null); renderCommand(null); });
  $('btnFollowReading').addEventListener('click', followReading);
  document.querySelectorAll('#panelCommand [data-rpm]').forEach((b) => b.addEventListener('click', () => sendCommand(Number(b.dataset.rpm), b.textContent.trim())));
  $('btnLatestCommand').addEventListener('click', showLatestCommand);
  $('btnDeviceLog').addEventListener('click', refreshConsole);
  $('dcAuto').addEventListener('change', (e) => setConsoleAuto(e.target.checked));
  await loadDevices();
  renderReading(null);
  renderCommand(null);
}

main().catch((err) => toast(`Behind the Scenes view: ${err.message}`, 'err', 6000));
