<div align="center">

# 📺 Hybrid Stream Server

Lightweight scraper-backed streaming backend for Stremio, built for always-on Ubuntu servers.

[![stremio addon](https://img.shields.io/badge/stremio-addon-blue)](http://YOUR_SERVER_IP:3000/manifest.json)
[![node](https://img.shields.io/badge/node-%3E%3D20-339933)](https://nodejs.org/)
[![platform](https://img.shields.io/badge/platform-Ubuntu%20Server-orange)](#ubuntu-247-deployment)
[![playback](https://img.shields.io/badge/playback-HTTP%20%2B%20Torrent-green)](#features)
[![cache](https://img.shields.io/badge/cache-disk%20backed-6f42c1)](#features)
[![runtime](https://img.shields.io/badge/runtime-low--end%20friendly-success)](#notes)

[Features](#features) • [Stremio Addon](#stremio-addon) • [Endpoints](#endpoints) • [Ubuntu 24/7 Deployment](#ubuntu-247-deployment) • [Quick Checks](#quick-checks) • [Notes](#notes)

</div>

---

## Features

- Scraper-backed stream discovery across multiple providers
- Unified playback route through the same server-owned stream pipeline
- HTTP proxy streaming with range support
- Torrent playback with fallback support
- Disk-backed cache with hard cap enforcement
- Persistent scrape-result cache to reduce repeat CPU and network usage
- Stream prioritization for Stremio native-player compatibility
- Runtime limits for low-end always-on systems

## Stremio Addon

Install URL:

```text
http://YOUR_SERVER_IP:3000/manifest.json
```

Alternative manifest path:

```text
http://YOUR_SERVER_IP:3000/stremio/manifest.json
```

Example Stremio stream request:

```text
http://YOUR_SERVER_IP:3000/stream/movie/tt0133093.json
```

Supported Stremio resources:

- `stream`

Supported types:

- `movie`
- `series`

Supported id prefixes:

- `tt`

## Endpoints

Core routes:

- `GET /health`
- `GET /providers`
- `GET /providers/:provider/streams`
- `GET /providers/aggregate/streams`
- `POST /add-source`
- `GET /stream`
- `GET /stream/http`
- `GET /stream/torrent`
- `GET /stream/torrent/:infoHash/:filename`

Stremio routes:

- `GET /manifest.json`
- `GET /stremio/manifest.json`
- `GET /stream/:type/:id.json`
- `GET /stremio/stream/:type/:id.json`

## Playback Model

Playback policy:

1. If cached:
   instant play from disk
2. Else if HTTP:
   validate and stream
3. Else:
   torrent fallback

Returned Stremio stream cards also expose lightweight format hints such as:

- `[MP4/H264]`
- `[HLS]`
- `[MKV/HEVC]`
- `[TORRENT]`

This makes it easier to choose native-player-friendly streams on TV and keep heavier formats for external players like VLC.

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
curl "http://127.0.0.1:3000/providers/aggregate/streams?tmdbId=603&mediaType=movie"
curl "http://127.0.0.1:3000/stream/movie/tt0133093.json"
```

## Notes

- Keep `MAX_ACTIVE_TORRENTS=1` on low-end systems.
- Put `CACHE_DIR` on a disk with enough free space.
- The server keeps playback inside its own `/stream` pipeline instead of returning third-party URLs directly.
- Aggregate scraping can be slow on cold requests and much faster after cache warm-up.
- Some upstream scrapers return imperfect title matches; the backend can rank and filter them, but source quality still depends on upstream behavior.
