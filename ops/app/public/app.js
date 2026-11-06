/* Contoso IoT Operations - Event Grid MQTT edition - front end */

const PAGE_SIZE = 6;

const state = {
  config: null,
  devices: [],
  templates: [],
  page: 1,
  search: '',
  selectedTemplate: null,
  lastCreated: null,
  dashDevice: null,
  gaugeMetric: null,
  chartMetric: null,
  range: 'hourly',
  latest: {},
  counters: {},
  chart: null,
  socket: null,
  kafkaRows: [],
  alertRows: [],
  powerLoss: {},
  clockOffset: 0,
};

const $ = (id) => document.getElementById(id);
const api = async (path, options = {}) => {
  const response = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const trimmed = text.trim();
  const data = trimmed.startsWith('{') || trimmed.startsWith('[') ? JSON.parse(text) : text;
  if (!response.ok) throw Object.assign(new Error(data?.error || `HTTP ${response.status}`), { data, status: response.status });
  return data;
};

let toastTimer = null;
function toast(message, kind = '', ms = 3200) {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

async function copyText(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  toast(label, 'ok');
}

const formatDate = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 2000) return '—';
  return date.toLocaleString(undefined, { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
};
const formatTime = (value) => (value ? new Date(value).toLocaleTimeString() : '—');

/** "37:12" / "2 d 4 h" / "expired 3 min ago" - live countdown to a certificate's expiry. */
function countdown(notAfter) {
  if (!notAfter) return { text: '—', cls: '' };
  const ms = Date.parse(notAfter) - Date.now();
  if (ms <= 0) {
    const ago = Math.round(-ms / 60000);
    return { text: `expired ${ago < 120 ? `${ago} min` : `${Math.round(ago / 60)} h`} ago`, cls: 'expired' };
  }
  const s = Math.floor(ms / 1000);
  if (s >= 86400) return { text: `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`, cls: '' };
  if (s >= 3600) return { text: `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`, cls: '' };
  return { text: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, cls: s < 20 * 60 ? 'soon' : '' };
}
const countdownHtml = (notAfter) => {
  const c = countdown(notAfter);
  return `<span class="countdown ${c.cls}" data-expires="${escapeAttr(notAfter || '')}">${c.text}</span>`;
};

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
));
const escapeAttr = escapeHtml;
const shortSerial = (serial) => (serial ? `${serial.slice(0, 10)}…` : '—');
const brief = (obj, max = 160) => {
  if (obj === null || obj === undefined) return '—';
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

/* ============================================================== routing */
const VIEWS = ['dashboard', 'devices', 'templates', 'certificates', 'retained', 'pipeline', 'fleet', 'widgets'];

function route() {
  const view = (location.hash.replace('#/', '') || 'devices').split('?')[0];
  const active = VIEWS.includes(view) ? view : 'devices';
  for (const name of VIEWS) $(`view-${name}`).classList.toggle('active', name === active);
  document.querySelectorAll('.sidenav a').forEach((link) => link.classList.toggle('active', link.dataset.view === active));
  if (active === 'devices') loadDevices();
  if (active === 'dashboard') refreshDashboard();
  if (active === 'widgets') renderWidgetConfig();
  if (active === 'certificates') loadCertificates();
  if (active === 'retained') loadRetained();
  if (active === 'pipeline') loadPipeline();
  if (active === 'fleet') loadFleet();
}

/* ========================================================= device list */
async function loadDevices() {
  try {
    state.devices = await api('/devices');
  } catch (err) {
    toast(`Could not load devices: ${err.message}`, 'err');
    state.devices = [];
  }
  renderDevices();
  syncDeviceSelectors();
}

function upsertDevice(device) {
  const index = state.devices.findIndex((d) => d.deviceId === device.deviceId);
  if (index < 0) state.devices.unshift(device);
  else state.devices[index] = { ...state.devices[index], ...device };
}

function filteredDevices() {
  const needle = state.search.trim().toLowerCase();
  return needle ? state.devices.filter((d) => d.deviceId.toLowerCase().includes(needle)) : state.devices;
}

const STATUS_CLASS = { Connected: 'status-connected', Revoked: 'status-revoked', Offline: 'status-offline' };

function renderDevices() {
  const rows = $('deviceRows');
  const list = filteredDevices();
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (state.page > pages) state.page = pages;
  const slice = list.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);

  if (!slice.length) {
    rows.innerHTML = `<tr><td colspan="7" class="empty">${state.devices.length ? 'No device matches that search.' : 'No devices yet — click Create New Device.'}</td></tr>`;
  } else {
    rows.innerHTML = slice.map((device) => {
      const connected = device.status === 'Connected';
      const revoked = device.status === 'Revoked';
      const cert = device.certificate;
      const id = escapeAttr(device.deviceId);
      const reason = device.presence && !device.presence.online && device.presence.reason
        ? `<div class="hint" style="margin:2px 0 0;font-size:11px">${escapeHtml(device.presence.reason)}</div>` : '';
      return `
        <tr>
          <td>${escapeHtml(device.deviceId)}</td>
          <td><span class="profile-tag">${escapeHtml(templateName(device.template))}</span></td>
          <td>${cert ? `<span class="mono" title="${escapeAttr(cert.serial)}">${shortSerial(cert.serial)}</span>
                <div class="hint" style="margin:2px 0 0;font-size:11px">${escapeHtml(cert.method)} · ${escapeHtml(cert.keyType || '')}</div>`
              : '<span class="badge muted">not enrolled</span>'}</td>
          <td>${cert ? countdownHtml(cert.notAfter) : '—'}</td>
          <td>${formatDate(device.createdAt)}</td>
          <td class="${STATUS_CLASS[device.status] || ''}">${escapeHtml(device.status)}${reason}</td>
          <td>
            <div class="row-actions">
              ${revoked ? '' : connected
                ? `<button class="btn-xs btn-disconnect" data-action="disconnect" data-id="${id}">Disconnect</button>`
                : `<button class="btn-xs btn-connect" data-action="connect" data-id="${id}">Connect</button>`}
              <button class="btn-xs btn-script" data-action="script" data-id="${id}" title="Onboarding script for this device">Script</button>
              ${revoked
                ? `<button class="btn-xs btn-connect" data-action="restore" data-id="${id}" title="Enable the Event Grid client again">Restore</button>`
                : `<button class="btn-xs btn-warn" data-action="revoke" data-id="${id}" title="Disable the Event Grid client and refuse new certificates">Revoke</button>`}
              <button class="btn-xs btn-delete" data-action="delete" data-id="${id}">Delete</button>
            </div>
          </td>
        </tr>`;
    }).join('');
  }
  $('devicePager').innerHTML = Array.from({ length: pages }, (_, i) =>
    `<button class="${i + 1 === state.page ? 'active' : ''}" data-page="${i + 1}">${i + 1}</button>`).join('');
}

function templateName(templateId) {
  if (!templateId) return 'Unknown';
  if (templateId === 'gateway') return 'Site gateway';
  const template = state.templates.find((t) => t.id === templateId);
  return template ? template.name : templateId;
}

$('deviceRows').addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const deviceId = button.dataset.id;
  const action = button.dataset.action;
  if (action === 'script') return showScriptFor(deviceId);

  button.disabled = true;
  try {
    if (action === 'connect') {
      const r = await api(`/devices/${encodeURIComponent(deviceId)}/connect`, { method: 'POST', body: {} });
      toast(`${deviceId}: started at the mine site (${r.session?.enrolment || 'ok'})`, 'ok');
    } else if (action === 'disconnect') {
      await api(`/devices/${encodeURIComponent(deviceId)}/disconnect`, { method: 'POST', body: {} });
      toast(`${deviceId} stopped - retained status set to offline`);
    } else if (action === 'revoke') {
      if (!confirm(`Revoke '${deviceId}'? Its Event Grid client is disabled and no new certificate will be issued.`)) { button.disabled = false; return; }
      await api(`/devices/${encodeURIComponent(deviceId)}/enabled`, { method: 'POST', body: { enabled: false } });
      toast(`${deviceId} revoked`, 'ok');
    } else if (action === 'restore') {
      await api(`/devices/${encodeURIComponent(deviceId)}/enabled`, { method: 'POST', body: { enabled: true } });
      toast(`${deviceId} restored`, 'ok');
    } else if (action === 'delete') {
      if (!confirm(`Delete '${deviceId}'? This removes its Event Grid client, its key and certificate at the site and its retained messages.`)) { button.disabled = false; return; }
      await api(`/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
      toast(`${deviceId} deleted`);
    }
    await loadDevices();
  } catch (err) {
    toast(err.message, 'err');
    button.disabled = false;
  }
});

$('devicePager').addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  state.page = Number(button.dataset.page);
  renderDevices();
});

$('deviceSearch').addEventListener('input', (event) => {
  state.search = event.target.value;
  state.page = 1;
  renderDevices();
});

/* ======================================================= create device */
$('btnCreateDevice').addEventListener('click', () => {
  $('newDeviceId').value = '';
  $('createMsg').textContent = '';
  $('btnShowScript').hidden = true;
  $('tokenBox').hidden = true;
  state.lastCreated = null;
  $('createModal').hidden = false;
  $('newDeviceId').focus();
});

$('btnDoneCreate').addEventListener('click', () => {
  $('createModal').hidden = true;
  loadDevices();
});

$('newDeviceId').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('btnAddDevice').click(); });

$('btnAddDevice').addEventListener('click', async () => {
  const deviceId = $('newDeviceId').value.trim();
  const message = $('createMsg');
  if (!deviceId) {
    message.className = 'modal-msg';
    message.textContent = 'Enter a device ID.';
    return;
  }
  $('btnAddDevice').disabled = true;
  try {
    const created = await api('/devices', { method: 'POST', body: { deviceId, template: $('newDeviceTemplate').value } });
    message.className = 'modal-msg ok';
    message.textContent = `'${deviceId}' registered as ${templateName(created.template)}: Event Grid client created (certificate auth, attributes site/profile).`;
    $('tokenValue').textContent = created.token;
    $('tokenBox').hidden = false;
    state.lastCreated = deviceId;
    $('btnShowScript').hidden = false;
    $('newDeviceId').value = '';
    await loadDevices();
    upsertDevice(created);
    renderDevices();
    syncDeviceSelectors();
  } catch (err) {
    message.className = 'modal-msg';
    message.textContent = err.message;
    $('btnShowScript').hidden = true;
    $('tokenBox').hidden = true;
  } finally {
    $('btnAddDevice').disabled = false;
  }
});

$('btnCopyToken').addEventListener('click', () => copyText($('tokenValue').textContent, 'Enrolment token copied'));

$('btnShowScript').addEventListener('click', async () => {
  if (!state.lastCreated) return;
  $('createModal').hidden = true;
  await showScriptFor(state.lastCreated);
});

/* ============================================ connect summary / all-off */
$('btnConnectSummary').addEventListener('click', async () => {
  try {
    const summary = await api('/devices/connect-summary');
    $('summaryBody').innerHTML = `
      <div class="summary-stats">
        <div><strong>${summary.totalRegistered}</strong>Registered</div>
        <div><strong>${summary.totalConnected}</strong>Connected</div>
        <div><strong>${summary.totalMessagesSent}</strong>Messages received</div>
      </div>
      <p class="hint">Telemetry pipeline: ${escapeHtml(summary.telemetryPipeline)}<br>
        Site gateway: ${escapeHtml(summary.gateway || '—')}${summary.siteError ? ` — <b>${escapeHtml(summary.siteError)}</b>` : ''}</p>
      ${summary.sessions.length ? `
        <table class="summary-table">
          <thead><tr><th>Device</th><th>Profile</th><th>Uptime</th><th>Messages</th><th>Transport</th><th>Certificate</th></tr></thead>
          <tbody>${summary.sessions.map((s) => `
            <tr>
              <td>${escapeHtml(s.deviceId)}</td>
              <td>${escapeHtml(templateName(s.template))}</td>
              <td>${s.uptimeSeconds ?? '—'}s</td>
              <td>${s.messagesSent}</td>
              <td>${escapeHtml(s.mode)}${s.lastError ? ` — ${escapeHtml(s.lastError)}` : ''}</td>
              <td>${s.certificate?.notAfter ? countdownHtml(s.certificate.notAfter) : '—'}</td>
            </tr>`).join('')}
          </tbody>
        </table>` : '<p class="hint">No simulated machine is running at the mine site right now.</p>'}`;
    $('summaryModal').hidden = false;
  } catch (err) {
    toast(err.message, 'err');
  }
});
$('btnCloseSummary').addEventListener('click', () => { $('summaryModal').hidden = true; });

$('btnDisconnectAll').addEventListener('click', async () => {
  try {
    const result = await api('/devices/disconnect-all', { method: 'POST', body: {} });
    toast(`Stopped ${result.disconnected.length} machine(s)`);
    await loadDevices();
  } catch (err) {
    toast(err.message, 'err');
  }
});

/* ======================================================= onboarding */
async function loadTemplates() {
  state.templates = await api('/templates');
  $('templateGrid').innerHTML = state.templates.map((template) => `
    <div class="template-card" data-template="${escapeAttr(template.id)}" title="${escapeAttr(template.description)}">
      <div class="tpl-head">${escapeHtml(template.name)}</div>
      <img src="img/${escapeAttr(template.id)}.svg" alt="${escapeAttr(template.name)}" />
    </div>`).join('');
  $('newDeviceTemplate').innerHTML = state.templates.map((t) => `<option value="${escapeAttr(t.id)}">${escapeHtml(t.name)} profile</option>`).join('');
  $('templateGrid').querySelectorAll('.template-card').forEach((card) => card.addEventListener('click', () => selectTemplate(card.dataset.template)));
}

async function selectTemplate(templateId, deviceId = null) {
  state.selectedTemplate = templateId;
  const template = state.templates.find((t) => t.id === templateId);
  document.querySelectorAll('.template-card').forEach((card) => card.classList.toggle('selected', card.dataset.template === templateId));
  const keep = deviceId !== null ? deviceId : $('scriptDevice').value;
  $('scriptDevice').innerHTML = '<option value="">Generic (fill in the device ID and token)</option>'
    + state.devices.map((d) => `<option value="${escapeAttr(d.deviceId)}">${escapeHtml(d.deviceId)} (${escapeHtml(templateName(d.template))})</option>`).join('');
  if (keep && state.devices.some((d) => d.deviceId === keep)) $('scriptDevice').value = keep;
  $('scriptTitle').textContent = `${template.name} Onboarding Script`;
  $('scriptCard').hidden = false;
  await loadScript();
  $('scriptCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function updateScriptNote(script) {
  const note = $('scriptNote');
  const deviceId = $('scriptDevice').value;
  if (!deviceId) {
    note.className = 'script-note';
    note.textContent = 'Generic script - fill in the device ID and a one-time token.';
    return;
  }
  const device = state.devices.find((d) => d.deviceId === deviceId);
  const hasToken = !script.includes('<paste a one-time enrolment token>');
  if (device && device.template !== state.selectedTemplate) {
    note.className = 'script-note warn';
    note.textContent = `${deviceId} is registered as ${templateName(device.template)}, but you are viewing the ${templateName(state.selectedTemplate)} script.`;
  } else if (hasToken) {
    note.className = 'script-note ok';
    note.textContent = `${deviceId}'s one-time enrolment token is embedded. It works once, within 24 hours - after that the device renews its own certificate over MQTT.`;
  } else {
    note.className = 'script-note warn';
    note.textContent = `Tokens are shown only once. Press "New token" to embed a fresh one-time token for ${deviceId}.`;
  }
}

async function showScriptFor(deviceId) {
  try {
    upsertDevice(await api(`/devices/${encodeURIComponent(deviceId)}`));
  } catch (err) {
    toast(`Could not open the script for ${deviceId}: ${err.message}`, 'err');
    return;
  }
  const device = state.devices.find((d) => d.deviceId === deviceId);
  location.hash = '#/templates';
  await selectTemplate(device.template, deviceId);
}

async function loadScript() {
  if (!state.selectedTemplate) return;
  const deviceId = $('scriptDevice').value;
  const script = await api(`/templates/${state.selectedTemplate}/script${deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : ''}`);
  $('scriptBody').textContent = script;
  updateScriptNote(script);
}

$('scriptDevice').addEventListener('change', async () => {
  const device = state.devices.find((d) => d.deviceId === $('scriptDevice').value);
  if (device && device.template && device.template !== state.selectedTemplate) {
    await selectTemplate(device.template, device.deviceId);
    toast(`${device.deviceId} is registered as ${templateName(device.template)} - showing that script`, 'ok');
    return;
  }
  await loadScript();
});
$('btnNewToken').addEventListener('click', async () => {
  const deviceId = $('scriptDevice').value;
  if (!deviceId) return toast('Pick a device first', 'err');
  try {
    await api(`/devices/${encodeURIComponent(deviceId)}/token`, { method: 'POST', body: {} });
    await loadScript();
    toast(`New one-time token issued for ${deviceId}`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
});
$('btnCopyScript').addEventListener('click', () => copyText($('scriptBody').textContent, 'Onboarding script copied'));

/* ============================================================ dashboard */
function syncDeviceSelectors() {
  const select = $('dashDevice');
  const previous = state.dashDevice;
  select.innerHTML = state.devices.length
    ? state.devices.map((d) => `<option value="${escapeAttr(d.deviceId)}">${escapeHtml(d.deviceId)}${d.status === 'Connected' ? ' ●' : ''}</option>`).join('')
    : '<option value="">No devices</option>';
  const stillExists = state.devices.some((d) => d.deviceId === previous);
  const connectedFirst = state.devices.find((d) => d.status === 'Connected');
  state.dashDevice = stillExists ? previous : (connectedFirst?.deviceId || state.devices[0]?.deviceId || null);
  if (state.dashDevice) select.value = state.dashDevice;
  renderCertWidget();
  renderConnPill();
  syncPowerLossButton();
}

function metricsForDevice() {
  const device = state.devices.find((d) => d.deviceId === state.dashDevice);
  const template = state.templates.find((t) => t.id === (device?.template || 'raspberry-pi')) || state.templates[0];
  return template ? template.metrics : ['temperature'];
}

function fieldSpec(metric) {
  for (const template of state.templates) if (template.fields?.[metric]) return template.fields[metric];
  return { min: 0, max: 100, unit: '' };
}

function fillMetricSelectors() {
  const metrics = metricsForDevice();
  const labelFor = (metric) => metric.charAt(0).toUpperCase() + metric.slice(1);
  for (const [id, key] of [['gaugeMetric', 'gaugeMetric'], ['chartMetric', 'chartMetric']]) {
    const select = $(id);
    const preferred = state[key] && metrics.includes(state[key]) ? state[key] : (metrics.includes('lux') ? 'lux' : metrics[0]);
    select.innerHTML = metrics.map((metric) => `<option value="${escapeAttr(metric)}">${labelFor(metric)}</option>`).join('');
    select.value = preferred;
    state[key] = preferred;
  }
}

function drawGauge(value) {
  const spec = fieldSpec(state.gaugeMetric);
  const valid = Number.isFinite(value);
  const fraction = valid ? Math.max(0, Math.min(1, (value - spec.min) / (spec.max - spec.min || 1))) : 0;
  const angle = Math.PI * (1 - fraction);
  const x = 100 + 80 * Math.cos(angle);
  const y = 110 - 80 * Math.sin(angle);
  $('gaugeValue').setAttribute('d', !valid || fraction <= 0.001 ? '' : `M20 110 A80 80 0 ${fraction > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}`);
  $('gaugeValueText').textContent = valid ? `${Math.round(value * 100) / 100}${spec.unit ? ` ${spec.unit}` : ''}` : '—';
  document.querySelectorAll('.gauge-tick')[0].textContent = spec.min;
  document.querySelectorAll('.gauge-tick')[1].textContent = spec.max;
}

function applyReading(reading) {
  state.latest[reading.deviceId] = reading;
  state.counters[reading.deviceId] = (state.counters[reading.deviceId] || 0) + 1;
  if (reading.deviceId !== state.dashDevice) return;
  $('dashTimestamp').textContent = `Timestamp: ${formatDate(reading.timestamp || reading.ts)}`;
  drawGauge(Number(reading[state.gaugeMetric]));
  const on = Boolean(reading.buzzer);
  $('buzzerLed').className = `led ${on ? 'led-on' : 'led-off'}`;
  $('buzzerState').textContent = on ? 'ON' : 'OFF';
  $('buzzerHint').textContent = reading.alarmAt ? `auto ≥ ${reading.alarmAt}°C` : 'auto';
  applyMotorReading(reading);
  $('statMessages').textContent = state.counters[reading.deviceId];
  $('statSource').textContent = { mqtt: 'via MQTT broker', kafka: 'via Kafka (history)', seed: 'seeded history' }[reading.source] || reading.source || 'live';
}

function renderCertWidget() {
  const device = state.devices.find((d) => d.deviceId === state.dashDevice);
  const cert = device?.certificate;
  const c = countdown(cert?.notAfter);
  $('certCountdown').textContent = cert ? c.text : '—';
  $('certCountdown').className = `stat-value countdown ${c.cls}`;
  $('certSerial').textContent = cert ? `${cert.method} · ${shortSerial(cert.serial)}` : 'not enrolled';
}

/* ------------------------------- connection status and power-loss banner */
const clockTime = (value) => (value
  ? new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
const serverNow = () => Date.now() + state.clockOffset;
const mmss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const secondsText = (value) => (value == null ? '?' : `${value < 10 ? Math.round(value * 10) / 10 : Math.round(value)} s`);
const PL_ACTIVE = ['requested', 'offline', 'overdue'];
const PL_SHOW_ONLINE_MS = 3 * 60_000;
const isPowerLossActive = (deviceId) => PL_ACTIVE.includes(state.powerLoss[deviceId]?.phase);

/** Online / offline pill for the selected machine, from its retained MQTT status. */
function renderConnPill() {
  const pill = $('dashConn');
  const device = state.devices.find((d) => d.deviceId === state.dashDevice);
  if (!device) { pill.hidden = true; return; }
  const online = device.status === 'Connected';
  let text = 'Revoked';
  if (online) text = `Online${device.presence?.since ? ` since ${clockTime(device.presence.since)}` : ''}`;
  else if (device.status !== 'Revoked') text = `${device.status}${device.presence?.reason ? ` - ${device.presence.reason}` : ''}`;
  pill.className = `conn-pill ${online ? 'online' : device.status === 'Revoked' ? 'revoked' : 'offline'}`;
  pill.title = "From the machine's retained MQTT status message - 'offline' is the broker's Last Will";
  pill.innerHTML = `<i></i>${escapeHtml(text)}`;
  pill.hidden = false;
}

const PL_ICONS = {
  requested: '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z" fill="currentColor"/></svg>',
  offline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 3v9"/><path d="M6.3 7.2a8 8 0 1 0 11.4 0"/></svg>',
  online: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  overdue: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 21h20z"/><path d="M12 10v5M12 18h.01"/></svg>',
};
const PL_STEPS = [
  ['requestedAt', 'Power cut'],
  ['offlineAt', 'Last Will: offline'],
  ['onlineAt', 'Back online'],
  ['firstTelemetryAt', 'Telemetry flowing'],
];

function plTitle(e) {
  return {
    requested: `Power cut sent to ${e.deviceId}`,
    offline: `${e.deviceId} is OFFLINE`,
    online: `${e.deviceId} is BACK ONLINE${e.late ? ' (later than planned)' : ''}`,
    overdue: `${e.deviceId} has not come back`,
  }[e.phase] || e.deviceId;
}

function plDetail(e, now) {
  if (e.phase === 'requested') return "Waiting for the broker to publish the machine's Last Will...";
  if (e.phase === 'offline') {
    const left = Math.round((Date.parse(e.expectedBackAt) - now) / 1000);
    return `The broker published its Last Will ${secondsText(e.willAfterSeconds)} after the power cut ("${e.reason || 'offline'}"). `
      + (left > 0 ? `Power returns in ${left} s, then it reconnects with its own certificate.`
        : 'Power is back - the machine is reconnecting with its own certificate...');
  }
  if (e.phase === 'online') {
    return `Offline for ${secondsText(e.outageSeconds)}: Last Will at ${clockTime(e.offlineAt)}, online again at ${clockTime(e.onlineAt)}. `
      + 'It reconnected with its own certificate and published a retained "online" status'
      + (e.firstTelemetryAt ? `; first reading at ${clockTime(e.firstTelemetryAt)}.` : '.');
  }
  return `${e.detail || ''} Check Device Visibility (a revoked machine is refused when it reconnects) `
    + 'and Grafana: Contoso - MQTT broker & routing > Connection failures.';
}

function plClock(e, now) {
  if (e.phase === 'online') return [secondsText(e.outageSeconds), 'was offline'];
  if (e.phase === 'requested') return [mmss(now - Date.parse(e.requestedAt)), 'since power cut'];
  return [mmss(now - Date.parse(e.offlineAt || e.requestedAt)), 'offline for'];
}

function plMarkup(e, now) {
  const current = PL_STEPS.findIndex(([key]) => !e[key]);
  const steps = PL_STEPS.map(([key, label], i) => {
    const cls = e[key] ? 'done' : (i === current && e.phase !== 'overdue' ? 'now' : '');
    return `<span class="pl-step ${cls}">${i + 1}. ${escapeHtml(label)}${e[key] ? ` <b>${clockTime(e[key])}</b>` : ''}</span>`;
  }).join('');
  const [big, small] = plClock(e, now);
  return `<div class="pl-icon">${PL_ICONS[e.phase] || ''}</div>
    <div class="pl-body">
      <div class="pl-title">${escapeHtml(plTitle(e))}</div>
      <div class="pl-detail">${escapeHtml(plDetail(e, now))}</div>
      <div class="pl-steps">${steps}</div>
    </div>
    <div class="pl-clock"><b>${escapeHtml(big)}</b><span>${escapeHtml(small)}</span></div>
    <button class="pl-close" data-dismiss="${escapeAttr(e.deviceId)}" title="Hide this message" aria-label="Hide">&times;</button>`;
}

/** One banner row per machine; rebuilt on a new phase, otherwise only the clock and text tick. */
function renderPowerLoss() {
  const box = $('plBanner');
  const now = serverNow();
  const visible = Object.values(state.powerLoss).filter((e) => !e.dismissed
    && !(e.phase === 'online' && now - Date.parse(e.onlineAt) > PL_SHOW_ONLINE_MS));
  [...box.children].forEach((el) => { if (!visible.some((e) => e.deviceId === el.dataset.id)) el.remove(); });
  for (const e of visible) {
    let el = [...box.children].find((x) => x.dataset.id === e.deviceId);
    if (!el) {
      el = document.createElement('div');
      el.dataset.id = e.deviceId;
      box.appendChild(el);
    }
    if (el.dataset.seq !== String(e.seq)) {
      el.dataset.seq = String(e.seq);
      el.className = `pl-item pl-${e.phase}`;
      el.innerHTML = plMarkup(e, now);
    } else {
      const [big, small] = plClock(e, now);
      el.querySelector('.pl-clock b').textContent = big;
      el.querySelector('.pl-clock span').textContent = small;
      el.querySelector('.pl-detail').textContent = plDetail(e, now);
    }
  }
  box.hidden = !visible.length;
}

function syncPowerLossButton() {
  const busy = isPowerLossActive(state.dashDevice);
  $('btnPowerLoss').disabled = busy;
  $('btnPowerLoss').textContent = busy ? 'Power loss in progress…' : 'Simulate Power Loss';
}

/** A power-loss episode changed on the server (or was loaded at start-up). */
function onPowerLoss(e, { quiet = false } = {}) {
  if (e.now) state.clockOffset = Date.parse(e.now) - Date.now();
  const before = state.powerLoss[e.deviceId];
  if (before && e.seq < before.seq) return;
  if (e.phase === 'cancelled') delete state.powerLoss[e.deviceId];
  else state.powerLoss[e.deviceId] = { ...e, dismissed: Boolean(before && before.phase === e.phase && before.dismissed) };
  if (!quiet && before?.phase !== e.phase) {
    if (e.phase === 'offline') toast(`${e.deviceId} is offline - the broker published its Last Will`, '', 4000);
    else if (e.phase === 'online') {
      toast(`${e.deviceId} is back online after the power loss - offline for ${secondsText(e.outageSeconds)}`, 'ok', 9000);
    } else if (e.phase === 'overdue') toast(`${e.deviceId} has not come back - ${e.detail}`, 'err', 9000);
  }
  renderPowerLoss();
  syncPowerLossButton();
}

$('plBanner').addEventListener('click', (event) => {
  const button = event.target.closest('[data-dismiss]');
  if (!button) return;
  const e = state.powerLoss[button.dataset.dismiss];
  if (e) e.dismissed = true;
  renderPowerLoss();
});

/* ------------------------------------------------- motor speed setpoint */
function applyMotorReading(reading) {
  const controllable = Number.isFinite(Number(reading.targetRpm));
  $('motorWidget').style.display = controllable ? '' : 'none';
  if (!controllable) return;
  const target = Math.round(Number(reading.targetRpm));
  const actual = Math.round(Number(reading.rpm));
  $('motorTarget').textContent = target;
  $('motorActual').textContent = Number.isFinite(actual) ? actual : '—';
  $('motorPresets').querySelectorAll('button').forEach((b) => b.classList.toggle('active', Number(b.dataset.rpm) === target));
  if (Number.isFinite(actual) && Math.abs(actual - target) > 150) {
    $('motorStatus').className = 'motor-status pending';
    $('motorStatus').textContent = `ramping ${actual} → ${target} rpm`;
  }
}

async function sendMotorSpeed(targetRpm) {
  if (!state.dashDevice) return toast('No device selected', 'err');
  const status = $('motorStatus');
  status.className = 'motor-status pending';
  status.textContent = `sending setMotorSpeed(${targetRpm})…`;
  try {
    const result = await api(`/devices/${encodeURIComponent(state.dashDevice)}/motor`, { method: 'POST', body: { targetRpm } });
    if (result.accepted) {
      const r = result.response || {};
      status.className = 'motor-status ok';
      status.textContent = `accepted · ${r.previousTargetRpm} → ${r.targetRpm} rpm · ${result.roundTripMs} ms`;
      toast(`Device accepted ${r.targetRpm} rpm`, 'ok');
    } else {
      status.className = 'motor-status err';
      status.textContent = `rejected by device · ${result.status} · ${result.reason || 'no reason given'}`;
      toast(`Device refused: ${result.reason || result.status}`, 'err');
    }
  } catch (err) {
    status.className = 'motor-status err';
    status.textContent = err.message;
    toast(err.message, 'err');
  }
}

async function refreshChart() {
  if (!state.dashDevice) return;
  try {
    const data = await api(`/telemetry/${encodeURIComponent(state.dashDevice)}/history?range=${state.range}`);
    const metric = state.chartMetric;
    const labels = data.points.map((p) => p.label);
    const values = data.points.map((p) => (p[metric] === undefined ? null : p[metric]));
    const label = metric.charAt(0).toUpperCase() + metric.slice(1);
    const s = data.sources || {};
    $('chartSources').textContent = s.cosmos !== undefined
      ? `points: ${s.cosmos} from Cosmos DB (routed via Kafka) · ${s.memory} live (MQTT)`
      : `points: ${s.memory ?? 0} live (MQTT)`;
    if (!state.chart) {
      state.chart = new Chart($('historyChart'), {
        type: 'line',
        data: { labels, datasets: [dataset(label, values)] },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          interaction: { intersect: false, mode: 'index' },
          plugins: { legend: { display: true, position: 'top', labels: { boxWidth: 24, font: { size: 11 } } } },
          scales: {
            x: { ticks: { maxRotation: 90, minRotation: 45, font: { size: 9 } }, grid: { color: '#eef1f5' } },
            y: { beginAtZero: false, ticks: { font: { size: 10 } }, grid: { color: '#eef1f5' } },
          },
        },
      });
    } else {
      state.chart.data.labels = labels;
      state.chart.data.datasets = [dataset(label, values)];
      state.chart.update('none');
    }
  } catch (err) {
    console.warn('chart refresh failed', err);
  }
}

const dataset = (label, values) => ({
  label, data: values, borderColor: '#4a90d9', backgroundColor: 'rgba(138, 182, 221, .55)', borderWidth: 1.5,
  pointRadius: 2.5, pointBackgroundColor: '#2f78c4', fill: true, spanGaps: true, tension: 0.15,
});

async function refreshDashboard() {
  if (!state.devices.length) await loadDevices();
  syncDeviceSelectors();
  fillMetricSelectors();
  if (state.dashDevice) {
    const latest = await api(`/telemetry/${encodeURIComponent(state.dashDevice)}/latest`).catch(() => null);
    if (latest) applyReading(latest);
    else {
      $('dashTimestamp').textContent = 'Timestamp: — (waiting for telemetry - press Connect on the device list)';
      drawGauge(NaN);
    }
  }
  await refreshChart();
}

$('dashDevice').addEventListener('change', (event) => {
  state.dashDevice = event.target.value;
  state.counters[state.dashDevice] = 0;
  refreshDashboard();
});
$('gaugeMetric').addEventListener('change', (event) => {
  state.gaugeMetric = event.target.value;
  localStorage.setItem('gaugeMetric', event.target.value);
  const latest = state.latest[state.dashDevice];
  drawGauge(latest ? Number(latest[state.gaugeMetric]) : NaN);
});
$('chartMetric').addEventListener('change', (event) => {
  state.chartMetric = event.target.value;
  localStorage.setItem('chartMetric', event.target.value);
  refreshChart();
});
$('rangeToggle').addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  state.range = button.dataset.range;
  $('rangeToggle').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === button));
  refreshChart();
});
$('motorPresets').addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (button) sendMotorSpeed(Number(button.dataset.rpm));
});
$('motorApply').addEventListener('click', () => {
  const raw = $('motorInput').value.trim();
  // Not validated here on purpose: the device polices its own limits.
  sendMotorSpeed(raw === '' ? null : Number(raw));
});
$('motorInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('motorApply').click(); });

$('btnSeed').addEventListener('click', async () => {
  if (!state.dashDevice) return toast('No device selected', 'err');
  $('btnSeed').disabled = true;
  try {
    const result = await api(`/telemetry/${encodeURIComponent(state.dashDevice)}/seed`, { method: 'POST', body: { days: 7 } });
    toast(`Seeded ${result.seeded} historical points`, 'ok');
    await refreshChart();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    $('btnSeed').disabled = false;
  }
});

$('btnRenew').addEventListener('click', async () => {
  if (!state.dashDevice) return toast('No device selected', 'err');
  try {
    const r = await api(`/devices/${encodeURIComponent(state.dashDevice)}/renew`, { method: 'POST', body: {} });
    toast(`${state.dashDevice}: ${r.response?.detail || 'renewal requested'} - watch the certificate countdown reset`, 'ok');
    setTimeout(loadDevices, 6000);
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('btnPowerLoss').addEventListener('click', async () => {
  const deviceId = state.dashDevice;
  if (!deviceId) return toast('No device selected', 'err');
  $('btnPowerLoss').disabled = true;
  try {
    const r = await api(`/devices/${encodeURIComponent(deviceId)}/power-loss`, { method: 'POST', body: { seconds: 20 } });
    if (r.episode) onPowerLoss(r.episode, { quiet: true });
    toast(`Power cut sent to ${deviceId} - it stays off for ${r.response?.offlineSeconds ?? 20} s. Watch the banner.`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    syncPowerLossButton();
  }
});

/* ========================================================= certificates */
async function loadCertificates() {
  let data;
  try {
    data = await api('/certificates');
  } catch (err) {
    return toast(`Certificates: ${err.message}`, 'err');
  }
  const ca = data.ca;
  $('caTable').innerHTML = `
    <thead><tr><th>CA</th><th>SUBJECT</th><th>KEY (KEY VAULT HSM)</th><th>EXPIRES</th><th>SHA-256</th></tr></thead>
    <tbody>${[['Root', ca.root], ['Device issuing', ca.deviceCa], ['Server issuing', ca.serverCa]].map(([label, c]) => `
      <tr><td><b>${label}</b></td><td>${escapeHtml(c.subject)}</td><td class="mono">${escapeHtml(c.keyVaultKey)}</td>
      <td>${formatDate(c.notAfter)} <span class="hint">(${c.daysLeft} days)</span></td><td class="mono">${escapeHtml(c.sha256.slice(0, 16))}…</td></tr>`).join('')}
    </tbody>`;
  const s = data.server || {};
  $('serverCert').innerHTML = [
    ['Active Key Vault certificate', s.activeCertificateName],
    ['Served by Event Grid (serial)', s.servedSerial],
    ['Issuer', s.servedIssuer],
    ['Expires', `${formatDate(s.servedNotAfter)} (${s.servedDaysLeft ?? '—'} days)`],
    ['Issued by the Contoso server CA', s.servedByIotCa ? 'yes' : 'NO'],
    ['Device certificate lifetime', `${ca.deviceCertMinutes} min · re-enrol grace ${ca.reenrollGraceHours} h`],
  ].map(([k, v]) => `<div class="kv"><b>${escapeHtml(k)}</b><span>${escapeHtml(v ?? '—')}</span></div>`).join('');

  $('certRows').innerHTML = data.inventory.length ? data.inventory.map((d) => {
    const c = d.certificate;
    const counts = d.counts || {};
    const id = escapeAttr(d.deviceId);
    const stateBadge = d.state === 'revoked' ? 'err' : d.state === 'enrolled' ? 'ok' : 'muted';
    return `<tr>
      <td>${escapeHtml(d.deviceId)}</td><td>${escapeHtml(d.type)}</td>
      <td><span class="badge ${stateBadge}">${escapeHtml(d.state)}</span></td>
      <td class="mono" title="${escapeAttr(c?.serial || '')}">${shortSerial(c?.serial)}</td>
      <td>${c ? `${escapeHtml(c.method)} · ${formatTime(c.issuedAt)}` : '—'}</td>
      <td>${c ? countdownHtml(c.notAfter) : '—'}</td>
      <td>${counts.enroll || 0} / ${counts.renew || 0} / ${counts.reenroll || 0}${counts.refused ? ` <span class="badge warn">${counts.refused} refused</span>` : ''}</td>
      <td><div class="row-actions">
        ${d.type === 'device' && d.status === 'Connected' ? `<button class="btn-xs" data-cert="renew" data-id="${id}">Renew now</button>` : ''}
        ${d.type === 'device' ? `<button class="btn-xs" data-cert="token" data-id="${id}">New token</button>` : ''}
      </div></td></tr>`;
  }).join('') : '<tr><td colspan="8" class="empty">No clients registered.</td></tr>';

  $('certEvents').innerHTML = data.events.length ? data.events.map((e) => `<tr>
      <td>${formatDate(e.ts)}</td><td>${escapeHtml(e.deviceId)}</td>
      <td><span class="badge ${e.type === 'refused' || e.type === 'revoked' ? 'err' : e.type.includes('rotat') ? 'warn' : 'ok'}">${escapeHtml(e.type)}</span></td>
      <td class="mono">${shortSerial(e.serial)}</td>
      <td class="payload">${escapeHtml(e.reason || e.method || e.source || brief({ notAfter: e.notAfter, name: e.name }))}</td></tr>`).join('')
    : '<tr><td colspan="5" class="empty">No events yet.</td></tr>';
}

$('btnCertRefresh').addEventListener('click', loadCertificates);
$('btnRotateServer').addEventListener('click', async () => {
  if (!confirm('Issue a new 7-day certificate for mqtt.iot.example.com now and switch Event Grid to it?')) return;
  $('btnRotateServer').disabled = true;
  toast('Rotating - issuing in Key Vault, switching the custom domain, waiting until Event Grid serves it…');
  try {
    const r = await api('/certificates/server/rotate', { method: 'POST', body: {} });
    toast(`New certificate ${r.name} served after ${r.servedAfterSeconds ?? '?'} s`, 'ok');
    await loadCertificates();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    $('btnRotateServer').disabled = false;
  }
});
$('certRows').addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const id = button.dataset.id;
  try {
    if (button.dataset.cert === 'renew') {
      await api(`/devices/${encodeURIComponent(id)}/renew`, { method: 'POST', body: {} });
      toast(`${id} is renewing over MQTT`, 'ok');
      setTimeout(loadCertificates, 6000);
    } else if (button.dataset.cert === 'token') {
      const r = await api(`/devices/${encodeURIComponent(id)}/token`, { method: 'POST', body: {} });
      await copyText(r.token, `New one-time token for ${id} copied (valid ${r.tokenExpiresInHours} h)`);
    }
  } catch (err) {
    toast(err.message, 'err');
  }
});

/* ============================================================ retained */
async function loadRetained() {
  const data = await api('/retained').catch((err) => { toast(err.message, 'err'); return { messages: [] }; });
  $('retainedRows').innerHTML = data.messages.length ? data.messages.map((m) => `<tr>
      <td class="mono">${escapeHtml(m.topic)}</td>
      <td class="payload mono" title="${escapeAttr(JSON.stringify(m.payload))}">${escapeHtml(brief(m.payload))}</td>
      <td>${formatTime(m.receivedAt)}</td>
      <td><button class="btn-xs btn-delete" data-clear="${escapeAttr(m.topic)}" title="Publish an empty retained message to delete it">Clear</button></td></tr>`).join('')
    : '<tr><td colspan="4" class="empty">No retained messages.</td></tr>';
}
$('btnRetainedRefresh').addEventListener('click', loadRetained);
$('retainedRows').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-clear]');
  if (!button) return;
  if (!confirm(`Delete the retained message on ${button.dataset.clear}?`)) return;
  try {
    await api(`/retained?topic=${encodeURIComponent(button.dataset.clear)}`, { method: 'DELETE' });
    toast('Retained message cleared', 'ok');
    setTimeout(loadRetained, 800);
  } catch (err) {
    toast(err.message, 'err');
  }
});
$('btnLateJoiner').addEventListener('click', async () => {
  const box = $('lateJoinerResult');
  box.hidden = false;
  box.textContent = 'Opening a brand-new MQTT session and subscribing…';
  $('btnLateJoiner').disabled = true;
  try {
    const r = await api('/retained/late-joiner', { method: 'POST', body: { listenMs: 3000 } });
    const first = r.messages.filter((m) => m.retain).map((m) => m.afterMs);
    box.innerHTML = `<b>New subscriber ${escapeHtml(r.clientId)}</b> connected in ${r.connectMs} ms and received
      <b>${r.retainedCount} retained message(s)</b>${first.length ? ` within ${Math.max(...first)} ms of subscribing` : ''}
      (plus ${r.liveCount} live message(s) in ${r.listenMs / 1000} s). It knows every device's status without waiting for anything.
      <table><thead><tr><th>after</th><th>topic</th><th>retained</th><th>payload</th></tr></thead><tbody>
      ${r.messages.map((m) => `<tr><td>${m.afterMs} ms</td><td class="mono">${escapeHtml(m.topic)}</td><td>${m.retain ? 'yes' : 'live'}</td>
        <td class="payload mono">${escapeHtml(brief(m.payload, 110))}</td></tr>`).join('')}</tbody></table>`;
  } catch (err) {
    box.textContent = `Late-joiner test failed: ${err.message}`;
  } finally {
    $('btnLateJoiner').disabled = false;
  }
});

/* ============================================================ pipeline */
async function loadPipeline() {
  const data = await api('/pipeline').catch((err) => { toast(err.message, 'err'); return null; });
  if (!data) return;
  const k = data.kafka;
  $('pipelineStats').innerHTML = [
    ['Kafka bootstrap', k.bootstrap], ['Authentication', k.authentication], ['Consumer group', k.groupId],
    ['Consumer', k.connected ? 'connected' : `not connected${k.lastError ? ` - ${k.lastError}` : ''}`],
    ['Events received', Object.entries(k.received).map(([t, n]) => `${t}: ${n}`).join(' · ') || '0'],
    ['Quarantined (revoked / unknown clients)', String(data.quarantine?.dropped ?? 0)],
    ['Last event', formatTime(k.lastEventAt)],
  ].map(([key, v]) => `<div class="kv"><b>${escapeHtml(key)}</b><span>${escapeHtml(v ?? '—')}</span></div>`).join('');
  $('routingTable').innerHTML = `<thead><tr><th>EVENT SUBSCRIPTION</th><th>FILTER</th><th>DESTINATION</th></tr></thead><tbody>
    ${data.routing.subscriptions.map((s) => `<tr><td>${escapeHtml(s.name)}</td><td class="mono">${escapeHtml(s.filter)}</td><td>${escapeHtml(s.destination)}</td></tr>`).join('')}
    <tr><td>enrichments</td><td class="mono" colspan="2">${escapeHtml(Object.entries(data.routing.enrichments).map(([a, b]) => `${a} = ${b}`).join('   '))}</td></tr></tbody>`;
  state.kafkaRows = data.recent;
  state.alertRows = data.alerts || [];
  renderKafkaRows();
  renderAlertRows();
}

function renderAlertRows(flashFirst = false) {
  const rows = state.alertRows || [];
  $('alertRows').innerHTML = rows.length ? rows.map((e, i) => {
    const d = e.data || {};
    return `<tr class="${flashFirst && i === 0 ? 'flash' : ''}"><td>${formatTime(e.receivedAt)}</td>
      <td>${escapeHtml(e.enrichments?.client || d.deviceId || '—')}</td>
      <td><b class="status-revoked">${escapeHtml(d.temperature ?? '—')} °C</b></td>
      <td>${escapeHtml(d.rpm ?? '—')} / ${escapeHtml(d.targetRpm ?? '—')}</td>
      <td class="mono">${escapeHtml(e.subject || '—')}</td>
      <td class="hint">p${e.partition} · #${e.offset}</td></tr>`;
  }).join('') : '<tr><td colspan="6" class="empty">No alert routed yet - press Boost on a Raspberry Pi machine.</td></tr>';
}

function renderKafkaRows(flashFirst = false) {
  $('kafkaRows').innerHTML = state.kafkaRows.length ? state.kafkaRows.slice(0, 30).map((e, i) => {
    const d = e.data || {};
    const data = typeof d === 'object' ? ['temperature', 'rpm', 'targetRpm', 'buzzer', 'battery'].filter((f) => d[f] !== undefined).map((f) => `${f}=${d[f]}`).join(' ') : brief(d, 80);
    const en = e.enrichments || {};
    return `<tr class="${flashFirst && i === 0 ? 'flash' : ''}"><td>${formatTime(e.receivedAt)}</td>
      <td>${e.topic === 'alerts' ? '<span class="badge err">alerts</span>' : '<span class="badge ok">telemetry</span>'} <span class="hint">p${e.partition} · #${e.offset}</span></td>
      <td class="mono">${escapeHtml(e.subject || '—')}</td>
      <td class="mono">site=${escapeHtml(en.site ?? '—')} profile=${escapeHtml(en.profile ?? '—')} client=${escapeHtml(en.client ?? '—')}${e.quarantined ? ' <span class="badge err" title="Not registered or revoked - dropped by the app, not stored">quarantined</span>' : ''}</td>
      <td class="mono payload">${escapeHtml(data)}</td></tr>`;
  }).join('') : '<tr><td colspan="5" class="empty">Waiting for events…</td></tr>';
}

/* ============================================================ fleet */
async function loadFleet() {
  const cfg = await api('/fleet-config').catch(() => null);
  if (!cfg) return;
  $('fleetCurrent').innerHTML = [
    ['Version', cfg.version], ['Telemetry interval', `${cfg.telemetryIntervalSeconds} s`],
    ['Renew certificates at', `${Math.round((cfg.renewAtFraction || 0.67) * 100)} % of lifetime`],
    ['Published', cfg.updatedAt ? formatDate(cfg.updatedAt) : (cfg.note || '—')],
  ].map(([k, v]) => `<div class="kv"><b>${escapeHtml(k)}</b><span>${escapeHtml(v)}</span></div>`).join('');
  $('fleetInterval').value = cfg.telemetryIntervalSeconds ?? 5;
  $('fleetRenew').value = cfg.renewAtFraction ?? 0.67;
}
$('btnPublishFleet').addEventListener('click', async () => {
  try {
    const r = await api('/fleet-config', { method: 'POST', body: {
      telemetryIntervalSeconds: Number($('fleetInterval').value), renewAtFraction: Number($('fleetRenew').value) } });
    toast(`Fleet config v${r.version} published (retained)`, 'ok');
    setTimeout(loadFleet, 800);
  } catch (err) {
    toast(err.message, 'err');
  }
});

/* ============================================================== widgets */
function renderWidgetConfig() {
  const metrics = metricsForDevice();
  $('widgetConfig').innerHTML = `
    <label><span>Gauge metric</span><select class="select" id="cfgGauge">${metrics.map((m) => `<option value="${escapeAttr(m)}" ${m === state.gaugeMetric ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
    <label><span>Chart metric</span><select class="select" id="cfgChart">${metrics.map((m) => `<option value="${escapeAttr(m)}" ${m === state.chartMetric ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
    <label><span>Default chart range</span><select class="select" id="cfgRange">${['hourly', 'daily', 'weekly'].map((r) => `<option value="${r}" ${r === state.range ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
    <label><span>Thermal alarm widget</span><span><input type="checkbox" id="cfgBuzzer" ${localStorage.getItem('hideBuzzer') ? '' : 'checked'} /> visible</span></label>`;
  $('cfgGauge').addEventListener('change', (e) => { state.gaugeMetric = e.target.value; localStorage.setItem('gaugeMetric', e.target.value); $('gaugeMetric').value = e.target.value; });
  $('cfgChart').addEventListener('change', (e) => { state.chartMetric = e.target.value; localStorage.setItem('chartMetric', e.target.value); $('chartMetric').value = e.target.value; });
  $('cfgRange').addEventListener('change', (e) => {
    state.range = e.target.value;
    localStorage.setItem('range', e.target.value);
    $('rangeToggle').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.range === e.target.value));
  });
  $('cfgBuzzer').addEventListener('change', (e) => {
    if (e.target.checked) localStorage.removeItem('hideBuzzer'); else localStorage.setItem('hideBuzzer', '1');
    $('buzzerWidget').style.display = e.target.checked ? '' : 'none';
  });
}

/* ================================================================ boot */
$('navToggle').addEventListener('click', () => $('sidenav').classList.toggle('collapsed'));
window.addEventListener('hashchange', route);

function setPills() {
  const c = state.config;
  if (!c) return;
  $('modeBroker').textContent = `Broker: ${c.broker || '—'}${c.features.mqtt ? '' : ' (offline)'}`;
  $('modeKafka').textContent = `Kafka: ${c.features.kafka ? 'consuming' : 'not connected'}`;
  $('modeHistory').textContent = `History: ${c.features.history}`;
  $('modeBroker').title = `${$('modeBroker').textContent} · devices connect to ${c.mqttHost}`;
}

let deviceReload = null;
function scheduleDeviceReload() {
  clearTimeout(deviceReload);
  deviceReload = setTimeout(() => { if ($('view-devices').classList.contains('active') || $('view-dashboard').classList.contains('active')) loadDevices(); }, 700);
}

async function boot() {
  state.gaugeMetric = localStorage.getItem('gaugeMetric');
  state.chartMetric = localStorage.getItem('chartMetric');
  state.range = localStorage.getItem('range') || 'hourly';
  $('rangeToggle').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.range === state.range));
  if (localStorage.getItem('hideBuzzer')) $('buzzerWidget').style.display = 'none';
  try {
    state.config = await api('/config');
    $('appTitle').textContent = state.config.ui.title;
    $('userLabel').textContent = `${state.config.ui.user} (${state.config.ui.role})`;
    setPills();
  } catch (err) {
    toast(`API unreachable: ${err.message}`, 'err');
  }
  await loadTemplates();
  await loadDevices();
  route();
  // Outages that started before this page was opened (or before a reload).
  try {
    (await api('/power-loss')).forEach((e) => onPowerLoss(e, { quiet: true }));
  } catch { /* the banner simply starts empty */ }

  state.socket = io();
  state.socket.on('telemetry', (reading) => applyReading(reading));
  // Retained status changes (including the broker's Last Will) update the list at once.
  state.socket.on('status', (s) => {
    const device = state.devices.find((d) => d.deviceId === s.deviceId);
    if (device) {
      device.status = device.status === 'Revoked' ? 'Revoked' : s.online ? 'Connected' : (s.cleared ? device.status : 'Offline');
      device.presence = { online: Boolean(s.online), reason: s.reason || null, since: s.since || null };
      renderDevices();
      syncDeviceSelectors();
    }
    if (!s.online && s.reason && !isPowerLossActive(s.deviceId)) toast(`${s.deviceId || s.gateway}: offline - ${s.reason}`);
    scheduleDeviceReload();
  });
  state.socket.on('powerloss', (e) => onPowerLoss(e));
  state.socket.on('state', (s) => {
    if (s.certificate?.serial) {
      const device = state.devices.find((d) => d.deviceId === s.deviceId);
      if (device && device.certificate && device.certificate.serial !== s.certificate.serial) scheduleDeviceReload();
    }
  });
  state.socket.on('kafka', (e) => {
    state.kafkaRows.unshift(e);
    state.kafkaRows.length = Math.min(state.kafkaRows.length, 60);
    if (e.topic === 'alerts') {
      state.alertRows = [e, ...(state.alertRows || [])].slice(0, 20);
      if ($('view-pipeline').classList.contains('active')) renderAlertRows(true);
    }
    if ($('view-pipeline').classList.contains('active')) renderKafkaRows(true);
  });
  state.socket.on('alert', (a) => {
    toast(`ALERT routed to Kafka 'alerts': ${a.deviceId} temperature ${a.temperature}°C (filter data.temperature > 75)`, 'err');
  });
  state.socket.on('config', () => { if ($('view-fleet').classList.contains('active')) loadFleet(); });

  // Live countdowns, and a gentle refresh of the dashboard chart.
  setInterval(() => {
    document.querySelectorAll('.countdown[data-expires]').forEach((el) => {
      const c = countdown(el.dataset.expires);
      el.textContent = c.text;
      el.className = `countdown ${c.cls}`;
    });
    renderCertWidget();
    if (Object.keys(state.powerLoss).length) renderPowerLoss();
  }, 1000);
  setInterval(() => { if ($('view-dashboard').classList.contains('active')) refreshChart(); }, 10000);
  setInterval(async () => {
    try { state.config = await api('/config'); setPills(); } catch { /* keep last */ }
  }, 30000);
}

boot();
