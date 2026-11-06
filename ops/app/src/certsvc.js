import { config } from './config.js';

/**
 * Client for the certificate service's INTERNAL API (127.0.0.1:8081, shared header token).
 * The certificate service is the registration authority: it owns the Event Grid client
 * records, one-time enrolment tokens and the certificate inventory. The operator app holds
 * no Event Grid write permission and no Key Vault access of its own.
 */
async function call(method, path, body) {
  const response = await fetch(`${config.certsvc.url}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-IOT-Internal': config.certsvc.token },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const err = new Error((data && (data.error || data.detail)) || `certificate service HTTP ${response.status}`);
    err.statusCode = response.status;
    throw err;
  }
  return data;
}

export const listDevices = () => call('GET', '/internal/devices');
export const getDevice = (id) => call('GET', `/internal/devices/${encodeURIComponent(id)}`);
export const register = (body) => call('POST', '/internal/devices', body);
export const newToken = (id) => call('POST', `/internal/devices/${encodeURIComponent(id)}/token`);
export const revoke = (id, reason) => call('POST', `/internal/devices/${encodeURIComponent(id)}/revoke`, { reason });
export const restore = (id) => call('POST', `/internal/devices/${encodeURIComponent(id)}/restore`);
export const remove = (id) => call('DELETE', `/internal/devices/${encodeURIComponent(id)}`);
export const events = (id, limit = 50) => call('GET', `/internal/events?limit=${limit}${id ? `&deviceId=${encodeURIComponent(id)}` : ''}`);
export const caInfo = () => call('GET', '/internal/ca');
export const trustBundle = () => call('GET', '/internal/trust-bundle');
export const serverCert = () => call('GET', '/internal/server-cert');
export const rotateServerCert = () => call('POST', '/internal/server-cert/rotate');
export const health = () => call('GET', '/internal/health');
