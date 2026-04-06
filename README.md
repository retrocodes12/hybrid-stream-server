# Hybrid Stream Server

Hybrid Node.js streaming backend with:

- scraper-backed source discovery
- HTTP proxy streaming
- torrent fallback streaming
- disk-backed caching
- Stremio-compatible addon endpoints

## Features

- Unified playback route: `/stream`
- Source registration: `POST /add-source`
- Provider discovery and aggregate scraping
- Cache-first playback policy
- HTTP-first with optional torrent fallback
- Stremio manifest and stream endpoints
- Runtime limits for low-end hardware

## Stremio Addon

Install URL:

```text
http://YOUR_SERVER_IP:3000/manifest.json
```

Available addon endpoints:

- `/manifest.json`
- `/stremio/manifest.json`
- `/stream/:type/:id.json`
- `/stremio/stream/:type/:id.json`

Example:

```text
http://YOUR_SERVER_IP:3000/stream/movie/tt0133093.json
```

## Ubuntu 24/7 Deployment

Assumptions:

- Ubuntu Server
- repo path: `/opt/hybrid-stream-server`
- Node.js 20+

### 1. Install system packages

```bash
sudo apt update
sudo apt install -y curl git build-essential
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

### 2. Clone and install

```bash
cd /opt
sudo git clone https://github.com/retrocodes12/hybrid-stream-server.git
sudo chown -R $USER:$USER /opt/hybrid-stream-server
cd /opt/hybrid-stream-server
npm install
```

### 3. Create environment file

```bash
cat > /opt/hybrid-stream-server/.env <<'EOF'
PORT=3000
CACHE_DIR=/opt/hybrid-stream-server/cache
MAX_CACHE_SIZE_GB=20
MAX_ACTIVE_TORRENTS=1
TORRENT_CONNECTIONS=80
TORRENT_METADATA_TIMEOUT_SECONDS=25
TORRENT_IDLE_TTL_SECONDS=120
TORRENT_CLEANUP_INTERVAL_SECONDS=30
HTTP_STREAM_TIMEOUT_SECONDS=20
HTTP_MAX_SOCKETS=8
HTTP_MAX_FREE_SOCKETS=4
HTTP_KEEP_ALIVE_MILLISECONDS=1000
PROVIDER_TIMEOUT_SECONDS=10
PROVIDER_CACHE_TTL_SECONDS=300
PROVIDER_MAX_CONCURRENCY=4
MAX_ACTIVE_STREAMS=8
STREMIO_ADDON_ID=community.hybrid.nuvio
STREMIO_ADDON_NAME=Hybrid Nuvio Streams
TMDB_API_KEY=439c478a771f35c05022f9feabcca01c
EOF
```

### 4. Manual smoke test

```bash
cd /opt/hybrid-stream-server
set -a
source .env
set +a
node index.js
```

In another shell:

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/manifest.json
```

### 5. Create systemd service

```bash
sudo tee /etc/systemd/system/hybrid-stream-server.service >/dev/null <<'EOF'
[Unit]
Description=Hybrid Stream Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/hybrid-stream-server
EnvironmentFile=/opt/hybrid-stream-server/.env
ExecStart=/usr/bin/node /opt/hybrid-stream-server/index.js
Restart=always
RestartSec=5
User=ubuntu
Group=ubuntu
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=false
ReadWritePaths=/opt/hybrid-stream-server/cache

[Install]
WantedBy=multi-user.target
EOF
```

If your server user is not `ubuntu`, replace `User` and `Group`.

### 6. Enable and start

```bash
sudo systemctl daemon-reload
sudo systemctl enable hybrid-stream-server
sudo systemctl start hybrid-stream-server
sudo systemctl status hybrid-stream-server
```

### 7. Logs

```bash
journalctl -u hybrid-stream-server -f
```

### 8. Firewall

```bash
sudo ufw allow 3000/tcp
```

## Quick Checks

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/providers
curl http://127.0.0.1:3000/manifest.json
curl "http://127.0.0.1:3000/stream/movie/tt0133093.json"
```

## Notes

- Keep `MAX_ACTIVE_TORRENTS=1` on low-end systems.
- Put `CACHE_DIR` on a disk with enough free space.
- The server is designed to keep playback inside its own `/stream` pipeline instead of returning third-party URLs directly.
- Aggregate scraping can be slow on cold requests and much faster after cache warm-up.
