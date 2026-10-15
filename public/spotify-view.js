const LIMIT = 50;
const SEARCH_LIMIT = 10;
const $ = (selector, root = document) => root.querySelector(selector);
const make = (tag, className, value) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value != null) node.textContent = String(value);
  return node;
};
const escapePath = value => encodeURIComponent(String(value));
const duration = ms => {
  const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
const itemName = item => item?.title || item?.name || 'Untitled';
const itemMeta = item => item?.artist || item?.owner || item?.description || '';
const ICONS = {
  home: 'M3 10.5 12 3l9 7.5M5.5 9v11h13V9M9 20v-6h6v6',
  search: 'm20 20-4.3-4.3M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z',
  queue: 'M4 6h16M4 12h16M4 18h10',
  back: 'm15 18-6-6 6-6M9 12h11',
  prev: 'M6 5v14m13-14L9 12l10 7V5Z',
  next: 'M18 5v14M5 5l10 7-10 7V5Z',
  play: 'm7 4 13 8-13 8V4Z',
  pause: 'M8 5v14M16 5v14',
  shuffle: 'm18 14 4 4-4 4m0-20 4 4-4 4M2 18h2.5a5 5 0 0 0 4-2l7-10a5 5 0 0 1 4-2H22M2 6h2.5a5 5 0 0 1 4 2l1 1m3 6 1.5 2a5 5 0 0 0 4 2H22',
  repeat: 'M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4m14-1v2a3 3 0 0 1-3 3H3',
  speaker: 'M11 5 6 9H3v6h3l5 4V5Zm4.5 3.5a5 5 0 0 1 0 7m3-10a9 9 0 0 1 0 13',
  close: 'm18 6-12 12M6 6l12 12',
  add: 'M12 5v14M5 12h14',
};
function icon(name, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name] || ICONS.play); svg.append(path); return svg;
}
function iconButton(className, glyph, label) {
  const button = make('button', className); button.type = 'button';
  button.setAttribute('aria-label', label); button.title = label; button.append(icon(glyph)); return button;
}
function tintFromArtwork(node, item) {
  if (!item?.artwork) return;
  const probe = new Image();
  probe.onload = () => {
    if (!node.isConnected) return;
    try {
      const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(probe, 0, 0, 1, 1);
      const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
      node.style.setProperty('--cover-rgb', `${r}, ${g}, ${b}`);
    } catch { /* Artwork stays usable if a browser blocks pixel sampling. */ }
  };
  probe.src = item.artwork;
}

export function mountSpotifyView(container, {
  spotify = {}, request = async () => ({}), action = async () => {}, onConnect = () => {}, onClose = () => {},
} = {}) {
  if (!(container instanceof Element)) throw new TypeError('Spotify view needs a container element');
  let current = spotify || {};
  let capabilities = null;
  let mode = 'home';
  let active = 'albums';
  let sidebarFilter = 'all';
  let items = [], albums = [], playlists = [], albumsNextOffset = null, playlistsNextOffset = null;
  let albumsTotal = 0, playlistsTotal = 0, offset = 0, nextOffset = null, total = 0;
  let selected = null, query = '', searchType = 'track', parents = [];
  let loading = false, homeLoading = false, error = '', missingScopes = [], queue = null;
  let dataRequestSequence = 0, homeRequestSequence = 0, destroyed = false, sheetVolumeTimer;

  container.replaceChildren(); container.classList.add('spotify-view');
  const top = make('header', 'spv-top');
  const brand = make('div', 'spv-brand'); brand.append(make('span', 'spv-mark', '♪'), make('span', 'spv-brand-name', 'Music'));
  const nav = make('nav', 'spv-toolbar-nav'); nav.setAttribute('aria-label', 'Spotify views');
  const navButtons = new Map();
  for (const [key, text, glyph] of [['home', 'Home', 'home'], ['search', 'Search', 'search'], ['queue', 'Queue', 'queue'], ['now', 'Now playing', 'play']]) {
    const button = make('button', 'spv-toolbar-button'); button.type = 'button'; button.dataset.mode = key;
    button.append(icon(glyph), make('span', '', text));
    button.addEventListener('click', () => navigate(key)); nav.append(button); navButtons.set(key, button);
  }
  const topActions = make('div', 'spv-top-actions');
  const status = make('span', 'spv-status');
  const reconnect = make('button', 'spv-connect', 'Connect Spotify'); reconnect.type = 'button'; reconnect.addEventListener('click', onConnect);
  const close = make('button', 'spv-close'); close.type = 'button'; close.append(icon('back'), make('span', '', 'Back')); close.addEventListener('click', () => {
    if (mode === 'detail' && parents.length) { selected = parents.pop(); offset = 0; items = []; loadCollection(); }
    else if (mode !== 'home') navigate('home'); else onClose();
  });
  topActions.append(status, reconnect, close); top.append(brand, nav, topActions);

  const workspace = make('div', 'spv-workspace');
  const sidebar = make('aside', 'spv-sidebar');
  const sidebarHeader = make('div', 'spv-sidebar-header'); sidebarHeader.append(make('h2', '', 'Your library'));
  const sideFilters = make('div', 'spv-side-filters');
  const sideList = make('div', 'spv-side-list'); sidebar.append(sidebarHeader, sideFilters, sideList);
  const stage = make('main', 'spv-stage');
  const notice = make('div', 'spv-notice'); notice.setAttribute('role', 'status');
  const searchForm = make('form', 'spv-search');
  const searchInput = make('input'); searchInput.type = 'search'; searchInput.placeholder = 'What do you want to listen to?'; searchInput.setAttribute('aria-label', 'Search Spotify');
  const searchSelect = make('select'); searchSelect.setAttribute('aria-label', 'Search type');
  for (const [value, label] of [['track', 'Songs'], ['album', 'Albums'], ['playlist', 'Playlists'], ['artist', 'Artists']]) { const option = make('option', '', label); option.value = value; searchSelect.append(option); }
  const searchButton = make('button', 'spv-primary', 'Search'); searchButton.type = 'submit'; searchForm.append(searchInput, searchSelect, searchButton);
  const homeView = make('section', 'spv-home-view');
  const detailView = make('section', 'spv-detail-view');
  const queueView = make('section', 'spv-queue-view');
  const nowView = make('section', 'spv-now-view');
  stage.append(notice, searchForm, homeView, detailView, queueView, nowView); workspace.append(sidebar, stage);

  const player = make('section', 'spv-player'); player.setAttribute('aria-label', 'Spotify playback');
  const sheetBackdrop = make('div', 'spv-sheet-backdrop'); sheetBackdrop.hidden = true;
  const sheet = make('section', 'spv-sheet'); sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-label', 'Playback and speaker');
  const sheetHeader = make('header', 'spv-sheet-header'); sheetHeader.append(make('h2', 'spv-sheet-title', 'Playback & speaker'));
  const sheetClose = make('button', 'spv-sheet-close', 'Done'); sheetClose.type = 'button'; sheetHeader.append(sheetClose);
  const sheetControls = make('div', 'spv-sheet-controls');
  const sheetShuffle = make('button', 'spv-sheet-control', 'Shuffle off'); sheetShuffle.type = 'button';
  const sheetRepeat = make('button', 'spv-sheet-control', 'Repeat off'); sheetRepeat.type = 'button'; sheetControls.append(sheetShuffle, sheetRepeat);
  const sheetDevice = make('select', 'spv-sheet-device'); sheetDevice.setAttribute('aria-label', 'Spotify speaker');
  const sheetVolume = make('label', 'spv-sheet-volume'); sheetVolume.append(make('span', '', 'Speaker volume'));
  const sheetVolumeRange = make('input'); sheetVolumeRange.type = 'range'; sheetVolumeRange.min = '0'; sheetVolumeRange.max = '100'; sheetVolumeRange.setAttribute('aria-label', 'Speaker volume');
  const sheetVolumeValue = make('span', 'spv-sheet-volume-value'); sheetVolume.append(sheetVolumeRange, sheetVolumeValue);
  sheet.append(sheetHeader, sheetControls, make('h3', 'spv-output-heading', 'Choose a speaker'), sheetDevice, sheetVolume); sheetBackdrop.append(sheet);
  container.append(top, workspace, player, sheetBackdrop);
  sheetClose.addEventListener('click', () => { sheetBackdrop.hidden = true; });
  sheetBackdrop.addEventListener('click', event => { if (event.target === sheetBackdrop) sheetBackdrop.hidden = true; });
  sheetShuffle.addEventListener('click', () => act({ action: 'shuffle', state: !current.shuffleState }));
  sheetRepeat.addEventListener('click', () => { const states = ['off', 'context', 'track']; const i = states.indexOf(current.repeatState || 'off'); act({ action: 'repeat', state: states[(i + 1) % states.length] }); });
  sheetDevice.addEventListener('change', () => sheetDevice.value && act({ action: 'transfer', deviceId: sheetDevice.value }));
  sheetVolumeRange.addEventListener('input', () => { sheetVolumeValue.textContent = `${sheetVolumeRange.value}%`; clearTimeout(sheetVolumeTimer); sheetVolumeTimer = setTimeout(() => act({ action: 'volume', volume: Number(sheetVolumeRange.value), deviceId: current.device?.id }), 250); });

  function connected() { return Boolean(current.connected); }
  function effectiveMissingScopes() { return missingScopes.length ? missingScopes : (Array.isArray(capabilities?.missing) ? capabilities.missing : []); }
  function scopeMessage() { return `Spotify has not granted ${effectiveMissingScopes().join(', ') || 'Spotify library permissions'}. Reconnect to approve access.`; }
  function setNotice(message, kind = '') { notice.textContent = message || ''; notice.className = `spv-notice${kind ? ` ${kind}` : ''}`; notice.hidden = !message; }
  function updateStatus() {
    if (current.error === 'spotify_reauthorization_required' || current.error === 'spotify_refresh_rejected') { status.textContent = 'Reconnect needed'; reconnect.hidden = false; }
    else if (capabilities?.known && effectiveMissingScopes().length) { status.textContent = 'Limited access'; reconnect.hidden = false; }
    else if (connected()) { status.textContent = current.device?.name ? `Speaker: ${current.device.name}` : 'Spotify connected'; reconnect.hidden = true; }
    else { status.textContent = current.configured ? 'Sign in needed' : 'Not connected'; reconnect.hidden = false; }
  }
  function artwork(item, className = 'spv-art') {
    if (!item?.artwork) { const fallback = make('div', `${className} spv-art-fallback`); fallback.append(icon('play')); return fallback; }
    const image = make('img', className); image.alt = ''; image.loading = 'lazy'; image.src = item.artwork;
    return image;
  }
  function renderSidebar() {
    sideFilters.replaceChildren();
    for (const [key, text] of [['all', 'All'], ['playlist', 'Playlists'], ['album', 'Albums'], ['tracks', 'Liked songs']]) {
      const b = make('button', 'spv-side-filter', text); b.type = 'button'; b.setAttribute('aria-pressed', String(sidebarFilter === key));
      b.addEventListener('click', () => { sidebarFilter = key; if (key === 'tracks') { selected = null; active = 'tracks'; mode = 'detail'; offset = 0; items = []; loadCollection(); } else { renderSidebar(); } }); sideFilters.append(b);
    }
    sideList.replaceChildren();
    const entries = sidebarFilter === 'playlist' ? playlists : sidebarFilter === 'album' ? albums : [...albums, ...playlists];
    if (!connected()) { sideList.append(make('p', 'spv-side-empty', 'Connect Spotify to see your library.')); return; }
    if (!entries.length) { sideList.append(make('p', 'spv-side-empty', 'Your saved albums and playlists will appear here.')); return; }
    entries.forEach(item => {
      const b = make('button', `spv-side-entry${selected?.id === item.id ? ' is-selected' : ''}`); b.type = 'button';
      b.append(artwork(item, 'spv-side-art'));
      const copy = make('span', 'spv-side-copy'); copy.append(make('strong', '', itemName(item)), make('small', '', `${item.type === 'playlist' ? 'Playlist' : 'Album'} · ${itemMeta(item)}`)); b.append(copy);
      b.addEventListener('click', () => openItem(item)); sideList.append(b);
    });
    const hasMore = sidebarFilter === 'album' ? albumsNextOffset != null
      : sidebarFilter === 'playlist' ? playlistsNextOffset != null
        : albumsNextOffset != null || playlistsNextOffset != null;
    if (hasMore) {
      const all = make('button', 'spv-side-show-all', `See all ${sidebarFilter === 'playlist' ? 'playlists' : sidebarFilter === 'album' ? 'albums' : 'saved music'}`);
      all.type = 'button'; all.addEventListener('click', () => showLibrary(sidebarFilter === 'playlist' ? 'playlists' : 'albums')); sideList.append(all);
    }
  }
  function renderPlayer() {
    player.replaceChildren();
    const now = make('button', 'spv-now-summary'); now.type = 'button'; now.setAttribute('aria-label', 'Open now playing'); now.append(artwork(current.track, 'spv-now-art'));
    const copy = make('span', 'spv-now-copy'); copy.append(make('strong', '', current.track?.title || 'Nothing playing'), make('small', '', current.track?.artist || (connected() ? 'Choose a song from your library' : 'Connect your Spotify account'))); now.append(copy);
    now.addEventListener('click', () => navigate('now'));
    const transport = make('div', 'spv-playback');
    const previous = iconButton('spv-transport-button', 'prev', 'Previous track');
    const toggle = iconButton('spv-play-toggle', current.playing ? 'pause' : 'play', current.playing ? 'Pause' : 'Play');
    const next = iconButton('spv-transport-button', 'next', 'Next track');
    const modify = !(capabilities?.known && capabilities.capabilities?.modifyPlayback === false);
    [previous, toggle, next].forEach(button => { button.disabled = !connected() || !modify; });
    previous.addEventListener('click', () => act({ action: 'previous' })); toggle.addEventListener('click', () => act({ action: current.playing ? 'pause' : 'play' })); next.addEventListener('click', () => act({ action: 'next' }));
    transport.append(previous, toggle, next);
    const seekArea = make('div', 'spv-progress');
    const seek = make('input', 'spv-seek'); seek.type = 'range'; seek.min = '0'; seek.max = String(current.track?.durationMs || 0); seek.value = String(Math.min(Number(current.progressMs) || 0, Number(current.track?.durationMs) || 0)); seek.setAttribute('aria-label', 'Seek within track'); seek.disabled = !connected() || !current.track?.durationMs || !modify;
    const times = make('div', 'spv-times'); const elapsed = make('span', 'spv-elapsed', duration(current.progressMs)); const total = make('span', 'spv-duration', duration(current.track?.durationMs)); times.append(elapsed, total); seekArea.append(seek, times);
    seek.addEventListener('input', () => { elapsed.textContent = duration(seek.value); }); seek.addEventListener('change', () => act({ action: 'seek', positionMs: Number(seek.value) }));
    const output = make('button', 'spv-output-button'); output.type = 'button'; output.append(icon('speaker'), make('span', '', current.device?.name || 'Playback & speaker')); output.disabled = !connected(); output.addEventListener('click', () => { renderOutputSheet(); sheetBackdrop.hidden = false; });
    player.append(now, transport, seekArea, output); renderOutputSheet();
  }
  function renderOutputSheet() {
    const modify = !(capabilities?.known && capabilities.capabilities?.modifyPlayback === false);
    sheetShuffle.textContent = current.shuffleState ? 'Shuffle is on' : 'Shuffle is off'; sheetShuffle.setAttribute('aria-pressed', String(Boolean(current.shuffleState)));
    sheetRepeat.textContent = `Repeat ${current.repeatState || 'off'}`; sheetShuffle.disabled = !connected() || !modify; sheetRepeat.disabled = !connected() || !modify;
    sheetDevice.replaceChildren(); const placeholder = make('option', '', current.devices?.length ? 'Choose a speaker' : 'No speakers available'); placeholder.value = ''; sheetDevice.append(placeholder);
    (current.devices || []).forEach(device => { const option = make('option', '', device.name || 'Spotify speaker'); option.value = device.id; option.selected = device.id === current.device?.id; sheetDevice.append(option); });
    sheetDevice.disabled = !connected() || !current.devices?.length; sheetVolumeRange.value = String(current.device?.volume ?? 35); sheetVolumeRange.disabled = !connected() || !current.device?.supportsVolume || !modify; sheetVolumeValue.textContent = `${sheetVolumeRange.value}%`;
  }
  function playItem(item) {
    if (!item?.uri) return;
    if (item.type === 'track' && selected) act({ action: 'play', contextUri: selected.uri, offsetUri: item.uri });
    else if (item.type === 'track') act({ action: 'play', uri: item.uri });
    else act({ action: 'play', contextUri: item.uri });
  }
  function openItem(item) {
    if (!item?.id || !['artist', 'playlist', 'album'].includes(item.type)) return;
    if (selected?.type === 'artist' && item.type === 'album') parents.push(selected); else parents = [];
    selected = { id: item.id, type: item.type, name: item.name || item.title || 'Collection', uri: item.uri, artwork: item.artwork, artist: item.artist, owner: item.owner, tracksTotal: item.tracksTotal };
    mode = 'detail'; offset = 0; nextOffset = null; items = []; loadCollection();
  }
  function renderShelf(title, entries, kind) {
    const section = make('section', 'spv-shelf');
    const heading = make('div', 'spv-shelf-heading'); heading.append(make('h2', '', title));
    const show = make('button', 'spv-shelf-link', 'See all'); show.type = 'button'; show.addEventListener('click', () => showLibrary(kind === 'album' ? 'albums' : 'playlists')); heading.append(show); section.append(heading);
    const row = make('div', 'spv-shelf-row');
    entries.slice(0, 8).forEach(item => {
      const card = make('button', 'spv-home-card'); card.type = 'button'; card.addEventListener('click', () => openItem(item));
      card.append(artwork(item, 'spv-home-art'), make('strong', '', itemName(item)), make('small', '', itemMeta(item)));
      row.append(card);
    });
    if (!entries.length) row.append(make('p', 'spv-shelf-empty', connected() ? `No saved ${kind === 'album' ? 'albums' : 'playlists'} to show.` : 'Connect Spotify to load your saved music.'));
    section.append(row); return section;
  }
  function renderHome() {
    homeView.replaceChildren();
    const intro = make('div', 'spv-home-intro'); intro.append(make('p', 'spv-eyebrow', 'YOUR MUSIC'), make('h1', '', 'Made for your room'), make('p', '', 'Pick up where you left off, or choose something from your library.')); homeView.append(intro);
    if (current.track?.title) {
      const now = make('button', 'spv-home-now'); now.type = 'button'; now.addEventListener('click', () => navigate('now'));
      now.append(artwork(current.track, 'spv-home-now-art'));
      const copy = make('span', 'spv-home-now-copy'); copy.append(make('small', '', current.playing ? 'NOW PLAYING' : 'LAST PLAYED'), make('strong', '', current.track.title), make('span', '', current.track.artist || '')); now.append(copy, icon('play', 'spv-home-now-play')); homeView.append(now);
    }
    if (homeLoading && !albums.length && !playlists.length) homeView.append(make('p', 'spv-home-loading', 'Loading your saved music…'));
    homeView.append(renderShelf('Saved albums', albums, 'album'), renderShelf('Your playlists', playlists, 'playlist'));
  }
  function renderDetail() {
    detailView.replaceChildren();
    if (selected) {
      const hero = make('section', 'spv-detail-hero'); hero.append(artwork(selected, 'spv-detail-art'));
      const info = make('div', 'spv-detail-info'); info.append(make('p', 'spv-eyebrow', selected.type === 'playlist' ? 'PLAYLIST' : selected.type === 'artist' ? 'ARTIST' : 'ALBUM'), make('h1', '', selected.name || 'Collection'), make('p', 'spv-detail-meta', [itemMeta(selected), total ? `${total} tracks` : ''].filter(Boolean).join(' · ')));
      const controls = make('div', 'spv-detail-actions');
      const play = make('button', 'spv-detail-play', 'Play'); play.type = 'button'; play.append(icon('play')); play.addEventListener('click', () => selected?.uri && act({ action: 'play', contextUri: selected.uri })); play.disabled = !selected?.uri || !connected(); controls.append(play);
      const back = make('button', 'spv-detail-back', 'Back to library'); back.type = 'button'; back.addEventListener('click', () => { if (parents.length) selected = parents.pop(); else { selected = null; mode = 'home'; } offset = 0; items = []; render(); if (mode === 'home') loadHomeData(); else loadCollection(); }); controls.append(back);
      info.append(controls); hero.append(info); detailView.append(hero); tintFromArtwork(hero, selected);
    }
    const heading = make('div', 'spv-track-heading');
    const listTitle = mode === 'search' ? `${({track:'Song',album:'Album',playlist:'Playlist',artist:'Artist'})[searchType]} results`
      : selected?.type === 'artist' ? 'Albums' : selected ? 'Songs' : ({albums: 'Saved albums', playlists: 'Your playlists', tracks: 'Liked songs'}[active] || 'Search results');
    heading.append(make('h2', '', listTitle), make('span', '', total ? `${total} items` : ''));
    const list = make('div', 'spv-track-list');
    if (loading && !items.length) list.append(make('p', 'spv-list-empty', 'Loading your library…'));
    else if (error && !items.length) list.append(make('p', 'spv-list-empty spv-error', error));
    else if (!items.length) list.append(make('p', 'spv-list-empty', emptyText()));
    items.forEach((item, index) => {
      const row = make('article', `spv-track-row${item.type === 'track' ? ' is-track' : ''}`);
      row.append(make('span', 'spv-track-number', String(index + 1)));
      const rowArt = item.artwork ? item : selected?.artwork ? { ...item, artwork: selected.artwork } : null;
      row.append(rowArt ? artwork(rowArt, 'spv-track-art') : make('span', 'spv-no-track-art'));
      const copy = make('button', 'spv-track-copy'); copy.type = 'button'; copy.append(make('strong', '', itemName(item)), make('small', '', itemMeta(item))); copy.addEventListener('click', () => item.type === 'album' || item.type === 'playlist' || item.type === 'artist' ? openItem(item) : playItem(item)); row.append(copy);
      if (item.type === 'artist') {
        const open = make('button', 'spv-track-open', 'Open albums'); open.type = 'button'; open.addEventListener('click', () => openItem(item)); row.append(open);
      } else {
        const playButton = iconButton('spv-track-play', 'play', `Play ${itemName(item)}`); playButton.addEventListener('click', () => playItem(item)); row.append(playButton);
      }
      if (item.type === 'track') {
        const add = iconButton('spv-track-queue', 'add', `Add ${itemName(item)} to queue`); add.addEventListener('click', () => act({ action: 'queue', uri: item.uri })); row.append(add);
        row.append(make('span', 'spv-track-duration', duration(item.durationMs)));
      }
      list.append(row);
    });
    detailView.append(heading, list);
    const more = make('button', 'spv-more', 'Load more'); more.type = 'button'; more.hidden = !nextOffset; more.addEventListener('click', () => { if (!nextOffset || loading) return; offset = nextOffset; loadCollection(true); }); detailView.append(more);
  }
  function renderQueue() {
    queueView.replaceChildren(make('p', 'spv-eyebrow', 'UP NEXT'), make('h1', '', 'Queue'));
    const list = make('div', 'spv-track-list');
    if (queue?.current) list.append(queueRow(queue.current, 'Now playing'));
    (queue?.items || []).forEach((item, index) => list.append(queueRow(item, String(index + 1))));
    if (error) list.append(make('p', 'spv-list-empty spv-error', error));
    else if (!queue?.current && !queue?.items?.length) list.append(make('p', 'spv-list-empty', connected() ? 'Your Spotify queue is empty.' : 'Connect Spotify to view your queue.'));
    queueView.append(list);
  }
  function queueRow(item, index) {
    const row = make('article', 'spv-track-row'); row.append(make('span', 'spv-track-number', index), item.artwork ? artwork(item, 'spv-track-art') : make('span', 'spv-no-track-art'));
    const copy = make('span', 'spv-track-copy'); copy.append(make('strong', '', item.title || item.name || index), make('small', '', item.artist || ''));
    row.append(copy); if (item.uri) { const b = iconButton('spv-track-play', 'play', `Play ${item.title || item.name}`); b.addEventListener('click', () => playItem(item)); row.append(b); } return row;
  }
  function renderNow() {
    nowView.replaceChildren();
    if (!current.track?.title) { nowView.append(make('p', 'spv-eyebrow', 'NOW PLAYING'), make('h1', '', 'Nothing playing'), make('p', 'spv-now-empty', connected() ? 'Choose an album or song from your library.' : 'Connect Spotify to start listening.')); return; }
    tintFromArtwork(nowView, current.track);
    const cover = artwork(current.track, 'spv-now-cover');
    const info = make('div', 'spv-now-playing-copy'); info.append(make('p', 'spv-eyebrow', current.playing ? 'NOW PLAYING' : 'READY WHEN YOU ARE'), make('h1', '', current.track.title), make('p', '', current.track.artist || ''), make('span', '', current.track.album || ''));
    nowView.append(cover, info);
  }
  function emptyText() {
    if (!connected()) return 'Connect Spotify in Home settings to browse your music.';
    if (selected?.type === 'artist') return 'No saved albums were returned for this artist.';
    if (active === 'playlists') return 'No playlists were returned for this account.';
    if (active === 'tracks') return 'No liked songs were returned for this account.';
    if (active === 'albums') return 'No liked albums were returned for this account.';
    return 'No Spotify results found.';
  }
  function render() {
    updateStatus(); renderSidebar(); navButtons.forEach((button, key) => button.setAttribute('aria-current', String(key === mode || key === 'home' && mode === 'detail')));
    sidebar.hidden = mode === 'now'; searchForm.hidden = mode !== 'search';
    homeView.hidden = mode !== 'home'; detailView.hidden = mode !== 'detail' && mode !== 'search'; queueView.hidden = mode !== 'queue'; nowView.hidden = mode !== 'now';
    if (mode === 'home') renderHome(); else if (mode === 'detail' || mode === 'search') renderDetail(); else if (mode === 'queue') renderQueue(); else renderNow(); renderPlayer();
  }
  async function fetchCapability() { try { capabilities = await request('/spotify/capabilities'); missingScopes = Array.isArray(capabilities?.missing) ? capabilities.missing : []; } catch { capabilities = null; } }
  async function loadHomeData() {
    if (!connected()) { albums = []; playlists = []; render(); return; }
    const sequence = ++homeRequestSequence; homeLoading = true; render();
    try {
      const [albumPage, playlistPage] = await Promise.all([request(`/spotify/library/albums?limit=${LIMIT}&offset=0`), request(`/spotify/playlists?limit=${LIMIT}&offset=0`)]);
      if (destroyed || sequence !== homeRequestSequence) return;
      albums = Array.isArray(albumPage?.items) ? albumPage.items : []; playlists = Array.isArray(playlistPage?.items) ? playlistPage.items : [];
      albumsNextOffset = Object.hasOwn(albumPage || {}, 'nextOffset') ? albumPage.nextOffset : null;
      playlistsNextOffset = Object.hasOwn(playlistPage || {}, 'nextOffset') ? playlistPage.nextOffset : null;
      albumsTotal = Number(albumPage?.total) || albums.length; playlistsTotal = Number(playlistPage?.total) || playlists.length;
      if (!capabilities?.known || !effectiveMissingScopes().length) setNotice('');
      if (albumPage?.error || playlistPage?.error) setNotice('Some saved music could not be loaded.');
    } catch (reason) { if (sequence === homeRequestSequence) handleError(reason); }
    finally { if (sequence === homeRequestSequence) { homeLoading = false; render(); } }
  }
  async function loadCollection(append = false) {
    if (mode === 'search' && !selected) return search(append);
    const sequence = ++dataRequestSequence; loading = true; error = ''; missingScopes = Array.isArray(capabilities?.missing) ? capabilities.missing : []; if (!append) { items = []; offset = 0; }
    render();
    let path = '';
    if (selected?.type === 'artist') path = `/spotify/artists/${escapePath(selected.id)}/albums?limit=${LIMIT}&offset=${offset}`;
    else if (selected) path = `/spotify/${selected.type === 'playlist' ? 'playlists' : 'albums'}/${escapePath(selected.id)}/tracks?limit=${LIMIT}&offset=${offset}`;
    else if (active === 'playlists') path = `/spotify/playlists?limit=${LIMIT}&offset=${offset}`;
    else if (active === 'tracks') path = `/spotify/library/tracks?limit=${LIMIT}&offset=${offset}`;
    else if (active === 'albums') path = `/spotify/library/albums?limit=${LIMIT}&offset=${offset}`;
    else return search();
    try {
      const response = await request(path); if (destroyed || sequence !== dataRequestSequence) return;
      const page = Array.isArray(response?.items) ? response.items : []; items = append ? items.concat(page) : page; total = Number(response?.total) || items.length;
      offset = Number(response?.offset ?? offset); nextOffset = Object.hasOwn(response || {}, 'nextOffset') ? response.nextOffset : (offset + page.length < total ? offset + page.length : null); error = '';
    } catch (reason) { if (sequence === dataRequestSequence) handleError(reason); }
    finally { if (sequence === dataRequestSequence) { loading = false; render(); } }
  }
  async function search(append = false) {
    if (!append) { const term = searchInput.value.trim(); if (!term) { setNotice('Enter a song, album, artist, or playlist to search.'); return; } query = term; searchType = searchSelect.value; selected = null; mode = 'search'; offset = 0; nextOffset = null; items = []; }
    const sequence = ++dataRequestSequence; loading = true; error = ''; missingScopes = Array.isArray(capabilities?.missing) ? capabilities.missing : []; setNotice(''); render();
    try {
      const response = await request(`/spotify/search?q=${encodeURIComponent(query)}&type=${encodeURIComponent(searchType)}&limit=${SEARCH_LIMIT}&offset=${offset}`);
      if (destroyed || sequence !== dataRequestSequence) return; const collection = response?.results?.[searchType] || response; const page = Array.isArray(collection?.items) ? collection.items : [];
      items = append ? items.concat(page) : page; total = Number(collection?.total) || items.length; offset = Number(collection?.offset ?? offset);
      nextOffset = Object.hasOwn(collection || {}, 'nextOffset') ? collection.nextOffset : (offset + page.length < total ? offset + page.length : null);
    } catch (reason) { if (sequence === dataRequestSequence) handleError(reason); }
    finally { if (sequence === dataRequestSequence) { loading = false; render(); } }
  }
  async function loadQueue() {
    const sequence = ++dataRequestSequence; loading = true; error = ''; render();
    try { const result = await request('/spotify/queue'); if (destroyed || sequence !== dataRequestSequence) return; queue = result; }
    catch (reason) { if (sequence === dataRequestSequence) { handleError(reason); queue = null; } }
    finally { if (sequence === dataRequestSequence) { loading = false; render(); } }
  }
  function handleError(reason) {
    const data = reason?.data || {};
    if (data.needsReauth || data.error === 'spotify_missing_scope') { missingScopes = Array.isArray(data.missingScopes) ? data.missingScopes : []; error = scopeMessage(); setNotice(error, 'spv-notice-warning'); reconnect.hidden = false; }
    else { error = reason?.message || 'Spotify could not load this view.'; if (String(error).includes('spotify_not_connected')) error = 'Connect Spotify in Home settings before browsing.'; setNotice(error, 'spv-notice-error'); }
    render();
  }
  async function act(payload) {
    try { await action(payload); const fresh = await request('/spotify'); if (!destroyed) { current = fresh; render(); } if (payload.action === 'queue' && mode === 'queue') await loadQueue(); }
    catch (reason) { handleError(reason); }
  }
  function navigate(next) {
    dataRequestSequence++; loading = false; error = ''; nextOffset = null; selected = null; parents = [];
    mode = next; if (next === 'home') { active = 'albums'; render(); loadHomeData(); }
    else if (next === 'search') { render(); searchInput.focus(); }
    else if (next === 'queue') { render(); loadQueue(); }
    else { render(); }
  }
  function showLibrary(kind) {
    dataRequestSequence++; loading = false;
    const albumMode = kind === 'albums'; sidebarFilter = albumMode ? 'album' : 'playlist'; parents = [];
    active = albumMode ? 'albums' : 'playlists'; selected = null; mode = 'detail'; items = albumMode ? albums.slice() : playlists.slice();
    total = albumMode ? albumsTotal : playlistsTotal; offset = 0; nextOffset = albumMode ? albumsNextOffset : playlistsNextOffset; error = ''; render();
  }
  searchForm.addEventListener('submit', event => { event.preventDefault(); searchInput.blur(); search(); });
  searchInput.addEventListener('keydown', event => { if (event.key === 'Escape') navigate('home'); });
  async function refresh() {
    await fetchCapability(); try { current = await request('/spotify'); } catch { /* keep last known playback */ }
    updateStatus(); if (mode === 'home') await loadHomeData(); else if (mode === 'detail') await loadCollection(); else if (mode === 'queue') await loadQueue(); else render();
    if (capabilities?.known && missingScopes.length) { setNotice(scopeMessage(), 'spv-notice-warning'); reconnect.hidden = false; }
  }
  // Keep event bindings on rebuilt sidebar entries local to each entry.
  render();
  if (connected()) refresh(); else setNotice('Connect Spotify in Home settings, then your saved music will appear here.', 'spv-notice-warning');
  return {
    update(next) { const wasConnected = connected(); current = next || {}; updateStatus(); renderPlayer(); if (mode === 'now') renderNow(); if (!destroyed && !wasConnected && connected()) void refresh(); },
    updateProgress(ms) { const seek = $('.spv-seek', player), elapsed = $('.spv-elapsed', player); if (seek && !seek.matches(':active')) seek.value = String(Math.min(Number(ms) || 0, Number(seek.max) || 0)); if (elapsed) elapsed.textContent = duration(ms); },
    refresh,
    destroy() { destroyed = true; homeRequestSequence++; dataRequestSequence++; clearTimeout(sheetVolumeTimer); container.replaceChildren(); container.classList.remove('spotify-view'); },
  };
}
