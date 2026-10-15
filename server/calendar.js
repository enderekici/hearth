import ICAL from 'ical.js';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false, parseTagValue: false, trimValues: false });
const arr = x => x == null ? [] : Array.isArray(x) ? x : [x];
const text = x => typeof x === 'string' ? x : x?.['#text'];
const propfind = properties => '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>' + properties + '</d:prop></d:propfind>';
const stamp = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

export class CalendarError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

export function appleURL(href, base = 'https://caldav.icloud.com/') {
  const u = new URL(href, base);
  if (u.protocol !== 'https:' || u.port || u.username || u.password
      || !(u.hostname === 'caldav.icloud.com' || /^p\d+-caldav\.icloud\.com$/.test(u.hostname))) {
    throw new CalendarError('untrusted_calendar_url');
  }
  return u;
}

async function readBody(res) {
  const maxBytes = 2 * 1024 * 1024;
  if (Number(res.headers.get('content-length')) > maxBytes) {
    await res.body?.cancel();
    throw new CalendarError('calendar_response_too_large');
  }
  if (!res.body) throw new CalendarError('empty_calendar_response');
  const reader = res.body.getReader(), decoder = new TextDecoder();
  let size = 0, body = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { body += decoder.decode(); break; }
      size += value.byteLength;
      if (size > maxBytes) throw new CalendarError('calendar_response_too_large');
      body += decoder.decode(value, { stream: true });
    }
  } finally { await reader.cancel(); }
  if (/<!DOCTYPE|<!ENTITY/i.test(body) || XMLValidator.validate(body) !== true) throw new CalendarError('invalid_calendar_xml');
  return arr(parser.parse(body).multistatus?.response);
}

function props(r) {
  const p = {};
  for (const x of arr(r.propstat)) if (/\s200\s/.test(x.status || '')) Object.assign(p, x.prop);
  return p;
}

function zonedDate(time, tzid, formatters) {
  if (typeof tzid !== 'string' || !tzid) throw new CalendarError('unresolved_calendar_timezone');
  let format = formatters.get(tzid);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat('en-US', { timeZone: tzid, calendar: 'iso8601',
        numberingSystem: 'latn', hourCycle: 'h23', year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch { throw new CalendarError('unresolved_calendar_timezone'); }
    formatters.set(tzid, format);
  }
  const localStamp = date => {
    const p = Object.fromEntries(format.formatToParts(date).map(x => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  };
  const wall = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
  const candidates = new Set();
  for (const hours of [-36, 0, 36]) {
    const sample = wall + hours * 3_600_000;
    const candidate = wall - (localStamp(new Date(sample)) - sample);
    if (localStamp(new Date(candidate)) === wall) candidates.add(candidate);
  }
  if (candidates.size !== 1) throw new CalendarError('ambiguous_or_nonexistent_calendar_time');
  return new Date([...candidates][0]);
}

export function parseEvents(ics, calendarId) {
  const root = new ICAL.Component(ICAL.parse(ics));
  const embeddedZones = new Set(root.getAllSubcomponents('vtimezone')
    .map(zone => zone.getFirstPropertyValue('tzid')).filter(Boolean));
  const events = [];
  const formatters = new Map();
  for (const c of root.getAllSubcomponents('vevent')) {
    if (c.getFirstPropertyValue('status') === 'CANCELLED') continue;
    if (c.hasProperty('rrule') || c.hasProperty('rdate')) throw new CalendarError('server_did_not_expand_recurrence');
    const e = new ICAL.Event(c), start = e.startDate, end = e.endDate;
    if (!e.uid || !start || !end) throw new CalendarError('invalid_calendar_event');
    const toDate = (time, propertyName) => {
      if (time.isDate) return time.toJSDate();
      const prop = c.getFirstProperty(propertyName) || c.getFirstProperty('dtstart');
      const tzid = prop?.getParameter('tzid');
      if (tzid && !embeddedZones.has(tzid)) return zonedDate(time, tzid, formatters);
      if (!tzid && time.zone?.tzid === 'floating') throw new CalendarError('unresolved_calendar_timezone');
      return time.toJSDate();
    };
    const startDate = toDate(start, 'dtstart'), endDate = toDate(end, 'dtend');
    if (endDate < startDate) throw new CalendarError('invalid_calendar_duration');
    const recurrence = c.getFirstPropertyValue('recurrence-id');
    events.push({
      id: calendarId + ':' + e.uid + ':' + (recurrence?.toString() || start.toString()),
      calendarId, title: e.summary || '(Untitled)',
      start: start.isDate ? start.toString() : startDate.toISOString(),
      end: end.isDate ? end.toString() : endDate.toISOString(),
      allDay: start.isDate, location: e.location || '', description: e.description || '',
    });
    if (events.length > 2000) throw new CalendarError('too_many_calendar_events');
  }
  return events;
}

export async function discoverCalendars(credentials, fetcher = fetch) {
  const auth = 'Basic ' + Buffer.from(credentials.email + ':' + credentials.password).toString('base64');
  const signal = AbortSignal.timeout(20000);
  let requests = 0;
  async function request(href, method, body, depth = '0', redirects = 0) {
    if (++requests > 12) throw new CalendarError('too_many_calendar_requests');
    const url = appleURL(href);
    const res = await fetcher(url, { method, body, redirect: 'manual', signal,
      headers: { Authorization: auth, 'Content-Type': 'application/xml; charset=utf-8', Depth: depth } });
    if ([301, 302, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location'); await res.body?.cancel();
      if (!loc || redirects >= 3) throw new CalendarError('calendar_redirect_failed');
      return request(appleURL(loc, url), method, body, depth, redirects + 1);
    }
    if (!res.ok) { await res.body?.cancel(); throw new CalendarError(res.status === 401 ? 'icloud_authentication_failed' : 'icloud_request_failed', res.status); }
    return { url, responses: await readBody(res) };
  }
  const principal = await request('https://caldav.icloud.com/', 'PROPFIND', propfind('<d:current-user-principal/>'));
  const principalHref = text(principal.responses.map(props).find(p => p['current-user-principal']?.href)?.['current-user-principal']?.href);
  if (!principalHref) throw new CalendarError('calendar_principal_missing');
  const home = await request(appleURL(principalHref, principal.url), 'PROPFIND', propfind('<c:calendar-home-set/>'));
  const homeHref = text(home.responses.map(props).find(p => p['calendar-home-set']?.href)?.['calendar-home-set']?.href);
  if (!homeHref) throw new CalendarError('calendar_home_missing');
  const listing = await request(appleURL(homeHref, home.url), 'PROPFIND',
    propfind('<d:displayname/><d:resourcetype/><x:calendar-color xmlns:x="http://apple.com/ns/ical/"/>'), '1');
  return listing.responses.filter(r => Object.hasOwn(props(r).resourcetype || {}, 'calendar'))
    .map(r => ({ id: appleURL(text(r.href), listing.url).href, name: text(props(r).displayname) || 'Calendar',
      color: text(props(r)['calendar-color']) || '' }));
}

export function defaultCalendarRange(now = new Date()) {
  const from = new Date(now); from.setUTCHours(0, 0, 0, 0); from.setUTCDate(from.getUTCDate() - 1);
  const to = new Date(from); to.setUTCDate(to.getUTCDate() + 36);
  return { from, to, rangeStart: from.toISOString().slice(0, 10), rangeEnd: to.toISOString().slice(0, 10) };
}

export async function readCalendars(config, now = new Date(), fetcher = fetch, range = null) {
  const requestedRange = range || defaultCalendarRange(now);
  const { from, to, rangeStart, rangeEnd } = requestedRange;
  if (!config.icloud || !config.calendarIds.length) {
    return { calendars: [], events: [], configured: false, rangeStart, rangeEnd };
  }
  const auth = 'Basic ' + Buffer.from(config.icloud.email + ':' + config.icloud.password).toString('base64');
  const signal = AbortSignal.timeout(25000);
  let count = 0;
  async function request(href, method, body, depth = '0', redirects = 0) {
    if (++count > 45) throw new CalendarError('too_many_calendar_requests');
    const url = appleURL(href);
    const res = await fetcher(url, { method, body, redirect: 'manual', signal,
      headers: { Authorization: auth, 'Content-Type': 'application/xml; charset=utf-8', Depth: depth } });
    if ([301, 302, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location'); await res.body?.cancel();
      if (!loc || redirects >= 3) throw new CalendarError('calendar_redirect_failed');
      return request(appleURL(loc, url), method, body, depth, redirects + 1);
    }
    if (!res.ok) { await res.body?.cancel(); throw new CalendarError(res.status === 401 ? 'icloud_authentication_failed' : 'icloud_request_failed', res.status); }
    return { url, responses: await readBody(res) };
  }
  const calendars = await discoverCalendars(config.icloud, fetcher);
  const selected = calendars.filter(c => config.calendarIds.includes(c.id));
  if (selected.length !== config.calendarIds.length) throw new CalendarError('selected_calendar_missing');
  const body = '<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data><c:expand start="' + stamp(from) + '" end="' + stamp(to) + '"/></c:calendar-data></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="' + stamp(from) + '" end="' + stamp(to) + '"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>';
  const events = [];
  for (const cal of selected) {
    const report = await request(cal.id, 'REPORT', body, '1');
    for (const r of report.responses) {
      const ics = text(props(r)['calendar-data']);
      if (!ics) throw new CalendarError('calendar_data_missing');
      events.push(...parseEvents(ics, cal.id));
      if (events.length > 2000) throw new CalendarError('too_many_calendar_events');
    }
  }
  events.sort((a, b) => a.start.localeCompare(b.start));
  return { configured: true, calendars: selected, events, rangeStart, rangeEnd,
    updatedAt: now.toISOString(), stale: false, error: null };
}
