const ORIGIN = 'https://www.mychildatschool.com';
const LOGIN_URL = `${ORIGIN}/MCAS/MCSParentLogin`;
const DASHBOARD_URL = `${ORIGIN}/MCAS/MCSDashboardPage`;
const PROXY_URL = `${ORIGIN}/MCAS/WebServices/MCSAPIRequestProxy.asmx/CreateGetRequest`;
const MAX_REDIRECTS = 6;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export class McasError extends Error {
  constructor(code) {
    super(code);
    this.name = 'McasError';
    this.code = code;
  }
}

function fail(code) { throw new McasError(code); }

function decodeHtml(value) {
  return value.replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function attributes(tag) {
  const values = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)) {
    values[match[1].toLowerCase()] = decodeHtml(match[3]);
  }
  return values;
}

function mergeSetCookies(headers, jar) {
  const values = headers.getSetCookie?.() || (headers.get('set-cookie') ? [headers.get('set-cookie')] : []);
  for (const item of values) {
    const pair = item.split(';', 1)[0];
    const delimiter = pair.indexOf('=');
    if (delimiter > 0) jar.set(pair.slice(0, delimiter), pair.slice(delimiter + 1));
  }
}

function unwrap(value) {
  let result = value;
  for (let i = 0; i < 2 && typeof result === 'string'; i++) {
    try { result = JSON.parse(result); } catch { break; }
  }
  return result;
}

async function readLimitedText(response) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) fail('mcas_response_too_large');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { text += decoder.decode(); return text; }
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) fail('mcas_response_too_large');
      text += decoder.decode(value, { stream: true });
    }
  } finally { await reader.cancel(); }
}

export class McasClient {
  constructor({ fetcher = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    if (typeof fetcher !== 'function') fail('mcas_fetch_unavailable');
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
    this.cookies = new Map();
    this.identity = null;
  }

  async request(url, init = {}) {
    let target = new URL(url, ORIGIN);
    if (target.origin !== ORIGIN) fail('mcas_untrusted_redirect');
    let method = init.method || 'GET';
    let body = init.body;
    const headers = new Headers(init.headers || {});
    for (let redirects = 0; ; redirects++) {
      if (this.cookies.size) headers.set('cookie', [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '));
      let response;
      try {
        response = await this.fetcher(target, { method, body, headers, redirect: 'manual',
          signal: AbortSignal.timeout(this.timeoutMs) });
      } catch {
        fail('mcas_request_failed');
      }
      mergeSetCookies(response.headers, this.cookies);
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects >= MAX_REDIRECTS) fail('mcas_redirect_failed');
      const next = new URL(location, target);
      if (next.origin !== ORIGIN) fail('mcas_untrusted_redirect');
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
        headers.delete('content-type');
      }
      target = next;
    }
  }

  async login(credentials) {
    const email = credentials?.email || credentials?.username;
    const password = credentials?.password;
    if (typeof email !== 'string' || !email || typeof password !== 'string' || !password) fail('mcas_invalid_credentials');
    let response = await this.request(LOGIN_URL);
    if (!response.ok) fail('mcas_login_page_failed');
    const html = await readLimitedText(response);
    const values = {};
    for (const tag of html.match(/<input\b[^>]*>/gi) || []) {
      const input = attributes(tag);
      if (input.name?.startsWith('__') && input.value !== undefined) values[input.name] = input.value;
    }
    values.EmailTextBox = email;
    values.PasswordTextBox = password;
    response = await this.request(LOGIN_URL, { method: 'POST', headers: {
      'content-type': 'application/x-www-form-urlencoded',
    }, body: new URLSearchParams(values) });
    const page = await readLimitedText(response);
    if (!response.ok || /MCSParentLogin/i.test(response.url || '') || /id=["']EmailTextBox["']/i.test(page)) {
      fail('mcas_auth_failed');
    }
    if (response.url?.includes('MCSDashboardPage.aspx')) {
      response = await this.request(DASHBOARD_URL);
      if (!response.ok) fail('mcas_dashboard_failed');
      this.identity = this.extractIdentity(await readLimitedText(response));
    } else {
      this.identity = this.extractIdentity(page);
    }
    return this.identity;
  }

  extractIdentity(html) {
    const tags = html.match(/<input\b[^>]*>/gi) || [];
    const inputs = tags.map(attributes);
    const selectors = inputs.filter(input => input.name === 'userSelectorRadio');
    const selector = /^(\d+)_(\d+)$/.exec(selectors[0]?.id || '');
    const schoolID = /schoolID\s*=\s*["']?(\d+)/i.exec(html)?.[1] || selector?.[1];
    const studentIDs = /studentIDs\s*=\s*["']([^"']+)/i.exec(html)?.[1]
      ?.split(',').map(value => value.trim()).filter(Boolean) || [];
    const selectedStudent = inputs.find(input => input.id?.toLowerCase().includes('student-selector-studentid'))?.value;
    const linkedStudents = [...new Set([...studentIDs, ...(selectedStudent ? [selectedStudent] : [])])];
    const studentID = selectedStudent || studentIDs[0];
    const contactID = selector?.[2];
    if (!schoolID || !contactID || !studentID) fail('mcas_profile_unavailable');
    if (selectors.length !== 1 || linkedStudents.length !== 1) fail('mcas_multiple_students');
    if (!/^\d+$/.test(String(schoolID)) || !/^\d+$/.test(String(contactID)) || !/^\d+$/.test(String(studentID))) {
      fail('mcas_profile_unavailable');
    }
    return { schoolID: Number(schoolID), contactID: Number(contactID), studentID: String(studentID) };
  }

  async get(path) {
    if (!this.identity) fail('mcas_not_authenticated');
    const response = await this.request(PROXY_URL, { method: 'POST', headers: {
      'content-type': 'application/json; charset=utf-8',
    }, body: JSON.stringify({ url: path, schoolID: this.identity.schoolID, contactID: this.identity.contactID }) });
    if (!response.ok) fail('mcas_api_failed');
    let outer;
    try { outer = JSON.parse(await readLimitedText(response)); } catch (error) {
      if (error instanceof McasError) throw error;
      fail('mcas_api_invalid_json');
    }
    const value = unwrap(outer?.d);
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.Message || value.ExceptionMessage) {
      fail('mcas_api_invalid_response');
    }
    return value;
  }

  getAcademicCalendar() { return this.get('api/v1/calendars/mcas/academiccalendar'); }
  getRegisteredClubs() { return this.get(`api/v1/mcas/clubsandtrips/StudentClubsAndTrips/${this.identity?.studentID}`); }
  getMessages() { return this.get(`api/v1/mcas/user/findMessages/${this.identity?.contactID}/Received`); }
}
