"""Server certificates for the Contoso demo, issued by the HSM-backed server issuing CA.

MQTT custom domain (mqtt.iot.example.com)
    Event Grid reads the certificate from Key Vault through its managed identity
    and CACHES IT PER CERTIFICATE NAME: a new version under the same name was not
    served after 8 hours, while a certificate under a name Event Grid had never
    used was served within about 90 seconds. Every renewal is therefore created
    under a NEW name ("mqtt-srv-YYYYMMDD-HHMMSS"), then the custom domain is switched to
    it. The private key is generated inside Key Vault (Key Vault CSR) and never
    leaves it; only the signature comes from the server issuing CA.

Enrolment endpoint (enroll.iot.example.com)
    nginx on vm-ops; key generated locally, certificate signed by the same CA.
"""
from __future__ import annotations

import datetime as dt
import os
import pathlib
import socket
import ssl
import time

import requests
from azure.keyvault.certificates import CertificateClient, CertificateContentType, CertificatePolicy
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

import iotca

ARM = "https://management.azure.com"
EG_API = "2025-02-15"
PREFIX = "mqtt-srv-"


class ServerCerts:
    def __init__(self, cfg, credential, server_ca: iotca.KvCa, log=print):
        self.cfg = cfg
        self.cred = credential
        self.ca = server_ca
        self.certs = CertificateClient(cfg.vault_url, credential)
        self.log = log

    # ------------------------------------------------------------------ ARM
    def _arm(self, method, path, body=None):
        token = self.cred.get_token(f"{ARM}/.default").token
        url = f"{ARM}{path}?api-version={EG_API}"
        r = requests.request(method, url, json=body, headers={"Authorization": f"Bearer {token}"}, timeout=60)
        if r.status_code >= 300:
            raise RuntimeError(f"ARM {method} {path}: {r.status_code} {r.text[:300]}")
        return r.json() if r.text else {}

    def namespace(self):
        return self._arm("GET", self.cfg.namespace_id)

    def active_name(self) -> str | None:
        domains = self.namespace()["properties"]["topicSpacesConfiguration"].get("customDomains") or []
        for d in domains:
            if d["fullyQualifiedDomainName"] == self.cfg.mqtt_host:
                return d["certificateUrl"].rstrip("/").split("/")[-1]
        return None

    def _switch(self, cert_name: str):
        tsc = self.namespace()["properties"]["topicSpacesConfiguration"]
        body = {"properties": {"topicSpacesConfiguration": {
            "routeTopicResourceId": tsc.get("routeTopicResourceId"),
            "routingEnrichments": tsc.get("routingEnrichments"),
            "customDomains": [{
                "fullyQualifiedDomainName": self.cfg.mqtt_host,
                "certificateUrl": f"{self.cfg.vault_url.rstrip('/')}/certificates/{cert_name}",
                "identity": {"type": "SystemAssigned"},
            }],
        }}}
        self._arm("PATCH", self.cfg.namespace_id, body)

    # ------------------------------------------------------------- observe
    def served(self) -> x509.Certificate | None:
        """The certificate Event Grid presents on the MQTT custom domain (via the private endpoint)."""
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        try:
            with socket.create_connection((self.cfg.mqtt_host, 8883), timeout=10) as sock:
                with ctx.wrap_socket(sock, server_hostname=self.cfg.mqtt_host) as tls:
                    return x509.load_der_x509_certificate(tls.getpeercert(binary_form=True))
        except OSError:
            return None

    def status(self) -> dict:
        served = self.served()
        now = iotca.utcnow()
        return {
            "activeCertificateName": self.active_name(),
            "servedSerial": format(served.serial_number, "X") if served else None,
            "servedIssuer": served.issuer.rfc4514_string() if served else None,
            "servedNotAfter": served.not_valid_after_utc.isoformat() if served else None,
            "servedDaysLeft": round((served.not_valid_after_utc - now).total_seconds() / 86400, 2) if served else None,
            "servedByIotCa": bool(served and served.issuer == self.ca.subject),
        }

    # -------------------------------------------------------------- rotate
    def rotate(self, wait_seconds: int = 600, reason: str = "scheduled") -> dict:
        now = iotca.utcnow()
        name = f"{PREFIX}{now:%Y%m%d-%H%M%S}"
        policy = CertificatePolicy(
            issuer_name="Unknown", subject=f"CN={self.cfg.mqtt_host}", san_dns_names=[self.cfg.mqtt_host],
            exportable=True, key_type="RSA", key_size=2048, reuse_key=False,
            content_type=CertificateContentType.pkcs12, validity_in_months=1)
        self.certs.begin_create_certificate(name, policy, tags={"CostControl": "Ignore", "purpose": "iot-eventgrid-mqtt-demo",
                                                                "rotation": reason})
        csr = x509.load_der_x509_csr(self.certs.get_certificate_operation(name).csr)
        leaf = iotca.issue_server(self.ca, csr, [self.cfg.mqtt_host], dt.timedelta(days=self.cfg.server_cert_days))
        self.certs.merge_certificate(name, [leaf.public_bytes(serialization.Encoding.DER),
                                            self.ca.certificate.public_bytes(serialization.Encoding.DER)])
        previous = self.active_name()
        self._switch(name)
        serial = format(leaf.serial_number, "X")
        self.log(f"server certificate {name} serial {serial} issued; custom domain switched from {previous}")
        started = time.time()
        served_after = None
        while time.time() - started < wait_seconds:
            s = self.served()
            if s is not None and s.serial_number == leaf.serial_number:
                served_after = round(time.time() - started)
                break
            time.sleep(10)
        return {"name": name, "previous": previous, "serial": serial,
                "notAfter": leaf.not_valid_after_utc.isoformat(), "servedAfterSeconds": served_after}

    def prune(self, keep: int = 2) -> list[str]:
        """Delete older mqtt-srv-* certificates, keeping the newest `keep` (never the active one)."""
        active = self.active_name()
        names = sorted((p.name for p in self.certs.list_properties_of_certificates()
                        if p.name.startswith(PREFIX) and p.name != active), reverse=True)
        doomed = names[max(0, keep - 1):]
        for n in doomed:
            self.certs.begin_delete_certificate(n)
        return doomed

    def due(self) -> bool:
        """Renew once fewer than server_renew_days_left days remain (day 4 of 7).

        Decided from the certificate the custom domain is CONFIGURED to use, not the one
        currently served, so a slow pickup never triggers a second rotation.
        """
        active = self.active_name()
        if not active or not active.startswith(PREFIX):
            return True  # still on a certificate this service did not issue
        expires = self.certs.get_certificate(active).properties.expires_on
        return expires - iotca.utcnow() <= dt.timedelta(days=self.cfg.server_renew_days_left)

    # ------------------------------------------------------- enrolment TLS
    def enroll_cert_due(self) -> bool:
        path = pathlib.Path(self.cfg.tls_dir) / "enroll.crt"
        if not path.exists():
            return True
        cert = x509.load_pem_x509_certificate(path.read_bytes())
        return cert.not_valid_after_utc - iotca.utcnow() <= dt.timedelta(days=self.cfg.server_renew_days_left)

    def renew_enroll_cert(self) -> dict:
        tls = pathlib.Path(self.cfg.tls_dir)
        key = ec.generate_private_key(ec.SECP256R1())
        csr = (x509.CertificateSigningRequestBuilder().subject_name(iotca.name(self.cfg.enroll_host))
               .sign(key, hashes.SHA256()))
        leaf = iotca.issue_server(self.ca, csr, [self.cfg.enroll_host], dt.timedelta(days=self.cfg.server_cert_days))
        tmp_key, tmp_crt = tls / "enroll.key.new", tls / "enroll.crt.new"
        tmp_key.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                              serialization.NoEncryption()))
        os.chmod(tmp_key, 0o640)
        tmp_crt.write_text(iotca.pem(leaf) + iotca.pem(self.ca.certificate))
        os.replace(tmp_key, tls / "enroll.key")
        os.replace(tmp_crt, tls / "enroll.crt")  # a systemd path unit reloads nginx
        return {"serial": format(leaf.serial_number, "X"), "notAfter": leaf.not_valid_after_utc.isoformat()}
