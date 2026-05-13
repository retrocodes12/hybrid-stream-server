# NebulaStreams Provider Adapter Architecture

## 1. Refactor Plan

Keep current routes and formatting. Add adapter-backed providers beside old scrapers. Move provider ecosystems into `src/adapters`, register them through `src/registry`, normalize into one internal stream schema, then let existing `ProviderService` and `StreamManager` handle cache, health, ranking, filtering, and Stremio output.

Next migrations:
- add more plugin ecosystems as adapters
- split old `vendor/HTTP/providers` into legacy adapter
- move formatting helpers from `streamManager` into `src/formatters`
- move stream cleanup into `src/normalizers`

## 2. Folder Structure

```text
src/
  adapters/
  providers/
  registry/
  cache/
  formatters/
  normalizers/
  utils/
```

## 3. Unified Provider Interface

Adapters expose:

```js
adapter.getStreams({
  tmdbId,
  mediaType,
  season,
  episode,
  signal
});
```

Adapters return internal streams only. No Stremio card formatting in adapters.

## 4. Adapter Examples

Current:
- `NuvioPluginAdapter`: loads D3adlyRocket All-in-One-Nuvio manifest and provider scripts.

Future:
- `RemoteAddonAdapter`: call external Stremio addon stream route.
- `LegacyProviderAdapter`: wrap local `vendor/HTTP/providers`.

## 5. Migration Strategy

1. Add `nuvio` as provider adapter.
2. Keep old providers as fallback.
3. Prefer adapter providers in fast search.
4. Observe health and stream counts.
5. Replace brittle internal scrapers one provider family at a time.

## 6. Error Handling

Plugin errors are contained per plugin. One broken plugin returns `[]`, not route failure. Existing provider health tracks `nuvio` as provider. Future improvement: track `pluginProvider` separately.

## 7. Caching Strategy

Manifest cache: 1 hour. Script cache: 6 hours. Provider result cache remains in `ProviderService`. Stremio result cache remains in `StreamManager`.

## 8. Timeout / Retry

Adapter overall timeout: 15s. Plugin timeout: 7s each. Slow plugins fail closed. Existing fast search timeout still protects AIOStreams.

## 9. Ranking

`nuvio` is high-priority provider. Individual plugin identity stored in:
- `sourceProvider`
- `pluginProvider`
- `pluginProviderName`
- `sourceSite`

Future ranking can score per plugin without changing response formatter.

## 10. Current Implementation

Integrated provider:
- `nuvio`

Source:
- `https://github.com/D3adlyRocket/All-in-One-Nuvio`

Execution:
- fetch cached manifest
- select enabled plugins
- fetch cached plugin script
- execute CommonJS `getStreams(tmdbId, mediaType, season, episode)`
- normalize stream headers, source labels, quality, URL/magnet
- return to existing Nebula formatter

