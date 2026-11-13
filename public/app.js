import { createTranscript, applySnapshot, applyEvent, prependHistory } from './state.js';

const $ = id => document.getElementById(id);
let csrfToken;
let stream;
let connected = false;
let sessions = [];
let selected = null;
let transcript = createTranscript();
let selectionVersion = 0;
let snapshotting = false;
let synced = false;
let resnapshotNeeded = false;
let buffer = [];
let sending = false;
let stopping = false;
let listVersion = 0;
let authenticated = false;

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken || '' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && authenticated) showLogin();
    throw new ApiError(data.error?.message || `Request failed (${response.status})`, response.status);
  }
  return data;
}

function notice(message = '') {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}

function showLogin() {
  authenticated = false;
  stream?.close();
  stream = null;
  connected = false;
  csrfToken = undefined;
  selected = null;
  sessions = [];
  transcript = createTranscript();
  selectionVersion++;
  listVersion++;
  buffer = [];
  $('messages').replaceChildren();
  $('sessions').replaceChildren();
  $('prompt').value = '';
  $('workspace').hidden = true;
  $('login').hidden = false;
  $('key').focus();
}

function start() {
  authenticated = true;
  $('login').hidden = true;
  $('workspace').hidden = false;
  stream?.close();
  const source = new EventSource('/api/events', { withCredentials: true });
  stream = source;
  source.onopen = () => {
    if (stream !== source) return;
    connected = true;
    $('connection').textContent = 'Connected';
    $('connection').classList.add('online');
    refreshSessions(true);
  };
  source.onerror = () => {
    if (stream !== source) return;
    connected = false;
    $('connection').textContent = 'Reconnecting…';
    $('connection').classList.remove('online');
    renderControls();
    notice('Connection interrupted. Work continues in Pi. Reconnecting and checking history…');
    api('/api/auth').then(auth => { if (!auth.authenticated) showLogin(); }).catch(() => {});
  };
  source.addEventListener('sessions', () => refreshSessions());
  source.addEventListener('resync', () => refreshSessions(true));
  source.addEventListener('session', event => {
    if (stream !== source) return;
    let envelope;
    try { envelope = JSON.parse(event.data); } catch { refreshSessions(true); return; }
    const entry = sessions.find(session => session.id === envelope.id);
    if (entry && entry.generation === envelope.generation && envelope.event?.type === 'state' &&
        ['busy', 'runId', 'editorBusy', 'terminalRequired'].some(key =>
          entry.state?.[key] !== envelope.event.state?.[key])) {
      entry.state = { ...envelope.event.state };
      renderSessions();
    }
    if (envelope.id !== selected?.id) return;
    if (snapshotting) {
      if (buffer.length < 500) buffer.push(envelope);
      else resnapshotNeeded = true;
      return;
    }
    if (applyEvent(transcript, envelope) === 'resync') refreshSnapshot();
    else renderTranscript();
  });
  renderControls();
}

async function refreshSessions(resnapshot = false) {
  const version = ++listVersion;
  try {
    const data = await api('/api/sessions');
    if (version !== listVersion || !authenticated) return;
    sessions = data.sessions;
    if (selected) {
      const next = sessions.find(session => session.id === selected.id);
      if (!next) {
        selectSession(null);
        notice('That session is no longer available. Choose another main session.');
      } else {
        const changed = next.generation !== selected.generation;
        selected = next;
        if (changed || resnapshot) refreshSnapshot();
      }
    }
    renderSessions();
    renderHeader();
    renderControls();
  } catch (error) { notice(error.message); }
}

function renderSessions() {
  const nodes = sessions.map(session => {
    const button = document.createElement('button');
    button.className = 'session-card';
    button.setAttribute('aria-current', String(session.id === selected?.id));
    const title = document.createElement('span');
    title.className = 'session-title';
    title.textContent = session.name || 'Unnamed session';
    const context = document.createElement('span');
    context.className = 'session-project';
    context.textContent = session.projectRoot || 'No project';
    const detail = document.createElement('span');
    detail.className = 'session-detail';
    detail.textContent = `${session.branch || 'No branch'} · ${statusText(session.state)}`;
    button.append(title, context, detail);
    button.onclick = () => selectSession(session);
    return button;
  });
  $('sessions').replaceChildren(...nodes);
  $('list-empty').hidden = sessions.length !== 0;
}

function awaitingConfirmation(state = {}) {
  return state.busy && !state.runId && !state.editorBusy && !state.terminalRequired;
}

function statusText(state = {}) {
  if (state.terminalRequired) return 'Needs terminal';
  if (state.editorBusy) return 'Editor in control';
  if (awaitingConfirmation(state)) return 'Awaiting Pi confirmation';
  return state.busy ? 'Working' : 'Ready';
}

function selectSession(session) {
  selectionVersion++;
  selected = session;
  transcript = createTranscript();
  snapshotting = false;
  synced = false;
  resnapshotNeeded = false;
  buffer = [];
  notice();
  $('workspace').classList.toggle('show-conversation', Boolean(session));
  renderSessions();
  renderTranscript();
  if (session) refreshSnapshot();
}

async function refreshSnapshot() {
  if (!selected || !authenticated) return;
  if (snapshotting) { resnapshotNeeded = true; return; }
  const version = selectionVersion;
  const id = selected.id;
  snapshotting = true;
  synced = false;
  buffer = [];
  renderControls();
  try {
    const snapshot = await api(`/api/sessions/${encodeURIComponent(id)}/snapshot`);
    if (version !== selectionVersion || !authenticated) return;
    transcript = applySnapshot(snapshot);
    synced = true;
    for (const envelope of buffer) {
      if (applyEvent(transcript, envelope) === 'resync') {
        resnapshotNeeded = true;
        break;
      }
    }
    renderTranscript();
  } catch (error) {
    if (version === selectionVersion) notice(`Could not sync conversation: ${error.message}. Use Refresh to try again.`);
  } finally {
    if (version === selectionVersion) {
      snapshotting = false;
      buffer = [];
      renderControls();
      if (resnapshotNeeded) {
        resnapshotNeeded = false;
        refreshSnapshot();
      }
    }
  }
}

function renderHeader() {
  $('session-name').textContent = selected?.name || 'Choose a session';
  $('session-context').textContent = selected ? `${selected.projectRoot || 'No project'}${selected.branch ? ` · ${selected.branch}` : ''}` : 'Your live workspace';
  $('session-status').textContent = selected ? statusText(transcript.generation ? transcript.state : selected.state) : '';
}

function renderTranscript() {
  const viewport = $('transcript');
  const nearBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 100;
  const nodes = transcript.messages.map(message => {
    const article = document.createElement('article');
    article.className = `message ${['user', 'assistant', 'tool'].includes(message.role) ? message.role : 'tool'}`;
    const role = document.createElement('h3');
    role.textContent = message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Assistant' : 'Tool';
    const text = document.createElement('div');
    text.className = 'message-text';
    text.textContent = message.text || '';
    article.append(role, text);
    return article;
  });
  $('messages').replaceChildren(...nodes);
  $('welcome').hidden = Boolean(selected);
  $('older').hidden = !selected || !transcript.hasMore;
  if (nearBottom) viewport.scrollTop = viewport.scrollHeight;
  renderHeader();
  renderControls();
}

function renderControls() {
  const ready = authenticated && connected && selected && synced && transcript.generation && !snapshotting;
  const blocked = transcript.state.editorBusy || transcript.state.terminalRequired;
  const pending = awaitingConfirmation(transcript.state);
  $('prompt').disabled = !ready || blocked;
  $('send').disabled = !ready || blocked || pending || sending || !$('prompt').value.trim();
  $('send').textContent = sending ? 'Submitting…' : 'Send ↑';
  $('stop').disabled = !ready || stopping || !transcript.state.busy || !transcript.state.runId || transcript.state.editorBusy;
  $('composer-hint').textContent = transcript.state.terminalRequired
    ? 'This session needs attention in the terminal.'
    : transcript.state.editorBusy ? 'An editor request owns this session. Send is unavailable.'
      : snapshotting ? 'Synchronizing conversation…'
        : pending ? 'Awaiting Pi confirmation. Submitted does not mean accepted. Sending is paused; check the terminal. If dispatch remains uncertain, restart that Pi process before retrying.'
          : 'Submitted does not mean accepted. Watch the conversation for confirmation.';
}

$('login-form').onsubmit = async event => {
  event.preventDefault();
  $('connect').disabled = true;
  $('login-error').textContent = '';
  try {
    const auth = await api('/api/login', { key: $('key').value });
    csrfToken = auth.csrfToken;
    $('key').value = '';
    start();
  } catch (error) { $('login-error').textContent = error.message; }
  finally { $('connect').disabled = false; }
};
$('logout').onclick = async () => {
  try { await api('/api/logout', {}); showLogin(); }
  catch (error) { notice(`Could not confirm logout: ${error.message}`); }
};
$('refresh').onclick = () => refreshSessions(true);
$('back').onclick = () => $('workspace').classList.remove('show-conversation');
$('prompt').oninput = renderControls;
$('composer').onsubmit = async event => {
  event.preventDefault();
  if ($('send').disabled) return;
  const version = selectionVersion;
  const text = $('prompt').value;
  const id = selected.id;
  sending = true;
  renderControls();
  try {
    await api(`/api/sessions/${encodeURIComponent(id)}/prompt`, {
      generation: transcript.generation,
      requestId: crypto.randomUUID(),
      text,
      deliverAs: $('deliver-as').value,
    });
    if (version === selectionVersion) {
      if ($('prompt').value === text) $('prompt').value = '';
      notice('Instruction submitted. Check the conversation to confirm it was accepted.');
    }
  } catch (error) {
    if (version === selectionVersion) notice(error instanceof ApiError && error.status < 500
      ? `Not submitted: ${error.message}`
      : 'Delivery is uncertain. Your instruction may have reached Pi. Check the conversation before sending again; it will not be retried automatically.');
  } finally { sending = false; renderControls(); }
};
$('stop').onclick = async () => {
  if ($('stop').disabled) return;
  const version = selectionVersion;
  const { generation, state: { runId } } = transcript;
  const id = selected.id;
  stopping = true;
  renderControls();
  try {
    await api(`/api/sessions/${encodeURIComponent(id)}/abort`, { generation, runId });
    if (version === selectionVersion) notice('Stop requested for this run.');
  } catch (error) {
    if (version === selectionVersion) notice(error instanceof ApiError && error.status < 500
      ? `Stop rejected: ${error.message}` : 'Could not confirm stop. Check the session; stop was not retried.');
  } finally { stopping = false; renderControls(); }
};
$('older').onclick = async () => {
  if (!selected || !transcript.hasMore || $('older').disabled || snapshotting) return;
  const version = selectionVersion;
  const generation = transcript.generation;
  $('older').disabled = true;
  const viewport = $('transcript');
  const height = viewport.scrollHeight;
  const scrollTop = viewport.scrollTop;
  try {
    const page = await api(`/api/sessions/${encodeURIComponent(selected.id)}/snapshot?before=${encodeURIComponent(transcript.before || '')}`);
    if (version === selectionVersion && generation === transcript.generation) {
      if (!prependHistory(transcript, page)) { refreshSnapshot(); return; }
      renderTranscript();
      viewport.scrollTop = scrollTop + viewport.scrollHeight - height;
    }
  } catch (error) { if (version === selectionVersion) notice(error.message); }
  finally { $('older').disabled = false; }
};

api('/api/auth').then(auth => {
  if (auth.authenticated) { csrfToken = auth.csrfToken; start(); }
  else showLogin();
}).catch(error => { showLogin(); $('login-error').textContent = `Cannot reach Paj Remote: ${error.message}`; });
