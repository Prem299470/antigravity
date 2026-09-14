const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { handleWifiApiRequest } = require('./wifi-api-server');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || process.env.WIFI_API_PORT || 4318);
const rootDir = __dirname;

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8'
};

function sendFile(res, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store'
    });
    fs.createReadStream(filePath).pipe(res);
}

function sendJson(res, statusCode, body) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);

    // --- Impersonation Call Verification API ---
    if (url.pathname === '/api/verify-number') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        const incoming = url.searchParams.get('incoming');
        if (!incoming) { sendJson(res, 400, { ok: false, error: 'Missing required parameter: incoming' }); return; }
        const args = ['verify_number.py', '--incoming', incoming];
        const saved = url.searchParams.get('saved');
        if (saved) { args.push('--saved', saved); }
        try {
            const py = spawn('python', args, { cwd: rootDir, timeout: 10000 });
            let stdout = '', stderr = '';
            py.stdout.on('data', d => stdout += d);
            py.stderr.on('data', d => stderr += d);
            py.on('close', code => {
                try { sendJson(res, 200, JSON.parse(stdout)); }
                catch { sendJson(res, 500, { error: 'parse_error', message: stderr || stdout || 'Unknown error' }); }
            });
            py.on('error', () => {
                sendJson(res, 503, { error: 'python_unavailable', message: 'Python is required for advanced number verification' });
            });
        } catch (e) {
            sendJson(res, 503, { error: 'python_unavailable', message: e.message });
        }
        return;
    }

        // --- Footprint Source Verifier API ---
    if (url.pathname === '/api/footprint/verify-url') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        const targetUrl = url.searchParams.get('url');
        if (!targetUrl) {
            sendJson(res, 400, { ok: false, error: 'Missing required parameter: url' });
            return;
        }
        try {
            const parsed = new URL(targetUrl);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                sendJson(res, 400, { ok: false, error: 'Only http and https protocols are supported' });
                return;
            }
            const hostname = parsed.hostname.toLowerCase();
            if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname.endsWith('.local') || /^10\.|^192\.168\.|^172\.(1[6-9]|2[0-9]|3[01])\.|^169\.254\./.test(hostname)) {
                sendJson(res, 403, { ok: false, error: 'Restricted target address' });
                return;
            }

            let checkRes;
            try {
                checkRes = await fetch(parsed.href, {
                    method: 'HEAD',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 CyberShield-OSINT/1.0',
                        'Accept': '*/*'
                    },
                    redirect: 'follow',
                    signal: AbortSignal.timeout(4500)
                });
                if (checkRes.status === 405 || checkRes.status === 403) {
                    checkRes = await fetch(parsed.href, {
                        method: 'GET',
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 CyberShield-OSINT/1.0',
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                        },
                        redirect: 'follow',
                        signal: AbortSignal.timeout(4500)
                    });
                }
            } catch (fetchErr) {
                sendJson(res, 200, {
                    ok: true,
                    exists: false,
                    statusCode: 0,
                    error: fetchErr.name === 'TimeoutError' ? 'timeout' : 'unreachable',
                    url: parsed.href
                });
                return;
            }

            const statusCode = checkRes.status;
            const exists = statusCode >= 200 && statusCode < 400;
            sendJson(res, 200, {
                ok: true,
                exists,
                statusCode,
                url: parsed.href
            });
            return;
        } catch (err) {
            sendJson(res, 400, { ok: false, error: 'Invalid URL format' });
            return;
        }
    }

    if (
        url.pathname === '/health' ||
        url.pathname === '/api/wifi/devices' ||
        url.pathname === '/api/network/snapshot' ||
        url.pathname === '/api/vpn/profiles' ||
        url.pathname === '/api/vpn/connect' ||
        url.pathname === '/api/vpn/disconnect'
    ) {
        await handleWifiApiRequest(req, res, { host: HOST, port: PORT });
        return;
    }

    let relativePath = decodeURIComponent(url.pathname);
    if (relativePath === '/') relativePath = '/index.html';

    const normalizedPath = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(rootDir, normalizedPath);

    if (!filePath.startsWith(rootDir)) {
        sendJson(res, 403, { ok: false, error: 'Forbidden' });
        return;
    }

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            sendJson(res, 404, { ok: false, error: 'Not found' });
            return;
        }

        sendFile(res, filePath);
    });
});

server.listen(PORT, HOST, () => {
    console.log(`[CyberShield Local Server] http://${HOST}:${PORT}`);
    console.log('[Integrated] Static dashboard + Wi-Fi scanner + VPN local control API are running together.');
});
