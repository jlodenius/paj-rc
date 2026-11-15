import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { setImmediate as immediate, setTimeout as delay } from 'node:timers/promises';
import { createSessionAdapter, isEligible, projectMessage } from '../src/session.js';

function harness(options = {}) {
  const events = new Map();
  const calls = [];
  const emitted = [];
  let idle = true;
  let editorBusy = false;
  let identity = { id: 'paj', piSessionId: 'pi', pid: 123, role: 'primary', name: 'Main' };
  const reservations = new Set();
  const branch = [];
  const ctx = { mode: 'tui', hasUI: true, model: { input: ['text', 'image'] }, isIdle: () => idle,
    sessionManager: { getSessionId: () => 'pi', getBranch: () => branch },
    abort: () => calls.push('abort') };
  const pi = {
    on(name, fn) {
      const handlers = events.get(name) ?? new Set();
      events.set(name, handlers);
      handlers.add(fn);
      return () => handlers.delete(fn);
    },
    sendUserMessage(text, args) { calls.push({ text, args }); options.send?.(text); },
    ...(options.getCommands ? { getCommands: options.getCommands } : {}),
  };
  const paj = { version: 1, getSnapshot: () => ({ identity, editorBusy }),
    tryReserve(token) {
      if (editorBusy) return false;
      if (reservations.has(token)) return true;
      if (reservations.size) return false;
      reservations.add(token); return true;
    },
    release(token) { reservations.delete(token); } };
  const adapter = createSessionAdapter({ pi, ctx, paj, env: {}, pid: 123, ...options });
  adapter.subscribe((frame) => emitted.push(frame));
  const params = (extra) => ({ generation: adapter.generation, ...extra });
  return { adapter, ctx, paj, calls, emitted, branch, reservations, params,
    on: pi.on,
    async dispatch(name, event = {}) {
      for (const fn of events.get(name) ?? []) await fn(event, ctx);
    },
    idle(value) { idle = value; }, editor(value) { editorBusy = value; },
    identity(value) { identity = value; },
    event(name, event = {}, currentCtx = ctx) {
      for (const fn of events.get(name) ?? []) fn(event, currentCtx);
    },
    prompt(extra = {}) {
      return adapter.prompt(params({ requestId: 'request', text: 'Hello', deliverAs: 'reject', ...extra }));
    } };
}

test('eligibility requires live matching main TUI and rejects all inherited child metadata', () => {
  const h = harness();
  assert.equal(h.adapter.eligible(), true);
  for (const mode of ['rpc', 'json', 'print', undefined]) {
    assert.equal(isEligible({ ...h.ctx, mode }, h.paj.getSnapshot(), { env: {}, pid: 123 }), false);
  }
  for (const key of ['PAJ_SPAWN_ID', 'PAJ_PARENT_PI_SESSION_ID', 'PAJ_TASK_ID', 'PAJ_PARENT_TASK_ID']) {
    assert.equal(isEligible(h.ctx, h.paj.getSnapshot(), { env: { [key]: 'child' }, pid: 123 }), false);
  }
  for (const change of [{ role: 'subagent' }, { parentPiSessionId: 'parent' },
    { piSessionId: 'other' }, { pid: 124 }, { spawnId: 'spawn' }, { taskId: 'task' }]) {
    const snapshot = { identity: { ...h.paj.getSnapshot().identity, ...change } };
    assert.equal(isEligible(h.ctx, snapshot, { env: {}, pid: 123 }), false);
  }
  h.identity(null);
  for (const action of [() => h.prompt(), () => h.adapter.snapshot(h.params()),
    () => h.adapter.abort(h.params({ runId: 'run' }))]) {
    assert.throws(action, { code: 'unavailable' });
  }
  h.adapter.close();
});

test('history is current-branch paginated text only; secrets and payloads stay out', () => {
  const h = harness();
  h.branch.push({ type: 'message', id: 'system', message: { role: 'system', content: 'SECRET' } },
    { type: 'custom_message', id: 'hidden', message: { role: 'custom', content: 'SECRET' } });
  for (let i = 0; i < 105; i++) h.branch.push({ type: 'message', id: String(i),
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'SECRET' },
      { type: 'text', text: `Visible ${i}` }] } });
  h.branch.push({ type: 'message', id: 'tool', message: { role: 'toolResult', toolName: 'read',
    content: [{ type: 'text', text: 'SECRET FILE' }], details: { private: 'SECRET' } } });
  const snapshot = h.adapter.snapshot(h.params());
  assert.equal(snapshot.messages.length, 100);
  assert.equal(snapshot.hasMore, true);
  assert.equal(snapshot.before, '6');
  assert.equal(JSON.stringify(snapshot).includes('SECRET'), false);
  const older = h.adapter.snapshot(h.params({ before: snapshot.before }));
  assert.equal(older.messages.length, 6);
  assert.equal(older.hasMore, false);
  assert.throws(() => h.adapter.snapshot(h.params({ before: 'lost' })), { code: 'invalid_cursor' });
  assert.equal(projectMessage({ role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(20000) }] }, 'id').text.length, 8192);
  const escaped = projectMessage({ role: 'assistant', content: '\u0000'.repeat(20000) }, 'id');
  assert.ok(Buffer.byteLength(JSON.stringify(escaped.text)) <= 8194);
  assert.deepEqual(projectMessage({ role: 'custom', display: true, content: 'Visible report' }, 'custom'),
    { id: 'custom', role: 'assistant', text: 'Visible report' });
  assert.deepEqual(projectMessage({ role: 'custom', customType: 'paj-messages', display: true,
    content: '**Agent report**', details: { secret: 'SECRET' } }, 'paj'),
  { id: 'paj', role: 'assistant', text: '**Agent report**', customType: 'paj-messages' });
  assert.deepEqual(projectMessage({ role: 'assistant', customType: 'paj-messages',
    content: 'Ordinary response' }, 'normal'),
  { id: 'normal', role: 'assistant', text: 'Ordinary response' });
  assert.equal(projectMessage({ role: 'custom', customType: 'paj-messages', display: false,
    content: 'SECRET' }, 'hidden-paj'), null);
  assert.equal(projectMessage({ role: 'custom', display: false, content: 'SECRET' }, 'hidden'), null);
  h.adapter.close();
});

test('visible Paj reports reconcile numeric live timestamps with ISO custom-entry timestamps', async () => {
  const h = harness();
  const timestamp = Date.now();
  h.event('message_end', { message: { role: 'custom', customType: 'paj-messages',
    display: true, content: 'Review completed', timestamp } });
  await delay(40);
  assert.equal(h.adapter.snapshot(h.params()).messages[0].customType, 'paj-messages');
  assert.ok(h.emitted.some(frame => frame.event.type === 'message' &&
    frame.event.message.customType === 'paj-messages'));
  h.branch.push({ type: 'custom_message', id: 'report', customType: 'paj-messages',
    display: true, content: 'Review completed', timestamp: new Date(timestamp + 10).toISOString() });
  await delay(100);
  const snapshot = h.adapter.snapshot(h.params());
  assert.deepEqual(snapshot.messages, [{ id: 'report', role: 'assistant', text: 'Review completed',
    customType: 'paj-messages' }]);
  assert.ok(h.emitted.some(frame => frame.event.type === 'reset'));
  h.adapter.close();
});

test('void submission is not acceptance; literal input, dedup and explicit busy choices', () => {
  const h = harness();
  assert.equal(h.prompt({ text: '/not-a-command' }).status, 'submitted');
  assert.deepEqual(h.calls[0], { text: '/not-a-command', args: { expandPromptTemplates: false } });
  assert.equal(h.prompt({ text: '/not-a-command' }).duplicate, true);
  assert.equal(h.calls.length, 1);
  assert.throws(() => h.prompt({ text: 'changed' }), { code: 'request_conflict' });
  assert.throws(() => h.prompt({ requestId: 'new' }), { code: 'busy' });
  h.idle(false);
  h.event('agent_start');
  assert.throws(() => h.prompt({ requestId: 'busy' }), { code: 'busy' });
  h.prompt({ requestId: 'steer', deliverAs: 'steer' });
  assert.equal(h.calls.at(-1).args.deliverAs, 'steer');
  h.event('agent_start');
  h.prompt({ requestId: 'followup', deliverAs: 'followUp' });
  assert.equal(h.calls.at(-1).args.deliverAs, 'followUp');
  h.adapter.close();
});

test('multiple steering messages can be queued during the same running turn', () => {
  const h = harness();
  h.idle(false);
  h.event('agent_start');
  assert.equal(h.prompt({ requestId: 'first-steer', text: 'First correction',
    deliverAs: 'steer' }).status, 'submitted');
  assert.equal(h.prompt({ requestId: 'second-steer', text: 'Second correction',
    deliverAs: 'steer' }).status, 'submitted');
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].args.deliverAs, 'steer');
  assert.equal(h.calls[1].args.deliverAs, 'steer');
  assert.equal(h.reservations.size, 1);
  assert.equal(h.prompt({ requestId: 'second-steer', text: 'Second correction',
    deliverAs: 'steer' }).duplicate, true);
  assert.equal(h.calls.length, 2);
  h.idle(true);
  assert.throws(() => h.prompt({ requestId: 'idle-steer', deliverAs: 'steer' }), { code: 'busy' });
  h.event('agent_settled');
  assert.equal(h.reservations.size, 0);
  assert.equal(h.adapter.state().busy, false);
  h.adapter.close();
});

test('active steering and follow-ups share a reservation without allowing reject-mode input', () => {
  const h = harness();
  h.idle(false);
  h.event('agent_start');
  h.prompt({ requestId: 'steer', deliverAs: 'steer' });
  h.prompt({ requestId: 'follow-up', deliverAs: 'followUp' });
  assert.equal(h.calls.length, 2);
  assert.equal(h.reservations.size, 1);
  assert.throws(() => h.prompt({ requestId: 'reject', deliverAs: 'reject' }), { code: 'busy' });
  h.editor(true);
  assert.throws(() => h.prompt({ requestId: 'editor', deliverAs: 'steer' }), { code: 'editor_busy' });
  h.adapter.close();
});

test('an idle submission remains exclusive until agent_start confirms it', () => {
  const h = harness();
  h.prompt();
  h.idle(false);
  h.event('before_agent_start');
  assert.throws(() => h.prompt({ requestId: 'early-steer', deliverAs: 'steer' }), { code: 'busy' });
  h.event('agent_start');
  h.prompt({ requestId: 'steer', deliverAs: 'steer' });
  h.prompt({ requestId: 'another-steer', deliverAs: 'steer' });
  assert.equal(h.calls.length, 3);
  h.adapter.close();
});

test('a failed additional steer preserves the reservation and deduplicates its failure', () => {
  const h = harness({ send(text) { if (text === 'fail') throw new Error('submission failed'); } });
  h.idle(false);
  h.event('agent_start');
  h.prompt({ requestId: 'first', deliverAs: 'steer' });
  for (let index = 0; index < 2; index++) {
    assert.throws(() => h.prompt({ requestId: 'failed', text: 'fail', deliverAs: 'steer' }),
      { code: 'submission_failed' });
  }
  assert.equal(h.reservations.size, 1);
  assert.equal(h.calls.length, 2);
  h.prompt({ requestId: 'next', deliverAs: 'steer' });
  assert.equal(h.calls.length, 3);
  h.adapter.close();
});

test('active queue reuse cannot take another external client reservation', () => {
  const h = harness();
  h.idle(false);
  h.event('agent_start');
  h.prompt({ requestId: 'first', deliverAs: 'steer' });
  h.reservations.clear();
  h.reservations.add('another-client');
  assert.throws(() => h.prompt({ requestId: 'second', deliverAs: 'steer' }), { code: 'editor_busy' });
  assert.equal(h.calls.length, 1);
  h.adapter.close();
  assert.deepEqual([...h.reservations], ['another-client']);
});

test('editor ownership excludes prompt and stop without applying bridge policies', () => {
  const h = harness();
  h.editor(true);
  assert.throws(() => h.prompt(), { code: 'editor_busy' });
  h.idle(false);
  h.event('agent_start');
  assert.throws(() => h.adapter.abort(h.params({ runId: h.adapter.state().runId })), { code: 'editor_busy' });
  assert.deepEqual(h.calls, []);
  h.editor(false);
  h.prompt({ deliverAs: 'steer' });
  assert.equal(h.calls[0].text, 'Hello');
  assert.equal(h.calls[0].args.expandPromptTemplates, false);
  h.adapter.close();
});

test('generation and run-bound control; terminal state; settled is final', () => {
  const h = harness();
  assert.throws(() => h.adapter.snapshot({ generation: 'old' }), { code: 'stale_generation' });
  h.idle(false);
  h.event('agent_start');
  const first = h.adapter.state().runId;
  h.event('ui_prompt_start');
  assert.equal(h.adapter.state().terminalRequired, true);
  h.event('ui_prompt_end');
  assert.equal(h.adapter.state().terminalRequired, false);
  h.event('agent_end');
  assert.equal(h.adapter.state().runId, first);
  assert.throws(() => h.adapter.abort(h.params({ runId: 'old' })), { code: 'stale_run' });
  assert.equal(h.adapter.abort(h.params({ runId: first })).status, 'submitted');
  h.idle(true);
  h.event('agent_settled');
  h.idle(false);
  h.event('agent_start');
  assert.notEqual(h.adapter.state().runId, first);
  assert.throws(() => h.adapter.abort(h.params({ runId: first })), { code: 'stale_run' });
  h.adapter.close();
});

test('stream buffers bounded partial text, excludes thinking, resets after persistence', async () => {
  const h = harness();
  h.event('message_start', { message: { role: 'assistant' } });
  h.event('message_update', { assistantMessageEvent: { type: 'thinking_delta', delta: 'SECRET' } });
  h.event('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'Hello' } });
  const partial = h.adapter.snapshot(h.params()).messages.at(-1);
  assert.equal(partial.text, 'Hello');
  h.event('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] } });
  h.branch.push({ type: 'message', id: 'persisted', message: { role: 'assistant', content: 'Hello!' } });
  await immediate();
  assert.deepEqual(h.adapter.snapshot(h.params()).messages, [{ id: 'persisted', role: 'assistant', text: 'Hello!' }]);
  assert.equal(h.emitted.at(-1).event.type, 'reset');
  assert.deepEqual(h.emitted.map((frame) => frame.seq), h.emitted.map((_, index) => index + 1));
  assert.equal(JSON.stringify(h.emitted).includes('SECRET'), false);
  h.adapter.close();
});

test('finalized message overlays survive later async message_end handlers until persistence is observed', async () => {
  const h = harness();
  const old = { role: 'assistant', timestamp: 1, content: 'Final text' };
  h.branch.push({ type: 'message', id: 'old-identical-text', message: old });
  let release;
  h.on('message_end', async () => new Promise(resolve => { release = resolve; }));
  const message = { role: 'assistant', timestamp: 2, content: [{ type: 'text', text: 'Final text' }] };
  h.event('message_start', { message });
  h.event('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'Partial' } });
  const streamedId = h.adapter.snapshot(h.params()).messages.at(-1).id;
  const dispatch = h.dispatch('message_end', { message }).then(() => {
    h.branch.push({ type: 'message', id: 'persisted-final', message: { ...message } });
  });
  await immediate();
  await delay(60);
  assert.deepEqual(h.adapter.snapshot(h.params()).messages, [
    { id: 'old-identical-text', role: 'assistant', text: 'Final text' },
    { id: streamedId, role: 'assistant', text: 'Final text' },
  ]);
  assert.equal(h.emitted.some(frame => frame.event.type === 'reset'), false);
  release();
  await dispatch;
  const after = h.adapter.snapshot(h.params());
  assert.deepEqual(after.messages.map(value => value.id), ['old-identical-text', 'persisted-final']);
  assert.equal(h.emitted.at(-1).event.type, 'reset');
  const resetCount = h.emitted.filter(frame => frame.event.type === 'reset').length;
  await delay(100);
  assert.equal(h.emitted.filter(frame => frame.event.type === 'reset').length, resetCount);
  h.adapter.close();
});

test('pending user and tool final messages survive lifecycle resets and reconcile transformed persistence', async () => {
  const h = harness();
  const user = { role: 'user', timestamp: 10, content: 'User text' };
  const tool = { role: 'toolResult', timestamp: 11, toolCallId: 'tool-call', toolName: 'read', content: 'SECRET' };
  h.event('message_end', { message: user });
  h.event('message_end', { message: tool });
  await immediate();
  h.event('agent_settled');
  h.event('session_compact_failed');
  assert.deepEqual(h.adapter.snapshot(h.params()).messages.map(value => value.text), ['User text', 'read: completed']);
  h.branch.push({ type: 'message', id: 'user-persisted', message: { ...user, content: 'Transformed user text' } },
    { type: 'message', id: 'tool-persisted', message: { ...tool } });
  assert.deepEqual(h.adapter.snapshot(h.params()).messages, [
    { id: 'user-persisted', role: 'user', text: 'Transformed user text' },
    { id: 'tool-persisted', role: 'tool', text: 'read: completed' },
  ]);
  h.adapter.close();
});

test('identical consecutive overlays consume distinct persisted entries across observations', async () => {
  const h = harness();
  h.event('message_end', { message: { role: 'user', content: 'Repeated text' } });
  h.event('message_end', { message: { role: 'user', content: 'Repeated text' } });
  h.branch.push({ type: 'message', id: 'first', message: { role: 'user', content: 'Repeated text' } });
  const first = h.adapter.snapshot(h.params());
  assert.equal(first.messages.length, 2);
  assert.equal(first.messages[0].id, 'first');
  await immediate();
  assert.equal(h.adapter.snapshot(h.params()).messages.length, 2);
  h.branch.push({ type: 'message', id: 'second', message: { role: 'user', content: 'Repeated text' } });
  assert.deepEqual(h.adapter.snapshot(h.params()).messages.map(message => message.id), ['first', 'second']);
  h.adapter.close();
});

test('branch invalidation and teardown discard unpersisted overlays and stop observation', async () => {
  for (const event of ['session_tree', 'session_compact']) {
    const h = harness();
    const message = { role: 'assistant', timestamp: 1, content: 'Stale branch text' };
    h.event('message_end', { message });
    await immediate();
    assert.equal(h.adapter.snapshot(h.params()).messages.length, 1);
    h.event(event);
    assert.deepEqual(h.adapter.snapshot(h.params()).messages, []);
    h.branch.push({ type: 'message', id: 'late-persistence', message });
    const count = h.emitted.length;
    await delay(40);
    assert.equal(h.emitted.length, count);
    h.event('message_end', { message: { ...message, timestamp: 2 } });
    h.adapter.close();
    const closedCount = h.emitted.length;
    await delay(40);
    assert.equal(h.emitted.length, closedCount);
  }
});

test('handled or rejected void input stays submitted and reservation fails closed until real run', () => {
  const h = harness({ send() {} });
  assert.equal(h.prompt().status, 'submitted');
  assert.equal(h.reservations.size, 1);
  h.idle(false);
  h.event('agent_start');
  assert.equal(h.reservations.size, 0);
  h.adapter.close();
  assert.throws(() => h.prompt(), { code: 'unavailable' });
});

test('bounded dedup and synchronous submission errors are stable', () => {
  const h = harness({ dedupLimit: 2 });
  for (const requestId of ['a', 'b', 'c']) {
    h.prompt({ requestId });
    h.event('agent_start');
  }
  assert.equal(h.prompt({ requestId: 'c' }).duplicate, true);
  h.prompt({ requestId: 'a' });
  assert.equal(h.calls.length, 4);
  h.adapter.close();
  const failure = harness({ send() { throw new Error('sensitive internals'); } });
  assert.throws(() => failure.prompt(), { code: 'submission_failed' });
  assert.throws(() => failure.prompt(), { code: 'submission_failed' });
  assert.equal(failure.calls.length, 1);
  assert.equal(failure.reservations.size, 0);
  failure.adapter.close();
});


test('image prompts preserve exact SDK content, image-only input, capability and hash dedup', () => {
  const image = { mimeType: 'image/png', data: readFileSync(
    new URL('../public/icons/icon-192.png', import.meta.url)).toString('base64') };
  const other = { mimeType: 'image/png', data: readFileSync(
    new URL('../public/icons/icon-512.png', import.meta.url)).toString('base64') };
  const h = harness();
  assert.equal(h.adapter.state().supportsImages, true);
  h.prompt({ text: '', images: [image] });
  assert.deepEqual(h.calls[0], { text: [{ type: 'image', ...image }],
    args: { expandPromptTemplates: false } });
  h.ctx.model = { input: ['text'] };
  h.event('model_select');
  assert.equal(h.emitted.at(-1).event.state.supportsImages, false);
  assert.equal(h.prompt({ text: '', images: [image] }).duplicate, true);
  assert.throws(() => h.prompt({ text: '', images: [other] }), { code: 'request_conflict' });
  assert.throws(() => h.prompt({ requestId: 'new-image', text: '', images: [image] }),
    { code: 'images_unsupported' });
  h.ctx.model = undefined;
  assert.equal(h.adapter.state().supportsImages, false);
  h.ctx.model = { input: ['image', 'text'] };
  h.idle(false); h.event('agent_start');
  h.prompt({ requestId: 'with-caption', text: 'Describe this', images: [image], deliverAs: 'steer' });
  h.prompt({ requestId: 'second-image', text: '', images: [other], deliverAs: 'steer' });
  assert.equal(h.reservations.size, 1);
  assert.deepEqual(h.calls[1].text, [{ type: 'text', text: 'Describe this' }, { type: 'image', ...image }]);
  assert.equal(h.calls[1].args.deliverAs, 'steer');
  assert.throws(() => h.prompt({ requestId: 'bad-image', images: [{ ...image, data: 'bad' }] }),
    { status: 400, code: 'invalid_image' });
  h.adapter.close();
});

test('model selection refreshes capability from the current event context', () => {
  const h = harness();
  h.event('model_select', {}, { ...h.ctx, model: { input: ['text'] } });
  assert.equal(h.adapter.state().supportsImages, false);
  assert.equal(h.emitted.at(-1).event.state.supportsImages, false);
  h.event('model_select', {}, { ...h.ctx, model: { input: ['text', 'image'] } });
  assert.equal(h.adapter.state().supportsImages, true);
  h.adapter.close();
});

test('user image projections retain bounded counts and placeholders but never image payloads', () => {
  const image = { type: 'image', mimeType: 'image/png', data: 'SECRET_IMAGE_BYTES', url: 'SECRET_URL' };
  assert.deepEqual(projectMessage({ role: 'user', content: [image] }, 'one'),
    { id: 'one', role: 'user', text: '[Image attached]', imageCount: 1 });
  assert.deepEqual(projectMessage({ role: 'user', content: [image, image] }, 'two'),
    { id: 'two', role: 'user', text: '[2 images attached]', imageCount: 2 });
  assert.deepEqual(projectMessage({ role: 'user', content: [{ type: 'text', text: 'Caption' }, image] }, 'caption'),
    { id: 'caption', role: 'user', text: 'Caption', imageCount: 1 });
  assert.equal(projectMessage({ role: 'user', content: Array(50).fill(image) }, 'many').imageCount, 3);
  const h = harness();
  h.event('message_end', { message: { role: 'user', content: [image] } });
  const snapshot = h.adapter.snapshot(h.params());
  assert.equal(snapshot.messages[0].text, '[Image attached]');
  assert.doesNotMatch(JSON.stringify([snapshot, h.emitted]), /SECRET/);
  h.adapter.close();
});


test('live metadata whitelists model and preserves known, unknown and zero context usage', () => {
  const h = harness();
  h.ctx.model = { id: 'model', provider: 'provider', name: 'Model', apiKey: 'SECRET' };
  let usage = { tokens: 0, contextWindow: 200000, payload: 'SECRET' };
  h.ctx.getContextUsage = () => usage;
  assert.deepEqual(h.adapter.state().model, { id: 'model', provider: 'provider', name: 'Model' });
  for (const tokens of [0, 123, null, undefined, -1, 1.5, Infinity, NaN, '12', Number.MAX_SAFE_INTEGER + 1]) {
    usage = { tokens, contextWindow: 200000 };
    assert.deepEqual(h.adapter.state().context, { tokens: tokens === 0 || tokens === 123 ? tokens : null,
      contextWindow: 200000 });
  }
  for (const contextWindow of [undefined, 0, -1, 1.5, Infinity, NaN, '200000', Number.MAX_SAFE_INTEGER + 1]) {
    usage = { tokens: 12, contextWindow };
    assert.equal(h.adapter.state().context, null);
  }
  usage = null;
  assert.equal(h.adapter.state().context, null);
  h.ctx.getContextUsage = () => { throw new Error('SECRET'); };
  assert.equal(h.adapter.state().context, null);
  assert.doesNotMatch(JSON.stringify(h.adapter.snapshot(h.params())), /SECRET/);
  for (const name of ['', 'bad\nname', null, {}]) {
    h.ctx.model.name = name;
    assert.equal(h.adapter.state().model, null);
  }
  h.ctx.model.name = 'x'.repeat(300);
  assert.equal(h.adapter.state().model.name.length, 200);
  h.adapter.close();
});

test('completion and reset events use current contexts and defer usage until persistence', async () => {
  const h = harness();
  let usage = { tokens: 10, contextWindow: 1000 };
  const current = { ...h.ctx, model: { id: 'new', provider: 'new-provider', name: 'New' },
    getContextUsage: () => usage };
  h.event('model_select', {}, current);
  assert.equal(h.emitted.at(-1).event.state.model.id, 'new');
  h.event('message_end', { message: { role: 'assistant', content: 'Done' } }, current);
  usage = { tokens: 99, contextWindow: 1000 };
  await immediate();
  assert.deepEqual(h.emitted.at(-1).event.state.context, usage);
  for (const name of ['session_compact', 'session_tree', 'session_compact_failed', 'turn_end', 'agent_end', 'agent_settled']) {
    const fresh = { ...current, model: { id: name, provider: 'provider', name },
      getContextUsage: () => ({ tokens: null, contextWindow: 2000 }) };
    h.event(name, {}, fresh);
    assert.deepEqual(h.adapter.snapshot(h.params()).state.context, { tokens: null, contextWindow: 2000 });
    assert.equal(h.adapter.state().model.id, name);
    await immediate();
  }
  h.event('session_compact', {}, { ...current, getContextUsage: () => null });
  assert.equal(h.adapter.state().context, null);
  h.adapter.close();
  const old = harness();
  assert.equal(old.adapter.state().context, null);
  assert.equal(old.adapter.state().model, null);
  old.adapter.close();
});

test('snapshots advertise only bounded native skill/prompt commands with native collision precedence', () => {
  const catalog = [
    { name: 'blocked', source: 'extension' },
    { name: 'blocked', source: 'prompt', description: 'Shadowed prompt' },
    { name: 'skill:blocked', source: 'extension' },
    { name: 'skill:blocked', source: 'skill' },
    { name: 'review', source: 'prompt', description: 'Review\nchanges\u001b' },
    { name: 'review', source: 'prompt', description: 'Duplicate' },
    { name: 'skill:check', source: 'skill', description: 'x'.repeat(300),
      sourceInfo: { path: 'SECRET' }, content: 'SECRET', raw: 'SECRET' },
    ...Array.from({ length: 150 }, (_, i) => ({ name: `p${i}`, source: 'prompt' })),
  ];
  const h = harness({ getCommands: () => catalog });
  const commands = h.adapter.snapshot(h.params()).commands;
  assert.equal(commands.length, 128);
  assert.deepEqual(commands[0], { name: 'review', source: 'prompt', description: 'Review changes' });
  assert.equal(commands[1].name, 'skill:check');
  assert.equal(commands[1].description.length, 240);
  assert.doesNotMatch(JSON.stringify(commands), /SECRET|blocked|Duplicate/);
  h.adapter.close();
  const old = harness();
  assert.equal(Object.hasOwn(old.adapter.snapshot(old.params()), 'commands'), false);
  old.adapter.close();
});

test('only approved live commands opt into native expansion across delivery modes and photos', () => {
  const image = { mimeType: 'image/png', data: readFileSync(new URL('../public/icons/icon-192.png', import.meta.url)).toString('base64') };
  for (const deliverAs of ['reject', 'steer', 'followUp']) {
    for (const images of [undefined, [image]]) {
      for (const text of ['/review argument', '/skill:check argument', '/danger', '/blocked', '/unknown', 'ordinary']) {
        const h = harness({ getCommands: () => [
          { name: 'danger', source: 'extension' }, { name: 'blocked', source: 'extension' },
          { name: 'blocked', source: 'prompt' }, { name: 'review', source: 'prompt' },
          { name: 'skill:check', source: 'skill' },
        ] });
        if (deliverAs !== 'reject') { h.idle(false); h.event('agent_start'); }
        h.prompt({ text, deliverAs, ...(images ? { images } : {}) });
        assert.equal(h.calls[0].args.expandPromptTemplates, text.startsWith('/review ') || text.startsWith('/skill:check '), `${deliverAs}: ${text}`);
        h.adapter.close();
      }
    }
  }
});

test('explicit commands beyond the discovery cap still expand without relaxing native collision rules', () => {
  const catalog = [{ name: 'blocked', source: 'extension' },
    ...Array.from({ length: 130 }, (_, i) => ({ name: `p${i}`, source: 'prompt' })),
    { name: 'skill:late', source: 'skill' }, { name: 'blocked', source: 'prompt' }];
  for (const [text, expand] of [['/p129 argument', true], ['/skill:late argument', true], ['/blocked', false],
    ['/p129\targument', true], ['/p129\nargument', true], ['/skill:late\targument', false],
    ['/skill:late\nargument', false], ['/blocked\targument', false]]) {
    const h = harness({ getCommands: () => catalog });
    assert.equal(h.adapter.snapshot(h.params()).commands.length, 128);
    assert.equal(h.adapter.snapshot(h.params()).commands.some(command => command.name === 'p129'), false);
    h.prompt({ text });
    assert.equal(h.calls[0].args.expandPromptTemplates, expand, text);
    h.adapter.close();
  }
});

test('missing, throwing and malformed native command catalogs cannot enable command dispatch', () => {
  for (const catalog of [null, {}, [{ name: '/bad', source: 'prompt' }],
    [{ name: 'bad name', source: 'prompt' }], [{ name: 'bad', source: 'skill' }],
    [{ name: 'x'.repeat(101), source: 'prompt' }], [{ name: 'bad', source: 'other' }],
    [{ name: 'review', source: 'prompt', description: {} }]]) {
    const h = harness({ getCommands: () => catalog });
    assert.deepEqual(h.adapter.snapshot(h.params()).commands, []);
    h.prompt({ text: '/review argument' });
    assert.equal(h.calls[0].args.expandPromptTemplates, false);
    h.adapter.close();
  }
  const h = harness({ getCommands: () => { throw new Error('SECRET'); } });
  assert.deepEqual(h.adapter.snapshot(h.params()).commands, []);
  h.prompt({ text: '/review' });
  assert.equal(h.calls[0].args.expandPromptTemplates, false);
  h.adapter.close();
});
