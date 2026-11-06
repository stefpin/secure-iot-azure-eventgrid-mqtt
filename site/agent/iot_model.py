"""Simulated machine behaviour, ported 1:1 from the IoT Hub demo (app/src/device-model.js).

raspberry-pi  industrial gateway profile: motor rpm with a remote speed setpoint, winding
              temperature that follows the load, humidity, line voltage, lux, thermal alarm
esp32         low-power sensor node: temperature, humidity, lux, battery, Wi-Fi rssi
"""
from __future__ import annotations

import datetime as dt
import random

TEMPLATES = {
    "raspberry-pi": {
        "metrics": ["temperature", "humidity", "voltage", "rpm", "lux"],
        "fields": {
            "temperature": {"start": 45.0, "min": 20, "max": 95, "drift": 0.35},
            "humidity": {"start": 60.0, "min": 20, "max": 95, "drift": 0.4},
            "voltage": {"start": 230.0, "min": 200, "max": 250, "drift": 0.6},
            "rpm": {"start": 4500, "min": 0, "max": 6000, "drift": 25},
            "lux": {"start": 6.67, "min": 0, "max": 100, "drift": 0.8},
        },
        "control": {"method": "setMotorSpeed", "metric": "rpm", "min": 0, "max": 6000, "nominal": 4500,
                    "rampFactor": 0.5, "thermalFactor": 0.28, "heatPerRpm": 0.025, "coolPerRpm": 0.006},
    },
    "esp32": {
        "metrics": ["temperature", "humidity", "lux", "battery", "rssi"],
        "fields": {
            "temperature": {"start": 31.5, "min": 15, "max": 60, "drift": 0.3},
            "humidity": {"start": 68.0, "min": 20, "max": 99, "drift": 0.5},
            "lux": {"start": 12.4, "min": 0, "max": 100, "drift": 1.2},
            "battery": {"start": 96.0, "min": 5, "max": 100, "drift": 0.05},
            "rssi": {"start": -58, "min": -95, "max": -30, "drift": 1.5},
        },
    },
}


def clamp(value, low, high):
    return max(low, min(high, value))


class Machine:
    def __init__(self, profile: str):
        self.profile = profile if profile in TEMPLATES else "raspberry-pi"
        self.t = TEMPLATES[self.profile]
        self.values = {k: f["start"] for k, f in self.t["fields"].items()}
        self.velocity = {k: 0.0 for k in self.t["fields"]}
        self.control = self.t.get("control")
        self.setpoint = self.control["nominal"] if self.control else None
        self.manual_buzzer = None
        self.buzzer = False

    @property
    def alarm_at(self) -> float:
        return round(self.t["fields"]["temperature"]["max"] * 0.8, 2)

    def _targets(self):
        targets = {k: f["start"] for k, f in self.t["fields"].items()}
        c = self.control
        if not c:
            return targets
        sp = clamp(self.setpoint if self.setpoint is not None else c["nominal"], c["min"], c["max"])
        targets[c["metric"]] = sp
        delta = sp - c["nominal"]
        per = c["heatPerRpm"] if delta >= 0 else c["coolPerRpm"]
        tf = self.t["fields"]["temperature"]
        targets["temperature"] = clamp(tf["start"] + delta * per, tf["min"], tf["max"])
        return targets

    def step(self, interval_seconds: float = 5) -> dict:
        targets = self._targets()
        c = self.control
        for field, spec in self.t["fields"].items():
            noise = (random.random() - 0.5) * spec["drift"]
            if c and field == c["metric"]:
                self.values[field] = clamp(self.values[field] + (targets[field] - self.values[field]) * c["rampFactor"] + noise,
                                           spec["min"], spec["max"])
                continue
            if c and field == "temperature":
                self.values[field] = clamp(self.values[field] + (targets[field] - self.values[field]) * c["thermalFactor"] + noise,
                                           spec["min"], spec["max"])
                continue
            nudge = (targets[field] - self.values[field]) * 0.02
            self.velocity[field] = self.velocity[field] * 0.7 + noise + nudge
            self.values[field] = clamp(self.values[field] + self.velocity[field], spec["min"], spec["max"])

        self.buzzer = (self.values["temperature"] > self.alarm_at) if self.manual_buzzer is None else self.manual_buzzer
        reading = {
            "timestamp": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
            "template": self.profile,
            "buzzer": bool(self.buzzer),
        }
        if c:
            reading["targetRpm"] = int(round(self.setpoint if self.setpoint is not None else c["nominal"]))
            reading["alarmAt"] = self.alarm_at
        for m in self.t["metrics"]:
            reading[m] = int(round(self.values[m])) if m == "rpm" else round(self.values[m], 2)
        return reading

    # ---------------------------------------------------------------- commands
    def set_motor_speed(self, payload: dict, interval_seconds: float = 5):
        c = self.control
        if not c:
            return 404, {"accepted": False, "error": "This device has no motor to control."}
        raw = (payload or {}).get("targetRpm")
        try:
            if raw is None or raw == "":
                raise ValueError
            requested = int(round(float(raw)))
        except (TypeError, ValueError):
            return 400, {"accepted": False, "error": "targetRpm must be a number.", "received": raw}
        if requested < c["min"] or requested > c["max"]:
            return 400, {"accepted": False, "error": f"targetRpm must be between {c['min']} and {c['max']}.",
                         "received": requested, "min": c["min"], "max": c["max"]}
        previous = int(self.setpoint if self.setpoint is not None else c["nominal"])
        self.setpoint = requested
        return 200, {"accepted": True, "previousTargetRpm": previous, "targetRpm": requested,
                     "rampSeconds": max(1, int(round(4 * interval_seconds)))}

    def set_buzzer(self, payload: dict):
        self.manual_buzzer = bool((payload or {}).get("on"))
        return 200, {"buzzer": self.manual_buzzer}

    def clear_buzzer_override(self):
        self.manual_buzzer = None
        return 200, {"buzzer": "auto"}
