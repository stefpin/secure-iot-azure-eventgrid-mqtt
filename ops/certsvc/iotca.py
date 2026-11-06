"""Contoso IoT demo certificate authority, backed by Azure Key Vault Premium (HSM keys).

The CA private keys never leave the Key Vault HSM. To issue a certificate this
module builds the X.509 "to-be-signed" structure (TBS) locally, asks Key Vault to
sign its SHA-256 digest with the CA key (RS256 = RSASSA-PKCS1-v1_5), splices the
signature into the certificate and then verifies it with the CA public key.

cryptography's CertificateBuilder can only produce a signed certificate, so the
TBS is obtained by signing once with a throw-away RSA key: the TBS bytes do not
depend on the signing key (only the algorithm identifier, which is the same
sha256WithRSAEncryption), so they are exactly what the real CA must sign.

Hierarchy (Option A - Contoso runs its own CA; the demo CA is never reused in production)
    iot-root-ca      RSA-HSM 3072, 10 years, key DISABLED after it signs the two issuing CAs
    iot-device-ca    RSA-HSM 2048, 2 years, signs device + gateway client certificates (1 hour)
    iot-server-ca    RSA-HSM 2048, 2 years, name-constrained to iot.example.com,
                     signs the MQTT custom-domain and enrolment server certificates (7 days)
"""
from __future__ import annotations

import datetime as dt
import hashlib
from functools import lru_cache

from azure.keyvault.keys import KeyClient
from azure.keyvault.keys.crypto import CryptographyClient, SignatureAlgorithm
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

ORG = "Contoso Mining demo"
ZONE = "iot.example.com"
SKEW = dt.timedelta(minutes=5)

# AlgorithmIdentifier { sha256WithRSAEncryption, NULL }
_SHA256_RSA = bytes.fromhex("300d06092a864886f70d01010b0500")


def _der_len(n: int) -> bytes:
    if n < 0x80:
        return bytes([n])
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(raw)]) + raw


def _assemble(tbs: bytes, signature: bytes) -> bytes:
    bit_string = b"\x03" + _der_len(len(signature) + 1) + b"\x00" + signature
    body = tbs + _SHA256_RSA + bit_string
    return b"\x30" + _der_len(len(body)) + body


@lru_cache(maxsize=1)
def _throwaway_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def name(common_name: str, unit: str | None = None) -> x509.Name:
    attrs = [x509.NameAttribute(NameOID.ORGANIZATION_NAME, ORG)]
    if unit:
        attrs.append(x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, unit))
    attrs.append(x509.NameAttribute(NameOID.COMMON_NAME, common_name))
    return x509.Name(attrs)


def pem(cert: x509.Certificate) -> str:
    return cert.public_bytes(serialization.Encoding.PEM).decode()


def common_name(cert_or_csr) -> str | None:
    values = cert_or_csr.subject.get_attributes_for_oid(NameOID.COMMON_NAME)
    return values[0].value if values else None


class KvCa:
    """One CA key held in Key Vault, plus (optionally) its certificate."""

    def __init__(self, vault_url: str, credential, key_name: str, certificate: x509.Certificate | None = None):
        self.key_name = key_name
        self.keys = KeyClient(vault_url, credential)
        self.key = self.keys.get_key(key_name)
        self.crypto = CryptographyClient(self.key, credential)
        self.certificate = certificate

    @property
    def public_key(self) -> rsa.RSAPublicKey:
        jwk = self.key.key
        return rsa.RSAPublicNumbers(int.from_bytes(jwk.e, "big"), int.from_bytes(jwk.n, "big")).public_key()

    @property
    def subject(self) -> x509.Name:
        return self.certificate.subject

    def sign(self, builder: x509.CertificateBuilder) -> x509.Certificate:
        tbs = builder.sign(_throwaway_key(), hashes.SHA256()).tbs_certificate_bytes
        digest = hashlib.sha256(tbs).digest()
        signature = self.crypto.sign(SignatureAlgorithm.rs256, digest).signature
        cert = x509.load_der_x509_certificate(_assemble(tbs, signature))
        # Never hand out a certificate that does not verify against the CA key.
        self.public_key.verify(cert.signature, cert.tbs_certificate_bytes, padding.PKCS1v15(), hashes.SHA256())
        return cert


def ca_certificate(ca: KvCa, subject: x509.Name, subject_public_key, issuer: KvCa | None, days: int,
                   path_length: int, permitted_dns: list[str] | None = None) -> x509.Certificate:
    """Root (issuer=None, self-signed) or issuing CA certificate."""
    now = utcnow()
    signer = issuer or ca
    builder = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer.subject if issuer else subject)
        .public_key(subject_public_key)
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - SKEW)
        .not_valid_after(now + dt.timedelta(days=days))
        .add_extension(x509.BasicConstraints(ca=True, path_length=path_length), critical=True)
        .add_extension(x509.KeyUsage(digital_signature=False, content_commitment=False, key_encipherment=False,
                                     data_encipherment=False, key_agreement=False, key_cert_sign=True,
                                     crl_sign=True, encipher_only=False, decipher_only=False), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(subject_public_key), critical=False)
    )
    if issuer:
        builder = builder.add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(issuer.public_key), critical=False)
    if permitted_dns:
        builder = builder.add_extension(
            x509.NameConstraints(permitted_subtrees=[x509.DNSName(d) for d in permitted_dns],
                                 excluded_subtrees=None), critical=True)
    return signer.sign(builder)


def _check_csr(csr: x509.CertificateSigningRequest) -> None:
    if not csr.is_signature_valid:
        raise ValueError("The CSR signature is not valid.")
    key = csr.public_key()
    if isinstance(key, ec.EllipticCurvePublicKey):
        if key.curve.name not in ("secp256r1", "secp384r1"):
            raise ValueError("EC keys must use P-256 or P-384.")
    elif isinstance(key, rsa.RSAPublicKey):
        if key.key_size < 2048:
            raise ValueError("RSA keys must be at least 2048 bits.")
    else:
        raise ValueError("Only EC (P-256/P-384) and RSA keys are accepted.")


def issue_client(issuer: KvCa, csr: x509.CertificateSigningRequest, client_name: str, unit: str,
                 lifetime: dt.timedelta) -> x509.Certificate:
    """Short-lived TLS client certificate for a device or gateway.

    The subject CN is the Event Grid client authentication name; the namespace
    validates it with the SubjectMatchesAuthenticationName scheme.
    """
    _check_csr(csr)
    requested = common_name(csr)
    if requested != client_name:
        raise ValueError(f"CSR common name '{requested}' does not match '{client_name}'.")
    now = utcnow()
    key = csr.public_key()
    builder = (
        x509.CertificateBuilder()
        .subject_name(name(client_name, unit))
        .issuer_name(issuer.subject)
        .public_key(key)
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - SKEW)
        .not_valid_after(now + lifetime)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False,
                                     key_encipherment=isinstance(key, rsa.RSAPublicKey), data_encipherment=False,
                                     key_agreement=False, key_cert_sign=False, crl_sign=False,
                                     encipher_only=False, decipher_only=False), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CLIENT_AUTH]), critical=False)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(issuer.public_key), critical=False)
    )
    return issuer.sign(builder)


def issue_server(issuer: KvCa, csr: x509.CertificateSigningRequest, dns_names: list[str],
                 lifetime: dt.timedelta) -> x509.Certificate:
    """TLS server certificate (MQTT custom domain or the enrolment endpoint)."""
    _check_csr(csr)
    for dns in dns_names:
        if not (dns == ZONE or dns.endswith("." + ZONE)):
            raise ValueError(f"{dns} is outside {ZONE}; the server CA is name-constrained to it.")
    now = utcnow()
    key = csr.public_key()
    builder = (
        x509.CertificateBuilder()
        .subject_name(name(dns_names[0], "IoT platform"))
        .issuer_name(issuer.subject)
        .public_key(key)
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - SKEW)
        .not_valid_after(now + lifetime)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False,
                                     key_encipherment=isinstance(key, rsa.RSAPublicKey), data_encipherment=False,
                                     key_agreement=False, key_cert_sign=False, crl_sign=False,
                                     encipher_only=False, decipher_only=False), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(d) for d in dns_names]), critical=False)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(issuer.public_key), critical=False)
    )
    return issuer.sign(builder)
