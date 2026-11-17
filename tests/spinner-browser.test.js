import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { inflateSync } from 'node:zlib';

function pixels(png) {
  const data = Buffer.from(png, 'base64');
  const chunks = [];
  let width, height, channels;
  for (let offset = 8; offset < data.length;) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('ascii', offset + 4, offset + 8);
    const chunk = data.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4);
      assert.equal(chunk[8], 8);
      assert.ok([2, 6].includes(chunk[9]));
      channels = chunk[9] === 2 ? 3 : 4;
    }
    if (type === 'IDAT') chunks.push(chunk);
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const result = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const left = x < channels ? 0 : result[y * stride + x - channels];
      const up = y === 0 ? 0 : result[(y - 1) * stride + x];
      const corner = y === 0 || x < channels ? 0 : result[(y - 1) * stride + x - channels];
      const p = left + up - corner;
      const a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - corner);
      const predictor = [0, left, up, Math.floor((left + up) / 2),
        a <= b && a <= c ? left : b <= c ? up : corner][filter];
      assert.notEqual(predictor, undefined);
      result[y * stride + x] = (raw[y * (stride + 1) + x + 1] + predictor) & 255;
    }
  }
  const ink = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * stride + x * channels;
    if (result[offset] > result[offset + 1] + 30) ink.push([x, y]);
  }
  return { data: result, width, height, ink };
}

async function until(predicate) {
  for (let n = 0; n < 200; n++) {
    try { const value = await predicate(); if (value) return value; } catch {}
    await delay(25);
  }
  throw new Error('Browser condition timed out');
}

test('spinner paints every complete glyph at a stable baseline, including the wrap',
  { skip: !process.env.PAJ_RC_BROWSER_BIN, timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'paj-spinner-'));
  const css = await readFile(new URL('../dist/public/style.css', import.meta.url));
  const app = await readFile(new URL('../dist/public/app.js', import.meta.url), 'utf8');
  const setup = app.slice(app.indexOf('const $ ='), app.indexOf('let csrfToken;'));
  const server = createServer(async (req, res) => {
    if (req.url === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end(css); }
    else if (req.url.startsWith('/fonts/')) {
      res.end(await readFile(new URL(`../dist/public${req.url}`, import.meta.url)));
    } else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="composer"></div>
        <script>${setup}; workingIndicator.hidden = false;</script>
        <style>#composer { position:absolute; left:20px; top:20.75px; padding:0; }
        .working-indicator { position:static; } body { margin:0; }</style>`);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const profile = join(root, 'browser');
  const browser = spawn(process.env.PAJ_RC_BROWSER_BIN, ['--headless=new', '--no-sandbox',
    '--disable-gpu', '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-extensions', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`], { stdio: 'ignore' });
  let socket;
  t.after(async () => {
    socket?.close(); browser.kill('SIGTERM');
    await Promise.race([once(browser, 'exit').catch(() => {}), delay(2000)]);
    if (browser.exitCode === null) browser.kill('SIGKILL');
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const port = await until(async () => (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(value => value.type === 'page').webSocketDebuggerUrl);
  await once(socket, 'open');
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const frame = JSON.parse(event.data);
    const task = pending.get(frame.id);
    if (!task) return;
    pending.delete(frame.id);
    if (frame.error) task.reject(new Error(frame.error.message)); else task.resolve(frame.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}` });
  await until(() => evaluate('document.querySelector(".working-spinner-frames") && document.readyState === "complete"'));
  await evaluate('document.fonts.ready');
  const failures = [];
  for (const deviceScaleFactor of [1, 2, 3]) {
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor, mobile: true });
    for (const family of ['', 'monospace']) {
      const geometry = await evaluate(`(() => {
        const spinner = document.querySelector('.working-spinner');
        spinner.style.fontFamily = ${JSON.stringify(family)};
        const frames = document.querySelector('.working-spinner-frames');
        window.animation = frames.getAnimations()[0]; animation.pause();
        window.original = frames.textContent;
        const r = spinner.getBoundingClientRect();
        return { x:r.x, y:r.y, width:r.width, height:r.height, scale:1,
          lineHeight:getComputedStyle(spinner).lineHeight, spriteHeight:frames.getBoundingClientRect().height };
      })()`);
      const { lineHeight, spriteHeight, ...clip } = geometry;
      const capture = async () => (await call('Page.captureScreenshot', { format: 'png', clip })).data;
      for (const time of [0, 40, 79.999, 80.001, 120, 200, 280, 360, 440, 520, 600, 680, 760, 799.999, 800, 800.001, 840]) {
        const index = Math.floor(time / 80) % 10;
        await evaluate(`animation.currentTime = ${time}; true`);
        const actual = pixels(await capture());
        await evaluate(`(() => {
          const frames = document.querySelector('.working-spinner-frames');
          frames.style.animation = 'none'; frames.style.transform = 'none';
          frames.textContent = [...'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'][${index}];
        })()`);
        const expected = pixels(await capture());
        assert.ok(expected.ink.length > 0, `reference glyph ${index} must not be blank`);
        assert.ok(expected.ink.every(([x, y]) => x > 0 && x < expected.width - 1 && y > 0 && y < expected.height - 1),
          `reference glyph ${index} must fit inside the clip`);
        if (!actual.data.equals(expected.data)) failures.push({ index, time, deviceScaleFactor, family, geometry,
          actualRows: [...new Set(actual.ink.map(([, y]) => y))],
          expectedRows: [...new Set(expected.ink.map(([, y]) => y))] });
        await evaluate(`(() => {
          const frames = document.querySelector('.working-spinner-frames');
          frames.textContent = original; frames.style.animation = ''; frames.style.transform = '';
          animation = frames.getAnimations()[0]; animation.pause();
        })()`);
      }
    }
  }
  assert.deepEqual(failures, [], 'paint must match each complete stationary glyph without baseline jumps');
  await evaluate(`document.querySelector('#working-indicator').hidden = true; true`);
  assert.equal(await evaluate(`document.querySelector('.working-spinner-frames').getAnimations().length`), 0);
  await evaluate(`document.querySelector('#working-indicator').hidden = false; true`);
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.deepEqual(await evaluate(`(() => {
    const frames = document.querySelector('.working-spinner-frames');
    return { animations: frames.getAnimations().length, transform: getComputedStyle(frames).transform,
      hiddenFromAT: document.querySelector('#working-spinner').getAttribute('aria-hidden'),
      role: document.querySelector('#working-indicator').getAttribute('role') };
  })()`), { animations: 0, transform: 'none', hiddenFromAT: 'true', role: 'status' });
});
