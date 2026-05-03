// CyberShield Wi-Fi Device Discovery API — v3 (Accurate)
// STRICT: only scans the actual Wi-Fi adapter's subnet.
// NO DNS cache, NO netstat (they return internet IPs, not local devices).

const http   = require('node:http');
const dns    = require('node:dns').promises;
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const os     = require('node:os');

const execFileAsync = promisify(execFile);

const HOST         = '127.0.0.1';
const PORT         = Number(process.env.WIFI_API_PORT || 4318);
const CACHE_TTL_MS = 25000;   // 25 s cache — avoids hammering on every click

let cachedSnapshot = null;
let cachedAt       = 0;

// ─── Utilities ─────────────────────────────────────────────────────────────

function sendJson(res, code, body) {
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(body));
}

function timeout(ms) {
    return new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), ms)
    );
}

function race(promise, ms) {
    return Promise.race([promise, timeout(ms)]);
}

async function ps(script) {
    try {
        const { stdout } = await execFileAsync(
            'powershell',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
            { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }
        );
        return stdout.trim();
    } catch { return ''; }
}

// Convert IP string to 32-bit int
function ipToInt(ip) {
    const p = String(ip || '').split('.').map(Number);
    if (p.length !== 4 || p.some(n => isNaN(n) || n < 0 || n > 255)) return null;
    return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

// Check if ip is in subnet defined by subnetIp/prefixLen
function inSubnet(ip, subnetIp, prefixLen) {
    const ipInt = ipToInt(ip);
    const snInt = ipToInt(subnetIp);
    if (ipInt === null || snInt === null) return false;
    const mask = prefixLen === 0 ? 0 : (0xFFFFFFFF << (32 - prefixLen)) >>> 0;
    return (ipInt & mask) === (snInt & mask);
}

// Is this a multicast / broadcast / reserved IP?
function isSpecialIp(ip) {
    return /^(224\.|239\.|255\.|127\.|0\.|169\.254\.)/.test(ip);
}

// Is this a locally-administered (randomised) MAC?
function isLocalMAC(mac) {
    const norm = String(mac || '').replace(/[^0-9a-fA-F]/g, '');
    if (norm.length < 2) return false;
    return (parseInt(norm.slice(0, 2), 16) & 0x02) !== 0;
}

// ─── Step 1: Identify the PRIMARY Wi-Fi interface ──────────────────────────
async function getPrimaryInterface() {
    const raw = await ps(`
        $best = $null
        $priority = 999

        Get-NetAdapter | Where-Object Status -eq Up | ForEach-Object {
            $a = $_
            $cfg = Get-NetIPConfiguration -InterfaceIndex $a.ifIndex -ErrorAction SilentlyContinue
            $ip4 = $cfg.IPv4Address | Where-Object { $_.IPAddress -notmatch '^169\\.254\\.' } | Select-Object -First 1
            $gw  = $cfg.IPv4DefaultGateway | Select-Object -First 1

            if (-not $ip4) { return }

            # Score: real Wi-Fi=1, has-gateway-Ethernet=2, any-other=3
            $score = 3
            if ($a.NdisPhysicalMedium -eq 9 -or $a.Name -match 'Wi.?Fi|Wireless|WLAN') { $score = 1 }
            elseif ($gw) { $score = 2 }

            # Prefer lowest score, then highest ifIndex (most recently added)
            if ($score -lt $priority -or ($score -eq $priority -and $a.ifIndex -gt $best.ifIndex)) {
                $priority = $score
                $best = [PSCustomObject]@{
                    ifIndex     = $a.ifIndex
                    name        = $a.Name
                    desc        = $a.InterfaceDescription
                    mac         = $a.MacAddress
                    ip          = $ip4.IPAddress
                    prefix      = $ip4.PrefixLength
                    gateway     = if ($gw) { $gw.NextHop } else { $null }
                    isWifi      = ($score -eq 1)
                    medium      = $a.NdisPhysicalMedium
                }
            }
        }

        if ($best) { $best | ConvertTo-Json -Compress } else { '{}' }
    `);
    try { return JSON.parse(raw) || {}; } catch { return {}; }
}

// ─── Step 2: WLAN signal info ──────────────────────────────────────────────
async function getWlanInfo() {
    const raw = await ps(`netsh wlan show interfaces | Out-String`);
    const get = label => {
        const m = raw.match(new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, 'im'));
        return m ? m[1].trim() : null;
    };
    return {
        ssid:         get('SSID') || get('Profile'),
        bssid:        get('AP BSSID'),
        signal:       get('Signal'),
        band:         get('Band'),
        radioType:    get('Radio type'),
        channel:      get('Channel'),
        receiveRate:  get('Receive rate \\(Mbps\\)'),
        transmitRate: get('Transmit rate \\(Mbps\\)')
    };
}

// ─── Step 3: Ping sweep — ONLY the adapter's /prefix subnet ───────────────
async function pingSweep(myIp, prefixLen) {
    const ipInt  = ipToInt(myIp);
    if (ipInt === null) return;

    // Only sweep /16 through /30 — skip huge enterprise /8 nets
    const clampedPrefix = Math.max(16, Math.min(30, prefixLen));
    const hostBits = 32 - clampedPrefix;
    const count    = Math.min(254, (1 << hostBits) - 2); // max 254 hosts
    const mask     = (0xFFFFFFFF << hostBits) >>> 0;
    const network  = (ipInt & mask) >>> 0;

    const targets = [];
    for (let i = 1; i <= 254 && targets.length < count; i++) {
        const candidate = (network | i) >>> 0;
        if (candidate === ipInt) continue;
        targets.push([candidate >> 24 & 255, candidate >> 16 & 255, candidate >> 8 & 255, candidate & 255].join('.'));
    }

    // Fire in batches of 40 simultaneous pings
    const BATCH = 40;
    for (let i = 0; i < targets.length; i += BATCH) {
        await Promise.all(
            targets.slice(i, i + BATCH).map(ip =>
                race(
                    execFileAsync('ping.exe', ['-n', '1', '-w', '250', ip], { windowsHide: true, maxBuffer: 4096 }),
                    700
                ).catch(() => {})
            )
        );
    }
}

// ─── Step 4: Read ARP table — ONLY for the target interface ───────────────
async function getArpForInterface(ifIndex, myIp, prefixLen) {
    const raw = await ps(`
        Get-NetNeighbor -InterfaceIndex ${ifIndex} -AddressFamily IPv4 |
        Where-Object {
            $_.LinkLayerAddress -and
            $_.LinkLayerAddress -ne 'FF-FF-FF-FF-FF-FF' -and
            $_.LinkLayerAddress -ne '00-00-00-00-00-00' -and
            ([string]$_.State) -notin @('Invalid','Unreachable','Permanent')
        } |
        Group-Object IPAddress |
        ForEach-Object { $_.Group | Sort-Object { @('Reachable','Stale','Probe','Delay').IndexOf([string]$_.State) } | Select-Object -First 1 } |
        Select-Object IPAddress, LinkLayerAddress, State |
        ConvertTo-Json -Compress
    `);

    let list = [];
    try {
        const parsed = JSON.parse(raw);
        list = Array.isArray(parsed) ? parsed : (parsed && parsed.IPAddress ? [parsed] : []);
    } catch { return []; }

    // Strict subnet filter — only IPs that truly belong to this interface's subnet
    return list
        .filter(d =>
            d.IPAddress &&
            !isSpecialIp(d.IPAddress) &&
            inSubnet(d.IPAddress, myIp, prefixLen)
        )
        .map(d => ({
            ip:    d.IPAddress,
            mac:   d.LinkLayerAddress || 'Unknown',
            state: d.State || 'Discovered'
        }));
}

// ─── Step 5: Name resolution (parallel, per device) ───────────────────────
async function resolveHostname(ip) {
    // Method A: NetBIOS
    try {
        const { stdout } = await race(
            execFileAsync('nbtstat.exe', ['-A', ip], { windowsHide: true, maxBuffer: 32768 }),
            1800
        );
        const m = stdout.match(/^\s*([^\s<][^<]{0,14})<00>\s+UNIQUE\s+Registered/im);
        if (m) return m[1].trim();
    } catch {}

    // Method B: Reverse DNS
    try {
        const names = await race(dns.reverse(ip), 500);
        if (names && names.length) return names[0].split('.')[0];
    } catch {}

    // Method C: Ping -a (Windows name resolution)
    try {
        const { stdout } = await race(
            execFileAsync('ping.exe', ['-a', '-n', '1', '-w', '200', ip], { windowsHide: true, maxBuffer: 8192 }),
            1200
        );
        const m = stdout.match(/Pinging\s+([^\s\[]+)\s+\[/i);
        if (m) {
            const name = m[1].trim();
            if (!/^\d+\.\d+\.\d+\.\d+$/.test(name)) return name.split('.')[0];
        }
    } catch {}

    return null;
}

// ─── Step 6: MAC vendor lookup ─────────────────────────────────────────────
const vendorCache = new Map();
async function getVendor(mac) {
    if (!mac || mac === 'Unknown') return null;
    const oui = mac.replace(/[^0-9a-fA-F]/g, '').slice(0, 6).toUpperCase();
    if (oui.length < 6) return null;
    if (vendorCache.has(oui)) return vendorCache.get(oui);

    // Try maclookup.app
    try {
        const r = await race(fetch(`https://api.maclookup.app/v2/macs/${mac}`), 2500);
        if (r.ok) {
            const j = await r.json();
            if (j && j.found && j.company) {
                const name = j.company
                    .replace(/,?\s*(inc\.?|ltd\.?|llc|corp\.?|corporation|limited|co\.,?\s*ltd\.?)$/i, '')
                    .trim();
                vendorCache.set(oui, name);
                return name;
            }
        }
    } catch {}

    vendorCache.set(oui, null);
    return null;
}

// ─── Step 7: Guess device type ─────────────────────────────────────────────
function guessType(name, vendor, role) {
    const s = `${name || ''} ${vendor || ''}`.toLowerCase();
    if (role === 'gateway')     return { type: 'Router / Gateway',    icon: '🌐' };
    if (role === 'self')        return { type: 'This PC',             icon: '💻' };
    if (/iphone|ipad/.test(s)) return { type: 'iPhone / iPad',       icon: '📱' };
    if (/android|samsung|xiaomi|redmi|poco|oneplus|oppo|vivo|realme|huawei/.test(s))
                                return { type: 'Android Phone',       icon: '📱' };
    if (/macbook|imac|mac mini/.test(s)) return { type: 'Mac',       icon: '💻' };
    if (/tv|roku|firetv|chromecast|shield|bravia|vizio/.test(s))
                                return { type: 'Smart TV',            icon: '📺' };
    if (/printer|hp.*laser|canon|epson|brother/.test(s))
                                return { type: 'Printer',             icon: '🖨️' };
    if (/raspberry/.test(s))   return { type: 'Raspberry Pi',        icon: '🖥️' };
    if (/esp32|esp8266|arduino|nodemcu/.test(s))
                                return { type: 'IoT Device',          icon: '📡' };
    if (/camera|cam|hikvision|dahua/.test(s))
                                return { type: 'IP Camera',           icon: '📷' };
    if (/sonos|bose|speaker/.test(s))
                                return { type: 'Smart Speaker',       icon: '🔊' };
    if (/apple/.test(s))       return { type: 'Apple Device',         icon: '🍎' };
    if (/intel|realtek/.test(s)) return { type: 'PC / Laptop',       icon: '💻' };
    if (/tp-link|netgear|asus.*rt|linksys|dlink|zyxel|ubiquiti/.test(s))
                                return { type: 'Access Point',        icon: '📡' };
    if (/microsoft|windows/.test(s)) return { type: 'Windows PC',    icon: '🖥️' };
    if (isLocalMAC(mac => mac)) return { type: 'Randomized MAC Device', icon: '📱' };
    return { type: 'Unknown Device', icon: '❓' };
}

// ─── MAIN SCAN ─────────────────────────────────────────────────────────────
async function fullScan(forceRefresh) {
    if (!forceRefresh && cachedSnapshot && (Date.now() - cachedAt) < CACHE_TTL_MS) {
        return cachedSnapshot;
    }

    if (forceRefresh) vendorCache.clear();

    // 1. Get primary interface
    const iface = await getPrimaryInterface();
    if (!iface.ifIndex || !iface.ip) {
        return {
            ok: false,
            error: 'No active network adapter found.',
            devices: [],
            totalFound: 0,
            network: {}
        };
    }

    const myIp     = iface.ip;
    const prefix   = iface.prefix || 24;
    const ifIndex  = iface.ifIndex;
    const gateway  = iface.gateway;

    // 2. Get WLAN info in parallel with ping sweep
    const [wlanInfo] = await Promise.all([
        getWlanInfo(),
        pingSweep(myIp, prefix)   // populates ARP table while we get WLAN info
    ]);

    // 3. Read ARP table — ONLY for this interface, filtered to subnet
    const arpDevices = await getArpForInterface(ifIndex, myIp, prefix);

    // 4. Enrich each real device with name + vendor (parallel)
    const enriched = await Promise.all(
        arpDevices.map(async device => {
            const isGateway = gateway && device.ip === gateway;
            const role = isGateway ? 'gateway' : 'client';

            // Parallel name + vendor
            const [hostname, vendor] = await Promise.all([
                resolveHostname(device.ip),
                getVendor(device.mac)
            ]);

            let name = hostname;
            if (!name) {
                if (isGateway)     name = vendor ? `${vendor} Router` : 'Network Router';
                else if (vendor)   name = `${vendor} Device`;
                else               name = `Device (${device.ip})`;
            }

            const deviceInfo = guessType(name, vendor, role);

            return {
                ip:    device.ip,
                mac:   device.mac,
                name,
                vendor: vendor || null,
                role,
                state: device.state,
                deviceInfo
            };
        })
    );

    // Sort: gateway first, then by last octet
    enriched.sort((a, b) => {
        if (a.role === 'gateway') return -1;
        if (b.role === 'gateway') return 1;
        const aLast = Number(a.ip.split('.').pop()) || 0;
        const bLast = Number(b.ip.split('.').pop()) || 0;
        return aLast - bLast;
    });

    const result = {
        ok: true,
        scannedAt: new Date().toISOString(),
        network: {
            ssid:         wlanInfo.ssid    || iface.name,
            bssid:        wlanInfo.bssid,
            signal:       wlanInfo.signal,
            band:         wlanInfo.band,
            radioType:    wlanInfo.radioType,
            channel:      wlanInfo.channel,
            receiveRate:  wlanInfo.receiveRate,
            transmitRate: wlanInfo.transmitRate,
            myIp,
            myMac:        iface.mac,
            gateway,
            adapterName:  iface.name,
            subnet:       `${myIp}/${prefix}`
        },
        thisDevice: {
            name: os.hostname(),
            ip:   myIp,
            mac:  iface.mac,
            role: 'self'
        },
        devices:    enriched,
        totalFound: enriched.length,
        scanTechniques: [
            `ARP (ifIndex=${ifIndex})`,
            'Ping sweep (subnet only)',
            'NetBIOS',
            'Reverse DNS',
            'Ping -a',
            'MAC vendor API'
        ]
    };

    cachedSnapshot = result;
    cachedAt = Date.now();
    return result;
}

// ─── HTTP Server ───────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { sendJson(res, 204, {}); return; }

    const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);

    if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true, service: 'wifi-api-server', port: PORT, version: '3.0-accurate' });
        return;
    }

    if (req.method === 'GET' && url.pathname === '/api/wifi/devices') {
        try {
            const force = url.searchParams.get('refresh') === '1';
            if (force) { cachedSnapshot = null; cachedAt = 0; }
            const data = await fullScan(force);
            sendJson(res, 200, data);
        } catch (err) {
            sendJson(res, 500, { ok: false, error: err?.message || 'Scan failed' });
        }
        return;
    }

    sendJson(res, 404, { ok: false, error: 'Not found' });
});

server.listen(PORT, HOST, () => {
    console.log(`[CyberShield Wi-Fi API v3] http://${HOST}:${PORT}`);
    console.log(`[Accurate] Only scans primary adapter's subnet — no DNS cache, no netstat.`);
});
