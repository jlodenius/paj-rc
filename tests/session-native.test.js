import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createSessionAdapter } from '../dist/src/session.js';

async function until(predicate) {
  for (let n = 0; n < 500; n++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail('Native session condition timed out');
}

test('isolated native Pi executes extension commands and expands loaded skills/templates',
  { skip: !process.env.PAJ_RC_PI_MODULE, timeout: 20000 }, async t => {
  const moduleUrl = pathToFileURL(process.env.PAJ_RC_PI_MODULE);
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(moduleUrl);
  const { createAssistantMessageEventStream } = await import(new URL('../node_modules/@earendil-works/pi-ai/dist/index.js', moduleUrl));
  const root = await mkdtemp(join(tmpdir(), 'paj-rc-native-'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Network forbidden in native smoke test'); };
  let session, adapter;
  t.after(async () => {
    adapter?.close(); session?.dispose(); globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  });
  const skillPath = join(root, 'SKILL.md');
  await writeFile(skillPath, '---\nname: check\ndescription: Check fixture\n---\nSKILL_BODY_FIXTURE');
  const modelRuntime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null,
    modelsStorePath: join(root, 'models-cache.json'), refreshOnCreate: false, allowModelNetwork: false });
  let requests = 0;
  let holdStream = false;
  let finishStream;
  modelRuntime.registerProvider('paj-test-only', { api: 'openai-completions', apiKey: 'not-a-real-credential',
    baseUrl: 'http://127.0.0.1:1/never-used',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model) {
      requests++;
      const stream = createAssistantMessageEventStream();
      const message = { role: 'assistant', content: [{ type: 'text', text: 'Fixture response' }],
        api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const finish = () => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); };
      if (holdStream) finishStream = finish;
      else queueMicrotask(finish);
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false },
    cacheWarming: { enabled: false } });
  let extensionCalls = 0;
  let finishDelayed;
  let delayedDone = false;
  let finishSelect;
  const errors = [];
  const sourceInfo = { path: skillPath, source: 'fixture', scope: 'temporary', origin: 'top-level' };
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: 'Fixture only',
    skillsOverride: () => ({ skills: [{ name: 'check', description: 'Check fixture', filePath: skillPath,
      baseDir: root, sourceInfo }], diagnostics: [] }),
    promptsOverride: () => ({ prompts: [
      { name: 'review', description: 'Review fixture', content: 'TEMPLATE_BODY $1 / $@', sourceInfo },
      { name: 'blocked', description: 'Shadowed', content: 'NEVER_EXPAND', sourceInfo },
    ], diagnostics: [] }),
    extensionFactories: [pi => {
      pi.registerCommand('blocked', { handler: async args => { extensionCalls++; assert.equal(args, 'exact arguments'); } });
      pi.registerCommand('x'.repeat(101), { handler: async () => { extensionCalls++; } });
      pi.registerCommand('delayed', { handler: async () => {
        await new Promise(resolve => { finishDelayed = resolve; });
        delayedDone = true;
      } });
      pi.registerCommand('broken', { handler: async () => {
        await Promise.resolve();
        throw new Error('Expected command failure');
      } });
      pi.registerCommand('choose', { handler: async (_args, ctx) => { await ctx.ui.select('Fixture choice', ['Yes']); } });
      pi.registerCommand('start-run', { handler: async () => { pi.sendUserMessage('Started by command'); } });
      pi.on('session_start', (_event, ctx) => {
        const identity = { id: 'fixture', piSessionId: ctx.sessionManager.getSessionId(), pid: process.pid, role: 'primary' };
        const reservations = new Set();
        const paj = { version: 1, getSnapshot: () => ({ identity, editorBusy: false }),
          tryReserve: token => { reservations.add(token); return true; }, release: token => reservations.delete(token) };
        adapter = createSessionAdapter({ pi, ctx, paj, env: {} });
      });
    }],
  });
  await loader.reload();
  ({ session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime,
    model: modelRuntime.getModel('paj-test-only', 'fixture'), resourceLoader: loader,
    noTools: true, sessionManager: SessionManager.inMemory(root), settingsManager }));
  await session.bindExtensions({ mode: 'tui', uiContext: {
    select: () => new Promise(resolve => { finishSelect = resolve; }),
  }, onError: error => errors.push(error) });
  assert.equal(adapter.eligible(), true);
  assert.deepEqual(adapter.snapshot({ generation: adapter.generation }).commands.map(command => command.name), ['blocked', 'x'.repeat(101), 'delayed', 'broken', 'choose', 'start-run', 'review', 'skill:check']);
  let submitted = 0;
  async function submit(text) {
    adapter.prompt({ generation: adapter.generation, requestId: `request-${++submitted}`, text, deliverAs: 'reject' });
    await until(() => session.isIdle && session.messages.filter(message => message.role === 'user').length === submitted);
    return session.messages.filter(message => message.role === 'user').at(-1).content.map(part => part.type === 'text' ? part.text : '').join('');
  }
  assert.equal(await submit('/review "two words" tail'), 'TEMPLATE_BODY two words / two words tail');
  const skill = await submit('/skill:check inspect this');
  assert.match(skill, /<skill name="check"/);
  assert.match(skill, /SKILL_BODY_FIXTURE/);
  assert.match(skill, /inspect this$/);
  const command = { generation: adapter.generation, requestId: 'extension-one',
    text: '/blocked exact arguments', deliverAs: 'reject' };
  adapter.prompt(command);
  await until(() => extensionCalls === 1);
  assert.equal(adapter.state().busy, false, 'a command with no agent run must not leave a submission lease');
  assert.equal(adapter.prompt(command).duplicate, true);
  assert.equal(extensionCalls, 1, 'duplicate requests never repeat command side effects');
  assert.equal(await submit('/unknown'), '/unknown');
  assert.equal(await submit('/review\ttabbed'), 'TEMPLATE_BODY tabbed / tabbed');
  assert.equal(await submit('/review\nmultiline'), 'TEMPLATE_BODY multiline / multiline');
  assert.equal(await submit('/skill:check\tunchanged'), '/skill:check\tunchanged');
  assert.equal(await submit('/skill:check\nunchanged'), '/skill:check\nunchanged');
  assert.equal(await submit('/blocked\tunchanged'), '/blocked\tunchanged');
  assert.equal(extensionCalls, 1);
  assert.equal(requests, 8);
  holdStream = true;
  adapter.prompt({ generation: adapter.generation, requestId: 'active-run', text: 'Keep running', deliverAs: 'reject' });
  await until(() => finishStream && !session.isIdle);
  for (const deliverAs of ['reject', 'steer', 'followUp']) {
    adapter.prompt({ generation: adapter.generation, requestId: `command-${deliverAs}`,
      text: '/blocked exact arguments', deliverAs });
    assert.equal(extensionCalls, 2 + ['reject', 'steer', 'followUp'].indexOf(deliverAs), 'native command executes before active run finishes');
  }
  assert.equal(requests, 9);
  holdStream = false;
  finishStream();
  await until(() => session.isIdle && !adapter.state().busy);
  assert.equal(session.messages.filter(message => message.role === 'user').length, 9, 'commands never became queued model input');
  adapter.prompt({ generation: adapter.generation, requestId: 'delayed', text: '/delayed', deliverAs: 'reject' });
  assert.equal(typeof finishDelayed, 'function');
  assert.equal(delayedDone, false, 'submission acknowledgement is not asynchronous completion');
  assert.equal(adapter.state().busy, false, 'command dispatch cannot retain an unobservable run lease');
  finishDelayed();
  await until(() => delayedDone);
  adapter.prompt({ generation: adapter.generation, requestId: 'broken', text: '/broken', deliverAs: 'reject' });
  await until(() => errors.length === 1);
  assert.equal(errors[0].event, 'command');
  assert.equal(errors[0].extensionPath, 'command:broken');
  assert.equal(adapter.state().busy, false, 'async command error does not permanently block remote sending');
  errors.shift();
  adapter.prompt({ generation: adapter.generation, requestId: 'choose', text: '/choose', deliverAs: 'reject' });
  await until(() => adapter.state().terminalRequired);
  assert.throws(() => adapter.prompt({ generation: adapter.generation, requestId: 'during-ui', text: '/blocked', deliverAs: 'reject' }), { code: 'terminal_required' });
  finishSelect(undefined);
  await until(() => !adapter.state().terminalRequired);
  adapter.prompt({ generation: adapter.generation, requestId: 'start-run', text: '/start-run', deliverAs: 'reject' });
  await until(() => session.isIdle && requests === 10 && !adapter.state().busy);
  adapter.prompt({ generation: adapter.generation, requestId: 'long-command', text: `/${'x'.repeat(101)}`, deliverAs: 'reject' });
  await until(() => extensionCalls === 5);
  assert.equal(adapter.state().busy, false);
  assert.deepEqual(errors, []);
});
