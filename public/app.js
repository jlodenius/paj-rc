import { createTranscript, applySnapshot, applyEvent, prependHistory } from './state.js';
import { renderMarkdown } from './markdown.js';
import { prepareImage } from './images.js';
import { MAX_IMAGES } from './image-limits.js';
import { compactProjectPath } from './paths.js';
import { sessionInfo } from './session-info.js';
import { createSubmissionFeedback, steeringLabel } from './submissions.js';

if (globalThis.isSecureContext && globalThis.navigator?.serviceWorker) {
  navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => {});
}

const $ = id => document.getElementById(id);
const workingIndicator = document.createElement('div');
workingIndicator.id = 'working-indicator';
workingIndicator.className = 'working-indicator';
workingIndicator.setAttribute('role', 'status');
workingIndicator.hidden = true;
const workingSpinner = document.createElement('span');
workingSpinner.id = 'working-spinner';
workingSpinner.className = 'working-spinner';
workingSpinner.setAttribute('aria-hidden', 'true');
const workingFrames = document.createElement('span');
workingFrames.className = 'working-spinner-frames';
workingFrames.textContent = [...'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'].join('\n');
workingSpinner.append(workingFrames);
const workingLabel = document.createElement('span');
workingLabel.textContent = 'Working…';
workingIndicator.append(workingSpinner, workingLabel);
$('composer').prepend(workingIndicator);
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
let imageUploads = false;
let photos = [];
let preparingPhotos = false;
let photoError = '';
let photoRevision = 0;
let removePhotoButtons = [];
let projectPaths = [];
let headerPath;
const submissionFeedback = createSubmissionFeedback();
const feedbackScope = (id, generation) => `${id}:${generation}`;

function fitProjectPaths() {
  for (const entry of [...projectPaths, ...(headerPath ? [headerPath] : [])]) {
    const width = entry.container.clientWidth;
    if (!width) continue;
    const probe = document.createElement('span');
    probe.className = 'path-measure';
    probe.setAttribute('aria-hidden', 'true');
    entry.container.append(probe);
    const measure = text => {
      probe.textContent = text;
      return probe.getBoundingClientRect().width;
    };
    let available = width;
    if (entry.branch) {
      const branchWidth = measure(entry.branch.textContent) + 8;
      const directories = entry.fullPath.split('/').filter(Boolean);
      const minimum = directories.length > 1 ? `../${directories.at(-1)}` : entry.fullPath;
      if (branchWidth + measure(minimum) <= width) available -= branchWidth;
    }
    entry.node.textContent = compactProjectPath(entry.fullPath, text => measure(text) <= available);
    probe.remove();
  }
}

if (globalThis.ResizeObserver) {
  const observer = new ResizeObserver(fitProjectPaths);
  observer.observe($('workspace'));
  observer.observe($('session-context'));
}
document.fonts?.ready.then(fitProjectPaths);

function clearPhotos() {
  photoRevision++;
  for (const photo of photos) URL.revokeObjectURL(photo.url);
  photos = [];
  preparingPhotos = false;
  photoError = '';
  $('photo-library').value = '';
  $('photo-camera').value = '';
  renderPhotos();
}

function renderPhotos() {
  removePhotoButtons = [];
  const nodes = photos.map((photo, index) => {
    const card = document.createElement('div');
    card.className = 'photo-preview';
    const image = document.createElement('img');
    image.src = photo.url;
    image.alt = `Selected photo ${index + 1}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'photo-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove photo ${index + 1}`);
    remove.onclick = () => {
      if (sending || preparingPhotos) return;
      URL.revokeObjectURL(photo.url);
      photos = photos.filter(value => value !== photo);
      photoRevision++;
      photoError = '';
      renderPhotos();
      renderControls();
    };
    removePhotoButtons.push(remove);
    card.append(image, remove);
    return card;
  });
  $('photo-previews').replaceChildren(...nodes);
  $('photo-previews').hidden = photos.length === 0;
}

async function selectPhotos(event) {
  const files = Array.from(event.target.files || []).slice(0, Math.max(0, MAX_IMAGES - photos.length));
  event.target.value = '';
  if (!files.length || preparingPhotos || sending || !selected || !authenticated) return;
  const revision = ++photoRevision;
  const version = selectionVersion;
  preparingPhotos = true;
  photoError = '';
  renderControls();
  try {
    const prepared = [];
    for (const file of files) {
      const image = await prepareImage(file);
      if (revision !== photoRevision || version !== selectionVersion || !authenticated) return;
      prepared.push(image);
    }
    for (const image of prepared) {
      photos.push({ mimeType: image.mimeType, data: image.data,
        url: URL.createObjectURL(image.blob) });
    }
    renderPhotos();
  } catch (error) {
    if (revision === photoRevision && version === selectionVersion) photoError = error.message;
  } finally {
    if (revision === photoRevision) {
      preparingPhotos = false;
      renderControls();
    }
  }
}

function renderPhotoControls() {
  const state = transcript.generation ? transcript.state : selected?.state;
  const supported = imageUploads && state?.supportsImages === true;
  const disabled = !authenticated || !selected || !supported || preparingPhotos || sending || photos.length >= MAX_IMAGES;
  $('attach-photo').disabled = disabled;
  $('take-photo').disabled = disabled;
  $('photo-library').disabled = disabled;
  $('photo-camera').disabled = disabled;
  for (const button of removePhotoButtons) button.disabled = sending || preparingPhotos;
  const message = photoError || (preparingPhotos ? 'Preparing photos…'
    : selected && !supported ? !imageUploads ? 'Update the service to enable photos.'
      : state?.supportsImages === false ? 'This model does not support photos.' : 'Reload Pi to enable photos.'
      : photos.length ? `${photos.length} photo${photos.length === 1 ? '' : 's'} attached` : '');
  if ($('photo-status').textContent !== message) $('photo-status').textContent = message;
  $('photo-status').setAttribute('data-error', String(Boolean(photoError)));
}

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
  let data;
  try { data = await response.json(); }
  catch { throw new ApiError(`Service unavailable (${response.status})`, response.status); }
  if (!response.ok) {
    if (response.status === 401 && authenticated) showLogin();
    throw new ApiError(data.error?.message || `Request failed (${response.status})`, response.status);
  }
  return data;
}

let actionNotice = '';
let connectionNotice = '';

function renderNotice() {
  const message = [actionNotice, connectionNotice].filter(Boolean).join(' ');
  $('notice').textContent = message;
  $('notice').hidden = !message;
}

function notice(message = '') {
  actionNotice = message;
  renderNotice();
}

function connectionWarning(message = '') {
  connectionNotice = message;
  renderNotice();
}

function showLogin() {
  clearPhotos();
  submissionFeedback.clear();
  authenticated = false;
  imageUploads = false;
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
  renderHeader();
  $('prompt').value = '';
  $('workspace').hidden = true;
  $('login').hidden = false;
  $('key').focus();
  notice();
  connectionWarning();
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
    synced = false;
    $('connection').textContent = 'Reconnecting…';
    $('connection').classList.remove('online');
    renderControls();
    connectionWarning('Connection interrupted. Work continues in Pi. Reconnecting and checking history…');
    api('/api/auth').then(auth => { if (!auth.authenticated) showLogin(); }).catch(() => {});
  };
  source.addEventListener('sessions', () => refreshSessions());
  source.addEventListener('resync', () => refreshSessions(true));
  source.addEventListener('session', event => {
    if (stream !== source) return;
    let envelope;
    try { envelope = JSON.parse(event.data); } catch { refreshSessions(true); return; }
    const entry = sessions.find(session => session.id === envelope.id);
    if (entry && entry.generation === envelope.generation) {
      submissionFeedback.observe(feedbackScope(entry.id, entry.generation), envelope);
      if (envelope.event?.type === 'state' &&
          JSON.stringify(entry.state) !== JSON.stringify(envelope.event.state)) {
        entry.state = { ...envelope.event.state };
        renderSessions();
      }
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
    imageUploads = data.imageUploads === true;
    sessions = data.sessions;
    if (selected) {
      const next = sessions.find(session => session.id === selected.id);
      if (!next) {
        selectSession(null);
        notice('That session is no longer available. Choose another main session.');
      } else {
        const changed = next.generation !== selected.generation;
        if (changed) selectSession(next, { reveal: false });
        else {
          selected = next;
          if (resnapshot) refreshSnapshot();
        }
      }
    }
    if (connected && !selected) connectionWarning();
    renderSessions();
    renderHeader();
    renderControls();
  } catch (error) { notice(error.message); }
}

function renderSessions() {
  projectPaths = [];
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
    context.title = context.textContent;
    projectPaths.push({ container: context, node: context, fullPath: context.textContent });
    const detail = document.createElement('span');
    detail.className = 'session-detail';
    detail.textContent = `${session.branch || 'No branch'} `;
    const separator = document.createElement('span');
    separator.className = 'session-separator';
    separator.textContent = '·';
    detail.append(separator, ` ${statusText(session.state)}`);
    button.append(title, context, detail, metadataRow(session.state, session.model));
    button.onclick = () => selectSession(session);
    return button;
  });
  $('sessions').replaceChildren(...nodes);
  $('list-empty').hidden = sessions.length !== 0;
  fitProjectPaths();
}

function metadataRow(state, fallbackModel) {
  const info = sessionInfo(state, fallbackModel);
  const row = document.createElement('span');
  row.className = 'agent-meta';
  const model = document.createElement('span');
  model.className = 'agent-model';
  model.textContent = info.modelText;
  model.title = info.modelTitle;
  const context = document.createElement('span');
  context.className = 'agent-context';
  context.textContent = info.contextText;
  context.title = info.contextTitle;
  row.append(model, context);
  return row;
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

function selectSession(session, { reveal = true } = {}) {
  if (selected?.id !== session?.id || selected?.generation !== session?.generation) clearPhotos();
  selectionVersion++;
  selected = session;
  transcript = createTranscript();
  snapshotting = false;
  synced = false;
  resnapshotNeeded = false;
  buffer = [];
  notice();
  if (reveal) $('workspace').classList.toggle('show-conversation', Boolean(session));
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
    if (connected && !resnapshotNeeded) connectionWarning();
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
  const context = $('session-context');
  headerPath = null;
  if (!selected) {
    context.textContent = 'Your live workspace';
    context.title = '';
    $('session-metadata').replaceChildren();
    $('session-metadata').hidden = true;
    return;
  }
  const path = document.createElement('span');
  path.className = 'context-path';
  path.textContent = selected.projectRoot || 'No project';
  context.title = `${path.textContent}${selected.branch ? ` · ${selected.branch}` : ''}`;
  const branch = selected.branch ? document.createElement('span') : null;
  if (branch) {
    branch.className = 'context-branch';
    branch.textContent = selected.branch;
  }
  context.replaceChildren(path, ...(branch ? [' ', branch] : []));
  headerPath = { container: context, node: path, fullPath: path.textContent, branch };
  const metadata = $('session-metadata');
  metadata.replaceChildren(metadataRow(transcript.generation === selected.generation ? transcript.state : selected.state, selected.model));
  metadata.hidden = false;
  fitProjectPaths();
}

function renderTranscript() {
  if (selected && transcript.generation === selected.generation &&
      JSON.stringify(selected.state) !== JSON.stringify(transcript.state)) {
    selected.state = { ...transcript.state };
    renderSessions();
  }
  const viewport = $('transcript');
  const nearBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 100;
  const messages = selected ? submissionFeedback.messages(feedbackScope(selected.id, transcript.generation), transcript.messages) : transcript.messages;
  const nodes = messages.map(message => {
    const article = document.createElement('article');
    const paj = message.role === 'assistant' && message.customType === 'paj-messages';
    article.className = `message ${paj ? 'paj' : ['user', 'assistant', 'tool'].includes(message.role) ? message.role : 'tool'}${message.steering ? ' steering' : ''}`;
    const role = document.createElement('h3');
    role.className = 'message-role';
    role.textContent = message.steering ? steeringLabel(message) : paj ? 'Paj agents' : message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Assistant' : 'Tool';
    const text = document.createElement('div');
    text.className = paj ? 'message-text markdown' : 'message-text';
    if (paj) renderMarkdown(text, message.text || '');
    else text.textContent = message.text || '';
    article.append(role, text);
    if (Number.isSafeInteger(message.imageCount) && message.imageCount > 0) {
      const caption = document.createElement('div');
      caption.className = 'photo-caption';
      caption.textContent = `${message.imageCount} photo${message.imageCount === 1 ? '' : 's'} attached`;
      article.append(caption);
    }
    return article;
  });
  $('messages').replaceChildren(...nodes);
  $('welcome').hidden = Boolean(selected);
  $('older').hidden = !selected || !transcript.hasMore;
  renderHeader();
  renderControls();
  if (nearBottom) viewport.scrollTop = viewport.scrollHeight;
}

function renderControls() {
  const ready = authenticated && connected && selected && synced && transcript.generation && !snapshotting;
  const blocked = transcript.state.editorBusy || transcript.state.terminalRequired;
  const pending = awaitingConfirmation(transcript.state);
  workingIndicator.hidden = !(authenticated && connected && selected && transcript.generation &&
    !blocked && transcript.state.busy && transcript.state.runId);
  // Disabling the draft during resync dismisses mobile keyboards.
  $('prompt').disabled = !authenticated || !selected;
  $('send').disabled = !ready || blocked || pending || sending || preparingPhotos ||
    (!$('prompt').value.trim() && photos.length === 0) ||
    (photos.length > 0 && (!imageUploads || transcript.state.supportsImages !== true));
  $('send').textContent = sending ? 'Submitting…' : 'Send ↑';
  $('stop').disabled = !ready || stopping || !transcript.state.busy || !transcript.state.runId || transcript.state.editorBusy;
  $('composer-hint').textContent = transcript.state.terminalRequired
    ? 'This session needs attention in the terminal.'
    : transcript.state.editorBusy ? 'An editor request owns this session. Send is unavailable.'
      : snapshotting ? 'Synchronizing conversation…'
        : pending ? 'Awaiting Pi confirmation. Sending is paused; check the terminal. If dispatch remains uncertain, restart that Pi process before retrying.'
          : '';
  $('composer-hint').hidden = !$('composer-hint').textContent;
  renderPhotoControls();
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
$('deliver-as').onchange = () => {
  const current = $('delivery-current');
  if (current) current.textContent = { steer: 'Steer', reject: 'Reject',
    followUp: 'Queue follow-up' }[$('deliver-as').value] || 'Steer';
};
$('deliver-as').onchange();
$('attach-photo').onclick = () => $('photo-library').click();
$('take-photo').onclick = () => $('photo-camera').click();
$('photo-library').onchange = selectPhotos;
$('photo-camera').onchange = selectPhotos;
$('composer').onsubmit = async event => {
  event.preventDefault();
  if ($('send').disabled) return;
  const version = selectionVersion;
  const text = $('prompt').value;
  const images = photos.map(photo => ({ mimeType: photo.mimeType, data: photo.data }));
  const revision = photoRevision;
  const id = selected.id;
  const generation = transcript.generation;
  const requestId = crypto.randomUUID();
  const deliverAs = $('deliver-as').value;
  const scope = feedbackScope(id, generation);
  const steering = deliverAs === 'steer' && transcript.state.busy && Boolean(transcript.state.runId);
  if (steering) submissionFeedback.begin(scope, { requestId, text, imageCount: images.length, seq: transcript.seq });
  sending = true;
  renderTranscript();
  try {
    const action = images.length ? 'image-prompt' : 'prompt';
    await api(`/api/sessions/${encodeURIComponent(id)}/${action}`, {
      generation,
      requestId,
      text,
      ...(images.length ? { images } : {}),
      deliverAs,
    });
    if (steering) submissionFeedback.update(scope, requestId, 'submitted');
    if (version === selectionVersion) {
      if ($('prompt').value === text) $('prompt').value = '';
      if (revision === photoRevision) clearPhotos();
      notice();
    }
  } catch (error) {
    if (steering) submissionFeedback.update(scope, requestId, error instanceof ApiError && error.status < 500 ? 'rejected' : 'unknown');
    if (version === selectionVersion) notice(error instanceof ApiError && error.status < 500
      ? `Not submitted: ${error.message}`
      : 'Delivery is uncertain. Your instruction may have reached Pi. Check the conversation before sending again; it will not be retried automatically.');
  } finally { sending = false; renderTranscript(); }
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
}).catch(error => { showLogin(); $('login-error').textContent = `Cannot reach paj-rc: ${error.message}`; });
