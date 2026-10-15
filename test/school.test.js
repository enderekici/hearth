import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hearth-school-'));
process.env.DATA_DIR = path.join(root, 'data');
const school = await import('../server/school.js');
const { dataDir } = await import('../server/config.js');
await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });

const credentialPath = path.join(dataDir, 'mcas-credentials.json');
const snapshotPath = path.join(dataDir, 'school-snapshot.json');
const secret = 'private-fixture-password';
const credentials = { username: 'fixture@example.test', password: secret };
const destinationURL = 'https://p12-caldav.icloud.com/123456789/calendars/family/';
const messages = [
  { id: 'mail-1', subject: 'School note', body: 'Private body', sender: 'Teacher', receivedAt: '2026-10-14T10:00:00Z', isRead: false, isSchoolMessage: true },
  { id: 'mail-2', subject: 'Old note', body: 'Older private body', sender: 'School', receivedAt: '2026-10-13T10:00:00Z', isRead: true, isSchoolMessage: true },
];
const events = [{ sourceId: 'class-1', title: 'Term event', allDay: true,
  start: '2026-11-02', end: '2026-11-03', timeZone: 'Europe/London' }];
const completeSnapshot = { connected: true, complete: true, lastSuccess: '2026-10-15T08:00:00.000Z',
  messages, events, sourceCounts: { academic: 1, activities: 0, clubs: 1 },
  sources: { academic: { complete: true, eventCount: 1 }, activities: { complete: true, eventCount: 0 }, clubs: { complete: true, eventCount: 0 } } };

test('private school cache keeps last complete data, skips partial feeds, serializes refreshes and paginates locally', async () => {
  await fs.writeFile(credentialPath, JSON.stringify({ credentials, calendarDestinationURL: destinationURL }), { mode: 0o600 });
  await fs.chmod(credentialPath, 0o600);
  const loaded = await school.loadSchoolCredentials(credentialPath);
  assert.deepEqual(loaded, { credentials, calendarDestinationURL: destinationURL });
  assert.equal((await fs.stat(credentialPath)).mode & 0o777, 0o600);

  const setup = async () => loaded;
  await school.initializeSchool({ credentialsPath: credentialPath, snapshotPath });
  let writerCalls = 0, planCalls = 0;
  const saved = await school.runSchoolRefresh({ credentialsPath: credentialPath, snapshotPath,
    readCredentials: setup, readConfig: async () => ({ icloud: { email: 'apple@example.test', password: 'abcd-efgh-ijkl-mnop' } }),
    readSnapshot: async () => structuredClone(completeSnapshot),
    planSync: input => { planCalls++; assert.deepEqual(input.feed.events, events); return { operations: [{ action: 'upsert' }] }; },
    syncEvents: async input => { writerCalls++; assert.equal(input.destinationURL, destinationURL);
      return { results: [{ sourceId: 'class-1', uid: 'hearth-fixture@hearth.local', action: 'created' }] }; },
    now: new Date('2026-10-15T08:05:00.000Z') });
  assert.equal(saved.connected, true);
  assert.equal(saved.lastSuccess, completeSnapshot.lastSuccess);
  assert.deepEqual(saved.counts, { messages: 2, unread: 1 });
  assert.deepEqual(saved.calendar.counts, { created: 1, updated: 0, unchanged: 0 });
  assert.equal(planCalls, 1);
  assert.equal(writerCalls, 1);
  const cached = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
  assert.equal((await fs.stat(snapshotPath)).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(cached).includes(secret), false);

  const page = school.listSchoolMessages({ limit: 1, offset: 1 });
  assert.equal(page.items[0].id, 'mail-2');
  assert.equal(page.total, 2);
  assert.equal(page.nextOffset, null);
  assert.throws(() => school.listSchoolMessages({ limit: 101 }), { code: 'invalid_school_page' });

  const messageFailure = await school.runSchoolRefresh({ credentialsPath: credentialPath, snapshotPath,
    readCredentials: setup, readSnapshot: async () => ({ ...completeSnapshot, complete: false,
      messages: [], messageError: 'mcas_message_date_invalid' }),
    syncEvents: async () => { writerCalls++; throw new Error('incomplete feed must not write'); },
    now: new Date('2026-10-15T08:07:00.000Z') });
  assert.equal(messageFailure.error, 'mcas_message_date_invalid');
  assert.equal(messageFailure.calendar.error, 'mcas_message_date_invalid');
  assert.equal(school.schoolStatus().counts.messages, 2);
  assert.equal(school.listSchoolMessages({}).items[0].id, 'mail-1');
  assert.equal(writerCalls, 1);

  const partial = await school.runSchoolRefresh({ credentialsPath: credentialPath, snapshotPath,
    readCredentials: setup, readSnapshot: async () => ({ ...completeSnapshot, complete: false,
      events: [], messages: [{ ...messages[0], id: 'mail-new' }],
      sourceCounts: { academic: 0, activities: 0, clubs: 0 },
      sources: { academic: { complete: true }, activities: { complete: false, error: 'mcas_activities_unavailable' }, clubs: { complete: true } } }),
    syncEvents: async () => { writerCalls++; throw new Error('partial feed must not write'); },
    now: new Date('2026-10-15T08:10:00.000Z') });
  assert.equal(partial.error, 'mcas_activities_unavailable');
  assert.equal(partial.sources.activities.complete, false);
  assert.equal(partial.lastSuccess, completeSnapshot.lastSuccess);
  assert.deepEqual(school.listSchoolMessages({}).items.map(item => item.id), ['mail-new']);
  assert.equal(school.schoolState().events[0].sourceId, 'class-1');
  assert.equal(writerCalls, 1);

  const failed = await school.runSchoolRefresh({ credentialsPath: credentialPath, snapshotPath,
    readCredentials: setup, readSnapshot: async () => { throw Object.assign(new Error(secret), { code: 'mcas_network_unavailable' }); },
    now: new Date('2026-10-15T08:15:00.000Z') });
  assert.equal(failed.error, 'mcas_network_unavailable');
  assert.equal(JSON.stringify(school.schoolState()).includes(secret), false);
  assert.equal(failed.lastSuccess, completeSnapshot.lastSuccess);
  const restored = await school.loadSchoolCache(snapshotPath);
  assert.equal(restored.messages.length, 1);
  assert.deepEqual(school.schoolStatus().counts, { messages: 1, unread: 1 });
});

test('only one upstream refresh can run at a time', async () => {
  let finish, reads = 0;
  const blocked = new Promise(resolve => { finish = resolve; });
  const options = { credentialsPath: credentialPath, snapshotPath, readCredentials: async () => ({ credentials }),
    readSnapshot: async () => { reads++; await blocked; return structuredClone(completeSnapshot); },
    readConfig: async () => ({ icloud: null }), now: new Date('2026-10-15T09:00:00.000Z') };
  const first = school.runSchoolRefresh(options);
  const second = school.runSchoolRefresh(options);
  assert.equal(first, second);
  for (let attempt = 0; attempt < 20 && reads === 0; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(reads, 1);
  finish();
  await first;
  assert.equal(reads, 1);
});

test('school HTTP routes return cached data and keep sync writes local-origin guarded', async () => {
  await fs.rm(credentialPath, { force: true });
  await school.initializeSchool({ credentialsPath: credentialPath, snapshotPath });
  const { createServer } = await import('../server/index.js');
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = (route, { method = 'GET', host, origin, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: route, method, headers: { ...(host ? { Host: host } : {}), ...(origin ? { Origin: origin } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
  try {
    const status = await request('/api/school');
    assert.equal(status.status, 200);
    assert.equal(status.body.configured, false);
    assert.equal(status.body.syncing, false);
    const page = await request('/api/school/messages?limit=1&offset=0');
    assert.equal(page.status, 200);
    assert.equal(page.body.items[0].id, 'mail-1');
    const badPage = await request('/api/school/messages?limit=1&limit=2');
    assert.equal(badPage.status, 400);
    const badOrigin = await request('/api/school/sync', { method: 'POST', host: '127.0.0.1:' + server.address().port,
      origin: 'http://evil.example', body: {} });
    assert.equal(badOrigin.status, 403);
    const notConfigured = await request('/api/school/sync', { method: 'POST', host: '127.0.0.1:' + server.address().port,
      origin: 'http://127.0.0.1:' + server.address().port, body: {} });
    assert.equal(notConfigured.status, 409);
    assert.equal(notConfigured.body.error, 'school_not_configured');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
