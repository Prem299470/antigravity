# Cyber Shield AI

Advanced Digital Intelligence & Cybersecurity Suite.

**Live Demo**: [https://cybershieldssit.netlify.app](https://cybershieldssit.netlify.app)

## Overview
Cyber Shield AI is an all-in-one browser-based security command center designed for threat detection, network analysis, and emergency response.

## Key Features
- **Scam Detection**: AI-powered analysis of messages and emails.
- **Network Discovery**: Real-time surgical device scanning and signal visualization.
- **VPN**: WireGuard full-tunnel profiles for untrusted public Wi-Fi.
- **Live GPS Tracking**: Professional-grade coordinate smoothing and landmark intelligence.
- **Password Audit**: Offline-first secure password analysis.
- **Emergency Mode**: Instant lockdown and location broadcasting.
- **Shield Box AI**: Context-aware security copilot.

## Installation & Setup
1. Clone the repository.
2. For the best local experience, start the integrated local server (requires Node.js):
   ```bash
   node server.js
   ```
3. Open `http://127.0.0.1:4318` in your browser.
4. The **Wi-Fi Scanner** will now use the integrated local API and can show connected device names, IPs, MACs, and inferred device types while scanning your network.
5. The **VPN** page can verify the observed public exit IP plus local adapter IP, MAC, gateway, DNS, WireGuard adapter state, and WireGuard tunnel services. Each refresh also prints the same network snapshot in the `node server.js` terminal.

## Wi-Fi Scanner Notes
- The Wi-Fi scanner works fully only when the app is running locally through `server.js` or `start_cybershield.bat`.
- The hosted Netlify site cannot enumerate devices on your home Wi-Fi because browsers do not expose LAN neighbor tables to public websites.

## VPN: WireGuard Consumer Protection
The VPN section is now profile-driven and verification-first. It uses real WireGuard `.conf` profiles from `vpn-profiles/`, a local Node control plane on `127.0.0.1:4318`, and WireGuard for Windows to start or stop tunnel services. Do not rely on it as a phishing or malware shield; it protects network traffic in transit, not user decisions or compromised devices.

### Current Architecture
```text
Browser app
   ↓
Local API / control plane (node server.js on 127.0.0.1:4318)
   ↓
Local profile discovery and safety validation
   ↓
WireGuard for Windows tunnel service
   ↓
VPN server provisioned by setup-server.sh
   ↓
Internet
```

### Audit Summary
- **Technology stack**: static HTML/CSS/JavaScript frontend, Node.js local helper, PowerShell/Windows network inspection, Bash WireGuard server/client scripts, Netlify static deployment for hosted UI.
- **VPN protocol**: WireGuard. No custom cryptography is used.
- **Already working**: WireGuard server bootstrap, client profile generation, local profile discovery, public exit lookup, local adapter/DNS snapshot, one-click tunnel install/start/stop when running locally with the right privileges.
- **Hardened in the app**: the UI does not show Protected until a real profile, active WireGuard adapter/service, DNS configuration, IPv4 full tunnel, and IPv6 full tunnel are verified. Unsafe profiles are rejected before connection.
- **Known gaps**: production account/device revocation, subscription entitlements, a real kill switch, formal DNS leak enforcement, formal IPv6 leak enforcement, server health/load APIs, automated VPN integration tests, and cross-platform native clients are still future milestones.

### Files
- `setup-server.sh`: Ubuntu 22.04+ server setup for WireGuard, UFW, forwarding, and NAT.
- `generate-client.sh`: creates one unique client key pair, a full-tunnel `.conf`, and QR codes with `qrencode`.
- `vpn-profiles/`: local-only WireGuard client profiles used by the dashboard. `.conf` files are ignored by git because they contain private keys.
- `scripts/vpn-smoke-test.js`: local API smoke test for VPN profile safety and tunnel-control authorization.

### Local smoke test
```bash
node scripts/vpn-smoke-test.js
```

### Server setup
```bash
sudo chmod +x setup-server.sh generate-client.sh
sudo ./setup-server.sh
```

Optional environment variables:
```bash
WG_PORT=51820 WG_IPV4_CIDR=10.44.0.1/24 WG_IPV6_CIDR=fd42:44:44::1/64 ENDPOINT_HOST=vpn.example.com sudo -E ./setup-server.sh
```

### Client generation
```bash
sudo ./generate-client.sh alice vpn.example.com:51820
```

The generated client profile uses:
- `AllowedIPs = 0.0.0.0/0, ::/0` for a full tunnel.
- `DNS = 1.1.1.1, 9.9.9.9` by default.
- `PersistentKeepalive = 25` for NAT traversal and reliable roaming.

WireGuard's cryptographic suite is intentionally fixed: ChaCha20-Poly1305 for authenticated encryption, Curve25519 for key exchange, BLAKE2s for hashing, and HKDF for session-key derivation. WireGuard automatically rotates session keys during active sessions, normally every two minutes.

### Public Wi-Fi only
The safest operating model is to enable this profile only on untrusted networks. In the WireGuard mobile app, use on-demand activation rules for Wi-Fi networks you do not trust. On laptops, enable the tunnel manually when joining guest/public Wi-Fi and disconnect it on trusted home/work networks unless you intentionally want all traffic routed through the VPN server.

### Verifying the active route
Run the app through `node server.js`, open `http://127.0.0.1:4318`, choose a profile, and click **Connect**. The app starts the selected WireGuard tunnel service, refreshes the OS/network snapshot, and only then shows Protected. It logs a terminal line like:

```text
[Network Snapshot] public_ip=... adapter_ip=... mac=... gateway=... dns=... vpn_adapter=...
```

MAC addresses usually remain the local physical adapter's MAC when a VPN is connected. If Windows exposes a WireGuard/TUN adapter, Cyber Shield AI shows that adapter separately; otherwise the public IP change is the main proof that traffic is exiting through the VPN.

### One-click country profiles
For real country switching, add WireGuard client `.conf` files to `vpn-profiles/`. The local dashboard scans that folder and turns those profiles into selectable countries/cities. Click **Connect** to start the selected profile, then Cyber Shield AI verifies the observed public IP, country, adapter, MAC, gateway, DNS, and tunnel service state.

On Windows, install WireGuard first and run `node server.js` from an Administrator terminal so the app can start and stop WireGuard tunnel services. One-click tunnel control is intentionally blocked from hosted pages and `file://` pages; use `http://127.0.0.1:4318`.

Profiles must include:
```ini
AllowedIPs = 0.0.0.0/0, ::/0
DNS = 1.1.1.1, 9.9.9.9
```

If IPv6 is not supported by your VPN server yet, do not claim IPv6 leak protection in production. Either route IPv6 through WireGuard or add a real platform kill-switch/firewall rule to block IPv6 outside the tunnel.

### Security hardening checklist
- Disable password-based SSH login and use key-only SSH authentication.
- Install and configure `fail2ban` for brute-force protection.
- Keep server logs minimized for a no-logs posture; avoid storing connection metadata longer than operationally required.
- Keep Ubuntu and WireGuard packages updated with routine patching.
- Restrict UFW to SSH and the WireGuard UDP port, which `setup-server.sh` applies.
- Store generated client configs securely; each config contains a private key.
- Revoke lost devices by removing their `[Peer]` block from `/etc/wireguard/wg0.conf` and `/etc/wireguard/wg0.peers`, then run `sudo systemctl restart wg-quick@wg0`.

### Prioritized VPN Roadmap
1. Implement a real Windows kill switch with firewall rules tied to the WireGuard adapter and prove traffic is blocked on tunnel failure.
2. Add server health reporting for country/city/server status, capacity, load, latency, packet loss, and maintenance mode.
3. Add backend account, device registration, and device revocation so revoked profiles cannot reconnect.
4. Add automated integration tests for connect, disconnect, reconnect, unsafe profiles, network loss, DNS settings, IPv6 coverage, and helper authorization.
5. Add native packaging for the supported desktop/mobile targets instead of relying on a browser dashboard for VPN control.

### What this protects against
- Local Wi-Fi snooping on open or hostile hotspots.
- Packet tampering between your device and the VPN server.
- DNS queries leaking to the local hotspot when the client honors the VPN DNS setting.
- Captive or shared-network observers seeing destination traffic contents beyond encrypted tunnel metadata.

### What this does not protect against
- Phishing, scam messages, or fake login pages.
- Malware or spyware already running on the device.
- Tracking inside websites and apps after you log in.
- The VPN server operator or cloud host observing traffic that exits the VPN.
- Weak account security, reused passwords, or missing MFA.

## License
MIT License. See [LICENSING.md](LICENSING.md) for details.

## Impersonation Call Verification Protocol

### Core Principle
**Never send money based on a phone call alone, regardless of how urgent or convincing it sounds. Always verify through a second, independent channel before acting.**

### What This Tool Does
The Impersonation Call Verification module inside the Smart Investigation Engine helps protect against scam calls where a caller impersonates a known contact (friend, family member, boss, or colleague) and requests urgent money transfer. It combines:

1. **Caller ID / Number Cross-Check**: Compares the incoming number against your saved contact's verified number using the `phonenumbers` Python library to detect region, carrier, and VoIP mismatches that indicate caller ID spoofing.
2. **Challenge Question Protocol**: A locally-encrypted vault of pre-agreed safe words or challenge questions set up in advance with close family and friends. During a suspicious call, you can ask the question naturally to verify the caller's identity.
3. **Callback Verification with Cooldown**: When a money request is detected, the tool enforces a mandatory cooldown period and prompts you to hang up and call back on the person's saved number — not the number that just called you.
4. **Red Flag Checklist**: A rules-based checklist that automatically flags common scam indicators (urgency language, unusual payment methods, discouraging callbacks, failing safe word verification).
5. **Quick Actions**: One-tap buttons to call back on the saved number, report the number to authorities, or alert a trusted family member.

### Setting Up Safe Words with Family
Before you need this tool in an emergency, take 5 minutes to set up safe words:
1. Open the Smart Investigation Engine → Impersonation Verification tab.
2. Set a Master Password to protect your vault (this never leaves your device).
3. Add your close contacts with their verified phone number and a pre-agreed challenge question.
4. **In person or via a trusted channel**, agree on the safe word/question with each contact. Examples:
   - "What was the name of our childhood pet?"
   - "What restaurant did we eat at on your birthday last year?"
   - A random code word like "pineapple" that only you both know.
5. The answers are encrypted with AES-256-GCM and stored only on your device.

### Voice Cloning Warning
AI voice cloning can now convincingly mimic tone and speech patterns from just seconds of audio (e.g., scraped from social media videos). **Voice alone is NOT reliable proof of identity.** This tool deliberately does not claim to detect AI voice clones — reliable real-time voice deepfake detection is an unsolved research problem. Instead, this tool's defense is **procedural**: safe words and callback verification are far more effective than any algorithmic voice check.

### Payment Method Red Flags
Banks and legitimate family emergencies **never** require:
- Gift cards (Google Play, iTunes, Amazon) as payment
- Cryptocurrency transfers to unfamiliar wallets
- Wire transfers to unknown accounts
- Payment app transfers (Venmo, Zelle, UPI) to unfamiliar recipients

If someone insists on these payment methods during an "emergency," it is almost certainly a scam.

### Reporting
- **India**: [Sanchar Saathi](https://sancharsaathi.gov.in/) or call **1930** (Cybercrime Helpline)
- **USA**: [FTC ReportFraud.gov](https://reportfraud.ftc.gov/)
- **UK**: Action Fraud **0300 123 2040**
