import crypto from 'node:crypto';
import { mutateConfig } from './config.js';

const REDIRECT = 'http://127.0.0.1:8787/api/spotify/callback';
const AUTH = 'https://accounts.spotify.com/authorize';
const TOKEN = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
export const SCOPES = ['user-read-private', 'user-read-playback-state', 'user-read-currently-playing',
  'user-modify-playback-state', 'user-library-read', 'playlist-read-private', 'playlist-read-collaborative'];
let pending = null;
const artworkUrls = new Map();
const artworkCache = new Map();
let artworkCacheBytes = 0;
const ART_MAX_BYTES = 2 * 1024 * 1024;
const ART_CACHE_BYTES = 12 * 1024 * 1024;
const SPOTIFY_ART_HOSTS = new Set(['i.scdn.co', 'image-cdn-ak.spotifycdn.com',
  'image-cdn-fa.spotifycdn.com', 'mosaic.scdn.co']);
export const spotifyFetchWithTimeout = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(15000) });

export function spotifyConfigured(config) { return Boolean(config.spotify?.clientId); }

export function spotifyScopeStatus(config) {
  const s = config.spotify || {};
  const granted = Array.isArray(s.scopes) ? [...s.scopes] : [];
  const denied = Array.isArray(s.scopeDenied) ? [...s.scopeDenied] : [];
  const known = granted.length > 0;
  const missing = [...new Set([...denied, ...(known ? SCOPES.filter(scope => !granted.includes(scope)) : [])])];
  const permits = (scope) => known ? granted.includes(scope) : denied.includes(scope) ? false : null;
  const permitsAny = (scopes) => known ? scopes.some(scope => granted.includes(scope))
    : scopes.every(scope => denied.includes(scope)) ? false : null;
  return { known, granted, missing, capabilities: {
    search: permits('user-read-private'), playlists: permits('playlist-read-private'),
    savedTracks: permits('user-library-read'), savedAlbums: permits('user-library-read'),
    playback: permits('user-read-playback-state'), queue: permitsAny(['user-read-currently-playing', 'user-read-playback-state']),
    modifyPlayback: permits('user-modify-playback-state'),
  } };
}

export function spotifyArtworkReference(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return ''; }
  const imagePath = url.hostname === 'mosaic.scdn.co'
    ? /^\/(?:60|300|640)\/[a-zA-Z0-9._-]{1,160}$/.test(url.pathname)
    : /^\/image\/[a-zA-Z0-9._-]{1,160}$/.test(url.pathname);
  if (url.protocol !== 'https:' || !SPOTIFY_ART_HOSTS.has(url.hostname) || url.port
      || url.username || url.password || url.search || url.hash || !imagePath) return '';
  const id = crypto.createHash('sha256').update(url.href).digest('hex');
  artworkUrls.set(id, url.href);
  while (artworkUrls.size > 256) artworkUrls.delete(artworkUrls.keys().next().value);
  return '/api/spotify/artwork/' + id;
}

export async function readSpotifyArtwork(id, fetcher = spotifyFetchWithTimeout) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('spotify_artwork_not_found');
  const url = artworkUrls.get(id);
  if (!url) throw new Error('spotify_artwork_not_found');
  const cached = artworkCache.get(url);
  if (cached) {
    artworkCache.delete(url); artworkCache.set(url, cached);
    return cached;
  }
  const response = await fetcher(url, { redirect: 'error' });
  if (!response.ok) throw new Error('spotify_artwork_unavailable');
  const type = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) {
    await response.body?.cancel();
    throw new Error('spotify_artwork_type_unsupported');
  }
  if (Number(response.headers.get('content-length')) > ART_MAX_BYTES) {
    await response.body?.cancel();
    throw new Error('spotify_artwork_too_large');
  }
  if (!response.body) throw new Error('spotify_artwork_empty');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > ART_MAX_BYTES) throw new Error('spotify_artwork_too_large');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel(); }
  const result = { body: Buffer.concat(chunks, size), type };
  while (artworkCacheBytes + size > ART_CACHE_BYTES && artworkCache.size) {
    const [oldUrl, old] = artworkCache.entries().next().value;
    artworkCache.delete(oldUrl); artworkCacheBytes -= old.body.length;
  }
  if (size <= ART_CACHE_BYTES) { artworkCache.set(url, result); artworkCacheBytes += size; }
  return result;
}

export async function spotifyLoginUrl(config) {
  if (!spotifyConfigured(config)) throw new Error('spotify_not_configured');
  const state = crypto.randomBytes(24).toString('hex');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  pending = { state, verifier, createdAt: Date.now() };
  const url = new URL(AUTH);
  url.search = new URLSearchParams({ response_type: 'code', client_id: config.spotify.clientId,
    redirect_uri: REDIRECT, scope: SCOPES.join(' '), state, code_challenge_method: 'S256',
    code_challenge: challenge }).toString();
  return url.toString();
}

async function tokenRequest(config, values, fetcher = spotifyFetchWithTimeout) {
  const s = config.spotify;
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (s.clientSecret) headers.Authorization = 'Basic ' + Buffer.from(s.clientId + ':' + s.clientSecret).toString('base64');
  const response = await fetcher(TOKEN, { method: 'POST', headers, body: new URLSearchParams(values) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    if (values.grant_type === 'refresh_token' && [400, 401].includes(response.status)) {
      throw new Error('spotify_refresh_rejected');
    }
    throw new Error('spotify_token_exchange_failed');
  }
  const grantedScopes = typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean)
    : values.grant_type === 'authorization_code' ? SCOPES : undefined;
  const updated = await mutateConfig(current => {
    if (current.spotify.clientId !== s.clientId) throw new Error('spotify_config_changed');
    current.spotify.accessToken = body.access_token;
    if (body.refresh_token) current.spotify.refreshToken = body.refresh_token;
    current.spotify.expiresAt = Date.now() + Number(body.expires_in || 3600) * 1000;
    if (grantedScopes) {
      current.spotify.scopes = [...new Set(grantedScopes)];
      current.spotify.scopeDenied = [];
    }
  });
  s.accessToken = body.access_token;
  if (body.refresh_token) s.refreshToken = body.refresh_token;
  s.expiresAt = updated.config.spotify.expiresAt;
  return s.accessToken;
}

export async function spotifyCallback(config, query, fetcher = spotifyFetchWithTimeout) {
  const p = pending;
  if (!p || Date.now() - p.createdAt > 10 * 60_000 || query.state !== p.state) throw new Error('spotify_oauth_state_invalid');
  pending = null;
  if (query.error) throw new Error('spotify_authorization_' + String(query.error).replace(/[^a-z0-9_-]/gi, '').slice(0, 40));
  if (!query.code) throw new Error('spotify_authorization_code_missing');
  await tokenRequest(config, { grant_type: 'authorization_code', code: query.code,
    redirect_uri: REDIRECT, client_id: config.spotify.clientId, code_verifier: p.verifier }, fetcher);
  return true;
}

async function accessToken(config, fetcher = spotifyFetchWithTimeout) {
  const s = config.spotify;
  if (!s.accessToken) throw new Error('spotify_not_connected');
  if (s.expiresAt > Date.now() + 30_000) return s.accessToken;
  if (!s.refreshToken) throw new Error('spotify_refresh_token_missing');
  await tokenRequest(config, { grant_type: 'refresh_token', refresh_token: s.refreshToken,
    client_id: s.clientId, ...(s.clientSecret ? { client_secret: s.clientSecret } : {}) }, fetcher);
  return s.accessToken;
}

export async function spotifyRequest(config, endpoint, options = {}, fetcher = spotifyFetchWithTimeout) {
  const token = await accessToken(config, fetcher);
  const res = await fetcher(API + endpoint, { ...options,
    headers: { Authorization: 'Bearer ' + token, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const code = res.status === 401 ? 'spotify_reauthorization_required'
      : res.status === 403 && /insufficient client scope/i.test(String(data?.error?.message || '')) ? 'spotify_insufficient_scope'
        : res.status === 403 ? 'spotify_premium_or_provider_restriction'
        : res.status === 404 ? 'spotify_device_unavailable' : 'spotify_api_error_' + res.status;
    throw Object.assign(new Error(code), { status: res.status });
  }
  return data;
}

export async function getSpotify(config, fetcher = spotifyFetchWithTimeout) {
  if (!spotifyConfigured(config)) return { connected: false, track: null, playing: false, progressMs: 0, device: null, devices: [], error: null };
  if (!config.spotify.accessToken) return { connected: false, track: null, playing: false, progressMs: 0, device: null, devices: [], error: null };
  let playback, deviceData;
  try {
    [playback, deviceData] = await Promise.all([
      spotifyRequest(config, '/me/player', {}, fetcher),
      spotifyRequest(config, '/me/player/devices', {}, fetcher),
    ]);
  } catch (error) {
    if (error.message === 'spotify_insufficient_scope') {
      error.missingScope = 'user-read-playback-state'; error.needsReauth = true;
    }
    throw error;
  }
  const item = playback?.item;
  const artwork = spotifyArtworkReference(item?.album?.images?.[0]?.url || '');
  return { connected: true, track: item ? { title: item.name, artist: item.artists?.map(a => a.name).join(', ') || '',
      album: item.album?.name || '', artwork,
      durationMs: item.duration_ms || 0 } : null,
    playing: Boolean(playback?.is_playing), progressMs: playback?.progress_ms || 0,
    shuffleState: typeof playback?.shuffle_state === 'boolean' ? playback.shuffle_state : null,
    repeatState: ['off', 'track', 'context'].includes(playback?.repeat_state) ? playback.repeat_state : null,
    scopes: spotifyScopeStatus(config),
    device: playback?.device ? { id: playback.device.id, name: playback.device.name,
      volume: playback.device.volume_percent, supportsVolume: playback.device.supports_volume } : null,
    devices: (deviceData?.devices || []).map(d => ({ id: d.id, name: d.name, volume: d.volume_percent,
      supportsVolume: d.supports_volume })), error: null };
}

export async function spotifyAction(config, input, fetcher = spotifyFetchWithTimeout) {
  const device = input.deviceId ? '?device_id=' + encodeURIComponent(input.deviceId) : '';
  const body = async (method, endpoint, value) => {
    try {
      return await spotifyRequest(config, endpoint, {
        method, ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      }, fetcher);
    } catch (error) {
      if (error.message === 'spotify_insufficient_scope') {
        error.missingScope = 'user-modify-playback-state'; error.needsReauth = true;
      }
      throw error;
    }
  };
  switch (input.action) {
    case 'play': {
      const payload = {};
      if (input.uri !== undefined) {
        if (typeof input.uri !== 'string' || !/^spotify:track:[A-Za-z0-9]{22}$/.test(input.uri)) throw new Error('invalid_spotify_uri');
        payload.uris = [input.uri];
      }
      if (input.contextUri !== undefined) {
        if (typeof input.contextUri !== 'string' || !/^spotify:(album|artist|playlist):[A-Za-z0-9]{22}$/.test(input.contextUri)) throw new Error('invalid_spotify_context');
        payload.context_uri = input.contextUri;
      }
      if (input.offsetUri !== undefined) {
        if (typeof input.offsetUri !== 'string' || !/^spotify:track:[A-Za-z0-9]{22}$/.test(input.offsetUri)) throw new Error('invalid_spotify_uri');
        payload.offset = { uri: input.offsetUri };
      }
      if (input.contextUri !== undefined && input.uri !== undefined) throw new Error('invalid_spotify_play_request');
      return body('PUT', '/me/player/play' + device, Object.keys(payload).length ? payload : undefined);
    }
    case 'pause': return body('PUT', '/me/player/pause' + device);
    case 'next': return body('POST', '/me/player/next' + device);
    case 'previous': return body('POST', '/me/player/previous' + device);
    case 'volume':
      if (!Number.isInteger(input.volume) || input.volume < 0 || input.volume > 100) throw new Error('invalid_volume');
      return body('PUT', '/me/player/volume?volume_percent=' + input.volume + (device ? '&' + device.slice(1) : ''));
    case 'transfer':
      if (!input.deviceId) throw new Error('spotify_device_required');
      return body('PUT', '/me/player', { device_ids: [input.deviceId], play: false });
    case 'seek':
      if (!Number.isInteger(input.positionMs) || input.positionMs < 0 || input.positionMs > 86_400_000) throw new Error('invalid_spotify_position');
      return body('PUT', '/me/player/seek?' + new URLSearchParams({ position_ms: String(input.positionMs), ...(input.deviceId ? { device_id: input.deviceId } : {}) }));
    case 'shuffle':
      if (typeof input.state !== 'boolean') throw new Error('invalid_spotify_shuffle');
      return body('PUT', '/me/player/shuffle?' + new URLSearchParams({ state: String(input.state), ...(input.deviceId ? { device_id: input.deviceId } : {}) }));
    case 'repeat':
      if (!['off', 'track', 'context'].includes(input.state)) throw new Error('invalid_spotify_repeat');
      return body('PUT', '/me/player/repeat?' + new URLSearchParams({ state: input.state, ...(input.deviceId ? { device_id: input.deviceId } : {}) }));
    case 'queue':
      if (typeof input.uri !== 'string' || !/^spotify:track:[A-Za-z0-9]{22}$/.test(input.uri)) throw new Error('invalid_spotify_uri');
      return body('POST', '/me/player/queue?' + new URLSearchParams({ uri: input.uri, ...(input.deviceId ? { device_id: input.deviceId } : {}) }));
    default: throw new Error('invalid_spotify_action');
  }
}

export { REDIRECT };
