# Part 2 — Prepare your computer

[Documentation index](README.md) · [← Part 1 — How the demo works](part-01-how-the-demo-works.md) · [Part 3 — Build the networks and the VPN →](part-03-networks-and-vpn.md)

## 2.1 Install the tools

1. Install the **Azure CLI**: open https://aka.ms/installazurecliwindows, run the installer, accept the defaults.
2. Install **Python 3.12** from https://www.python.org/downloads/ — tick **Add python.exe to PATH** on the first screen.
3. Open a new **PowerShell** window and check both: `az version` and `python --version`.

## 2.2 Get the project folder

Copy the folder **secure-iot-azure-eventgrid-mqtt** to your PC. It contains:

| Folder | Contents |
|---|---|
| `infra\` | The numbered build scripts `01`–`23`, the test `90-test.ps1`, `env.ps1` (all names in one place) and `lib-vm.ps1` |
| `ops\certsvc\` | The certificate service and the CA code (Python) |
| `ops\app\` | The operator web app (Node.js) |
| `ops\config\` | systemd units and nginx configuration for vm-ops |
| `site\agent\` | The site agent and the machine agent (Python) |
| `pki\` | The **public** Contoso CA certificates and `trust-bundle.pem` (no private keys anywhere in the folder) |
| `tests\` | The end-to-end tests run by `90-test.ps1` |
| `architecture\`, `docs\` | Diagrams, this guide, the cost model |

## 2.3 Sign in

*PowerShell*

```powershell
az login
az account set --subscription "your-subscription"
az account show --query "{name:name, user:user.name}" -o table
```

> [!IMPORTANT]
> **Checkpoint — do not continue until this is true**
>
> `az account show` prints the subscription name and your user name.

> [!TIP]
> **Keep secrets outside the project folder**
>
> Two scripts ask for a file path for a secret: the VPN pre-shared key (`-PskFile`) and the operator password (`-PasswordFile`). Point both at a folder outside the project, for example `C:\iot-secrets\`. The scripts create the files if they do not exist.

---

[Documentation index](README.md) · [← Part 1 — How the demo works](part-01-how-the-demo-works.md) · [Part 3 — Build the networks and the VPN →](part-03-networks-and-vpn.md)
