/*
 * Trace hooks - the only link between the message flow and the optional "Behind the scenes" view.
 *
 * Existing modules call emit() at a few points (MQTT in, MQTT request/PUBACK, Kafka in, Cosmos DB
 * write). Until the trace module installs a sink, emit() does nothing. emit() never throws and never
 * waits, so the hooks cannot change what the app does - with IOT_TRACE=off they stay no-ops.
 */
let sink = null;

export function setSink(fn) {
  sink = typeof fn === 'function' ? fn : null;
}

export function emit(kind, data) {
  if (!sink) return;
  try {
    sink(kind, data);
  } catch {
    // A tracing problem must never reach the caller.
  }
}

export function isActive() {
  return sink !== null;
}
