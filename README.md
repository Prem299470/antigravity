# Cyber Shield AI

Advanced Digital Intelligence & Cybersecurity Suite.

**Live Demo**: [https://cybershieldssit.netlify.app](https://cybershieldssit.netlify.app)

## Overview
Cyber Shield AI is an all-in-one browser-based security command center designed for threat detection, network analysis, and emergency response.

## Key Features
- **Scam Detection**: AI-powered analysis of messages and emails.
- **Network Discovery**: Real-time surgical device scanning and signal visualization.
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

## Wi-Fi Scanner Notes
- The Wi-Fi scanner works fully only when the app is running locally through `server.js` or `start_cybershield.bat`.
- The hosted Netlify site cannot enumerate devices on your home Wi-Fi because browsers do not expose LAN neighbor tables to public websites.

## License
MIT License. See [LICENSING.md](LICENSING.md) for details.
