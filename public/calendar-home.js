import { mountCalendarView } from './calendar-view.js';

const $ = selector => document.querySelector(selector);
const CACHE_KEY = 'hearth.calendar-home.v1';
let settings = { palette: 'linen', theme: 'auto', dayStart: '07:00', nightStart: '22:00' };
let configured = false;
let calendar = null;
let zone = 'Europe/London';
let cachedEvents = [];
let refreshing = false;
let lastMounted = '';
try {
  const saved = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
  if (saved.settings) settings = { ...settings, ...saved.settings };
  configured = Boolean(saved.configured);
  cachedEvents = Array.isArray(saved.events) ? saved.events : [];
} catch { /* Storage is optional. */ }

async function request(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`/api${path}`, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
      ...(body ? { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Calendar unavailable');
    return data;
  } finally { clearTimeout(timer); }
}
function saveCache() {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ settings: {
    palette: settings.palette, theme: settings.theme, dayStart: settings.dayStart,
    nightStart: settings.nightStart, location: { timezone: settings.location?.timezone || zone },
  }, configured, events: cachedEvents })); } catch { /* Storage is optional. */ }
}
function tick() {
  const now = new Date();
  zone = settings.location?.timezone || 'Europe/London';
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const value = key => parts.find(part => part.type === key)?.value || '00';
  $('#clock').textContent = `${value('hour')}:${value('minute')}`;
  const minutes = Number(value('hour')) * 60 + Number(value('minute'));
  const toMinutes = (raw, fallback) => /^\d\d:\d\d$/.test(raw || '') ? Number(raw.slice(0, 2)) * 60 + Number(raw.slice(3)) : fallback;
  const day = toMinutes(settings.dayStart, 420), night = toMinutes(settings.nightStart, 1320);
  const dark = settings.theme === 'night' || settings.theme === 'dark' || settings.theme === 'auto' && (day < night ? minutes < day || minutes >= night : minutes < day && minutes >= night);
  document.body.dataset.palette = settings.palette || 'linen';
  document.body.classList.toggle('night', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  $('meta[name="theme-color"]').content = dark ? '#20221e' : '#f5f2e9';
}
function mount() {
  const key = `${zone}:${configured}`;
  if (calendar && key === lastMounted) return false;
  calendar?.destroy();
  calendar = mountCalendarView($('#calendar'), {
    events: cachedEvents, timezone: zone, configured,
    onRangeRequest: async (from, to) => {
      const data = await request(`/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      if (Array.isArray(data.events)) { cachedEvents = data.events; saveCache(); }
      return data;
    },
  });
  lastMounted = key;
  return true;
}
async function refresh() {
  if (refreshing || document.hidden) return;
  refreshing = true;
  try {
    const [nextSettings, status] = await Promise.all([request('/settings'), request('/status')]);
    settings = nextSettings;
    configured = Boolean(status.calendar?.configured);
    tick();
    const mounted = mount();
    if (!mounted) await calendar.refresh();
    $('#connection-status').textContent = configured ? '' : 'Connect your iCloud calendars in Settings.';
    saveCache();
  } catch {
    $('#connection-status').textContent = 'Offline · showing saved calendar. Retrying automatically.';
  } finally { refreshing = false; }
}
async function openSettings() {
  $('#theme').value = settings.theme === 'night' ? 'dark' : settings.theme === 'day' ? 'light' : settings.theme || 'auto';
  $('#settings-dialog').showModal();
  $('#calendar-options').textContent = 'Loading calendars…';
  $('#settings-feedback').textContent = '';
  $('#save-calendars').disabled = true;
  try {
    const data = await request('/calendars');
    const options = $('#calendar-options'); options.replaceChildren();
    const selected = new Set(settings.calendarIds || []);
    for (const item of data.calendars || []) {
      const label = document.createElement('label'); label.className = 'calendar-option';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = item.id; checkbox.checked = selected.has(item.id);
      const name = document.createElement('span'); name.textContent = item.name || 'Calendar'; label.append(checkbox, name); options.append(label);
    }
    if (!options.children.length) options.textContent = 'No calendars connected. Open Connections below to set up iCloud.';
    $('#save-calendars').disabled = !options.children.length;
  } catch { $('#calendar-options').textContent = 'Could not load calendars. Check the connection and reopen Settings.'; }
}
$('#settings-open').addEventListener('click', openSettings);
$('#settings-close').addEventListener('click', () => $('#settings-dialog').close());
$('#settings-dialog').addEventListener('click', event => { if (event.target === $('#settings-dialog')) event.target.close(); });
$('#theme').addEventListener('change', async event => {
  try { settings = await request('/settings', { theme: event.target.value }); tick(); saveCache(); }
  catch { event.target.value = settings.theme || 'auto'; $('#settings-feedback').textContent = 'Could not save appearance. Please retry.'; }
});
$('#calendar-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = $('#save-calendars'); button.disabled = true;
  try {
    const calendarIds = [...document.querySelectorAll('#calendar-options input:checked')].map(input => input.value);
    await request('/calendars', { calendarIds }); settings.calendarIds = calendarIds;
    cachedEvents = []; calendar?.updateEvents([]);
    $('#settings-feedback').textContent = 'Calendars saved.';
    await refresh();
  } catch { $('#settings-feedback').textContent = 'Could not save calendars. Please retry.'; }
  finally { button.disabled = false; }
});
tick(); mount(); refresh();
setInterval(tick, 10000);
setInterval(refresh, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
