#!/usr/bin/env python3
"""Makes stand-in signing files for tests: a certificate, its .p12 and a .mobileprovision.

They look like the real thing — "iPhone Developer: Created via API (...)", issued under
Apple's real WWDR G3 intermediate, a profile that allows exactly one app ID, a device
list, and a wildcard permission — but the key is a throwaway, so the certificate is not
trusted by Apple. That is enough to exercise the whole signing pipeline, the chain
embedding and the checker. Run from the repo root:

    PYTHONPATH=<folder with the 'cryptography' package> \
        python3 tools/make-test-fixtures.py <folder with AppleWWDRCAG3.cer>
"""
import datetime, plistlib, sys, pathlib, uuid
from cryptography import x509
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID, ObjectIdentifier
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12, BestAvailableEncryption

cas = pathlib.Path(sys.argv[1])
out = pathlib.Path(__file__).resolve().parent.parent / "Packages/SignKit/Tests/SignKitTests/Fixtures"

g3 = x509.load_der_x509_certificate((cas / "AppleWWDRCAG3.cer").read_bytes())
g3_ski = g3.extensions.get_extension_for_class(x509.SubjectKeyIdentifier).value

TEAM = "3KQD4FN5YL"
key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
now = datetime.datetime(2026, 3, 7, 12, 0, 0)
subject = x509.Name([
    x509.NameAttribute(NameOID.USER_ID, "A1B2C3D4E5"),
    x509.NameAttribute(NameOID.COMMON_NAME, "iPhone Developer: Created via API (" + TEAM + ")"),
    x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, TEAM),
    x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Stand-in Test Team"),
    x509.NameAttribute(NameOID.COUNTRY_NAME, "US"),
])
cert = (x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(g3.subject)
        .public_key(key.public_key())
        .serial_number(int.from_bytes(uuid.uuid4().bytes[:12], "big"))
        .not_valid_before(now)
        .not_valid_after(now.replace(year=2027))
        .add_extension(x509.AuthorityKeyIdentifier(g3_ski.digest, None, None), critical=False)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .add_extension(x509.KeyUsage(True, False, False, False, False, False, False, False, False), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CODE_SIGNING]), critical=True)
        .add_extension(x509.AuthorityInformationAccess([
            x509.AccessDescription(x509.oid.AuthorityInformationAccessOID.OCSP,
                                   x509.UniformResourceIdentifier("http://ocsp.apple.com/ocsp03-wwdrg301")),
        ]), critical=False)
        .sign(rsa.generate_private_key(public_exponent=65537, key_size=2048), hashes.SHA256()))

# Two .p12 flavours: the old Triple-DES kind Apple's Keychain makes, and the modern AES kind.
legacy = (serialization.PrivateFormat.PKCS12.encryption_builder()
          .kdf_rounds(2048)
          .key_cert_algorithm(pkcs12.PBES.PBESv1SHA1And3KeyTripleDESCBC)
          .hmac_hash(hashes.SHA1()).build(b"hunter2"))
(out / "standin.p12").write_bytes(pkcs12.serialize_key_and_certificates(
    b"stand-in", key, cert, None, legacy))
(out / "standin-aes.p12").write_bytes(pkcs12.serialize_key_and_certificates(
    b"stand-in", key, cert, None, BestAvailableEncryption(b"hunter2")))

# A profile that allows exactly one app ID, lists one phone, and carries a wildcard grant.
bundle = "app.sweetpotato2703.cancer3985"
profile = {
    "AppIDName": "Stand-in App",
    "ApplicationIdentifierPrefix": [TEAM],
    "CreationDate": datetime.datetime(2026, 3, 7, 12, 5, 0),
    "ExpirationDate": datetime.datetime(2027, 3, 7, 12, 5, 0),
    "DeveloperCertificates": [cert.public_bytes(serialization.Encoding.DER)],
    "Entitlements": {
        "application-identifier": TEAM + "." + bundle,
        "com.apple.developer.team-identifier": TEAM,
        "get-task-allow": True,
        "keychain-access-groups": [TEAM + ".*"],
        "com.apple.developer.associated-domains": "*",
    },
    "Name": "Stand-in Development Profile",
    "Platform": ["iOS"],
    "ProvisionedDevices": ["00008110-000A1B2C3D4E901E"],
    "TeamIdentifier": [TEAM],
    "TeamName": "Stand-in Test Team",
    "TimeToLive": 365,
    "UUID": str(uuid.uuid4()).upper(),
    "Version": 1,
}
(out / "standin.mobileprovision").write_bytes(plistlib.dumps(profile))
print("wrote standin.p12, standin-aes.p12 and standin.mobileprovision to", out)
print("leaf issuer matches WWDR G3 subject:", cert.issuer == g3.subject)
