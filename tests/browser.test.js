import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTranscript, applySnapshot, applyEvent, prependHistory } from '../dist/public/state.js';

function snapshot(overrides = {}) {
  return {
    generation: 'generation-a', seq: 4,
    state: { busy: true, runId: 'run-a' },
    messages: [{ id: 'one', role: 'assistant', text: 'Hello' }],
    hasMore: true, before: 'one', ...overrides,
  };
}
function event(seq, payload, generation = 'generation-a') {
  return { id: 'session-a', generation, seq, event: payload };
}

test('snapshot is isolated from source objects', () => {
  const source = snapshot();
  const transcript = applySnapshot(source);
  transcript.messages[0].text = 'changed';
  transcript.state.busy = false;
  assert.equal(source.messages[0].text, 'Hello');
  assert.equal(source.state.busy, true);
  assert.equal(createTranscript().generation, null);
});

test('buffer replay ignores snapshot-covered duplicates and reconciles partial message', () => {
  const transcript = applySnapshot(snapshot());
  assert.equal(applyEvent(transcript, event(4, { type: 'delta', messageId: 'one', text: 'Hello' })), 'duplicate');
  assert.equal(applyEvent(transcript, event(5, { type: 'delta', messageId: 'one', text: ' world' })), 'applied');
  assert.equal(transcript.messages[0].text, 'Hello world');
  applyEvent(transcript, event(6, { type: 'message', message: { id: 'one', role: 'assistant', text: 'Hello world!' } }));
  assert.equal(transcript.messages.length, 1);
  assert.equal(transcript.messages[0].text, 'Hello world!');
  assert.equal(applyEvent(transcript, event(5, { type: 'delta', messageId: 'one', text: ' repeated' })), 'duplicate');
  assert.equal(transcript.messages[0].text, 'Hello world!');
});

test('gap, generation replacement, and reset require snapshot without clearing history', () => {
  for (const envelope of [
    event(6, { type: 'delta', messageId: 'one', text: 'gap' }),
    event(5, { type: 'state', state: {} }, 'generation-b'),
    event(5, { type: 'reset' }),
    event(5, { type: 'unknown' }),
  ]) {
    const transcript = applySnapshot(snapshot());
    const before = structuredClone(transcript);
    assert.equal(applyEvent(transcript, envelope), 'resync');
    assert.deepEqual(transcript, before);
  }
});

test('state changes carry the exact current run identity', () => {
  const transcript = applySnapshot(snapshot());
  applyEvent(transcript, event(5, { type: 'state', state: { busy: true, runId: 'run-b', terminalRequired: true } }));
  assert.equal(transcript.state.runId, 'run-b');
  assert.equal(transcript.state.terminalRequired, true);
  applyEvent(transcript, event(6, { type: 'state', state: { busy: false, runId: null } }));
  assert.equal(transcript.state.runId, null);
  assert.equal(transcript.state.terminalRequired, undefined);
});

test('new partials and user/tool messages retain plain text', () => {
  const transcript = applySnapshot(snapshot({ messages: [] }));
  applyEvent(transcript, event(5, { type: 'delta', messageId: 'partial', text: '<script>alert(1)</script>' }));
  applyEvent(transcript, event(6, { type: 'message', message: { id: 'tool', role: 'tool', text: '<img onerror=alert(1)>' } }));
  assert.equal(transcript.messages[0].role, 'assistant');
  assert.equal(transcript.messages[0].text, '<script>alert(1)</script>');
  assert.equal(transcript.messages[1].role, 'tool');
});

test('pagination preserves current message and live sequence, deduplicates overlap', () => {
  const transcript = applySnapshot(snapshot());
  assert.equal(prependHistory(transcript, snapshot({
    seq: 3, messages: [
      { id: 'old', role: 'user', text: 'Earlier' },
      { id: 'one', role: 'assistant', text: 'Outdated partial' },
    ], hasMore: false, before: null,
  })), true);
  assert.deepEqual(transcript.messages.map(message => message.text), ['Earlier', 'Hello']);
  assert.equal(transcript.seq, 4);
  assert.equal(transcript.hasMore, false);
  const before = structuredClone(transcript);
  assert.equal(prependHistory(transcript, snapshot({ generation: 'other' })), false);
  assert.deepEqual(transcript, before);
});

test('browser assets contain no HTML transcript injection or external runtime dependencies', async () => {
  const app = await readFile(new URL('../dist/public/app.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../dist/public/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../dist/public/style.css', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(html + css, /https?:\/\/|@import/);
  assert.match(app, /text\.textContent = message\.text/);
  assert.match(app, /generation, runId/);
});
