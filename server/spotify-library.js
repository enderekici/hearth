import { spotifyArtworkReference, spotifyRequest, spotifyFetchWithTimeout } from './spotify.js';

const ID = /^[A-Za-z0-9]{22}$/;
const TYPES = new Set(['track', 'album', 'artist', 'playlist']);

function invalid(code) { throw Object.assign(new Error(code), { status: 400 }); }
function pageArgs(input = {}, { defaultLimit = 20, maxLimit = 50, maxOffset = 10_000 } = {}) {
  const limit = input.limit === undefined ? defaultLimit : Number(input.limit);
  const offset = input.offset === undefined ? 0 : Number(input.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit
      || !Number.isInteger(offset) || offset < 0 || offset > maxOffset) invalid('invalid_spotify_page');
  return { limit, offset };
}
function spotifyId(value) {
  if (typeof value !== 'string' || !ID.test(value)) invalid('invalid_spotify_id');
  return value;
}
function page(data, mapped, { limit, offset }, rawCount = mapped.length) {
  const total = Number.isInteger(data?.total) && data.total >= 0 ? data.total : offset + mapped.length;
  const nextOffset = rawCount > 0 && offset + rawCount < total && offset + rawCount <= 10_000
    ? offset + rawCount : null;
  return { items: mapped, limit, offset, total, nextOffset };
}
function image(images) { return spotifyArtworkReference(images?.[0]?.url || ''); }
function artistNames(artists) { return (artists || []).map(artist => artist?.name).filter(Boolean).join(', '); }

export function mapSpotifyTrack(track) {
  if (!track || typeof track !== 'object') return null;
  const album = track.album;
  return { id: track.id || '', uri: track.uri || '', type: 'track', title: track.name || '',
    artist: artistNames(track.artists), album: album?.name || '', artwork: image(album?.images),
    durationMs: Number.isFinite(track.duration_ms) ? track.duration_ms : 0,
    explicit: Boolean(track.explicit), playable: track.is_playable !== false };
}

function mapAlbum(album) {
  if (!album || typeof album !== 'object') return null;
  return { id: album.id || '', uri: album.uri || '', type: 'album', name: album.name || '',
    artist: artistNames(album.artists), artwork: image(album.images), tracksTotal: Number(album.total_tracks) || 0,
    releaseDate: album.release_date || '' };
}
function mapArtist(artist) {
  if (!artist || typeof artist !== 'object') return null;
  return { id: artist.id || '', uri: artist.uri || '', type: 'artist', name: artist.name || '',
    artwork: image(artist.images) };
}
function mapPlaylist(playlist) {
  if (!playlist || typeof playlist !== 'object') return null;
  return { id: playlist.id || '', uri: playlist.uri || '', type: 'playlist', name: playlist.name || '',
    description: playlist.description || '', artwork: image(playlist.images),
    tracksTotal: Number(playlist.items?.total ?? playlist.tracks?.total) || 0,
    owner: playlist.owner?.display_name || playlist.owner?.id || '' };
}

async function request(config, endpoint, options, fetcher, scope) {
  try { return await spotifyRequest(config, endpoint, options, fetcher); }
  catch (error) {
    if (error.message === 'spotify_insufficient_scope') {
      error.missingScope = scope;
      error.needsReauth = true;
    }
    throw error;
  }
}

export async function searchSpotify(config, input, fetcher = spotifyFetchWithTimeout) {
  const q = typeof input.q === 'string' ? input.q.trim() : '';
  const types = typeof input.type === 'string' ? input.type.split(',') : ['track'];
  const args = pageArgs(input, { defaultLimit: 5, maxLimit: 10, maxOffset: 1000 });
  if (!q || q.length > 120 || !types.length || types.length > 4 || types.some(type => !TYPES.has(type))) {
    invalid('invalid_spotify_search');
  }
  const params = new URLSearchParams({ q, type: [...new Set(types)].join(','), limit: String(args.limit), offset: String(args.offset) });
  const data = await request(config, '/search?' + params, {}, fetcher, 'user-read-private');
  const maps = { tracks: mapSpotifyTrack, albums: mapAlbum, artists: mapArtist, playlists: mapPlaylist };
  return { results: Object.fromEntries([...new Set(types)].map(type => {
    const key = type + 's';
    const result = data?.[key] || {};
    const mapped = (result.items || []).map(maps[key]).filter(Boolean);
    return [type, page(result, mapped, args, (result.items || []).length)];
  })) };
}

export async function getSpotifyPlaylists(config, input = {}, fetcher = spotifyFetchWithTimeout) {
  const args = pageArgs(input);
  const params = new URLSearchParams({ limit: String(args.limit), offset: String(args.offset) });
  const data = await request(config, '/me/playlists?' + params, {}, fetcher, 'playlist-read-private');
  return page(data, (data?.items || []).map(mapPlaylist).filter(Boolean), args, (data?.items || []).length);
}

export async function getSpotifyLibraryTracks(config, input = {}, fetcher = spotifyFetchWithTimeout) {
  const args = pageArgs(input);
  const params = new URLSearchParams({ limit: String(args.limit), offset: String(args.offset) });
  const data = await request(config, '/me/tracks?' + params, {}, fetcher, 'user-library-read');
  const items = (data?.items || []).map(item => mapSpotifyTrack(item?.track)).filter(Boolean);
  return page(data, items, args, (data?.items || []).length);
}

export async function getSpotifyLibraryAlbums(config, input = {}, fetcher = spotifyFetchWithTimeout) {
  const args = pageArgs(input);
  const params = new URLSearchParams({ limit: String(args.limit), offset: String(args.offset) });
  const data = await request(config, '/me/albums?' + params, {}, fetcher, 'user-library-read');
  const items = (data?.items || []).map(item => mapAlbum(item?.album)).filter(Boolean);
  return page(data, items, args, (data?.items || []).length);
}

export async function getSpotifyAlbumTracks(config, id, input = {}, fetcher = spotifyFetchWithTimeout) {
  id = spotifyId(id);
  const args = pageArgs(input);
  const params = new URLSearchParams({ limit: String(args.limit), offset: String(args.offset) });
  const data = await request(config, `/albums/${id}/tracks?${params}`, {}, fetcher, '');
  return { ...page(data, (data?.items || []).map(mapSpotifyTrack).filter(Boolean), args, (data?.items || []).length),
    context: { id, type: 'album', name: '' } };
}

export async function getSpotifyPlaylistTracks(config, id, input = {}, fetcher = spotifyFetchWithTimeout) {
  id = spotifyId(id);
  const args = pageArgs(input);
  const params = new URLSearchParams({ limit: String(args.limit), offset: String(args.offset) });
  const data = await request(config, `/playlists/${id}/items?${params}`, {}, fetcher, 'playlist-read-private');
  const items = (data?.items || []).map(entry => mapSpotifyTrack(entry?.item || entry?.track)).filter(Boolean);
  return { ...page(data, items, args, (data?.items || []).length), context: { id, type: 'playlist', name: '' } };
}

export async function getSpotifyArtistAlbums(config, id, input = {}, fetcher = spotifyFetchWithTimeout) {
  id = spotifyId(id);
  const args = pageArgs(input);
  const providerLimit = Math.min(args.limit, 10);
  const params = new URLSearchParams({ limit: String(providerLimit), offset: String(args.offset),
    include_groups: 'album,single,compilation' });
  const data = await request(config, `/artists/${id}/albums?${params}`, {}, fetcher, '');
  return { ...page(data, (data?.items || []).map(mapAlbum).filter(Boolean),
    { ...args, limit: providerLimit }, (data?.items || []).length),
    context: { id, type: 'artist', name: '' } };
}

export async function getSpotifyQueue(config, fetcher = spotifyFetchWithTimeout) {
  const data = await request(config, '/me/player/queue', {}, fetcher, 'user-read-playback-state');
  return { current: mapSpotifyTrack(data?.currently_playing), items: (data?.queue || []).map(mapSpotifyTrack).filter(Boolean) };
}

export function spotifyScopeFailure(error) {
  if (error?.needsReauth && typeof error.missingScope === 'string') {
    return { error: 'spotify_missing_scope', needsReauth: true, missingScopes: [error.missingScope] };
  }
  const code = String(error?.message || 'spotify_library_error').replace(/[^a-z0-9_-]/gi, '_').slice(0, 80);
  const needsReauth = ['spotify_reauthorization_required', 'spotify_refresh_rejected', 'spotify_refresh_token_missing'].includes(code);
  return { error: code, needsReauth, missingScopes: [] };
}
