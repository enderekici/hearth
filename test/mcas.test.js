import test from 'node:test';
import assert from 'node:assert/strict';
import { readSchoolSnapshot } from '../server/mcas.js';

const credentials = { email: 'account@example.invalid', password: 'test-only' };

function academicRows() {
  const entries = [
    ['2026-08-31', '#', 'Holiday'], ['2026-09-01', '#', 'Holiday'],
    ['2026-09-02', '-', 'Normal Day'], ['2026-09-03', '-', 'Normal Day'],
    ['2026-09-04', '#', 'Holiday'], ['2026-09-07', '#', 'Holiday'],
  ];
  return entries.map(([day, code, description], index) => ({ Index: index + 1,
    Month: Number(day.slice(5, 7)), Year: Number(day.slice(0, 4)), Day: `${day}T00:00:00`,
    DayStatusCode: code, DayStatusDescription: description }));
}

function response(value, status = 200, headers = {}) {
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), { status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}

function dashboard() {
  return '<script>var schoolID = 123; var studentIDs = "456";</script>'
    + '<input id="123_789" name="userSelectorRadio" type="radio">';
}

function mockPortal({ clubs = [], messageDate = '2026-06-01T12:30:00', messageBody = '<p>Notice &amp; details</p>' } = {}) {
  const calls = [];
  const fetcher = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ path: url.pathname, method: init.method || 'GET', cookie: new Headers(init.headers).get('cookie') || '', body: init.body });
    if (url.pathname === '/MCAS/MCSParentLogin' && (init.method || 'GET') === 'GET') {
      return response('<input type="hidden" name="__VIEWSTATE" value="view-state">'
        + '<input name="EmailTextBox"><input name="PasswordTextBox">', 200,
      { 'set-cookie': 'ASP.NET_SessionId=private-session; Path=/; HttpOnly' });
    }
    if (url.pathname === '/MCAS/MCSParentLogin' && init.method === 'POST') {
      return response('', 302, { location: '/MCAS/MCSDashboardPage.aspx' });
    }
    if (url.pathname === '/MCAS/MCSDashboardPage.aspx') return response('', 301, { location: '/MCAS/MCSDashboardPage' });
    if (url.pathname === '/MCAS/MCSDashboardPage') return response(dashboard(), 200);
    if (url.pathname.endsWith('/CreateGetRequest')) {
      const request = JSON.parse(init.body);
      const payload = request.url.includes('/academiccalendar')
        ? { Table: academicRows(), Table1: [
          { DayStatusCode: '#', DayStatusDescription: 'Holiday' },
          { DayStatusCode: '$', DayStatusDescription: 'Staff Only' },
          { DayStatusCode: '-', DayStatusDescription: 'Normal Day' },
        ], Table2: [] }
        : request.url.includes('/StudentClubsAndTrips/') ? { Table: clubs }
          : { Table: [{ MessageID: 7, SenderID: 4, Sender: 'School', RecipientID: 5,
            Message: messageBody, Subject: 'Notice', IsRead: true,
            Date: messageDate, IsSchoolMessage: true }] };
      return response({ d: JSON.stringify(payload) });
    }
    throw new Error('unexpected mocked request');
  };
  return { fetcher, calls };
}

function registered({ id, trip, date, time, minutes = 60 }) {
  return { ClubID: id, ClubName: `Registered ${trip ? 'trip' : 'club'}`,
    IsTrip: trip, NextSession: `${date}T00:00:00`, StartTime: `${date}T${time}:00`,
    SessionLength: minutes, Room: 'Room 1' };
}

test('Node client logs in, keeps session cookies, and returns complete normalized sources', async () => {
  const { fetcher, calls } = mockPortal({ clubs: [
    registered({ id: 1, trip: true, date: '2026-07-10', time: '09:00' }),
    registered({ id: 2, trip: false, date: '2026-11-10', time: '09:00' }),
  ] });
  const result = await readSchoolSnapshot(credentials, { fetcher, now: new Date('2026-10-15T12:00:00Z') });
  assert.equal(result.complete, true);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].body, 'Notice & details');
  assert.equal(result.messages[0].receivedAt, '2026-06-01T11:30:00.000Z');
  assert.equal(result.sourceCounts.academic, 2);
  assert.equal(result.sourceCounts.activities, 1);
  assert.equal(result.sourceCounts.clubs, 1);
  assert.equal(result.events.length, 4);
  assert.deepEqual(result.sources.activities.coverage, 'registered_trips_only');
  assert.deepEqual(result.sources.clubs.coverage, 'registered_next_session_only');
  const holidayRanges = result.events.filter(event => event.allDay);
  assert.equal(holidayRanges[0].start, '2026-08-31');
  assert.equal(holidayRanges[0].end, '2026-09-02');
  assert.equal(holidayRanges[1].start, '2026-09-04');
  assert.equal(holidayRanges[1].end, '2026-09-08');
  assert.ok(result.events.every(event => event.status === 'confirmed'));
  const timed = result.events.filter(event => !event.allDay);
  assert.ok(timed.every(event => /(?:Z|[+-]\d\d:\d\d)$/.test(event.start) && /Z$/.test(event.end)));
  assert.equal(Date.parse(timed[0].end) - Date.parse(timed[0].start), 60 * 60_000);
  assert.equal(timed.find(event => event.sourceId.includes(':activities:1:')).start, '2026-07-10T09:00:00+01:00');
  assert.equal(timed.find(event => event.sourceId.includes(':clubs:2:')).start, '2026-11-10T09:00:00+00:00');
  assert.ok(calls.filter(call => call.path.endsWith('/CreateGetRequest')).every(call => call.cookie.includes('ASP.NET_SessionId=')));
});

test('source civil dates do not shift at local midnight and routine weekdays are not events', async () => {
  const { fetcher } = mockPortal();
  const result = await readSchoolSnapshot(credentials, { fetcher });
  const allDay = result.events.filter(event => event.allDay);
  assert.deepEqual(allDay.map(event => [event.start, event.end]), [
    ['2026-08-31', '2026-09-02'], ['2026-09-04', '2026-09-08'],
  ]);
  assert.equal(result.events.some(event => event.start === '2026-09-02'), false);
});

test('invalid spring DST local time fails the registered feed instead of rolling the session', async () => {
  const { fetcher } = mockPortal({ clubs: [registered({ id: 3, trip: true,
    date: '2026-03-29', time: '01:30', minutes: 60 })] });
  const result = await readSchoolSnapshot(credentials, { fetcher });
  assert.equal(result.sources.activities.complete, false);
  assert.equal(result.complete, false);
  assert.equal(result.events.some(event => event.sourceId.includes(':activities:3:')), false);
});

test('invalid message rows preserve valid calendar sources without reporting a complete snapshot', async () => {
  const { fetcher: base } = mockPortal();
  const fetcher = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/CreateGetRequest') && JSON.parse(init.body).url.includes('/findMessages/')) {
      return response({ d: JSON.stringify({ Table: [{ MessageID: 8, Message: '<p>Bad date</p>',
        Subject: 'Notice', Date: 'not-a-date' }] }) });
    }
    return base(input, init);
  };
  const result = await readSchoolSnapshot(credentials, { fetcher });
  assert.equal(result.complete, false);
  assert.equal(result.messageError, 'mcas_message_date_invalid');
  assert.equal(result.messages.length, 0);
  assert.equal(result.sources.academic.complete, true);
  assert.equal(result.events.filter(event => event.allDay).length, 2);
});

test('malformed numeric HTML entities remain text instead of throwing', async () => {
  const { fetcher } = mockPortal({ messageBody: '<p>Notice &#99999999;</p>' });
  const result = await readSchoolSnapshot(credentials, { fetcher });
  assert.equal(result.messages[0].body, 'Notice &#99999999;');
  assert.equal(result.complete, true);
});

test('multiple linked students fail closed before reading source feeds', async () => {
  let sourceRequests = 0;
  const { fetcher: base } = mockPortal();
  const fetcher = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/CreateGetRequest')) sourceRequests++;
    const result = await base(input, init);
    if (url.pathname === '/MCAS/MCSDashboardPage') {
      return response('<script>var schoolID = 123; var studentIDs = "456,457";</script>'
        + '<input id="123_789" name="userSelectorRadio" type="radio">');
    }
    return result;
  };
  await assert.rejects(readSchoolSnapshot(credentials, { fetcher }), error => error.code === 'mcas_multiple_students');
  assert.equal(sourceRequests, 0);
});
