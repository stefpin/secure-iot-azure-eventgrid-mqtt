"""Contoso certificate service (registration authority + issuing front end for the HSM-backed CA).

Runs on vm-ops as user iotcert with the user-assigned identity id-iotmq-certsvc.

Public, private-network only (nginx :443 on enroll.iot.example.com, reachable from the
mine site through the VPN; never published to the internet):
    POST /v1/enroll     first certificate: one-time token + CSR (key generated ON the device)
    POST /v1/reenroll   certificate already expired (device was offline) - proves possession of
                        the previous key within the grace period; no new token needed
    GET  /v1/health

MQTT (Entra ID auth, RBAC on topic space ts-certsvc):
    iot/cert/{site}/{id}/req  ->  iot/cert/{site}/{id}/res   routine renewal before expiry.
    Only a client that authenticated with the CURRENT certificate for {id} can publish on that
    topic (topic template uses ${client.authenticationName}), so the topic itself proves identity.

Internal (127.0.0.1 only, shared header token) - used by the operator web app:
    devices: register / token / revoke / restore / delete / list; events; CA info;
    server certificate status and rotate-now.

Scheduled (every 10 minutes): rotate the MQTT server certificate when 3 of 7 days remain
(day 4), renew the enrolment TLS certificate, prune old server certificates.
"""
from __future__ import annotations

import base64
import collections
import concurrent.futures
import datetime as dt
import json
import logging
import os
import pathlib
import threading
import time

import paho.mqtt.client as mqtt
import uvicorn
from azure.identity import ManagedIdentityCredential
from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from paho.mqtt.packettypes import PacketTypes
from paho.mqtt.properties import Properties

import iotca
from config import Config
from registry import Registry, RegistryError, iso, utcnow
from servercert import ServerCerts

cfg = Config()
cred = ManagedIdentityCredential(client_id=cfg.client_id)

log = logging.getLogger("iot.certsvc")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logging.getLogger("azure").setLevel(logging.WARNING)
logging.getLogger("uvicorn.access").setLevel(logging.WARNING)

meter = None
if os.environ.get("APPLICATIONINSIGHTS_CONNECTION_STRING"):
    try:
        from azure.monitor.opentelemetry import configure_azure_monitor
        from opentelemetry import metrics

        # Application Insights has local auth disabled: telemetry is accepted only with an Entra token.
        configure_azure_monitor(credential=cred, logger_name="iot.certsvc",
                                instrumentation_options={"fastapi": {"enabled": True}, "requests": {"enabled": False},
                                                         "urllib3": {"enabled": False}, "urllib": {"enabled": False}})
        meter = metrics.get_meter("iot.certsvc")
    except Exception as exc:  # telemetry must never stop issuance
        log.warning("Application Insights disabled: %s", exc)


def emit(event: str, **fields):
    """One structured log line per lifecycle event -> AppTraces in Log Analytics (Grafana reads these)."""
    log.info(event, extra={"iot.event": event, **{f"iot.{k}": v for k, v in fields.items() if v is not None}})


PKI = pathlib.Path(cfg.pki_dir)
root_cert = x509.load_pem_x509_certificate((PKI / "root-ca.pem").read_bytes())
device_ca = iotca.KvCa(cfg.vault_url, cred, "iot-device-ca",
                       x509.load_pem_x509_certificate((PKI / "device-ca.pem").read_bytes()))
server_ca = iotca.KvCa(cfg.vault_url, cred, "iot-server-ca",
                       x509.load_pem_x509_certificate((PKI / "server-ca.pem").read_bytes()))
registry = Registry(cfg, cred, log=log.warning)
servers = ServerCerts(cfg, cred, server_ca, log=log.info)
TRUST_BUNDLE = iotca.pem(root_cert) + iotca.pem(server_ca.certificate)

issued_counter = meter.create_counter("iot_certificates_issued", description="Device/gateway certificates issued") if meter else None
refused_counter = meter.create_counter("iot_certificates_refused", description="Certificate requests refused") if meter else None
_server_status = {"value": None, "at": 0.0}


def _server_days_left(_options):
    from opentelemetry.metrics import Observation
    s = _server_status["value"]
    return [Observation(s["servedDaysLeft"], {"host": cfg.mqtt_host})] if s and s.get("servedDaysLeft") is not None else []


if meter:
    meter.create_observable_gauge("iot_server_cert_days_left", callbacks=[_server_days_left],
                                  description="Days until the MQTT custom-domain certificate served by Event Grid expires")

# ----------------------------------------------------------------- issuance
_rate = collections.defaultdict(collections.deque)
_rate_lock = threading.Lock()


def _rate_check(device_id: str):
    now = time.time()
    with _rate_lock:
        q = _rate[device_id]
        while q and now - q[0] > 3600:
            q.popleft()
        if len(q) >= cfg.max_issues_per_hour:
            raise RegistryError(429, f"More than {cfg.max_issues_per_hour} certificates in an hour for '{device_id}'.")
        q.append(now)


def _refuse(device_id: str, method: str, err: Exception, source: str):
    status = getattr(err, "status", 400)
    registry.event(device_id, "refused", detail={"method": method, "reason": str(err), "source": source})
    doc = registry.get(device_id)
    if doc:
        doc.setdefault("counts", {}).setdefault("refused", 0)
        doc["counts"]["refused"] += 1
        registry.save(doc)
    if refused_counter:
        refused_counter.add(1, {"method": method})
    emit("cert.refused", deviceId=device_id, method=method, reason=str(err), status=status, source=source)


def issue(device_id: str, csr_pem: str, method: str, source: str) -> dict:
    """Common path for enrol / renew / re-enrol. Raises RegistryError on refusal."""
    doc = registry.get(device_id)
    if not doc or doc.get("state") == "deleted":
        raise RegistryError(404, f"Device '{device_id}' is not registered.")
    if doc.get("state") == "revoked":
        raise RegistryError(403, f"Device '{device_id}' is revoked.")
    _rate_check(device_id)
    try:
        csr = x509.load_pem_x509_csr(csr_pem.encode())
    except Exception:
        raise RegistryError(400, "The CSR is not a valid PEM certificate signing request.")
    try:
        minutes = int(doc.get("certMinutes") or cfg.device_cert_minutes)
        cert = iotca.issue_client(device_ca, csr, device_id, doc.get("site", "site1"), dt.timedelta(minutes=minutes))
    except ValueError as exc:
        raise RegistryError(400, str(exc))

    key = cert.public_key()
    key_type = (f"EC {key.curve.name}" if isinstance(key, ec.EllipticCurvePublicKey) else f"RSA {key.key_size}")
    serial = format(cert.serial_number, "X")
    previous = (doc.get("cert") or {}).get("serial")
    doc["cert"] = {
        "serial": serial, "notBefore": iso(cert.not_valid_before_utc), "notAfter": iso(cert.not_valid_after_utc),
        "issuedAt": iso(), "method": method, "keyType": key_type, "previousSerial": previous,
        "sha256": cert.fingerprint(hashes.SHA256()).hex(),
    }
    doc["state"] = "enrolled"
    doc.setdefault("counts", {}).setdefault(method, 0)
    doc["counts"][method] += 1
    doc["lastIssuedAt"] = iso()
    registry.save(doc)
    registry.event(device_id, method, serial=serial,
                   detail={"notAfter": doc["cert"]["notAfter"], "keyType": key_type, "source": source,
                           "previousSerial": previous})
    if issued_counter:
        issued_counter.add(1, {"method": method, "type": doc.get("type", "device")})
    emit("cert.issued", deviceId=device_id, method=method, serial=serial, notAfter=doc["cert"]["notAfter"],
         type=doc.get("type"), site=doc.get("site"), source=source)
    return {
        "deviceId": device_id,
        "certificate": iotca.pem(cert),
        "chain": iotca.pem(device_ca.certificate),
        "notAfter": doc["cert"]["notAfter"],
        "serial": serial,
        "mqttHost": cfg.mqtt_host,
        "trustBundle": TRUST_BUNDLE,
    }


def verify_previous_possession(device_id: str, cert_pem: str, csr_pem: str, signature_b64: str) -> None:
    """Re-enrolment proof: the expired certificate is ours, current, recent, and the caller holds its key."""
    try:
        old = x509.load_pem_x509_certificate(cert_pem.encode())
    except Exception:
        raise RegistryError(400, "certificate is not a valid PEM certificate.")
    try:
        old.verify_directly_issued_by(device_ca.certificate)
    except Exception:
        raise RegistryError(403, "The previous certificate was not issued by the Contoso device CA.")
    if iotca.common_name(old) != device_id:
        raise RegistryError(403, "The previous certificate belongs to another device.")
    doc = registry.get(device_id) or {}
    if (doc.get("cert") or {}).get("serial") != format(old.serial_number, "X"):
        raise RegistryError(403, "Only the most recently issued certificate can be used to re-enrol.")
    expired_for = utcnow() - old.not_valid_after_utc
    if expired_for > dt.timedelta(hours=cfg.reenroll_grace_hours):
        raise RegistryError(403, f"The previous certificate expired more than {cfg.reenroll_grace_hours} h ago; "
                                 "ask the operator for a new enrolment token.")
    csr_der = x509.load_pem_x509_csr(csr_pem.encode()).public_bytes(serialization.Encoding.DER)
    sig = base64.b64decode(signature_b64 or "")
    key = old.public_key()
    try:
        if isinstance(key, ec.EllipticCurvePublicKey):
            key.verify(sig, csr_der, ec.ECDSA(hashes.SHA256()))
        else:
            key.verify(sig, csr_der, padding.PKCS1v15(), hashes.SHA256())
    except InvalidSignature:
        raise RegistryError(403, "Proof of possession failed: the signature does not match the previous key.")


# --------------------------------------------------------------------- MQTT
class MqttRenewals:
    """Answers iot/cert/{site}/{id}/req with a fresh certificate, as an Entra ID MQTT 5 client."""

    def __init__(self):
        self.connected = threading.Event()
        self.stop = threading.Event()
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=4)
        self.token_expires = 0
        self.stats = {"requests": 0, "issued": 0, "refused": 0, "lastRequestAt": None, "connects": 0}
        self.client = mqtt.Client(callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
                                  client_id="iot-certsvc", protocol=mqtt.MQTTv5, reconnect_on_failure=False)
        self.client.tls_set()  # namespace hostname -> Microsoft-managed certificate, system trust store
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = lambda c, u, f, rc, p: (self.connected.clear(), log.warning("mqtt disconnected: %s", rc))
        self.client.on_message = lambda c, u, m: self.pool.submit(self._handle, m)

    def _on_connect(self, client, userdata, flags, rc, props):
        if rc.is_failure:
            log.error("mqtt connect refused: %s", rc)
            return
        self.stats["connects"] += 1
        client.subscribe("iot/cert/+/+/req", qos=1)
        self.connected.set()
        log.info("mqtt connected to %s (session present=%s)", cfg.broker_host, flags.session_present)

    def run(self):
        backoff = 5
        while not self.stop.is_set():
            token = cred.get_token("https://eventgrid.azure.net/.default")
            self.token_expires = token.expires_on
            props = Properties(PacketTypes.CONNECT)
            props.AuthenticationMethod = "OAUTH2-JWT"
            props.AuthenticationData = token.token.encode()
            props.SessionExpiryInterval = 3600
            try:
                self.client.connect(cfg.broker_host, 8883, keepalive=60, clean_start=False, properties=props)
            except Exception as exc:
                log.error("mqtt connect failed: %s", exc)
                time.sleep(backoff)
                backoff = min(backoff * 2, 120)
                continue
            backoff = 5
            self.client.loop_start()
            deadline = time.time() + 20
            while not self.connected.is_set() and time.time() < deadline:
                time.sleep(0.5)
            if not self.connected.is_set():
                self.client.loop_stop()
                log.error("mqtt session not established - retrying in %s s", backoff)
                time.sleep(backoff)
                backoff = min(backoff * 2, 120)
                continue
            # Stay connected until the token is 10 minutes from expiry, then reconnect with a fresh one.
            while self.connected.is_set() and not self.stop.is_set() and time.time() < self.token_expires - 600:
                time.sleep(5)
            if self.connected.is_set():
                log.info("refreshing the Entra ID token - reconnecting")
                self.client.disconnect()
            self.client.loop_stop()
            self.connected.clear()
            time.sleep(2)

    def _reply(self, topic: str, correlation: bytes | None, status: int, body: dict):
        props = Properties(PacketTypes.PUBLISH)
        props.ContentType = "application/json"
        props.PayloadFormatIndicator = 1
        if correlation:
            props.CorrelationData = correlation
        props.UserProperty = [("status", str(status))]
        self.client.publish(topic, json.dumps(body), qos=1, properties=props)

    def _handle(self, msg):
        parts = msg.topic.split("/")
        if len(parts) != 5:
            return
        _, _, site, device_id, _ = parts
        expected = f"iot/cert/{site}/{device_id}/res"
        props = msg.properties
        response_topic = getattr(props, "ResponseTopic", None)
        correlation = getattr(props, "CorrelationData", None)
        self.stats["requests"] += 1
        self.stats["lastRequestAt"] = iso()
        if response_topic != expected:
            log.warning("renewal from %s with response topic %r refused", device_id, response_topic)
            self._reply(expected, correlation, 400, {"error": f"Response topic must be {expected}."})
            return
        try:
            body = json.loads(msg.payload or b"{}")
            doc = registry.get(device_id)
            if doc and doc.get("site") != site:
                raise RegistryError(403, "Site does not match the registry.")
            result = issue(device_id, body.get("csr", ""), "renew", "mqtt")
            self.stats["issued"] += 1
            self._reply(expected, correlation, 200, result)
        except RegistryError as exc:
            self.stats["refused"] += 1
            _refuse(device_id, "renew", exc, "mqtt")
            self._reply(expected, correlation, exc.status, {"error": str(exc)})
        except Exception as exc:
            self.stats["refused"] += 1
            log.exception("renewal for %s failed", device_id)
            self._reply(expected, correlation, 500, {"error": f"internal error: {exc}"})


renewals = MqttRenewals()


# ---------------------------------------------------------------- scheduler
class Scheduler:
    def __init__(self):
        self.last = {}
        self.lock = threading.Lock()

    def server_status(self, refresh=False):
        if refresh or time.time() - _server_status["at"] > 60:
            _server_status["value"] = servers.status()
            _server_status["at"] = time.time()
        return _server_status["value"]

    def rotate_server(self, reason: str):
        with self.lock:
            result = servers.rotate(reason=reason)
            emit("servercert.rotated", name=result["name"], serial=result["serial"], previous=result["previous"],
                 servedAfterSeconds=result["servedAfterSeconds"], reason=reason)
            registry.event("_server", "server-rotated", serial=result["serial"], detail=result)
            self.server_status(refresh=True)
            return result

    def tick(self):
        try:
            if servers.due():
                self.rotate_server("scheduled")
            if servers.enroll_cert_due():
                r = servers.renew_enroll_cert()
                emit("enrollcert.renewed", serial=r["serial"], notAfter=r["notAfter"])
            pruned = servers.prune(keep=2)
            if pruned:
                emit("servercert.pruned", names=",".join(pruned))
            self.server_status(refresh=True)
            self.last["tick"] = iso()
        except Exception as exc:
            log.exception("scheduler tick failed")
            self.last["error"] = f"{iso()} {exc}"

    def run(self):
        while True:
            self.tick()
            time.sleep(600)


scheduler = Scheduler()

# ---------------------------------------------------------------------- HTTP
app = FastAPI(title="Contoso certificate service", docs_url=None, redoc_url=None, openapi_url=None)


@app.exception_handler(RegistryError)
async def _registry_error(_request: Request, exc: RegistryError):
    return JSONResponse(status_code=exc.status, content={"error": str(exc)})


@app.get("/v1/health")
def health():
    return {"status": "ok", "mqtt": renewals.connected.is_set(), "time": iso()}


@app.post("/v1/enroll")
def enroll(body: dict):
    device_id = str(body.get("deviceId", ""))
    try:
        registry.consume_token(device_id, str(body.get("token", "")))
        return issue(device_id, str(body.get("csr", "")), "enroll", "https")
    except RegistryError as exc:
        _refuse(device_id, "enroll", exc, "https")
        raise


@app.post("/v1/reenroll")
def reenroll(body: dict):
    device_id = str(body.get("deviceId", ""))
    try:
        verify_previous_possession(device_id, str(body.get("certificate", "")), str(body.get("csr", "")),
                                   str(body.get("signature", "")))
        return issue(device_id, str(body.get("csr", "")), "reenroll", "https")
    except RegistryError as exc:
        _refuse(device_id, "reenroll", exc, "https")
        raise


def _internal(token: str | None):
    if not cfg.internal_token or token != cfg.internal_token:
        raise HTTPException(status_code=401, detail="internal API")


@app.get("/internal/health")
def internal_health(x_iot_internal: str | None = Header(default=None)):
    _internal(x_iot_internal)
    return {"status": "ok", "mqtt": {"connected": renewals.connected.is_set(), **renewals.stats},
            "scheduler": scheduler.last, "deviceCertMinutes": cfg.device_cert_minutes,
            "reenrollGraceHours": cfg.reenroll_grace_hours}


@app.post("/internal/devices")
def internal_register(body: dict, x_iot_internal: str | None = Header(default=None)):
    _internal(x_iot_internal)
    device_id = str(body.get("deviceId", "")).strip()
    kind = str(body.get("type", "device"))
    if kind not in ("device", "gateway"):
        raise RegistryError(400, "type must be device or gateway.")
    if not device_id or len(device_id) > 64 or not all(c.isalnum() or c in "-_" for c in device_id):
        raise RegistryError(400, "Device ID must be 1-64 letters, digits, '-' or '_'.")
    doc, token = registry.register(device_id, kind, str(body.get("site", "site1")),
                                   str(body.get("profile", "") if kind == "device" else ""),
                                   created_by=str(body.get("createdBy", "operator")))
    if body.get("certMinutes"):
        # Optional per-device lifetime (e.g. 3-minute test devices to exercise expiry and re-enrolment).
        doc["certMinutes"] = int(min(max(int(body["certMinutes"]), 2), 1440))
        doc = registry.save(doc)
    emit("device.registered", deviceId=device_id, type=kind, site=doc["site"], profile=doc["profile"])
    return {"device": doc, "token": token, "tokenExpiresInHours": cfg.token_hours,
            "enrollUrl": f"https://{cfg.enroll_host}/v1/enroll", "mqttHost": cfg.mqtt_host}


@app.get("/internal/devices")
def internal_list(x_iot_internal: str | None = Header(default=None)):
    _internal(x_iot_internal)
    return registry.list()


@app.get("/internal/devices/{device_id}")
def internal_get(device_id: str, x_iot_internal: str | None = Header(default=None)):
    _internal(x_iot_internal)
    doc = registry.get(device_id)
    if not doc or doc.get("state") == "deleted":
        raise RegistryError(404, "not found")
    client = registry.eg_client(device_id)
    doc["eventGrid"] = (client or {}).get("properties")
    return doc


@app.post("/internal/devices/{device_id}/token")
def internal_token(device_id: str, x_iot_internal: str | None = Header(default=None)):
    _internal(x_iot_internal)
    doc = registry.get(device_id)
    if not doc or doc.get("state") in ("deleted", "revoked"):
        raise RegistryError(409, "Only registered or enrolled devices can get a new token.")
    token = registry.new_token(device_id)
    registry.event(device_id, "token-issued")
    return {"token": token, "tokenExpiresInHours": cfg.token_hours, "enrollUrl": f"https://{cfg.enroll_host}/v1/enroll"}


@app.post("/internal/devices/{device_id}/revoke")
def internal_revoke(device_id: str, body: dict | None = None, x_iot_internal: str | None = Header(default=None)):
    _internal(x_iot_internal)
    doc = registry.get(device_id)
    if not doc or doc.get("state") == "deleted":
        raise RegistryError(404, "not found")
    attrs = {"type": doc.get("type", "device"), "site": doc.get("site", "site1")}
    if doc.get("profile"):
        attrs["profile"] = doc["profile"]
    registry.eg_upsert_client(device_id, attrs, enabled=False, description=f"REVOKED {device_id}")
    doc["stateBeforeRevoke"] = doc.get("state")
    doc["state"] = "revoked"
    doc["revokedAt"] = iso()
    registry.save(doc)
    reason = (body or {}).get("reason", "operator")
    registry.event(device_id, "revoked", serial=(doc.get("cert") or {}).get("serial"), detail={"reason": reason})
    emit("device.revoked", deviceId=device_id, reason=reason)
    return doc


@app.post("/internal/devices/{device_id}/restore")
def internal_restore(device_id: str, x_iot_internal: str | None = Header(default=None)):
    _internal(x_iot_internal)
    doc = registry.get(device_id)
    if not doc or doc.get("state") != "revoked":
        raise RegistryError(409, "Only a revoked device can be restored.")
    attrs = {"type": doc.get("type", "device"), "site": doc.get("site", "site1")}
    if doc.get("profile"):
        attrs["profile"] = doc["profile"]
    registry.eg_upsert_client(device_id, attrs, enabled=True)
    doc["state"] = doc.pop("stateBeforeRevoke", "registered") or "registered"
    registry.save(doc)
    registry.event(device_id, "restored")
    emit("device.restored", deviceId=device_id)
    return doc


@app.delete("/internal/devices/{device_id}")
def internal_delete(device_id: str, x_iot_internal: str | None = Header(default=None)):
    _internal(x_iot_internal)
    registry.eg_delete_client(device_id)
    doc = registry.get(device_id)
    if doc:
        doc["state"] = "deleted"
        doc["deletedAt"] = iso()
        registry.save(doc)
    registry.event(device_id, "deleted")
    emit("device.deleted", deviceId=device_id)
    return {"deleted": device_id}


@app.get("/internal/events")
def internal_events(deviceId: str | None = None, limit: int = 50, x_iot_internal: str | None = Header(default=None)):
    _internal(x_iot_internal)
    return registry.recent_events(deviceId, min(max(limit, 1), 200))


def _ca_info(cert: x509.Certificate, key_name: str | None):
    return {"subject": cert.subject.rfc4514_string(), "notAfter": iso(cert.not_valid_after_utc),
            "daysLeft": round((cert.not_valid_after_utc - utcnow()).total_seconds() / 86400),
            "sha256": cert.fingerprint(hashes.SHA256()).hex(), "keyVaultKey": key_name}


@app.get("/internal/ca")
def internal_ca(x_iot_internal: str | None = Header(default=None)):
    _internal(x_iot_internal)
    return {"root": _ca_info(root_cert, "iot-root-ca (disabled - offline root)"),
            "deviceCa": _ca_info(device_ca.certificate, "iot-device-ca"),
            "serverCa": _ca_info(server_ca.certificate, "iot-server-ca"),
            "deviceCertMinutes": cfg.device_cert_minutes, "serverCertDays": cfg.server_cert_days,
            "serverRenewDaysLeft": cfg.server_renew_days_left, "reenrollGraceHours": cfg.reenroll_grace_hours}


@app.get("/internal/trust-bundle", response_class=PlainTextResponse)
def internal_bundle(x_iot_internal: str | None = Header(default=None)):
    _internal(x_iot_internal)
    return TRUST_BUNDLE


@app.get("/internal/server-cert")
def internal_server(x_iot_internal: str | None = Header(default=None)):
    _internal(x_iot_internal)
    return scheduler.server_status(refresh=True)


@app.post("/internal/server-cert/rotate")
def internal_rotate(x_iot_internal: str | None = Header(default=None)):
    _internal(x_iot_internal)
    return scheduler.rotate_server("manual")


def main():
    threading.Thread(target=renewals.run, name="mqtt", daemon=True).start()
    threading.Thread(target=scheduler.run, name="scheduler", daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=cfg.http_port, proxy_headers=True, forwarded_allow_ips="127.0.0.1",
                log_level="warning")


if __name__ == "__main__":
    main()
