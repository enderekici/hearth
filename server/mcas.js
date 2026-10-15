import { createHash } from 'node:crypto';
import { McasClient, McasError } from './mcas-client.js';

const TIME_ZONE = 'Europe/London';
const MESSAGE_LIMIT = 12_000;
const EVENT_LIMIT = 250;

export { McasError };

function fail(code) { throw new McasError(code); }

function civilDate(value) {
  if (typeof value !== 'string') return null;
  const date = value.slice(0, 10);
  if (!/^\d{4}-\d\d-\d\d$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
}

function addCivilDays(value, amount) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function dayDistance(from, to) {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

function weekday(value) { return new Date(`${value}T00:00:00.000Z`).getUTCDay(); }

function htmlText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p\s*>|<\/div\s*>|<\/li\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (entity, code) => {
      const point = Number(code);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
        && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : entity;
    })
    .replace(/[\t\r ]+/g, ' ').replace(/ *\n */g, '\n').trim().slice(0, maxLength);
}

function localTimeCandidates(date, time) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute, second = 0] = time.split(':').map(Number);
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const fieldsAt = instant => Object.fromEntries(formatter.formatToParts(instant)
    .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  const desired = { year, month, day, hour, minute, second };
  const offsets = new Set();
  for (let delta = -36; delta <= 36; delta += 6) {
    const instant = guess + delta * 3_600_000;
    const fields = fieldsAt(instant);
    offsets.add((Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second)
      - instant) / 60_000);
  }
  const matches = [];
  for (const offset of offsets) {
    const instant = guess - offset * 60_000;
    const actual = fieldsAt(instant);
    if (Object.keys(desired).every(key => actual[key] === desired[key])) matches.push({ instant, offset });
  }
  return matches;
}

function offsetSuffix(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

function localDateTime(value) {
  if (typeof value !== 'string') return null;
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/i.test(value)) {
    const instant = new Date(value);
    return Number.isFinite(instant.getTime()) ? instant.toISOString() : null;
  }
  const date = civilDate(value);
  const match = /T(\d\d:\d\d(?::\d\d)?)/.exec(value);
  if (!date || !match) return null;
  const time = match[1].length === 5 ? `${match[1]}:00` : match[1];
  const candidates = localTimeCandidates(date, time);
  if (candidates.length !== 1) return null;
  return `${date}T${time}${offsetSuffix(candidates[0].offset)}`;
}

function normalizeMessages(payload) {
  if (!Array.isArray(payload?.Table)) fail('mcas_messages_schema_invalid');
  const messages = [];
  for (const row of payload.Table) {
    if (!row || !Number.isFinite(Number(row.MessageID)) || typeof row.Message !== 'string'
        || typeof row.Subject !== 'string' || typeof row.Date !== 'string') fail('mcas_message_row_invalid');
    const receivedAt = localDateTime(row.Date);
    if (!receivedAt) fail('mcas_message_date_invalid');
    messages.push({ id: String(row.MessageID), subject: htmlText(row.Subject, 500),
      body: htmlText(row.Message, MESSAGE_LIMIT), sender: htmlText(String(row.Sender || ''), 300),
      receivedAt: new Date(receivedAt).toISOString(), isRead: row.IsRead === true,
      isSchoolMessage: row.IsSchoolMessage === true });
  }
  messages.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt) || a.id.localeCompare(b.id));
  return messages;
}

function normalizeAcademic(payload, scope) {
  if (!Array.isArray(payload?.Table) || payload.Table.length === 0 || !Array.isArray(payload?.Table1)) {
    fail('mcas_academic_schema_invalid');
  }
  const legend = new Map(payload.Table1.map(row => [String(row.DayStatusCode), String(row.DayStatusDescription || '')]));
  const rows = payload.Table.map(row => {
    const date = civilDate(row?.Day);
    if (!date || typeof row.DayStatusCode !== 'string' || !legend.has(row.DayStatusCode)
        || Number(row.Year) !== Number(date.slice(0, 4)) || Number(row.Month) !== Number(date.slice(5, 7))) {
      fail('mcas_academic_row_invalid');
    }
    return { date, code: row.DayStatusCode, description: String(row.DayStatusDescription || legend.get(row.DayStatusCode) || '') };
  }).sort((a, b) => a.date.localeCompare(b.date));
  if (new Set(rows.map(row => row.date)).size !== rows.length) fail('mcas_academic_duplicate_dates');

  const start = rows[0].date, end = rows.at(-1).date;
  let weekdays = 0;
  const rowByDate = new Map(rows.map(row => [row.date, row]));
  for (let date = start; date <= end; date = addCivilDays(date, 1)) {
    if ([1, 2, 3, 4, 5].includes(weekday(date))) {
      weekdays++;
      if (!rowByDate.has(date)) fail('mcas_academic_weekday_gap');
    }
  }
  if (weekdays !== rows.filter(row => [1, 2, 3, 4, 5].includes(weekday(row.date))).length) fail('mcas_academic_weekday_invalid');

  const ranges = [];
  let current = null;
  for (const row of rows) {
    if (row.code === '-') { current = null; continue; }
    if (current && current.code === row.code && dayDistance(current.last, row.date) <= 3) {
      current.last = row.date;
      if (row.description) current.description = row.description;
    } else {
      current = { code: row.code, description: `School: ${row.description || `Calendar status ${row.code}`}`,
        first: row.date, last: row.date };
      ranges.push(current);
    }
  }
  const events = ranges.map(range => ({
    sourceId: `${scope}:academic:${range.code}:${range.first}`,
    title: range.description,
    start: range.first,
    end: addCivilDays(range.last, 1),
    allDay: true,
    timeZone: TIME_ZONE,
    status: 'confirmed',
  }));
  return { events, complete: true, eventCount: events.length, window: { start, end } };
}

function sessionEvent(row, scope, type) {
  if (!row || !Number.isInteger(Number(row.ClubID)) || typeof row.ClubName !== 'string') return null;
  const date = civilDate(row.NextSession);
  const timeMatch = typeof row.StartTime === 'string' && /T(\d\d:\d\d(?::\d\d)?)/.exec(row.StartTime);
  const duration = Number(row.SessionLength);
  if (!date || !timeMatch || !Number.isFinite(duration) || duration <= 0 || duration > 24 * 60) return null;
  const time = timeMatch[1].length === 5 ? `${timeMatch[1]}:00` : timeMatch[1];
  if (+time.slice(0, 2) > 23 || +time.slice(3, 5) > 59 || +time.slice(6, 8) > 59) return null;
  const candidates = localTimeCandidates(date, time);
  if (candidates.length !== 1) return null;
  const start = `${date}T${time}${offsetSuffix(candidates[0].offset)}`;
  const end = new Date(new Date(start).getTime() + duration * 60_000).toISOString();
  if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end))) return null;
  return { sourceId: `${scope}:${type}:${Number(row.ClubID)}:${date}`, title: htmlText(row.ClubName, 500),
    start, end, allDay: false, timeZone: TIME_ZONE,
    ...(typeof row.Room === 'string' && row.Room.trim() ? { location: htmlText(row.Room, 300) } : {}),
    description: type === 'activities' ? 'Registered school trip or activity' : 'Registered after-school club',
    status: 'confirmed' };
}

function normalizeRegisteredRows(payload, scope) {
  if (!Array.isArray(payload?.Table)) fail('mcas_registered_schema_invalid');
  const events = { clubs: [], activities: [] };
  for (const row of payload.Table) {
    if (typeof row?.IsTrip !== 'boolean') fail('mcas_registered_row_invalid');
    const type = row.IsTrip ? 'activities' : 'clubs';
    const event = sessionEvent(row, scope, type);
    if (!event) fail('mcas_registered_session_invalid');
    events[type].push(event);
  }
  return events;
}

function studentScope(identity) {
  return createHash('sha256').update(`${identity.schoolID}:${identity.studentID}`).digest('hex').slice(0, 16);
}

async function attempt(operation) {
  try { return { value: await operation(), error: null }; }
  catch (error) { return { value: null, error: error instanceof McasError ? error : new McasError('mcas_source_failed') }; }
}

export async function readSchoolSnapshot(credentials, { fetcher = globalThis.fetch, now = new Date() } = {}) {
  const client = new McasClient({ fetcher });
  const identity = await client.login(credentials);
  const scope = `student-${studentScope(identity)}`;
  const [messageResult, academicResult, registeredResult] = await Promise.all([
    attempt(() => client.getMessages()),
    attempt(() => client.getAcademicCalendar()),
    attempt(() => client.getRegisteredClubs()),
  ]);
  const messageNormalization = messageResult.value
    ? await attempt(() => normalizeMessages(messageResult.value)) : messageResult;
  const messages = messageNormalization.value || [];
  const academic = academicResult.value ? await attempt(() => normalizeAcademic(academicResult.value, scope)) : academicResult;
  const registered = registeredResult.value ? await attempt(() => normalizeRegisteredRows(registeredResult.value, scope)) : registeredResult;
  const academicSource = { complete: Boolean(academic.value), eventCount: academic.value?.eventCount || 0,
    ...(academic.value?.window ? { window: academic.value.window } : {}), ...(academic.error ? { error: academic.error.code } : {}) };
  const activityCount = registered.value?.activities.length || 0;
  const clubCount = registered.value?.clubs.length || 0;
  const sources = {
    academic: academicSource,
    activities: { complete: Boolean(registered.value), eventCount: activityCount, coverage: 'registered_trips_only',
      ...(registered.error ? { error: registered.error.code } : {}) },
    clubs: { complete: Boolean(registered.value), eventCount: clubCount, coverage: 'registered_next_session_only',
      ...(registered.error ? { error: registered.error.code } : {}) },
  };
  const events = [...(academic.value?.events || []), ...(registered.value?.activities || []), ...(registered.value?.clubs || [])];
  if (events.length > EVENT_LIMIT) fail('mcas_too_many_events');
  const complete = Boolean(messageNormalization.value && academic.value && registered.value);
  return { connected: true, lastSuccess: new Date(now).toISOString(), messages, events,
    sourceCounts: { academic: academic.value?.eventCount || 0, activities: activityCount, clubs: clubCount },
    complete, sources, ...(messageNormalization.error ? { messageError: messageNormalization.error.code } : {}) };
}
