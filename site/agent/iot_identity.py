"""Device / gateway identity: private key, short-lived certificate, enrolment and renewal.

The private key is generated ON the device (EC P-256) and never leaves it. The device gets
certificates in three ways:
  enroll    first time - HTTPS POST with a one-time token from the operator     (/v1/enroll)
  renew     routine, before expiry - over MQTT, authenticated by the current certificate
  reenroll  certificate already expired (device was offline) - HTTPS POST that proves
            possession of the previous key, accepted within the grace period  (/v1/reenroll)
Files are swapped atomically (write *.new, then rename), so a power cut never leaves a
mismatched key/certificate pair behind.
"""
from __future__ import annotations

import base64
import datetime as dt
import json
import os
import pathlib

import requests
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


class EnrollmentError(Exception):
    pass


class Identity:
    def __init__(self, name: str, state_dir: str, enroll_base: str, trust_file: str | None = None, log=print):
        self.name = name
        self.dir = pathlib.Path(state_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        os.chmod(self.dir, 0o700)
        self.enroll_base = enroll_base.rstrip("/")
        self.log = log
        self.key_path = self.dir / "device.key"
        self.crt_path = self.dir / "device.crt"
        self.trust_path = self.dir / "trust-bundle.pem"
        self.meta_path = self.dir / "meta.json"
        if trust_file and not self.trust_path.exists():
            self.trust_path.write_bytes(pathlib.Path(trust_file).read_bytes())
        self.pending_key = None

    # ------------------------------------------------------------ state
    def certificate(self) -> x509.Certificate | None:
        if not self.crt_path.exists():
            return None
        return x509.load_pem_x509_certificate(self.crt_path.read_bytes())

    def meta(self) -> dict:
        try:
            return json.loads(self.meta_path.read_text())
        except Exception:
            return {}

    def summary(self) -> dict:
        cert = self.certificate()
        if not cert:
            return {"serial": None, "notAfter": None}
        return {"serial": format(cert.serial_number, "X"),
                "notAfter": cert.not_valid_after_utc.isoformat().replace("+00:00", "Z"),
                "issuer": cert.issuer.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value}

    def seconds_left(self) -> float:
        cert = self.certificate()
        return (cert.not_valid_after_utc - utcnow()).total_seconds() if cert else -1

    def expired(self) -> bool:
        return self.seconds_left() <= 30

    def renew_due(self, fraction: float) -> bool:
        """True once `fraction` of the lifetime has passed (default 2/3: minute 40 of 60).

        Measured from when the certificate was actually issued, not from notBefore: the CA
        backdates notBefore by a few minutes for clock skew, which would otherwise make short
        certificates renew almost immediately.
        """
        cert = self.certificate()
        if not cert:
            return False
        start, end = cert.not_valid_before_utc, cert.not_valid_after_utc
        issued = self.meta().get("lastIssuedAt")
        if issued:
            try:
                start = max(start, dt.datetime.fromisoformat(issued.replace("Z", "+00:00")))
            except ValueError:
                pass
        return utcnow() >= start + (end - start) * fraction

    # ------------------------------------------------------------- keys
    def new_csr(self) -> str:
        """New key for every certificate (no key reuse). Kept in memory until the certificate arrives."""
        self.pending_key = ec.generate_private_key(ec.SECP256R1())
        csr = (x509.CertificateSigningRequestBuilder()
               .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, self.name)]))
               .sign(self.pending_key, hashes.SHA256()))
        return csr.public_bytes(serialization.Encoding.PEM).decode()

    def install(self, response: dict, method: str) -> dict:
        """Verify the issued certificate matches the pending key and chain, then swap files atomically."""
        if self.pending_key is None:
            raise EnrollmentError("no pending key")
        leaf = x509.load_pem_x509_certificate(response["certificate"].encode())
        chain = x509.load_pem_x509_certificate(response["chain"].encode())
        pub = lambda k: k.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        if pub(leaf.public_key()) != pub(self.pending_key.public_key()):
            raise EnrollmentError("issued certificate does not match the new key")
        leaf.verify_directly_issued_by(chain)
        if leaf.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value != self.name:
            raise EnrollmentError("issued certificate is for another name")
        key_new, crt_new = self.dir / "device.key.new", self.dir / "device.crt.new"
        key_new.write_bytes(self.pending_key.private_bytes(serialization.Encoding.PEM,
                                                           serialization.PrivateFormat.PKCS8,
                                                           serialization.NoEncryption()))
        os.chmod(key_new, 0o600)
        crt_new.write_text(response["certificate"] + response["chain"])
        os.replace(key_new, self.key_path)
        os.replace(crt_new, self.crt_path)
        if response.get("trustBundle"):
            tmp = self.dir / "trust-bundle.pem.new"
            tmp.write_text(response["trustBundle"])
            os.replace(tmp, self.trust_path)
        self.pending_key = None
        meta = self.meta()
        meta.update({"lastMethod": method, "lastIssuedAt": utcnow().isoformat(), "serial": response.get("serial"),
                     "notAfter": response.get("notAfter"), "mqttHost": response.get("mqttHost")})
        meta.setdefault("counts", {})
        meta["counts"][method] = meta["counts"].get(method, 0) + 1
        self.meta_path.write_text(json.dumps(meta, indent=1))
        return meta

    # ------------------------------------------------------------ HTTPS
    def _post(self, path: str, body: dict) -> dict:
        try:
            r = requests.post(f"{self.enroll_base}/{path}", json=body, timeout=30, verify=str(self.trust_path))
        except requests.RequestException as exc:
            raise EnrollmentError(f"enrolment endpoint unreachable: {exc}")
        if r.status_code != 200:
            try:
                msg = r.json().get("error") or r.json().get("detail")
            except Exception:
                msg = r.text[:200]
            raise EnrollmentError(f"{path} refused ({r.status_code}): {msg}")
        return r.json()

    def enroll(self, token: str) -> dict:
        csr = self.new_csr()
        response = self._post("enroll", {"deviceId": self.name, "token": token, "csr": csr})
        return self.install(response, "enroll")

    def reenroll(self) -> dict:
        old = self.crt_path.read_text()
        old_key = serialization.load_pem_private_key(self.key_path.read_bytes(), password=None)
        csr = self.new_csr()
        csr_der = x509.load_pem_x509_csr(csr.encode()).public_bytes(serialization.Encoding.DER)
        signature = old_key.sign(csr_der, ec.ECDSA(hashes.SHA256()))
        leaf_only = old.split("-----END CERTIFICATE-----")[0] + "-----END CERTIFICATE-----\n"
        response = self._post("reenroll", {"deviceId": self.name, "csr": csr, "certificate": leaf_only,
                                           "signature": base64.b64encode(signature).decode()})
        return self.install(response, "reenroll")

    def ensure(self, token: str | None) -> str:
        """Make sure a valid certificate exists. Returns how it was obtained."""
        if self.certificate() is not None and not self.expired():
            return "existing"
        if self.certificate() is not None:
            try:
                self.reenroll()
                self.log("certificate had expired - re-enrolled with proof of the previous key")
                return "reenroll"
            except EnrollmentError as exc:
                self.log(f"re-enrolment refused: {exc}")
                if not token:
                    raise
        if not token:
            raise EnrollmentError("no certificate yet and no enrolment token - ask the operator for one")
        self.enroll(token)
        self.log("enrolled with the one-time token")
        return "enroll"
