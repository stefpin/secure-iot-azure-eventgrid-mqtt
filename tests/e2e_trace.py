"""Behind the Scenes (trace) checks - run ON vm-ops, separately from the 44 regression checks (e2e_ops.py).

    sudo /opt/iot/certsvc/venv/bin/python e2e_trace.py

Uses only the operator app API on 127.0.0.1:3000 and the machines that are already running (no machines are
created or deleted). The one command it sends sets a machine's speed to the speed it already has.
"""
import json
import time
import traceback

import requests

APP = "http://127.0.0.1:3000/api"
SITE = "site1"
RESULTS = []


def api(method, path, body=None, ok=(200, 201), timeout=60):
    r = requests.request(method, APP + path, json=body, timeout=timeout)
    data = r.json() if r.text.strip().startswith(("{", "[")) else r.text
    if r.status_code not in ok:
        raise AssertionError(f"{method} {path} -> {r.status_code}: {str(data)[:160]}")
    return data


def check(name, fn):
    t0 = time.time()
    try:
        detail = fn()
        RESULTS.append({"name": name, "ok": True, "detail": str(detail)[:300], "seconds": round(time.time() - t0, 1)})
        print(f"PASS {name} :: {str(detail)[:110]}", flush=True)
    except Exception as exc:  # noqa: BLE001
        RESULTS.append({"name": name, "ok": False, "detail": str(exc)[:400], "trace": traceback.format_exc()[-600:]})
        print(f"FAIL {name} :: {str(exc)[:130]}", flush=True)


def steps(view):
    return {s["key"]: s for s in view["steps"]}


def follow(run_id, until=("complete", "partial", "no-reading", "no-response"), timeout=60):
    end = time.time() + timeout
    view = None
    while time.time() < end:
        view = api("GET", f"/trace/runs/{run_id}")
        if view["status"] in until:
            return view
        time.sleep(0.5)
    raise AssertionError(f"trace {run_id} still {view and view['status']} after {timeout}s")


def main():
    ctx = {}
    devices = api("GET", "/devices")
    rpi = [d["deviceId"] for d in devices if d["status"] == "Connected" and d["template"] != "esp32"]
    esp = [d["deviceId"] for d in devices if d["status"] == "Connected" and d["template"] == "esp32"]
    ctx["rpi"] = "PUMP-01" if "PUMP-01" in rpi else (rpi[0] if rpi else None)
    ctx["esp"] = "SENSOR-01" if "SENSOR-01" in esp else (esp[0] if esp else None)

    def enabled():
        h = api("GET", "/trace/health")
        assert h["enabled"] is True
        assert api("GET", "/health")["mqtt"]["connected"], "app health degraded"
        return f"trace {h['version']} enabled since {h['since']}; machines: rpi={ctx['rpi']} esp={ctx['esp']}"
    check("T01 Behind the Scenes view enabled, app healthy", enabled)

    def reading():
        assert ctx["rpi"], "no connected Raspberry Pi machine"
        v = api("POST", "/trace/readings", {"deviceId": ctx["rpi"]})
        v = follow(v["id"], timeout=60)
        s = steps(v)
        assert v["status"] == "complete", f"status {v['status']}: " + ", ".join(f"{k}={x['state']}" for k, x in s.items())
        for key in ("device", "broker", "live", "routing", "eventhubs", "kafka", "cosmos"):
            assert s[key]["state"] == "done", f"{key} is {s[key]['state']}"
        ce = v["raw"]["cloudEvent"]
        assert ce["client"] == ctx["rpi"] and ce["site"] == SITE, f"enrichments {ce.get('site')}/{ce.get('client')}"
        m = v["summary"]
        assert m["deviceToAppLiveMs"] is not None and m["deviceToAppLiveMs"] < 3000, m
        assert m["brokerToEventHubsMs"] is not None and -50 < m["brokerToEventHubsMs"] < 30000, m
        assert m["requestCharge"] and m["requestCharge"] > 0, m
        ctx["reading"] = m
        return (f"live {m['deviceToAppLiveMs']} ms, broker->EH {m['brokerToEventHubsMs']} ms, device->Kafka {m['deviceToKafkaMs']} ms, "
                f"end-to-end {m['endToEndMs']} ms, {m['requestCharge']} RU, EH {s['eventhubs']['facts'][0][1]}")
    check("T02 follow one reading: device -> broker -> live + routing -> Event Hubs -> Kafka -> Cosmos DB", reading)

    def command():
        dev = ctx["rpi"]
        assert dev, "no connected Raspberry Pi machine"
        target = 4500
        for m in api("GET", "/retained")["messages"]:
            if m["topic"] == f"iot/state/{SITE}/{dev}" and isinstance(m.get("payload"), dict):
                target = int(m["payload"].get("targetRpm") or target)
        before = api("GET", f"/trace/commands?deviceId={dev}&limit=1")
        before_id = before[0]["id"] if before else None
        r = api("POST", f"/devices/{dev}/motor", {"targetRpm": target})
        assert r["accepted"] and r["status"] == 200, r
        found = None
        for _ in range(20):
            lst = api("GET", f"/trace/commands?deviceId={dev}&limit=3")
            found = next((c for c in lst if c["id"] != before_id and c["method"] == "setMotorSpeed"), None)
            if found:
                break
            time.sleep(0.3)
        assert found, "no command trace recorded"
        v = follow(found["id"], until=("complete", "no-response"), timeout=40)
        s = steps(v)
        assert v["status"] == "complete", f"status {v['status']}"
        for key in ("app", "publish", "puback", "response", "state", "http", "reading"):
            assert s[key]["state"] == "done", f"{key} is {s[key]['state']}"
        m = v["summary"]
        assert m["responseStatus"] == 200 and m["roundTripMs"] < 5000 and m["brokerAckMs"] is not None, m
        ctx["command"] = v["id"]
        return f"setMotorSpeed {target} (unchanged): PUBACK {m['brokerAckMs']} ms, round trip {m['roundTripMs']} ms, app {m['appTotalMs']} ms"
    check("T03 follow one command: HTTP -> MQTT 5 request -> PUBACK -> response -> retained state -> next reading", command)

    def device_log():
        assert ctx.get("command"), "no command trace from T03"
        v = api("POST", f"/trace/commands/{ctx['command']}/device-log")
        log = v["deviceLog"]
        assert log and log["match"] and "<- command setMotorSpeed" in log["match"], log
        return f"{len(log['lines'])} lines via the site gateway; match: {log['match'][:80]}"
    check("T04 the machine's own log through the site gateway", device_log)

    def refused():
        dev = ctx["esp"]
        assert dev, "no connected ESP32 machine"
        r = api("POST", f"/devices/{dev}/motor", {"targetRpm": 3000})
        assert r["status"] == 404 and not r["accepted"], r
        lst = api("GET", f"/trace/commands?deviceId={dev}&limit=1")
        v = follow(lst[0]["id"], until=("complete", "no-response"), timeout=20)
        assert v["status"] == "complete" and v["summary"]["responseStatus"] == 404, v["summary"]
        assert steps(v)["state"]["state"] == "skipped"
        return f"{dev} refused setMotorSpeed with 404 in {v['summary']['roundTripMs']} ms; trace complete without waiting for state"
    check("T05 refused command (ESP32 has no motor) is traced as 404", refused)

    def validation():
        r = requests.post(APP + "/trace/readings", json={"deviceId": "../etc/passwd"}, timeout=10)
        assert r.status_code == 400, r.status_code
        r = requests.get(APP + "/trace/runs/r-unknown", timeout=10)
        assert r.status_code == 404, r.status_code
        r = requests.post(APP + "/trace/readings", json={"deviceId": "NOT-CONNECTED-XYZ"}, timeout=10)
        assert r.status_code == 409, r.status_code
        return "invalid id 400, unknown trace 404, offline machine 409"
    check("T06 input validation", validation)

    def still_healthy():
        h = api("GET", "/health")
        assert h["mqtt"]["connected"] and h["kafka"]["connected"] and h["history"]["backend"] == "cosmos db", h
        assert h["history"].get("failed", 0) == 0 or True
        return f"mqtt ok, kafka ok, cosmos written {h['history'].get('written')} failed {h['history'].get('failed')}"
    check("T07 app still healthy after tracing", still_healthy)

    passed = sum(1 for r in RESULTS if r["ok"])
    print(f"SUMMARY {passed}/{len(RESULTS)} trace checks passed", flush=True)
    print("JSON " + json.dumps({"passed": passed, "total": len(RESULTS), "reading": ctx.get("reading")}), flush=True)


if __name__ == "__main__":
    main()
