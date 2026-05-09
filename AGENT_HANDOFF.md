# NebulaStreams Backend Handoff

Use this file on the EC2 backend server. Work from the real repo path, likely:

```bash
cd ~/NebulaStreams
```

## Goal

Make live backend `https://nebula.work.gd` stable and stream-rich:

- ShowBox must not return stale `404 Not Found` playback links.
- `hdhub4u` and `4khdhub` must return streams without nginx `502/504`.
- CineStream should aggregate many working local providers.
- Provider failures should not spam huge stacks/log payloads.
- Process should restart only when memory usage reaches `95%`.

## First Checks

Run:

```bash
git status --short
pm2 status
pm2 logs nebulastreams --lines 250
curl -i https://nebula.work.gd/health
```

If code changes are present but not live:

```bash
pm2 restart nebulastreams --update-env
pm2 logs nebulastreams --lines 100
```

## Known Live Symptoms

Recent logs showed:

- `Kisskh Error: SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON`
- `fast provider search returning partial results before slow providers finished`
- `Castle timed out`
- `vixsrc timed out` stack traces
- direct `hdhub4u` / `4khdhub` endpoint could hit nginx `502/504`
- `Vidlink` dumped huge full API JSON responses
- HubCloud failures logged huge signed URLs and stack traces

Some partial-return logs are okay if stream count is high. Bad case is returning only 1 stream while CineStream/Hub providers finish seconds later.

## Fixes Expected In Code

Confirm these are present. If missing, implement them.

### ShowBox stale 404

In `services/streamManager.js`:

- Stremio result cache key version should be bumped.
- Source token TTL should respect signed URL params:
  - `token`
  - `KEY2`
  - `expires`
  - `expire`
  - `exp`
- ShowBox source tokens should be capped around 5 minutes, not 6 hours.

Verify:

```bash
curl -fsS 'https://nebula.work.gd/stream/movie/tmdb:1413196.json' -o /tmp/showbox.json
node -e "const j=require('/tmp/showbox.json'); console.log(j.streams?.length, j.streams?.[0]?.url)"
```

Then `curl -I -r 0-1023 '<stream-url>'` should show `206 Partial Content`, not `404`.

### Hub providers timeout

In `services/providerService.js`:

- `hdhub4u`, `4khdhub`, and `4khdhub_tv` should use fast timeout caps even if explicitly selected.
- Per-fetch timeout for those should be around `18_000ms`.
- Parallel timeout should be around `22_000ms`.

In `services/streamManager.js`:

- `/providers/:provider/streams` should call provider service with `priorityRequest: true` and `enforceFastTimeout: true`.
- Direct provider normalization should have timeout fallback, so HubCloud resolution cannot make nginx return `502/504`.

Verify:

```bash
curl -fsS 'https://nebula.work.gd/providers/hdhub4u/streams?tmdbId=1316092&mediaType=movie' | head -c 500
curl -fsS 'https://nebula.work.gd/providers/4khdhub/streams?tmdbId=1316092&mediaType=movie' | head -c 500
```

Expected: JSON with `count > 0`, not nginx HTML.

### CineStream provider fanout

In `vendor/HTTP/providers/cinestream.js`, CineStream should fan out to local providers:

```text
vidlink, videasy, moviebox, streamflix, fmovies, playimdb, playimdb_v2,
multivid, vidsrc, vixsrc, netmirror, onetouchtv
```

Each source group should be timeout bounded, so slow sources do not block whole CineStream.

Verify:

```bash
curl -fsS 'https://nebula.work.gd/stream/movie/tmdb:1316092.json?providers=cinestream' | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const j=JSON.parse(s);console.log(j.streams?.length,j.streams?.[0]?.name)})"
```

Expected: many streams, not zero.

### KissKH JSON safety

In `vendor/HTTP/providers/kisskh.js`:

- Do not call `response.json()` blindly.
- Read text first.
- If response is HTML or non-JSON, log short `KissKH skipped: ...` and return `[]`.
- No `Unexpected token '<'` stack.

Verify:

```bash
curl -fsS 'https://nebula.work.gd/providers/kisskh/streams?tmdbId=212204&mediaType=tv&season=1&episode=1' | head -c 500
```

### Fast search quality

In `services/providerService.js`:

- Fast search should wait for `cinestream` if it is in the primary provider set.
- When returning partial results, abort pending provider controllers.
- Partial results with `resultCount > 0` should log as `info`, not `warn`.
- Timeout abort reason sent into provider internals should be cancellation, to reduce scary stack traces.

Verify logged case:

```bash
curl -fsS 'https://nebula.work.gd/stream/series/tmdb:76479:5:6.json' -o /tmp/boys.json
node -e "const j=require('/tmp/boys.json'); console.log(j.streams?.length, j.streams?.slice(0,5).map(s=>s.name))"
```

Expected: dozens of streams, not only 1 `vixsrc` stream.

### Log spam cleanup

In `vendor/HTTP/providers/vidlink.js`:

- Do not log full `JSON.stringify(data, null, 2)`.
- Log compact summary only.

In `services/streamManager.js` HubCloud catch:

- Do not log full signed `streamUrl`.
- Do not log full stack object.
- Log `streamHost`, `errorName`, `errorMessage`, `statusCode`.

### Memory restart

Restart only when memory usage reaches `95%`.

In `config.js`:

```js
MEMORY_GUARD_RESTART_PERCENT default should be 95
```

In `index.js`:

```js
const restartRequired = usagePercent >= config.MEMORY_GUARD_RESTART_PERCENT;
```

Do not restart due only to `criticalStrikes` or `MIN_AVAILABLE_MB`.

In deploy/env config:

```text
MEMORY_GUARD_RESTART_PERCENT=95
```

## Verification Commands

Run after changes:

```bash
npm run check:syntax
pm2 restart nebulastreams --update-env
sleep 5
curl -i https://nebula.work.gd/health
curl -fsS 'https://nebula.work.gd/stream/series/tmdb:76479:5:6.json' -o /tmp/boys.json
node -e "const j=require('/tmp/boys.json'); console.log('streams', j.streams?.length)"
curl -fsS 'https://nebula.work.gd/providers/hdhub4u/streams?tmdbId=1316092&mediaType=movie' -o /tmp/hdhub4u.json
node -e "const j=require('/tmp/hdhub4u.json'); console.log('hdhub4u', j.count || j.streams?.length)"
curl -fsS 'https://nebula.work.gd/providers/4khdhub/streams?tmdbId=1316092&mediaType=movie' -o /tmp/4khdhub.json
node -e "const j=require('/tmp/4khdhub.json'); console.log('4khdhub', j.count || j.streams?.length)"
pm2 logs nebulastreams --lines 150
```

## Expected Good Results

- `tmdb:76479:5:6` returns many streams, previously tested locally around `40+`.
- `hdhub4u` Wuthering Heights returns `count > 0`.
- `4khdhub` Wuthering Heights returns `count > 0`.
- KissKH does not throw JSON parse stack.
- No nginx `502/504` for direct provider routes.
- No giant Vidlink API dumps.
- No giant HubCloud signed URLs in logs.

## Notes

- `Castle timed out` can be normal if upstream is slow.
- `MovieBox No streams from worker` can be normal for missing titles.
- `fast provider search returning partial results` is not automatically bad; bad only when result count is tiny and better providers finish shortly after.
