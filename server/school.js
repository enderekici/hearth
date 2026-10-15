import fs from 'node:fs/promises';
import fsNative from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir, loadConfig } from './config.js';
import { planSync, syncEvents } from './calendar-sync.js';

const CREDENTIALS_PATH = path.join(dataDir, 'mcas-credentials.json');
const SNAPSHOT_PATH = path.join(dataDir, 'school-snapshot.json');
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const POLL_INTERVAL_MS = 15 * 60_000;
const PAGE_MAX = 100;
let state = emptyState();
let loaded = false;
let configured = false;
let refreshPromise = null;
let pollTimer = null;

function emptyState() {
  return { connected: false, complete: false, messages: [], events: [], sourceCounts: { academic: null, activities: null, clubs: null },
    lastSuccess: null, lastAttemptAt: null, error: null,
    calendar: { lastSyncAt: null, counts: { created: 0, updated: 0, unchanged: 0 }, sourceCounts: { academic: null, activities: null, clubs: null }, error: null },
    ownedTracking: [] };
}

function stableError(error, fallback = 'school_refresh_failed') {
  const value = String(error?.code || '');
  return /^[a-z0-9_-]{1,100}$/i.test(value) ? value : fallback;
}

function isPrivateMode(mode) { return (mode & 0o077) === 0; }

async function readPrivateJson(filename) {
  let handle;
  try {
    handle = await fs.open(filename, fsNative.constants.O_RDONLY | (fsNative.constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || !isPrivateMode(stat.mode)) throw Object.assign(new Error('school_private_file_permissions'), { code: 'school_private_file_permissions' });
    if (stat.size > MAX_SNAPSHOT_BYTES) throw Object.assign(new Error('school_private_file_too_large'), { code: 'school_private_file_too_large' });
    return JSON.parse(await handle.readFile('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally { await handle?.close(); }
}

export async function loadSchoolCredentials(filename = CREDENTIALS_PATH) {
  const record = await readPrivateJson(filename);
  if (!record) return null;
  const credentials = record.credentials;
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)
      || !Object.entries(credentials).every(([key, value]) => ['username', 'email', 'password'].includes(key)
        && typeof value === 'string' && value.length > 0 && value.length <= 512)
      || !Object.hasOwn(credentials, 'password')
      || !(Object.hasOwn(credentials, 'username') || Object.hasOwn(credentials, 'email'))) {
    throw Object.assign(new Error('invalid_school_credentials'), { code: 'invalid_school_credentials' });
  }
  const destination = record.calendarDestinationURL;
  if (destination != null && (typeof destination !== 'string' || destination.length > 2048)) {
    throw Object.assign(new Error('invalid_school_calendar_destination'), { code: 'invalid_school_calendar_destination' });
  }
  return { credentials: { ...credentials }, calendarDestinationURL: destination || '' };
}

function validSnapshot(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Array.isArray(value.messages) && Array.isArray(value.events)
    && value.sourceCounts && typeof value.sourceCounts === 'object'
    && value.calendar && typeof value.calendar === 'object';
}

export async function loadSchoolCache(filename = SNAPSHOT_PATH) {
  const saved = await readPrivateJson(filename);
  if (!saved) { state = emptyState(); loaded = true; return schoolState(); }
  if (!validSnapshot(saved)) throw Object.assign(new Error('invalid_school_snapshot'), { code: 'invalid_school_snapshot' });
  state = { ...emptyState(), ...saved, calendar: { ...emptyState().calendar, ...saved.calendar,
    counts: { ...emptyState().calendar.counts, ...(saved.calendar.counts || {}) } } };
  loaded = true;
  return schoolState();
}

async function saveSchoolCache(value, filename = SNAPSHOT_PATH) {
  const body = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(body) > MAX_SNAPSHOT_BYTES) throw Object.assign(new Error('school_snapshot_too_large'), { code: 'school_snapshot_too_large' });
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(filename), 0o700);
  const temporary = filename + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(body, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temporary, filename);
  await fs.chmod(filename, 0o600);
  const directory = await fs.open(path.dirname(filename), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

function boundedCount(value) { return Number.isInteger(value) && value >= 0 ? value : 0; }
function knownCount(value) { return Number.isInteger(value) && value >= 0 ? value : null; }
function validTime(value, fallback) {
  const date = value ? new Date(value) : fallback;
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback.toISOString();
}

function snapshotStatus() {
  const messages = state.messages.length;
  const unread = state.messages.filter(message => message.isRead === false).length;
  return { configured, connected: state.connected, syncing: Boolean(refreshPromise), lastSuccess: state.lastSuccess, error: state.error,
    sources: state.sources || {},
    calendar: { lastSyncAt: state.calendar.lastSyncAt, counts: state.calendar.counts,
      sourceCounts: state.calendar.sourceCounts, error: state.calendar.error },
    counts: { messages, unread } };
}

export function schoolState() {
  return structuredClone(state);
}

export function schoolStatus() {
  return structuredClone(snapshotStatus());
}

export function listSchoolMessages(input = {}) {
  const limit = input.limit === undefined ? 30 : Number(input.limit);
  const offset = input.offset === undefined ? 0 : Number(input.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX
      || !Number.isInteger(offset) || offset < 0 || offset > 10_000) {
    throw Object.assign(new Error('invalid_school_page'), { status: 400, code: 'invalid_school_page' });
  }
  const total = state.messages.length;
  const items = state.messages.slice(offset, offset + limit);
  return { items, total, limit, offset, nextOffset: offset + items.length < total ? offset + items.length : null };
}

async function defaultReadSnapshot(credentials, options) {
  const adapter = await import('./mcas.js');
  if (typeof adapter.readSchoolSnapshot !== 'function') throw Object.assign(new Error('school_source_unavailable'), { code: 'school_source_unavailable' });
  return adapter.readSchoolSnapshot(credentials, options);
}

function normalizeSourceCounts(value = {}) {
  return { academic: knownCount(value.academic), activities: knownCount(value.activities), clubs: knownCount(value.clubs) };
}

function snapshotSourceCounts(source) {
  const counts = normalizeSourceCounts(source.sourceCounts);
  if (source.sources && typeof source.sources === 'object') {
    for (const key of ['academic', 'activities', 'clubs']) {
      if (source.sources[key]?.complete !== true) counts[key] = null;
    }
  }
  return counts;
}

function snapshotFailureCode(source) {
  if (source?.messageError) return stableError({ code: source.messageError }, 'school_snapshot_incomplete');
  for (const key of ['academic', 'activities', 'clubs']) {
    const failure = source?.sources?.[key]?.error;
    if (failure) return stableError({ code: failure }, 'school_snapshot_incomplete');
  }
  return 'school_snapshot_incomplete';
}

function calendarCounts(results = []) {
  const counts = { created: 0, updated: 0, unchanged: 0 };
  for (const result of results) {
    if (result.action === 'created') counts.created++;
    else if (['updated', 'cancelled'].includes(result.action)) counts.updated++;
    else if (['unchanged', 'already_cancelled'].includes(result.action)) counts.unchanged++;
  }
  return counts;
}

async function refresh(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  if (!loaded) await loadSchoolCache(options.snapshotPath || SNAPSHOT_PATH);
  let setup;
  try {
    setup = await (options.readCredentials || loadSchoolCredentials)(options.credentialsPath || CREDENTIALS_PATH);
  } catch (error) {
    configured = false;
    state = { ...state, lastAttemptAt: now.toISOString(), error: stableError(error), connected: false };
    await (options.saveCache || saveSchoolCache)(state, options.snapshotPath || SNAPSHOT_PATH);
    return schoolStatus();
  }
  configured = Boolean(setup?.credentials);
  if (!configured) {
    state = { ...state, lastAttemptAt: now.toISOString(), error: null, connected: false };
    return schoolStatus();
  }

  state = { ...state, lastAttemptAt: now.toISOString(), error: null };
  let sourceReceived = false;
  try {
    const source = await (options.readSnapshot || defaultReadSnapshot)(setup.credentials,
      { now, fetcher: options.fetcher });
    const allSourcesComplete = !source?.sources || ['academic', 'activities', 'clubs']
      .every(key => source.sources[key]?.complete === true);
    if (!source || source.complete !== true || !allSourcesComplete
        || !Array.isArray(source.messages) || !Array.isArray(source.events)) {
      configured = true;
      state = { ...state, connected: Boolean(source?.connected),
        ...(Array.isArray(source?.messages) && !source?.messageError
          ? { messages: source.messages.slice(0, 1000), messagesUpdatedAt: validTime(source.lastSuccess, now) } : {}),
        ...(source?.sources && typeof source.sources === 'object' ? { sources: source.sources } : {}),
        ...(source?.sourceCounts ? { sourceCounts: snapshotSourceCounts(source),
          calendar: { ...state.calendar, sourceCounts: snapshotSourceCounts(source) } } : {}),
        lastAttemptAt: now.toISOString(),
        error: snapshotFailureCode(source) };
      state.calendar = { ...state.calendar, error: state.error };
      await (options.saveCache || saveSchoolCache)(state, options.snapshotPath || SNAPSHOT_PATH);
      return schoolStatus();
    }
    const successfulAt = validTime(source.lastSuccess, now);
    sourceReceived = true;
    const newState = { ...state, connected: true, complete: true, error: null, lastAttemptAt: now.toISOString(),
      lastSuccess: successfulAt, messages: source.messages.slice(0, 1000), events: source.events.slice(0, 250),
      sourceCounts: snapshotSourceCounts(source),
      sources: source.sources && typeof source.sources === 'object' ? source.sources : {},
      ownedTracking: state.ownedTracking || [],
      calendar: { ...state.calendar, sourceCounts: snapshotSourceCounts(source), error: null } };
    state = newState;

    const config = await (options.readConfig || loadConfig)();
    if (setup.calendarDestinationURL && config.icloud) {
      const feed = { complete: true, events: source.events };
      const plan = (options.planSync || planSync)({ destinationURL: setup.calendarDestinationURL,
        credentials: config.icloud, feed, now });
      const planned = plan.operations.reduce((counts, operation) => {
        counts[operation.action] = (counts[operation.action] || 0) + 1;
        return counts;
      }, {});
      const outcome = await (options.syncEvents || syncEvents)({ destinationURL: setup.calendarDestinationURL,
        credentials: config.icloud, feed, now, fetcher: options.calendarFetcher });
      const counts = calendarCounts(outcome.results);
      state = { ...state, calendar: { lastSyncAt: now.toISOString(), counts,
        sourceCounts: snapshotSourceCounts(source), error: null },
        ownedTracking: outcome.results.filter(item => item.action !== 'missing').map(item => ({ sourceId: item.sourceId, uid: item.uid })) };
      state.lastCalendarPlanCounts = { upsert: boundedCount(planned.upsert), cancel: boundedCount(planned.cancel), skip: boundedCount(planned.skip) };
      if (outcome.results.some(item => ['created', 'updated', 'cancelled'].includes(item.action))) {
        options.onCalendarChanged?.();
      }
    } else {
      state = { ...state, calendar: { ...state.calendar, error: 'school_calendar_not_configured' } };
    }
  } catch (error) {
    const code = stableError(error);
    if (sourceReceived) {
      state = { ...state, calendar: { ...state.calendar, error: code } };
    } else {
      state = { ...state, connected: false, error: code };
    }
  }
  await (options.saveCache || saveSchoolCache)(state, options.snapshotPath || SNAPSHOT_PATH);
  return schoolStatus();
}

export function runSchoolRefresh(options = {}) {
  if (refreshPromise) return refreshPromise;
  refreshPromise = refresh(options).catch(error => {
    state = { ...state, connected: false, lastAttemptAt: new Date().toISOString(), error: stableError(error) };
    return schoolStatus();
  }).finally(() => { refreshPromise = null; });
  return refreshPromise;
}

export function beginSchoolRefresh(options = {}) {
  if (refreshPromise) return false;
  void runSchoolRefresh(options);
  return true;
}

export async function initializeSchool(options = {}) {
  if (!loaded) {
    try { await loadSchoolCache(options.snapshotPath || SNAPSHOT_PATH); }
    catch (error) { state = { ...emptyState(), error: stableError(error) }; loaded = true; }
  }
  try { configured = Boolean(await (options.readCredentials || loadSchoolCredentials)(options.credentialsPath || CREDENTIALS_PATH)); }
  catch { configured = false; }
  return schoolStatus();
}

export async function startSchoolPolling(options = {}) {
  await initializeSchool(options);
  if (!configured) return false;
  if (pollTimer) clearInterval(pollTimer);
  void runSchoolRefresh(options);
  pollTimer = setInterval(() => { void runSchoolRefresh(options); }, options.intervalMs || POLL_INTERVAL_MS);
  pollTimer.unref?.();
  return true;
}

export function stopSchoolPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}
