import { createServer, createConnection } from 'node:net';
import { mkdir, chmod, lstat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { readFrames, writeFrame, isMain } from './protocol.js';

import type { Socket } from 'node:net';
import type { Paths } from './config.js';
import type { MainIdentity } from './protocol.js';

interface SessionState {
  busy: boolean;
  editorBusy: boolean;
  terminalRequired: boolean;
  supportsImages?: boolean;
  runId: string | null;
  model?: Record<string, string> | null;
  context?: { tokens: number | null; contextWindow: number } | null;
}
interface Command { name: string; source: string; description: string }
interface Result { state?: SessionState; commands?: Command[]; [key: string]: unknown }
interface Frame {
  [key: string]: unknown;
  type: string;
  protocol?: number;
  identity?: MainIdentity;
  generation?: string;
  state?: SessionState;
  id?: string;
  result?: Result;
  ok?: boolean;
  error?: { code?: string; message?: string };
  seq?: number;
  event?: { type: string; state?: SessionState };
}
interface Pending {
  timer: ReturnType<typeof setTimeout>;
  method: string;
  resolve: (result: Result) => void;
  reject: (error: Error) => void;
}
interface Endpoint {
  socket: Socket;
  identity: MainIdentity | null;
  generation: string | null;
  state: SessionState | null;
  seq: number;
  lastSeen: number;
  captain: boolean;
  captainExpiresAt: number;
  registryRead: number;
  pending: Map<string, Pending>;
}
export interface BrokerOptions {
  paths: Paths;
  listSessions: () => Promise<unknown>;
  onEvent?: (name: string, data: unknown) => void;
  onMembership?: (size: number) => void;
  heartbeatTimeoutMs?: number;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
}

export class RemoteError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function state(value: SessionState) {
  if (!value || typeof value.busy !== 'boolean' || typeof value.editorBusy !== 'boolean' ||
      typeof value.terminalRequired !== 'boolean' ||
      (value.supportsImages !== undefined && typeof value.supportsImages !== 'boolean') ||
      !(value.runId === null || typeof value.runId === 'string')) throw new Error('Invalid session state');
  let model: Record<string, string> | null;
  if (value.model !== undefined) {
    model = null;
    if (value.model !== null) {
      if (typeof value.model !== 'object' || Array.isArray(value.model)) throw new Error('Invalid session model');
      model = {};
      for (const key of ['id', 'provider', 'name']) {
        const text = value.model?.[key];
        if (typeof text !== 'string' || !text.trim() || text.length > 200 ||
            /[\u0000-\u001f\u007f]/u.test(text)) throw new Error('Invalid session model');
        model[key] = text;
      }
    }
  }
  let context;
  if (value.context !== undefined) {
    context = null;
    if (value.context !== null) {
      if (typeof value.context !== 'object' || Array.isArray(value.context)) throw new Error('Invalid session context');
      const { tokens, contextWindow } = value.context;
      if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0 ||
          !(tokens === null || (Number.isSafeInteger(tokens) && tokens >= 0))) {
        throw new Error('Invalid session context');
      }
      context = { tokens, contextWindow };
    }
  }
  return { busy: value.busy, editorBusy: value.editorBusy, terminalRequired: value.terminalRequired,
    ...(model !== undefined ? { model } : {}), ...(context !== undefined ? { context } : {}),
    runId: value.runId,
    ...(typeof value.supportsImages === 'boolean' ? { supportsImages: value.supportsImages } : {}) };
}

function commandMetadata(value: Command[]) {
  if (!Array.isArray(value) || value.length > 128) throw new Error('Invalid session commands');
  const seen = new Set();
  return value.map(entry => {
    if (!entry || typeof entry.name !== 'string' || !entry.name || entry.name.length > 100 ||
        entry.name.startsWith('/') || /[\s\u0000-\u001f\u007f-\u009f]/u.test(entry.name) ||
        !['skill', 'prompt'].includes(entry.source) ||
        (entry.source === 'skill' && (!entry.name.startsWith('skill:') || entry.name.length === 6)) ||
        typeof entry.description !== 'string' || entry.description.length > 240 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(entry.description) || seen.has(entry.name)) {
      throw new Error('Invalid session commands');
    }
    seen.add(entry.name);
    return { name: entry.name, description: entry.description, source: entry.source };
  });
}

async function removeStale(path: string) {
  try {
    const info = await lstat(path);
    if (!info.isSocket()) throw new Error('Refusing to replace a non-socket runtime path');
    const occupied = await new Promise(resolve => {
      const probe = createConnection(path);
      probe.once('connect', () => { probe.destroy(); resolve(true); });
      probe.once('error', (error: NodeJS.ErrnoException) => resolve(error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT'));
      probe.setTimeout(1000, () => { probe.destroy(); resolve(true); });
    });
    if (occupied) throw new Error('Another paj-rc daemon already owns the runtime socket');
    await unlink(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function startBroker({ paths, listSessions, onEvent = () => {}, onMembership = () => {},
  heartbeatTimeoutMs = 20000, pollIntervalMs = 5000, requestTimeoutMs = 10000 }: BrokerOptions) {
  await mkdir(paths.runtimeDir, { recursive: true, mode: 0o700 });
  const directory = await lstat(paths.runtimeDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() ||
      (process.getuid && directory.uid !== process.getuid())) throw new Error('Unsafe runtime directory');
  await chmod(paths.runtimeDir, 0o700);
  await removeStale(paths.socketPath);
  const endpoints = new Map<string, Endpoint>();
  const connections = new Set<Socket>();
  let closed = false;
  let pollPending = false;
  let registryRead = 0;

  const matches = (record: unknown, endpoint: Endpoint) => isMain(record) && record.id === endpoint.identity.id &&
    record.piSessionId === endpoint.identity.piSessionId && record.pid === endpoint.identity.pid;
  const updateCaptain = (endpoint: Endpoint, record: unknown, read = endpoint.registryRead) => {
    if (read < endpoint.registryRead) return;
    endpoint.registryRead = read;
    const value = record as { captainInspection?: unknown; lastHeartbeatMs?: unknown } | undefined;
    const heartbeat = value?.lastHeartbeatMs;
    const now = Date.now();
    const captain = typeof value?.captainInspection === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.captainInspection) &&
      typeof heartbeat === 'number' && Number.isSafeInteger(heartbeat) &&
      heartbeat <= now && now - heartbeat <= 60000;
    endpoint.captainExpiresAt = captain ? heartbeat + 60000 : 0;
    if (captain !== endpoint.captain) {
      endpoint.captain = captain;
      if (endpoints.get(endpoint.identity.id) === endpoint) onEvent('sessions', {});
    }
  };
  const expireCaptains = () => {
    for (const endpoint of endpoints.values()) {
      if (endpoint.captain && Date.now() > endpoint.captainExpiresAt) updateCaptain(endpoint, undefined);
    }
  };
  const validate = async (endpoint: Endpoint) => {
    const read = ++registryRead;
    const records = await listSessions();
    const record = Array.isArray(records) ? records.find(record => matches(record, endpoint)) : undefined;
    updateCaptain(endpoint, record, read);
    return Boolean(record);
  };
  const remove = (endpoint: Endpoint) => {
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
    const endpoint: Endpoint = { socket, identity: null, generation: null, state: null,
      seq: 0, lastSeen: Date.now(), captain: false, captainExpiresAt: 0, registryRead: 0, pending: new Map() };
    let chain = Promise.resolve();
    let queued = 0;
    const handle = async (frame: Frame) => {
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
        let result = frame.result;
        if (frame.ok === true && pending.method === 'snapshot') {
          result = { ...result, state: state(result?.state),
            ...(result?.commands === undefined ? {} : { commands: commandMetadata(result.commands) }) };
          endpoint.state = result.state;
        }
        endpoint.pending.delete(frame.id);
        clearTimeout(pending.timer);
        if (frame.ok === true) pending.resolve(result);
        else pending.reject(new RemoteError(String(frame.error?.code ?? 'session_error').slice(0, 100),
          String(frame.error?.message ?? 'Session request failed').slice(0, 1000)));
        return;
      }
      if (frame.type !== 'event' || !Number.isSafeInteger(frame.seq) || frame.seq <= endpoint.seq ||
          !frame.event || !['state', 'message', 'delta', 'reset'].includes(frame.event.type)) {
        throw new Error('Invalid session event');
      }
      if (frame.event.type === 'state') {
        endpoint.state = state(frame.event.state);
        frame.event = { type: 'state', state: endpoint.state };
      }
      if (frame.seq !== endpoint.seq + 1 && endpoint.seq !== 0) onEvent('resync', {});
      endpoint.seq = frame.seq;
      onEvent('session', { id: endpoint.identity.id, generation: endpoint.generation,
        seq: frame.seq, event: frame.event });
    };
    readFrames(socket, frame => {
      if (++queued > 64) { socket.destroy(); return; }
      chain = chain.then(() => handle(frame as Frame)).catch(() => { socket.destroy(); }).finally(() => { queued--; });
    });
    socket.on('close', () => { connections.delete(socket); remove(endpoint); });
  });
  server.on('error', () => {});
  let socketInfo;
  try {
    await new Promise<void>((resolve, reject) => {
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
    expireCaptains();
    if (pollPending || closed) return;
    pollPending = true;
    const read = ++registryRead;
    const polled = [...endpoints.values()];
    try {
      const records = await listSessions();
      for (const endpoint of polled) {
        if (endpoints.get(endpoint.identity.id) !== endpoint || endpoint.registryRead > read) continue;
        const record = Array.isArray(records) ? records.find(record => matches(record, endpoint)) : undefined;
        updateCaptain(endpoint, record, read);
        if (Date.now() - endpoint.lastSeen > heartbeatTimeoutMs || !record) endpoint.socket.destroy();
      }
    } catch {
      for (const endpoint of polled) {
        if (endpoints.get(endpoint.identity.id) === endpoint && endpoint.registryRead <= read) endpoint.socket.destroy();
      }
    } finally { pollPending = false; }
  }, pollIntervalMs);
  timer.unref();

  return {
    get size() { return endpoints.size; },
    list() {
      expireCaptains();
      return [...endpoints.values()].filter(endpoint => !endpoint.socket.destroyed).map(endpoint => ({
        id: endpoint.identity.id, piSessionId: endpoint.identity.piSessionId, generation: endpoint.generation,
        name: String(endpoint.identity.name ?? 'Agent').slice(0, 200),
        projectRoot: String(endpoint.identity.projectRoot ?? '').slice(0, 4096),
        branch: typeof endpoint.identity.branch === 'string' ? endpoint.identity.branch.slice(0, 500) : null,
        state: endpoint.state, captain: endpoint.captain,
      }));
    },
    async request(id: string, method: string, params: Record<string, unknown>) {
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
      return new Promise<Result>((resolve, reject) => {
        const requestId = randomUUID();
        const timer = setTimeout(() => {
          endpoint.pending.delete(requestId);
          reject(new RemoteError('timeout', method === 'snapshot' ? 'Session did not respond' :
            'Write outcome is unknown; check the conversation before retrying', 504));
        }, requestTimeoutMs);
        endpoint.pending.set(requestId, { resolve, reject, timer, method });
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
