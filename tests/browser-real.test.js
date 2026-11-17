import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { startDaemon } from '../dist/src/daemon.js';
import { createConnector } from '../dist/src/connector.js';

async function until(predicate, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const value = await predicate(); if (value) return value; } catch {}
    await delay(40);
  }
  throw new Error('Browser condition timed out');
}

test('real mobile browser pairs, renders safely, preserves draft focus, and reconnects',
  { skip: !process.env.PAJ_RC_BROWSER_BIN, timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'paj-rc-browser-'));
  const paths = { runtimeDir: root, socketPath: join(root, 'daemon.sock') };
  const identity = { id: randomUUID(), piSessionId: randomUUID(), pid: process.pid,
    name: 'Backend', projectRoot: '/home/developer/Development/work/client-projects/backend',
    branch: 'feature/mobile-layout', role: 'primary', parentPiSessionId: null };
  const config = { port: 0, allowedOrigins: [], idleTimeoutMs: 60000,
    pairingKey: randomBytes(32).toString('base64url') };
  const state = { busy: false, runId: null, editorBusy: false, terminalRequired: false, supportsImages: true,
    model: { id: 'gpt-6.1-sol', provider: 'openai-codex', name: 'GPT 6.1 Sol' },
    context: { tokens: 200000, contextWindow: 500000 } };
  const submissions = [];
  const nativeSteers = [];
  const commands = [
    { name: 'review', description: 'Review changes', source: 'prompt' },
    { name: 'skill:research', description: '<img src=x onerror=alert(1)> Research a topic', source: 'skill' },
  ];
  const listeners = new Set();
  let seq = 0;
  let snapshots = 0;
  const emit = event => {
    const frame = { type: 'event', seq: ++seq, event };
    for (const listener of listeners) listener(frame);
  };
  const adapter = { identity, generation: randomUUID(), eligible: () => true, state: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    snapshot() { snapshots++; return { sessionId: identity.piSessionId, generation: this.generation, seq, state, commands,
      messages: [
        { id: 'older-user', role: 'user', text: 'Review the earlier changes' },
        { id: 'm1', role: 'assistant', text: '<img src=x onerror=alert(1)> Safe text' },
        { id: 'latest-user', role: 'user', text: 'Check the latest changes' },
        { id: 'paj', role: 'assistant', customType: 'paj-messages',
          text: '## Agent review\n\n**All checks passed.**\n\n- Updated `src/app.js`\n- Preserved your changes\n\n```js\nconst safe = true;\n```\n\n<img src=x onerror=alert(1)>\n\n[Unsafe](javascript:alert(1))' },
        ...nativeSteers,
      ], hasMore: false, before: null }; },
    prompt(params) { submissions.push(params); return { status: 'submitted', requestId: params.requestId }; } };
  let daemon = await startDaemon(config, { paths, listSessions: async () => [identity] });
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
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await call('Page.navigate', { url: daemon.address });
  await until(() => evaluate('document.querySelector("#key") && document.readyState === "complete"'));
  await until(() => evaluate('navigator.serviceWorker.controller !== null'));
  assert.equal(await evaluate('document.querySelector("#deliver-as").value'), 'steer');
  const manifest = await call('Page.getAppManifest');
  assert.deepEqual(manifest.errors, []);
  assert.equal(JSON.parse(manifest.data).display, 'standalone');
  const installability = await call('Page.getInstallabilityErrors');
  assert.deepEqual(installability.installabilityErrors, []);
  await evaluate(`document.querySelector('#key').value = ${JSON.stringify(config.pairingKey)}; document.querySelector('#login-form').requestSubmit(); true`);
  await until(() => evaluate('document.querySelectorAll(".session-card").length === 1'));
  assert.equal(await evaluate('document.querySelector(".session-card .agent-model").textContent'), 'gpt-6.1-sol');
  assert.equal(await evaluate('document.querySelector(".session-card .agent-context").textContent'), 'context: 200k/500k');
  state.model = { id: 'gpt-6-astra', provider: 'openai-codex', name: 'GPT 6 Astra' };
  emit({ type: 'state', state: { ...state } });
  await until(() => evaluate('document.querySelector(".session-card .agent-model").textContent === "gpt-6-astra"'));
  await evaluate('document.querySelector(".session-card").click(); true');
  await until(() => evaluate('!document.querySelector("#prompt").disabled && document.querySelector(".message.paj")'));
  assert.equal(await evaluate('document.querySelector("#session-metadata .agent-model").textContent'), 'gpt-6-astra');
  assert.equal(await evaluate('document.querySelector("#session-metadata .agent-context").textContent'), 'context: 200k/500k');
  state.context = { tokens: null, contextWindow: 500000 };
  emit({ type: 'state', state: { ...state } });
  await until(() => evaluate('document.querySelector("#session-metadata .agent-context").textContent === "context: —/500k"'));
  state.context = { tokens: 200000, contextWindow: 500000 };
  emit({ type: 'state', state: { ...state } });
  await until(() => evaluate('document.querySelector("#session-metadata .agent-context").textContent === "context: 200k/500k"'));
  assert.equal(await evaluate('document.querySelector("#photo-status").textContent'), '');
  await evaluate(`(() => {
    const input = document.querySelector('#prompt'); input.focus(); input.value = '/';
    input.setSelectionRange(1, 1); input.dispatchEvent(new Event('input'));
  })()`);
  assert.equal(await evaluate('document.querySelectorAll(".command-option").length'), 2);
  assert.equal(await evaluate('document.querySelectorAll("#command-completions img").length'), 0);
  assert.equal(await evaluate('document.querySelector("#command-completions").textContent.includes("<img src=x")'), true);
  await evaluate('window.menuOption = document.querySelector(".command-option"); true');
  emit({ type: 'state', state: { ...state } });
  await delay(40);
  assert.equal(await evaluate('window.menuOption === document.querySelector(".command-option")'), true,
    'Streaming state updates must not replace the option beneath a tapping finger');
  await evaluate(`document.querySelector('#prompt').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true })); true`);
  assert.equal(await evaluate('document.querySelector("#prompt").getAttribute("aria-activedescendant")'), 'command-option-0');
  await evaluate(`document.querySelector('#prompt').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, cancelable: true })); true`);
  assert.equal(await evaluate('document.querySelector("#prompt").value'), '/');
  await evaluate(`document.querySelector('#prompt').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })); true`);
  assert.equal(await evaluate('document.querySelector("#prompt").value'), '/review ');
  assert.equal(await evaluate('document.querySelector("#command-completions").hidden'), true);
  assert.equal(submissions.length, 0, 'Completion must never submit');
  await evaluate(`(() => {
    const input = document.querySelector('#prompt'); input.value = '/re "API safety"';
    input.setSelectionRange(3, 3); input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape' }));
  })()`);
  assert.equal(await evaluate('document.querySelector("#command-completions").hidden'), true);
  await evaluate(`document.querySelector('#prompt').dispatchEvent(new Event('input')); true`);
  await call('Emulation.setTouchEmulationEnabled', { enabled: true });
  const commandTarget = await evaluate(`(() => {
    const rect = document.querySelectorAll('.command-option')[1].getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [commandTarget] });
  await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await until(() => evaluate('document.querySelector("#prompt").value === \'/skill:research "API safety"\''));
  assert.equal(await evaluate('document.activeElement === document.querySelector("#prompt")'), true);
  assert.equal(await evaluate('document.querySelector("#prompt").selectionStart'), 16);
  assert.equal(submissions.length, 0);
  await evaluate('document.querySelector("#prompt").value = ""; document.querySelector("#prompt").dispatchEvent(new Event("input")); true');
  assert.equal(await evaluate('document.querySelector("#messages").textContent.includes("<img src=x")'), true);
  assert.equal(await evaluate('document.querySelectorAll("#messages img").length'), 0);
  assert.equal(await evaluate('document.querySelector("#back").textContent'), '/sessions');
  assert.equal(await evaluate('document.querySelector(".back-arrow")'), null);
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".back-slash")).color'), 'rgb(239, 83, 80)');
  assert.equal(await evaluate('document.querySelector("#session-status")'), null);
  assert.equal(await evaluate(`(() => {
    const title = document.querySelector('.heading').getBoundingClientRect();
    const back = document.querySelector('#back').getBoundingClientRect();
    return title.right <= back.left && back.bottom > title.top && back.top < title.bottom;
  })()`), true);
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#back")).borderTopWidth'), '0px');
  assert.equal(await evaluate('document.querySelector(".delivery").nextElementSibling.id'), 'send');
  assert.equal(await evaluate('document.querySelector("#delivery-current").textContent'), 'Steer');
  for (const [value, label] of [['followUp', 'Queue follow-up'], ['reject', 'Reject'], ['steer', 'Steer']]) {
    await evaluate(`(() => {
      const mode = document.querySelector('#deliver-as');
      mode.value = ${JSON.stringify(value)}; mode.dispatchEvent(new Event('change'));
    })()`);
    assert.equal(await evaluate('document.querySelector("#delivery-current").textContent'), label);
  }
  await evaluate('document.querySelector("#deliver-as").focus(); true');
  assert.equal(await evaluate('document.activeElement.id'), 'deliver-as');
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".delivery")).outlineStyle'), 'solid');
  assert.equal(await evaluate(`(() => {
    const rect = document.querySelector('#back').getBoundingClientRect();
    return rect.height >= 44 && rect.width < 220;
  })()`), true);
  await evaluate('document.querySelector("#back").click(); true');
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".sidebar")).display'), 'flex');
  await evaluate('document.querySelector(".session-card").click(); true');
  await until(() => evaluate('document.querySelector(".message.paj")'));
  assert.equal(await evaluate('document.querySelector(".message.paj > .message-role").textContent'), 'Paj agents');
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".heading h2"), "::before").content'), '"# "');
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".message.paj h2"), "::before").content'), '"## "');
  assert.equal(await evaluate('document.querySelector(".message.paj h2").textContent'), 'Agent review');
  assert.equal(await evaluate('document.querySelector(".message.paj strong").textContent'), 'All checks passed.');
  assert.equal(await evaluate('document.querySelectorAll(".message.paj ul li").length'), 2);
  assert.equal(await evaluate('document.querySelector(".message.paj pre code").textContent.trim()'), 'const safe = true;');
  assert.equal(await evaluate('document.querySelector(".message.paj").textContent.includes("<img src=x")'), true);
  assert.equal(await evaluate('document.querySelectorAll(".message.paj a").length'), 0);
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".message.paj")).backgroundColor'), 'rgb(240, 232, 250)');
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".message.paj")).backgroundColor'), 'rgb(48, 33, 63)');
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  assert.equal(await evaluate('document.querySelector("#composer-hint").hidden'), true);
  assert.equal(await evaluate('document.querySelector("#composer-hint").textContent'), '');
  assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'), 'rgb(255, 255, 255)');
  await evaluate('document.fonts.ready');
  assert.equal(await evaluate('document.fonts.check(\'14px "Fira Code"\')'), true);
  assert.equal(await evaluate('document.fonts.check(\'24px "Space Grotesk"\')'), true);
  assert.equal(await evaluate('document.title'), 'paj-rc');
  assert.equal(await evaluate('document.querySelector(".sidebar-header .brand").textContent'), '# paj-rc');
  for (const [scheme, colour] of [['light', 'rgb(230, 230, 230)'], ['dark', 'rgb(56, 56, 56)']]) {
    await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    const divider = await evaluate(`(() => {
      const card = document.querySelector('.session-card');
      const next = card.cloneNode(true);
      card.after(next);
      const style = getComputedStyle(card);
      const result = { width: style.borderBottomWidth, colour: style.borderBottomColor,
        gap: style.gap, spacing: style.marginBottom, lastColour: getComputedStyle(next).borderBottomColor };
      next.remove();
      return result;
    })()`);
    assert.deepEqual(divider, { width: '1px', colour, gap: '8px', spacing: '10px', lastColour: 'rgba(0, 0, 0, 0)' });
  }
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#refresh")).color'), 'rgb(239, 83, 80)');
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".session-separator")).color'), 'rgb(239, 83, 80)');
  const pathCandidates = [identity.projectRoot, ...identity.projectRoot.split('/').filter(Boolean)
    .map((_, index, parts) => `../${parts.slice(index + 1).join('/')}`).slice(0, -1)];
  for (const width of [320, 390, 768]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
    await delay(80);
    const layout = await evaluate(`(() => {
      const context = document.querySelector('#session-context');
      const branch = context.querySelector('.context-branch');
      return { path: context.querySelector('.context-path').textContent, branch: branch.textContent,
        fits: context.scrollWidth <= context.clientWidth + 1,
        clipped: getComputedStyle(context).textOverflow === 'ellipsis' };
    })()`);
    assert.ok(pathCandidates.includes(layout.path), layout.path);
    assert.equal(layout.branch, identity.branch);
    assert.equal(layout.fits, true);
    assert.equal(layout.clipped, false);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    assert.equal(await evaluate('document.querySelector("#session-metadata").scrollWidth <= document.querySelector(".heading").clientWidth + 1'), true);
  }
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate('document.querySelector("#working-indicator").hidden'), true);
  await evaluate(`(() => {
    const input = document.querySelector('#prompt');
    input.focus(); input.value = 'Keep typing this draft'; input.setSelectionRange(5, 9);
    window.draftBlurs = 0; input.addEventListener('blur', () => window.draftBlurs++);
  })()`);
  const previousSnapshots = snapshots;
  emit({ type: 'reset' });
  await until(() => snapshots > previousSnapshots);
  await until(() => evaluate('document.querySelector("#composer-hint").hidden'));
  assert.equal(await evaluate('window.draftBlurs'), 0, 'history sync must not blur the composer');
  assert.deepEqual(await evaluate(`(() => {
    const input = document.querySelector('#prompt');
    return [document.activeElement === input, input.value, input.selectionStart, input.selectionEnd];
  })()`), [true, 'Keep typing this draft', 5, 9]);
  Object.assign(state, { busy: true, runId: 'run' });
  emit({ type: 'state', state: { ...state } });
  await until(() => evaluate('!document.querySelector("#working-indicator").hidden'));
  assert.equal(await evaluate('document.querySelector("#working-indicator").parentElement.id'), 'composer');
  assert.equal(await evaluate(`(() => {
    const progress = document.querySelector('#working-indicator').getBoundingClientRect();
    const input = document.querySelector('#prompt').getBoundingClientRect();
    return progress.bottom <= input.top;
  })()`), true);
  const progressTop = await evaluate('document.querySelector("#working-indicator").getBoundingClientRect().top');
  emit({ type: 'message', message: { id: 'tool', role: 'tool', text: 'Tool update\n'.repeat(150) } });
  await until(() => evaluate('document.querySelector("#messages").textContent.includes("Tool update")'));
  assert.equal(await evaluate('document.querySelector("#working-indicator").getBoundingClientRect().top'), progressTop);
  const expectedFrames = [...'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'];
  const sequence = await evaluate(`(() => {
    const spinner = document.querySelector('#working-spinner');
    const track = spinner.querySelector('.working-spinner-frames');
    const animation = track.getAnimations()[0];
    const glyphs = track.textContent.split('\\n');
    const duration = animation.effect.getTiming().duration;
    animation.pause();
    const sequence = Array.from({ length: 11 }, (_, index) => {
      animation.currentTime = index === 10 ? duration : (index + 0.5) * duration / 10;
      const y = new DOMMatrixReadOnly(getComputedStyle(track).transform).m42;
      return glyphs[Math.round(-y / spinner.getBoundingClientRect().height)];
    });
    animation.play();
    return sequence;
  })()`);
  assert.deepEqual(sequence, [...expectedFrames, expectedFrames[0]],
    'spinner must display all ten frames and loop without an empty frame');
  const frames = new Set();
  for (let index = 0; index < 6; index++) {
    emit({ type: 'delta', messageId: 'm1', text: '.' });
    await delay(70);
    frames.add(await evaluate('getComputedStyle(document.querySelector(".working-spinner-frames")).transform'));
  }
  assert.ok(frames.size > 1, 'terminal spinner must keep animating while text streams');
  assert.deepEqual(await evaluate(`(() => {
    const input = document.querySelector('#prompt');
    return [document.activeElement === input, input.value, input.selectionStart, input.selectionEnd];
  })()`), [true, 'Keep typing this draft', 5, 9]);
  const toolSnapshots = snapshots;
  emit({ type: 'reset' });
  await until(() => snapshots > toolSnapshots);
  await until(() => evaluate('!document.querySelector("#messages").textContent.includes("Tool update")'));
  assert.equal(await evaluate('document.activeElement === document.querySelector("#prompt")'), true);
  assert.equal(await evaluate('document.querySelector("#working-indicator").hidden'), false);
  assert.equal(await evaluate('document.querySelector("#working-spinner").getAttribute("aria-hidden")'), 'true');
  await call('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' },
  ] });
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".working-spinner-frames")).animationName'), 'none');
  const workingScreenshot = process.env.PAJ_RC_WORKING_SCREENSHOT;
  if (workingScreenshot) {
    const shot = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(workingScreenshot, Buffer.from(shot.data, 'base64'));
  }
  Object.assign(state, { busy: false, runId: null });
  emit({ type: 'state', state: { ...state } });
  await until(() => evaluate('document.querySelector("#working-indicator").hidden'));
  const formId = await evaluate('document.querySelector("#prompt").form.id');
  await evaluate(`document.querySelector('#prompt').value = 'Run backend tests'; document.querySelector('#prompt').dispatchEvent(new Event('input')); document.querySelector(${JSON.stringify(`#${formId}`)}).requestSubmit(); true`);
  await until(() => submissions.length === 1);
  assert.equal(submissions[0].text, 'Run backend tests');
  assert.equal(submissions[0].generation, adapter.generation);
  assert.equal(submissions[0].deliverAs, 'steer');
  await until(() => evaluate('document.querySelector("#prompt").value === ""'));
  assert.equal(await evaluate('document.querySelector("#notice").hidden'), true);
  assert.equal(await evaluate('document.querySelector("#working-indicator").hidden'), true);
  Object.assign(state, { busy: true, runId: 'steering-run' });
  emit({ type: 'state', state: { ...state } });
  await until(() => evaluate('!document.querySelector("#stop").disabled'));
  await evaluate(`(() => {
    const originalFetch = window.fetch;
    window.holdSteeringResponse = true;
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (window.holdSteeringResponse && String(args[0]).endsWith('/prompt')) {
        window.holdSteeringResponse = false;
        await new Promise(resolve => { window.releaseSteeringResponse = resolve; });
      }
      return response;
    };
  })()`);
  for (const [index, text] of ['First steer', 'Second steer'].entries()) {
    await evaluate(`(() => {
      const input = document.querySelector('#prompt');
      input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event('input'));
      if (document.querySelector('#send').disabled) throw new Error('Steering unexpectedly disabled');
      input.form.requestSubmit();
    })()`);
    await until(() => submissions.length === index + 2);
    if (index === 0) {
      assert.equal(await evaluate('document.querySelector(".message.steering .message-role").textContent'), 'Steering · submitting…');
      assert.equal(await evaluate('document.querySelector(".message.steering .message-text").textContent'), text);
      await until(() => evaluate('typeof window.releaseSteeringResponse === "function"'));
      await evaluate('window.releaseSteeringResponse(); true');
    }
    await until(() => evaluate('document.querySelector("#prompt").value === ""'));
    assert.equal(await evaluate('document.querySelectorAll(".message.steering").length'), index + 1);
    assert.equal(await evaluate('document.querySelectorAll(".message.steering .message-role")[0].textContent'), 'Steering · submitted');
    assert.equal(submissions[index + 1].text, text);
    assert.equal(submissions[index + 1].deliverAs, 'steer');
  }
  nativeSteers.push({ id: 'native-steer-one', role: 'user', text: 'First steer' });
  emit({ type: 'message', message: nativeSteers[0] });
  await until(() => evaluate('[...document.querySelectorAll(".message.steering .message-role")].some(node => node.textContent === "Steering")'));
  assert.equal(await evaluate('[...document.querySelectorAll(".message-text")].filter(node => node.textContent === "First steer").length'), 1);
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".message.steering")).color !== getComputedStyle(document.querySelector(".message.user:not(.steering)")).color'), true);
  Object.assign(state, { busy: false, runId: null });
  emit({ type: 'state', state: { ...state } });
  await until(() => evaluate('document.querySelector("#working-indicator").hidden'));
  await evaluate(`(async () => {
    const noise = document.createElement('canvas'); noise.width = noise.height = 800;
    const context = noise.getContext('2d');
    const pixels = context.createImageData(800, 800); let seed = 12345;
    for (let index = 0; index < pixels.data.length; index += 4) {
      for (let channel = 0; channel < 3; channel++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
        pixels.data[index + channel] = seed >>> 24;
      }
      pixels.data[index + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    const large = document.createElement('canvas'); large.width = 3000; large.height = 1800;
    large.getContext('2d').fillRect(0, 0, 3000, 1800);
    const toFile = async (canvas, name) => new File([
      await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
    ], name, { type: 'image/png' });
    window.testPhotos = [await toFile(noise, 'camera-photo.png'), await toFile(large, 'large-photo.png')];
    const transfer = new DataTransfer(); for (const file of window.testPhotos) transfer.items.add(file);
    const picker = document.querySelector('#photo-library'); picker.files = transfer.files;
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await until(() => evaluate('document.querySelectorAll(".photo-preview img").length === 2'), 10000);
  await until(() => evaluate('[...document.querySelectorAll(".photo-preview img")].every(image => image.naturalWidth > 0)'));
  assert.equal(await evaluate('document.querySelectorAll(".photo-preview img")[1].naturalWidth'), 1600);
  assert.equal(await evaluate('[...document.querySelectorAll(".photo-preview img")].every(image => image.src.startsWith("blob:"))'), true);
  assert.equal(await evaluate('document.querySelector("#photo-camera").getAttribute("capture")'), 'environment');
  assert.equal(await evaluate('document.querySelector("#send").disabled'), false);
  assert.equal(await evaluate('document.querySelector("#photo-status").textContent.includes("Up to")'), false);
  await evaluate(`(() => {
    const transfer = new DataTransfer();
    for (const file of window.testPhotos) transfer.items.add(file);
    const picker = document.querySelector('#photo-library'); picker.files = transfer.files;
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await until(() => evaluate('document.querySelectorAll(".photo-preview img").length === 3'), 10000);
  assert.equal(await evaluate('document.querySelector("#attach-photo").disabled && document.querySelector("#take-photo").disabled'), true);
  assert.equal(await evaluate('document.querySelector("#photo-status").textContent'), '3 photos attached');
  await evaluate('[...document.querySelectorAll(".photo-remove")].at(-1).click(); true');
  assert.equal(await evaluate('document.querySelectorAll(".photo-preview img").length'), 2);
  assert.equal(await evaluate('document.querySelector("#attach-photo").disabled'), false);
  const photoScreenshot = process.env.PAJ_RC_PHOTO_SCREENSHOT;
  if (photoScreenshot) {
    const shot = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(photoScreenshot, Buffer.from(shot.data, 'base64'));
  }
  await evaluate('document.querySelector("#composer").requestSubmit(); true');
  await until(() => submissions.length === 4);
  await until(() => evaluate('document.querySelector("#photo-previews").hidden'));
  assert.equal(submissions[3].text, '');
  assert.equal(submissions[3].images.length, 2);
  assert.equal(submissions[3].images[0].mimeType, 'image/jpeg');
  assert.ok(Buffer.from(submissions[3].images[0].data, 'base64').length > 128 * 1024);
  assert.ok(submissions[3].images.every(image => Buffer.from(image.data, 'base64').length <= 512 * 1024));
  await evaluate(`(() => {
    const transfer = new DataTransfer(); transfer.items.add(window.testPhotos[0]);
    const picker = document.querySelector('#photo-library'); picker.files = transfer.files;
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await until(() => evaluate('document.querySelectorAll(".photo-preview img").length === 1'), 10000);
  Object.assign(state, { supportsImages: false }); emit({ type: 'state', state: { ...state } });
  await until(() => evaluate('document.querySelector("#photo-status").textContent.includes("does not support")'));
  assert.equal(await evaluate('document.querySelector("#send").disabled'), true);
  await evaluate('document.querySelector(".photo-remove").click(); true');
  assert.equal(await evaluate('document.querySelector("#photo-previews").hidden'), true);
  Object.assign(state, { supportsImages: true }); emit({ type: 'state', state: { ...state } });
  await until(() => evaluate('!document.querySelector("#attach-photo").disabled'));
  await evaluate(`(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'unsafe.svg', { type: 'image/svg+xml' }));
    const picker = document.querySelector('#photo-library'); picker.files = transfer.files;
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await until(() => evaluate('document.querySelector("#photo-status").getAttribute("data-error") === "true"'));
  assert.equal(await evaluate('document.querySelector("#photo-previews").hidden'), true);
  assert.equal(submissions.length, 4);
  const cached = await evaluate(`(async () => Promise.all((await caches.keys()).map(async name =>
    (await (await caches.open(name)).keys()).map(request => new URL(request.url).pathname))))()`);
  assert.ok(cached.flat().includes('/'));
  assert.ok(cached.flat().includes('/markdown.js'));
  assert.equal(cached.flat().some(path => path.startsWith('/api/')), false);
  assert.equal(exceptions.length, 0);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  assert.equal(await evaluate(`(() => {
    const mode = document.querySelector('.delivery').getBoundingClientRect();
    const actions = document.querySelector('.send-actions').getBoundingClientRect();
    return Math.abs(mode.top - actions.top) < 2;
  })()`), true, 'mobile send controls should fit on one row');
  const screenshot = await call('Page.captureScreenshot', { format: 'png' });
  const screenshotPath = process.env.PAJ_RC_SCREENSHOT;
  if (screenshotPath) await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  const darkScreenshotPath = process.env.PAJ_RC_DARK_SCREENSHOT;
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'), 'rgb(18, 18, 18)');
  if (darkScreenshotPath) {
    const dark = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(darkScreenshotPath, Buffer.from(dark.data, 'base64'));
  }
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 430, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  assert.equal(await evaluate('document.querySelector("#prompt").getBoundingClientRect().bottom <= innerHeight'), true);
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  const desktopScreenshotPath = process.env.PAJ_RC_DESKTOP_SCREENSHOT;
  if (desktopScreenshotPath) {
    const desktop = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(desktopScreenshotPath, Buffer.from(desktop.data, 'base64'));
  }
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const address = daemon.address;
  config.port = Number(new URL(address).port);
  config.allowedOrigins = [address];
  await daemon.close();
  await until(() => evaluate('document.querySelector("#notice").textContent.includes("Connection interrupted")'));
  assert.equal(await evaluate('document.activeElement === document.querySelector("#prompt")'), true);
  daemon = await startDaemon(config, { paths, listSessions: async () => [identity] });
  await until(() => evaluate('document.querySelector("#connection").textContent === "Connected" && document.querySelector("#notice").hidden'));
  assert.equal(await evaluate('document.activeElement === document.querySelector("#prompt")'), true);
  assert.equal(await evaluate('document.querySelector(".message.paj h2").textContent'), 'Agent review');
  await daemon.close();
  await call('Page.reload');
  await until(() => evaluate('document.querySelector("#login-error")?.textContent.includes("Cannot reach")'));
  assert.equal(await evaluate('document.querySelector("#messages").children.length'), 0);
  assert.equal(await evaluate(`fetch('/api/auth').then(() => false, () => true)`), true);
  daemon = await startDaemon(config, { paths, listSessions: async () => [identity] });
  await call('Page.reload');
  await until(() => evaluate('document.querySelector("#login").hidden && document.querySelectorAll(".session-card").length === 1'));
  assert.equal(submissions.length, 4);
});
