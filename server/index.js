import http from 'node:http';
import fsNative from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, saveConfig, mutateConfig, publicSettings, ensureDataDir, photoDir } from './config.js';
import { requireSafeLocal } from './security.js';
import { discoverCalendars, readCalendars, CalendarError, defaultCalendarRange } from './calendar.js';
import { listPhotos, listPhotoAlbums, optimizedPhoto, fetchWeather, searchPlaces, cacheState, photoCatalogState } from './providers.js';
import { spotifyConfigured, spotifyLoginUrl, spotifyCallback, getSpotify, spotifyAction, readSpotifyArtwork, spotifyScopeStatus } from './spotify.js';
import { searchSpotify, getSpotifyPlaylists, getSpotifyLibraryTracks, getSpotifyLibraryAlbums,
  getSpotifyAlbumTracks, getSpotifyPlaylistTracks, getSpotifyArtistAlbums, getSpotifyQueue, spotifyScopeFailure } from './spotify-library.js';
import { schoolStatus, listSchoolMessages, beginSchoolRefresh, initializeSchool, startSchoolPolling } from './school.js';

const PORT = Number(process.env.PORT || 8787);
const calendarCaches = new Map();
const latestCalendarCache = cacheState({ events: [], updatedAt: null, stale: true });
const weatherCache = cacheState({ current: null, hourly: [], daily: [], updatedAt: null, stale: true });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.webp': 'image/webp' };

function send(res, status, value, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(value === undefined ? '' : JSON.stringify(value));
}

async function bodyJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 32 * 1024) throw Object.assign(new Error('request_too_large'), { status: 413 });
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('invalid_json'), { status: 400 }); }
}

function errorCode(error) {
  return error instanceof CalendarError ? error.code : String(error?.message || 'internal_error')
    .replace(/[^a-z0-9_-]/gi, '_').slice(0, 80);
}

function calendarCacheKey(config, range) {
  return JSON.stringify([config.icloud?.email || '', [...config.calendarIds].sort(), range.rangeStart, range.rangeEnd]);
}

function cacheForCalendar(key, range) {
  let cache = calendarCaches.get(key);
  if (cache) calendarCaches.delete(key);
  else cache = cacheState({ events: [], rangeStart: range.rangeStart, rangeEnd: range.rangeEnd,
    updatedAt: null, stale: true });
  calendarCaches.set(key, cache);
  while (calendarCaches.size > 8) calendarCaches.delete(calendarCaches.keys().next().value);
  return cache;
}

function invalidateCalendarCache() {
  calendarCaches.clear();
  latestCalendarCache.invalidate({ events: [], updatedAt: null, stale: true });
}

async function rememberSpotifyScopeFailure(error) {
  if (!error?.missingScope) return;
  await mutateConfig(current => {
    current.spotify.scopeDenied = [...new Set([...current.spotify.scopeDenied, error.missingScope])];
  });
}

function parseCalendarRange(url, now = new Date()) {
  const fromValues = url.searchParams.getAll('from'), toValues = url.searchParams.getAll('to');
  if (!fromValues.length && !toValues.length) return defaultCalendarRange(now);
  if (fromValues.length !== 1 || toValues.length !== 1) throw new CalendarError('invalid_calendar_range', 400);
  const parseDate = value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new CalendarError('invalid_calendar_range', 400);
    const date = new Date(value + 'T00:00:00.000Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      throw new CalendarError('invalid_calendar_range', 400);
    }
    return date;
  };
  const from = parseDate(fromValues[0]), to = parseDate(toValues[0]);
  const days = (to.getTime() - from.getTime()) / 86_400_000;
  if (days <= 0 || days > 62) throw new CalendarError('invalid_calendar_range', 400);
  return { from, to, rangeStart: fromValues[0], rangeEnd: toValues[0] };
}

async function refreshCalendar(config, range, cache) {
  try {
    const value = await readCalendars(config, new Date(), fetch, range);
    cache.success(value);
    latestCalendarCache.success(value);
  } catch (error) {
    cache.fail(errorCode(error));
    latestCalendarCache.fail(errorCode(error));
  }
  const state = cache.get();
  return { ...state.value, stale: Boolean(state.error), error: state.error };
}

async function refreshWeather(config) {
  try { weatherCache.success(await fetchWeather(config.location)); }
  catch (error) { weatherCache.fail(errorCode(error)); }
  const state = weatherCache.get();
  return { ...state.value, stale: Boolean(state.error), error: state.error };
}

function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_settings');
  const value = {};
  if (Object.hasOwn(input, 'location')) {
    const l = input.location;
    if (!l || typeof l !== 'object' || Array.isArray(l)
        || !(l.latitude === null || Number.isFinite(l.latitude) && l.latitude >= -90 && l.latitude <= 90)
        || !(l.longitude === null || Number.isFinite(l.longitude) && l.longitude >= -180 && l.longitude <= 180)
        || typeof l.name !== 'string' || l.name.length > 120 || typeof l.timezone !== 'string' || l.timezone.length > 80) {
      throw new Error('invalid_location');
    }
    try { new Intl.DateTimeFormat('en', { timeZone: l.timezone }); } catch { throw new Error('invalid_timezone'); }
    value.location = { name: l.name.trim(), latitude: l.latitude, longitude: l.longitude, timezone: l.timezone };
  }
  if (Object.hasOwn(input, 'theme')) {
    if (!['auto', 'light', 'dark'].includes(input.theme)) throw new Error('invalid_theme');
    value.theme = input.theme;
  }
  if (Object.hasOwn(input, 'palette')) {
    if (!['linen', 'ocean', 'forest', 'ink'].includes(input.palette)) throw new Error('invalid_palette');
    value.palette = input.palette;
  }
  if (Object.hasOwn(input, 'photoAlbums')) {
    if (!Array.isArray(input.photoAlbums) || input.photoAlbums.length > 64
        || !input.photoAlbums.every(x => typeof x === 'string' && /^[a-f0-9]{24}$/.test(x))) throw new Error('invalid_photo_albums');
    value.photoAlbums = [...new Set(input.photoAlbums)];
  }
  for (const key of ['dayStart', 'nightStart']) if (Object.hasOwn(input, key)) {
    if (typeof input[key] !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input[key])) throw new Error('invalid_' + key);
    value[key] = input[key];
  }
  if (Object.hasOwn(input, 'photoInterval')) {
    if (!Number.isInteger(input.photoInterval) || input.photoInterval < 5 || input.photoInterval > 3600) throw new Error('invalid_photo_interval');
    value.photoInterval = input.photoInterval;
  }
  return value;
}

async function handler(req, res) {
  let url;
  try { url = new URL(req.url, 'http://' + (req.headers.host || 'localhost')); }
  catch { return send(res, 400, { error: 'invalid_request_url' }); }
  const method = req.method || 'GET';
  if ((url.pathname.startsWith('/api/') && method !== 'GET')
      || url.pathname === '/api/spotify/login' || url.pathname === '/api/spotify/callback'
      || method === 'GET' && (url.pathname === '/api/places' || url.pathname.startsWith('/api/spotify/artwork/'))) {
    if (!requireSafeLocal(req, res)) return;
  }
  if (method === 'OPTIONS' && url.pathname.startsWith('/api/')) return send(res, 204, undefined, { 'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
  try {
    if (method === 'GET' && url.pathname === '/api/health') return send(res, 200, { service: 'hearth-dashboard', status: 'ok' });
    const config = await loadConfig();

    if (method === 'GET' && url.pathname === '/api/school') return send(res, 200, schoolStatus());
    if (method === 'GET' && url.pathname === '/api/school/messages') {
      const limits = url.searchParams.getAll('limit'), offsets = url.searchParams.getAll('offset');
      if (limits.length > 1 || offsets.length > 1) return send(res, 400, { error: 'invalid_school_page' });
      try { return send(res, 200, listSchoolMessages({ limit: limits[0], offset: offsets[0] })); }
      catch (error) { return send(res, error.status || 400, { error: 'invalid_school_page' }); }
    }
    if (method === 'POST' && url.pathname === '/api/school/sync') {
      const current = schoolStatus();
      if (!current.configured) return send(res, 409, { error: 'school_not_configured', syncing: false });
      const started = beginSchoolRefresh({ onCalendarChanged: invalidateCalendarCache });
      return send(res, 202, { started, syncing: true });
    }

    if (method === 'GET' && url.pathname === '/api/settings') return send(res, 200, publicSettings(config));
    if (method === 'PUT' && url.pathname === '/api/settings') {
      let patch;
      try { patch = validateSettings(await bodyJson(req)); }
      catch (error) { return send(res, 400, { error: errorCode(error) }); }
      const updated = await mutateConfig(current => {
        const previousLocation = JSON.stringify(current.location);
        Object.assign(current, patch);
        return previousLocation !== JSON.stringify(current.location);
      });
      if (updated.result) weatherCache.invalidate();
      return send(res, 200, publicSettings(updated.config));
    }

    if (method === 'POST' && url.pathname === '/api/icloud/connect') {
      const input = await bodyJson(req);
      if (typeof input.email !== 'string' || input.email.length > 254
          || typeof input.password !== 'string' || !/^[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}$/i.test(input.password.trim())) {
        return send(res, 400, { error: 'invalid_icloud_credentials' });
      }
      const credentials = { email: input.email.trim(), password: input.password.trim() };
      const calendars = await discoverCalendars(credentials);
      const updated = await mutateConfig(current => {
        current.icloud = credentials;
        current.calendarIds = [];
      });
      invalidateCalendarCache();
      return send(res, 200, { calendars });
    }
    if (method === 'GET' && url.pathname === '/api/calendars') {
      const calendars = config.icloud ? await discoverCalendars(config.icloud) : [];
      return send(res, 200, { calendars });
    }
    if (method === 'PUT' && url.pathname === '/api/calendars') {
      const input = await bodyJson(req);
      if (!Array.isArray(input.calendarIds) || input.calendarIds.length > 12
          || !input.calendarIds.every(x => typeof x === 'string' && x.length <= 2048)) return send(res, 400, { error: 'invalid_calendar_selection' });
      const calendars = config.icloud ? await discoverCalendars(config.icloud) : [];
      const ids = new Set(calendars.map(c => c.id));
      if (!input.calendarIds.every(id => ids.has(id))) return send(res, 400, { error: 'unknown_calendar' });
      const updated = await mutateConfig(current => {
        if (JSON.stringify(current.icloud) !== JSON.stringify(config.icloud)) throw new Error('icloud_configuration_changed');
        current.calendarIds = [...new Set(input.calendarIds)];
      });
      invalidateCalendarCache();
      return send(res, 200, { calendars: calendars.filter(c => updated.config.calendarIds.includes(c.id)) });
    }
    if (method === 'GET' && url.pathname === '/api/calendar') {
      const range = parseCalendarRange(url);
      const cache = cacheForCalendar(calendarCacheKey(config, range), range);
      const state = cache.get();
      const fresh = state.value.rangeStart === range.rangeStart && state.value.rangeEnd === range.rangeEnd
        && state.value.updatedAt && Date.now() - Date.parse(state.value.updatedAt) < 60_000;
      if (fresh) {
        latestCalendarCache.success(state.value);
        return send(res, 200, { ...state.value, stale: Boolean(state.error), error: state.error });
      }
      return send(res, 200, await refreshCalendar(config, range, cache));
    }

    if (method === 'GET' && url.pathname === '/api/photo-albums') {
      return send(res, 200, { albums: await listPhotoAlbums() });
    }
    if (method === 'GET' && url.pathname === '/api/photos') {
      const result = await listPhotos(config.photoAlbums);
      return send(res, 200, result);
    }
    if (method === 'GET' && url.pathname.startsWith('/api/photos/')) {
      const image = await optimizedPhoto(url.pathname.slice('/api/photos/'.length));
      if (!image) return send(res, 404, { error: 'photo_not_found' });
      res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff', 'Last-Modified': new Date(image.mtimeMs).toUTCString() });
      return fsNative.createReadStream(image.path).pipe(res);
    }

    if (method === 'GET' && url.pathname === '/api/weather') {
      const state = weatherCache.get();
      const fresh = state.value.updatedAt && Date.now() - Date.parse(state.value.updatedAt) < 10 * 60_000;
      return send(res, 200, fresh ? { ...state.value, stale: Boolean(state.error), error: state.error } : await refreshWeather(config));
    }

    if (method === 'GET' && url.pathname === '/api/places') {
      const query = url.searchParams.get('q') || '';
      if (!query.trim() || query.length > 100) return send(res, 400, { error: 'invalid_place_query' });
      return send(res, 200, await searchPlaces(query));
    }

    if (method === 'POST' && url.pathname === '/api/spotify/config') {
      const input = await bodyJson(req);
      if (typeof input.clientId !== 'string' || !/^[a-zA-Z0-9]{20,64}$/.test(input.clientId)
          || Object.hasOwn(input, 'clientSecret') && (typeof input.clientSecret !== 'string' || input.clientSecret.length > 128)) {
        return send(res, 400, { error: 'invalid_spotify_config' });
      }
      await mutateConfig(current => {
        const changedClientId = current.spotify.clientId !== input.clientId;
        current.spotify.clientId = input.clientId;
        if (Object.hasOwn(input, 'clientSecret')) current.spotify.clientSecret = input.clientSecret;
        if (changedClientId) {
          current.spotify.accessToken = '';
          current.spotify.refreshToken = '';
          current.spotify.expiresAt = 0;
          current.spotify.scopes = [];
          current.spotify.scopeDenied = [];
        }
      });
      return send(res, 200, { configured: true });
    }
    if (method === 'POST' && url.pathname === '/api/spotify/logout') {
      await mutateConfig(current => {
        current.spotify.accessToken = '';
        current.spotify.refreshToken = '';
        current.spotify.expiresAt = 0;
        current.spotify.scopes = [];
        current.spotify.scopeDenied = [];
      });
      return send(res, 200, { connected: false, localTokensCleared: true, remoteRevocation: false });
    }
    if (method === 'GET' && url.pathname === '/api/spotify/login') {
      const target = await spotifyLoginUrl(config);
      res.writeHead(302, { Location: target, 'Cache-Control': 'no-store' }); return res.end();
    }
    if (method === 'GET' && url.pathname === '/api/spotify/callback') {
      await spotifyCallback(config, Object.fromEntries(url.searchParams));
      res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' }); return res.end();
    }
    if (method === 'POST' && url.pathname === '/api/spotify/action') {
      try {
        const result = await spotifyAction(config, await bodyJson(req));
        return send(res, 200, result || { ok: true });
      } catch (error) {
        await rememberSpotifyScopeFailure(error);
        return send(res, error.status || (error.needsReauth ? 403 : 502), spotifyScopeFailure(error));
      }
    }
    if (method === 'GET' && url.pathname === '/api/spotify/capabilities') {
      return send(res, 200, spotifyScopeStatus(config));
    }
    if (method === 'GET' && url.pathname === '/api/spotify/search') {
      try { return send(res, 200, await searchSpotify(config, Object.fromEntries(url.searchParams))); }
      catch (error) {
        await rememberSpotifyScopeFailure(error);
        return send(res, error.status || (error.needsReauth ? 403 : 502), spotifyScopeFailure(error));
      }
    }
    if (method === 'GET' && url.pathname === '/api/spotify/playlists') {
      try { return send(res, 200, await getSpotifyPlaylists(config, Object.fromEntries(url.searchParams))); }
      catch (error) {
        await rememberSpotifyScopeFailure(error);
        return send(res, error.status || (error.needsReauth ? 403 : 502), spotifyScopeFailure(error));
      }
    }
    if (method === 'GET' && url.pathname === '/api/spotify/library/tracks') {
      try { return send(res, 200, await getSpotifyLibraryTracks(config, Object.fromEntries(url.searchParams))); }
      catch (error) {
        await rememberSpotifyScopeFailure(error);
        return send(res, error.status || (error.needsReauth ? 403 : 502), spotifyScopeFailure(error));
      }
    }
    if (method === 'GET' && url.pathname === '/api/spotify/library/albums') {
      try { return send(res, 200, await getSpotifyLibraryAlbums(config, Object.fromEntries(url.searchParams))); }
      catch (error) {
        await rememberSpotifyScopeFailure(error);
        return send(res, error.status || (error.needsReauth ? 403 : 502), spotifyScopeFailure(error));
      }
    }
    if (method === 'GET' && url.pathname === '/api/spotify/queue') {
      try { return send(res, 200, await getSpotifyQueue(config)); }
      catch (error) { return send(res, error.status || (error.needsReauth ? 403 : 502), spotifyScopeFailure(error)); }
    }
    const albumTracks = method === 'GET' && url.pathname.match(/^\/api\/spotify\/albums\/([^/]+)\/tracks$/);
    if (albumTracks) {
      try { return send(res, 200, await getSpotifyAlbumTracks(config, albumTracks[1], Object.fromEntries(url.searchParams))); }
      catch (error) { return send(res, error.status || (error.needsReauth ? 403 : 502), spotifyScopeFailure(error)); }
    }
    const playlistTracks = method === 'GET' && url.pathname.match(/^\/api\/spotify\/playlists\/([^/]+)\/tracks$/);
    if (playlistTracks) {
      try { return send(res, 200, await getSpotifyPlaylistTracks(config, playlistTracks[1], Object.fromEntries(url.searchParams))); }
      catch (error) {
        await rememberSpotifyScopeFailure(error);
        return send(res, error.status || (error.needsReauth ? 403 : 502), spotifyScopeFailure(error));
      }
    }
    const artistAlbums = method === 'GET' && url.pathname.match(/^\/api\/spotify\/artists\/([^/]+)\/albums$/);
    if (artistAlbums) {
      try { return send(res, 200, await getSpotifyArtistAlbums(config, artistAlbums[1], Object.fromEntries(url.searchParams))); }
      catch (error) { return send(res, error.status || (error.needsReauth ? 403 : 502), spotifyScopeFailure(error)); }
    }
    if (method === 'GET' && url.pathname === '/api/spotify') {
      if (!spotifyConfigured(config) || !config.spotify.accessToken) {
        return send(res, 200, { connected: false, track: null, playing: false, progressMs: 0,
          shuffleState: null, repeatState: null, device: null, devices: [], scopes: spotifyScopeStatus(config), error: null });
      }
      try { return send(res, 200, await getSpotify(config)); }
      catch (error) {
        const message = errorCode(error);
        await rememberSpotifyScopeFailure(error);
        if (message.includes('reauthorization_required')) {
          await mutateConfig(current => { current.spotify.accessToken = ''; });
        } else if (message.includes('refresh_rejected')) {
          await mutateConfig(current => {
            current.spotify.accessToken = '';
            current.spotify.refreshToken = '';
          });
        }
        return send(res, 200, { connected: false, track: null, playing: false, progressMs: 0,
          shuffleState: null, repeatState: null, device: null, devices: [], scopes: spotifyScopeStatus(config),
          ...spotifyScopeFailure(error), error: message });
      }
    }
    if (method === 'GET' && url.pathname.startsWith('/api/spotify/artwork/')) {
      const id = url.pathname.slice('/api/spotify/artwork/'.length);
      try {
        const image = await readSpotifyArtwork(id);
        res.writeHead(200, { 'Content-Type': image.type, 'Content-Length': image.body.length,
          'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
        return res.end(image.body);
      } catch (error) {
        const code = errorCode(error);
        return send(res, code === 'spotify_artwork_not_found' ? 404 : 502, { error: code });
      }
    }

    if (method === 'GET' && url.pathname === '/api/status') {
      const calState = latestCalendarCache.get(), weatherState = weatherCache.get();
        let photos = photoCatalogState(), spotify = { connected: Boolean(config.spotify.accessToken), error: null };
      try { await fs.access(photoDir); } catch { photos.error = 'photo_directory_unavailable'; }
      if (!config.spotify.accessToken) spotify.connected = false;
      return send(res, 200, {
        calendar: { configured: Boolean(config.icloud && config.calendarIds.length),
          lastSuccess: calState.value.updatedAt, error: calState.error },
        spotify: { configured: spotifyConfigured(config), connected: spotify.connected, error: spotify.error },
        weather: { configured: Number.isFinite(config.location.latitude) && Number.isFinite(config.location.longitude),
          lastSuccess: weatherState.value.updatedAt, error: weatherState.error },
        photos: { configured: !photos.error, error: photos.error },
      });
    }

    if (method === 'GET' && url.pathname === '/') {
      try {
        const html = await fs.readFile(path.resolve('public/index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      } catch {}
    }
    if (method === 'GET' && !url.pathname.startsWith('/api/')) {
      let decoded;
      try { decoded = decodeURIComponent(url.pathname); } catch { return send(res, 400, { error: 'invalid_path' }); }
      const root = path.resolve('public');
      const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
      const target = path.resolve(root, relative);
      if (target.startsWith(root + path.sep)) {
        try {
          const stat = await fs.stat(target);
          if (stat.isFile()) {
            res.writeHead(200, { 'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
              'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
            return fsNative.createReadStream(target).pipe(res);
          }
        } catch {}
      }
    }
    return send(res, 404, { error: 'not_found' });
  } catch (error) {
    const code = errorCode(error);
    return send(res, error.status || (code === 'spotify_not_configured' ? 409 : 502), { error: code });
  }
}

export function createServer() { return http.createServer(handler); }

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const server = createServer();
  await ensureDataDir();
  await loadConfig();
  await initializeSchool();
  server.listen(PORT, '0.0.0.0', () => {
    console.log('hearth-dashboard listening on 0.0.0.0:' + PORT);
    void startSchoolPolling({ onCalendarChanged: invalidateCalendarCache }).catch(() => {});
  });
}
