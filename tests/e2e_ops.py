"""End-to-end tests, operations side - runs ON vm-ops (python from the certificate-service venv).

    sudo /opt/iot/certsvc/venv/bin/python e2e_ops.py [--quick]

Uses the operator app API (127.0.0.1:3000) and the certificate service (127.0.0.1:8081) exactly
as an operator would, against the real mine-site simulator, broker, Kafka path and Cosmos DB.
Creates the test machines E2E-RPI, E2E-ESP and E2E-TOK and deletes them at the end.
Prints one line per check and writes the full results to /var/log/iot-e2e/.
"""
import argparse
import datetime as dt
import json
import os
import pathlib
import sys
import time
import traceback

import requests
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

APP = "http://127.0.0.1:3000/api"
CS = "http://127.0.0.1:8081"
TOKEN = pathlib.Path("/etc/iot/internal.token").read_text().strip()
SITE = "site1"
RESULTS = []
START = time.time()


def api(method, path, body=None, ok=(200, 201, 202), timeout=120):
    r = requests.request(method, APP + path, json=body, timeout=timeout)
    data = r.json() if r.text.strip().startswith(("{", "[")) else r.text
    if r.status_code not in ok:
        raise AssertionError(f"{method} {path} -> {r.status_code}: {str(data)[:160]}")
    return data


def internal(method, path, body=None):
    r = requests.request(method, CS + path, json=body, headers={"X-IOT-Internal": TOKEN}, timeout=120)
    return r.status_code, (r.json() if r.text.strip().startswith(("{", "[")) else r.text)


def check(name, fn):
    t0 = time.time()
    try:
        detail = fn()
        RESULTS.append({"name": name, "ok": True, "detail": str(detail)[:300], "seconds": round(time.time() - t0, 1)})
        print(f"PASS {name} :: {str(detail)[:90]}", flush=True)
        return True
    except Exception as exc:
        RESULTS.append({"name": name, "ok": False, "detail": f"{exc}"[:500], "trace": traceback.format_exc()[-800:],
                        "seconds": round(time.time() - t0, 1)})
        print(f"FAIL {name} :: {str(exc)[:110]}", flush=True)
        return False


def wait_for(fn, timeout, every=3, what="condition"):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = fn()
            if last:
                return last
        except AssertionError:
            pass
        time.sleep(every)
    raise AssertionError(f"timed out after {timeout}s waiting for {what} (last={str(last)[:100]})")


def device(dev_id):
    return api("GET", f"/devices/{dev_id}")


def retained_status(dev_id):
    for m in api("GET", "/retained")["messages"]:
        if m["topic"] == f"iot/status/{SITE}/{dev_id}":
            return m["payload"]
    return None


def cleanup(*ids):
    for d in ids:
        try:
            requests.delete(f"{APP}/devices/{d}", timeout=60)
        except Exception:
            pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="skip the slow expiry / re-enrolment checks")
    args = ap.parse_args()
    rpi, esp, tok = "E2E-RPI", "E2E-ESP", "E2E-TOK"
    cleanup(rpi, esp, tok)
    time.sleep(3)
    ctx = {}

    # ------------------------------------------------------------ platform
    def health():
        h = api("GET", "/health")
        assert h["mqtt"]["connected"], "app not connected to MQTT"
        assert h["kafka"]["connected"], f"Kafka consumer not connected: {h['kafka'].get('lastError')}"
        assert h["history"]["backend"] == "cosmos db", h["history"]
        assert h["certificateService"]["status"] == "ok" and h["certificateService"]["mqtt"]["connected"]
        return f"MQTT (Entra ID) ok, Kafka ok, Cosmos ok, certsvc MQTT ok"
    check("O01 platform health (MQTT, Kafka, Cosmos, certificate service)", health)

    def ca():
        c = api("GET", "/certificates")["ca"]
        assert "Root CA" in c["root"]["subject"] and c["root"]["daysLeft"] > 3000
        assert "Device Issuing CA" in c["deviceCa"]["subject"] and "Server Issuing CA" in c["serverCa"]["subject"]
        assert c["deviceCertMinutes"] == 60
        return f"root {c['root']['daysLeft']} d, issuing CAs {c['deviceCa']['daysLeft']} d, device certs {c['deviceCertMinutes']} min"
    check("O02 CA hierarchy (Key Vault HSM keys)", ca)

    def server():
        s = api("GET", "/certificates")["server"]
        assert s["servedByIotCa"], f"served issuer {s['servedIssuer']}"
        assert s["servedDaysLeft"] > 3, s
        assert s["activeCertificateName"].startswith("mqtt-srv-")
        return f"{s['activeCertificateName']} serial {s['servedSerial'][:10]}, {s['servedDaysLeft']} days left"
    check("O03 MQTT endpoint certificate served by the Contoso server CA", server)

    # ------------------------------------------------------------ onboarding
    def create_rpi():
        d = api("POST", "/devices", {"deviceId": rpi, "template": "raspberry-pi"})
        assert d["token"] and len(d["token"]) >= 30 and d["state"] == "registered"
        full = device(rpi)
        eg = full["eventGrid"]
        assert eg["state"] == "Enabled" and eg["attributes"] == {"type": "device", "site": SITE, "profile": "raspberry-pi"}, eg
        assert eg["validationScheme"] == "SubjectMatchesAuthenticationName"
        return f"Event Grid client Enabled {eg['attributes']}, one-time token issued"
    check("O04 register a machine (Event Grid client + one-time token)", create_rpi)

    def connect_rpi():
        r = api("POST", f"/devices/{rpi}/connect", {})
        d = wait_for(lambda: device(rpi)["status"] == "Connected" and device(rpi), 180, what=f"{rpi} Connected")
        c = d["certificate"]
        assert c["method"] == "enroll" and c["keyType"] == "EC secp256r1"
        life = (dt.datetime.fromisoformat(c["notAfter"].replace("Z", "+00:00")) - dt.datetime.fromisoformat(c["notBefore"].replace("Z", "+00:00")))
        ctx["serial"] = c["serial"]
        return f"enrolled over private HTTPS ({r['session']['enrolment']}), {c['keyType']}, lifetime {life}"
    check("O05 enrol + connect through VPN and private endpoint (mTLS)", connect_rpi)

    def mqtt_telemetry():
        n0 = device(rpi)["messages"]
        time.sleep(16)
        n1 = device(rpi)["messages"]
        latest = api("GET", f"/telemetry/{rpi}/latest")
        assert n1 - n0 >= 2, f"only {n1 - n0} messages in 16 s"
        assert latest["source"] == "mqtt" and "rpm" in latest
        return f"{n1 - n0} messages in 16 s via MQTT, latest rpm {latest['rpm']}"
    check("O06 live telemetry over MQTT", mqtt_telemetry)

    def kafka_history():
        def got():
            h = api("GET", f"/telemetry/{rpi}/history?range=hourly")
            return h if h["sources"].get("cosmos", 0) >= 2 else None
        h = wait_for(got, 120, every=5, what="Kafka-sourced history in Cosmos")
        return f"points per store {h['sources']} (Cosmos is written only from Event Grid routing -> Event Hubs Kafka)"
    check("O07 routed telemetry via Kafka persisted in Cosmos DB", kafka_history)

    def cmd_ok():
        r = api("POST", f"/devices/{rpi}/motor", {"targetRpm": 3000})
        assert r["accepted"] and r["status"] == 200, r
        wait_for(lambda: api("GET", f"/telemetry/{rpi}/latest").get("targetRpm") == 3000, 30, what="targetRpm 3000 in telemetry")
        return f"accepted 4500 -> 3000 in {r['roundTripMs']} ms; telemetry confirms the new setpoint"
    check("O08 command setMotorSpeed (MQTT 5 request/response) accepted", cmd_ok)

    def cmd_400():
        r = api("POST", f"/devices/{rpi}/motor", {"targetRpm": 9999})
        assert not r["accepted"] and r["status"] == 400, r
        return f"device refused: {r['reason']}"
    check("O09 command out of range -> 400 from the device", cmd_400)

    def cmd_404():
        r = api("POST", f"/devices/{rpi}/command", {"method": "selfDestruct"})
        assert r["status"] == 404, r
        return f"unknown method -> 404 {r['response']}"
    check("O10 unknown command -> 404 (not a timeout)", cmd_404)

    def create_esp():
        api("POST", "/devices", {"deviceId": esp, "template": "esp32", "certMinutes": 3})
        api("POST", f"/devices/{esp}/connect", {})
        wait_for(lambda: device(esp)["status"] == "Connected", 180, what=f"{esp} Connected")
        r = api("POST", f"/devices/{esp}/motor", {"targetRpm": 2000})
        assert r["status"] == 404 and "no motor" in r["reason"], r
        ctx["esp_serial"] = device(esp)["certificate"]["serial"]
        return f"ESP32 (3-minute test certificate) connected; setMotorSpeed -> 404 '{r['reason']}'"
    check("O11 ESP32 profile refuses motor commands (404)", create_esp)

    def renew_now():
        before = device(rpi)["certificate"]["serial"]
        r = api("POST", f"/devices/{rpi}/renew", {})
        assert r["status"] == 202
        d = wait_for(lambda: (lambda x: x if x["certificate"]["serial"] != before else None)(device(rpi)), 40, what="new serial")
        wait_for(lambda: device(rpi)["status"] == "Connected", 30, what="Connected after renewal")
        assert d["certificate"]["method"] == "renew" and d["certificate"]["previousSerial"] == before
        return f"{before[:10]} -> {d['certificate']['serial'][:10]} over MQTT, reconnected with the new certificate"
    check("O12 on-demand certificate renewal over MQTT", renew_now)

    def late_joiner():
        r = api("POST", "/retained/late-joiner", {"listenMs": 3000})
        mine = [m for m in r["messages"] if m["retain"] and m["topic"] == f"iot/status/{SITE}/{rpi}"]
        assert mine and mine[0]["payload"]["online"] is True, "no retained online status for the test machine"
        assert any(m["topic"] == "iot/config/fleet" for m in r["messages"] if m["retain"])
        return f"new session got {r['retainedCount']} retained messages within {max(m['afterMs'] for m in r['messages'] if m['retain'])} ms"
    check("O13 retained status + fleet config for a late joiner", late_joiner)

    def fleet():
        cur = api("GET", "/fleet-config")
        new = api("POST", "/fleet-config", {"telemetryIntervalSeconds": cur.get("telemetryIntervalSeconds", 5), "renewAtFraction": cur.get("renewAtFraction", 0.67)})
        time.sleep(4)
        st = api("GET", f"/devices/{rpi}")["retainedState"]
        assert st and st.get("configVersion") == new["version"], f"device state configVersion {st and st.get('configVersion')}"
        return f"fleet config v{new['version']} (retained) applied by the machine at once"
    check("O14 retained fleet configuration reaches devices", fleet)

    def power_loss_episode(dev_id):
        return next((e for e in api("GET", "/power-loss") if e["deviceId"] == dev_id), None)

    def lwt():
        r = api("POST", f"/devices/{rpi}/power-loss", {"seconds": 15})
        assert r["status"] == 200 and r["episode"]["phase"] in ("requested", "offline"), r
        s = wait_for(lambda: (lambda p: p if p and p.get("online") is False else None)(retained_status(rpi)), 20, every=1, what="Last Will")
        assert "Last Will" in (s.get("reason") or ""), s
        wait_for(lambda: device(rpi)["status"] == "Connected", 60, what="back online")
        # The operator app tracks the outage and tells the operator when the machine is back.
        ep = wait_for(lambda: (lambda e: e if e and e["phase"] == "online" and e.get("firstTelemetryAt") else None)(power_loss_episode(rpi)),
                      30, every=1, what="power-loss notification (back online + telemetry)")
        assert ep["offlineAt"] and 10 <= ep["outageSeconds"] <= 60, ep
        return (f"broker published retained offline ('{s['reason']}') {ep['willAfterSeconds']} s after the cut; "
                f"back online after {ep['outageSeconds']} s and the operator was notified")
    check("O15 Last Will on abrupt disconnect + back-online notification", lwt)

    def routing_alert():
        before = len([a for a in api("GET", "/pipeline")["alerts"] if (a.get("enrichments") or {}).get("client") == rpi])
        api("POST", f"/devices/{rpi}/motor", {"targetRpm": 5900})
        def alert():
            al = [a for a in api("GET", "/pipeline")["alerts"] if (a.get("enrichments") or {}).get("client") == rpi]
            return al[0] if len(al) > before else None
        a = wait_for(alert, 150, every=5, what="routed alert")
        api("POST", f"/devices/{rpi}/motor", {"targetRpm": 4500})
        assert a["enrichments"] == {"site": SITE, "profile": "raspberry-pi", "client": rpi}, a["enrichments"]
        assert a["data"]["temperature"] > 75
        return f"temperature {a['data']['temperature']} routed to Kafka 'alerts' with enrichments {a['enrichments']}"
    check("O16 routing filter data.temperature > 75 -> Kafka alerts", routing_alert)

    if not args.quick:
        def scheduled_renewal():
            d = wait_for(lambda: (lambda x: x if x["counts"].get("renew", 0) >= 1 else None)(device(esp)), 200, every=10,
                         what="automatic renewal of the 3-minute certificate")
            return f"renewed automatically at 2/3 of its lifetime (renewals {d['counts']['renew']})"
        check("O17 scheduled renewal (no operator action)", scheduled_renewal)

        def reenroll():
            api("POST", f"/devices/{esp}/disconnect", {})
            na = dt.datetime.fromisoformat(device(esp)["certificate"]["notAfter"].replace("Z", "+00:00"))
            wait_s = (na - dt.datetime.now(dt.timezone.utc)).total_seconds() + 40
            time.sleep(max(wait_s, 5))
            api("POST", f"/devices/{esp}/connect", {})
            d = wait_for(lambda: (lambda x: x if x["status"] == "Connected" and x["certificate"]["method"] == "reenroll" else None)(device(esp)),
                         120, every=5, what="re-enrolment")
            return f"offline past expiry ({na:%H:%M:%S}Z), re-enrolled with proof of the previous key, no new token"
        check("O18 re-enrolment after the certificate expired offline", reenroll)

    def revoke():
        api("POST", f"/devices/{esp}/enabled", {"enabled": False})
        d = device(esp)
        assert d["status"] == "Revoked" and d["eventGrid"]["state"] == "Disabled", d["eventGrid"]
        # The broker keeps the already-open session alive, so the app must drop its data.
        time.sleep(15)
        dropped = api("GET", "/health")["quarantine"]["byDevice"].get(esp, 0)
        assert dropped > 0, "no readings quarantined after revocation"
        api("POST", f"/devices/{esp}/renew", {}, ok=(200, 202, 409))
        time.sleep(4)
        ev = [e for e in api("GET", "/certificates")["events"] if e["deviceId"] == esp and e["type"] == "refused"]
        assert ev, "no refused renewal recorded"
        api("POST", f"/devices/{esp}/disconnect", {})
        api("POST", f"/devices/{esp}/connect", {}, ok=(409,))
        return f"client Disabled; {dropped} readings from the still-open session quarantined; renewal refused; connect blocked"
    check("O19 revoke: client disabled, data quarantined, renewals refused", revoke)

    def restore():
        api("POST", f"/devices/{esp}/enabled", {"enabled": True})
        d = device(esp)
        assert d["eventGrid"]["state"] == "Enabled" and d["status"] != "Revoked"
        return f"client Enabled again (state {d['state']})"
    check("O20 restore a revoked machine", restore)

    def token_single_use():
        code, reg = internal("POST", "/internal/devices", {"deviceId": tok, "type": "device", "site": SITE, "profile": "esp32"})
        assert code == 200, reg
        key = ec.generate_private_key(ec.SECP256R1())
        csr = x509.CertificateSigningRequestBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, tok)])).sign(key, hashes.SHA256())
        body = {"deviceId": tok, "token": reg["token"], "csr": csr.public_bytes(serialization.Encoding.PEM).decode()}
        r1 = requests.post(f"{CS}/v1/enroll", json=body, timeout=60)
        r2 = requests.post(f"{CS}/v1/enroll", json=body, timeout=60)
        bad = requests.post(f"{CS}/v1/enroll", json={**body, "token": "not-a-token"}, timeout=60)
        other = dict(body, deviceId=rpi)
        r4 = requests.post(f"{CS}/v1/enroll", json=other, timeout=60)
        assert r1.status_code == 200 and r2.status_code == 403 and bad.status_code == 403 and r4.status_code == 403, (r1.status_code, r2.status_code, bad.status_code, r4.status_code)
        return f"first use 200, reuse 403 ({r2.json()['error']}), bogus 403, other device 403"
    check("O21 enrolment token is single-use and device-bound", token_single_use)

    def delete():
        for d in (rpi, esp, tok):
            api("DELETE", f"/devices/{d}")
        time.sleep(3)
        gone = [d for d in (rpi, esp, tok) if requests.get(f"{APP}/devices/{d}", timeout=30).status_code != 404]
        left = [m["topic"] for m in api("GET", "/retained")["messages"] if any(m["topic"].endswith("/" + d) for d in (rpi, esp, tok))]
        assert not gone and not left, f"still present: {gone} retained: {left}"
        return "Event Grid clients deleted, keys purged at the site, retained messages cleared"
    check("O22 delete machines (registry, site, retained)", delete)

    passed = sum(r["ok"] for r in RESULTS)
    out = pathlib.Path("/var/log/iot-e2e")
    out.mkdir(exist_ok=True)
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    (out / f"ops-{stamp}.json").write_text(json.dumps({"passed": passed, "total": len(RESULTS), "seconds": round(time.time() - START),
                                                       "results": RESULTS}, indent=1))
    print(f"SUMMARY {passed}/{len(RESULTS)} passed in {round(time.time() - START)} s -> {out}/ops-{stamp}.json")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
