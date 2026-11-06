# pki

`infra/15-pki.ps1` fills this folder during the CA ceremony with the **public** certificates of your own certificate authority:

| File | What it is |
|---|---|
| `root-ca.pem` | Root CA certificate (its key is an RSA-HSM key in Key Vault Premium, disabled after signing the issuing CAs) |
| `device-ca.pem` | Device issuing CA — signs the machine and gateway certificates; uploaded to Event Grid as the CA certificate for client authentication |
| `server-ca.pem` | Server issuing CA — signs the MQTT endpoint certificate of the custom domain |
| `trust-bundle.pem` | Root + server issuing CA — what devices trust (the custom domain sends only the leaf certificate) |

`infra/17-site.ps1` copies `trust-bundle.pem` to the remote site. No private key ever exists here: the CA keys never leave the Key Vault HSM. The `.pem` files are git-ignored, because every deployment creates its own CA.
