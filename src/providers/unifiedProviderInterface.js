/**
 * Unified provider contract used by adapter-backed providers.
 *
 * @typedef {Object} ProviderRequest
 * @property {number} tmdbId
 * @property {'movie'|'tv'} mediaType
 * @property {?number} season
 * @property {?number} episode
 * @property {?AbortSignal} signal
 *
 * @typedef {Object} UnifiedStream
 * @property {string=} provider
 * @property {string=} sourceProvider
 * @property {string=} name
 * @property {string=} title
 * @property {string=} quality
 * @property {string=} url
 * @property {string=} magnet
 * @property {Object=} headers
 * @property {Object=} behaviorHints
 *
 * @typedef {Object} ProviderAdapter
 * @property {string} id
 * @property {(request: ProviderRequest) => Promise<UnifiedStream[]>} getStreams
 */

export const PROVIDER_INTERFACE_VERSION = 1;

