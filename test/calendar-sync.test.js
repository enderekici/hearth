import test from 'node:test';
import assert from 'node:assert/strict';
import ICAL from 'ical.js';
import { planSync, syncEvents } from '../server/calendar-sync.js';

const destinationURL = 'https://p12-caldav.icloud.com/123456/calendars/family/';
const credentials = { email: 'family@example.test', password: 'private-app-password' };
const now = new Date('2026-10-15T10:00:00.000Z');
const event = (overrides = {}) => ({
  sourceId: 'student-event-42', title: 'Art, music; & tea',
  start: '2026-10-25T01:30:00+01:00', end: '2026-10-25T03:00:00Z', allDay: false,
  timeZone: 'Europe/London', location: 'Studio, east', description: 'Bring a notebook.\nAnd a pen.',
  sourceUpdatedAt: '2026-10-14T09:00:00Z', ...overrides,
});

function response(status, body = '', headers = {}) {
  return new Response([204, 205, 304].includes(status) ? null : body, { status, headers });
}

function eventIn(ics) {
  const root = new ICAL.Component(ICAL.parse(ics));
  return root.getFirstSubcomponent('vevent');
}

function unfold(ics) { return ics.replace(/\r\n[ \t]/g, ''); }

test('planSync makes stable owned identities and standards-shaped all-day and timed data', () => {
  const feed = { complete: true, events: [
    event({ sourceId: '学年-calendar-1', allDay: true, start: '2026-12-31', end: '2027-01-02', timeZone: 'Pacific/Kiritimati' }),
    event({ sourceId: 'long-title', title: '暮らし ' + 'é'.repeat(100), description: 'line one\nline two' }),
    event(),
  ] };
  const first = planSync({ destinationURL, feed, now });
  const second = planSync({ destinationURL, feed, now });
  assert.deepEqual(first, second);
  assert.equal(first.operations.length, 3);
  const [allDay, longText, timed] = first.operations;
  assert.match(allDay.uid, /^hearth-[a-f0-9]{64}@hearth\.local$/);
  assert.equal(allDay.uid, planSync({ destinationURL, feed: { complete: true, events: [feed.events[0]] }, now }).operations[0].uid);
  assert.match(allDay.calendarData, /DTSTART;VALUE=DATE:20261231\r\n/);
  assert.match(allDay.calendarData, /DTEND;VALUE=DATE:20270102\r\n/);
  assert.match(timed.calendarData, /DTSTART:20261025T003000Z\r\n/);
  assert.match(timed.calendarData, /DTEND:20261025T030000Z\r\n/);
  assert.match(timed.calendarData, /X-HEARTH-TIMEZONE:Europe\/London\r\n/);
  assert.match(timed.calendarData, /SUMMARY:Art\\, music\\; & tea\r\n/);
  assert.match(timed.calendarData, /DESCRIPTION:Bring a notebook\.\\nAnd a pen\.\r\n/);
  assert.match(unfold(longText.calendarData), /SUMMARY:暮らし é{100}\r\n/);
  for (const line of longText.calendarData.split('\r\n')) {
    if (line) assert.ok(Buffer.byteLength(line) <= 75, `folded output line exceeds 75 octets: ${Buffer.byteLength(line)}`);
  }
  assert.equal(eventIn(allDay.calendarData).getFirstProperty('dtend').getFirstValue().toString(), '2027-01-02');
});

test('create uses If-None-Match and verifies remote ownership and data by readback', async () => {
  const calls = [], resource = new Map();
  const fetcher = async (url, options) => {
    const target = new URL(url).href; calls.push({ target, ...options });
    const item = resource.get(target);
    if (options.method === 'GET') return item ? response(200, item.body, { etag: item.etag }) : response(404);
    if (options.method === 'PUT') {
      assert.equal(options.headers['If-None-Match'], '*');
      resource.set(target, { body: options.body, etag: '"v1"' });
      return response(201);
    }
    throw new Error('unexpected method');
  };
  const result = await syncEvents({ destinationURL, credentials, feed: { complete: true, events: [event()] }, now, fetcher });
  assert.equal(result.results[0].action, 'created');
  assert.deepEqual(calls.map(call => call.method), ['GET', 'PUT', 'GET']);
  assert.equal(calls[1].headers.Authorization, `Basic ${Buffer.from(`${credentials.email}:${credentials.password}`).toString('base64')}`);
  assert.match(calls[1].headers['Content-Type'], /^text\/calendar/);
  assert.ok(calls.every(call => call.signal instanceof AbortSignal && !call.signal.aborted));
  assert.equal(new Set(calls.map(call => call.signal)).size, 3, 'each HTTP leg has an independent request timeout');
  assert.doesNotMatch(JSON.stringify(result), /private-app-password|family@example\.test/);
});

test('repeat is unchanged and an owned edit uses If-Match with the observed ETag', async () => {
  const resource = new Map(), calls = [];
  const fetcher = async (url, options) => {
    const key = new URL(url).href; calls.push({ key, ...options });
    const old = resource.get(key);
    if (options.method === 'GET') return old ? response(200, old.body, { etag: old.etag }) : response(404);
    if (options.method === 'PUT') {
      if (options.headers['If-None-Match'] === '*' && old) return response(412);
      if (options.headers['If-Match'] && options.headers['If-Match'] !== old?.etag) return response(412);
      const version = Number(old?.etag?.match(/v(\d+)/)?.[1] || 0) + 1;
      resource.set(key, { body: options.body, etag: `"v${version}"` });
      return response(204);
    }
    throw new Error('unexpected method');
  };
  const original = { complete: true, events: [event()] };
  assert.equal((await syncEvents({ destinationURL, credentials, feed: original, now, fetcher })).results[0].action, 'created');
  const beforeRepeat = calls.length;
  assert.equal((await syncEvents({ destinationURL, credentials, feed: original, now, fetcher })).results[0].action, 'unchanged');
  assert.equal(calls.length, beforeRepeat + 1);
  const changed = { complete: true, events: [event({ title: 'A new title' })] };
  assert.equal((await syncEvents({ destinationURL, credentials, feed: changed, now, fetcher })).results[0].action, 'updated');
  const write = calls.filter(call => call.method === 'PUT').at(-1);
  assert.equal(write.headers['If-Match'], '"v1"');
  assert.match(write.body, /SUMMARY:A new title\r\n/);
});

test('foreign collision and create/update races fail closed without overwrite retries', async () => {
  let writes = 0;
  const foreign = planSync({ destinationURL, feed: { complete: true, events: [event()] }, now }).operations[0];
  const foreignBody = foreign.calendarData.replace(foreign.uid, 'foreign@example.test').replace(foreign.sourceMarker, 'other:foreign');
  await assert.rejects(() => syncEvents({ destinationURL, credentials, feed: { complete: true, events: [event()] }, now,
    fetcher: async (url, options) => options.method === 'GET' ? response(200, foreignBody, { etag: '"other"' }) : (++writes, response(200)) }),
  { code: 'calendar_sync_resource_collision' });
  assert.equal(writes, 0);

  await assert.rejects(() => syncEvents({ destinationURL, credentials, feed: { complete: true, events: [event({ title: 'Update desired' })] }, now,
    fetcher: async (_url, options) => options.method === 'GET' ? response(404) : (++writes, response(412)) }),
  { code: 'calendar_sync_create_race' });
  assert.equal(writes, 1);

  await assert.rejects(() => syncEvents({ destinationURL, credentials, feed: { complete: true, events: [event({ title: 'Update desired' })] }, now,
    fetcher: async (_url, options) => options.method === 'GET' ? response(200, foreign.calendarData, { etag: '"v1"' }) : (++writes, response(412)) }),
  { code: 'calendar_sync_update_race' });
  assert.equal(writes, 2);
});

test('cancellation requires a complete feed and only updates an existing owned event', async () => {
  const cancelledEvent = event({ status: 'cancelled' });
  const partialPlan = planSync({ destinationURL, feed: { complete: false, events: [cancelledEvent] }, now });
  assert.equal(partialPlan.operations[0].action, 'skip');
  let calls = 0;
  const skipped = await syncEvents({ destinationURL, credentials, feed: { complete: false, events: [cancelledEvent] }, now,
    fetcher: async () => { calls++; return response(200); } });
  assert.equal(skipped.results[0].action, 'skipped');
  assert.equal(calls, 0);
  const missing = await syncEvents({ destinationURL, credentials, feed: { complete: true, events: [cancelledEvent] }, now,
    fetcher: async () => { calls++; return response(404); } });
  assert.equal(missing.results[0].action, 'missing');
  assert.equal(calls, 1);
  const owned = planSync({ destinationURL, feed: { complete: true, events: [event()] }, now }).operations[0];
  const live = { body: owned.calendarData, etag: '"v7"' }, writes = [];
  const cancelled = await syncEvents({ destinationURL, credentials, feed: { complete: true, events: [cancelledEvent] }, now,
    fetcher: async (_url, options) => {
      if (options.method === 'GET') return response(200, live.body, { etag: live.etag });
      writes.push(options);
      live.body = options.body; live.etag = '"v8"';
      return response(204);
    } });
  assert.equal(cancelled.results[0].action, 'cancelled');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].headers['If-Match'], '"v7"');
  assert.match(writes[0].body, /STATUS:CANCELLED\r\n/);
  assert.doesNotMatch(writes[0].method, /DELETE/);
});

test('empty, errored, incomplete and duplicate feeds never trigger destructive reconciliation', async () => {
  for (const feed of [
    { complete: false, events: [] },
    { complete: true, status: 'partial', events: [] },
  ]) {
    const plan = planSync({ destinationURL, feed, now });
    assert.deepEqual(plan.operations, []);
  }
  assert.throws(() => planSync({ destinationURL, feed: { complete: true, error: 'upstream unavailable', events: [] }, now }),
    { code: 'source_feed_error' });
  assert.throws(() => planSync({ destinationURL, feed: { complete: true, events: [event(), event()] }, now }),
    { code: 'duplicate_source_id' });
});

test('Apple URL validation and same-origin redirects prevent credential forwarding', async () => {
  assert.throws(() => planSync({ destinationURL: 'https://evil.example/calendar/', feed: { complete: true, events: [] }, now }),
    { code: 'untrusted_calendar_url' });
  assert.throws(() => planSync({ destinationURL: 'https://p12-caldav.icloud.com/calendars/family?x=1', feed: { complete: true, events: [] }, now }),
    { code: 'invalid_destination_calendar' });
  const requested = [];
  await assert.rejects(() => syncEvents({ destinationURL, credentials, feed: { complete: true, events: [event()] }, now,
    fetcher: async (url, options) => {
      requested.push({ url: new URL(url).href, authorization: options.headers.Authorization });
      return response(302, '', { location: 'https://attacker.example/collect' });
    } }), { code: 'untrusted_calendar_url' });
  assert.equal(requested.length, 1);
  assert.equal(new URL(requested[0].url).hostname, 'p12-caldav.icloud.com');
  assert.match(requested[0].authorization, /^Basic /);
});

test('missing ETags, oversized resources, failed readback and network errors fail closed', async () => {
  const original = planSync({ destinationURL, feed: { complete: true, events: [event()] }, now }).operations[0];
  let puts = 0;
  await assert.rejects(() => syncEvents({ destinationURL, credentials,
    feed: { complete: true, events: [event({ title: 'Changed' })] }, now,
    fetcher: async (_url, options) => options.method === 'GET'
      ? response(200, original.calendarData)
      : (++puts, response(204)) }),
  { code: 'calendar_sync_missing_strong_etag' });
  assert.equal(puts, 0);

  await assert.rejects(() => syncEvents({ destinationURL, credentials, feed: { complete: true, events: [event()] }, now,
    fetcher: async () => response(200, 'x'.repeat(512 * 1024 + 1), { 'Content-Length': String(512 * 1024 + 1) }) }),
  { code: 'calendar_sync_response_too_large' });

  let readCount = 0;
  await assert.rejects(() => syncEvents({ destinationURL, credentials,
    feed: { complete: true, events: [event({ title: 'Changed' })] }, now,
    fetcher: async (_url, options) => {
      if (options.method === 'GET') { readCount++; return response(200, original.calendarData, { etag: '"v1"' }); }
      puts++; return response(204);
    } }), { code: 'calendar_sync_readback_mismatch' });
  assert.equal(readCount, 2);

  await assert.rejects(() => syncEvents({ destinationURL, credentials, feed: { complete: true, events: [event()] }, now,
    fetcher: async () => { throw new Error(`${credentials.email} ${credentials.password}`); } }), error => {
    assert.equal(error.code, 'calendar_sync_request_failed');
    assert.doesNotMatch(error.message, /family@example\.test|private-app-password/);
    return true;
  });
});

test('source validation rejects floating times, invalid zones, reversed intervals and oversized feeds', () => {
  const invalid = [
    event({ start: '2026-10-25T01:30:00', end: '2026-10-25T02:30:00Z' }),
    event({ timeZone: 'Mars/Nope' }),
    event({ start: '2026-10-25T03:00:00Z', end: '2026-10-25T02:00:00Z' }),
    event({ allDay: true, start: '2026-02-30', end: '2026-03-01' }),
    event({ recurrence: 'FREQ=WEEKLY' }),
  ];
  for (const item of invalid) assert.throws(() => planSync({ destinationURL, feed: { complete: true, events: [item] }, now }));
  assert.throws(() => planSync({ destinationURL, feed: { complete: true,
    events: [event({ recurrence: 'FREQ=WEEKLY' })] }, now }), { code: 'unsupported_source_recurrence' });
  const many = Array.from({ length: 251 }, (_, index) => event({ sourceId: String(index) }));
  assert.throws(() => planSync({ destinationURL, feed: { complete: true, events: many }, now }),
    { code: 'too_many_source_events' });
});
