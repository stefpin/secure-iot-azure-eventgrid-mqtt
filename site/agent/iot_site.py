#!/usr/bin/env python3
"""Contoso mine-site agent (gateway gw-site1) - runs the simulated machines on vm-site1.

It is itself an MQTT client with its own short-lived certificate (client group cg-gateways)
and answers simulator-control requests from the operator app:
    iot/site/{site}/sim/req  ->  iot/site/{site}/sim/res     (MQTT 5 request/response)
        {"action": "start", "deviceId", "profile", "token"?}   start (and on first start, enrol) a machine
        {"action": "stop",  "deviceId"}                         clean stop (retained status: offline)
        {"action": "purge", "deviceId"}                         stop and delete its key/certificate
        {"action": "list"}                                      running machines + certificate state
        {"action": "logs",  "deviceId", "lines"?}               last log lines of one machine
The desired set of running machines is persisted, so a VM restart resumes the simulation.
"""
from __future__ import annotations

import collections
import json
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from iot_identity import EnrollmentError, Identity  # noqa: E402
from iot_mqtt import AGENT, Session, now_iso, renew_over_mqtt  # noqa: E402

SITE = os.environ.get("IOT_SITE", "site1")
NAME = os.environ.get("IOT_GATEWAY_ID", f"gw-{SITE}")
STATE = pathlib.Path(os.environ.get("IOT_STATE_ROOT", "/var/lib/iot"))
TRUST = os.environ.get("IOT_TRUST_BUNDLE", "/etc/iot/trust-bundle.pem")
ENROLL = os.environ.get("IOT_ENROLL_URL", "https://enroll.iot.example.com/v1")
MQTT_HOST = os.environ.get("IOT_MQTT_HOST", "mqtt.iot.example.com")
TOKEN_FILE = pathlib.Path(os.environ.get("IOT_GATEWAY_TOKEN_FILE", "/etc/iot/gateway.token"))
PY = sys.executable
HERE = os.path.dirname(os.path.abspath(__file__))
DESIRED = STATE / "desired.json"


def log(msg):
    print(f"{now_iso()} [site] {msg}", flush=True)


class Fleet:
    """Child processes, one per simulated machine."""

    def __init__(self):
        self.procs = {}
        self.meta = {}
        self.logs = collections.defaultdict(lambda: collections.deque(maxlen=200))
        self.lock = threading.Lock()
        self.desired = json.loads(DESIRED.read_text()) if DESIRED.exists() else {}

    def _save(self):
        DESIRED.write_text(json.dumps(self.desired, indent=1))

    def _pump(self, device_id, proc):
        for line in proc.stdout:
            self.logs[device_id].append(line.rstrip())
        proc.wait()

    def start(self, device_id: str, profile: str, token: str | None = None) -> dict:
        with self.lock:
            p = self.procs.get(device_id)
            if p and p.poll() is None:
                return {"deviceId": device_id, "running": True, "pid": p.pid, "alreadyRunning": True}
            cmd = [PY, os.path.join(HERE, "iot_device.py"), "--id", device_id, "--profile", profile, "--site", SITE,
                   "--state-dir", str(STATE / "devices" / device_id), "--trust", TRUST,
                   "--enroll-url", ENROLL, "--mqtt-host", MQTT_HOST]
            env = dict(os.environ)
            if token:
                env["IOT_ENROLL_TOKEN"] = token  # environment, not argv: not visible in the process list
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
            self.procs[device_id] = proc
            self.meta[device_id] = {"profile": profile, "startedAt": now_iso()}
            threading.Thread(target=self._pump, args=(device_id, proc), daemon=True).start()
            self.desired[device_id] = {"profile": profile}
            self._save()
            return {"deviceId": device_id, "running": True, "pid": proc.pid}

    def stop(self, device_id: str, forget: bool = True) -> dict:
        with self.lock:
            p = self.procs.pop(device_id, None)
            if forget:
                self.desired.pop(device_id, None)
                self._save()
        if p and p.poll() is None:
            p.send_signal(signal.SIGTERM)
            try:
                p.wait(10)
            except subprocess.TimeoutExpired:
                p.kill()
            return {"deviceId": device_id, "running": False, "wasRunning": True}
        return {"deviceId": device_id, "running": False, "wasRunning": False}

    def purge(self, device_id: str) -> dict:
        r = self.stop(device_id)
        shutil.rmtree(STATE / "devices" / device_id, ignore_errors=True)
        self.logs.pop(device_id, None)
        r["purged"] = True
        return r

    def list(self) -> list[dict]:
        out = []
        for device_id in sorted(set(self.procs) | set(self.desired)):
            p = self.procs.get(device_id)
            ident = Identity(device_id, str(STATE / "devices" / device_id), ENROLL, log=lambda *_: None)
            meta = ident.meta()
            out.append({"deviceId": device_id, "running": bool(p and p.poll() is None), "pid": p.pid if p else None,
                        "profile": (self.meta.get(device_id) or self.desired.get(device_id) or {}).get("profile"),
                        "startedAt": (self.meta.get(device_id) or {}).get("startedAt"),
                        "certificate": ident.summary(), "counts": meta.get("counts", {}),
                        "lastLine": self.logs[device_id][-1] if self.logs[device_id] else None})
        return out

    def resume(self):
        for device_id, d in list(self.desired.items()):
            self.start(device_id, d.get("profile", "raspberry-pi"))
            log(f"resumed {device_id}")

    def supervise(self):
        """Restart machines that crashed (desired but not running)."""
        while True:
            time.sleep(15)
            for device_id, d in list(self.desired.items()):
                p = self.procs.get(device_id)
                if p is not None and p.poll() is not None:
                    log(f"{device_id} exited ({p.returncode}) - restarting")
                    self.start(device_id, d.get("profile", "raspberry-pi"))


class SiteAgent:
    def __init__(self):
        STATE.mkdir(parents=True, exist_ok=True)
        self.fleet = Fleet()
        self.ident = Identity(NAME, str(STATE / "gateway"), ENROLL, TRUST, log=log)
        self.session = None
        self.reconnect = threading.Event()
        self.stopping = threading.Event()
        self.req_topic = f"iot/site/{SITE}/sim/req"

    def on_message(self, msg):
        if msg.topic != self.req_topic:
            return
        try:
            req = json.loads(msg.payload or b"{}")
        except ValueError:
            return self.session.respond(msg, 400, {"error": "invalid JSON"})
        action = req.get("action")
        device_id = str(req.get("deviceId", ""))
        try:
            if action == "start":
                body = self.fleet.start(device_id, req.get("profile", "raspberry-pi"), req.get("token"))
            elif action == "stop":
                body = self.fleet.stop(device_id)
            elif action == "purge":
                body = self.fleet.purge(device_id)
            elif action == "list":
                body = {"site": SITE, "gateway": NAME, "devices": self.fleet.list()}
            elif action == "logs":
                n = int(min(max(req.get("lines", 40), 1), 200))
                body = {"deviceId": device_id, "lines": list(self.fleet.logs[device_id])[-n:]}
            else:
                return self.session.respond(msg, 400, {"error": f"unknown action {action}"})
            log(f"{action} {device_id} -> ok")
            self.session.respond(msg, 200, body)
            if action in ("start", "stop", "purge"):
                self.publish_state()
        except Exception as exc:
            log(f"{action} {device_id} failed: {exc}")
            self.session.respond(msg, 500, {"error": str(exc)})

    def publish_state(self):
        if self.session and self.session.connected.is_set():
            running = [d["deviceId"] for d in self.fleet.list() if d["running"]]
            self.session.publish(f"iot/state/{SITE}/{NAME}", {"gateway": NAME, "site": SITE, "agent": AGENT,
                                 "running": running, "certificate": self.ident.summary(), "updatedAt": now_iso()},
                                 retain=True)

    def run(self):
        self.fleet.resume()
        threading.Thread(target=self.fleet.supervise, daemon=True).start()
        backoff = 5
        while not self.stopping.is_set():
            token = TOKEN_FILE.read_text().strip() if TOKEN_FILE.exists() else None
            try:
                how = self.ident.ensure(token)
                if how != "existing":
                    log(f"gateway certificate ready ({how})")
            except EnrollmentError as exc:
                log(f"gateway cannot obtain a certificate: {exc}")
                self.stopping.wait(min(backoff, 120))
                backoff = min(backoff * 2, 300)
                continue
            self.reconnect.clear()
            will = {"online": False, "reason": "connection lost (Last Will)", "gateway": NAME, "site": SITE}
            self.session = Session(self.ident, MQTT_HOST, SITE, on_message=self.on_message, will=will, log=log)
            if not self.session.open():
                log(f"gateway connect failed: {self.session.refused}")
                self.stopping.wait(min(backoff, 120))
                backoff = min(backoff * 2, 300)
                continue
            backoff = 5
            log(f"gateway {NAME} connected (certificate valid to {self.ident.summary()['notAfter']})")
            if self.session.subscribe(self.req_topic, "iot/config/fleet", f"iot/cert/{SITE}/{NAME}/res") is None:
                self.session.close()
                self.stopping.wait(5)
                continue
            self.session.publish(self.session.status_topic, {"online": True, "gateway": NAME, "site": SITE,
                                                             "since": now_iso()}, retain=True)
            self.publish_state()
            next_try, next_state = 0.0, time.time() + 60
            while not self.stopping.is_set() and not self.reconnect.is_set() and self.session.connected.is_set():
                now = time.time()
                if self.ident.renew_due(2 / 3) and now >= next_try:
                    try:
                        meta = renew_over_mqtt(self.session, SITE)
                        log(f"gateway certificate renewed over MQTT (valid to {meta['notAfter']})")
                        self.reconnect.set()
                    except Exception as exc:
                        log(f"gateway renewal failed: {exc}")
                        next_try = now + 60
                if now >= next_state:
                    self.publish_state()
                    next_state = now + 60
                self.stopping.wait(1)
            self.session.close(status={"online": False, "reason": "stopped", "gateway": NAME}
                               if self.stopping.is_set() else None)

    def shutdown(self, *_):
        self.stopping.set()
        for device_id in list(self.fleet.procs):
            self.fleet.stop(device_id, forget=False)


if __name__ == "__main__":
    agent = SiteAgent()
    signal.signal(signal.SIGTERM, agent.shutdown)
    signal.signal(signal.SIGINT, agent.shutdown)
    log(f"site agent {NAME} starting (site {SITE}, broker {MQTT_HOST})")
    agent.run()
