import { createServer, createConnection } from 'node:net';
import { mkdir, chmod, lstat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { readFrames, writeFrame, isMain } from './protocol.js';

export class RemoteError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function state(value) {
  if (!value || typeof value.busy !== 'boolean' || typeof value.editorBusy !== 'boolean' ||
      typeof value.terminalRequired !== 'boolean' ||
      !(value.runId === null || typeof value.runId === 'string')) throw new Error('Invalid session state');
  return { busy: value.busy, editorBusy: value.editorBusy, terminalRequired: value.terminalRequired,
    runId: value.runId };
}

async function removeStale(path) {
  try {
    const info = await lstat(path);
    if (!info.isSocket()) throw new Error('Refusing to replace a non-socket runtime path');
    const occupied = await new Promise(resolve => {
      const probe = createConnection(path);
      probe.once('connect', () => { probe.destroy(); resolve(true); });
      probe.once('error', error => resolve(error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT'));
      probe.setTimeout(1000, () => { probe.destroy(); resolve(true); });
    });
    if (occupied) throw new Error('Another paj-rc daemon already owns the runtime socket');
    await unlink(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function startBroker({ paths, listSessions, onEvent = () => {}, onMembership = () => {},
  heartbeatTimeoutMs = 20000, pollIntervalMs = 5000, requestTimeoutMs = 10000 }) {
  await mkdir(paths.runtimeDir, { recursive: true, mode: 0o700 });
  const directory = await lstat(paths.runtimeDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() ||
      (process.getuid && directory.uid !== process.getuid())) throw new Error('Unsafe runtime directory');
  await chmod(paths.runtimeDir, 0o700);
  await removeStale(paths.socketPath);
  const endpoints = new Map();
  const connections = new Set();
  let closed = false;
  let pollPending = false;

  const matches = (record, endpoint) => isMain(record) && record.id === endpoint.identity.id &&
    record.piSessionId === endpoint.identity.piSessionId && record.pid === endpoint.identity.pid;
  const validate = async endpoint => {
    const records = await listSessions();
    return Array.isArray(records) && records.some(record => matches(record, endpoint));
  };
  const remove = endpoint => {
    for (const pending of endpoint.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RemoteError('disconnected', 'Session disconnected; a submitted write may still run', 503));
    }
    endpoint.pending.clear();
    if (endpoints.get(endpoint.identity?.id) !== endpoint) return;
    endpoints.delete(endpoint.identity.id);
    onEvent('sessions', {});
    onMembership(endpoints.size);
  };
  const server = createServer(socket => {
    if (connections.size >= 256) { socket.destroy(); return; }
    connections.add(socket);
    socket.on('error', () => {});
    socket.setTimeout(heartbeatTimeoutMs, () => socket.destroy());
    const endpoint = { socket, identity: null, generation: null, state: null,
      seq: 0, lastSeen: Date.now(), pending: new Map() };
    let chain = Promise.resolve();
    let queued = 0;
    const handle = async frame => {
      if (closed || socket.destroyed) return;
      if (!endpoint.identity) {
        if (frame.type !== 'register' || frame.protocol !== 1 || !isMain(frame.identity) ||
            typeof frame.generation !== 'string' || !frame.generation || frame.generation.length > 128) {
          throw new Error('An eligible main session registration is required');
        }
        endpoint.identity = frame.identity;
        endpoint.generation = frame.generation;
        endpoint.state = state(frame.state);
        if (!(await validate(endpoint))) throw new Error('Paj registration does not match');
        if (socket.destroyed || closed) return;
        const old = endpoints.get(endpoint.identity.id);
        if (old) old.socket.destroy();
        endpoints.set(endpoint.identity.id, endpoint);
        writeFrame(socket, { type: 'registered', protocol: 1 });
        onEvent('sessions', {});
        onEvent('resync', {});
        onMembership(endpoints.size);
        return;
      }
      if (endpoints.get(endpoint.identity.id) !== endpoint) throw new Error('Session registration is superseded');
      endpoint.lastSeen = Date.now();
      if (frame.type === 'heartbeat') return;
      if (frame.type === 'response') {
        const pending = endpoint.pending.get(frame.id);
        if (!pending) return;
        endpoint.pending.delete(frame.id);
        clearTimeout(pending.timer);
        if (frame.ok === true) pending.resolve(frame.result);
        else pending.reject(new RemoteError(String(frame.error?.code ?? 'session_error').slice(0, 100),
          String(frame.error?.message ?? 'Session request failed').slice(0, 1000)));
        return;
      }
      if (frame.type !== 'event' || !Number.isSafeInteger(frame.seq) || frame.seq <= endpoint.seq ||
          !frame.event || !['state', 'message', 'delta', 'reset'].includes(frame.event.type)) {
        throw new Error('Invalid session event');
      }
      if (frame.event.type === 'state') endpoint.state = state(frame.event.state);
      if (frame.seq !== endpoint.seq + 1 && endpoint.seq !== 0) onEvent('resync', {});
      endpoint.seq = frame.seq;
      onEvent('session', { id: endpoint.identity.id, generation: endpoint.generation,
        seq: frame.seq, event: frame.event });
    };
    readFrames(socket, frame => {
      if (++queued > 64) { socket.destroy(); return; }
      chain = chain.then(() => handle(frame)).catch(() => socket.destroy()).finally(() => queued--);
    });
    socket.on('close', () => { connections.delete(socket); remove(endpoint); });
  });
  server.on('error', () => {});
  let socketInfo;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(paths.socketPath, resolve);
    });
    socketInfo = await lstat(paths.socketPath);
    await chmod(paths.socketPath, 0o600);
  } catch (error) {
    for (const socket of connections) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    throw error;
  }
  const timer = setInterval(async () => {
    if (pollPending || closed) return;
    pollPending = true;
    try {
      const records = await listSessions();
      for (const endpoint of endpoints.values()) {
        if (Date.now() - endpoint.lastSeen > heartbeatTimeoutMs ||
            !Array.isArray(records) || !records.some(record => matches(record, endpoint))) endpoint.socket.destroy();
      }
    } catch {
      for (const endpoint of endpoints.values()) endpoint.socket.destroy();
    } finally { pollPending = false; }
  }, pollIntervalMs);
  timer.unref();

  return {
    get size() { return endpoints.size; },
    list() {
      return [...endpoints.values()].filter(endpoint => !endpoint.socket.destroyed).map(endpoint => ({
        id: endpoint.identity.id, piSessionId: endpoint.identity.piSessionId, generation: endpoint.generation,
        name: String(endpoint.identity.name ?? 'Agent').slice(0, 200),
        projectRoot: String(endpoint.identity.projectRoot ?? '').slice(0, 4096),
        branch: typeof endpoint.identity.branch === 'string' ? endpoint.identity.branch.slice(0, 500) : null,
        state: endpoint.state,
      }));
    },
    async request(id, method, params) {
      const endpoint = endpoints.get(id);
      if (!endpoint || endpoint.socket.destroyed) throw new RemoteError('unavailable', 'Main session is unavailable', 404);
      if (!(await validate(endpoint)) || endpoints.get(id) !== endpoint || endpoint.socket.destroyed) {
        endpoint.socket.destroy();
        throw new RemoteError('unavailable', 'Main session is no longer registered', 404);
      }
      if (params.generation && params.generation !== endpoint.generation) {
        throw new RemoteError('stale_generation', 'Session changed; refresh before sending');
      }
      if (endpoint.pending.size >= 16) throw new RemoteError('overloaded', 'Too many pending session requests', 429);
      return new Promise((resolve, reject) => {
        const requestId = randomUUID();
        const timer = setTimeout(() => {
          endpoint.pending.delete(requestId);
          reject(new RemoteError('timeout', method === 'snapshot' ? 'Session did not respond' :
            'Write outcome is unknown; check the conversation before retrying', 504));
        }, requestTimeoutMs);
        endpoint.pending.set(requestId, { resolve, reject, timer });
        try {
          writeFrame(endpoint.socket, { type: 'request', id: requestId, method,
            params: { ...params, generation: endpoint.generation } });
        } catch {
          clearTimeout(timer);
          endpoint.pending.delete(requestId);
          reject(new RemoteError('disconnected', 'Session disconnected; write outcome may be unknown', 503));
        }
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      for (const connection of connections) connection.destroy();
      await new Promise(resolve => server.close(resolve));
      try {
        const current = await lstat(paths.socketPath);
        if (current.ino === socketInfo.ino && current.dev === socketInfo.dev) await unlink(paths.socketPath);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
  };
}
