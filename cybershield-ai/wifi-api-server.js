// CyberShield Wi-Fi Device Discovery API — v3 (Accurate)
// STRICT: only scans the actual Wi-Fi adapter's subnet.
// NO DNS cache, NO netstat (they return internet IPs, not local devices).

const http   = require('node:http');
const dns    = require('node:dns').promises;
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const os     = require('node:os');
const fs     = require('node:fs');
const path   = require('node:path');

const execFileAsync = promisify(execFile);

const HOST         = '127.0.0.1';
const PORT         = Number(process.env.WIFI_API_PORT || 4318);
const CACHE_TTL_MS = 25000;   // 25 s cache — avoids hammering on every click
const VPN_PROFILE_DIR = path.resolve(__dirname, 'vpn-profiles');

let cachedSnapshot = null;
let cachedAt       = 0;
let cachedNetworkSnapshot = null;
let cachedNetworkSnapshotAt = 0;

// ─── Utilities ─────────────────────────────────────────────────────────────

function sendJson(res, code, body) {
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-CyberShield-Local-Control',
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

function normalizeMac(mac) {
    const norm = String(mac || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
    if (norm.length !== 12) return null;
    return norm.match(/.{2}/g).join('-');
}

function sanitizeLogValue(value) {
    return String(value || 'Unavailable').replace(/[\r\n]+/g, ' ').trim();
}

function endpointHost(endpoint) {
    const value = String(endpoint || '').trim();
    if (!value) return '';
    if (value.startsWith('[')) {
        const match = value.match(/^\[([^\]]+)\](?::\d+)?$/);
        return match ? match[1] : '';
    }
    return value.replace(/:\d+$/, '');
}

function parsePingLatency(raw) {
    const text = String(raw || '');
    const windowsMatch = text.match(/Average\s*=\s*(\d+)\s*ms/i);
    if (windowsMatch) return Number(windowsMatch[1]);
    const unixMatch = text.match(/=\s*[\d.]+\/([\d.]+)\/[\d.]+\/[\d.]+\s*ms/i);
    if (unixMatch) return Math.round(Number(unixMatch[1]));
    return null;
}

async function measureEndpointLatency(endpoint) {
    const host = endpointHost(endpoint);
    if (!host) return null;

    const command = process.platform === 'win32' ? 'ping.exe' : 'ping';
    const args = process.platform === 'win32'
        ? ['-n', '2', '-w', '1000', host]
        : ['-c', '2', '-W', '1', host];

    try {
        const { stdout } = await execFileAsync(command, args, {
            windowsHide: true,
            timeout: 3500,
            maxBuffer: 128 * 1024
        });
        const latency = parsePingLatency(stdout);
        return Number.isFinite(latency) ? latency : null;
    } catch {
        return null;
    }
}

function profileWarnings(profile) {
    const warnings = [];
    if (!profile.fullTunnelIpv4) warnings.push('Profile does not route all IPv4 traffic.');
    if (!profile.fullTunnelIpv6) warnings.push('Profile does not route all IPv6 traffic.');
    if (!profile.dnsConfigured) warnings.push('Profile does not configure tunnel DNS.');
    return warnings;
}

async function enrichVpnProfiles(profiles) {
    return Promise.all(profiles.map(async profile => {
        const latencyMs = await measureEndpointLatency(profile.endpoint);
        const health = latencyMs === null ? 'unknown' : 'healthy';
        return {
            ...profile,
            latencyMs,
            health,
            healthReason: latencyMs === null
                ? 'Endpoint did not return an ICMP latency sample; this does not always mean the VPN is offline.'
                : `Endpoint ICMP average ${latencyMs} ms.`,
            warnings: profileWarnings(profile),
            consumerReady: profile.fullTunnelIpv4 && profile.fullTunnelIpv6 && profile.dnsConfigured
        };
    }));
}

function isLoopbackOrigin(origin) {
    if (!origin) return true;
    if (origin === 'null') return false;
    try {
        const parsed = new URL(origin);
        return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname);
    } catch {
        return false;
    }
}

function isVpnControlRequestAllowed(req) {
    if (process.env.CYBERSHIELD_ALLOW_REMOTE_VPN_CONTROL === '1') return true;
    if (req.headers['x-cybershield-local-control'] !== '1') return false;
    return isLoopbackOrigin(req.headers.origin);
}

async function getPublicExitInfo() {
    const providers = [
        async () => {
            const res = await race(fetch('https://ipwho.is/'), 5000);
            if (!res.ok) throw new Error('ipwho.is failed');
            const data = await res.json();
            if (!data || data.success === false || !data.ip) throw new Error('ipwho.is returned no IP');
            return {
                ip: data.ip,
                country: data.country || null,
                region: data.region || null,
                city: data.city || null,
                org: data.connection && data.connection.org ? data.connection.org : null,
                isp: data.connection && data.connection.isp ? data.connection.isp : null,
                source: 'ipwho.is'
            };
        },
        async () => {
            const res = await race(fetch('https://ipapi.co/json/'), 5000);
            if (!res.ok) throw new Error('ipapi.co failed');
            const data = await res.json();
            if (!data || !data.ip) throw new Error('ipapi.co returned no IP');
            return {
                ip: data.ip,
                country: data.country_name || null,
                region: data.region || null,
                city: data.city || null,
                org: data.org || null,
                isp: data.org || null,
                source: 'ipapi.co'
            };
        },
        async () => {
            const res = await race(fetch('https://api.ipify.org?format=json'), 4000);
            if (!res.ok) throw new Error('ipify failed');
            const data = await res.json();
            if (!data || !data.ip) throw new Error('ipify returned no IP');
            return {
                ip: data.ip,
                country: null,
                region: null,
                city: null,
                org: null,
                isp: null,
                source: 'api.ipify.org'
            };
        }
    ];

    for (const provider of providers) {
        try {
            return await provider();
        } catch {}
    }

    return {
        ip: null,
        country: null,
        region: null,
        city: null,
        org: null,
        isp: null,
        source: 'unavailable'
    };
}

async function getWireGuardStatus() {
    const raw = await ps(`
        $adapters = Get-NetAdapter -ErrorAction SilentlyContinue |
            Where-Object { $_.Status -eq 'Up' -and ($_.Name -match 'WireGuard|wg|VPN|Tunnel|TAP|TUN' -or $_.InterfaceDescription -match 'WireGuard|VPN|Tunnel|TAP|TUN') } |
            ForEach-Object {
                $cfg = Get-NetIPConfiguration -InterfaceIndex $_.ifIndex -ErrorAction SilentlyContinue
                [PSCustomObject]@{
                    ifIndex = $_.ifIndex
                    name = $_.Name
                    desc = $_.InterfaceDescription
                    mac = $_.MacAddress
                    ipv4 = @($cfg.IPv4Address | Where-Object { $_.IPAddress -notmatch '^169\\.254\\.' } | Select-Object -ExpandProperty IPAddress)
                    ipv6 = @($cfg.IPv6Address | Where-Object { $_.IPAddress -notmatch '^fe80:' } | Select-Object -ExpandProperty IPAddress)
                    gateway = @($cfg.IPv4DefaultGateway | Select-Object -ExpandProperty NextHop)
                    dnsServers = @($cfg.DNSServer.ServerAddresses)
                }
            }
        $adapters | ConvertTo-Json -Compress -Depth 4
    `);

    let adapters = [];
    try {
        const parsed = JSON.parse(raw);
        adapters = Array.isArray(parsed) ? parsed : (parsed && parsed.name ? [parsed] : []);
    } catch {
        adapters = [];
    }

    return {
        active: adapters.length > 0,
        adapters: adapters.map(adapter => ({
            ifIndex: adapter.ifIndex || null,
            name: adapter.name || null,
            desc: adapter.desc || null,
            mac: normalizeMac(adapter.mac) || adapter.mac || null,
            ipv4: Array.isArray(adapter.ipv4) ? adapter.ipv4 : (adapter.ipv4 ? [adapter.ipv4] : []),
            ipv6: Array.isArray(adapter.ipv6) ? adapter.ipv6 : (adapter.ipv6 ? [adapter.ipv6] : []),
            gateway: Array.isArray(adapter.gateway) ? adapter.gateway[0] || null : adapter.gateway || null,
            dnsServers: Array.isArray(adapter.dnsServers) ? adapter.dnsServers : (adapter.dnsServers ? [adapter.dnsServers] : [])
        }))
    };
}

function ensureVpnProfileDir() {
    fs.mkdirSync(VPN_PROFILE_DIR, { recursive: true });
}

function isPathInside(childPath, parentPath) {
    const relative = path.relative(parentPath, childPath);
    return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function safeTunnelName(name) {
    return String(name || '')
        .replace(/\.conf$/i, '')
        .replace(/[^a-zA-Z0-9_.-]/g, '-')
        .slice(0, 64) || 'cybershield-vpn';
}

function inferCountryFromName(name) {
    const text = String(name || '').toLowerCase();
    const matches = [
        ['ch', 'Switzerland'], ['switzerland', 'Switzerland'], ['zurich', 'Switzerland'],
        ['de', 'Germany'], ['germany', 'Germany'], ['frankfurt', 'Germany'],
        ['gb', 'United Kingdom'], ['uk', 'United Kingdom'], ['london', 'United Kingdom'],
        ['us', 'United States'], ['usa', 'United States'], ['ashburn', 'United States'], ['sanjose', 'United States'],
        ['sg', 'Singapore'], ['singapore', 'Singapore'],
        ['jp', 'Japan'], ['japan', 'Japan'], ['tokyo', 'Japan'],
        ['au', 'Australia'], ['australia', 'Australia'], ['sydney', 'Australia'],
        ['in', 'India'], ['india', 'India'], ['bengaluru', 'India'], ['mumbai', 'India']
    ];
    const found = matches.find(([needle]) => new RegExp(`(^|[^a-z])${needle}([^a-z]|$)`).test(text));
    return found ? found[1] : 'Unknown';
}

function readWireGuardProfile(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split(/\r?\n/);
    const getValue = key => {
        const line = lines.find(item => item.trim().toLowerCase().startsWith(key.toLowerCase() + ' ='));
        return line ? line.split('=').slice(1).join('=').trim() : null;
    };
    const getComment = key => {
        const re = new RegExp(`^\\s*#\\s*${key}\\s*:\\s*(.+)$`, 'i');
        const line = lines.find(item => re.test(item));
        const match = line && line.match(re);
        return match ? match[1].trim() : null;
    };

    const parsed = path.parse(filePath);
    const id = parsed.name;
    const tunnelName = parsed.name;
    const endpoint = getValue('Endpoint');
    const address = getValue('Address');
    const dnsServers = (getValue('DNS') || '').split(',').map(item => item.trim()).filter(Boolean);
    const allowedIps = (getValue('AllowedIPs') || '').split(',').map(item => item.trim()).filter(Boolean);
    const fullTunnelIpv4 = allowedIps.includes('0.0.0.0/0');
    const fullTunnelIpv6 = allowedIps.includes('::/0');
    const dnsConfigured = dnsServers.length > 0;
    const country = getComment('Country') || inferCountryFromName(parsed.name);
    const city = getComment('City') || getComment('Location') || '';
    const displayName = getComment('Name') || [country, city].filter(Boolean).join(' - ') || parsed.name;

    return {
        id,
        tunnelName,
        fileName: parsed.base,
        name: displayName,
        country,
        city,
        endpoint,
        address,
        dnsServers,
        allowedIps,
        fullTunnel: fullTunnelIpv4 && fullTunnelIpv6,
        fullTunnelIpv4,
        fullTunnelIpv6,
        dnsConfigured,
        path: filePath
    };
}

function listVpnProfiles() {
    ensureVpnProfileDir();
    const profiles = fs.readdirSync(VPN_PROFILE_DIR, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.conf'))
        .map(entry => readWireGuardProfile(path.join(VPN_PROFILE_DIR, entry.name)))
        .sort((a, b) => a.name.localeCompare(b.name));

    return {
        ok: true,
        profileDir: VPN_PROFILE_DIR,
        profiles: profiles.map(profile => ({
            id: profile.id,
            tunnelName: profile.tunnelName,
            fileName: profile.fileName,
            name: profile.name,
            country: profile.country,
            city: profile.city,
            endpoint: profile.endpoint,
            address: profile.address,
            dnsServers: profile.dnsServers,
            allowedIps: profile.allowedIps,
            fullTunnel: profile.fullTunnel,
            fullTunnelIpv4: profile.fullTunnelIpv4,
            fullTunnelIpv6: profile.fullTunnelIpv6,
            dnsConfigured: profile.dnsConfigured,
            warnings: profileWarnings(profile),
            consumerReady: profile.fullTunnelIpv4 && profile.fullTunnelIpv6 && profile.dnsConfigured
        }))
    };
}

function getVpnProfileById(id) {
    ensureVpnProfileDir();
    const fileName = String(id || '').endsWith('.conf') ? String(id) : String(id || '') + '.conf';
    const profilePath = path.resolve(VPN_PROFILE_DIR, fileName);
    if (!isPathInside(profilePath, VPN_PROFILE_DIR)) return null;
    if (!fs.existsSync(profilePath)) return null;
    return readWireGuardProfile(profilePath);
}

function findWireGuardExe() {
    const candidates = [
        process.env.WIREGUARD_EXE,
        'C:\\Program Files\\WireGuard\\wireguard.exe',
        'C:\\Program Files (x86)\\WireGuard\\wireguard.exe'
    ].filter(Boolean);
    return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

async function getWireGuardServices() {
    const raw = await ps(`
        Get-Service 'WireGuardTunnel$*' -ErrorAction SilentlyContinue |
            Select-Object Name, Status, DisplayName |
            ConvertTo-Json -Compress
    `);
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : (parsed && parsed.Name ? [parsed] : []);
    } catch {
        return [];
    }
}

function psQuoted(value) {
    return "'" + String(value || '').replace(/'/g, "''") + "'";
}

async function startWireGuardService(tunnelName) {
    const serviceName = 'WireGuardTunnel$' + safeTunnelName(tunnelName);
    const raw = await ps(`
        $name = ${psQuoted(serviceName)}
        $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
        if (-not $svc) {
            [PSCustomObject]@{ ok = $false; error = 'WireGuard tunnel service was not found.' } | ConvertTo-Json -Compress
            return
        }
        if ($svc.Status -ne 'Running') {
            Start-Service -Name $name -ErrorAction Stop
            $svc = Get-Service -Name $name -ErrorAction Stop
        }
        [PSCustomObject]@{ ok = ($svc.Status -eq 'Running'); status = [string]$svc.Status; name = $svc.Name } | ConvertTo-Json -Compress
    `);
    try {
        const parsed = JSON.parse(raw);
        return parsed && parsed.ok
            ? { ok: true, status: parsed.status, serviceName: parsed.name }
            : { ok: false, error: parsed && parsed.error ? parsed.error : 'Unable to start WireGuard tunnel service.' };
    } catch {
        return { ok: false, error: 'Unable to start WireGuard tunnel service. Run the local server as Administrator.' };
    }
}

async function connectVpnProfile(id) {
    const profile = getVpnProfileById(id);
    if (!profile) {
        return { ok: false, error: 'Profile not found. Add a WireGuard .conf file to vpn-profiles first.' };
    }

    const warnings = profileWarnings(profile);
    if (warnings.length) {
        return {
            ok: false,
            error: 'This WireGuard profile is not safe for consumer full-tunnel mode: ' + warnings.join(' '),
            profile: profile.id,
            warnings
        };
    }

    const wgExe = findWireGuardExe();
    if (!wgExe) {
        return { ok: false, error: 'WireGuard for Windows is not installed or wireguard.exe was not found.', profile: profile.id };
    }

    try {
        await execFileAsync(wgExe, ['/installtunnelservice', profile.path], {
            windowsHide: true,
            timeout: 15000,
            maxBuffer: 1024 * 1024
        });
    } catch (err) {
        const message = err && (err.stderr || err.stdout || err.message) ? String(err.stderr || err.stdout || err.message).trim() : 'Unable to start tunnel';
        if (!/already exists|already installed|service exists/i.test(message)) {
            return {
                ok: false,
                error: message + ' Run the local server as Administrator and make sure the profile credentials are valid.',
                profile: profile.id
            };
        }
    }

    const serviceStart = await startWireGuardService(profile.tunnelName);
    if (!serviceStart.ok) {
        return {
            ok: false,
            error: serviceStart.error,
            profile: profile.id
        };
    }

    cachedNetworkSnapshot = null;
    cachedNetworkSnapshotAt = 0;
    await new Promise(resolve => setTimeout(resolve, 2500));
    const snapshot = await getNetworkSnapshot(true);
    if (!snapshot.wireguard || !snapshot.wireguard.active) {
        return {
            ok: false,
            error: 'WireGuard command completed, but no active WireGuard adapter was detected. Check the profile, Windows service status, and Administrator permissions.',
            profile: profile.id,
            snapshot
        };
    }
    return { ok: true, action: 'connect', profile: listVpnProfiles().profiles.find(item => item.id === profile.id), snapshot };
}

async function disconnectVpnProfile(id) {
    const profile = getVpnProfileById(id);
    const tunnelName = profile ? profile.tunnelName : safeTunnelName(id);
    const wgExe = findWireGuardExe();
    if (!wgExe) {
        return { ok: false, error: 'WireGuard for Windows is not installed or wireguard.exe was not found.', profile: id };
    }

    try {
        await execFileAsync(wgExe, ['/uninstalltunnelservice', tunnelName], {
            windowsHide: true,
            timeout: 15000,
            maxBuffer: 1024 * 1024
        });
    } catch (err) {
        const message = err && (err.stderr || err.stdout || err.message) ? String(err.stderr || err.stdout || err.message).trim() : 'Unable to stop tunnel';
        if (!/does not exist|not installed|not found/i.test(message)) {
            return { ok: false, error: message, profile: id };
        }
    }

    cachedNetworkSnapshot = null;
    cachedNetworkSnapshotAt = 0;
    await new Promise(resolve => setTimeout(resolve, 1500));
    const snapshot = await getNetworkSnapshot(true);
    return { ok: true, action: 'disconnect', profile: id || tunnelName, snapshot };
}

async function getNetworkSnapshot(forceRefresh) {
    if (!forceRefresh && cachedNetworkSnapshot && (Date.now() - cachedNetworkSnapshotAt) < CACHE_TTL_MS) {
        return cachedNetworkSnapshot;
    }

    const [iface, wlanInfo, exit, wireguard] = await Promise.all([
        getPrimaryInterface(),
        getWlanInfo(),
        getPublicExitInfo(),
        getWireGuardStatus()
    ]);

    const location = [exit.city, exit.region, exit.country].filter(Boolean).join(', ');
    const snapshot = {
        ok: true,
        scannedAt: new Date().toISOString(),
        publicExit: {
            ip: exit.ip,
            country: exit.country,
            region: exit.region,
            city: exit.city,
            location,
            org: exit.org || exit.isp || null,
            source: exit.source
        },
        adapter: {
            name: iface.name || null,
            description: iface.desc || null,
            ip: iface.ip || null,
            mac: iface.mac || null,
            gateway: iface.gateway || null,
            dnsServers: iface.dnsServers || [],
            prefixLength: iface.prefix || null,
            subnet: iface.ip ? `${iface.ip}/${iface.prefix || 24}` : null,
            isWifi: !!iface.isWifi,
            source: iface.source || null
        },
        wifi: wlanInfo,
        wireguard
    };

    console.log(
        `[Network Snapshot] public_ip=${sanitizeLogValue(snapshot.publicExit.ip)} ` +
        `adapter_ip=${sanitizeLogValue(snapshot.adapter.ip)} ` +
        `mac=${sanitizeLogValue(snapshot.adapter.mac)} ` +
        `gateway=${sanitizeLogValue(snapshot.adapter.gateway)} ` +
        `dns=${sanitizeLogValue((snapshot.adapter.dnsServers || []).join(','))} ` +
        `vpn_adapter=${wireguard.active ? sanitizeLogValue(wireguard.adapters.map(a => a.name).join(',')) : 'not_detected'}`
    );

    cachedNetworkSnapshot = snapshot;
    cachedNetworkSnapshotAt = Date.now();
    return snapshot;
}

function subnetMaskToPrefix(mask) {
    const parts = String(mask || '').split('.').map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const bits = parts.map(n => n.toString(2).padStart(8, '0')).join('');
    if (!/^1*0*$/.test(bits)) return null;
    return bits.indexOf('0') === -1 ? 32 : bits.indexOf('0');
}

function cleanIpconfigValue(value) {
    return String(value || '').replace(/\(Preferred\)/gi, '').trim();
}

function firstValue(values, key) {
    const list = values[key] || [];
    return list.find(Boolean) || null;
}

function firstIpv4(values, key, allowSpecial) {
    const list = values[key] || [];
    for (const value of list) {
        const match = String(value || '').match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
        if (match && ipToInt(match[0]) !== null && (allowSpecial || !isSpecialIp(match[0]))) return match[0];
    }
    return null;
}

function parseIpconfigAdapters(raw) {
    const adapters = [];
    let current = null;
    let lastLabel = null;

    for (const line of String(raw || '').split(/\r?\n/)) {
        const header = line.match(/^([^:\r\n]+ adapter [^:]+):\s*$/i);
        if (header) {
            if (current) adapters.push(current);
            current = {
                header: header[1].trim(),
                name: header[1].replace(/^.*?\badapter\s+/i, '').trim(),
                values: {}
            };
            lastLabel = null;
            continue;
        }

        if (!current) continue;

        const pair = line.match(/^\s*([^:]+):\s*(.*)$/);
        if (pair) {
            const label = pair[1].replace(/\./g, '').replace(/\s+/g, ' ').trim().toLowerCase();
            const value = cleanIpconfigValue(pair[2]);
            if (!current.values[label]) current.values[label] = [];
            current.values[label].push(value);
            lastLabel = label;
            continue;
        }

        const continuation = cleanIpconfigValue(line);
        if (lastLabel && continuation) current.values[lastLabel].push(continuation);
    }

    if (current) adapters.push(current);

    return adapters.map(adapter => {
        const values = adapter.values;
        const desc = firstValue(values, 'description');
        const mac = normalizeMac(firstValue(values, 'physical address'));
        const ip = firstIpv4(values, 'ipv4 address');
        const mask = firstIpv4(values, 'subnet mask', true);
        const gateway = firstIpv4(values, 'default gateway');
        const dnsServers = (values['dns servers'] || [])
            .map(value => {
                const match = String(value || '').match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
                return match ? match[0] : null;
            })
            .filter(Boolean);
        const haystack = `${adapter.header} ${adapter.name} ${desc || ''}`.toLowerCase();

        return {
            ...adapter,
            desc,
            mac,
            ip,
            prefix: subnetMaskToPrefix(mask),
            gateway,
            dnsServers: [...new Set(dnsServers)],
            isWifi: /wi-?fi|wireless|wlan|802\.11/.test(haystack),
            isVirtual: /virtual|vmware|virtualbox|hyper-v|wsl|bluetooth|loopback|tunnel|tap|vpn/.test(haystack),
            disconnected: /media disconnected/i.test(firstValue(values, 'media state') || '')
        };
    });
}

function scoreIpconfigAdapter(adapter) {
    if (!adapter || adapter.disconnected || !adapter.ip) return Number.POSITIVE_INFINITY;
    let score = 100;
    if (adapter.isWifi) score -= 60;
    if (adapter.gateway) score -= 25;
    if (adapter.mac) score -= 5;
    if (adapter.isVirtual) score += 80;
    return score;
}

function getPrimaryInterfaceFromOs() {
    const candidates = [];
    const interfaces = os.networkInterfaces();

    for (const [name, entries] of Object.entries(interfaces)) {
        for (const entry of entries || []) {
            if (entry.family !== 'IPv4' || entry.internal || isSpecialIp(entry.address)) continue;
            const haystack = `${name} ${entry.mac || ''}`.toLowerCase();
            candidates.push({
                ifIndex: null,
                name,
                desc: name,
                mac: normalizeMac(entry.mac),
                ip: entry.address,
                prefix: subnetMaskToPrefix(entry.netmask) || Number((entry.cidr || '').split('/')[1]) || 24,
                gateway: null,
                dnsServers: [],
                isWifi: /wi-?fi|wireless|wlan|802\.11/.test(haystack),
                isVirtual: /virtual|vmware|virtualbox|hyper-v|wsl|bluetooth|loopback|tunnel|tap|vpn/.test(haystack),
                disconnected: false,
                medium: null,
                source: 'node-os'
            });
        }
    }

    candidates.sort((a, b) => scoreIpconfigAdapter(a) - scoreIpconfigAdapter(b));
    return candidates[0] || {};
}

async function getPrimaryInterfaceFromIpconfig() {
    let raw = '';
    try {
        const { stdout } = await execFileAsync('ipconfig.exe', ['/all'], {
            windowsHide: true,
            maxBuffer: 1024 * 1024
        });
        raw = stdout;
    } catch {}

    if (!raw) raw = await ps('ipconfig /all | Out-String');

    const adapters = parseIpconfigAdapters(raw)
        .filter(adapter => adapter.ip && !isSpecialIp(adapter.ip))
        .sort((a, b) => scoreIpconfigAdapter(a) - scoreIpconfigAdapter(b));
    const best = adapters[0];
    if (!best) return getPrimaryInterfaceFromOs();
    return {
        ifIndex: null,
        name: best.name || best.header,
        desc: best.desc,
        mac: best.mac,
        ip: best.ip,
        prefix: best.prefix || 24,
        gateway: best.gateway,
        dnsServers: best.dnsServers || [],
        isWifi: best.isWifi,
        medium: null,
        source: 'ipconfig'
    };
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
                    dnsServers  = @($cfg.DNSServer.ServerAddresses | Where-Object { $_ -match '^\\d+\\.' })
                    isWifi      = ($score -eq 1)
                    medium      = $a.NdisPhysicalMedium
                }
            }
        }

        if ($best) { $best | ConvertTo-Json -Compress } else { '{}' }
    `);
    try {
        const parsed = JSON.parse(raw) || {};
        if (parsed && parsed.ip) return { ...parsed, source: 'powershell' };
    } catch {}
    return getPrimaryInterfaceFromIpconfig();
}

// ─── Step 2: WLAN signal info ──────────────────────────────────────────────
async function getWlanInfo() {
    let raw = await ps(`netsh wlan show interfaces | Out-String`);
    if (!raw) {
        try {
            const { stdout } = await execFileAsync('netsh.exe', ['wlan', 'show', 'interfaces'], {
                windowsHide: true,
                maxBuffer: 1024 * 1024
            });
            raw = stdout;
        } catch {
            raw = '';
        }
    }
    const get = label => {
        const m = raw.match(new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, 'im'));
        return m ? m[1].trim() : null;
    };
    return {
        name:         get('Name'),
        state:        get('State'),
        ssid:         get('SSID') || get('Profile'),
        bssid:        get('AP BSSID'),
        authentication: get('Authentication'),
        cipher:       get('Cipher'),
        signal:       get('Signal'),
        band:         get('Band'),
        radioType:    get('Radio type'),
        channel:      get('Channel'),
        receiveRate:  get('Receive rate \\(Mbps\\)'),
        transmitRate: get('Transmit rate \\(Mbps\\)')
    };
}

// ─── Step 3: Fast UDP ARP Sweep (Bypasses Ping blocks) ───────────────────────
async function udpArpSweep(myIp, prefixLen) {
    const ipInt  = ipToInt(myIp);
    if (ipInt === null) return { attempted: 0, responsive: 0, prefix: prefixLen };

    const clampedPrefix = Math.max(16, Math.min(30, prefixLen));
    const hostBits = 32 - clampedPrefix;
    // For large subnets, cap the sweep to 16,384 hosts to prevent memory issues,
    // though native UDP can handle it easily.
    const count    = Math.min(16384, (1 << hostBits) - 2); 
    const mask     = (0xFFFFFFFF << hostBits) >>> 0;
    const network  = (ipInt & mask) >>> 0;

    const targets = [];
    for (let i = 1; i <= count; i++) {
        const candidate = (network | i) >>> 0;
        if (candidate === ipInt) continue;
        targets.push([candidate >> 24 & 255, candidate >> 16 & 255, candidate >> 8 & 255, candidate & 255].join('.'));
    }

    return new Promise((resolve) => {
        const dgram = require('node:dgram');
        const socket = dgram.createSocket('udp4');
        socket.on('error', () => {});
        const payload = Buffer.from([0x00]);
        
        // Blast UDP packets. The OS will automatically broadcast ARP requests for each IP.
        for (const ip of targets) {
            socket.send(payload, 33434, ip, () => {});
        }
        
        // Give the OS network stack 1 second to receive all the ARP hardware replies
        setTimeout(() => {
            socket.close();
            resolve({ attempted: targets.length, responsive: 'ARP-Triggered', prefix: clampedPrefix });
        }, 1200);
    });
}

// ─── Step 3b: Zero-Configuration Multicast Discovery (Accurate Names) ────────
async function multicastDiscovery() {
    return new Promise((resolve) => {
        const discoveredNames = new Map();
        const dgram = require('node:dgram');
        let activeSockets = 0;
        
        const finish = () => {
            if (--activeSockets <= 0) resolve(discoveredNames);
        };

        // --- mDNS (224.0.0.251:5353) ---
        try {
            const mdns = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            activeSockets++;
            mdns.on('error', () => {});
            mdns.on('message', (msg, rinfo) => {
                const packetStr = msg.toString('ascii');
                const match = packetStr.match(/([a-zA-Z0-9-]+\.local)/i);
                if (match) {
                    const name = match[1].replace(/\.local$/i, '');
                    if (!discoveredNames.has(rinfo.address) && name.length > 2) {
                        discoveredNames.set(rinfo.address, name);
                    }
                }
            });
            mdns.bind(0, () => {
                const query = Buffer.from([
                    0x00, 0x00, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 
                    0x00, 0x00, 0x00, 0x00, 0x09, 0x5f, 0x73, 0x65, 
                    0x72, 0x76, 0x69, 0x63, 0x65, 0x73, 0x07, 0x5f, 
                    0x64, 0x6e, 0x73, 0x2d, 0x73, 0x64, 0x04, 0x5f, 
                    0x75, 0x64, 0x70, 0x05, 0x6c, 0x6f, 0x63, 0x61, 
                    0x6c, 0x00, 0x00, 0x0c, 0x00, 0x01
                ]);
                mdns.send(query, 5353, '224.0.0.251');
                setTimeout(() => { mdns.close(); finish(); }, 1500);
            });
        } catch { activeSockets--; }

        // --- SSDP / UPnP (239.255.255.250:1900) ---
        try {
            const ssdp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            activeSockets++;
            ssdp.on('error', () => {});
            ssdp.on('message', async (msg, rinfo) => {
                const text = msg.toString('utf8');
                const locationMatch = text.match(/LOCATION:\s*(http:\/\/[^\s]+)/i);
                if (locationMatch && !discoveredNames.has(rinfo.address)) {
                    discoveredNames.set(rinfo.address, 'Discovering...');
                    try {
                        const controller = new AbortController();
                        const to = setTimeout(() => controller.abort(), 1000);
                        const res = await fetch(locationMatch[1], { signal: controller.signal });
                        clearTimeout(to);
                        const xml = await res.text();
                        const nameMatch = xml.match(/<friendlyName>(.*?)<\/friendlyName>/i);
                        if (nameMatch) {
                            discoveredNames.set(rinfo.address, nameMatch[1].trim());
                        } else {
                            discoveredNames.delete(rinfo.address);
                        }
                    } catch {
                        discoveredNames.delete(rinfo.address);
                    }
                }
            });
            ssdp.bind(0, () => {
                const search = Buffer.from(
                    'M-SEARCH * HTTP/1.1\r\n' +
                    'Host: 239.255.255.250:1900\r\n' +
                    'Man: "ssdp:discover"\r\n' +
                    'ST: ssdp:all\r\n' +
                    'MX: 1\r\n\r\n'
                );
                ssdp.send(search, 1900, '239.255.255.250');
                setTimeout(() => { ssdp.close(); finish(); }, 1500);
            });
        } catch { activeSockets--; }

        if (activeSockets === 0) resolve(discoveredNames);
    });
}

function parseArpTable(raw, myIp, prefixLen) {
    const byIp = new Map();
    let currentInterfaceIp = null;

    for (const line of String(raw || '').split(/\r?\n/)) {
        const header = line.match(/^\s*Interface:\s+((?:\d{1,3}\.){3}\d{1,3})\s+---/i);
        if (header) {
            currentInterfaceIp = header[1];
            continue;
        }

        const row = line.match(/^\s*((?:\d{1,3}\.){3}\d{1,3})\s+([0-9a-f]{2}(?:[-:][0-9a-f]{2}){5})\s+(\w+)/i);
        if (!row) continue;

        const ip = row[1];
        const mac = normalizeMac(row[2]);
        const type = row[3].toLowerCase();
        const sameInterface = currentInterfaceIp === myIp || inSubnet(currentInterfaceIp, myIp, prefixLen);

        if (!sameInterface || ip === myIp || !mac) continue;
        if (mac === 'FF-FF-FF-FF-FF-FF' || mac === '00-00-00-00-00-00') continue;
        if (isSpecialIp(ip) || !inSubnet(ip, myIp, prefixLen)) continue;
        if (type !== 'dynamic' && type !== 'static') continue;

        const state = type === 'dynamic' ? 'Discovered' : 'Static';
        const existing = byIp.get(ip);
        if (!existing || existing.state === 'Static') {
            byIp.set(ip, { ip, mac, state });
        }
    }

    return [...byIp.values()];
}

function normalizeNeighborState(state) {
    const text = String(state || '').trim();
    const numericStates = {
        0: 'Unreachable',
        1: 'Incomplete',
        2: 'Probe',
        3: 'Delay',
        4: 'Stale',
        5: 'Reachable',
        6: 'Permanent'
    };
    if (/^\d+$/.test(text)) return numericStates[text] || 'Discovered';
    return text || 'Discovered';
}

async function getArpFromArpCommand(myIp, prefixLen) {
    let raw = '';
    try {
        const { stdout } = await execFileAsync('arp.exe', ['-a'], {
            windowsHide: true,
            maxBuffer: 1024 * 1024
        });
        raw = stdout;
    } catch {}

    if (!raw) raw = await ps('arp -a | Out-String');
    return parseArpTable(raw, myIp, prefixLen);
}

// ─── Step 4: Read ARP table — ONLY for the target interface ───────────────
async function getArpForInterface(ifIndex, myIp, prefixLen) {
    let list = [];

    if (ifIndex) {
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

        try {
            const parsed = JSON.parse(raw);
            list = Array.isArray(parsed) ? parsed : (parsed && parsed.IPAddress ? [parsed] : []);
        } catch {
            list = [];
        }
    }

    const powershellDevices = list
        .filter(d =>
            d.IPAddress &&
            !isSpecialIp(d.IPAddress) &&
            inSubnet(d.IPAddress, myIp, prefixLen)
        )
        .map(d => ({
            ip:    d.IPAddress,
            mac:   normalizeMac(d.LinkLayerAddress) || 'Unknown',
            state: normalizeNeighborState(d.State)
        }));

    if (powershellDevices.length) return powershellDevices;
    return getArpFromArpCommand(myIp, prefixLen);
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
function parseMbps(value) {
    const match = String(value || '').match(/\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : null;
}

function guessType(name, vendor, role, mac) {
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
    if (isLocalMAC(mac)) return { type: 'Randomized MAC Device', icon: '📱' };
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
    if (!iface.ip) {
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

    // 2. Run ARP UDP Sweep and Multicast Discovery in parallel with WLAN info
    const [wlanInfo, sweepMeta, multicastNames] = await Promise.all([
        getWlanInfo(),
        udpArpSweep(myIp, prefix),
        multicastDiscovery()
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

            let name = multicastNames.get(device.ip);
            if (!name) {
                name = hostname;
                if (!name) {
                    if (isGateway)     name = vendor ? `${vendor} Router` : 'Network Router';
                    else if (vendor)   name = `${vendor} Device`;
                    else               name = `Device (${device.ip})`;
                }
            }

            const deviceInfo = guessType(name, vendor, role, device.mac);

            return {
                ip:    device.ip,
                mac:   device.mac,
                name,
                hostName: name,
                vendor: vendor || null,
                role,
                state: device.state,
                type: deviceInfo.type,
                icon: deviceInfo.icon,
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
            state:        wlanInfo.state,
            ssid:         wlanInfo.ssid    || iface.name,
            bssid:        wlanInfo.bssid,
            auth:         wlanInfo.authentication,
            authentication: wlanInfo.authentication,
            cipher:       wlanInfo.cipher,
            signal:       wlanInfo.signal,
            band:         wlanInfo.band,
            radioType:    wlanInfo.radioType,
            channel:      wlanInfo.channel,
            receiveRate:  wlanInfo.receiveRate,
            transmitRate: wlanInfo.transmitRate,
            receiveRateMbps: parseMbps(wlanInfo.receiveRate),
            transmitRateMbps: parseMbps(wlanInfo.transmitRate),
            myIp,
            myMac:        iface.mac,
            gateway,
            defaultGateway: gateway,
            ipv4Address:  myIp,
            localMac:     iface.mac,
            adapterName:  iface.name,
            adapterDescription: iface.desc,
            prefixLength: prefix,
            dnsServers:   iface.dnsServers || [],
            discoverySource: iface.source || 'powershell',
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
            ifIndex ? `PowerShell Get-NetNeighbor (ifIndex=${ifIndex})` : 'arp.exe fallback',
            'Ping sweep (subnet only)',
            'NetBIOS',
            'Reverse DNS',
            'Ping -a',
            'MAC vendor API'
        ],
        meta: {
            discovery: ifIndex ? 'PowerShell adapter + neighbor table' : 'ipconfig.exe + arp.exe fallback',
            naming: 'NetBIOS, reverse DNS, ping -a, MAC vendor lookup',
            sweep: sweepMeta
        }
    };

    cachedSnapshot = result;
    cachedAt = Date.now();
    return result;
}

// ─── HTTP Server ───────────────────────────────────────────────────────────
async function handleWifiApiRequest(req, res, options = {}) {
    const host = options.host || HOST;
    const port = Number(options.port || PORT);

    if (req.method === 'OPTIONS') { sendJson(res, 204, {}); return; }

    const url = new URL(req.url || '/', `http://${host}:${port}`);

    if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true, service: 'wifi-api-server', port, version: '3.0-accurate' });
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

    if (req.method === 'GET' && url.pathname === '/api/network/snapshot') {
        try {
            const force = url.searchParams.get('refresh') === '1';
            if (force) { cachedNetworkSnapshot = null; cachedNetworkSnapshotAt = 0; }
            const data = await getNetworkSnapshot(force);
            sendJson(res, 200, data);
        } catch (err) {
            sendJson(res, 500, { ok: false, error: err?.message || 'Network snapshot failed' });
        }
        return;
    }

    if (req.method === 'GET' && url.pathname === '/api/vpn/profiles') {
        try {
            const listing = listVpnProfiles();
            sendJson(res, 200, {
                ...listing,
                profiles: await enrichVpnProfiles(listing.profiles),
                wireGuardInstalled: !!findWireGuardExe(),
                services: await getWireGuardServices()
            });
        } catch (err) {
            sendJson(res, 500, { ok: false, error: err?.message || 'Unable to list VPN profiles' });
        }
        return;
    }

    if (req.method === 'POST' && url.pathname === '/api/vpn/connect') {
        if (!isVpnControlRequestAllowed(req)) {
            sendJson(res, 403, {
                ok: false,
                error: 'VPN control is only allowed from the local Cyber Shield AI app at http://127.0.0.1:4318.'
            });
            return;
        }
        try {
            const profileId = url.searchParams.get('profile');
            const result = await connectVpnProfile(profileId);
            sendJson(res, result.ok ? 200 : 400, result);
        } catch (err) {
            sendJson(res, 500, { ok: false, error: err?.message || 'Unable to connect VPN profile' });
        }
        return;
    }

    if (req.method === 'POST' && url.pathname === '/api/vpn/disconnect') {
        if (!isVpnControlRequestAllowed(req)) {
            sendJson(res, 403, {
                ok: false,
                error: 'VPN control is only allowed from the local Cyber Shield AI app at http://127.0.0.1:4318.'
            });
            return;
        }
        try {
            const profileId = url.searchParams.get('profile');
            const result = await disconnectVpnProfile(profileId);
            sendJson(res, result.ok ? 200 : 400, result);
        } catch (err) {
            sendJson(res, 500, { ok: false, error: err?.message || 'Unable to disconnect VPN profile' });
        }
        return;
    }

    sendJson(res, 404, { ok: false, error: 'Not found' });
}

function createWifiApiServer(options = {}) {
    const host = options.host || HOST;
    const port = Number(options.port || PORT);
    return http.createServer((req, res) => handleWifiApiRequest(req, res, { host, port }));
}

function startWifiApiServer(options = {}) {
    const host = options.host || HOST;
    const port = Number(options.port || PORT);
    const server = createWifiApiServer({ host, port });
    server.listen(port, host, () => {
        console.log(`[CyberShield Wi-Fi API v3] http://${host}:${port}`);
        console.log(`[Accurate] Only scans primary adapter's subnet — no DNS cache, no netstat.`);
    });
    return server;
}

module.exports = {
    createWifiApiServer,
    handleWifiApiRequest,
    startWifiApiServer,
    getNetworkSnapshot,
    listVpnProfiles,
    connectVpnProfile,
    disconnectVpnProfile
};

if (require.main === module) {
    startWifiApiServer();
}
