const { createWifiApiServer } = require('../wifi-api-server');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { parseError: true, text };
  }
}

async function main() {
  const server = createWifiApiServer({ host: '127.0.0.1', port: 0 });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const health = await fetch(`${base}/health`).then(readJson);
    assert(health.ok === true, 'health endpoint should return ok=true');

    const profiles = await fetch(`${base}/api/vpn/profiles`).then(readJson);
    assert(profiles.ok === true, 'profile endpoint should return ok=true');
    assert(Array.isArray(profiles.profiles), 'profile endpoint should return profiles array');

    const profilePayload = JSON.stringify(profiles);
    assert(!profilePayload.includes('PrivateKey'), 'profile API must not expose private keys');

    for (const profile of profiles.profiles) {
      if (profile.consumerReady) {
        assert(profile.fullTunnelIpv4, `${profile.id} must route all IPv4 traffic`);
        assert(profile.fullTunnelIpv6, `${profile.id} must route all IPv6 traffic`);
        assert(profile.dnsConfigured, `${profile.id} must configure DNS`);
      }
    }

    const denied = await fetch(`${base}/api/vpn/connect?profile=missing`, { method: 'POST' });
    assert(denied.status === 403, 'VPN control without local-control header should be blocked');

    const allowed = await fetch(`${base}/api/vpn/connect?profile=missing`, {
      method: 'POST',
      headers: { 'X-CyberShield-Local-Control': '1' }
    });
    const allowedBody = await readJson(allowed);
    assert(allowed.status === 400, 'local-control request with missing profile should be a profile error');
    assert(allowedBody.ok === false, 'missing profile response should be ok=false');

    console.log(JSON.stringify({
      ok: true,
      profileCount: profiles.profiles.length,
      wireGuardInstalled: !!profiles.wireGuardInstalled,
      blockedUnauthorizedControl: denied.status === 403
    }, null, 2));
  } finally {
    server.close();
  }
}

main().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
});
