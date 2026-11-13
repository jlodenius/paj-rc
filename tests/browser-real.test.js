import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { startDaemon } from '../src/daemon.js';
import { createConnector } from '../src/connector.js';

async function until(predicate, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const value = await predicate(); if (value) return value; } catch {}
    await delay(40);
  }
  throw new Error('Browser condition timed out');
}

test('real mobile browser can pair, open chat, and submit without rendering executable transcript HTML',
  { skip: !process.env.PAJ_RC_BROWSER_BIN, timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'paj-rc-browser-'));
  const paths = { runtimeDir: root, socketPath: join(root, 'daemon.sock') };
  const identity = { id: randomUUID(), piSessionId: randomUUID(), pid: process.pid,
    name: 'Backend', projectRoot: '/projects/backend', role: 'primary', parentPiSessionId: null };
  const config = { port: 0, allowedOrigins: [], idleTimeoutMs: 60000,
    pairingKey: randomBytes(32).toString('base64url') };
  const state = { busy: false, runId: null, editorBusy: false, terminalRequired: false };
  const submissions = [];
  const listeners = new Set();
  const adapter = { identity, generation: randomUUID(), eligible: () => true, state: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    snapshot() { return { sessionId: identity.piSessionId, generation: this.generation, seq: 0, state,
      messages: [{ id: 'm1', role: 'assistant', text: '<img src=x onerror=alert(1)> Safe text' }],
      hasMore: false, before: null }; },
    prompt(params) { submissions.push(params); return { status: 'submitted', requestId: params.requestId }; } };
  const daemon = await startDaemon(config, { paths, listSessions: async () => [identity] });
  const connector = createConnector({ adapter, socketPath: paths.socketPath, ensureService: async () => true });
  connector.start();
  const profile = join(root, 'browser');
  const browser = spawn(process.env.PAJ_RC_BROWSER_BIN, ['--headless=new', '--no-sandbox',
    '--disable-gpu', '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-extensions', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`], { stdio: 'ignore' });
  let socket;
  t.after(async () => {
    socket?.close();
    connector.close();
    browser.kill('SIGTERM');
    await Promise.race([once(browser, 'exit').catch(() => {}), delay(2000)]);
    if (browser.exitCode === null) browser.kill('SIGKILL');
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  });
  const port = await until(async () => (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find(value => value.type === 'page');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, 'open');
  let nextId = 0;
  const pending = new Map();
  const exceptions = [];
  socket.addEventListener('message', event => {
    const frame = JSON.parse(event.data);
    if (frame.method === 'Runtime.exceptionThrown') exceptions.push(frame.params.exceptionDetails.text);
    const task = pending.get(frame.id);
    if (!task) return;
    pending.delete(frame.id);
    if (frame.error) task.reject(new Error(frame.error.message));
    else task.resolve(frame.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  await call('Page.enable');
  await call('Runtime.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await call('Page.navigate', { url: daemon.address });
  await until(() => evaluate('document.querySelector("#key") && document.readyState === "complete"'));
  await evaluate(`document.querySelector('#key').value = ${JSON.stringify(config.pairingKey)}; document.querySelector('#login-form').requestSubmit(); true`);
  await until(() => evaluate('document.querySelectorAll(".session-card").length === 1'));
  await evaluate('document.querySelector(".session-card").click(); true');
  await until(() => evaluate('!document.querySelector("#prompt").disabled'));
  assert.equal(await evaluate('document.querySelector("#messages").textContent.includes("<img src=x")'), true);
  assert.equal(await evaluate('document.querySelectorAll("#messages img").length'), 0);
  const formId = await evaluate('document.querySelector("#prompt").form.id');
  await evaluate(`document.querySelector('#prompt').value = 'Run backend tests'; document.querySelector('#prompt').dispatchEvent(new Event('input')); document.querySelector(${JSON.stringify(`#${formId}`)}).requestSubmit(); true`);
  await until(() => submissions.length === 1);
  assert.equal(submissions[0].text, 'Run backend tests');
  assert.equal(submissions[0].generation, adapter.generation);
  assert.equal(exceptions.length, 0);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  const screenshot = await call('Page.captureScreenshot', { format: 'png' });
  const screenshotPath = process.env.PAJ_RC_SCREENSHOT;
  if (screenshotPath) await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
});
