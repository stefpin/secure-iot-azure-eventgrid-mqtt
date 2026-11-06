"""Settings for the Contoso certificate service, read from the environment (/etc/iot/certsvc.env)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def _int(name: str, default: int) -> int:
    return int(os.environ.get(name, default))


@dataclass(frozen=True)
class Config:
    client_id: str = field(default_factory=lambda: os.environ["AZURE_CLIENT_ID"])
    vault_url: str = field(default_factory=lambda: os.environ["IOT_VAULT_URL"])
    namespace_id: str = field(default_factory=lambda: os.environ["IOT_NAMESPACE_ID"])
    # Cloud workloads use the namespace's own hostname (Microsoft-managed certificate) through
    # the private endpoint, so operations keep working even if the custom-domain certificate breaks.
    broker_host: str = field(default_factory=lambda: os.environ["IOT_BROKER_HOST"])
    mqtt_host: str = field(default_factory=lambda: os.environ.get("IOT_MQTT_HOST", "mqtt.iot.example.com"))
    enroll_host: str = field(default_factory=lambda: os.environ.get("IOT_ENROLL_HOST", "enroll.iot.example.com"))
    cosmos_endpoint: str = field(default_factory=lambda: os.environ["IOT_COSMOS_ENDPOINT"])
    cosmos_db: str = field(default_factory=lambda: os.environ.get("IOT_COSMOS_DB", "iotmq"))
    pki_dir: str = field(default_factory=lambda: os.environ.get("IOT_PKI_DIR", "/etc/iot/pki"))
    tls_dir: str = field(default_factory=lambda: os.environ.get("IOT_TLS_DIR", "/etc/iot/tls"))
    internal_token: str = field(default_factory=lambda: os.environ.get("IOT_INTERNAL_TOKEN", ""))
    http_port: int = field(default_factory=lambda: _int("IOT_HTTP_PORT", 8081))

    # Lifetimes (demo values - see the runbook for production guidance)
    device_cert_minutes: int = field(default_factory=lambda: _int("IOT_DEVICE_CERT_MINUTES", 60))
    reenroll_grace_hours: int = field(default_factory=lambda: _int("IOT_REENROLL_GRACE_HOURS", 24))
    token_hours: int = field(default_factory=lambda: _int("IOT_TOKEN_HOURS", 24))
    server_cert_days: int = field(default_factory=lambda: _int("IOT_SERVER_CERT_DAYS", 7))
    server_renew_days_left: int = field(default_factory=lambda: _int("IOT_SERVER_RENEW_DAYS_LEFT", 3))
    max_issues_per_hour: int = field(default_factory=lambda: _int("IOT_MAX_ISSUES_PER_HOUR", 20))
