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
    this.attributes = new Map();
  }
  get textContent() {
    return (this.text || '') + this.children.map(child => typeof child === 'string' ? child : child.textContent || '').join('');
  }
  set textContent(text) { this.text = text; this.children = []; }
  replaceChildren(...children) { this.text = ''; this.children = children; }
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  focus() {}
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
}
const settle = () => new Promise(resolve => setImmediate(resolve));

async function withListSync(run) {
  const globals = { document: globalThis.document, fetch: globalThis.fetch, EventSource: globalThis.EventSource };
  const elements = new Map();
  const lists = [];
  let source;
  let snapshot = { generation: 'main-gen', seq: 0, state: { busy: false }, messages: [], hasMore: false };
  let snapshots = 0;
  let snapshotGate;
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    createElement() { return new Element(); },
  };
  globalThis.EventSource = class {
    constructor() { source = this; this.listeners = {}; }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    close() {}
  };
  globalThis.fetch = async url => {
    const reply = data => ({ ok: true, json: async () => structuredClone(data) });
    if (url === '/api/auth') return reply({ authenticated: true });
    if (url === '/api/sessions') return new Promise((resolve, reject) => {
      lists.push({ resolve: sessions => resolve(reply({ sessions })), reject });
    });
    if (url === '/api/sessions/main/snapshot') {
      snapshots++;
      const response = reply(snapshot);
      await snapshotGate;
      return response;
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  try {
    await import(`../dist/public/app.js?list-sync=${withListSync.calls = (withListSync.calls ?? 0) + 1}`);
    await settle();
    source.onopen();
    elements.get('prompt').value = 'A saved draft';
    await run({ elements, source, lists, snapshots: () => snapshots,
      setSnapshot: value => { snapshot = { ...snapshot, ...value }; },
      holdSnapshot() {
        let release;
        snapshotGate = new Promise(resolve => { release = resolve; });
        return () => { snapshotGate = undefined; release(); };
      } });
    assert.equal(lists.length, 0);
  } finally { Object.assign(globalThis, globals); }
}

const listedSession = (id, stateSeq = 0, busy = false, generation = `${id}-gen`) =>
  ({ id, generation, name: id, stateSeq, state: { busy, runId: busy ? 'run' : null } });

test('reconnect resnapshots after a failed and then superseded list refresh', () => withListSync(async h => {
  const main = listedSession('main');
  h.lists.shift().resolve([main]);
  await settle();
  h.elements.get('sessions').children[0].onclick();
  await settle();
  assert.equal(h.snapshots(), 1);
  assert.equal(h.elements.get('send').disabled, false);
  h.source.onerror();
  h.source.onopen();
  h.lists.shift().reject(new Error('Temporary failure'));
  await settle();
  h.source.listeners.resync();
  const delayed = h.lists.shift();
  h.source.listeners.sessions();
  const winning = h.lists.shift();
  delayed.resolve([main]);
  await settle();
  assert.equal(h.snapshots(), 1, 'only the winning list may consume resnapshot intent');
  assert.equal(h.elements.get('send').disabled, true);
  h.setSnapshot({ seq: 4, state: { busy: true, runId: 'run', editorBusy: false, terminalRequired: false },
    messages: [{ id: 'new', role: 'assistant', text: 'Updated during the interruption' }] });
  winning.resolve([main]);
  await settle();
  assert.equal(h.snapshots(), 2);
  assert.match(h.elements.get('messages').textContent, /Updated during the interruption/);
  assert.equal(h.elements.get('send').disabled, false);
  assert.equal(h.elements.get('stop').disabled, false);
  h.source.listeners.sessions();
  h.lists.shift().resolve([main]);
  await settle();
  assert.equal(h.snapshots(), 2, 'ordinary refreshes no longer resnapshot after handoff');
}));

test('ordinary list refresh can recover reconnect resync intent after a list failure', () => withListSync(async h => {
  const main = listedSession('main');
  h.lists.shift().resolve([main]);
  await settle();
  h.elements.get('sessions').children[0].onclick();
  await settle();
  h.source.onerror();
  h.source.onopen();
  h.lists.shift().reject(new Error('Temporary failure'));
  await settle();
  h.source.listeners.sessions();
  h.lists.shift().resolve([main]);
  await settle();
  assert.equal(h.snapshots(), 2);
  assert.equal(h.elements.get('send').disabled, false);
}));

test('a snapshot started before disconnect cannot re-enable Send during reconnect', () => withListSync(async h => {
  const main = listedSession('main');
  h.lists.shift().resolve([main]);
  await settle();
  const release = h.holdSnapshot();
  h.elements.get('sessions').children[0].onclick();
  h.source.onerror();
  h.source.onopen();
  release();
  await settle();
  assert.equal(h.elements.get('send').disabled, true);
  assert.match(h.elements.get('notice').textContent, /reconnecting/i);
  h.lists.shift().resolve([main]);
  await settle();
  assert.equal(h.snapshots(), 2);
  assert.equal(h.elements.get('send').disabled, false);
}));

test('rendering delayed transcript events cannot roll back the selected list row', () => withListSync(async h => {
  const main = listedSession('main');
  h.lists.shift().resolve([main]);
  await settle();
  h.elements.get('sessions').children[0].onclick();
  await settle();
  h.elements.get('filter-working').onclick();
  h.source.listeners.sessions();
  h.lists.shift().resolve([listedSession('main', 10, true)]);
  await settle();
  const visible = () => h.elements.get('sessions').children.length;
  assert.equal(visible(), 1);
  h.source.listeners.session({ data: JSON.stringify({ id: main.id, generation: main.generation, seq: 1,
    event: { type: 'message', message: { id: 'reply', role: 'assistant', text: 'Still renders' } },
  }) });
  assert.match(h.elements.get('messages').textContent, /Still renders/);
  assert.equal(visible(), 1);
  h.setSnapshot({ seq: 11 });
  h.source.listeners.resync();
  h.lists.shift().resolve([listedSession('main', 10, true)]);
  await settle();
  assert.equal(visible(), 0, 'a newer snapshot can advance the selected row');
}));

test('the Working filter merges list and live state for unselected, newly listed and replacement rows',
  () => withListSync(async h => {
    const main = listedSession('main');
    const worker = listedSession('worker');
    const newcomer = listedSession('newcomer');
    const publish = row => h.source.listeners.session({ data: JSON.stringify({
      id: row.id, generation: row.generation, seq: row.stateSeq, event: { type: 'state', state: row.state },
    }) });
    const names = () => h.elements.get('sessions').children.map(card =>
      card.children[0].children.find(child => child.className === 'session-label').textContent);
    const refresh = () => { h.source.listeners.sessions(); return h.lists.shift(); };
    h.lists.shift().resolve([main, worker]);
    await settle();
    h.elements.get('sessions').children[0].onclick();
    await settle();
    h.elements.get('filter-working').onclick();
    const delayed = refresh();
    publish(listedSession('worker', 9, true));
    publish(listedSession('newcomer', 7, true));
    assert.deepEqual(names(), ['worker']);
    delayed.resolve([main, worker, newcomer]);
    await settle();
    assert.deepEqual(names(), ['worker', 'newcomer'], 'delayed lists cannot regress newer live state');
    refresh().resolve([main, listedSession('worker', 10), newcomer]);
    await settle();
    publish(listedSession('worker', 9, true));
    assert.deepEqual(names(), ['newcomer'], 'older live state cannot regress newer list state');
    const replacement = refresh();
    publish(listedSession('worker', 1, true, 'replacement'));
    replacement.resolve([main, listedSession('worker', 0, false, 'replacement'),
      listedSession('newcomer', 0, false, 'newcomer-replacement')]);
    await settle();
    assert.deepEqual(names(), ['worker'], 'a replacement accepts its own earlier-in-sequence event, never an old generation');
    assert.equal(h.elements.get('session-name').textContent, 'main');
    assert.equal(h.snapshots(), 1);
  }));

test('activity filters follow live busy state, retain Captain order and never change the conversation', async () => {
  const globals = { document: globalThis.document, fetch: globalThis.fetch, EventSource: globalThis.EventSource };
  const elements = new Map();
  const sessions = [
    { id: 'work', name: 'WorkFirst', state: { busy: true, runId: 'run' } },
    { id: 'idle-captain', name: 'IdleCaptain', captain: true, state: { busy: false } },
    { id: 'unknown', name: 'Unknown', state: {} },
    { id: 'work-captain', name: 'WorkingCaptain', captain: true, state: { busy: true, runId: 'other-run' } },
    { id: 'idle', name: 'IdleSecond', state: { busy: false } },
    { id: 'pending', name: 'Pending', state: { busy: true, runId: null } },
  ].map(session => ({ ...session, generation: `${session.id}-gen` }));
  let source;
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
      if (failList) throw new Error('List unavailable');
      data = { sessions };
    }
    else if (url.endsWith('/snapshot')) data = { generation: 'work-gen', seq: 0,
      state: sessions[0].state, messages: [{ id: 'reply', role: 'assistant', text: 'Keep this conversation' }], hasMore: false };
    else throw new Error(`Unexpected URL: ${url}`);
    return { ok: true, json: async () => structuredClone(data) };
  };
  const names = () => elements.get('sessions').children.map(card =>
    card.children[0].children.find(child => child.className === 'session-label').textContent);
  const choose = filter => elements.get(`filter-${filter}`).onclick();
  const pressed = filter => elements.get(`filter-${filter}`).getAttribute('aria-pressed');
  const sequences = new Map();
  const update = (index, busy) => {
    const seq = (sequences.get(index) || 0) + 1;
    sequences.set(index, seq);
    sessions[index].state = { busy, runId: null };
    source.listeners.session({ data: JSON.stringify({ id: sessions[index].id,
      generation: sessions[index].generation, seq, event: { type: 'state', state: sessions[index].state } }) });
  };
  try {
    await import(`../dist/public/app.js?filters=${Date.now()}`);
    await settle();
    source.onopen();
    await settle();
    assert.equal(elements.has('refresh'), false, 'no removed control is bound during startup');
    assert.equal(pressed('all'), 'true');
    assert.equal(pressed('working'), 'false');
    assert.equal(pressed('idle'), 'false');
    assert.deepEqual(names(), ['IdleCaptain', 'WorkingCaptain', 'WorkFirst', 'Unknown', 'IdleSecond', 'Pending']);
    elements.get('sessions').children[2].onclick();
    await settle();
    elements.get('prompt').value = 'Keep my draft';
    choose('working');
    assert.deepEqual(names(), ['WorkingCaptain', 'WorkFirst', 'Pending']);
    assert.deepEqual([pressed('all'), pressed('working'), pressed('idle')], ['false', 'true', 'false']);
    choose('idle');
    assert.deepEqual(names(), ['IdleCaptain', 'IdleSecond']);
    assert.equal(elements.get('session-name').textContent, 'WorkFirst');
    assert.match(elements.get('messages').textContent, /Keep this conversation/);
    choose('working');
    update(0, false);
    assert.deepEqual(names(), ['WorkingCaptain', 'Pending']);
    assert.equal(pressed('working'), 'true');
    assert.equal(elements.get('session-name').textContent, 'WorkFirst');
    update(3, false);
    update(5, false);
    assert.deepEqual(names(), []);
    assert.equal(elements.get('list-empty').hidden, false);
    assert.match(elements.get('list-empty').textContent, /No working/);
    choose('idle');
    const idleNames = ['IdleCaptain', 'WorkingCaptain', 'WorkFirst', 'IdleSecond', 'Pending'];
    assert.deepEqual(names(), idleNames);
    source.listeners.sessions();
    await settle();
    assert.equal(pressed('idle'), 'true');
    assert.deepEqual(names(), idleNames);
    source.onerror();
    assert.equal(pressed('idle'), 'true');
    assert.deepEqual(names(), [], 'disconnected cached status is not explicit idle');
    assert.match(elements.get('list-empty').textContent, /status.*unavailable/i);
    choose('all');
    assert.deepEqual(names(), ['IdleCaptain', 'WorkingCaptain', 'WorkFirst', 'Unknown', 'IdleSecond', 'Pending']);
    choose('idle');
    source.onopen();
    await settle();
    assert.equal(pressed('idle'), 'true');
    assert.deepEqual(names(), idleNames);
    assert.equal(elements.get('session-name').textContent, 'WorkFirst');
    assert.match(elements.get('messages').textContent, /Keep this conversation/);
    assert.equal(elements.get('prompt').value, 'Keep my draft');
    for (const index of [0, 1, 3, 4, 5]) update(index, true);
    assert.deepEqual(names(), []);
    assert.match(elements.get('list-empty').textContent, /No idle/);
    choose('working');
    assert.equal(names().length, 5);
    failList = true;
    source.listeners.sessions();
    await settle();
    assert.equal(pressed('working'), 'true');
    assert.deepEqual(names(), [], 'failed list refresh cannot classify cached sessions as working');
    assert.match(elements.get('list-empty').textContent, /status.*unavailable/i);
    choose('all');
    assert.equal(names().length, 6);
    assert.equal(elements.get('prompt').value, 'Keep my draft');
  } finally { Object.assign(globalThis, globals); }
});

test('Captain sessions sort first stably and badges follow activation, revocation and reconnect', async () => {
  const globals = { document: globalThis.document, fetch: globalThis.fetch, EventSource: globalThis.EventSource };
  const elements = new Map();
  const session = { id: 'captain', name: 'Main', generation: 'generation', state: {}, captain: true };
  const ordinary = { ...session, id: 'ordinary', name: 'Captain by name only', captain: undefined };
  const listed = [ordinary, session];
  const titles = () => elements.get('sessions').children.map(card => card.children[0].children
    .filter(child => child.className !== 'session-name-prefix')
    .map(child => typeof child === 'string' ? child : child.textContent).join(''));
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
      data = { sessions: structuredClone(listed) };
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
    assert.deepEqual(titles(), ['Main Captain', 'Captain by name only'], 'active Captain precedes earlier ordinary session');
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
      assert.equal(titles()[0], value === true ? 'Main Captain' : 'Captain by name only');
    }
    listed.push({ ...ordinary, id: 'last-ordinary', name: 'Last ordinary' },
      { ...session, id: 'second-captain', name: 'Second main' });
    source.listeners.sessions();
    await settle();
    assert.deepEqual(titles(), ['Main Captain', 'Second main Captain', 'Captain by name only', 'Last ordinary'],
      'multiple Captains precede ordinary sessions with stable ordering in both groups');
    assert.equal(elements.get('session-name').textContent, 'Main Captain', 'sorting preserves selection');
    listed.splice(2);
    source.listeners.sessions();
    await settle();
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
    source.listeners.resync();
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
    source.listeners.resync();
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
