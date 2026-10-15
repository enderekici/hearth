const PAGE_SIZE = 30;
const SYNC_POLL_INTERVAL_MS = 2000;
const SYNC_POLL_LIMIT_MS = 90000;
const make = (tag, className = '', value = '') => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== null && value !== undefined) node.textContent = String(value);
  return node;
};

function formatDate(value, { withTime = true } = {}) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, withTime
    ? { dateStyle: 'medium', timeStyle: 'short' }
    : { dateStyle: 'medium' }).format(date);
}

function safeCount(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.floor(Number(value)) : 0;
}

function errorText(error, fallback) {
  return String(error?.message || fallback).slice(0, 240);
}

export function mountSchoolView(container, { request = async () => ({}) } = {}) {
  if (!(container instanceof Element)) throw new TypeError('School view needs a container element');

  let summary = null;
  let messages = [];
  let total = 0;
  let nextOffset = null;
  let searchTerm = '';
  let expandedId = null;
  let loadingMessages = false;
  let loadingMore = false;
  let syncing = false;
  let summaryError = '';
  let messagesError = '';
  let destroyed = false;
  let generation = 0;
  let pageGeneration = 0;
  let syncPollTimer = null;
  let syncPollToken = 0;
  let pollingSync = false;

  container.replaceChildren();
  container.classList.add('school-view');

  const header = make('header', 'sv-header');
  const titleBlock = make('div', 'sv-title-block');
  const eyebrow = make('p', 'sv-eyebrow', 'HOME & SCHOOL');
  const title = make('h2', 'sv-title', 'School');
  const subtitle = make('p', 'sv-subtitle', 'School messages and Shared calendar sync.');
  titleBlock.append(eyebrow, title, subtitle);
  const actions = make('div', 'sv-actions');
  const refreshButton = make('button', 'sv-refresh', 'Refresh school data');
  refreshButton.type = 'button';
  refreshButton.addEventListener('click', syncSchool);
  actions.append(refreshButton);
  header.append(titleBlock, actions);

  const notices = make('div', 'sv-notices');
  notices.setAttribute('aria-live', 'polite');
  notices.setAttribute('aria-atomic', 'true');
  const schoolStatusCard = make('section', 'sv-summary-card sv-school-status');
  schoolStatusCard.setAttribute('aria-label', 'School connection and inbox summary');
  const calendarCard = make('section', 'sv-summary-card sv-calendar-summary');
  calendarCard.setAttribute('aria-label', 'Shared calendar sync summary');
  const summaryGrid = make('div', 'sv-summary-grid');
  summaryGrid.append(schoolStatusCard, calendarCard);

  const inbox = make('section', 'sv-inbox');
  const inboxHeader = make('div', 'sv-inbox-header');
  const inboxTitleBlock = make('div', 'sv-inbox-title-block');
  const inboxTitle = make('h3', 'sv-inbox-title', 'Messages');
  const inboxCount = make('p', 'sv-inbox-count', '');
  inboxTitleBlock.append(inboxTitle, inboxCount);
  const searchWrap = make('label', 'sv-search-wrap');
  const searchLabel = make('span', 'sv-search-label', 'Search loaded messages');
  const search = make('input', 'sv-search');
  search.type = 'search';
  search.autocomplete = 'off';
  search.setAttribute('aria-label', 'Search loaded messages');
  search.placeholder = 'Subject, sender, or message';
  search.addEventListener('input', () => {
    searchTerm = search.value.trim().toLocaleLowerCase();
    expandedId = null;
    renderMessages();
  });
  searchWrap.append(searchLabel, search);
  inboxHeader.append(inboxTitleBlock, searchWrap);
  const listStatus = make('p', 'sv-list-status');
  listStatus.setAttribute('role', 'status');
  const list = make('div', 'sv-message-list');
  const moreButton = make('button', 'sv-more', 'Load more messages');
  moreButton.type = 'button';
  moreButton.addEventListener('click', loadMore);
  inbox.append(inboxHeader, listStatus, list, moreButton);

  container.append(header, notices, summaryGrid, inbox);

  function renderSummary() {
    schoolStatusCard.replaceChildren();
    calendarCard.replaceChildren();

    const schoolHeading = make('div', 'sv-card-heading');
    schoolHeading.append(make('h3', '', 'School inbox'));
    const statusPill = make('span', 'sv-status-pill');
    let statusLabel = 'Loading status';
    let statusKind = 'pending';
    if (summaryError) { statusLabel = 'Status unavailable'; statusKind = 'offline'; }
    else if (summary) {
      if (!summary.configured) { statusLabel = 'Not configured'; statusKind = 'unavailable'; }
      else if (!summary.connected) { statusLabel = 'Offline'; statusKind = 'offline'; }
      else { statusLabel = 'Connected'; statusKind = 'connected'; }
    }
    statusPill.textContent = statusLabel;
    statusPill.dataset.state = statusKind;
    schoolHeading.append(statusPill);

    const connectionCopy = make('p', 'sv-connection-copy');
    if (summaryError && summary) connectionCopy.textContent = 'Could not refresh school connection status.';
    else if (summary?.configured && summary.connected) connectionCopy.textContent = 'School messages are available.';
    else if (summary?.configured && !summary.connected) connectionCopy.textContent = 'The school connection is currently unavailable.';
    else if (summary && !summary.configured) connectionCopy.textContent = 'School access has not been configured.';
    else if (summaryError) connectionCopy.textContent = 'Could not load school connection status.';
    else connectionCopy.textContent = 'Checking school connection…';

    const lastSuccess = formatDate(summary?.lastSuccess);
    const lastSync = make('p', 'sv-last-sync', lastSuccess ? `Last school sync · ${lastSuccess}` : 'No successful school sync recorded.');
    const counts = make('div', 'sv-inbox-stats');
    counts.append(
      statTile('Messages', summary?.counts?.messages),
      statTile('Unread', summary?.counts?.unread),
    );
    schoolStatusCard.append(schoolHeading, connectionCopy, lastSync, counts);

    const calendarHeading = make('div', 'sv-card-heading');
    calendarHeading.append(make('h3', '', 'Shared calendar'));
    const calendarSync = formatDate(summary?.calendar?.lastSyncAt);
    const calendarCopy = make('p', 'sv-calendar-copy', calendarSync
      ? `Last calendar sync · ${calendarSync}`
      : 'No successful calendar sync recorded.');
    const syncCounts = summary?.calendar?.counts || {};
    const calendarCounts = make('div', 'sv-calendar-counts');
    calendarCounts.append(
      statTile('Created', syncCounts.created),
      statTile('Updated', syncCounts.updated),
      statTile('Unchanged', syncCounts.unchanged),
    );
    const sourceCounts = summary?.calendar?.sourceCounts || {};
    const sourceRow = make('div', 'sv-source-counts');
    for (const [key, label] of [['academic', 'Academic'], ['activities', 'Activities'], ['clubs', 'Clubs']]) {
      sourceRow.append(sourceTile(label, sourceCounts[key]));
    }
    calendarCard.append(calendarHeading, calendarCopy, calendarCounts, sourceRow);
    if (summary?.calendar?.error) calendarCard.append(inlineNotice(`Calendar sync · ${summary.calendar.error}`, 'error'));
    if (summary?.error) schoolStatusCard.append(inlineNotice(`School status · ${summary.error}`, 'error'));
    if (summaryError) schoolStatusCard.append(inlineNotice(summaryError, 'error'));
  }

  function statTile(label, value) {
    const tile = make('div', 'sv-stat-tile');
    const amount = value === undefined || value === null ? '—' : safeCount(value).toLocaleString();
    tile.append(make('strong', 'sv-stat-value', amount), make('span', 'sv-stat-label', label));
    return tile;
  }

  function sourceTile(label, value) {
    const tile = make('span', 'sv-source-tile');
    tile.append(make('span', 'sv-source-name', label), make('strong', 'sv-source-value', value === undefined || value === null ? '—' : safeCount(value).toLocaleString()));
    return tile;
  }

  function inlineNotice(message, kind = '') {
    const node = make('p', `sv-inline-notice${kind ? ` ${kind}` : ''}`, message);
    return node;
  }

  function setListStatus(message, kind = '') {
    listStatus.textContent = message || '';
    listStatus.className = `sv-list-status${kind ? ` ${kind}` : ''}`;
  }

  function filteredMessages() {
    const ordered = [...messages].sort((left, right) => {
      const a = Date.parse(left.receivedAt || '');
      const b = Date.parse(right.receivedAt || '');
      if (Number.isFinite(a) && Number.isFinite(b)) return b - a;
      if (Number.isFinite(a)) return -1;
      if (Number.isFinite(b)) return 1;
      return 0;
    });
    if (!searchTerm) return ordered;
    return ordered.filter(item => [item.subject, item.sender, item.body]
      .some(value => String(value || '').toLocaleLowerCase().includes(searchTerm)));
  }

  function renderMessages() {
    list.replaceChildren();
    const visible = filteredMessages();
    inboxCount.textContent = `${messages.length.toLocaleString()} loaded${Number.isFinite(total) ? ` · ${total.toLocaleString()} total` : ''}`;
    moreButton.hidden = nextOffset === null || nextOffset === undefined || searchTerm.length > 0 || loadingMore || loadingMessages;
    moreButton.disabled = loadingMore;
    moreButton.textContent = loadingMore ? 'Loading more…' : 'Load more messages';

    if (loadingMessages && !messages.length) {
      setListStatus('Loading school messages…');
      return;
    }
    if (messagesError && !messages.length) {
      setListStatus(messagesError, 'error');
      return;
    }
    if (!visible.length) {
      setListStatus(searchTerm ? 'No loaded messages match this search.' : messagesError || 'No school messages are available.');
      if (messagesError) setListStatus(messagesError, 'error');
      return;
    }
    setListStatus(messagesError
      ? `${messagesError} · Showing loaded messages.`
      : searchTerm
        ? `${visible.length.toLocaleString()} loaded message${visible.length === 1 ? '' : 's'} match.`
        : 'Newest messages first. Opening a message does not change its read state.', messagesError ? 'error' : '');

    for (const item of visible) {
      const row = make('article', 'sv-message');
      if (!item.isRead) row.classList.add('is-unread');
      const toggle = make('button', 'sv-message-toggle');
      toggle.type = 'button';
      const isExpanded = String(expandedId) === String(item.id);
      toggle.setAttribute('aria-expanded', String(isExpanded));
      toggle.setAttribute('aria-controls', `sv-body-${safeId(item.id)}`);

      const topLine = make('span', 'sv-message-topline');
      const badges = make('span', 'sv-message-badges');
      badges.append(make('span', 'sv-badge sv-source-badge', String(item.source || 'School')));
      badges.append(make('span', `sv-badge ${item.isRead ? 'sv-read-badge' : 'sv-unread-badge'}`, item.isRead ? 'Read' : 'Unread'));
      const receivedAt = formatDate(item.receivedAt);
      topLine.append(badges, make('time', 'sv-message-date', receivedAt));

      const sender = make('span', 'sv-message-sender', item.sender || 'Sender unavailable');
      const subject = make('strong', 'sv-message-subject', item.subject || 'No subject');
      const preview = make('span', 'sv-message-preview', previewText(item.body));
      const copy = make('span', 'sv-message-copy');
      copy.append(sender, subject, preview);
      const chevron = make('span', 'sv-message-chevron', isExpanded ? '−' : '+');
      chevron.setAttribute('aria-hidden', 'true');
      toggle.append(topLine, copy, chevron);
      toggle.addEventListener('click', () => {
        expandedId = isExpanded ? null : item.id;
        renderMessages();
        const current = list.querySelector(`[data-message-id="${cssEscape(item.id)}"] .sv-message-toggle`);
        current?.focus({ preventScroll: true });
      });
      row.dataset.messageId = String(item.id ?? '');

      const body = make('div', 'sv-message-body');
      body.id = `sv-body-${safeId(item.id)}`;
      body.hidden = !isExpanded;
      body.textContent = String(item.body || 'Message body is empty.');
      row.append(toggle, body);
      list.append(row);
    }
  }

  function previewText(value) {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return 'No preview available';
    return normalized.length > 170 ? `${normalized.slice(0, 167)}…` : normalized;
  }

  function safeId(value) {
    const encoded = encodeURIComponent(String(value ?? 'message')).replace(/%/g, '-');
    return encoded.slice(0, 80) || 'message';
  }

  function cssEscape(value) {
    return globalThis.CSS?.escape ? CSS.escape(String(value ?? '')) : String(value ?? '').replace(/["\\]/g, '\\$&');
  }

  async function loadSummary() {
    try {
      const nextSummary = await request('/school');
      if (destroyed) return;
      summary = nextSummary;
      summaryError = '';
    } catch (error) {
      if (destroyed) return;
      summaryError = errorText(error, 'Could not load school status.');
    }
    if (!destroyed) {
      renderSummary();
      if (summary?.syncing) startSyncPolling();
    }
  }

  async function loadFirstPage() {
    const currentGeneration = ++pageGeneration;
    loadingMessages = true;
    messagesError = '';
    renderMessages();
    try {
      const page = await request(`/school/messages?limit=${PAGE_SIZE}&offset=0`);
      if (destroyed || currentGeneration !== pageGeneration) return;
      messages = Array.isArray(page?.items) ? page.items : [];
      total = Number.isFinite(Number(page?.total)) ? Math.max(0, Number(page.total)) : messages.length;
      nextOffset = page?.nextOffset ?? null;
      expandedId = null;
    } catch (error) {
      if (destroyed || currentGeneration !== pageGeneration) return;
      messagesError = errorText(error, 'Could not load school messages.');
    } finally {
      if (!destroyed && currentGeneration === pageGeneration) {
        loadingMessages = false;
        renderMessages();
      }
    }
  }

  async function refresh() {
    const currentGeneration = ++generation;
    summaryError = '';
    renderSummary();
    const results = await Promise.allSettled([loadSummary(), loadFirstPage()]);
    if (destroyed || currentGeneration !== generation) return;
    renderSummary();
    return results;
  }

  function startSyncPolling() {
    if (destroyed || pollingSync) return;
    pollingSync = true;
    const token = ++syncPollToken;
    const startedAt = Date.now();
    const poll = async () => {
      syncPollTimer = null;
      if (destroyed || token !== syncPollToken) return;
      await loadSummary();
      if (destroyed || token !== syncPollToken) return;
      if (!summary?.syncing) {
        pollingSync = false;
        notices.replaceChildren(inlineNotice('School sync finished. Latest messages and calendar status are shown.', 'pending'));
        await loadFirstPage();
        if (!destroyed && token === syncPollToken) renderSummary();
        return;
      }
      if (Date.now() - startedAt >= SYNC_POLL_LIMIT_MS) {
        pollingSync = false;
        notices.replaceChildren(inlineNotice('School sync is still running. Refresh school data to check its status again.', 'pending'));
        return;
      }
      syncPollTimer = setTimeout(poll, SYNC_POLL_INTERVAL_MS);
    };
    syncPollTimer = setTimeout(poll, SYNC_POLL_INTERVAL_MS);
  }

  async function loadMore() {
    if (nextOffset === null || nextOffset === undefined || loadingMore || loadingMessages) return;
    const currentGeneration = pageGeneration;
    const offset = Number(nextOffset);
    if (!Number.isFinite(offset) || offset < 0) { nextOffset = null; renderMessages(); return; }
    loadingMore = true;
    renderMessages();
    try {
      const page = await request(`/school/messages?limit=${PAGE_SIZE}&offset=${encodeURIComponent(offset)}`);
      if (destroyed || currentGeneration !== pageGeneration) return;
      const incoming = Array.isArray(page?.items) ? page.items : [];
      const known = new Set(messages.map(item => String(item.id)));
      messages = messages.concat(incoming.filter(item => !known.has(String(item.id))));
      total = Number.isFinite(Number(page?.total)) ? Math.max(0, Number(page.total)) : total;
      nextOffset = page?.nextOffset ?? null;
      messagesError = '';
    } catch (error) {
      if (!destroyed && currentGeneration === pageGeneration) messagesError = errorText(error, 'Could not load more messages.');
    } finally {
      if (!destroyed && currentGeneration === pageGeneration) {
        loadingMore = false;
        renderMessages();
        if (messagesError) setListStatus(messagesError, 'error');
      }
    }
  }

  async function syncSchool() {
    if (syncing || destroyed) return;
    syncing = true;
    refreshButton.disabled = true;
    refreshButton.textContent = 'Checking school…';
    notices.replaceChildren();
    notices.append(inlineNotice('Sync requested. Waiting for the latest school and calendar status.', 'pending'));
    try {
      await request('/school/sync', { method: 'POST' });
      await refresh();
      if (!summary?.syncing) {
        notices.replaceChildren(inlineNotice('School sync finished. Latest messages and calendar status are shown.', 'pending'));
      }
    } catch (error) {
      const message = errorText(error, 'Could not start school sync.');
      if (message === 'school_sync_in_progress') {
        notices.replaceChildren(inlineNotice('A school sync is already in progress. Current status is shown below.', 'pending'));
      } else {
        notices.replaceChildren(inlineNotice(message, 'error'));
      }
      await refresh();
    } finally {
      syncing = false;
      if (!destroyed) {
        refreshButton.disabled = false;
        refreshButton.textContent = 'Refresh school data';
      }
    }
  }

  renderSummary();
  renderMessages();
  refresh();

  return {
    refresh,
    destroy() {
      destroyed = true;
      generation++;
      pageGeneration++;
      syncPollToken++;
      if (syncPollTimer !== null) clearTimeout(syncPollTimer);
      syncPollTimer = null;
      pollingSync = false;
      container.replaceChildren();
      container.classList.remove('school-view');
    },
  };
}
