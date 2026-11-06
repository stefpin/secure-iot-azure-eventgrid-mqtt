"""Device registry for the certificate service.

Two stores, each authoritative for one thing:
  * Event Grid namespace "clients"  - who may connect and with which attributes
                                       (authentication name, type, site, profile, Enabled/Disabled)
  * Cosmos DB (keyless, private)     - certificate inventory, one-time enrolment tokens (hash only)
                                       and the issue/renew/revoke audit trail
"""
from __future__ import annotations

import datetime as dt
import hashlib
import secrets
import uuid

import requests
from azure.core import MatchConditions
from azure.core.exceptions import ResourceNotFoundError
from azure.cosmos import CosmosClient

ARM = "https://management.azure.com"
EG_API = "2025-02-15"


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(value: dt.datetime | None = None) -> str:
    return (value or utcnow()).isoformat().replace("+00:00", "Z")


class RegistryError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class Registry:
    def __init__(self, cfg, credential, log=print):
        self.cfg = cfg
        self.cred = credential
        self.log = log
        db = CosmosClient(cfg.cosmos_endpoint, credential=credential).get_database_client(cfg.cosmos_db)
        self.devices = db.get_container_client("devices")
        self.tokens = db.get_container_client("tokens")
        self.events = db.get_container_client("certevents")

    # ------------------------------------------------------------ Event Grid
    def _arm(self, method: str, path: str, body=None, ok=(200, 201, 202, 204)):
        token = self.cred.get_token(f"{ARM}/.default").token
        r = requests.request(method, f"{ARM}{self.cfg.namespace_id}/{path}?api-version={EG_API}",
                             json=body, headers={"Authorization": f"Bearer {token}"}, timeout=60)
        if r.status_code == 404 and method == "GET":
            return None
        if r.status_code not in ok:
            raise RegistryError(502, f"Event Grid {method} {path}: {r.status_code} {r.text[:300]}")
        return r.json() if r.text else {}

    def eg_client(self, name: str):
        return self._arm("GET", f"clients/{name}")

    def eg_upsert_client(self, name: str, attributes: dict, enabled: bool = True, description: str = ""):
        body = {"properties": {
            "authenticationName": name,
            "description": description or f"{attributes.get('type', 'device')} {name}",
            "clientCertificateAuthentication": {"validationScheme": "SubjectMatchesAuthenticationName"},
            "state": "Enabled" if enabled else "Disabled",
            "attributes": attributes,
        }}
        return self._arm("PUT", f"clients/{name}", body)

    def eg_delete_client(self, name: str):
        token = self.cred.get_token(f"{ARM}/.default").token
        r = requests.delete(f"{ARM}{self.cfg.namespace_id}/clients/{name}?api-version={EG_API}",
                            headers={"Authorization": f"Bearer {token}"}, timeout=60)
        if r.status_code not in (200, 202, 204, 404):
            raise RegistryError(502, f"Event Grid DELETE clients/{name}: {r.status_code} {r.text[:200]}")

    # --------------------------------------------------------------- devices
    def get(self, device_id: str) -> dict | None:
        try:
            return self.devices.read_item(device_id, partition_key=device_id)
        except ResourceNotFoundError:
            return None

    def save(self, doc: dict) -> dict:
        doc["updatedAt"] = iso()
        return self.devices.upsert_item(doc)

    def list(self) -> list[dict]:
        return list(self.devices.query_items("SELECT * FROM c WHERE c.state != 'deleted'",
                                             enable_cross_partition_query=True))

    def register(self, device_id: str, kind: str, site: str, profile: str, created_by: str = "operator") -> tuple[dict, str]:
        existing = self.get(device_id)
        if existing and existing.get("state") != "deleted":
            raise RegistryError(409, f"Device '{device_id}' already exists.")
        attributes = {"type": kind, "site": site}
        if profile:
            attributes["profile"] = profile
        self.eg_upsert_client(device_id, attributes, enabled=True,
                              description=f"Contoso {kind} {device_id} ({profile or 'gateway'}) at {site}")
        doc = {
            "id": device_id, "deviceId": device_id, "type": kind, "site": site, "profile": profile,
            "state": "registered", "createdAt": iso(), "createdBy": created_by,
            "cert": None, "counts": {"enroll": 0, "renew": 0, "reenroll": 0, "refused": 0},
        }
        self.save(doc)
        token = self.new_token(device_id)
        self.event(device_id, "registered", detail={"site": site, "profile": profile, "type": kind})
        return doc, token

    # ---------------------------------------------------------------- tokens
    @staticmethod
    def _hash(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()

    def new_token(self, device_id: str) -> str:
        token = secrets.token_urlsafe(24)
        expires = utcnow() + dt.timedelta(hours=self.cfg.token_hours)
        self.tokens.upsert_item({"id": self._hash(token), "deviceId": device_id, "expiresAt": iso(expires),
                                 "ttl": self.cfg.token_hours * 3600})
        return token

    def consume_token(self, device_id: str, token: str) -> None:
        """Single use: the token document is deleted with an ETag match, so it can be spent only once."""
        key = self._hash(token or "")
        try:
            doc = self.tokens.read_item(key, partition_key=key)
        except ResourceNotFoundError:
            raise RegistryError(403, "Unknown, used or expired enrolment token.")
        if doc.get("deviceId") != device_id:
            raise RegistryError(403, "The enrolment token belongs to another device.")
        if dt.datetime.fromisoformat(doc["expiresAt"].replace("Z", "+00:00")) < utcnow():
            raise RegistryError(403, "The enrolment token has expired.")
        try:
            self.tokens.delete_item(key, partition_key=key, etag=doc["_etag"], match_condition=MatchConditions.IfNotModified)
        except Exception:
            raise RegistryError(403, "The enrolment token was already used.")

    # ---------------------------------------------------------------- events
    def event(self, device_id: str, kind: str, serial: str | None = None, detail: dict | None = None) -> None:
        try:
            self.events.create_item({"id": str(uuid.uuid4()), "deviceId": device_id, "type": kind, "ts": iso(),
                                     "serial": serial, **(detail or {})})
        except Exception as exc:  # audit must never break issuance
            self.log(f"audit write failed for {device_id}: {exc}")

    def recent_events(self, device_id: str | None = None, limit: int = 50) -> list[dict]:
        if device_id:
            q = ("SELECT TOP @n * FROM c WHERE c.deviceId = @d ORDER BY c.ts DESC",
                 [{"name": "@n", "value": limit}, {"name": "@d", "value": device_id}])
            return list(self.events.query_items(q[0], parameters=q[1], partition_key=device_id))
        return list(self.events.query_items("SELECT TOP @n * FROM c ORDER BY c.ts DESC",
                                            parameters=[{"name": "@n", "value": limit}],
                                            enable_cross_partition_query=True))
