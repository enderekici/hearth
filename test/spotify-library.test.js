import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hearth-spotify-'));
process.env.DATA_DIR = path.join(root, 'data');
process.env.PHOTO_DIR = path.join(root, 'photos');
const configStore = await import('../server/config.js');
const spotify = await import('../server/spotify.js');
const library = await import('../server/spotify-library.js');
const { createServer } = await import('../server/index.js');

let server, base, originalFetch;
before(async () => {
  await configStore.ensureDataDir();
  await configStore.mutateConfig(current => {
    current.spotify = { clientId: 'a'.repeat(32), clientSecret: '', accessToken: 'fixture-access',
      refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3_600_000, scopes: [], scopeDenied: [] };
  });
  server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = 'http://127.0.0.1:' + server.address().port;
});
after(async () => {
  globalThis.fetch = originalFetch;
  server?.close();
  await fs.rm(root, { recursive: true, force: true });
});

const id = '4iV5W9uYEdYUVa79Axb7Rh';
const image = 'https://i.scdn.co/image/ab67616d00001e02ff9ca10b55ce82ae553c8228';
const track = { id, uri: 'spotify:track:' + id, name: 'Fixture Song', duration_ms: 191000,
  artists: [{ name: 'Fixture Artist' }], explicit: false, album: { name: 'Fixture Album',
    images: [{ url: image }], artists: [{ name: 'Fixture Artist' }] } };
const okJson = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, base), { method: options.method || 'GET', headers: options.headers }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test('search maps typed results, bounds pagination, and proxies only validated artwork', async () => {
  let called;
  const result = await library.searchSpotify({ spotify: { accessToken: 'x', expiresAt: Date.now() + 60000 } },
    { q: ' fixture ', type: 'track,album,artist,playlist', limit: '3', offset: '6' },
    async (url, options) => {
      called = { url: String(url), options };
      return okJson({ tracks: { total: 8, items: [track] }, albums: { total: 0, items: [] },
        artists: { total: 0, items: [] }, playlists: { total: 0, items: [] } });
    });
  const url = new URL(called.url);
  assert.equal(url.pathname, '/v1/search');
  assert.equal(url.searchParams.get('q'), 'fixture');
  assert.equal(url.searchParams.get('type'), 'track,album,artist,playlist');
  assert.equal(url.searchParams.get('limit'), '3');
  assert.deepEqual(result.results.track.items[0], { id, uri: track.uri, type: 'track', title: 'Fixture Song',
    artist: 'Fixture Artist', album: 'Fixture Album', artwork: spotify.spotifyArtworkReference(image),
    durationMs: 191000, explicit: false, playable: true });
  assert.equal(result.results.track.nextOffset, 7);
  await assert.rejects(() => library.searchSpotify({ spotify: {} }, { q: 'x', type: 'episode' },
    async () => { throw new Error('unexpected request'); }), { message: 'invalid_spotify_search' });
  await assert.rejects(() => library.getSpotifyPlaylists({ spotify: {} }, { limit: '51' },
    async () => { throw new Error('unexpected request'); }), { message: 'invalid_spotify_page' });
  await assert.rejects(() => library.searchSpotify({ spotify: {} }, { q: 'fixture', type: 'track', limit: '11' },
    async () => { throw new Error('unexpected request'); }), { message: 'invalid_spotify_page' });
});

test('saved library, playlist and album adapters use fixed Spotify endpoints and map null items safely', async () => {
  const calls = [];
  const config = { spotify: { accessToken: 'x', expiresAt: Date.now() + 60000 } };
  const playlistImage = 'https://image-cdn-fa.spotifycdn.com/image/playlist-fixture';
  const fetcher = async url => {
    const parsed = new URL(String(url)); calls.push(parsed.pathname);
    if (parsed.pathname === '/v1/me/playlists') return okJson({ total: 1, items: [{ id, uri: 'spotify:playlist:' + id,
      name: 'Set', description: '', items: { total: 2 }, owner: { display_name: 'Me' }, images: [{ url: playlistImage }] }] });
    if (parsed.pathname === '/v1/me/tracks') return okJson({ total: 3, items: [{ track }, { track: null }] });
    if (parsed.pathname === '/v1/me/albums') return okJson({ total: 1, items: [{ album: { id, uri: 'spotify:album:' + id,
      name: 'Fixture Album', total_tracks: 1, artists: [{ name: 'Fixture Artist' }], images: [{ url: image }] } }] });
    if (parsed.pathname === `/v1/albums/${id}/tracks`) return okJson({ total: 1, items: [track] });
    if (parsed.pathname === `/v1/playlists/${id}/items`) return okJson({ total: 2, items: [{ item: track }, { item: null }] });
    if (parsed.pathname === `/v1/artists/${id}/albums`) return okJson({ total: 1, items: [{ id,
      uri: 'spotify:album:' + id, name: 'Fixture Album', total_tracks: 1,
      artists: [{ name: 'Fixture Artist' }], images: [{ url: image }] }] });
    if (parsed.pathname === '/v1/me/player/queue') return okJson({ currently_playing: track, queue: [track, null] });
    throw new Error('untrusted endpoint');
  };
  const playlists = await library.getSpotifyPlaylists(config, {}, fetcher);
  assert.equal(playlists.items[0].tracksTotal, 2);
  assert.equal(playlists.items[0].type, 'playlist');
  assert.match(playlists.items[0].artwork, /^\/api\/spotify\/artwork\/[a-f0-9]{64}$/);
  const savedTracks = await library.getSpotifyLibraryTracks(config, { limit: 2 }, fetcher);
  assert.equal(savedTracks.items.length, 1);
  assert.equal(savedTracks.nextOffset, 2);
  assert.equal((await library.getSpotifyLibraryAlbums(config, {}, fetcher)).items[0].name, 'Fixture Album');
  assert.equal((await library.getSpotifyAlbumTracks(config, id, {}, fetcher)).context.type, 'album');
  assert.equal((await library.getSpotifyPlaylistTracks(config, id, {}, fetcher)).items.length, 1);
  assert.equal((await library.getSpotifyArtistAlbums(config, id, {}, fetcher)).items[0].name, 'Fixture Album');
  const queue = await library.getSpotifyQueue(config, fetcher);
  assert.equal(queue.current.title, 'Fixture Song');
  assert.equal(queue.items.length, 1);
  assert.deepEqual(calls, ['/v1/me/playlists', '/v1/me/tracks', '/v1/me/albums',
    `/v1/albums/${id}/tracks`, `/v1/playlists/${id}/items`, `/v1/artists/${id}/albums`, '/v1/me/player/queue']);
});

test('artist album pages clamp Spotify limit to 10 and advance using returned items', async () => {
  const urls = [];
  const fetcher = async rawUrl => {
    const url = new URL(String(rawUrl)); urls.push(url);
    assert.equal(url.searchParams.get('limit'), '10');
    assert.equal(url.searchParams.get('include_groups'), 'album,single,compilation');
    const offset = Number(url.searchParams.get('offset'));
    return okJson({ total: 42, items: Array.from({ length: 10 }, (_, index) => ({
      id: `${id.slice(0, 20)}${String((offset + index) % 10).padStart(2, '0')}`,
      name: 'Album', total_tracks: 1, images: [{ url: image }], artists: [{ name: 'Artist' }],
    })) });
  };
  const first = await library.getSpotifyArtistAlbums({ spotify: { accessToken: 'x', expiresAt: Date.now() + 60000 } },
    id, { limit: '50', offset: '0' }, fetcher);
  assert.equal(first.limit, 10);
  assert.equal(first.items.length, 10);
  assert.equal(first.nextOffset, 10);
  const second = await library.getSpotifyArtistAlbums({ spotify: { accessToken: 'x', expiresAt: Date.now() + 60000 } },
    id, { limit: '50', offset: String(first.nextOffset) }, fetcher);
  assert.equal(second.offset, 10);
  assert.equal(second.nextOffset, 20);
  assert.deepEqual(urls.map(url => url.searchParams.get('offset')), ['0', '10']);
});

test('scope errors distinguish actual missing permission from other provider restrictions', async () => {
  const config = { spotify: { accessToken: 'x', expiresAt: Date.now() + 60000 } };
  const denied = async () => new Response(JSON.stringify({ error: { status: 403,
    message: 'Insufficient client scope' } }), { status: 403 });
  await assert.rejects(() => library.getSpotifyLibraryTracks(config, {}, denied), error => {
    assert.equal(error.message, 'spotify_insufficient_scope');
    assert.equal(error.missingScope, 'user-library-read');
    assert.equal(error.needsReauth, true);
    return true;
  });
  assert.deepEqual(library.spotifyScopeFailure(Object.assign(new Error('spotify_insufficient_scope'),
    { missingScope: 'user-library-read', needsReauth: true })), {
    error: 'spotify_missing_scope', needsReauth: true, missingScopes: ['user-library-read'] });
  const restricted = async () => new Response(JSON.stringify({ error: { status: 403, message: 'Premium required' } }), { status: 403 });
  await assert.rejects(() => library.getSpotifyLibraryTracks(config, {}, restricted), error => {
    assert.equal(error.message, 'spotify_premium_or_provider_restriction');
    assert.equal(library.spotifyScopeFailure(error).needsReauth, false);
    return true;
  });
});

test('player actions build safe fixed requests for track/context, queue, seek, shuffle and repeat', async () => {
  const config = { spotify: { accessToken: 'x', expiresAt: Date.now() + 60000 } };
  const calls = [];
  const fetcher = async (url, options) => { calls.push({ url: String(url), options }); return new Response(null, { status: 204 }); };
  await spotify.spotifyAction(config, { action: 'play', uri: track.uri, deviceId: 'device 1' }, fetcher);
  assert.deepEqual(JSON.parse(calls[0].options.body), { uris: [track.uri] });
  assert.equal(new URL(calls[0].url).searchParams.get('device_id'), 'device 1');
  await spotify.spotifyAction(config, { action: 'play', contextUri: 'spotify:album:' + id, offsetUri: track.uri }, fetcher);
  assert.deepEqual(JSON.parse(calls[1].options.body), { context_uri: 'spotify:album:' + id, offset: { uri: track.uri } });
  await spotify.spotifyAction(config, { action: 'queue', uri: track.uri }, fetcher);
  assert.equal(new URL(calls[2].url).pathname, '/v1/me/player/queue');
  assert.equal(new URL(calls[2].url).searchParams.get('uri'), track.uri);
  await spotify.spotifyAction(config, { action: 'seek', positionMs: 182000 }, fetcher);
  await spotify.spotifyAction(config, { action: 'shuffle', state: true }, fetcher);
  await spotify.spotifyAction(config, { action: 'repeat', state: 'context' }, fetcher);
  assert.equal(new URL(calls[3].url).searchParams.get('position_ms'), '182000');
  assert.equal(new URL(calls[4].url).searchParams.get('state'), 'true');
  assert.equal(new URL(calls[5].url).searchParams.get('state'), 'context');
  await assert.rejects(() => spotify.spotifyAction(config, { action: 'queue', uri: 'https://evil.example' }, fetcher),
    { message: 'invalid_spotify_uri' });
});

test('HTTP routes expose scopes and return reauthorization only after explicit scope denial', async () => {
  originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).includes('/search?')) return okJson({ tracks: { total: 1, items: [track] } });
    if (String(url).includes('/me/tracks?')) return new Response(JSON.stringify({ error: { status: 403,
      message: 'Insufficient client scope' } }), { status: 403 });
    if (String(url).includes('/me/player/play')) return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ error: { status: 403, message: 'Premium required' } }), { status: 403 });
  };
  const search = await request('/api/spotify/search?q=fixture&type=track');
  assert.equal(search.status, 200);
  const searchBody = search.body;
  assert.equal(searchBody.results?.track?.items?.[0]?.title, 'Fixture Song', JSON.stringify(searchBody));
  const denied = await request('/api/spotify/library/tracks');
  assert.equal(denied.status, 403);
  assert.deepEqual(denied.body, { error: 'spotify_missing_scope', needsReauth: true,
    missingScopes: ['user-library-read'] });
  const capabilities = (await request('/api/spotify/capabilities')).body;
  assert.equal(capabilities.known, false);
  assert.deepEqual(capabilities.missing, ['user-library-read']);
  const action = await request('/api/spotify/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'play', uri: track.uri }) });
  assert.equal(action.status, 200);
  assert.ok(requests.every(call => new URL(call.url).origin === 'https://api.spotify.com'));
  assert.equal((await configStore.loadConfig()).spotify.accessToken, 'fixture-access');
});
