const http = require('node:http');
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

    if (url.pathname === '/health' || url.pathname === '/api/wifi/devices') {
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
    console.log('[Integrated] Static dashboard + Wi-Fi scanner API are running together.');
});
