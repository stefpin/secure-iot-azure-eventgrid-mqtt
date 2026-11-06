"""One-time CA ceremony for the Contoso Event Grid MQTT demo. Runs on vm-ops.

    sudo /opt/iot/certsvc/venv/bin/python bootstrap.py

Idempotent: keys and CA certificates that already exist are reused.
  1. Create the three HSM keys in Key Vault Premium (RSA-HSM, sign/verify only).
  2. Self-sign the root CA, then sign the device and server issuing CAs with it.
  3. Store the CA certificates (public) as Key Vault secrets and in /etc/iot/pki.
  4. DISABLE the root key - it is only needed again to sign new issuing CAs.
  5. Issue the 7-day enrolment-endpoint certificate for nginx.

The MQTT custom-domain certificate is NOT issued here: the certificate service issues it on
start-up (and every renewal) under a new Key Vault certificate name - see servercert.py.
"""
import datetime as dt
import json
import os
import pathlib
import sys

from azure.core.exceptions import ResourceNotFoundError
from azure.identity import ManagedIdentityCredential
from azure.keyvault.keys import KeyClient, KeyOperation
from azure.keyvault.secrets import SecretClient
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import iotca  # noqa: E402

VAULT = os.environ["IOT_VAULT_URL"]
ENROLL_HOST = os.environ.get("IOT_ENROLL_HOST", "enroll.iot.example.com")
PKI = pathlib.Path(os.environ.get("IOT_PKI_DIR", "/etc/iot/pki"))
TLS = pathlib.Path(os.environ.get("IOT_TLS_DIR", "/etc/iot/tls"))
SERVER_DAYS = int(os.environ.get("IOT_SERVER_CERT_DAYS", "7"))
TAGS = {"CostControl": "Ignore", "purpose": "iot-eventgrid-mqtt-demo"}

cred = ManagedIdentityCredential(client_id=os.environ["AZURE_CLIENT_ID"])
keys = KeyClient(VAULT, cred)
secrets = SecretClient(VAULT, cred)
report = {}


def ensure_key(name, size):
    try:
        key = keys.get_key(name)
        report[name] = f"exists ({key.key_type}, enabled={key.properties.enabled})"
        return key
    except ResourceNotFoundError:
        key = keys.create_rsa_key(name, size=size, hardware_protected=True,
                                  key_operations=[KeyOperation.sign, KeyOperation.verify], tags=TAGS)
        report[name] = f"created {key.key_type} {size}"
        return key


def load_secret_cert(name):
    try:
        return x509.load_pem_x509_certificate(secrets.get_secret(name).value.encode())
    except ResourceNotFoundError:
        return None


def store_cert(name, cert):
    secrets.set_secret(name, iotca.pem(cert), content_type="application/x-pem-file", tags=TAGS,
                       not_before=cert.not_valid_before_utc, expires_on=cert.not_valid_after_utc)


# 1. keys -------------------------------------------------------------------
ensure_key("iot-root-ca", 3072)
ensure_key("iot-device-ca", 2048)
ensure_key("iot-server-ca", 2048)

# 2-3. CA certificates ------------------------------------------------------
root_cert = load_secret_cert("iot-root-ca-cert")
root = None
if root_cert is None:
    keys.update_key_properties("iot-root-ca", enabled=True)
    root = iotca.KvCa(VAULT, cred, "iot-root-ca")
    root_cert = iotca.ca_certificate(root, iotca.name("Contoso IoT Demo Root CA", "PKI"), root.public_key,
                                     issuer=None, days=3650, path_length=1)
    store_cert("iot-root-ca-cert", root_cert)
    report["root"] = "issued"
else:
    report["root"] = "exists"


def ensure_issuing(key_name, secret_name, cn, permitted_dns=None):
    global root
    cert = load_secret_cert(secret_name)
    if cert is not None:
        report[secret_name] = "exists"
        return cert
    if root is None:
        keys.update_key_properties("iot-root-ca", enabled=True)
        root = iotca.KvCa(VAULT, cred, "iot-root-ca", root_cert)
    root.certificate = root_cert
    child = iotca.KvCa(VAULT, cred, key_name)
    cert = iotca.ca_certificate(child, iotca.name(cn, "PKI"), child.public_key, issuer=root, days=730,
                                path_length=0, permitted_dns=permitted_dns)
    store_cert(secret_name, cert)
    report[secret_name] = "issued"
    return cert


device_ca_cert = ensure_issuing("iot-device-ca", "iot-device-ca-cert", "Contoso IoT Demo Device Issuing CA")
server_ca_cert = ensure_issuing("iot-server-ca", "iot-server-ca-cert", "Contoso IoT Demo Server Issuing CA",
                                permitted_dns=[iotca.ZONE])

# 4. the root goes "offline" -------------------------------------------------
keys.update_key_properties("iot-root-ca", enabled=False)
report["iot-root-ca"] += " -> disabled"

PKI.mkdir(parents=True, exist_ok=True)
(PKI / "root-ca.pem").write_text(iotca.pem(root_cert))
(PKI / "device-ca.pem").write_text(iotca.pem(device_ca_cert))
(PKI / "server-ca.pem").write_text(iotca.pem(server_ca_cert))
(PKI / "device-chain.pem").write_text(iotca.pem(device_ca_cert))

server_ca = iotca.KvCa(VAULT, cred, "iot-server-ca", server_ca_cert)

# 5. enrolment endpoint certificate for nginx ---------------------------------
TLS.mkdir(parents=True, exist_ok=True)
key = ec.generate_private_key(ec.SECP256R1())
csr = (x509.CertificateSigningRequestBuilder()
       .subject_name(iotca.name(ENROLL_HOST))
       .sign(key, iotca.hashes.SHA256()))
leaf = iotca.issue_server(server_ca, csr, [ENROLL_HOST], dt.timedelta(days=SERVER_DAYS))
key_path = TLS / "enroll.key"
key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                       serialization.NoEncryption()))
os.chmod(key_path, 0o640)
(TLS / "enroll.crt").write_text(iotca.pem(leaf) + iotca.pem(server_ca_cert))
report["enroll-cert"] = {"serial": format(leaf.serial_number, "X"), "notAfter": leaf.not_valid_after_utc.isoformat()}

report["fingerprints"] = {
    n: c.fingerprint(iotca.hashes.SHA256()).hex()[:16]
    for n, c in (("root", root_cert), ("device-ca", device_ca_cert), ("server-ca", server_ca_cert))}
print(json.dumps(report, indent=1))
