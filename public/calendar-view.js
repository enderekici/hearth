const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validZone(timeZone) {
  try { new Intl.DateTimeFormat('en', { timeZone }).format(0); return timeZone; }
  catch { return 'UTC'; }
}

export function dateKeyInZone(value, timeZone = 'UTC', allDay = false) {
  const raw = String(value ?? '');
  if (allDay && DATE_RE.test(raw)) return raw;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: validZone(timeZone), calendar: 'iso8601', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  return `${parts.find(part => part.type === 'year').value}-${parts.find(part => part.type === 'month').value}-${parts.find(part => part.type === 'day').value}`;
}

export function shiftCivilDate(key, days) {
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function civilWeekStart(key) {
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  return shiftCivilDate(key, -((date.getUTCDay() + 6) % 7));
}

function visibleDays(view, anchor) {
  if (view === 'week') {
    const start = civilWeekStart(anchor);
    return Array.from({ length: 7 }, (_, index) => shiftCivilDate(start, index));
  }
  if (view === 'month') {
    const first = `${anchor.slice(0, 7)}-01`;
    const start = civilWeekStart(first);
    return Array.from({ length: 42 }, (_, index) => shiftCivilDate(start, index));
  }
  return Array.from({ length: 31 }, (_, index) => shiftCivilDate(anchor, index));
}

function eventStartKey(event, timeZone) { return dateKeyInZone(event.start, timeZone, event.allDay); }
function eventEndKeyExclusive(event, timeZone) {
  if (event.allDay && DATE_RE.test(String(event.end || ''))) return String(event.end).slice(0, 10);
  const start = eventStartKey(event, timeZone);
  const end = new Date(event.end);
  const startInstant = new Date(event.start);
  if (!Number.isFinite(end.getTime()) || !Number.isFinite(startInstant.getTime()) || end <= startInstant) return start ? shiftCivilDate(start, 1) : '';
  const key = dateKeyInZone(end, timeZone);
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: validZone(timeZone), hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(end);
  const atMidnight = ['hour', 'minute', 'second'].every(type => parts.find(part => part.type === type)?.value === '00') && end.getUTCMilliseconds() === 0;
  return atMidnight ? key : shiftCivilDate(key, 1);
}

function eventTouchesDay(event, key, timeZone) {
  const start = eventStartKey(event, timeZone);
  const end = eventEndKeyExclusive(event, timeZone);
  return Boolean(start && end && start <= key && key < end);
}

function eventTime(event, timeZone) {
  if (event.allDay) return 'All day';
  const date = new Date(event.start);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { timeZone: validZone(timeZone), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

function sortEvents(events) {
  return [...events].filter(event => event && event.start).sort((left, right) => String(left.start).localeCompare(String(right.start)) || String(left.title || '').localeCompare(String(right.title || '')));
}

export function formatDay(key, timeZone, options = {}) {
  const [year, month, day] = key.split('-').map(Number);
  // `key` is already a civil date in the configured zone. Format it at UTC noon
  // so extreme offsets cannot shift the label to the adjacent civil day.
  return new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', ...options }).format(new Date(Date.UTC(year, month - 1, day, 12)));
}

function rangeFor(view, anchor) {
  const days = visibleDays(view, anchor);
  return { from: shiftCivilDate(days[0], -1), to: shiftCivilDate(days.at(-1), 2) };
}

function moveAnchor(view, anchor, amount) {
  if (view === 'week') return shiftCivilDate(anchor, amount * 7);
  if (view === 'agenda') return shiftCivilDate(anchor, amount * 31);
  const [year, month] = anchor.split('-').map(Number);
  const moved = new Date(Date.UTC(year, month - 1 + amount, 1, 12));
  return `${moved.getUTCFullYear()}-${String(moved.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function eventLabel(event, timeZone) {
  const card = document.createElement('article');
  card.className = 'cv-event';
  card.style.setProperty('--event-color', event.color || 'var(--olive)');
  const time = document.createElement('time');
  time.textContent = eventTime(event, timeZone);
  const body = document.createElement('div');
  body.className = 'cv-event-copy';
  const title = document.createElement('strong');
  title.textContent = event.title || 'Untitled event';
  body.append(title);
  if (event.location) {
    const location = document.createElement('span');
    location.className = 'cv-event-meta';
    location.textContent = event.location;
    body.append(location);
  }
  if (event.description) {
    const description = document.createElement('p');
    description.textContent = event.description;
    body.append(description);
  }
  card.append(time, body);
  return card;
}

export function mountCalendarView(container, {
  events = [], timezone = 'Europe/London', onRangeRequest = async () => null, configured = true,
} = {}) {
  if (!(container instanceof Element)) throw new TypeError('Calendar view needs a container element');
  const zone = validZone(timezone);
  let allEvents = sortEvents(events);
  let view = 'week';
  let anchor = dateKeyInZone(new Date(), zone);
  let requestSequence = 0;
  let destroyed = false;
  let selectedDay = '';
  let statusMessage = '';
  let loadedRange = null;
  let failedRange = null;
  let requesting = false;

  container.replaceChildren();
  container.classList.add('calendar-view');
  const header = document.createElement('div'); header.className = 'cv-header';
  const controls = document.createElement('div'); controls.className = 'cv-controls';
  const heading = document.createElement('h2'); heading.className = 'cv-range-title';
  const rangeLabel = document.createElement('p'); rangeLabel.className = 'cv-range-label'; rangeLabel.setAttribute('aria-live', 'polite');
  const nav = document.createElement('div'); nav.className = 'cv-nav';
  const prev = document.createElement('button'); prev.className = 'cv-icon-button'; prev.type = 'button'; prev.textContent = '‹'; prev.setAttribute('aria-label', 'Previous range');
  const today = document.createElement('button'); today.className = 'cv-today'; today.type = 'button'; today.textContent = 'Today';
  const next = document.createElement('button'); next.className = 'cv-icon-button'; next.type = 'button'; next.textContent = '›'; next.setAttribute('aria-label', 'Next range');
  nav.append(prev, today, next);
  const tabs = document.createElement('div'); tabs.className = 'cv-tabs'; tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', 'Calendar view');
  const tabButtons = new Map();
  for (const [key, label] of [['agenda', 'Agenda'], ['week', 'Week'], ['month', 'Month']]) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'cv-tab'; button.textContent = label; button.dataset.view = key; button.setAttribute('aria-pressed', String(key === view));
    tabs.append(button); tabButtons.set(key, button);
  }
  controls.append(nav, tabs); header.append(heading, rangeLabel, controls);
  const status = document.createElement('p'); status.className = 'cv-status'; status.setAttribute('role', 'status');
  const content = document.createElement('div'); content.className = 'cv-content'; content.tabIndex = -1;
  const detail = document.createElement('section'); detail.className = 'cv-day-detail'; detail.hidden = true; detail.setAttribute('aria-label', 'Events for selected day');
  container.append(header, status, content, detail);

  function visibleTitle(days) {
    if (view === 'month') return formatDay(`${anchor.slice(0, 7)}-01`, zone, { month: 'long', year: 'numeric' });
    if (view === 'agenda') return `${formatDay(days[0], zone, { day: 'numeric', month: 'short' })} – ${formatDay(days.at(-1), zone, { day: 'numeric', month: 'short', year: 'numeric' })}`;
    if (days[0].slice(0, 7) === days.at(-1).slice(0, 7)) return formatDay(days[0], zone, { month: 'long', year: 'numeric' });
    return `${formatDay(days[0], zone, { day: 'numeric', month: 'short' })} – ${formatDay(days.at(-1), zone, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  }

  function renderDetail() {
    detail.replaceChildren();
    if (!selectedDay) { detail.hidden = true; return; }
    detail.hidden = false;
    const title = document.createElement('h3'); title.textContent = formatDay(selectedDay, zone, { weekday: 'long', day: 'numeric', month: 'long' });
    const close = document.createElement('button'); close.type = 'button'; close.className = 'cv-detail-close'; close.textContent = 'Close'; close.setAttribute('aria-label', 'Close selected day details');
    const top = document.createElement('div'); top.className = 'cv-detail-top'; top.append(title, close); detail.append(top);
    const matches = allEvents.filter(event => eventTouchesDay(event, selectedDay, zone));
    if (!matches.length) { const empty = document.createElement('p'); empty.className = 'cv-empty'; empty.textContent = 'No events for this day.'; detail.append(empty); }
    else { const list = document.createElement('div'); list.className = 'cv-event-list'; matches.forEach(event => list.append(eventLabel(event, zone))); detail.append(list); }
    close.addEventListener('click', () => { selectedDay = ''; renderDetail(); });
  }

  function renderMonth(days) {
    const grid = document.createElement('div'); grid.className = 'cv-month-grid';
    grid.setAttribute('role', 'grid'); grid.setAttribute('aria-label', heading.textContent);
    const weekdays = document.createElement('div'); weekdays.className = 'cv-weekdays'; weekdays.setAttribute('role', 'row');
    for (const key of days.slice(0, 7)) { const label = document.createElement('span'); label.setAttribute('role', 'columnheader'); label.textContent = formatDay(key, zone, { weekday: 'short' }); weekdays.append(label); }
    grid.append(weekdays);
    const cells = document.createElement('div'); cells.className = 'cv-month-cells';
    const todayKey = dateKeyInZone(new Date(), zone); const monthPrefix = anchor.slice(0, 7);
    for (const key of days) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'cv-day-cell'; button.setAttribute('role', 'gridcell');
      button.classList.toggle('outside-month', !key.startsWith(monthPrefix)); button.classList.toggle('is-today', key === todayKey);
      button.setAttribute('aria-label', formatDay(key, zone, { weekday: 'long', day: 'numeric', month: 'long' }));
      if (key === todayKey) button.setAttribute('aria-current', 'date');
      const number = document.createElement('span'); number.className = 'cv-day-number'; number.textContent = String(Number(key.slice(-2))); button.append(number);
      const list = document.createElement('span'); list.className = 'cv-month-events';
      const matches = allEvents.filter(event => eventTouchesDay(event, key, zone));
      matches.slice(0, 2).forEach(event => { const item = document.createElement('span'); item.className = 'cv-month-event'; item.style.setProperty('--event-color', event.color || 'var(--olive)'); item.textContent = event.title || 'Untitled event'; list.append(item); });
      if (matches.length > 2) { const more = document.createElement('span'); more.className = 'cv-more'; more.textContent = `+${matches.length - 2} more`; list.append(more); }
      button.append(list); button.addEventListener('click', () => { selectedDay = key; renderDetail(); detail.scrollIntoView({ block: 'nearest' }); }); cells.append(button);
    }
    grid.append(cells); content.append(grid);
  }

  function renderList(days) {
    const grouped = document.createElement('div'); grouped.className = `cv-day-list cv-${view}-list`;
    const todayKey = dateKeyInZone(new Date(), zone);
    const eventGroups = days.map(key => ({ key, matches: allEvents.filter(event => eventTouchesDay(event, key, zone)) }));
    const displayedDays = view === 'agenda' ? eventGroups.filter(group => group.matches.length) : eventGroups;
    if (view === 'agenda' && !displayedDays.length) {
      const empty = document.createElement('p'); empty.className = 'cv-range-empty';
      empty.textContent = days.every(key => rangeCovers(loadedRange, key)) ? 'Nothing on the calendar in this range.' : 'Events for this range have not loaded.';
      grouped.append(empty);
    }
    for (const { key, matches } of displayedDays) {
      const section = document.createElement('section'); section.className = 'cv-day'; section.classList.toggle('is-today', key === todayKey);
      const title = document.createElement('button'); title.type = 'button'; title.className = 'cv-day-heading';
      title.textContent = `${formatDay(key, zone, { weekday: 'long', day: 'numeric', month: 'short' })}${key === todayKey ? ' · Today' : ''}`;
      title.addEventListener('click', () => { selectedDay = key; renderDetail(); detail.scrollIntoView({ block: 'nearest' }); }); section.append(title);
      if (!matches.length) { const empty = document.createElement('p'); empty.className = 'cv-no-events'; empty.textContent = rangeCovers(loadedRange, key) ? 'No events' : rangeCovers(failedRange, key) ? 'Events unavailable' : requesting ? 'Loading events…' : 'Events not loaded'; section.append(empty); }
      else { const list = document.createElement('div'); list.className = 'cv-event-list'; matches.forEach(event => list.append(eventLabel(event, zone))); section.append(list); }
      grouped.append(section);
    }
    content.append(grouped);
  }

  function rangeCovers(range, key) { return Boolean(range && range.from <= key && key < range.to); }

  function render() {
    const days = visibleDays(view, anchor);
    heading.textContent = visibleTitle(days);
    rangeLabel.textContent = `${formatDay(days[0], zone, { weekday: 'long', day: 'numeric', month: 'long' })} – ${formatDay(days.at(-1), zone, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`;
    tabButtons.forEach((button, key) => button.setAttribute('aria-pressed', String(key === view)));
    content.replaceChildren();
    if (!configured) {
      status.textContent = 'Connect and select an iCloud calendar in Home settings to browse events.';
      content.hidden = true; detail.hidden = true; return;
    }
    content.hidden = false;
    status.textContent = statusMessage;
    if (view === 'month') renderMonth(days); else renderList(days);
    renderDetail();
  }

  async function fetchVisible() {
    if (!configured || typeof onRangeRequest !== 'function') return;
    const sequence = ++requestSequence;
    const range = rangeFor(view, anchor);
    requesting = true; failedRange = null; statusMessage = 'Loading this range…'; render();
    try {
      const response = await onRangeRequest(range.from, range.to);
      if (destroyed || sequence !== requestSequence) return;
      if (Array.isArray(response?.events)) allEvents = sortEvents(response.events);
      loadedRange = { from: response?.rangeStart || range.from, to: response?.rangeEnd || range.to };
      failedRange = null; requesting = false;
      statusMessage = response?.stale
        ? `Showing saved calendar data${response.error ? ` · ${String(response.error)}` : ''}${response.updatedAt ? ` · updated ${formatDay(dateKeyInZone(response.updatedAt, zone), zone, { month: 'short', day: 'numeric' })}` : ''}`
        : response?.error ? `Calendar update: ${String(response.error)}` : '';
    } catch (error) {
      if (destroyed || sequence !== requestSequence) return;
      requesting = false; failedRange = range;
      statusMessage = `Could not load this range: ${error?.message || 'request failed'}. Showing saved events.`;
    }
    render();
  }

  function navigate(delta) { selectedDay = ''; anchor = moveAnchor(view, anchor, delta); render(); fetchVisible(); }
  prev.addEventListener('click', () => navigate(-1));
  next.addEventListener('click', () => navigate(1));
  today.addEventListener('click', () => { anchor = dateKeyInZone(new Date(), zone); selectedDay = ''; render(); fetchVisible(); });
  tabs.addEventListener('click', event => {
    const button = event.target.closest('button[data-view]');
    if (!button || !tabs.contains(button)) return;
    view = button.dataset.view;
    selectedDay = '';
    if (view === 'month') anchor = `${anchor.slice(0, 7)}-01`;
    render(); fetchVisible();
  });

  render();
  if (configured) fetchVisible();
  return {
    updateEvents(nextEvents) { allEvents = sortEvents(nextEvents || []); render(); },
    destroy() { destroyed = true; requestSequence++; container.replaceChildren(); container.classList.remove('calendar-view'); },
  };
}

