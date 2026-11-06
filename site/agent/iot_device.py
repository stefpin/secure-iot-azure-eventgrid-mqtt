#!/usr/bin/env python3
"""Contoso simulated machine - Event Grid MQTT broker edition (MQTT 5, X.509 certificates).

    python iot_device.py --id PUMP-07 --profile raspberry-pi --site site1 \
        --state-dir /var/lib/iot/devices/PUMP-07 --trust trust-bundle.pem --token <one-time token>

First start: generates its own key, enrols over private HTTPS with the one-time token.
Then: connects with mutual TLS, publishes telemetry, keeps a RETAINED status (with a Last
Will) and state, executes commands (MQTT 5 request/response) and renews its certificate
over MQTT at 2/3 of its lifetime. If it was offline long enough for the certificate to
expire, it re-enrols with proof of the previous key (no new token needed within 24 h).
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from iot_identity import EnrollmentError, Identity  # noqa: E402
from iot_model import Machine  # noqa: E402
from iot_mqtt import AGENT, Session, now_iso, renew_over_mqtt  # noqa: E402

FIRMWARE = "1.4.0"


def _ts(iso: str) -> float:
    import datetime as _dt
    return _dt.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def log(msg: str):
    print(f"{now_iso()} {msg}", flush=True)


class DeviceAgent:
    def __init__(self, args):
        self.args = args
        self.site = args.site
        self.ident = Identity(args.id, args.state_dir, args.enroll_url, args.trust, log=log)
        self.machine = Machine(args.profile)
        self.interval = float(args.interval)
        self.renew_fraction = 2 / 3
        self.config_version = None
        self.stop = threading.Event()
        self.reconnect = threading.Event()
        self.force_renew = threading.Event()
        self.offline_for = 0
        self.session = None
        self.sent = 0
        self.connected_at = None
        base = f"iot/{{}}/{self.site}/{args.id}"
        self.t_tel, self.t_state, self.t_status = base.format("telemetry"), base.format("state"), base.format("status")
        self.t_cmd = f"iot/cmd/{self.site}/{args.id}"
        self.t_cmdres = f"iot/cmdres/{self.site}/{args.id}"

    # --------------------------------------------------------------- status
    def _will(self):
        return {"online": False, "reason": "connection lost (Last Will)", "deviceId": self.args.id,
                "profile": self.machine.profile, "connectedAt": now_iso()}

    def _publish_state(self):
        self.session.publish(self.t_state, {
            "deviceId": self.args.id, "profile": self.machine.profile, "firmware": FIRMWARE, "agent": AGENT,
            "targetRpm": self.machine.setpoint, "telemetryIntervalSeconds": self.interval,
            "configVersion": self.config_version, "certificate": self.ident.summary(),
            "connectedAt": self.connected_at, "updatedAt": now_iso()}, retain=True)

    def _publish_online(self):
        self.session.publish(self.t_status, {
            "online": True, "deviceId": self.args.id, "profile": self.machine.profile, "since": self.connected_at,
            "certificate": self.ident.summary()}, retain=True)

    # ------------------------------------------------------------- messages
    def on_message(self, msg):
        topic = msg.topic
        if topic == "iot/config/fleet":
            self._apply_config(msg)
        elif topic.startswith(self.t_cmd + "/"):
            self._command(msg, topic[len(self.t_cmd) + 1:])

    def _apply_config(self, msg):
        if not msg.payload:
            return
        try:
            cfg = json.loads(msg.payload)
        except ValueError:
            return
        self.interval = float(min(max(cfg.get("telemetryIntervalSeconds", self.interval), 1), 300))
        self.renew_fraction = float(min(max(cfg.get("renewAtFraction", self.renew_fraction), 0.3), 0.9))
        self.config_version = cfg.get("version")
        log(f"fleet config v{self.config_version}: interval {self.interval}s, renew at {self.renew_fraction:.0%}"
            f"{' (retained)' if msg.retain else ''}")
        self._publish_state()

    def _command(self, msg, method):
        try:
            payload = json.loads(msg.payload or b"{}")
        except ValueError:
            payload = {}
        if getattr(msg.properties, "ResponseTopic", None) not in (None, self.t_cmdres):
            log(f"command {method} asked for response topic {msg.properties.ResponseTopic} - refused")
            return
        m = self.machine
        if method == "setMotorSpeed":
            status, body = m.set_motor_speed(payload, self.interval)
        elif method == "setBuzzer":
            status, body = m.set_buzzer(payload)
        elif method == "clearBuzzerOverride":
            status, body = m.clear_buzzer_override()
        elif method == "renewCertificate":
            self.force_renew.set()
            status, body = 202, {"accepted": True, "detail": "renewal requested over MQTT"}
        elif method == "powerLoss":
            self.offline_for = int(min(max(payload.get("seconds", 20), 5), 600))
            status, body = 200, {"accepted": True, "offlineSeconds": self.offline_for,
                                 "detail": "dropping the connection without a clean disconnect"}
        elif method == "reboot":
            self.offline_for = 5
            status, body = 200, {"rebooting": True}
        else:
            status, body = 404, {"error": f"Unknown method '{method}'."}
        log(f"<- command {method} {payload} -> {status}")
        self.session.respond(msg, status, body)
        if method == "setMotorSpeed" and status == 200:
            self._publish_state()
        if self.offline_for:
            self.reconnect.set()

    # ----------------------------------------------------------------- loop
    def _renew(self):
        before = self.ident.summary()["serial"]
        meta = renew_over_mqtt(self.session, self.site)
        log(f"certificate renewed over MQTT: {before[:12]}... -> {meta['serial'][:12]}... (valid to {meta['notAfter']})")
        self.reconnect.set()  # reconnect so the new certificate is used from now on

    def run(self):
        backoff = 5
        while not self.stop.is_set():
            try:
                how = self.ident.ensure(self.args.token)
                if how != "existing":
                    log(f"certificate ready ({how}): {self.ident.summary()}")
            except EnrollmentError as exc:
                log(f"cannot obtain a certificate: {exc}")
                self.stop.wait(min(backoff, 60))
                backoff = min(backoff * 2, 300)
                continue
            self.reconnect.clear()
            self.connected_at = now_iso()
            self.session = Session(self.ident, self.args.mqtt_host, self.site, on_message=self.on_message,
                                   will=self._will(), log=log)
            if not self.session.open():
                log(f"connect failed: {self.session.refused}")
                # A just-registered client can be refused for a few seconds while the new Event Grid
                # client record propagates: retry every 10 s for the first 3 minutes after enrolment.
                fresh = self.ident.meta().get("lastIssuedAt")
                age = (time.time() - _ts(fresh)) if fresh else 1e9
                self.stop.wait(10 if age < 180 else min(backoff, 60))
                backoff = min(backoff * 2, 300)
                continue
            backoff = 5
            log(f"connected to {self.args.mqtt_host} as {self.args.id} ({self.machine.profile}), "
                f"certificate {self.ident.summary()['serial'][:12]}... valid to {self.ident.summary()['notAfter']}")
            if self.session.subscribe(f"{self.t_cmd}/#", f"iot/cert/{self.site}/{self.args.id}/res", "iot/config/fleet") is None:
                self.session.close()
                self.stop.wait(5)
                continue
            self._publish_online()
            self._publish_state()
            next_tel = 0.0
            next_renew_try = 0.0
            while not self.stop.is_set() and not self.reconnect.is_set() and self.session.connected.is_set():
                now = time.time()
                if now >= next_tel:
                    reading = self.machine.step(self.interval)
                    self.sent += 1
                    self.session.publish(self.t_tel, {"deviceId": self.args.id, "site": self.site, "seq": self.sent, **reading})
                    next_tel = now + self.interval
                if (self.force_renew.is_set() or self.ident.renew_due(self.renew_fraction)) and now >= next_renew_try:
                    self.force_renew.clear()
                    try:
                        self._renew()
                    except Exception as exc:
                        log(f"renewal failed, retrying in 60 s: {exc}")
                        next_renew_try = now + 60
                self.stop.wait(0.2)
            if self.stop.is_set():
                self.session.close(status={"online": False, "reason": "stopped", "deviceId": self.args.id,
                                           "profile": self.machine.profile, "at": now_iso()})
                log("stopped cleanly (status: offline, retained)")
            elif self.offline_for:
                secs, self.offline_for = self.offline_for, 0
                time.sleep(1.0)  # let the command response (QoS 1) reach the broker first
                self.session.close(with_will=True)
                log(f"simulated power loss - broker publishes the Last Will; back in {secs}s")
                self.stop.wait(secs)
            elif self.reconnect.is_set():
                self.session.close()
            else:
                log(f"connection lost - reconnecting in {backoff}s")
                self.session.close()
                self.stop.wait(backoff)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--id", default=os.environ.get("IOT_DEVICE_ID"), required=not os.environ.get("IOT_DEVICE_ID"))
    p.add_argument("--profile", default=os.environ.get("IOT_PROFILE", "raspberry-pi"), choices=["raspberry-pi", "esp32"])
    p.add_argument("--site", default=os.environ.get("IOT_SITE", "site1"))
    p.add_argument("--state-dir", default=os.environ.get("IOT_STATE_DIR"))
    p.add_argument("--token", default=os.environ.get("IOT_ENROLL_TOKEN"))
    p.add_argument("--trust", default=os.environ.get("IOT_TRUST_BUNDLE"))
    p.add_argument("--enroll-url", default=os.environ.get("IOT_ENROLL_URL", "https://enroll.iot.example.com/v1"))
    p.add_argument("--mqtt-host", default=os.environ.get("IOT_MQTT_HOST", "mqtt.iot.example.com"))
    p.add_argument("--interval", default=os.environ.get("IOT_INTERVAL", "5"))
    args = p.parse_args()
    args.state_dir = args.state_dir or os.path.join(os.path.expanduser("~"), ".iot", args.id)
    agent = DeviceAgent(args)
    signal.signal(signal.SIGTERM, lambda *_: agent.stop.set())
    signal.signal(signal.SIGINT, lambda *_: agent.stop.set())
    log(f"Contoso device {args.id} ({args.profile}) starting - state in {args.state_dir}")
    agent.run()


if __name__ == "__main__":
    main()
