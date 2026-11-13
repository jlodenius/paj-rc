import test from 'node:test';
import assert from 'node:assert/strict';

class Element {
  constructor() {
    this.value = '';
    this.children = [];
    this.disabled = false;
    this.scrollHeight = 500;
    this.scrollTop = 0;
    this.clientHeight = 500;
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
  setAttribute() {}
  focus() {}
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('browser subscribes before snapshot, reconciles buffered deltas, and never retries uncertain writes', async () => {
  const globals = { document: globalThis.document, fetch: globalThis.fetch, EventSource: globalThis.EventSource };
  const elements = new Map();
  const requests = [];
  let source;
  let resolveSnapshot;
  const session = {
    id: 'paj-id', name: 'Test main', generation: 'generation', projectRoot: '/project', branch: 'main',
    state: { busy: true, runId: 'run' },
  };
  const other = { ...session, id: 'other-id', name: 'Other main', generation: 'other-generation',
    state: { busy: true, runId: 'other-run' } };
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    createElement() { return new Element(); },
  };
  globalThis.EventSource = class {
    constructor(url) { this.url = url; this.listeners = {}; source = this; }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    close() {}
  };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    let data;
    if (url === '/api/auth') data = { authenticated: true, csrfToken: 'csrf-secret' };
    else if (url === '/api/sessions') data = { sessions: [session, other] };
    else if (url.endsWith('/snapshot')) {
      assert.equal(source.url, '/api/events');
      data = await new Promise(resolve => { resolveSnapshot = resolve; });
    } else if (url.endsWith('/prompt')) throw new TypeError('network response lost');
    else if (url.endsWith('/abort')) data = {};
    else throw new Error(`Unexpected URL: ${url}`);
    return { ok: true, json: async () => data };
  };
  try {
    await import(`../public/app.js?test=${Date.now()}`);
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
    elements.get('sessions').children[0].onclick();
    await settle();
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
    assert.equal(elements.get('session-status').textContent, 'Awaiting Pi confirmation');
    assert.equal(elements.get('send').disabled, true);
    assert.equal(elements.get('prompt').disabled, false);
    assert.match(elements.get('composer-hint').textContent, /Submitted does not mean accepted/);
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
    assert.equal(elements.get('session-status').textContent, 'Working');
    assert.equal(elements.get('send').disabled, false);
    assert.equal(elements.get('stop').disabled, false);
    source.onerror();
    await settle();
    assert.equal(elements.get('send').disabled, true);
    assert.match(elements.get('notice').textContent, /Work continues/);
    assert.equal(requests.filter(request => request.url.endsWith('/prompt')).length, 1);
    assert.equal(requests.filter(request => request.url.endsWith('/abort')).length, 1);
  } finally {
    for (const [key, value] of Object.entries(globals)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});
