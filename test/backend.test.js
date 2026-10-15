import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { once } from 'node:events';
import http from 'node:http';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hearth-dashboard-'));
process.env.DATA_DIR = path.join(root, 'data');
process.env.PHOTO_DIR = path.join(root, 'photos');
await fs.mkdir(process.env.PHOTO_DIR, { recursive: true });
const configStore = await import('../server/config.js');
const calendar = await import('../server/calendar.js');
const photos = await import('../server/providers.js');
const spotify = await import('../server/spotify.js');
const { createServer } = await import('../server/index.js');

let server, base;
before(async () => {
  server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = 'http://127.0.0.1:' + server.address().port;
});
after(async () => {
  server?.close();
  await fs.rm(root, { recursive: true, force: true });
});

test('iCloud calendar parser converts explicit IANA timezones and rejects DST ambiguity', () => {
  const make = (start, end) => 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART;TZID=Europe/London:' + start + '\r\nDTEND;TZID=Europe/London:' + end + '\r\nSUMMARY:Meeting\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const summer = calendar.parseEvents(make('20260701T110000', '20260701T120000'), 'cal')[0];
  assert.equal(summer.start, '2026-07-01T10:00:00.000Z');
  const winter = calendar.parseEvents(make('20260110T110000', '20260110T120000'), 'cal')[0];
  assert.equal(winter.start, '2026-01-10T11:00:00.000Z');
  assert.throws(() => calendar.parseEvents(make('20261025T013000', '20261025T023000'), 'cal'),
    { code: 'ambiguous_or_nonexistent_calendar_time' });
  assert.throws(() => calendar.parseEvents(make('20260329T013000', '20260329T023000'), 'cal'),
    { code: 'ambiguous_or_nonexistent_calendar_time' });
});

test('CalDAV URL validation rejects non-Apple redirect targets', () => {
  assert.equal(calendar.appleURL('https://p12-caldav.icloud.com/path').hostname, 'p12-caldav.icloud.com');
  assert.throws(() => calendar.appleURL('http://caldav.icloud.com/'), { code: 'untrusted_calendar_url' });
  assert.throws(() => calendar.appleURL('https://attacker.example/'), { code: 'untrusted_calendar_url' });
});

test('config uses an atomic private file and returns no integration secrets in settings', async () => {
  await configStore.ensureDataDir();
  const config = structuredClone(configStore.defaults);
  config.icloud = { email: 'user@example.test', password: 'abcd-efgh-ijkl-mnop' };
  config.spotify.clientSecret = 'private';
  await configStore.saveConfig(config);
  const stat = await fs.stat(configStore.configPath);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.deepEqual(configStore.publicSettings(await configStore.loadConfig()), {
    location: config.location, calendarIds: [], photoAlbums: [], theme: 'auto',
    palette: 'linen',
    dayStart: '07:00', nightStart: '22:00', photoInterval: 30, spotifyClientId: '',
  });
});

test('palette setting defaults old configs and persists only supported palette names', async () => {
  const legacy = structuredClone(configStore.defaults);
  delete legacy.palette;
  await configStore.saveConfig(legacy);
  assert.equal((await configStore.loadConfig()).palette, 'linen');

  const accepted = await fetch(base + '/api/settings', { method: 'PUT',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ palette: 'forest' }) });
  assert.equal(accepted.status, 200);
  const publicConfig = await accepted.json();
  assert.equal(publicConfig.palette, 'forest');
  assert.equal(publicConfig.theme, 'auto');
  assert.equal((await configStore.loadConfig()).palette, 'forest');

  const rejected = await fetch(base + '/api/settings', { method: 'PUT',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ palette: 'neon' }) });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error, 'invalid_palette');
  assert.equal((await configStore.loadConfig()).palette, 'forest');
});

test('concurrent setting updates merge without losing fields', async () => {
  const responses = await Promise.all([
    fetch(base + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: 'light' }) }),
    fetch(base + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dayStart: '06:30' }) }),
  ]);
  assert.deepEqual(responses.map(r => r.status), [200, 200]);
  const saved = await configStore.loadConfig();
  assert.equal(saved.theme, 'light');
  assert.equal(saved.dayStart, '06:30');
});

test('Spotify config preserves tokens for the same client ID and clears them when it changes', async () => {
  const initialId = 'A'.repeat(20), replacementId = 'B'.repeat(20);
  await configStore.mutateConfig(config => {
    config.spotify = { clientId: initialId, clientSecret: 'old-secret', accessToken: 'access',
      refreshToken: 'refresh', expiresAt: 123456 };
  });
  const sameId = await fetch(base + '/api/spotify/config', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: initialId }) });
  assert.equal(sameId.status, 200);
  let saved = await configStore.loadConfig();
  assert.deepEqual(saved.spotify, { clientId: initialId, clientSecret: 'old-secret', accessToken: 'access',
    refreshToken: 'refresh', expiresAt: 123456, scopes: [], scopeDenied: [] });

  const settings = await (await fetch(base + '/api/settings')).json();
  assert.equal(settings.spotifyClientId, initialId);
  assert.equal(Object.hasOwn(settings, 'spotifyClientSecret'), false);
  assert.equal(JSON.stringify(settings).includes('old-secret'), false);

  const changedId = await fetch(base + '/api/spotify/config', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: replacementId }) });
  assert.equal(changedId.status, 200);
  saved = await configStore.loadConfig();
  assert.deepEqual(saved.spotify, { clientId: replacementId, clientSecret: 'old-secret', accessToken: '',
    refreshToken: '', expiresAt: 0, scopes: [], scopeDenied: [] });
});

test('photo catalog is bounded, album-selectable, ignores symlinks, and caches optimized copies', async () => {
  const photosRoot = process.env.PHOTO_DIR;
  await fs.mkdir(path.join(photosRoot, 'Family'), { recursive: true });
  await fs.mkdir(path.join(photosRoot, 'Trips'), { recursive: true });
  const source = path.join(photosRoot, 'Family', 'portrait.png');
  await sharp({ create: { width: 24, height: 12, channels: 3, background: '#c04030' } }).png().toFile(source);
  const external = path.join(root, 'outside.png');
  await sharp({ create: { width: 8, height: 8, channels: 3, background: '#00aa00' } }).png().toFile(external);
  await fs.symlink(external, path.join(photosRoot, 'Trips', 'linked.png'));
  const albums = await photos.listPhotoAlbums();
  const family = albums.find(x => x.name === 'Family');
  assert.ok(family);
  let result = await photos.listPhotos([family.id]);
  for (let i = 0; i < 50 && !result.updatedAt; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    result = await photos.listPhotos([family.id]);
  }
  assert.equal(result.photos.length, 1);
  assert.equal(result.photos[0].name, 'portrait.png');
  assert.ok(result.photos.length <= 160);
  const before = await fs.readFile(source);
  const image = await photos.optimizedPhoto(result.photos[0].id);
  assert.ok(image.path.includes('photo-cache'));
  assert.equal((await sharp(image.path).metadata()).format, 'webp');
  assert.deepEqual(await fs.readFile(source), before);
  assert.equal(await photos.optimizedPhoto('../outside.png'), null);
});

test('write APIs reject cross-origin and untrusted Host requests', async () => {
  const badOrigin = await fetch(base + '/api/settings', { method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{}' });
  assert.equal(badOrigin.status, 403);
  const badHost = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: '/api/settings', method: 'PUT', headers: { Host: 'evil.example', 'Content-Type': 'application/json' } }, res => {
      res.resume(); res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', reject); req.end('{}');
  });
  assert.equal(badHost.status, 403);
  const good = await fetch(base + '/api/settings', { method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ theme: 'dark' }) });
  assert.equal(good.status, 200);
  assert.equal((await good.json()).theme, 'dark');
});

test('iCloud setup rejects a main-account password before network access', async () => {
  const response = await fetch(base + '/api/icloud/connect', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'user@example.test', password: 'main-account-password' }) });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_icloud_credentials' });
});

test('place search calls only the fixed Open-Meteo host and maps bounded results', async () => {
  let requested;
  const result = await photos.searchPlaces(' London ', async (url, options) => {
    requested = { url: new URL(url), options };
    return new Response(JSON.stringify({ results: [
      { name: 'London', latitude: 51.5, longitude: -0.12, timezone: 'Europe/London', country: 'United Kingdom', admin1: 'England', extra: 'drop' },
      { name: 'Invalid', latitude: 900, longitude: 0, timezone: 'UTC' },
    ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  assert.equal(requested.url.origin, 'https://geocoding-api.open-meteo.com');
  assert.equal(requested.url.pathname, '/v1/search');
  assert.equal(requested.url.searchParams.get('name'), 'London');
  assert.equal(requested.url.searchParams.get('count'), '6');
  assert.equal(requested.options.signal.aborted, false);
  assert.deepEqual(result, { results: [{ name: 'London', latitude: 51.5, longitude: -0.12,
    timezone: 'Europe/London', country: 'United Kingdom', admin1: 'England' }] });
  await assert.rejects(() => photos.searchPlaces('x'.repeat(101)), { message: 'invalid_place_query' });
  await assert.rejects(() => photos.searchPlaces('x'.repeat(101), async () => { throw new Error('network must not be called'); }),
    { message: 'invalid_place_query' });
  await assert.rejects(() => photos.searchPlaces('London', async () => new Response(
    Buffer.alloc(128 * 1024 + 1), { status: 200, headers: { 'Content-Type': 'application/json' } })),
  { message: 'place_search_response_too_large' });
});

test('place search and Spotify artwork routes enforce same-origin Host checks', async () => {
  const response = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: '/api/places?q=London', headers: { Origin: 'http://evil.example' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end();
  });
  assert.equal(response, 403);
  const originalFetch = globalThis.fetch;
  let upstreamUrl;
  globalThis.fetch = async url => {
    upstreamUrl = new URL(url);
    return new Response(JSON.stringify({ results: [{ name: 'Town', latitude: 12, longitude: 34,
      timezone: 'UTC', country: 'Test', admin1: 'Region' }] }), { status: 200 });
  };
  try {
    const local = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
        path: '/api/places?q=Town', headers: { Origin: base } }, res => {
        let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
      });
      req.on('error', reject); req.end();
    });
    assert.equal(local.status, 200);
    assert.equal(upstreamUrl.hostname, 'geocoding-api.open-meteo.com');
    assert.equal(local.body.results[0].name, 'Town');
  } finally { globalThis.fetch = originalFetch; }
});

test('Spotify artwork proxy allowlists exact CDN URLs, bounds bytes, and caches by URL', async () => {
  assert.equal(spotify.spotifyArtworkReference('https://i.scdn.co.evil.example/image/track'), '');
  assert.equal(spotify.spotifyArtworkReference('https://i.scdn.co:444/image/track'), '');
  assert.equal(spotify.spotifyArtworkReference('https://image-cdn-evil.spotifycdn.com/image/track'), '');
  assert.equal(spotify.spotifyArtworkReference('https://mosaic.scdn.co.evil.example/640/track'), '');
  assert.equal(spotify.spotifyArtworkReference('https://mosaic.scdn.co/720/track'), '');
  const reference = spotify.spotifyArtworkReference('https://i.scdn.co/image/test-proxy-unique');
  assert.match(reference, /^\/api\/spotify\/artwork\/[a-f0-9]{64}$/);
  const id = reference.split('/').at(-1);
  const expected = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  let calls = 0;
  const fetcher = async (url, options) => {
    calls++;
    assert.equal(new URL(url).href, 'https://i.scdn.co/image/test-proxy-unique');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers, undefined);
    return new Response(expected, { status: 200, headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(expected.length) } });
  };
  const first = await spotify.readSpotifyArtwork(id, fetcher);
  const second = await spotify.readSpotifyArtwork(id, fetcher);
  assert.equal(calls, 1);
  assert.equal(first.type, 'image/jpeg');
  assert.deepEqual(first.body, expected);
  assert.deepEqual(second.body, expected);

  for (const url of ['https://image-cdn-ak.spotifycdn.com/image/test-ak',
    'https://image-cdn-fa.spotifycdn.com/image/test-fa', 'https://mosaic.scdn.co/640/test-mosaic']) {
    const allowed = spotify.spotifyArtworkReference(url);
    assert.match(allowed, /^\/api\/spotify\/artwork\/[a-f0-9]{64}$/);
    const proxied = await spotify.readSpotifyArtwork(allowed.split('/').at(-1), async (upstream, options) => {
      assert.equal(new URL(upstream).href, url);
      assert.equal(options.redirect, 'error');
      return new Response(expected, { status: 200,
        headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(expected.length) } });
    });
    assert.deepEqual(proxied.body, expected);
  }

  const tooLarge = spotify.spotifyArtworkReference('https://i.scdn.co/image/test-proxy-large');
  await assert.rejects(() => spotify.readSpotifyArtwork(tooLarge.split('/').at(-1), async () =>
    new Response(Buffer.alloc(2 * 1024 * 1024 + 1), { status: 200,
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(2 * 1024 * 1024 + 1) } })),
  { message: 'spotify_artwork_too_large' });
});

test('Spotify playback exposes only a local artwork reference', async () => {
  const config = { spotify: { clientId: 'client', clientSecret: '', accessToken: 'token',
    refreshToken: 'refresh', expiresAt: Date.now() + 3600000 } };
  const state = await spotify.getSpotify(config, async url => {
    if (String(url).endsWith('/me/player/devices')) {
      return new Response(JSON.stringify({ devices: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ is_playing: true, item: {
      name: 'Song', artists: [{ name: 'Artist' }], album: { name: 'Album',
        images: [{ url: 'https://i.scdn.co/image/local-art-reference-test' }] }, duration_ms: 1000,
    } }), { status: 200 });
  });
  assert.equal(state.track.title, 'Song');
  assert.match(state.track.artwork, /^\/api\/spotify\/artwork\/[a-f0-9]{64}$/);
});

test('weather timestamps remain absolute UTC while daily dates use the selected timezone', async () => {
  const localMidnight = Date.UTC(2026, 0, 1, 0, 0, 0) / 1000;
  const payload = {
    utc_offset_seconds: 10800,
    current: { temperature_2m: 8, apparent_temperature: 7, weather_code: 2,
      wind_speed_10m: 4, relative_humidity_2m: 60 },
    hourly: { time: [localMidnight - 10800], temperature_2m: [9],
      precipitation_probability: [10], weather_code: [1] },
    daily: { time: [localMidnight - 10800], temperature_2m_min: [5],
      temperature_2m_max: [12], weather_code: [2], sunrise: [localMidnight + 21600],
      sunset: [localMidnight + 64800] },
  };
  let requested;
  const result = await photos.fetchWeather({ latitude: 41, longitude: 29, timezone: 'Europe/Istanbul' },
    async url => { requested = new URL(url); return new Response(JSON.stringify(payload)); });
  assert.equal(requested.searchParams.get('timeformat'), 'unixtime');
  assert.equal(result.hourly[0].time, '2025-12-31T21:00:00.000Z');
  assert.equal(result.daily[0].date, '2026-01-01');
  assert.equal(result.daily[0].sunrise, '2026-01-01T06:00:00.000Z');
  assert.equal(result.daily[0].sunset, '2026-01-01T18:00:00.000Z');
});

test('calendar selection response reflects the newly saved selection', async () => {
  const first = 'https://caldav.icloud.com/calendars/first/';
  const second = 'https://caldav.icloud.com/calendars/second/';
  await configStore.mutateConfig(current => {
    current.icloud = { email: 'user@example.test', password: 'abcd-efgh-ijkl-mnop' };
    current.calendarIds = [first];
  });
  const principalXml = '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/principal</d:href></d:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';
  const homeXml = '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/principal</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>/calendars/</d:href></c:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';
  const listingXml = '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:x="http://apple.com/ns/ical/"><d:response><d:href>/calendars/first/</d:href><d:propstat><d:prop><d:displayname>First</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><x:calendar-color>#111111</x:calendar-color></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>/calendars/second/</d:href><d:propstat><d:prop><d:displayname>Second</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><x:calendar-color>#222222</x:calendar-color></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const pathname = new URL(url).pathname;
    const text = pathname === '/' ? principalXml : pathname === '/principal' ? homeXml : listingXml;
    return new Response(text, { status: 207, headers: { 'Content-Type': 'application/xml' } });
  };
  try {
    const response = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
        path: '/api/calendars', method: 'PUT', headers: { 'Content-Type': 'application/json' } }, res => {
        let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
      });
      req.on('error', reject); req.end(JSON.stringify({ calendarIds: [second] }));
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.calendars.map(item => item.id), [second]);
    assert.deepEqual((await configStore.loadConfig()).calendarIds, [second]);
  } finally { globalThis.fetch = originalFetch; }
});

test('calendar endpoint validates bounded exclusive ranges and caches by range', async () => {
  const defaultRange = calendar.defaultCalendarRange(new Date('2026-01-02T14:00:00.000Z'));
  assert.equal(defaultRange.rangeStart, '2026-01-01');
  assert.equal(defaultRange.rangeEnd, '2026-02-06');
  const calendarId = 'https://caldav.icloud.com/calendars/range-test/';
  await configStore.mutateConfig(config => {
    config.icloud = { email: 'user@example.test', password: 'abcd-efgh-ijkl-mnop' };
    config.calendarIds = [calendarId];
  });
  const principalXml = '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/principal</d:href></d:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';
  const homeXml = '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/principal</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>/calendars/</d:href></c:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';
  const listingXml = '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:x="http://apple.com/ns/ical/"><d:response><d:href>/calendars/range-test/</d:href><d:propstat><d:prop><d:displayname>Range Test</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><x:calendar-color>#333333</x:calendar-color></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';
  const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:range-event\r\nDTSTART:20260715T100000Z\r\nDTEND:20260715T110000Z\r\nSUMMARY:Range event\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const reportXml = '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/events.ics</d:href><d:propstat><d:prop><c:calendar-data><![CDATA[' + ics + ']]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';
  const originalFetch = globalThis.fetch;
  const reportBodies = [];
  globalThis.fetch = async (url, options) => {
    const pathname = new URL(url).pathname;
    if (options.method === 'REPORT') { reportBodies.push(options.body); return new Response(reportXml, { status: 207 }); }
    const body = pathname === '/' ? principalXml : pathname === '/principal' ? homeXml : listingXml;
    return new Response(body, { status: 207 });
  };
  const request = path => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject); req.end();
  });
  try {
    const firstPath = '/api/calendar?from=2026-07-01&to=2026-08-12';
    const first = await request(firstPath);
    assert.equal(first.status, 200);
    assert.equal(first.body.rangeStart, '2026-07-01');
    assert.equal(first.body.rangeEnd, '2026-08-12');
    assert.equal(first.body.events[0].title, 'Range event');
    assert.match(reportBodies[0], /<c:expand start="20260701T000000Z" end="20260812T000000Z"\/>/);
    assert.match(reportBodies[0], /<c:time-range start="20260701T000000Z" end="20260812T000000Z"\/>/);

    const cached = await request(firstPath);
    assert.equal(cached.body.rangeStart, '2026-07-01');
    assert.equal(reportBodies.length, 1);
    const otherRange = await request('/api/calendar?from=2026-06-01&to=2026-07-01');
    assert.equal(otherRange.body.rangeStart, '2026-06-01');
    assert.equal(reportBodies.length, 2);

    for (const query of [
      '?from=2026-02-30&to=2026-03-01',
      '?from=2026-01-01&to=2026-03-05',
      '?from=2026-07-01',
    ]) {
      const invalid = await request('/api/calendar' + query);
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.error, 'invalid_calendar_range');
    }
    assert.equal(reportBodies.length, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test('Spotify OAuth rejects bad state without consuming a valid flow, and volume targets device correctly', async () => {
  const configured = await configStore.mutateConfig(current => {
    current.spotify.clientId = '12345678901234567890123456789012';
    current.spotify.clientSecret = '';
  });
  const login = new URL(await spotify.spotifyLoginUrl(configured.config));
  const state = login.searchParams.get('state');
  await assert.rejects(() => spotify.spotifyCallback(configured.config,
    { state: 'wrong-state', code: 'unused' }, async () => { throw new Error('must not be called'); }),
  { message: 'spotify_oauth_state_invalid' });
  await spotify.spotifyCallback(configured.config, { state, code: 'good-code' },
    async (_url, options) => {
      assert.equal(options.method, 'POST');
      assert.match(String(options.body), /code_verifier=/);
      return new Response(JSON.stringify({ access_token: 'oauth-access', refresh_token: 'oauth-refresh', expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
  const saved = await configStore.loadConfig();
  assert.equal(saved.spotify.accessToken, 'oauth-access');
  assert.equal(saved.spotify.refreshToken, 'oauth-refresh');
  assert.deepEqual(saved.spotify.scopes, spotify.SCOPES);
  assert.deepEqual(saved.spotify.scopeDenied, []);
  const requested = [];
  await spotify.spotifyAction({ ...saved, spotify: { ...saved.spotify, expiresAt: Date.now() + 3600000 } },
    { action: 'volume', volume: 42, deviceId: 'device-1' },
    async (url, options) => {
      requested.push({ url: String(url), options });
      return new Response(null, { status: 204 });
    });
  const volumeUrl = new URL(requested[0].url);
  assert.equal(volumeUrl.searchParams.get('volume_percent'), '42');
  assert.equal(volumeUrl.searchParams.get('device_id'), 'device-1');
});

test('transient Spotify API failure preserves access and refresh credentials', async () => {
  await configStore.mutateConfig(current => {
    current.spotify.clientId = '12345678901234567890123456789012';
    current.spotify.accessToken = 'keep-access';
    current.spotify.refreshToken = 'keep-refresh';
    current.spotify.expiresAt = Date.now() + 3600000;
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('temporary network outage'); };
  try {
    const response = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/api/spotify' }, res => {
        let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
      });
      req.on('error', reject); req.end();
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.error, 'temporary_network_outage');
  } finally { globalThis.fetch = originalFetch; }
  const saved = await configStore.loadConfig();
  assert.equal(saved.spotify.accessToken, 'keep-access');
  assert.equal(saved.spotify.refreshToken, 'keep-refresh');
});

test('Spotify HTTP OAuth callback uses the default bounded fetch path', async () => {
  await configStore.mutateConfig(config => {
    config.spotify.clientId = '12345678901234567890123456789012';
    config.spotify.clientSecret = '';
    config.spotify.accessToken = '';
    config.spotify.refreshToken = '';
    config.spotify.expiresAt = 0;
  });
  const request = route => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: route }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject); req.end();
  });
  const login = await request('/api/spotify/login');
  assert.equal(login.status, 302);
  const state = new URL(login.headers.location).searchParams.get('state');
  assert.ok(state);

  const originalFetch = globalThis.fetch;
  let tokenRequests = 0;
  globalThis.fetch = async (url, options) => {
    tokenRequests++;
    assert.equal(String(url), 'https://accounts.spotify.com/api/token');
    assert.equal(options.method, 'POST');
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(JSON.stringify({ access_token: 'route-callback-access',
      refresh_token: 'route-callback-refresh', expires_in: 3600, scope: spotify.SCOPES.join(' ') }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const callback = await request('/api/spotify/callback?code=fixture-code&state=' + encodeURIComponent(state));
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.location, '/');
    assert.equal(tokenRequests, 1);
  } finally { globalThis.fetch = originalFetch; }
  const saved = await configStore.loadConfig();
  assert.equal(saved.spotify.accessToken, 'route-callback-access');
  assert.equal(saved.spotify.refreshToken, 'route-callback-refresh');
});

test('Spotify HTTP state refreshes an expired token through the default bounded fetch path', async () => {
  await configStore.mutateConfig(config => {
    config.spotify.clientId = '12345678901234567890123456789012';
    config.spotify.clientSecret = '';
    config.spotify.accessToken = 'expired-fixture-access';
    config.spotify.refreshToken = 'fixture-refresh-token';
    config.spotify.expiresAt = Date.now() - 60_000;
    config.spotify.scopes = spotify.SCOPES;
    config.spotify.scopeDenied = [];
  });
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url) === 'https://accounts.spotify.com/api/token') {
      assert.equal(options.method, 'POST');
      return new Response(JSON.stringify({ access_token: 'refreshed-fixture-access',
        expires_in: 3600, scope: spotify.SCOPES.join(' ') }), { status: 200,
        headers: { 'Content-Type': 'application/json' } });
    }
    assert.equal(options.headers.Authorization, 'Bearer refreshed-fixture-access');
    return String(url).endsWith('/me/player/devices')
      ? new Response(JSON.stringify({ devices: [] }), { status: 200 })
      : new Response(JSON.stringify({ is_playing: false, item: null, device: null }), { status: 200 });
  };
  try {
    const response = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/api/spotify' }, res => {
        let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      });
      req.on('error', reject); req.end();
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.connected, true);
    assert.equal(response.body.error, null);
    const tokenCalls = calls.filter(call => call.url === 'https://accounts.spotify.com/api/token');
    const apiCalls = calls.filter(call => call.url.startsWith('https://api.spotify.com/v1/'));
    assert.ok(tokenCalls.length >= 1);
    assert.equal(apiCalls.length, 2);
    assert.ok(calls.every(call => call.options.signal instanceof AbortSignal));
  } finally { globalThis.fetch = originalFetch; }
  const saved = await configStore.loadConfig();
  assert.equal(saved.spotify.accessToken, 'refreshed-fixture-access');
  assert.ok(saved.spotify.expiresAt > Date.now());
});
