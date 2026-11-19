import test from 'node:test';
import assert from 'node:assert/strict';

class Element {
  constructor() {
    this.value = '';
    this.children = [];
    this.disabled = false;
    this.style = {};
    this.scrollHeight = 500;
    this.scrollTop = 0;
    this.clientHeight = 500;
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  get textContent() {
    return (this.text || '') + this.children.map(child => typeof child === 'string' ? child : child.textContent || '').join('');
  }
  set textContent(text) { this.text = text; this.children = []; }
  replaceChildren(...children) { this.text = ''; this.children = children; }
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  setAttribute() {}
  removeAttribute() {}
  focus() {}
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('Captain badges require a fresh connected session list and follow activation, revocation and reconnect', async () => {
  const globals = { document: globalThis.document, fetch: globalThis.fetch, EventSource: globalThis.EventSource };
  const elements = new Map();
  const session = { id: 'captain', name: 'Main', generation: 'generation', state: {}, captain: true };
  const ordinary = { ...session, id: 'ordinary', name: 'Captain by name only', captain: undefined };
  let source;
  let pendingList;
  let holdList = false;
  let failList = false;
  globalThis.document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    createElement() { return new Element(); },
  };
  globalThis.EventSource = class {
    constructor() { source = this; this.listeners = {}; }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    close() {}
  };
  globalThis.fetch = async url => {
    let data;
    if (url === '/api/auth') data = { authenticated: true };
    else if (url === '/api/sessions') {
      if (failList) throw new Error('offline');
      data = { sessions: structuredClone([session, ordinary]) };
      if (holdList) await new Promise(resolve => { pendingList = resolve; });
    } else if (url.endsWith('/snapshot')) data = { generation: 'generation', seq: 0,
      state: {}, messages: [], hasMore: false };
    else throw new Error(`Unexpected URL: ${url}`);
    return { ok: true, json: async () => structuredClone(data) };
  };
  const badges = node => (node?.children || []).flatMap(child => typeof child === 'string' ? [] :
    [...(child.className === 'captain-badge' ? [child] : []), ...badges(child)]);
  const count = () => badges(elements.get('sessions')).length;
  try {
    await import(`../dist/public/app.js?captain=${Date.now()}`);
    await settle();
    source.onopen();
    await settle();
    assert.equal(count(), 1, 'initial live list');
    assert.equal(badges(elements.get('sessions'))[0].textContent, 'Captain');
    elements.get('sessions').children[0].onclick();
    await settle();
    assert.equal(badges(elements.get('session-name')).length, 1, 'selected heading');
    for (const value of [false, undefined, 'true', true]) {
      session.captain = value;
      source.listeners.sessions();
      await settle();
      assert.equal(count(), value === true ? 1 : 0);
      assert.equal(badges(elements.get('session-name')).length, value === true ? 1 : 0);
    }
    holdList = true;
    source.listeners.sessions();
    await settle();
    assert.equal(count(), 0, 'pending refresh cannot keep an unverified badge indefinitely');
    source.onerror();
    assert.equal(count(), 0, 'hide immediately on interrupted stream');
    assert.equal(badges(elements.get('session-name')).length, 0);
    const oldList = pendingList;
    source.onopen();
    assert.equal(count(), 0, 'reconnect waits for a fresh list');
    await settle();
    oldList();
    await settle();
    assert.equal(count(), 0, 'pre-interruption list response cannot revive badge after reopen');
    session.captain = false;
    pendingList();
    await settle();
    assert.equal(count(), 1);
    holdList = false;
    source.listeners.sessions();
    await settle();
    assert.equal(count(), 0, 'revocation during outage replaces cached activation');
    session.captain = true;
    source.listeners.sessions();
    await settle();
    assert.equal(count(), 1);
    failList = true;
    source.listeners.sessions();
    await settle();
    assert.equal(count(), 0, 'failed list refresh hides unverified capability');
  } finally { Object.assign(globalThis, globals); }
});

test('remote commands load every catalog page, execute extensions immediately and ignore stale pages', async () => {
  const globals = { document: globalThis.document, fetch: globalThis.fetch, EventSource: globalThis.EventSource };
  const elements = new Map();
  const sessions = [
    { id: 'main', generation: 'main-gen', name: 'Main', state: { busy: true, runId: 'run' } },
    { id: 'other', generation: 'other-gen', name: 'Other', state: {} },
  ];
  const revision = 'a'.repeat(64);
  const commands = Array.from({ length: 128 }, (_, i) => ({ name: `skill:s${i}`, source: 'skill' }));
  let source;
  let resolvePage;
  let submissions = 0;
  globalThis.document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    createElement() { return new Element(); },
  };
  globalThis.EventSource = class {
    constructor() { source = this; this.listeners = {}; }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    close() {}
  };
  globalThis.fetch = async (url, options) => {
    let data;
    if (url === '/api/auth') data = { authenticated: true };
    else if (url === '/api/sessions') data = { sessions };
    else if (url === '/api/sessions/main/snapshot') data = { generation: 'main-gen', seq: 0,
      state: sessions[0].state, messages: [], hasMore: false, commands, commandsNext: 128, commandsRevision: revision };
    else if (url === '/api/sessions/other/snapshot') data = { generation: 'other-gen', seq: 0,
      state: {}, messages: [], hasMore: false, commands: [{ name: 'other-only', source: 'prompt' }] };
    else if (url.startsWith('/api/sessions/main/commands?')) {
      assert.match(url, /generation=main-gen/);
      const offset = new URL(url, 'http://fixture').searchParams.get('offset');
      assert.ok(['128', '129'].includes(offset));
      data = offset === '128' ? await new Promise(resolve => { resolvePage = resolve; }) : {
        generation: 'main-gen', commands: [{ name: 'last-prompt', source: 'prompt' }],
        commandsNext: null, commandsRevision: revision,
      };
    } else if (url === '/api/sessions/main/prompt') {
      assert.equal(JSON.parse(options.body).text, '/captain ');
      submissions++;
      data = { status: 'submitted', command: 'captain' };
    } else throw new Error(`Unexpected URL: ${url}`);
    return { ok: true, json: async () => structuredClone(data) };
  };
  const showMenu = text => {
    const input = elements.get('prompt');
    input.value = text;
    input.selectionStart = input.selectionEnd = text.length;
    globalThis.document.activeElement = input;
    input.oninput();
    return elements.get('command-completions');
  };
  const page = { generation: 'main-gen', commands: [{ name: 'captain', source: 'extension', description: 'Enable Captain' }],
    commandsNext: 129, commandsRevision: revision };
  try {
    await import(`../dist/public/app.js?commands=${Date.now()}`);
    await settle();
    source.onopen();
    await settle();
    elements.get('sessions').children[0].onclick();
    await settle();
    assert.equal(typeof resolvePage, 'function', 'fetches pages beyond the first 128 loaded resources');
    showMenu('/captain ');
    elements.get('deliver-as').value = 'steer';
    await elements.get('composer').onsubmit({ preventDefault() {} });
    assert.equal(elements.get('messages').children.length, 0, 'server-recognized command cannot retain a steering receipt before discovery finishes');
    resolvePage(page);
    await settle();
    const menu = showMenu('/capt');
    assert.equal(menu.children.length, 1);
    assert.equal(menu.children[0].children[1].textContent, 'extension');
    menu.children[0].onclick();
    assert.equal(elements.get('prompt').value, '/captain ');
    assert.match(elements.get('composer-hint').textContent, /immediately/);
    elements.get('deliver-as').value = 'followUp';
    await elements.get('composer').onsubmit({ preventDefault() {} });
    assert.equal(submissions, 2);
    assert.match(elements.get('notice').textContent, /submitted.*immediately/);
    assert.equal(elements.get('messages').children.length, 0, 'command is not a queued steering receipt');
    elements.get('refresh').onclick();
    await settle();
    const oldPage = resolvePage;
    elements.get('sessions').children[1].onclick();
    await settle();
    oldPage(page);
    await settle();
    const otherMenu = showMenu('/');
    assert.equal(otherMenu.children.length, 1);
    assert.equal(otherMenu.children[0].children[0].textContent, '/other-only');
  } finally { Object.assign(globalThis, globals); }
});

test('browser subscribes before snapshot, reconciles buffered deltas, and never retries uncertain writes', async () => {
  const globals = { document: globalThis.document, fetch: globalThis.fetch, EventSource: globalThis.EventSource };
  const elements = new Map();
  const requests = [];
  let source;
  let resolveSnapshot;
  let imageUploads = true;
  const session = {
    id: 'paj-id', name: 'Test main', generation: 'generation', projectRoot: '/project', branch: 'main',
    state: { busy: true, runId: 'run', supportsImages: true },
  };
  const other = { ...session, id: 'other-id', name: 'Other main', generation: 'other-generation',
    state: { busy: true, runId: 'other-run' } };
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    createElement() {
      const element = new Element();
      Object.defineProperty(element, 'id', { set(id) { elements.set(id, element); } });
      return element;
    },
  };
  globalThis.EventSource = class {
    constructor(url) { this.url = url; this.listeners = {}; source = this; }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    close() {}
  };
  let holdPrompt = false;
  let resolvePrompt;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    let data;
    if (url === '/api/auth') data = { authenticated: true, csrfToken: 'csrf-secret' };
    else if (url === '/api/sessions') data = { sessions: [session, other], imageUploads };
    else if (url.endsWith('/snapshot')) {
      assert.equal(source.url, '/api/events');
      data = await new Promise(resolve => { resolveSnapshot = resolve; });
    } else if (url.endsWith('/prompt')) {
      if (!holdPrompt) throw new TypeError('network response lost');
      data = await new Promise(resolve => { resolvePrompt = resolve; });
    }
    else if (url.endsWith('/abort')) data = {};
    else throw new Error(`Unexpected URL: ${url}`);
    return { ok: true, json: async () => structuredClone(data) };
  };
  try {
    await import(`../dist/public/app.js?test=${Date.now()}`);
    await settle();
    assert.equal(source.url, '/api/events');
    assert.equal(requests.length, 1);
    source.onopen();
    await settle();
    source.listeners.session({ data: JSON.stringify({ id: 'other-id', generation: 'other-generation',
      seq: 1, event: { type: 'state', state: {
        busy: false, runId: null, editorBusy: false, terminalRequired: false,
      } } }) });
    assert.match(elements.get('sessions').children[1].children[2].textContent, /Ready/);
    source.onerror();
    await settle();
    assert.match(elements.get('notice').textContent, /Connection interrupted/);
    source.onopen();
    await settle();
    assert.equal(elements.get('notice').hidden, true);
    elements.get('sessions').children[0].onclick();
    await settle();
    elements.get('prompt').value = 'Draft while synchronizing';
    elements.get('prompt').oninput();
    assert.equal(elements.get('prompt').disabled, false);
    assert.equal(elements.get('send').disabled, true);
    await elements.get('composer').onsubmit({ preventDefault() {} });
    assert.equal(requests.filter(request => request.url.endsWith('/prompt')).length, 0);
    source.listeners.session({ data: JSON.stringify({
      id: 'paj-id', generation: 'generation', seq: 5,
      event: { type: 'delta', messageId: 'partial', text: ' world' },
    }) });
    resolveSnapshot({
      generation: 'generation', seq: 4, state: session.state,
      messages: [{ id: 'partial', role: 'assistant', text: 'Hello' }], hasMore: false, before: null,
    });
    await settle();
    assert.equal(elements.get('messages').children[0].children[1].textContent, 'Hello world');
    assert.equal(elements.get('composer-hint').textContent, '');
    assert.equal(elements.get('composer-hint').hidden, true);
    assert.equal(document.getElementById('working-indicator').hidden, false);
    source.onerror();
    assert.equal(document.getElementById('working-indicator').hidden, true);
    await settle();
    assert.match(elements.get('notice').textContent, /Connection interrupted/);
    source.onopen();
    await settle();
    assert.match(elements.get('notice').textContent, /Connection interrupted/);
    resolveSnapshot({ generation: 'generation', seq: 5, state: session.state,
      messages: [{ id: 'partial', role: 'assistant', text: 'Hello world' }], hasMore: false });
    await settle();
    assert.equal(elements.get('notice').hidden, true);
    assert.equal(elements.get('notice').textContent, '');
    elements.get('prompt').value = 'An instruction';
    document.getElementById('deliver-as').value = 'steer';
    elements.get('prompt').oninput();
    await elements.get('composer').onsubmit({ preventDefault() {} });
    await settle();
    const writes = requests.filter(request => request.url.endsWith('/prompt'));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].options.credentials, 'same-origin');
    assert.equal(writes[0].options.headers['X-CSRF-Token'], 'csrf-secret');
    const prompt = JSON.parse(writes[0].options.body);
    assert.equal(prompt.generation, 'generation');
    assert.equal(prompt.deliverAs, 'steer');
    assert.equal(prompt.text, 'An instruction');
    assert.ok(prompt.requestId);
    assert.match(elements.get('notice').textContent, /uncertain/);
    assert.equal(elements.get('messages').children.at(-1).children[0].textContent, 'Steering · delivery unconfirmed');
    assert.equal(elements.get('messages').children.at(-1).children[1].textContent, 'An instruction');
    assert.equal(elements.get('prompt').value, 'An instruction');
    await elements.get('stop').onclick();
    const abort = requests.find(request => request.url.endsWith('/abort'));
    assert.deepEqual(JSON.parse(abort.options.body), { generation: 'generation', runId: 'run' });
    source.listeners.session({ data: JSON.stringify({
      id: 'paj-id', generation: 'generation', seq: 7,
      event: { type: 'delta', messageId: 'partial', text: 'missed an event' },
    }) });
    await settle();
    assert.equal(elements.get('send').disabled, true);
    assert.equal(elements.get('messages').children[0].children[1].textContent, 'Hello world');
    resolveSnapshot({
      generation: 'generation', seq: 7,
      state: { busy: true, runId: null, editorBusy: false, terminalRequired: false },
      messages: [{ id: 'partial', role: 'assistant', text: 'Resynchronized' }], hasMore: false,
    });
    await settle();
    assert.equal(elements.get('messages').children[0].children[1].textContent, 'Resynchronized');
    assert.equal(elements.get('stop').disabled, true);
    assert.match(elements.get('composer-hint').textContent, /Awaiting Pi confirmation/);
    assert.equal(elements.get('working-indicator').hidden, true);
    assert.equal(elements.get('send').disabled, true);
    assert.equal(elements.get('prompt').disabled, false);
    assert.doesNotMatch(elements.get('composer-hint').textContent, /Submitted does not mean/);
    assert.match(elements.get('composer-hint').textContent, /check the terminal.*restart that Pi process/);
    await elements.get('composer').onsubmit({ preventDefault() {} });
    assert.equal(requests.filter(request => request.url.endsWith('/prompt')).length, 1);
    session.state = { busy: true, runId: null, editorBusy: false, terminalRequired: false };
    source.listeners.sessions();
    await settle();
    assert.match(elements.get('sessions').children[0].children[2].textContent, /Awaiting Pi confirmation/);
    source.listeners.session({ data: JSON.stringify({
      id: 'paj-id', generation: 'generation', seq: 8,
      event: { type: 'state', state: {
        busy: true, runId: 'confirmed-run', editorBusy: false, terminalRequired: false,
      } },
    }) });
    assert.equal(elements.get('working-indicator').hidden, false);
    assert.equal(elements.get('send').disabled, false);
    assert.equal(elements.get('stop').disabled, false);
    elements.get('prompt').value = 'Another instruction';
    elements.get('prompt').oninput();
    await elements.get('composer').onsubmit({ preventDefault() {} });
    assert.match(elements.get('notice').textContent, /Delivery is uncertain/);
    source.onerror();
    await settle();
    assert.equal(elements.get('send').disabled, true);
    assert.match(elements.get('notice').textContent, /Work continues/);
    assert.equal(requests.filter(request => request.url.endsWith('/prompt')).length, 2);
    assert.equal(requests.filter(request => request.url.endsWith('/abort')).length, 1);
    assert.match(elements.get('notice').textContent, /Delivery is uncertain/);
    source.onopen();
    await settle();
    assert.match(elements.get('notice').textContent, /Connection interrupted/);
    resolveSnapshot({ generation: 'generation', seq: 8,
      state: { busy: true, runId: 'confirmed-run', editorBusy: false, terminalRequired: false },
      messages: [{ id: 'older-user', role: 'user', text: 'Earlier instruction' },
        { id: 'earlier', role: 'assistant', text: 'Earlier response' },
        { id: 'user', role: 'user', text: 'Latest instruction' },
        { id: 'partial', role: 'assistant', text: 'Recovered' }], hasMore: false });
    await settle();
    assert.doesNotMatch(elements.get('notice').textContent, /Connection interrupted/);
    assert.match(elements.get('notice').textContent, /Delivery is uncertain/);
    assert.equal(elements.get('notice').hidden, false);
    assert.equal(elements.get('working-indicator').hidden, false);
    assert.equal(elements.get('composer').children[0], elements.get('working-indicator'));
    assert.equal(elements.get('messages').children.includes(elements.get('working-indicator')), false);
    for (const [index, state] of [
      { busy: false, runId: null },
      { busy: true, runId: 'run', editorBusy: true },
      { busy: true, runId: 'run', terminalRequired: true },
    ].entries()) {
      source.listeners.session({ data: JSON.stringify({ id: 'paj-id', generation: 'generation',
        seq: 9 + index, event: { type: 'state', state } }) });
      assert.equal(elements.get('working-indicator').hidden, true);
      assert.equal(elements.get('prompt').disabled, false);
    }
    source.listeners.session({ data: JSON.stringify({ id: 'paj-id', generation: 'generation',
      seq: 12, event: { type: 'state', state: { busy: false, runId: null,
        editorBusy: false, terminalRequired: false, supportsImages: true } } }) });
    assert.equal(elements.get('attach-photo').disabled, false);
    holdPrompt = true;
    elements.get('prompt').value = 'Draft for a replacement generation';
    elements.get('prompt').oninput();
    const pendingPrompt = elements.get('composer').onsubmit({ preventDefault() {} });
    await settle();
    session.generation = 'replacement-generation';
    session.state = { busy: false, runId: null, editorBusy: false, terminalRequired: false, supportsImages: true };
    source.listeners.sessions();
    await settle();
    resolveSnapshot({ generation: session.generation, seq: 0, state: session.state, messages: [], hasMore: false });
    await settle();
    elements.get('notice').textContent = 'Replacement generation notice';
    resolvePrompt({ status: 'submitted' });
    await pendingPrompt;
    assert.equal(elements.get('prompt').value, 'Draft for a replacement generation');
    assert.equal(elements.get('notice').textContent, 'Replacement generation notice');
    elements.get('refresh').onclick();
    await settle();
    const oldSnapshot = resolveSnapshot;
    const snapshotRequests = requests.filter(request => request.url.endsWith('/snapshot')).length;
    session.generation = 'latest-generation';
    source.listeners.sessions();
    await settle();
    assert.equal(requests.filter(request => request.url.endsWith('/snapshot')).length, snapshotRequests + 1,
      'A generation change must start a replacement snapshot even while the old snapshot is pending');
    oldSnapshot({ generation: 'replacement-generation', seq: 0, state: session.state, messages: [], hasMore: false });
    resolveSnapshot({ generation: session.generation, seq: 0, state: session.state, messages: [], hasMore: false });
    await settle();
    assert.equal(elements.get('send').disabled, false, 'Replacement snapshot must recover composer controls');
    imageUploads = false;
    source.listeners.sessions();
    await settle();
    assert.equal(elements.get('attach-photo').disabled, true);
    assert.match(elements.get('photo-status').textContent, /Update the service/);
    elements.get('sessions').children[1].onclick();
    await settle();
    resolveSnapshot({ generation: 'other-generation', seq: 0, state: other.state, messages: [], hasMore: false });
    await settle();
    assert.equal(elements.get('messages').children.length, 0, 'Steering receipts must not leak into another session');
    assert.equal(requests.filter(request => request.url.endsWith('/prompt')).length, 3);
  } finally {
    for (const [key, value] of Object.entries(globals)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});
