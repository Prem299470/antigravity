# VPN Profiles

Place real WireGuard client profiles in this folder to enable one-click VPN control from the local Cyber Shield AI dashboard.

The VPN UI is profile-driven. Each `.conf` file becomes a selectable location, so add metadata comments for the country and city users should see.

Example file names:

```text
switzerland-zurich.conf
germany-frankfurt.conf
singapore.conf
```

Optional metadata comments at the top of each `.conf` improve the country selector:

```ini
# Name: Switzerland - Zurich
# Country: Switzerland
# City: Zurich

[Interface]
PrivateKey = ...
Address = 10.44.0.2/32
DNS = 1.1.1.1, 9.9.9.9

[Peer]
PublicKey = ...
Endpoint = vpn.example.com:51820
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25
```

Profiles are marked consumer-ready only when they include:

- `AllowedIPs = 0.0.0.0/0, ::/0`
- a non-empty `DNS = ...` value

Cyber Shield AI will not show Protected until the local helper verifies an active WireGuard tunnel after connection.

Keep `.conf` files private. They contain client private keys and are ignored by git.
