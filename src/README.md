# Provider Adapter Architecture

Incremental adapter layer. Existing routes and formatting stay in `services/streamManager.js`.

## Plan

1. Keep current providers running.
2. Add adapter-backed providers through `PluginProviderRegistry`.
3. Convert external plugin output into Nebula internal stream schema.
4. Let existing cache, health, ranking, normalization, and Stremio formatting handle output.
5. Migrate old providers one-by-one behind adapters.

## Structure

- `adapters/`: external plugin execution, one class per plugin ecosystem.
- `providers/`: unified provider interface docs.
- `registry/`: provider registration and adapter lookup.
- `cache/`: cached manifests and plugin scripts.
- `normalizers/`: plugin stream cleanup into internal schema.
- `formatters/`: reserved for future formatter isolation.
- `utils/`: timeout and shared helpers.

## Interface

Adapters expose:

```js
await adapter.getStreams({
  tmdbId,
  mediaType,
  season,
  episode,
  signal
});
```

Return value: array of internal stream objects. No adapter formats Stremio response text.

## Current Integration

`nuvio` provider loads D3adlyRocket All-in-One-Nuvio manifest, caches it, downloads selected provider scripts, executes `getStreams()`, normalizes streams, then returns to existing Nebula pipeline.

## Error / Timeout

Each plugin has bounded timeout. Adapter has overall timeout. Failures return empty stream list and are tracked by existing provider health code.

## Cache

Manifest cache TTL: 1 hour. Script cache TTL: 6 hours. Provider result cache still handled by `ProviderService`.

## Ranking

`nuvio` is ranked as one provider first. Individual plugin names are retained in `sourceProvider` and `pluginProvider` for later per-plugin ranking.

