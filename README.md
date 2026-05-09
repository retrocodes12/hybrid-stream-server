<div align="center">

<img src="./assets/WhatsApp Image 2026-04-25 at 12.16.53 AM.jpeg" alt="NebulaStreams logo" width="220" />

# 📺 NebulaStreams

Lightweight scraper-backed streaming backend for Stremio.

[![live addon](https://img.shields.io/badge/live-nebula.work.gd-4f46e5)](https://nebula.work.gd/manifest.json)
[![configure](https://img.shields.io/badge/configure-nebula.work.gd%2Fconfigure-0ea5e9)](https://nebula.work.gd/configure)
[![node](https://img.shields.io/badge/node-%3E%3D20-339933)](https://nodejs.org/)
[![platform](https://img.shields.io/badge/platform-Render%20ready-46e3b7)](#render-deployment)
[![playback](https://img.shields.io/badge/playback-HTTP%20%2B%20Torrent-green)](#)
[![cache](https://img.shields.io/badge/cache-disk%20backed-6f42c1)](#)
[![runtime](https://img.shields.io/badge/runtime-low--end%20friendly-success)](#)

[Features](#features) • [Live Addon](https://nebula.work.gd/manifest.json) • [Configure](https://nebula.work.gd/configure) • [Render Deployment](#render-deployment) • [Local Development](#local-development)

</div>

## Features

- Stremio manifest and stream endpoints for movies and series
- Provider filtering and quality-priority install page at `/configure`
- Direct HTTP stream URLs for lower buffering
- Native Stremio torrent entries via `infoHash`
- Disk-backed provider and metadata cache

## Render Deployment

This repo includes [render.yaml](/home/sohil/hybrid-stream-server/render.yaml) for a Render Blueprint deployment.

1. Push this repo to GitHub.
2. In Render, create a new Blueprint and select this repository.
3. Render will create a Node web service using the settings in `render.yaml`.
4. After the first deploy, your install URL will be:
   `https://<your-service>.onrender.com/manifest.json`
5. The provider/quality configure page will be:
   `https://<your-service>.onrender.com/configure`

Important:
- Render free web services spin down after idle time, so the first request after sleeping will cold start.
- The addon now returns direct HTTP URLs and native Stremio torrent entries, so Render is mostly serving manifests and scraping providers, not relaying the media stream itself.
- Render's filesystem is ephemeral, so the cache resets on redeploy/restart.

## Local Development

```bash
npm ci
npm start
```

Local endpoints:
- `http://127.0.0.1:3000/manifest.json`
- `http://127.0.0.1:3000/configure`
- `http://127.0.0.1:3000/health`
