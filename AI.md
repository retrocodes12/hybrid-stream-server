# NebulaStreams - AI Context Document

> **Purpose**: This file provides a comprehensive, token-efficient overview of the NebulaStreams project so AI assistants can understand the codebase without exhaustive file exploration.

---

## 1. Project Overview

**NebulaStreams** is a Node.js-based Stremio addon backend. It scrapes streaming sources from multiple HTTP providers and torrent trackers, then exposes them as a Stremio-compatible manifest and stream endpoint. It supports direct HTTP URLs, torrent magnet links (via `infoHash`), and configurable quality filtering.

- **Runtime**: Node.js >=20, ES modules (`"type": "module"`)
- **Entry Point**: `index.js` (~4,414 lines)
- **Main Framework**: Express.js
- **Deployment Targets**: Render (cloud), systemd user service (self-hosted)
- **Public Instance**: `https://nebulastreams.onrender.com`

---

## 2. File Structure

```
NebulaStreams/
├── index.js                  # Express server, routing, HTML config page, main entry point
├── config.js                 # Centralized env-driven config with validators (60+ env vars)
├── package.json              # ESM project, dependencies: express, axios, cheerio, torrent-stream, redis, ws, etc.
├── start.sh                  # Production startup script (NVM-aware, caps Node heap at 768MB)
├── nebulastreams.service     # systemd user service template (deployed to ~/.config/systemd/user/)
├── render.yaml               # Render Blueprint deployment config (free tier tuned)
├── README.md                 # User-facing docs
│
├── services/                 # Core business logic (9 modules)
│   ├── cacheManager.js       # Disk-backed cache (HTTP, provider results, torrents) with LRU pruning
│   ├── providerService.js    # Provider orchestration: scraper loading, caching, concurrency, retries
│   ├── streamManager.js      # Stremio stream endpoint, quality sorting, deduplication, stream proxy
│   ├── httpProxy.js          # HTTP proxy/passthrough with private-IP filtering, range support
│   ├── torrentEngine.js      # torrent-stream wrapper for torrent playback
│   ├── reverseProxy.js       # Full reverse proxy mode (alternative to stream proxy)
│   ├── imdbResolver.js       # TMDB API client for IMDB ID -> TMDB metadata resolution
│   ├── userTracker.js        # Analytics: request tracking, popular search prewarm, bot detection
│   └── sourceRegistry.js     # In-memory ephemeral registry for temporary stream sources
│
├── providers/                # Custom scrapers (not from npm/vendored)
│   ├── tamilian.cjs          # Custom Tamilian.io scraper (CommonJS for require() compat)
│   ├── torrent-scraper.cjs   # 1337x / TPB torrent scraper
│   └── torrent-scraper-runner.cjs  # Wrapper to spawn torrent-scraper in subprocess
│
├── utils/
│   ├── logger.js             # Structured JSON logger (info/warn/error -> stdout)
│   └── magnet.js             # Magnet link parsing, infoHash extraction, tracker enhancement
│
├── scripts/
│   └── keepAliveRender.js    # Cron-friendly ping script to keep Render free tier awake
│
├── vendor/                   # Vendored third-party provider packs (submodules/git deps)
│   ├── HTTP/                 # easystreams-based HTTP provider pack (~78 provider modules)
│   └── Torrent-Scraping/     # Torrent scraping provider pack (API wrappers)
│
└── cache/                    # Runtime disk cache (created automatically)
    ├── http/                 # HTTP response cache
    ├── provider-results/     # Serialized provider search results
    ├── torrents/             # torrent-stream temporary files
    ├── index/                # Cache metadata index
    ├── private-configs/      # Encoded private configuration snapshots
    └── analytics/            # userTracker JSON storage
```

---

## 3. Architecture

### 3.1 Express Routes (index.js)

| Route | Handler | Purpose |
|-------|---------|---------|
| `GET /health` | index.js | Health check + system stats (CPU, memory, cache) |
| `GET /` / `/configure` | index.js | Interactive HTML configuration page (provider selection, quality sorting, presets) |
| `GET /donate` | index.js | Donation/support page |
| `GET /admin/login` | index.js | Admin login form |
| `POST /admin/login` | index.js | Admin auth (basic cookie session) |
| `GET /admin` | index.js | Admin dashboard (provider status, system stats, cache stats) |
| `GET /manifest.json` | StreamManager | Stremio addon manifest |
| `GET /stremio/manifest.json` | StreamManager | Stremio manifest (alternate path) |
| `GET /stream/:type/:id.json` | StreamManager | Stremio stream list for a given IMDB ID |
| `GET /configured/.../manifest.json` | StreamManager | Manifest with provider/quality/options encoded in path |
| `GET /configured/.../stream/...` | StreamManager | Streams with encoded configuration |
| `GET /private/:configId/...` | StreamManager | Streams/manifest with private (body-stored) config |
| `GET /preview/:type/:id.json` | StreamManager | Preview endpoint for config page |
| `GET /providers` | ProviderService | List all available provider IDs |
| `GET /providers/aggregate/streams` | StreamManager | Aggregate streams from multiple providers |
| `GET /providers/:provider/streams` | StreamManager | Single provider stream lookup |
| `GET /stream` | StreamManager | Unified HTTP/torrent stream proxy |
| `GET /stream/http` | StreamManager | Explicit HTTP stream proxy |
| `GET /stream/torrent` | StreamManager | Explicit torrent stream |
| `POST /add-source` | StreamManager | Register a temporary source in SourceRegistry |
| `POST /configure/private-config` | StreamManager | Save a private config to disk, return config ID |
| `GET /cache/stats` | StreamManager | Cache statistics JSON |

### 3.2 Configuration System (config.js)

`config.js` exports two frozen objects:
- `config` — ~80 env-driven settings with typed validators (`toPositiveInteger`, `toBoolean`, `toProxyRuleList`, etc.)
- `cacheConfig` — derived cache directory paths and max size

**Key categories:**
- **Network**: `PORT`, `PUBLIC_BASE_URL`, `REDIS_URL`, `HTTP_MAX_SOCKETS`, proxy configs
- **Torrent**: `MAX_ACTIVE_TORRENTS` (1-2), `TORRENT_CONNECTIONS` (80), timeouts
- **Provider**: `PROVIDER_TIMEOUT_SECONDS` (15), `PROVIDER_MAX_CONCURRENCY` (16), `PROVIDER_GLOBAL_MAX_INFLIGHT` (24), cache TTLs
- **Stremio**: `STREMIO_FAST_PROVIDER_CONCURRENCY` (6), `STREMIO_FAST_STREAM_LIMIT` (24), inflight limits, background refresh
- **Memory Guards**: `MEMORY_GUARD_ENABLED`, pressure/critical/restart thresholds, shed interval
- **Bot Protection**: `BOT_PROTECTION_ENABLED`, request limits, block durations
- **Donation**: `DONATION_PRIMARY_URL`, crypto addresses

### 3.3 Service Dependencies

```
index.js
├─ ProviderService ── loads ──> vendor/HTTP providers, vendor/Torrent-Scraping, providers/*.cjs
├─ StreamManager ── uses ──> ProviderService, HttpProxyService, TorrentEngineService,
│                              SourceRegistry, ImdbResolverService, CacheManager
├─ HttpProxyService ── proxies ──> external HTTP streams
├─ TorrentEngineService ── uses ──> torrent-stream npm package
├─ CacheManager ── disk I/O ──> cache/ directories
├─ UserTracker ── analytics ──> cache/analytics/users.json
├─ ImdbResolverService ── calls ──> TMDB API
└─ ReverseProxyService ── fallback proxy mode
```

---

## 4. Key Services

### 4.1 ProviderService (`services/providerService.js`)
- **Provider Loading**: Dynamically loads provider modules from `vendor/HTTP`, `vendor/Torrent-Scraping`, and `providers/*.cjs`
- **Scraper Execution**: Runs provider `stream()` functions with subprocess isolation for some providers
- **Caching**: Two-tier cache (memory LRU + disk) for provider results; per-provider cache versioning
- **Concurrency Control**: Host-level and global inflight limits, per-provider cooldown on failure
- **Retry Logic**: `PROVIDER_FETCH_MAX_RETRIES` with configurable delays
- **Context Tracking**: `AsyncLocalStorage` for provider fetch contexts and abort signals

### 4.2 StreamManager (`services/streamManager.js`)
- **Stremio Integration**: Manifest generation, stream endpoint (`/stream/:type/:id.json`)
- **Stream Normalization**: Converts provider-specific results into Stremio `StreamObject` format
- **Quality Scoring**: `toStremioCompatibilityScore()` — MP4 > HLS > WEBM > MKV; prefers H.264, penalizes HEVC/HDR
- **Deduplication**: Smart dedupe by host+quality or URL hash
- **Background Refresh**: Refreshes stale cache entries for popular items
- **Popular Prewarm**: Tracks popular searches and prewarms them on interval
- **Private Configs**: Saves encoded provider/quality/option configs to `cache/private-configs/`

### 4.3 CacheManager (`services/cacheManager.js`)
- Manages `cache/http`, `cache/provider-results`, `cache/torrents`
- Metadata-indexed disk cache with SHA256 keys
- Automatic pruning based on `MAX_CACHE_SIZE_GB`
- Handles partial file cleanup on startup

### 4.4 HttpProxyService (`services/httpProxy.js`)
- Proxies HTTP(S) streams with Range header support
- Private IP filtering (anti-SSRF)
- Custom CA certificate loading
- Axios-based with custom agents for connection pooling

### 4.5 TorrentEngineService (`services/torrentEngine.js`)
- Wraps `torrent-stream` npm package
- Metadata timeout handling, file selection (largest video file)
- Range request support for seeking
- MIME type detection by extension
- Cleanup on idle timeout (`TORRENT_IDLE_TTL_SECONDS`)

### 4.6 UserTracker (`services/userTracker.js`)
- Tracks unique client IPs per path
- Bot detection via User-Agent patterns
- Popular search tracking (LRU in-memory + disk flush)
- Prewarm scheduling for frequently requested content

---

## 5. Provider Ecosystem

Providers are loaded dynamically. The project includes:

1. **Vendored HTTP Providers** (`vendor/HTTP/` from `easystreams` / `nuvio-providers-*`):
   - ~78 individual provider modules covering various streaming sites
   - Common interface: `stream({ tmdbId, mediaType, season?, episode? }) -> StreamObject[]`

2. **Vendored Torrent Providers** (`vendor/Torrent-Scraping/`):
   - API wrappers for torrent sources

3. **Custom Providers** (`providers/`):
   - `tamilian.cjs` — Tamilian.io scraper with TMDB matching, custom unpacker logic
   - `torrent-scraper.cjs` — Direct 1337x/TPB scraper with Cheerio
   - `torrent-scraper-runner.cjs` — Subprocess runner wrapper

4. **Latino/Arabic Provider Packs** (npm git deps):
   - `nuvio-providers-latino`, `nuvio-providers-arabic`

---

## 6. Stremio Manifest & Stream Format

### Manifest
```json
{
  "id": "community.nebulastreams",
  "name": "NebulaStreams",
  "version": "1.0.0",
  "description": "...",
  "resources": ["stream"],
  "types": ["movie", "series"],
  "idPrefixes": ["tt"]
}
```

### Stream Object
```json
{
  "name": "NebulaStreams",
  "title": "Provider Name [MP4/H264] 1080p\n📼: Movie Title (2024)\n🚜: provider-id",
  "url": "https://...",
  "behaviorHints": { "bingeGroup": "..." }
}
```

Torrent entries use `infoHash` instead of `url`.

---

## 7. Configuration Page (`/configure`)

A self-contained, server-rendered HTML page (generated in `index.js`) that lets users:

1. **Select Providers** — checkbox grid with search filter
2. **Apply Presets** — Web Fast, Mobile Data, 4K HDR, Anime, Indian, Turkish, Italian, Latino, Arabic
3. **Quality Priority** — drag-to-rank (2160p, 1440p, 1080p, 720p, 480p, 360p, auto, unknown)
4. **Playback Filters**:
   - Web-ready only
   - Hide HEVC/HDR/10-bit
   - Preferred audio language
   - Max file size (GB)
   - Blocked hosts
   - Dedupe mode (off / smart / host-quality)
5. **Live Manifest Builder** — URL updates in real-time; supports private config (POST -> config ID)
6. **Preview** — test search any IMDB ID and see ranked results

---

## 8. Deployment & Operations

### Render (Cloud)
- Uses `render.yaml` with free-tier tuned limits (low concurrency, small caches)
- Ephemeral filesystem — cache resets on restart
- `scripts/keepAliveRender.js` for uptime ping (optional)

### Self-Hosted (systemd user service)
- **Service file**: copied from `nebulastreams.service` to `~/.config/systemd/user/nebulastreams.service`
- **No `User=` directive** (causes exit 216 for user services)
- **Node heap capped** at 768MB (`--max-old-space-size=768` in `start.sh`)
- **Memory guard** auto-restarts process at 94% system memory after 3 critical cycles
- Commands: `systemctl --user enable/start/status nebulastreams`

---

## 9. Important Patterns & Conventions

1. **ES Modules**: All `.js` files use ESM (`import/export`). Custom providers in `providers/*.cjs` remain CommonJS for `createRequire` loading.
2. **Error Handling**: `createHttpError` factory used across services; errors bubble to Express error middleware.
3. **Structured Logging**: All services use `utils/logger.js` — JSON lines to stdout with level/message/time/context.
4. **Rate Limiting**: Three-tier rate limiting (public, streams, providers) via in-memory token buckets.
5. **Bot Protection**: Tracks suspicious request patterns; auto-blocks aggressive clients.
6. **Memory Guard**: Periodic `process.memoryUsage()` check against `/proc/meminfo`; sheds caches, then restarts if critical.
7. **CORS**: All routes allow `*` origins (Stremio client compatibility).
8. **Cache Keys**: SHA256 hashes for URLs; provider cache keys include provider version for invalidation.
9. **Inflight Deduplication**: `AsyncLocalStorage` + Maps prevent redundant provider searches.

---

## 10. Environment Variables Quick Reference

Most behavior is controlled via env vars. See `config.js` for full list. Critical ones:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | 3000 | HTTP server port |
| `PUBLIC_BASE_URL` | `https://nebulastreams.onrender.com` | Canonical URL for manifests |
| `CACHE_DIR` | `./cache` | Disk cache root |
| `REDIS_URL` | `""` | Optional Redis for external stream result cache |
| `DISABLED_SOURCES` | `""` | Comma-separated provider IDs to disable |
| `TMDB_API_KEY` | built-in | TMDB API key for metadata |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / `sohil@123` | Admin panel credentials |
| `NODE_OPTIONS` | `--max-old-space-size=768` | Node.js memory limit |

---

## 11. Testing & Validation

- `npm run check:syntax` — runs `node --check` on all `.js` modules (no unit tests in repo)
- `npm run dev` — `node --watch index.js` for development
- `npm start` — production start

---

## 12. Dependencies (High-Level)

| Package | Role |
|---------|------|
| `express` | Web framework |
| `axios` | HTTP client for scraping |
| `cheerio-without-node-native` | HTML parsing for scrapers |
| `torrent-stream` | BitTorrent streaming engine |
| `redis` | Optional external cache |
| `ws` | WebSocket support (unused in core?) |
| `crypto-js` | Encryption for private configs |
| `easystreams` (github) | Vendored HTTP provider framework |
| `nuvio-providers-*` (github) | Latino/Arabic provider packs |

---

## 13. Gotchas for AI Assistants

1. **index.js is huge** (~4,400 lines). The HTML config page is embedded as a massive template string. Most business logic is in `services/`.
2. **ProviderService caches aggressively** — when debugging provider issues, clear `cache/provider-results/` or adjust TTL env vars.
3. **tamilian.cjs uses custom unpacker** — obfuscated JS unpacker for Tamilian.io embeds; fragile to site changes.
4. **torrent-scraper.cjs spawns subprocesses** — runs in isolated process to avoid blocking main loop.
5. **Memory guard may restart the process** — if editing in production, expect restarts under memory pressure.
6. **Private configs are stored in `cache/private-configs/`** as JSON files with hashed filenames.
7. **Reverse proxy mode** exists but is secondary; the primary mode is stream proxy/relay.
8. **No `User=` in systemd service** — the service is a user-scope service (`systemctl --user`).
