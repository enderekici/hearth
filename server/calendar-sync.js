import { createHash } from 'node:crypto';
import ICAL from 'ical.js';
import { appleURL, CalendarError } from './calendar.js';

const SOURCE_NAMESPACE = 'mcas';
const MAX_EVENTS = 250;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_ICS_BYTES = 512 * 1024;
const MAX_REDIRECTS = 2;
const REQUEST_TIMEOUT_MS = 15000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const OFFSET_DATE_TIME_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/i;

export class CalendarSyncError extends Error {
  constructor(code, status = 0) {
    super(code);
    this.name = 'CalendarSyncError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, status = 0) { throw new CalendarSyncError(code, status); }

function selectedCalendarURL(value) {
  let url;
  try { url = appleURL(value); }
  catch (error) {
    if (error instanceof CalendarError) fail(error.code);
    fail('invalid_destination_calendar');
  }
  if (url.search || url.hash || !url.pathname.endsWith('/')) fail('invalid_destination_calendar');
  return url;
}

function canonicalSourceId(value) {
  if (typeof value !== 'string') fail('invalid_source_id');
  const id = value.normalize('NFC').trim();
  if (!id || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id)) fail('invalid_source_id');
  return id;
}

function normalizeInstant(value, field) {
  if (typeof value !== 'string' || !OFFSET_DATE_TIME_RE.test(value)) fail(`invalid_${field}`);
  const dateTime = /^(\d{4}-\d\d-\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.\d{1,3})?)?/.exec(value);
  if (!dateTime) fail(`invalid_${field}`);
  validCivilDate(dateTime[1], field);
  if (+dateTime[2] > 23 || +dateTime[3] > 59 || +(dateTime[4] || 0) > 59) fail(`invalid_${field}`);
  const offset = /([+-])(\d\d):(\d\d)$/.exec(value);
  if (offset && (+offset[2] > 23 || +offset[3] > 59)) fail(`invalid_${field}`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail(`invalid_${field}`);
  return date;
}

function validCivilDate(value, field) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) fail(`invalid_${field}`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail(`invalid_${field}`);
  return value;
}

function validTimezone(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || value.length > 128) fail('invalid_timezone');
  try { new Intl.DateTimeFormat('en', { timeZone: value }); }
  catch { fail('invalid_timezone'); }
  return value;
}

function normalizeEvent(input, feedComplete) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_source_event');
  if (Object.keys(input).some(key => /recurr|rrule|rdate|exdate/i.test(key))) fail('unsupported_source_recurrence');
  const sourceId = canonicalSourceId(input.sourceId);
  const cancelled = input.status === 'cancelled' || input.cancelled === true;
  if (input.status && !['confirmed', 'cancelled'].includes(input.status)) fail('invalid_source_status');
  if (input.cancelled != null && typeof input.cancelled !== 'boolean') fail('invalid_source_status');
  if (input.status === 'confirmed' && input.cancelled === true) fail('invalid_source_status');
  const allDay = input.allDay === true;
  if (input.allDay != null && typeof input.allDay !== 'boolean') fail('invalid_all_day');
  const timezone = validTimezone(input.timeZone ?? input.timezone);
  let start, end, startDate, endDate;
  if (allDay) {
    startDate = validCivilDate(input.start, 'start');
    endDate = validCivilDate(input.end, 'end');
    if (endDate <= startDate) fail('invalid_event_duration');
    start = startDate; end = endDate;
  } else {
    start = normalizeInstant(input.start, 'start');
    end = normalizeInstant(input.end, 'end');
    if (end <= start) fail('invalid_event_duration');
  }
  const title = typeof input.title === 'string' ? input.title : '';
  const location = input.location == null ? '' : input.location;
  const description = input.description == null ? '' : input.description;
  if (typeof location !== 'string' || typeof description !== 'string'
      || title.length > 10000 || location.length > 10000 || description.length > 40000) fail('invalid_event_text');
  let sourceUpdatedAt = null;
  if (input.sourceUpdatedAt != null) {
    const updated = normalizeInstant(input.sourceUpdatedAt, 'source_updated_at');
    sourceUpdatedAt = updated.toISOString();
  }
  return {
    sourceId, sourceMarker: `${SOURCE_NAMESPACE}:${sourceId}`, cancelled, allDay,
    start, end, timezone, title: title || '(Untitled)', location, description, sourceUpdatedAt,
    skipped: cancelled && !feedComplete,
  };
}

function stableId(sourceId) {
  return createHash('sha256').update(`${SOURCE_NAMESPACE}\0${sourceId}`, 'utf8').digest('hex');
}

function escapeText(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n')
    .replace(/,/g, '\\,').replace(/;/g, '\\;');
}

function foldLine(line) {
  const chunks = [];
  let current = '', width = 0;
  for (const char of line) {
    const bytes = Buffer.byteLength(char, 'utf8');
    if (width + bytes > 75) {
      chunks.push(current);
      current = ' ';
      width = 1;
    }
    current += char;
    width += bytes;
  }
  chunks.push(current);
  return chunks.join('\r\n');
}

function compactUTC(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function makeIcs(event, uid, now) {
  const dtstamp = compactUTC(event.sourceUpdatedAt ? new Date(event.sourceUpdatedAt) : now);
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Hearth//MCAS Family Calendar Sync//EN',
    'CALSCALE:GREGORIAN', 'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${dtstamp}`,
    `X-HEARTH-SOURCE:${escapeText(event.sourceMarker)}`,
  ];
  if (event.cancelled) lines.push('STATUS:CANCELLED');
  if (event.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${event.start.replace(/-/g, '')}`);
    lines.push(`DTEND;VALUE=DATE:${event.end.replace(/-/g, '')}`);
  } else {
    lines.push(`DTSTART:${compactUTC(event.start)}`, `DTEND:${compactUTC(event.end)}`);
  }
  if (event.timezone) lines.push(`X-HEARTH-TIMEZONE:${escapeText(event.timezone)}`);
  lines.push(`SUMMARY:${escapeText(event.title)}`);
  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  const body = lines.map(foldLine).join('\r\n') + '\r\n';
  if (Buffer.byteLength(body, 'utf8') > MAX_ICS_BYTES) fail('calendar_event_too_large');
  return body;
}

function unwrapResponse(input, now) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_source_feed');
  if (!Array.isArray(input.events)) fail('invalid_source_feed');
  if (input.complete != null && typeof input.complete !== 'boolean') fail('invalid_source_feed');
  if (input.status && !['complete', 'partial', 'error'].includes(input.status)) fail('invalid_source_feed');
  const feedComplete = input.complete === true && input.status !== 'partial' && input.status !== 'error';
  if (input.error) fail('source_feed_error');
  if (input.events.length > MAX_EVENTS) fail('too_many_source_events');
  const seen = new Set();
  const plans = input.events.map(raw => {
    const event = normalizeEvent(raw, feedComplete);
    if (seen.has(event.sourceId)) fail('duplicate_source_id');
    seen.add(event.sourceId);
    const hash = stableId(event.sourceId);
    const uid = `hearth-${hash}@hearth.local`;
    const resourceName = `hearth-${hash}.ics`;
    return {
      sourceId: event.sourceId,
      sourceMarker: event.sourceMarker,
      uid,
      href: resourceName,
      action: event.skipped ? 'skip' : event.cancelled ? 'cancel' : 'upsert',
      reason: event.skipped ? 'cancellation_requires_complete_feed' : undefined,
      calendarData: event.skipped ? '' : makeIcs(event, uid, now),
    };
  });
  return { feedComplete, plans };
}

function safeNow(value) {
  const now = value instanceof Date ? new Date(value) : new Date(value || Date.now());
  if (!Number.isFinite(now.getTime())) fail('invalid_sync_timestamp');
  return now;
}

export function planSync({ destinationURL, feed, events, now = new Date() } = {}) {
  const destination = selectedCalendarURL(destinationURL);
  const instant = safeNow(now);
  const sourceFeed = feed || { complete: false, events: events || [] };
  const { feedComplete, plans } = unwrapResponse(sourceFeed, instant);
  return {
    destinationURL: destination.href,
    feedComplete,
    operations: plans.map(plan => ({
      ...plan,
      targetURL: new URL(plan.href, destination).href,
      method: plan.action === 'skip' ? null : 'PUT',
      precondition: plan.action === 'cancel' ? 'If-Match: current-owned-ETag' : 'If-None-Match:* or If-Match: current-owned-ETag',
    })),
  };
}

function authHeader(credentials) {
  if (!credentials || typeof credentials.email !== 'string' || typeof credentials.password !== 'string'
      || !credentials.email || !credentials.password) fail('invalid_calendar_credentials');
  return `Basic ${Buffer.from(`${credentials.email}:${credentials.password}`, 'utf8').toString('base64')}`;
}

async function readLimited(res) {
  const length = Number(res.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await res.body?.cancel(); fail('calendar_sync_response_too_large');
  }
  if (!res.body) return '';
  const reader = res.body.getReader(), decoder = new TextDecoder();
  let bytes = 0, body = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { body += decoder.decode(); break; }
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) fail('calendar_sync_response_too_large');
      body += decoder.decode(value, { stream: true });
    }
  } finally { await reader.cancel(); }
  return body;
}

async function request(url, method, headers, body, fetcher, signal) {
  let target = selectedCalendarURLForResource(url);
  for (let redirects = 0; ; redirects++) {
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let res;
    try { res = await fetcher(target, { method, headers, body, redirect: 'manual', signal: requestSignal }); }
    catch { fail('calendar_sync_request_failed'); }
    if (![301, 302, 303, 307, 308].includes(res.status)) return res;
    const location = res.headers.get('location');
    await res.body?.cancel();
    if (!location || redirects >= MAX_REDIRECTS) fail('calendar_sync_redirect_failed');
    let next;
    try { next = appleURL(location, target); }
    catch { fail('untrusted_calendar_url'); }
    if (next.origin !== target.origin) fail('calendar_sync_cross_origin_redirect');
    target = next;
  }
}

function selectedCalendarURLForResource(value) {
  let url;
  try { url = appleURL(value); }
  catch (error) {
    if (error instanceof CalendarError) fail(error.code);
    fail('invalid_calendar_resource_url');
  }
  if (url.search || url.hash) fail('invalid_calendar_resource_url');
  return url;
}

function parseCalendarEvent(body) {
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) fail('invalid_calendar_resource');
  let root;
  try { root = new ICAL.Component(ICAL.parse(body)); }
  catch { fail('invalid_calendar_resource'); }
  const components = root.getAllSubcomponents('vevent');
  if (components.length !== 1) fail('invalid_calendar_resource');
  const component = components[0];
  const get = name => component.getFirstPropertyValue(name);
  const startProperty = component.getFirstProperty('dtstart'), endProperty = component.getFirstProperty('dtend');
  const start = startProperty?.getFirstValue(), end = endProperty?.getFirstValue();
  if (!start || !end) fail('invalid_calendar_resource');
  return {
    uid: get('uid') || '', sourceMarker: get('x-hearth-source') || '',
    status: String(get('status') || 'CONFIRMED').toUpperCase(),
    allDay: Boolean(start.isDate), start: start.toString(), end: end.toString(),
    timezone: get('x-hearth-timezone') || '',
    title: get('summary') || '(Untitled)', location: get('location') || '', description: get('description') || '',
  };
}

function semanticCalendarData(body) { return JSON.stringify(parseCalendarEvent(body)); }

function etagForUpdate(value) {
  const etag = String(value || '').trim();
  if (!etag || etag.startsWith('W/') || /[\r\n]/.test(etag)) fail('calendar_sync_missing_strong_etag');
  return etag;
}

async function getOwnedResource(url, headers, fetcher, signal, expected) {
  const res = await request(url, 'GET', headers, undefined, fetcher, signal);
  if (res.status === 404 || res.status === 410) { await res.body?.cancel(); return null; }
  if (!res.ok) { await res.body?.cancel(); fail(`calendar_sync_read_failed_${res.status}`, res.status); }
  const body = await readLimited(res);
  const remote = parseCalendarEvent(body);
  if (remote.uid !== expected.uid || remote.sourceMarker !== expected.sourceMarker) fail('calendar_sync_resource_collision');
  return { body, remote, etag: res.headers.get('etag') };
}

async function writeResource(url, plan, existing, headers, fetcher, signal) {
  const requestHeaders = {
    ...headers,
    'Content-Type': 'text/calendar; charset=utf-8',
  };
  if (existing) requestHeaders['If-Match'] = etagForUpdate(existing.etag);
  else requestHeaders['If-None-Match'] = '*';
  const response = await request(url, 'PUT', requestHeaders, plan.calendarData, fetcher, signal);
  if (response.status === 412) {
    await response.body?.cancel(); fail(existing ? 'calendar_sync_update_race' : 'calendar_sync_create_race', 412);
  }
  if (!response.ok) { await response.body?.cancel(); fail(`calendar_sync_write_failed_${response.status}`, response.status); }
  await response.body?.cancel();
  const verified = await getOwnedResource(url, headers, fetcher, signal, plan);
  if (!verified || semanticCalendarData(verified.body) !== semanticCalendarData(plan.calendarData)) fail('calendar_sync_readback_mismatch');
  return existing ? (plan.action === 'cancel' ? 'cancelled' : 'updated') : 'created';
}

export async function syncEvents({
  destinationURL, credentials, feed, events, now = new Date(), fetcher = fetch,
  signal = null,
} = {}) {
  if (typeof fetcher !== 'function') fail('invalid_calendar_fetcher');
  const plan = planSync({ destinationURL, feed, events, now });
  const auth = authHeader(credentials);
  const headers = { Authorization: auth, Accept: 'text/calendar' };
  const results = [];
  let requests = 0;
  for (const operation of plan.operations) {
    if (operation.action === 'skip') {
      results.push({ sourceId: operation.sourceId, uid: operation.uid, action: 'skipped', reason: operation.reason });
      continue;
    }
    if (++requests > MAX_EVENTS * 3) fail('too_many_calendar_sync_requests');
    const url = selectedCalendarURLForResource(operation.targetURL);
    const expected = { uid: operation.uid, sourceMarker: operation.sourceMarker };
    const existing = await getOwnedResource(url, headers, fetcher, signal, expected);
    if (operation.action === 'cancel' && !existing) {
      results.push({ sourceId: operation.sourceId, uid: operation.uid, action: 'missing' });
      continue;
    }
    if (existing && semanticCalendarData(existing.body) === semanticCalendarData(operation.calendarData)) {
      results.push({ sourceId: operation.sourceId, uid: operation.uid, action: operation.action === 'cancel' ? 'already_cancelled' : 'unchanged' });
      continue;
    }
    const action = await writeResource(url, operation, existing, headers, fetcher, signal);
    requests += 2;
    if (requests > MAX_EVENTS * 3) fail('too_many_calendar_sync_requests');
    results.push({ sourceId: operation.sourceId, uid: operation.uid, action });
  }
  return { destinationURL: plan.destinationURL, feedComplete: plan.feedComplete, results };
}
