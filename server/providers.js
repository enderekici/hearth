import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { dataDir, photoDir } from './config.js';

const PHOTO_TYPES = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.tif', '.tiff']);
const VIDEO_TYPES = new Set(['.mp4']);
const photoCache = path.join(dataDir, 'photo-cache');
const MAX_LISTED_PHOTOS = 160;
let catalog = [];
let catalogMap = new Map();
let catalogUpdatedAt = null;
let catalogError = null;
let catalogRefreshing = null;
let catalogEpoch = 0;
let catalogSelection = null;

const albumId = name => crypto.createHash('sha256').update('album:' + name).digest('hex').slice(0, 24);

export async function listPhotoAlbums() {
  try {
    const entries = await fs.readdir(photoDir, { withFileTypes: true });
    const albums = entries.filter(e => e.isDirectory() && !e.isSymbolicLink()).map(e => ({ id: albumId(e.name), name: e.name }));
    if (entries.some(e => e.isFile() && (PHOTO_TYPES.has(path.extname(e.name).toLowerCase())
        || VIDEO_TYPES.has(path.extname(e.name).toLowerCase())))) albums.unshift({ id: albumId('root'), name: 'Photos' });
    return albums.sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function listPhotos(selectedAlbums = []) {
  const signature = [...selectedAlbums].sort().join(',');
  if (signature !== catalogSelection) {
    catalogSelection = signature;
    catalogEpoch++;
    catalog = [];
    catalogMap = new Map();
    catalogUpdatedAt = null;
    catalogError = null;
    catalogRefreshing = null;
  }
  if (!catalogRefreshing && (!catalogUpdatedAt || Date.now() - Date.parse(catalogUpdatedAt) > 15 * 60_000)) {
    const epoch = catalogEpoch;
    const task = rebuildPhotoCatalog(selectedAlbums, epoch);
    catalogRefreshing = task.finally(() => { if (epoch === catalogEpoch) catalogRefreshing = null; });
  }
  return { photos: catalog, updatedAt: catalogUpdatedAt, indexing: Boolean(catalogRefreshing),
    stale: Boolean(catalogError), error: catalogError };
}

async function rebuildPhotoCatalog(selectedAlbums, epoch) {
  const sample = [];
  const mapping = new Map();
  const chosen = new Set(selectedAlbums);
  let total = 0;
  async function walk(dir, rel = '') {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const nextRel = path.join(rel, entry.name);
      const full = path.join(dir, entry.name);
      const albumName = entry.isDirectory() ? (rel ? rel.split(path.sep)[0] : entry.name)
        : (rel ? rel.split(path.sep)[0] : 'root');
      const extension = path.extname(entry.name).toLowerCase();
      const isImage = entry.isFile() && PHOTO_TYPES.has(extension);
      const isVideo = entry.isFile() && VIDEO_TYPES.has(extension);
      if (selectedAlbums.length && !(chosen.has(albumId(albumName || 'root')))) continue;
      if (entry.isDirectory()) await walk(full, nextRel);
      else if (isImage || isVideo) {
        const id = crypto.createHash('sha256').update(nextRel).digest('hex').slice(0, 32);
        const item = isVideo
          ? { id, name: path.basename(entry.name), type: 'video', url: '/api/videos/' + id }
          : { id, url: '/api/photos/' + id, name: path.basename(entry.name) };
        total++;
        if (sample.length < MAX_LISTED_PHOTOS) {
          sample.push(item); mapping.set(id, { rel: nextRel, type: isVideo ? 'video' : 'image' });
        } else {
          const chosen = Math.floor(Math.random() * total);
          if (chosen < MAX_LISTED_PHOTOS) {
            mapping.delete(sample[chosen].id);
            sample[chosen] = item; mapping.set(id, { rel: nextRel, type: isVideo ? 'video' : 'image' });
          }
        }
      }
    }
  }
  try {
    await walk(photoDir);
    if (epoch === catalogEpoch) {
      catalog = sample;
      catalogMap = mapping;
      catalogUpdatedAt = new Date().toISOString();
      catalogError = null;
    }
  } catch (e) {
    if (epoch === catalogEpoch) catalogError = e.code === 'ENOENT' ? 'photo_directory_unavailable' : 'photo_index_failed';
  }
}

async function mediaPath(id, expectedType) {
  if (!/^[a-f0-9]{32}$/.test(id)) return null;
  if (!catalogUpdatedAt || Date.now() - Date.parse(catalogUpdatedAt) > 15 * 60_000) {
    await listPhotos(catalogSelection ? catalogSelection.split(',') : []);
  }
  const item = catalogMap.get(id);
  if (!item || item.type !== expectedType) return null;
  const root = path.resolve(photoDir);
  const target = path.resolve(root, item.rel);
  if (!target.startsWith(root + path.sep)) return null;
  try {
    const [rootReal, targetReal, stat, targetLstat] = await Promise.all([
      fs.realpath(root), fs.realpath(target), fs.stat(target), fs.lstat(target),
    ]);
    if (!targetReal.startsWith(rootReal + path.sep) || !stat.isFile() || targetLstat.isSymbolicLink()) return null;
    return { path: targetReal, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'ELOOP') return null;
    throw error;
  }
}

export async function optimizedPhoto(id) {
  const media = await mediaPath(id, 'image');
  if (!media) return null;
  await fs.mkdir(photoCache, { recursive: true, mode: 0o700 });
  const destination = path.join(photoCache, id + '.webp');
  try {
    const [src, dst] = await Promise.all([fs.stat(media.path), fs.stat(destination)]);
    if (dst.mtimeMs >= src.mtimeMs) return { path: destination, mtimeMs: dst.mtimeMs };
  } catch {}
  const temp = destination + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  await sharp(media.path, { failOn: 'none', limitInputPixels: 100_000_000 })
    .rotate().resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 }).toFile(temp);
  await fs.rename(temp, destination);
  const info = await fs.stat(destination);
  return { path: destination, mtimeMs: info.mtimeMs };
}

export async function videoFile(id) {
  return mediaPath(id, 'video');
}

export function photoCatalogState() {
  return { updatedAt: catalogUpdatedAt, stale: Boolean(catalogError), error: catalogError };
}

export async function fetchWeather(location, fetcher = fetch) {
  const { latitude, longitude, timezone } = location || {};
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error('location_not_configured');
  const params = new URLSearchParams({
    latitude: String(latitude), longitude: String(longitude), timezone: timezone || 'auto',
    timeformat: 'unixtime',
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m',
    hourly: 'temperature_2m,precipitation_probability,weather_code',
    daily: 'temperature_2m_min,temperature_2m_max,weather_code,sunrise,sunset',
    forecast_days: '7', forecast_hours: '24',
  });
  const res = await fetcher('https://api.open-meteo.com/v1/forecast?' + params,
    { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error('weather_upstream_' + res.status);
  const d = await res.json();
  if (!d.current || !d.hourly || !d.daily || !Number.isFinite(d.utc_offset_seconds)
      || !Array.isArray(d.hourly.time) || !Array.isArray(d.daily.time)) throw new Error('weather_response_invalid');
  const utcIso = seconds => {
    const value = Number(seconds);
    if (!Number.isFinite(value)) throw new Error('weather_response_invalid');
    return new Date(value * 1000).toISOString();
  };
  const civilDate = seconds => new Date((Number(seconds) + d.utc_offset_seconds) * 1000)
    .toISOString().slice(0, 10);
  return {
    current: { temperature: d.current.temperature_2m, feelsLike: d.current.apparent_temperature,
      code: d.current.weather_code, wind: d.current.wind_speed_10m, humidity: d.current.relative_humidity_2m },
    hourly: d.hourly.time.map((time, i) => ({ time: utcIso(time), temperature: d.hourly.temperature_2m[i],
      rainProbability: d.hourly.precipitation_probability[i], code: d.hourly.weather_code[i] })),
    daily: d.daily.time.map((date, i) => ({ date: civilDate(date), min: d.daily.temperature_2m_min[i],
      max: d.daily.temperature_2m_max[i], code: d.daily.weather_code[i],
      sunrise: utcIso(d.daily.sunrise[i]), sunset: utcIso(d.daily.sunset[i]) })),
    updatedAt: new Date().toISOString(), stale: false, error: null,
  };
}

export async function searchPlaces(query, fetcher = fetch) {
  const name = typeof query === 'string' ? query.trim() : '';
  if (!name || name.length > 100) throw new Error('invalid_place_query');
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
  url.search = new URLSearchParams({ name, count: '6', language: 'en', format: 'json' });
  const response = await fetcher(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('place_search_upstream_' + response.status);
  const contentLength = Number(response.headers.get('content-length'));
  if (contentLength > 128 * 1024) { await response.body?.cancel(); throw new Error('place_search_response_too_large'); }
  if (!response.body) throw new Error('place_search_response_invalid');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let size = 0, raw = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { raw += decoder.decode(); break; }
      size += value.byteLength;
      if (size > 128 * 1024) throw new Error('place_search_response_too_large');
      raw += decoder.decode(value, { stream: true });
    }
  } finally { await reader.cancel(); }
  const body = JSON.parse(raw);
  const results = Array.isArray(body.results) ? body.results.slice(0, 6).map(place => ({
    name: String(place.name || '').slice(0, 120),
    latitude: Number(place.latitude), longitude: Number(place.longitude),
    timezone: String(place.timezone || '').slice(0, 80),
    country: String(place.country || '').slice(0, 80),
    admin1: String(place.admin1 || '').slice(0, 80),
  })).filter(p => p.name && Number.isFinite(p.latitude) && p.latitude >= -90 && p.latitude <= 90
    && Number.isFinite(p.longitude) && p.longitude >= -180 && p.longitude <= 180) : [];
  return { results };
}

export function cacheState(initial = {}) {
  let value = initial;
  let lastError = null;
  return {
    get() { return { value, error: lastError }; },
    success(next) { value = next; lastError = null; },
    fail(error) { lastError = error; },
    invalidate(next = initial) { value = next; lastError = null; },
  };
}
