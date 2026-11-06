"""MQTT 5 session for a certificate-authenticated client (device or site gateway).

* mutual TLS to mqtt.iot.example.com:8883 with the CURRENT certificate - a new
  paho client is created for every connection, so a renewed certificate is always used
* client ID = user name = certificate CN = Event Grid authentication name
* clean start, no session expiry: a device that is offline must not receive stale
  commands when it comes back (commands also carry a message expiry)
* Last Will (retained) on iot/status/{site}/{id}: the broker announces "offline" if the
  connection drops without a clean DISCONNECT
* request/response helper (response topic + correlation data) - used for renewals
"""
from __future__ import annotations

import json
import queue
import ssl
import threading
import time
import uuid

import paho.mqtt.client as mqtt
from paho.mqtt.packettypes import PacketTypes
from paho.mqtt.properties import Properties
from paho.mqtt.reasoncodes import ReasonCode

AGENT = "iot-agent/1.0"


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def props_json(**extra) -> Properties:
    p = Properties(PacketTypes.PUBLISH)
    p.ContentType = "application/json"
    p.PayloadFormatIndicator = 1  # UTF-8 JSON -> Event Grid routing can filter on data.* fields
    for k, v in extra.items():
        setattr(p, k, v)
    return p


class Session:
    def __init__(self, ident, host: str, site: str, on_message=None, will: dict | None = None, log=print):
        self.ident = ident
        self.host = host
        self.site = site
        self.on_message_cb = on_message
        self.will = will
        self.log = log
        self.client = None
        self.connected = threading.Event()
        self.refused = None
        self.pending = {}  # correlation -> queue
        self.lock = threading.Lock()
        self.subacks = {}  # SUBSCRIBE packet id -> reason codes from the broker's SUBACK
        self.sub_cond = threading.Condition()

    @property
    def status_topic(self) -> str:
        return f"iot/status/{self.site}/{self.ident.name}"

    def open(self, timeout: float = 20) -> bool:
        self.connected.clear()
        self.refused = None
        c = mqtt.Client(callback_api_version=mqtt.CallbackAPIVersion.VERSION2, client_id=self.ident.name,
                        protocol=mqtt.MQTTv5, reconnect_on_failure=False)
        c.username_pw_set(self.ident.name)
        ctx = ssl.create_default_context(cafile=str(self.ident.trust_path))
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(certfile=str(self.ident.crt_path), keyfile=str(self.ident.key_path))
        c.tls_set_context(ctx)
        if self.will:
            wp = props_json()
            c.will_set(self.status_topic, json.dumps(self.will), qos=1, retain=True, properties=wp)
        c.on_connect = self._on_connect
        c.on_disconnect = self._on_disconnect
        c.on_message = self._on_message
        c.on_subscribe = self._on_subscribe
        self.client = c
        cp = Properties(PacketTypes.CONNECT)
        cp.SessionExpiryInterval = 0
        try:
            c.connect(self.host, 8883, keepalive=30, clean_start=True, properties=cp)
        except (OSError, ssl.SSLError) as exc:
            self.refused = f"TLS/TCP: {exc}"
            return False
        c.loop_start()
        self.connected.wait(timeout)
        if not self.connected.is_set():
            c.loop_stop()
            if not self.refused:
                self.refused = "no CONNACK within timeout"
            return False
        return True

    def _on_connect(self, client, userdata, flags, rc, props):
        if rc.is_failure:
            self.refused = f"CONNACK {rc}"
            return
        self.connected.set()

    def _on_disconnect(self, client, userdata, flags, rc, props):
        if self.connected.is_set():
            self.log(f"disconnected: {rc}")
        self.connected.clear()

    def _on_message(self, client, userdata, msg):
        corr = getattr(msg.properties, "CorrelationData", None) if msg.properties else None
        if corr is not None:
            with self.lock:
                q = self.pending.get(bytes(corr))
            if q is not None:
                q.put(msg)
                return
        if self.on_message_cb:
            try:
                self.on_message_cb(msg)
            except Exception as exc:  # never kill the network thread
                self.log(f"message handler error on {msg.topic}: {exc}")

    def _on_subscribe(self, client, userdata, mid, reason_codes, props):
        with self.sub_cond:
            self.subacks[mid] = reason_codes
            self.sub_cond.notify_all()

    def subscribe(self, *topics, qos=1, timeout: float = 15):
        """Subscribe and wait for the broker's SUBACK.

        A client says it is online only after this returns, so a command sent the moment it shows as
        Connected is not lost to a subscription the broker has not finished setting up.
        Returns the refused topics (empty list = all accepted), or None if no SUBACK arrived in time.
        """
        result, mid = self.client.subscribe([(t, qos) for t in topics])
        if result != mqtt.MQTT_ERR_SUCCESS:
            self.log(f"SUBSCRIBE not sent ({result}) for {', '.join(topics)}")
            return None
        with self.sub_cond:
            if not self.sub_cond.wait_for(lambda: mid in self.subacks, timeout):
                self.log(f"no SUBACK within {timeout:.0f} s for {', '.join(topics)}")
                return None
            codes = self.subacks.pop(mid)
        refused = [f"{t} ({rc})" for t, rc in zip(topics, codes) if rc.is_failure]
        if refused:
            self.log(f"subscription refused by the broker: {'; '.join(refused)}")
        return refused

    def publish(self, topic: str, payload, qos=1, retain=False, props: Properties | None = None):
        data = payload if isinstance(payload, (bytes, str)) else json.dumps(payload)
        return self.client.publish(topic, data, qos=qos, retain=retain, properties=props or props_json())

    def respond(self, msg, status: int, body: dict):
        rt = getattr(msg.properties, "ResponseTopic", None) if msg.properties else None
        if not rt:
            return
        extra = {"UserProperty": [("status", str(status))]}
        corr = getattr(msg.properties, "CorrelationData", None)
        if corr is not None:
            extra["CorrelationData"] = corr
        self.publish(rt, body, qos=1, props=props_json(**extra))

    def request(self, topic: str, body: dict, response_topic: str, timeout: float = 30):
        corr = uuid.uuid4().bytes
        q = queue.Queue()
        with self.lock:
            self.pending[corr] = q
        try:
            self.publish(topic, body, qos=1, props=props_json(ResponseTopic=response_topic, CorrelationData=corr))
            msg = q.get(timeout=timeout)
        finally:
            with self.lock:
                self.pending.pop(corr, None)
        status = 200
        for k, v in (getattr(msg.properties, "UserProperty", None) or []):
            if k == "status":
                status = int(v)
        return status, json.loads(msg.payload or b"{}")

    def close(self, status: dict | None = None, with_will: bool = False):
        """Clean close. status -> published (retained) first; with_will -> broker publishes the Last Will."""
        if not self.client:
            return
        try:
            if status is not None and self.connected.is_set():
                self.publish(self.status_topic, status, qos=1, retain=True).wait_for_publish(5)
            if with_will:
                # MQTT 5 reason code 0x04 "Disconnect with Will Message": the broker still publishes the will.
                self.client.disconnect(reasoncode=ReasonCode(PacketTypes.DISCONNECT, identifier=4))
            else:
                self.client.disconnect()
        except Exception:
            pass
        time.sleep(0.5)
        self.client.loop_stop()
        self.connected.clear()


def renew_over_mqtt(session: Session, site: str, timeout: float = 45) -> dict:
    """Ask the certificate service for a new certificate; returns the response body (raises on refusal)."""
    ident = session.ident
    csr = ident.new_csr()
    base = f"iot/cert/{site}/{ident.name}"
    status, body = session.request(f"{base}/req", {"csr": csr, "agent": AGENT}, f"{base}/res", timeout=timeout)
    if status != 200:
        ident.pending_key = None
        raise RuntimeError(f"renewal refused ({status}): {body.get('error')}")
    return ident.install(body, "renew")
