/**
 * Device behaviour model shared by the in-process simulator and the seed script.
 * The Python templates in app/templates mirror this logic 1:1, so a "real"
 * Raspberry Pi running the template produces the same shaped telemetry.
 */

export const TEMPLATES = {
  'raspberry-pi': {
    id: 'raspberry-pi',
    name: 'Raspberry Pi',
    order: 2,
    script: 'raspberry-pi.py',
    description: 'Industrial gateway profile: motor RPM, winding temperature, humidity, line voltage, ambient lux, a remote speed setpoint and a thermal alarm.',
    metrics: ['temperature', 'humidity', 'voltage', 'rpm', 'lux'],
    fields: {
      temperature: { start: 45.0, min: 20, max: 95, drift: 0.35, unit: '°C' },
      humidity: { start: 60.0, min: 20, max: 95, drift: 0.4, unit: '%' },
      voltage: { start: 230.0, min: 200, max: 250, drift: 0.6, unit: 'V' },
      rpm: { start: 4500, min: 0, max: 6000, drift: 25, unit: 'rpm' },
      lux: { start: 6.67, min: 0, max: 100, drift: 0.8, unit: 'lx' },
    },
    /**
     * Cloud-to-device speed control.
     *
     * `setMotorSpeed` moves the motor to a new setpoint. The motor reaches it
     * within a few readings; the winding temperature then follows the load,
     * asymmetrically - coasting sheds heat slowly, driving hard makes it fast.
     * Boost is deliberately hot enough to trip the thermal alarm on its own,
     * which is the point of the demo: nobody clicks the alarm.
     */
    control: {
      method: 'setMotorSpeed',
      metric: 'rpm',
      unit: 'rpm',
      min: 0,
      max: 6000,
      nominal: 4500,
      step: 100,
      rampFactor: 0.5,      // how fast rpm converges on the setpoint, per reading
      thermalFactor: 0.28,  // how fast winding temperature follows, per reading
      heatPerRpm: 0.025,    // °C gained per rpm above nominal
      coolPerRpm: 0.006,    // °C lost per rpm below nominal
      presets: [
        { id: 'eco', label: 'Eco', rpm: 2000 },
        { id: 'normal', label: 'Normal', rpm: 4500 },
        { id: 'boost', label: 'Boost', rpm: 5900 },
      ],
    },
  },
  esp32: {
    id: 'esp32',
    name: 'ESP32',
    order: 1,
    script: 'esp32.py',
    description: 'Low-power sensor node profile: temperature, humidity, ambient lux, battery level and Wi-Fi signal strength.',
    metrics: ['temperature', 'humidity', 'lux', 'battery', 'rssi'],
    fields: {
      temperature: { start: 31.5, min: 15, max: 60, drift: 0.3, unit: '°C' },
      humidity: { start: 68.0, min: 20, max: 99, drift: 0.5, unit: '%' },
      lux: { start: 12.4, min: 0, max: 100, drift: 1.2, unit: 'lx' },
      battery: { start: 96.0, min: 5, max: 100, drift: 0.05, unit: '%' },
      rssi: { start: -58, min: -95, max: -30, drift: 1.5, unit: 'dBm' },
    },
  },
};

export function templateFor(id) {
  return TEMPLATES[id] || TEMPLATES['raspberry-pi'];
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const round2 = (value) => Math.round(value * 100) / 100;

/**
 * Random-walk state machine: values drift smoothly instead of jumping, so the
 * charts look like real sensors rather than white noise.
 */
export function createState(templateId) {
  const template = templateFor(templateId);
  const state = { templateId: template.id, values: {}, velocity: {}, buzzer: false };
  for (const [field, spec] of Object.entries(template.fields)) {
    state.values[field] = spec.start;
    state.velocity[field] = 0;
  }
  if (template.control) state.setpoint = template.control.nominal;
  return state;
}

/** Alarm threshold, shared by the model and the UI. 80% of the sensor's range. */
export function alarmTemperature(template) {
  return round2(template.fields.temperature.max * 0.8);
}

/**
 * Where the controlled metric - and, as a consequence, the winding
 * temperature - is currently heading.
 */
function targetsFor(template, state) {
  const targets = {};
  for (const [field, spec] of Object.entries(template.fields)) targets[field] = spec.start;

  const control = template.control;
  if (!control) return targets;

  const setpoint = clamp(
    Number.isFinite(state.setpoint) ? state.setpoint : control.nominal,
    control.min,
    control.max,
  );
  targets[control.metric] = setpoint;

  const delta = setpoint - control.nominal;
  const perRpm = delta >= 0 ? control.heatPerRpm : control.coolPerRpm;
  const tempSpec = template.fields.temperature;
  targets.temperature = clamp(tempSpec.start + delta * perRpm, tempSpec.min, tempSpec.max);

  return targets;
}

/**
 * Validates and applies a cloud-to-device speed command.
 * Returns exactly what the device answers back to IoT Hub, so the dashboard
 * can show an acceptance or a rejection without inventing anything.
 */
export function applyMotorSpeed(state, payload, intervalSeconds = 5) {
  const template = templateFor(state.templateId);
  const control = template.control;

  if (!control) {
    return { status: 404, payload: { accepted: false, error: 'This device has no motor to control.' } };
  }

  const raw = payload?.targetRpm;
  if (raw === undefined || raw === null || raw === '' || !Number.isFinite(Number(raw))) {
    return {
      status: 400,
      payload: { accepted: false, error: 'targetRpm must be a number.', received: raw ?? null },
    };
  }

  const requested = Math.round(Number(raw));
  if (requested < control.min || requested > control.max) {
    return {
      status: 400,
      payload: {
        accepted: false,
        error: `targetRpm must be between ${control.min} and ${control.max}.`,
        received: requested,
        min: control.min,
        max: control.max,
      },
    };
  }

  const previous = Number.isFinite(state.setpoint) ? state.setpoint : control.nominal;
  state.setpoint = requested;

  return {
    status: 200,
    payload: {
      accepted: true,
      previousTargetRpm: previous,
      targetRpm: requested,
      rampSeconds: Math.max(1, Math.round(4 * intervalSeconds)),
    },
  };
}

export function step(state, ts = Date.now()) {
  const template = templateFor(state.templateId);
  const control = template.control;
  const targets = targetsFor(template, state);

  for (const [field, spec] of Object.entries(template.fields)) {
    const target = targets[field];

    // The controlled metric and the temperature that follows it use a direct
    // exponential approach: no momentum, so they converge without oscillating.
    if (control && field === control.metric) {
      const noise = (Math.random() - 0.5) * spec.drift;
      state.values[field] = clamp(
        state.values[field] + (target - state.values[field]) * control.rampFactor + noise,
        spec.min,
        spec.max,
      );
      continue;
    }
    if (control && field === 'temperature') {
      const noise = (Math.random() - 0.5) * spec.drift;
      state.values[field] = clamp(
        state.values[field] + (target - state.values[field]) * control.thermalFactor + noise,
        spec.min,
        spec.max,
      );
      continue;
    }

    // Everything else keeps the original random walk: velocity carries
    // momentum, damped each tick, plus a nudge back to `start`.
    const nudge = (target - state.values[field]) * 0.02;
    const noise = (Math.random() - 0.5) * spec.drift;
    state.velocity[field] = state.velocity[field] * 0.7 + noise + nudge;
    state.values[field] = clamp(
      state.values[field] + state.velocity[field],
      spec.min,
      spec.max,
    );
  }

  // The alarm latches on when the windings run hot. Nothing in the cloud sets
  // it: driving the motor hard is what trips it. A direct method can still
  // force it, which is how the Portal's setBuzzer demo works.
  if (state.manualBuzzer === undefined) {
    state.buzzer = state.values.temperature > alarmTemperature(template);
  } else {
    state.buzzer = state.manualBuzzer;
  }

  const reading = {
    ts,
    timestamp: new Date(ts).toISOString(),
    template: template.id,
    buzzer: state.buzzer,
  };
  if (control) {
    reading.targetRpm = Math.round(
      Number.isFinite(state.setpoint) ? state.setpoint : control.nominal,
    );
    reading.alarmAt = alarmTemperature(template);
  }
  for (const field of template.metrics) {
    reading[field] = field === 'rpm'
      ? Math.round(state.values[field])
      : round2(state.values[field]);
  }
  return reading;
}

/** Builds a plausible back-history so Daily/Weekly charts are populated on day one. */
export function generateHistory(deviceId, templateId, { days = 7, everyMs = 60_000, endTs = Date.now() } = {}) {
  const state = createState(templateId);
  const readings = [];
  const startTs = endTs - days * 24 * 60 * 60 * 1000;

  for (let ts = startTs; ts <= endTs; ts += everyMs) {
    // A gentle diurnal cycle on top of the random walk.
    const hour = new Date(ts).getHours();
    const daylight = Math.max(0, Math.sin(((hour - 6) / 12) * Math.PI));
    state.values.lux = clamp(4 + daylight * 70 + (Math.random() - 0.5) * 6, 0, 100);
    const reading = step(state, ts);
    reading.lux = round2(state.values.lux);
    readings.push({ deviceId, source: 'seed', ...reading });
  }
  return readings;
}
