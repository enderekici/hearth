import { renderThemePicker } from './theme-picker.js';
import { mountCalendarView } from './calendar-view.js';
import { mountSpotifyView } from './spotify-view.js';
import { mountSchoolView } from './school-view.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const API = '/api';
const CACHE_KEY = 'hearth.last-known.v1';
const state = {
  settings: { location: null, calendarIds: [], palette: 'linen', theme: 'auto', dayStart: '07:00', nightStart: '22:00', photoInterval: 30 },
  status: {}, events: [], photos: [], weather: null, spotify: null, calendars: [], selectedLocation: null,
  photoIndex: 0, photoIndexing: false, photoRetryTimer: null, slideshowTimer: null, refreshTimer: null, spotifyTimer: null, spotifyBackoffUntil: 0, progressTimer: null, toastTimer: null, placeSearchId: 0,
  calendarExpanded: false,
};
let calendarView = null;
let spotifyView = null;
let schoolView = null;

function safeDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date; }
function escText(value) { return String(value ?? ''); }
function text(selector, value) { const node = $(selector); if (node) node.textContent = escText(value); }
function setHidden(selector, hidden) { const node = $(selector); if (node) node.hidden = hidden; }
function formatTime(value, options = {}) {
  const date = safeDate(value); if (!date) return '';
  try { return new Intl.DateTimeFormat(undefined, { ...(selectedTimezone() ? { timeZone: selectedTimezone() } : {}), ...options, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date); }
  catch { return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
}
function formatDate(value, options = {}) {
  const date = safeDate(value); if (!date) return '';
  const isTimestamp = value instanceof Date || typeof value === 'string' && /T\d\d:\d\d/.test(value);
  const hasTime = options.hour || options.minute || options.second;
  const timeZone = options.timeZone || (isTimestamp && (hasTime || typeof value === 'string') ? selectedTimezone() : undefined);
  const formatterOptions = { ...(timeZone ? { timeZone } : {}), ...options };
  if (options.hour || options.minute || options.second) {
    formatterOptions.hour = '2-digit'; formatterOptions.minute = '2-digit'; formatterOptions.hourCycle = 'h23';
  }
  try { return new Intl.DateTimeFormat(undefined, formatterOptions).format(date); } catch { return date.toLocaleDateString(); }
}
function selectedTimezone() { return state.settings.location?.timezone || undefined; }
function dateKey(value, allDay = false) {
  const raw = String(value ?? '');
  if (allDay && /^\d{4}-\d\d-\d\d/.test(raw)) return raw.slice(0, 10);
  const date = safeDate(value); if (!date) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: selectedTimezone(), year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    return `${parts.find(p => p.type === 'year')?.value}-${parts.find(p => p.type === 'month')?.value}-${parts.find(p => p.type === 'day')?.value}`;
  } catch { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
}
function dateForKey(key) { const [year, month, day] = key.split('-').map(Number); return new Date(year, month - 1, day, 12); }
function displayEventDate(event) { return dateForKey(dateKey(event.start, event.allDay)); }
function localNowParts() {
  const date = new Date();
  if (!selectedTimezone()) return { hour: date.getHours(), minute: date.getMinutes(), date };
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: selectedTimezone(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
    return { hour: Number(parts.find(p => p.type === 'hour')?.value || 0), minute: Number(parts.find(p => p.type === 'minute')?.value || 0), date };
  } catch { return { hour: date.getHours(), minute: date.getMinutes(), date }; }
}
function api(path, options = {}) {
  const { timeoutMs = 15000, ...fetchOptions } = options;
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(`${API}${path}`, { credentials: 'same-origin', cache: 'no-store', ...fetchOptions, signal: controller.signal }).then(async response => {
    const raw = await response.text();
    let data = {}; try { data = raw ? JSON.parse(raw) : {}; } catch { data = { error: raw || response.statusText }; }
    if (!response.ok) { const error = new Error(data.error || data.message || `Request failed (${response.status})`); error.data = data; throw error; }
    return data;
  }).catch(error => { if (error.name === 'AbortError') throw new Error('Request timed out'); throw error; }).finally(() => clearTimeout(timeout));
}
function post(path, body, method = 'POST', timeoutMs = 15000) { return api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeoutMs }); }
function cacheRead() { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch { return {}; } }
function cacheWrite() {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ events: state.events, photos: state.photos, weather: state.weather, savedAt: new Date().toISOString() })); } catch { /* Browser storage may be disabled or full. */ }
}
function applyCache() {
  const cached = cacheRead();
  if (Array.isArray(cached.events)) { state.events = cached.events; renderAgenda(); }
  if (Array.isArray(cached.photos)) { state.photos = cached.photos; renderPhoto(); }
  if (cached.weather) { state.weather = cached.weather; renderWeather(); }
  if (cached.savedAt) text('#last-sync', `Showing saved data · ${formatDate(cached.savedAt, { hour: 'numeric', minute: '2-digit' })}`);
}
function showToast(message) {
  const node = $('#toast'); node.textContent = message; node.classList.add('show');
  clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => node.classList.remove('show'), 2600);
}
function setFeedback(message, bad = false) { const node = $('#settings-feedback'); node.textContent = message; node.style.color = bad ? 'var(--accent)' : ''; }
function mountPalettePicker() {
  renderThemePicker($('#palette-picker'), state.settings.palette || 'linen', palette => {
    saveSettings({ palette }, `${palette[0].toUpperCase()}${palette.slice(1)} palette selected`).catch(error => {
      setFeedback(error.message, true); mountPalettePicker();
    });
  });
}
function updateConnection(online, label = '') {
  const node = $('#connection'); node.classList.toggle('online', online); node.classList.toggle('offline', !online);
  $('span', node).textContent = label || (online ? 'Connected' : 'Offline · saved data');
}
function tickClock() {
  const date = new Date();
  let dateOptions = { weekday: 'long', day: 'numeric', month: 'long' };
  let timeOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  const zone = selectedTimezone(); if (zone) { dateOptions.timeZone = zone; timeOptions.timeZone = zone; }
  text('#date-line', formatDate(date, dateOptions)); text('#clock-line', formatDate(date, timeOptions));
  const { hour } = localNowParts();
  text('#greeting-line', hour < 6 ? 'Good night.' : hour < 12 ? 'Good morning.' : hour < 17 ? 'Good afternoon.' : hour < 21 ? 'Good evening.' : 'Good night.');
  updateTheme();
}
function toMinutes(value, fallback) { const match = /^(\d\d):(\d\d)$/.exec(value || ''); return match ? Number(match[1]) * 60 + Number(match[2]) : fallback; }
function updateTheme() {
  const theme = state.settings.theme || 'auto'; let night = theme === 'night' || theme === 'dark';
  if (theme === 'auto') {
    const now = localNowParts().hour * 60 + localNowParts().minute;
    const day = toMinutes(state.settings.dayStart, 420), dark = toMinutes(state.settings.nightStart, 1320);
    night = day < dark ? now < day || now >= dark : now < day && now >= dark;
  }
  document.body.dataset.palette = state.settings.palette || 'linen';
  document.body.classList.toggle('night', night);
  const color = night ? '#20221e' : '#f5f2e9'; $('meta[name="theme-color"]').content = color;
  text('#theme-toggle', night ? 'Night' : 'Day'); $('#theme-toggle').setAttribute('aria-label', night ? 'Switch to daylight theme' : 'Switch to night theme');
}
function weatherCode(code) {
  const c = Number(code);
  if (c === 0) return { label: 'Clear skies', icon: 'i-sun' };
  if ([1, 2].includes(c)) return { label: 'Partly cloudy', icon: 'i-sun' };
  if (c === 3) return { label: 'Overcast', icon: 'i-cloud' };
  if ([45, 48].includes(c)) return { label: 'Misty', icon: 'i-cloud' };
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(c)) return { label: 'Rain nearby', icon: 'i-rain' };
  if ([71, 73, 75, 77, 85, 86].includes(c)) return { label: 'Snow showers', icon: 'i-cloud' };
  if ([95, 96, 99].includes(c)) return { label: 'Thunderstorms', icon: 'i-rain' };
  return { label: 'Weather', icon: 'i-cloud' };
}
function setWeatherIcon(selector, icon) { const use = $(`${selector} use`); if (use) use.setAttribute('href', `#${icon}`); }
function temperature(value) { return Number.isFinite(Number(value)) ? `${Math.round(Number(value))}°` : '—°'; }
function renderWeather() {
  const w = state.weather, loc = state.settings.location;
  if (!w?.current) {
    text('#weather-temp', '—°'); text('#weather-summary', 'Weather'); text('#weather-place', loc?.name || 'Set a location in settings'); text('#weather-highlow', '— / —');
    text('#weather-detail-place', loc?.name || 'Weather'); setWeatherIcon('#weather-icon', 'i-cloud');
    $('#weather-detail-content').innerHTML = '<div class="detail-empty">Set a location in Home settings to see the forecast.</div>';
    return;
  }
  const description = weatherCode(w.current.code);
  text('#weather-temp', temperature(w.current.temperature)); text('#weather-summary', description.label); text('#weather-place', loc?.name || 'Your local forecast');
  const today = w.daily?.[0]; text('#weather-highlow', today ? `${Math.round(today.max)}° / ${Math.round(today.min)}°` : '');
  setWeatherIcon('#weather-icon', description.icon); text('#weather-detail-place', loc?.name || 'Your local forecast');
  $('#weather-detail-content').replaceChildren();
  const main = document.createElement('div'); main.className = 'weather-current';
  const temp = document.createElement('div'); temp.className = 'weather-current-temp'; temp.textContent = temperature(w.current.temperature);
  const copy = document.createElement('div'); copy.className = 'weather-current-copy';
  const strong = document.createElement('strong'); strong.textContent = description.label; const feels = document.createElement('span'); feels.textContent = `Feels like ${temperature(w.current.feelsLike)}`;
  const facts = document.createElement('div'); facts.className = 'weather-facts'; facts.textContent = `Wind ${Math.round(Number(w.current.wind) || 0)} km/h · Humidity ${Math.round(Number(w.current.humidity) || 0)}%`;
  copy.append(strong, feels, facts); main.append(temp, copy); $('#weather-detail-content').append(main);
  if (w.hourly?.length) {
    addForecastTitle('Next hours'); const strip = document.createElement('div'); strip.className = 'hourly-strip';
    w.hourly.slice(0, 24).forEach(item => {
      const box = document.createElement('div'); box.className = 'hour-item'; const time = document.createElement('span'); time.textContent = formatTime(item.time);
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); icon.setAttribute('class', 'weather-icon'); const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', `#${weatherCode(item.code).icon}`); icon.append(use);
      const degrees = document.createElement('strong'); degrees.textContent = temperature(item.temperature); const rain = document.createElement('span'); rain.textContent = Number.isFinite(Number(item.rainProbability)) ? `${Math.round(item.rainProbability)}% rain` : '';
      box.append(time, icon, degrees, rain); strip.append(box);
    }); $('#weather-detail-content').append(strip);
  }
  if (w.daily?.length) {
    addForecastTitle('The week'); const list = document.createElement('div'); list.className = 'daily-list';
    const mins = w.daily.map(x => Number(x.min)).filter(Number.isFinite), maxs = w.daily.map(x => Number(x.max)).filter(Number.isFinite);
    const min = Math.min(...mins), max = Math.max(...maxs), range = Math.max(1, max - min);
    w.daily.slice(0, 7).forEach((item, index) => {
      const row = document.createElement('div'); row.className = 'daily-row'; const date = document.createElement('strong'); date.textContent = index === 0 ? 'Today' : formatDate(dateForKey(dateKey(item.date, true)), { weekday: 'short' });
      const iconText = document.createElement('span'); iconText.textContent = weatherCode(item.code).label;
      const low = document.createElement('span'); low.textContent = temperature(item.min); const high = document.createElement('strong'); high.textContent = temperature(item.max);
      const bar = document.createElement('span'); bar.className = 'daily-range'; const fill = document.createElement('i'); const left = ((Number(item.min) - min) / range) * 60 + 10; const width = Math.max(20, ((Number(item.max) - Number(item.min)) / range) * 80); fill.style.left = `${left}%`; fill.style.width = `${width}%`; bar.append(fill);
      row.append(date, iconText, low, high); list.append(row);
    }); $('#weather-detail-content').append(list);
  }
  const stale = w.stale ? ` · Last updated ${formatDate(w.updatedAt, { hour: 'numeric', minute: '2-digit' })}` : '';
  text('#weather-state', loc ? `Set · ${loc.name}` : 'Not set'); $('#weather-state').className = `status-chip${loc ? ' good' : ''}`;
  if (stale) { const note = document.createElement('p'); note.className = 'form-note'; note.textContent = `Showing saved forecast${stale}`; $('#weather-detail-content').append(note); }
}
function addForecastTitle(label) { const title = document.createElement('h3'); title.className = 'forecast-title'; title.textContent = label; $('#weather-detail-content').append(title); }
function eventStart(event) { return safeDate(event.start); }
function sortedEvents() { return state.events.filter(event => eventStart(event)).sort((a, b) => eventStart(a) - eventStart(b)); }
function eventDayKey(event) {
  const start = dateKey(event.start, event.allDay), today = dateKey(new Date());
  if (!event.allDay) {
    const end = safeDate(event.end);
    return start < today && end && end > new Date() ? today : start;
  }
  if (start >= today) return start;
  const end = event.end ? dateKey(event.end, true) : '';
  return end > today ? today : start;
}
function groupEvents() {
  const now = new Date(), today = dateKey(now), lastDay = dateKey(new Date(now.getTime() + 9 * 86400000));
  return sortedEvents().filter(event => {
    const key = dateKey(event.start, event.allDay), end = safeDate(event.end);
    if (event.allDay) {
      const endKey = event.end ? dateKey(event.end, true) : '';
      return key <= lastDay && (endKey ? endKey > today : key >= today);
    }
    if (end) return end > now && key <= lastDay;
    return eventStart(event) >= new Date(now.getTime() - 2 * 60 * 60 * 1000) && key <= lastDay;
  });
}
function eventTime(event) { return event.allDay ? 'All day' : formatTime(event.start); }
function eventDayLabel(value, index, event = null) { const key = event ? eventDayKey(event) : dateKey(value); if (!key) return ''; const today = dateForKey(dateKey(new Date())), day = dateForKey(key); const delta = Math.round((day - today) / 86400000); return delta === 0 ? 'Today' : delta === 1 ? 'Tomorrow' : formatDate(day, { weekday: 'long' }); }
function calendarColor(event) { return event.color || state.calendars.find(cal => cal.id === event.calendarId)?.color || 'var(--olive)'; }
function updateNextAppointment() {
  const event = state.nextEvent;
  if (!event) {
    text('#next-up .next-title', 'No upcoming appointment'); text('#next-up .next-time', state.status.calendar?.configured ? 'Enjoy a little breathing room' : 'Connect iCloud to get started'); return;
  }
  const start = eventStart(event), end = safeDate(event.end), now = new Date(); let when;
  if (event.allDay && eventDayKey(event) === dateKey(now)) when = 'All day';
  else if (start <= now && end && end > now) when = `Happening now · until ${formatTime(end)}`;
  else if (event.allDay) when = `${eventDayLabel(start, 0, event)} · All day`;
  else when = `${formatCountdown(start - now)} · ${formatTime(start)}`;
  if (event.location) when += ` · ${event.location}`;
  text('#next-up .next-title', event.title || 'Untitled event'); text('#next-up .next-time', when);
}
function renderAgenda() {
  const events = groupEvents();
  const now = new Date();
  state.nextEvent = events.find(event => !event.allDay && eventStart(event) <= now && safeDate(event.end) > now)
    || events.find(event => !event.allDay && eventStart(event) > now)
    || events.find(event => event.allDay) || null;
  updateNextAppointment();
  const list = $('#agenda-list'); list.replaceChildren();
  if (!events.length) {
    const empty = document.createElement('div'); empty.className = 'empty-state'; const symbol = document.createElement('span'); symbol.className = 'empty-orbit'; symbol.textContent = '✳';
    const p = document.createElement('p'); p.textContent = state.status.calendar?.configured ? 'A little breathing room.' : 'Connect your calendars to see what is ahead.';
    const button = document.createElement('button'); button.className = 'text-button'; button.dataset.openSettings = ''; button.textContent = state.status.calendar?.configured ? 'No upcoming plans' : 'Set up iCloud calendar'; empty.append(symbol, p, button); list.append(empty);
  } else {
    const mainEvents = state.calendarExpanded ? events : events.slice(0, 3);
    const grouped = new Map(); mainEvents.forEach(event => { const key = eventDayKey(event); if (!grouped.has(key)) grouped.set(key, { date: dateForKey(key), items: [] }); grouped.get(key).items.push(event); });
    [...grouped.values()].slice(0, 4).forEach((day, dayIndex) => {
      const section = document.createElement('section'); section.className = 'agenda-day'; const label = document.createElement('div'); label.className = 'agenda-day-label';
      const strong = document.createElement('strong'); strong.textContent = eventDayLabel(day.date, dayIndex); const dateText = document.createElement('span'); dateText.textContent = formatDate(day.date, { day: 'numeric', month: 'short' }); label.append(strong, dateText); section.append(label);
      day.items.slice(0, state.calendarExpanded ? 99 : 3).forEach(event => section.append(buildEventRow(event))); list.append(section);
    });
  }
  const configured = state.status.calendar?.configured || state.calendars.length > 0;
  text('#calendar-updated', state.status.calendar?.error ? `Calendar · ${state.status.calendar.error}` : state.status.calendar?.lastSuccess ? `Updated ${formatDate(state.status.calendar.lastSuccess, { hour: 'numeric', minute: '2-digit' })}` : configured ? 'Calendar ready' : 'Calendar not connected');
}
function buildEventRow(event, detail = false) {
  const row = document.createElement(detail ? 'div' : 'div'); row.className = detail ? 'detail-event' : 'event-row';
  if (detail) {
    const time = document.createElement('time'); time.textContent = eventTime(event); const color = document.createElement('i'); color.style.background = calendarColor(event); const copy = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = event.title || 'Untitled event'; copy.append(title);
    const extra = [event.location, event.description].filter(Boolean).join(' · '); if (extra) { const p = document.createElement('p'); p.textContent = extra; copy.append(p); }
    row.append(time, color, copy);
  } else {
    const time = document.createElement('span'); time.className = 'event-time'; time.textContent = eventTime(event); const color = document.createElement('span'); color.className = 'event-color'; color.style.background = calendarColor(event); const copy = document.createElement('div'); copy.className = 'event-copy';
    const title = document.createElement('strong'); title.textContent = event.title || 'Untitled event'; copy.append(title);
    const duration = document.createElement('span'); duration.className = 'event-duration'; const end = safeDate(event.end); duration.textContent = end && !event.allDay ? formatTime(end) : '';
    row.append(time, color, copy, duration);
    const extra = [event.location, event.description].filter(Boolean).join(' · ');
    if (extra) {
      const details = document.createElement('span'); details.className = 'event-extra'; details.textContent = extra; details.hidden = true; row.append(details);
      row.tabIndex = 0; row.setAttribute('role', 'button'); row.setAttribute('aria-expanded', 'false'); row.setAttribute('aria-label', `${event.title || 'Event'}, show details`);
      const toggle = () => { details.hidden = !details.hidden; row.setAttribute('aria-expanded', String(!details.hidden)); };
      row.addEventListener('click', toggle); row.addEventListener('keydown', key => { if (key.key === 'Enter' || key.key === ' ') { key.preventDefault(); toggle(); } });
    }
  }
  return row;
}
function renderCalendarDetails() {
  calendarView?.destroy();
  calendarView = mountCalendarView($('#calendar-detail-content'), {
    events: state.events,
    timezone: selectedTimezone() || 'Europe/London',
    configured: Boolean(state.status.calendar?.configured),
    onRangeRequest: (from, to) => api(`/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  });
}
function formatCountdown(ms) { if (ms <= 0) return 'Starting now'; const mins = Math.ceil(ms / 60000); if (mins < 60) return `In ${mins} min`; const hours = Math.floor(mins / 60), rest = mins % 60; if (hours < 24) return `In ${hours}h${rest ? ` ${rest}m` : ''}`; const days = Math.floor(hours / 24); return `In ${days} ${days === 1 ? 'day' : 'days'}`; }
function renderPhoto() {
  const photo = state.photos[state.photoIndex]; const image = $('#photo-image');
  if (!photo) {
    if (image.hidden) { $('#photo-placeholder').hidden = false; setHidden('#photo-controls', true); }
    text('#photo-placeholder-title', state.photoIndexing ? 'Preparing your photo library' : state.status.photos?.configured ? 'No photos found' : 'Your moments, at home');
    text('#photo-placeholder-copy', state.photoIndexing ? 'The Pi is getting your pictures ready' : state.status.photos?.configured ? 'Add pictures to a selected folder on the Pi' : 'Add a photo folder on the Pi to begin');
    text('#photo-status', state.photoIndexing ? 'Finding your photo folders…' : 'Slideshow is ready when you are'); return;
  }
  const url = photo.url || `${API}/photos/${encodeURIComponent(photo.id)}`; const candidate = new Image(); candidate.decoding = 'async';
  candidate.onload = () => {
    image.src = url; image.hidden = false; $('#photo-placeholder').hidden = true;
    text('#photo-counter', `${state.photoIndex + 1} / ${state.photos.length}`); setHidden('#photo-controls', false);
    text('#photo-status', `${state.photos.length} ${state.photos.length === 1 ? 'photo' : 'photos'} · changes every ${state.settings.photoInterval || 30}s`);
  };
  candidate.onerror = () => {
    if (image.hidden) { $('#photo-placeholder').hidden = false; text('#photo-placeholder-title', 'Photos are unavailable'); text('#photo-placeholder-copy', 'The Pi will try again when the library is reachable'); }
    text('#photo-status', image.hidden ? 'Could not load a photo' : 'Showing the last photo · could not load the next one');
  };
  candidate.src = url;
}
function startSlideshow() { clearInterval(state.slideshowTimer); if (state.photos.length > 1) state.slideshowTimer = setInterval(() => changePhoto(1), Math.max(5, Number(state.settings.photoInterval) || 30) * 1000); }
function changePhoto(direction) { if (!state.photos.length) return; state.photoIndex = (state.photoIndex + direction + state.photos.length) % state.photos.length; renderPhoto(); }
function photoToggle() { if (state.slideshowTimer) { clearInterval(state.slideshowTimer); state.slideshowTimer = null; $('use', $('#photo-toggle')).setAttribute('href', '#i-play'); $('#photo-toggle').setAttribute('aria-label', 'Resume slideshow'); } else { $('use', $('#photo-toggle')).setAttribute('href', '#i-pause'); $('#photo-toggle').setAttribute('aria-label', 'Pause slideshow'); startSlideshow(); } }
function renderSpotify() {
  const s = state.spotify || {}; const track = s.track; const connected = Boolean(s.connected);
  text('#spotify-state', connected ? 'Connected' : s.configured ? 'Login needed' : 'Not connected'); $('#spotify-state').className = `status-chip${connected ? ' good' : ''}`;
  text('#track-title', track?.title || 'A soundtrack for home'); text('#track-artist', track?.artist || (connected ? 'Choose a speaker below' : 'Connect your Spotify account in Settings'));
  const art = $('#track-art'); art.style.backgroundImage = track?.artwork ? `url("${String(track.artwork).replace(/["\\]/g, '')}")` : '';
  const duration = Number(track?.durationMs) || 0; const progress = Number(s.progressMs) || 0;
  text('#track-duration', clockDuration(duration)); text('#track-elapsed', clockDuration(progress)); $('#progress-fill').style.width = duration ? `${Math.min(100, progress / duration * 100)}%` : '0%';
  $('use', $('#music-toggle')).setAttribute('href', s.playing ? '#i-pause' : '#i-play'); $('#music-toggle').setAttribute('aria-label', s.playing ? 'Pause' : 'Play');
  const select = $('#spotify-device'); const old = select.value; select.replaceChildren(); const devices = Array.isArray(s.devices) ? s.devices : [];
  if (!devices.length) { const option = new Option(connected ? 'No active speaker' : 'No active speaker', ''); select.append(option); }
  devices.forEach(device => { const option = new Option(device.name || 'Spotify device', device.id); option.selected = device.id === (s.device?.id || old); select.append(option); });
  const volume = Number(s.device?.volume); if (Number.isFinite(volume)) { $('#spotify-volume').value = volume; text('#volume-value', volume); }
  const error = s.error; text('#music-error', error || ''); setHidden('#music-error', !error);
  const available = Boolean(connected && track); ['#music-prev', '#music-next', '#music-toggle'].forEach(selector => { $(selector).disabled = !connected; });
  spotifyView?.update(s);
}
function clockDuration(ms) { if (!ms) return '0:00'; const seconds = Math.floor(ms / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }
async function spotifyAction(action, extra = {}) {
  try { await post('/spotify/action', { action, ...extra }); await refreshSpotify(); }
  catch (error) { text('#music-error', error.message); setHidden('#music-error', false); }
}
async function refreshSpotify() {
  if (state.spotifyBackoffUntil > Date.now()) return;
  try {
    const result = await api('/spotify');
    if (String(result.error || '').includes('api_error_429')) {
      state.spotifyBackoffUntil = Date.now() + 60_000;
      state.spotify = { ...state.spotify, error: 'Spotify is busy. Checking again in a minute.' };
    } else {
      state.spotifyBackoffUntil = 0; state.spotify = result;
    }
    renderSpotify();
  } catch (error) {
    if (String(error.message).includes('429')) state.spotifyBackoffUntil = Date.now() + 60_000;
    if (state.spotify) state.spotify = { ...state.spotify, error: error.message };
    renderSpotify();
  }
}
async function refreshPhotoCatalog() {
  try {
    const data = await api('/photos'); state.photoIndexing = Boolean(data.indexing);
    state.photos = Array.isArray(data.photos) ? data.photos : []; if (state.photoIndex >= state.photos.length) state.photoIndex = 0;
    renderPhoto(); cacheWrite(); clearTimeout(state.photoRetryTimer);
    if (state.photoIndexing) state.photoRetryTimer = setTimeout(refreshPhotoCatalog, 3000);
  } catch { /* Keep the last visible photo and retry with the regular refresh. */ }
}
async function loadSettings() {
  try { const settings = await api('/settings'); state.settings = { ...state.settings, ...settings };
  } catch { /* A cold page can render before the backend is reachable. */ }
  const s = state.settings;
  if (s.theme === 'light') s.theme = 'day'; else if (s.theme === 'dark') s.theme = 'night';
  $('#theme-setting').value = s.theme || 'auto'; $('#day-start').value = s.dayStart || '07:00'; $('#night-start').value = s.nightStart || '22:00'; $('#photo-interval').value = String(s.photoInterval || 30);
  if (s.location) { state.selectedLocation = s.location; text('#chosen-location', `${s.location.name}${s.location.timezone ? ` · ${s.location.timezone}` : ''}`); }
  $('#save-location').disabled = !state.selectedLocation;
  $('#location-search').value = s.location?.name || '';
  const status = state.status; text('#icloud-state', status.calendar?.configured ? 'Connected' : 'Not connected'); $('#icloud-state').className = `status-chip${status.calendar?.configured ? ' good' : ''}`;
  if (status.calendar?.configured) { $('#icloud-email').placeholder = 'Apple ID saved on this device'; $('#icloud-password').placeholder = 'Enter a new app-specific password to replace'; }
  $('#spotify-client-id').value = s.spotifyClientId || '';
  updateTheme();
  mountPalettePicker();
}
async function refreshAll() {
  const results = await Promise.allSettled([api('/status'), api('/calendar'), api('/photos'), api('/weather'), api('/spotify')]);
  let reachable = false;
  if (results[0].status === 'fulfilled') { state.status = results[0].value; reachable = true; }
  if (results[1].status === 'fulfilled') { const data = results[1].value; if (Array.isArray(data.events)) state.events = data.events; if (data.error && data.stale) text('#calendar-updated', `Saved calendar · ${data.error}`); }
  if (results[2].status === 'fulfilled') {
    const data = results[2].value; state.photoIndexing = Boolean(data.indexing);
    state.photos = Array.isArray(data.photos) ? data.photos : []; if (state.photoIndex >= state.photos.length) state.photoIndex = 0;
    clearTimeout(state.photoRetryTimer); if (state.photoIndexing) state.photoRetryTimer = setTimeout(refreshPhotoCatalog, 3000);
  }
  if (results[3].status === 'fulfilled') state.weather = results[3].value;
  if (results[4].status === 'fulfilled') state.spotify = results[4].value;
  const configured = Boolean(state.status.calendar?.configured || state.status.weather?.configured
    || state.status.spotify?.connected || state.photos.length);
  const problems = ['calendar', 'photos', 'weather', 'spotify'].some(key => state.status[key]?.configured && state.status[key]?.error);
  updateConnection(reachable, reachable ? (!configured ? 'Finish setup' : problems ? 'Some data needs attention' : 'Connected') : 'Offline · saved data');
    renderAgenda(); renderPhoto(); renderWeather(); renderSpotify(); cacheWrite();
  if (reachable) {
    text('#last-sync', configured ? `${problems ? 'Some saved data may be out of date' : 'Home data refreshed'} · ${formatDate(new Date(), { hour: 'numeric', minute: '2-digit' })}` : 'Finish setup to see your home data');
  }
  startSlideshow();
}
async function loadCalendars() {
  try { const data = await api('/calendars'); state.calendars = data.calendars || []; renderCalendarOptions(); }
  catch (error) { setFeedback(error.message, true); }
}
async function loadPhotoAlbums() {
  const node = $('#photo-albums'); node.replaceChildren();
  try {
    const data = await api('/photo-albums'); state.photoAlbums = data.albums || []; const selected = new Set(state.settings.photoAlbums || []);
    if (!state.photoAlbums.length) { const message = document.createElement('span'); message.className = 'form-note'; message.textContent = 'No photo folders found yet.'; node.append(message); return; }
    state.photoAlbums.forEach(album => {
      const label = document.createElement('label'); label.className = 'album-option'; const input = document.createElement('input'); input.type = 'checkbox'; input.value = album.id; input.checked = selected.has(album.id);
      const name = document.createElement('span'); name.textContent = album.name || 'Photo folder'; label.append(input, name); node.append(label);
    });
  } catch (error) { const message = document.createElement('span'); message.className = 'form-note'; message.textContent = error.message || 'Photo folders are unavailable.'; node.append(message); }
}
function renderCalendarOptions() {
  const node = $('#calendar-options'); node.replaceChildren(); const selected = new Set(state.settings.calendarIds || []);
  state.calendars.forEach(calendar => {
    const label = document.createElement('label'); label.className = 'calendar-option'; const input = document.createElement('input'); input.type = 'checkbox'; input.value = calendar.id; input.checked = selected.has(calendar.id);
    const swatch = document.createElement('i'); swatch.className = 'calendar-swatch'; swatch.style.background = calendar.color || 'var(--olive)'; const name = document.createElement('span'); name.textContent = calendar.name || 'Calendar'; label.append(input, swatch, name); node.append(label);
  }); setHidden('#calendar-select', !state.calendars.length);
}
function openSettings() {
  if (!$('#settings-dialog').open) $('#settings-dialog').showModal(); loadCalendars(); loadPhotoAlbums();
}
function closeSpotifyDialog() { closeDialog($('#spotify-dialog')); }
function openSchoolDialog() {
  const dialog = $('#school-dialog');
  if (!dialog.open) dialog.showModal();
  if (schoolView) return schoolView.refresh();
  schoolView = mountSchoolView($('#school-view'), { request: api });
}
function connectSpotifyFromView() {
  closeSpotifyDialog();
  if (window.FrameKiosk) {
    openSettings(); setFeedback('Connect Spotify from your computer browser through the SSH tunnel.');
    return;
  }
  if (!state.settings.spotifyClientId) { openSettings(); setFeedback('Add your Spotify Client ID before connecting.'); return; }
  location.href = '/api/spotify/login';
}
function openSpotifyDialog() {
  const dialog = $('#spotify-dialog');
  if (!dialog.open) dialog.showModal();
  if (spotifyView) return spotifyView.refresh();
  spotifyView = mountSpotifyView($('#spotify-view'), {
    spotify: state.spotify,
    request: api,
    action: payload => post('/spotify/action', payload),
    onConnect: connectSpotifyFromView,
    onClose: closeSpotifyDialog,
  });
}
function closeDialog(dialog) { if (dialog.open) dialog.close(); }
async function saveSettings(patch, message = 'Settings saved') {
  const backendPatch = { ...patch };
  if (backendPatch.theme === 'day') backendPatch.theme = 'light'; else if (backendPatch.theme === 'night') backendPatch.theme = 'dark';
  await post('/settings', backendPatch, 'PUT'); state.settings = { ...state.settings, ...patch }; updateTheme(); await loadSettings(); setFeedback(message); showToast(message); return state.settings;
}
async function geocode(query) {
  const searchId = ++state.placeSearchId;
  state.selectedLocation = null; $('#save-location').disabled = true; text('#chosen-location', 'Choose a place from the search results');
  const results = $('#location-results'); results.replaceChildren(); setHidden('#location-results', false); const loading = document.createElement('div'); loading.className = 'location-result'; loading.textContent = 'Looking for places…'; results.append(loading);
  try {
    const data = await api(`/places?q=${encodeURIComponent(query)}`, { timeoutMs: 10000 });
    if (searchId !== state.placeSearchId) return;
    results.replaceChildren();
    (data.results || []).forEach(place => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'location-result'; button.textContent = [place.name, place.admin1, place.country].filter((value, index, all) => value && all.indexOf(value) === index).join(', ');
      button.addEventListener('click', () => { state.selectedLocation = { name: button.textContent, latitude: place.latitude, longitude: place.longitude, timezone: place.timezone || '' }; text('#chosen-location', `${state.selectedLocation.name}${place.timezone ? ` · ${place.timezone}` : ''}`); $('#save-location').disabled = false; setHidden('#location-results', true); }); results.append(button);
    });
    if (!data.results?.length) { const empty = document.createElement('div'); empty.className = 'location-result'; empty.textContent = 'No places found. Try a nearby town.'; results.append(empty); }
  } catch (error) { if (searchId !== state.placeSearchId) return; results.replaceChildren(); const message = document.createElement('div'); message.className = 'location-result'; message.textContent = error.message; results.append(message); }
}
async function connectCalendar(event) {
  event.preventDefault(); const button = $('#icloud-connect'); button.disabled = true; button.textContent = 'Connecting…'; setFeedback('Checking your Apple calendar…');
  try {
    const data = await post('/icloud/connect', { email: $('#icloud-email').value.trim(), password: $('#icloud-password').value }, 'POST', 25000);
    $('#icloud-password').value = ''; state.calendars = data.calendars || []; renderCalendarOptions(); $('#calendar-select').hidden = !state.calendars.length;
    text('#icloud-state', 'Connected'); $('#icloud-state').className = 'status-chip good'; setFeedback('Connected. Choose which calendars to show, then save.'); await refreshAll();
  } catch (error) { setFeedback(error.message, true); }
  finally { button.disabled = false; button.textContent = 'Connect Apple calendar'; }
}
async function saveCalendars() {
  const ids = $$('#calendar-options input:checked').map(input => input.value);
  try { const data = await post('/calendars', { calendarIds: ids }, 'PUT'); state.settings.calendarIds = ids; if (data.calendars) state.calendars = data.calendars; setFeedback('Calendar selection saved.'); await refreshAll(); }
  catch (error) { setFeedback(error.message, true); }
}
async function saveSpotify() {
  try {
    const clientId = $('#spotify-client-id').value.trim();
    await post('/spotify/config', { clientId });
    setFeedback('Spotify Client ID saved.'); await refreshSpotify();
  }
  catch (error) { setFeedback(error.message, true); }
}
async function setup() {
  applyCache(); tickClock(); setInterval(tickClock, 1000);
  const bridge = window.FrameKiosk;
  if (!bridge) $('.android-section').hidden = true;
  if (!bridge?.setBrightness) $('.brightness-row').hidden = true;
  if (!bridge?.openSettings) $('#open-android-settings').hidden = true;
  if (!bridge?.openLauncher) $('#open-launcher').hidden = true;
  if (window.FrameKiosk) { $('#spotify-login').hidden = true; $('#spotify-frame-note').hidden = false; }
  try { state.status = await api('/status'); } catch { updateConnection(false); }
  await loadSettings(); await refreshAll();
  clearInterval(state.refreshTimer); state.refreshTimer = setInterval(refreshAll, 60000);
  clearInterval(state.spotifyTimer); state.spotifyTimer = setInterval(() => {
    if (!document.hidden && state.status.spotify?.configured && state.spotifyBackoffUntil <= Date.now()) refreshSpotify();
  }, 12000);
  clearInterval(state.progressTimer); state.progressTimer = setInterval(() => {
    if (!state.spotify?.playing || !state.spotify.track?.durationMs) return;
    state.spotify.progressMs = Math.min(state.spotify.track.durationMs, (Number(state.spotify.progressMs) || 0) + 1000);
    text('#track-elapsed', clockDuration(state.spotify.progressMs)); $('#progress-fill').style.width = `${Math.min(100, state.spotify.progressMs / state.spotify.track.durationMs * 100)}%`;
    spotifyView?.updateProgress(state.spotify.progressMs);
  }, 1000);
  setInterval(updateNextAppointment, 60000);
  if (new URLSearchParams(location.search).has('settings') || location.hash === '#settings') openSettings();
}

$('#settings-open').addEventListener('click', openSettings);
$('#spotify-browse').addEventListener('click', openSpotifyDialog);
$('#spotify-dialog').addEventListener('close', () => { spotifyView?.destroy(); spotifyView = null; });
$('#school-open').addEventListener('click', openSchoolDialog);
$('#school-dialog-close').addEventListener('click', () => closeDialog($('#school-dialog')));
$('#school-dialog').addEventListener('close', () => { schoolView?.destroy(); schoolView = null; });
$('#theme-toggle').addEventListener('click', async () => {
  const next = document.body.classList.contains('night') ? 'day' : 'night';
  $('#theme-setting').value = next;
  try { await saveSettings({ theme: next }, `${next === 'night' ? 'Night' : 'Day'} theme selected`); }
  catch (error) { setFeedback(error.message, true); }
});
document.addEventListener('click', event => { if (event.target.closest('[data-open-settings]')) openSettings(); });
$$('.dialog-close').forEach(button => button.addEventListener('click', () => closeDialog(button.closest('dialog'))));
$$('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) closeDialog(dialog); }));
$('#weather-open').addEventListener('click', () => $('#weather-dialog').showModal());
$('#calendar-expand').addEventListener('click', () => { renderCalendarDetails(); $('#calendar-dialog').showModal(); });
$('#calendar-refresh').addEventListener('click', async event => { const button = event.currentTarget; button.textContent = 'Updating…'; await refreshAll(); button.textContent = 'Refresh'; });
$('#photo-prev').addEventListener('click', () => changePhoto(-1)); $('#photo-next').addEventListener('click', () => changePhoto(1)); $('#photo-toggle').addEventListener('click', photoToggle);
function togglePhotoFullscreen(force) {
  const stage = $('#photo-stage'); const enable = force ?? !stage.classList.contains('css-fullscreen');
  stage.classList.toggle('css-fullscreen', enable); document.body.classList.toggle('photo-fullscreen-active', enable);
  $('#photo-fullscreen').setAttribute('aria-label', enable ? 'Exit fullscreen' : 'Open fullscreen');
  $('use', $('#photo-fullscreen')).setAttribute('href', enable ? '#i-close' : '#i-expand');
}
$('#photo-fullscreen').addEventListener('click', () => togglePhotoFullscreen());
document.addEventListener('keydown', event => { if (event.key === 'Escape' && $('#photo-stage').classList.contains('css-fullscreen')) togglePhotoFullscreen(false); });
$('#music-prev').addEventListener('click', () => spotifyAction('previous')); $('#music-next').addEventListener('click', () => spotifyAction('next'));
$('#music-toggle').addEventListener('click', () => spotifyAction(state.spotify?.playing ? 'pause' : 'play'));
$('#spotify-device').addEventListener('change', event => event.target.value && spotifyAction('transfer', { deviceId: event.target.value }));
let volumeTimer; $('#spotify-volume').addEventListener('input', event => { text('#volume-value', event.target.value); clearTimeout(volumeTimer); volumeTimer = setTimeout(() => spotifyAction('volume', { volume: Number(event.target.value), deviceId: state.spotify?.device?.id }), 280); });
$('#icloud-form').addEventListener('submit', connectCalendar); $('#save-calendars').addEventListener('click', saveCalendars);
$('#save-photo-albums').addEventListener('click', async () => {
  const photoAlbums = $$('#photo-albums input:checked').map(input => input.value);
  try { await saveSettings({ photoAlbums }, 'Photo folders saved'); await refreshAll(); }
  catch (error) { setFeedback(error.message, true); }
});
$('#location-form').addEventListener('submit', event => { event.preventDefault(); const query = $('#location-search').value.trim(); if (query) geocode(query); });
$('#save-location').addEventListener('click', async () => { if (!state.selectedLocation) { setFeedback('Search and select a place first.', true); return; } try { await saveSettings({ location: state.selectedLocation }, 'Home location saved'); await refreshAll(); } catch (error) { setFeedback(error.message, true); } });
$('#spotify-form').addEventListener('submit', event => { event.preventDefault(); saveSpotify(); }); $('#refresh-devices').addEventListener('click', async () => { await refreshSpotify(); showToast('Speaker list refreshed'); });
for (const selector of ['#theme-setting', '#day-start', '#night-start', '#photo-interval']) $(selector).addEventListener('change', async () => {
  const patch = { theme: $('#theme-setting').value, dayStart: $('#day-start').value, nightStart: $('#night-start').value, photoInterval: Number($('#photo-interval').value) };
  try { await saveSettings(patch); startSlideshow(); } catch (error) { setFeedback(error.message, true); }
});
$('#brightness-range').addEventListener('input', event => {
  const value = Number(event.target.value); text('#brightness-value', `${value}%`);
  const bridge = window.FrameKiosk; if (bridge?.setBrightness) { try { bridge.setBrightness(value / 100); } catch { /* Older bridge versions may not expose brightness. */ } }
});
$('#open-launcher').addEventListener('click', () => { if (window.FrameKiosk?.openLauncher) window.FrameKiosk.openLauncher(); else showToast('Device launcher is available on the frame'); });
$('#open-android-settings').addEventListener('click', () => { if (window.FrameKiosk?.openSettings) window.FrameKiosk.openSettings(); else showToast('Android settings are available on the frame'); });
$('#reload-dashboard').addEventListener('click', () => location.reload());
if (window.FrameKiosk?.getBrightness) { try { const level = Number(window.FrameKiosk.getBrightness()); if (Number.isFinite(level)) { $('#brightness-range').value = Math.round(level * 100); text('#brightness-value', `${Math.round(level * 100)}%`); } } catch { /* Optional Android bridge. */ } }
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAll(); });
setup();
