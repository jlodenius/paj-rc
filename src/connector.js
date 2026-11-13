import { createConnection } from 'node:net';

const MAX_FRAME = 2 * 1024 * 1024;

export function createConnector({ adapter, socketPath, ensureService,
  connect = createConnection, heartbeatMs = 5000, handshakeMs = 5000,
  retryInitialMs = 250, retryMaxMs = 30000, onStatus = () => {} }) {
  let socket;
  let stopped = true;
  let acknowledged = false;
  let retryTimer;
  let heartbeat;
  let handshake;
  let retryMs = retryInitialMs;
  let attempt = 0;
  let unsubscribe;

  const status = (value) => { try { onStatus(value); } catch {} };
  const send = (frame) => {
    if (!socket || socket.destroyed || !socket.writable) return false;
    const line = JSON.stringify(frame) + '\n';
    if (Buffer.byteLength(line) > MAX_FRAME || socket.writableLength > MAX_FRAME) {
      socket.destroy();
      return false;
    }
    socket.write(line);
    return true;
  };
  const schedule = () => {
    if (stopped || retryTimer || !adapter.eligible()) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void open();
    }, retryMs);
    retryTimer.unref?.();
    retryMs = Math.min(retryMaxMs, Math.max(retryInitialMs, retryMs * 2));
  };
  async function open() {
    if (stopped || !adapter.eligible()) return;
    const currentAttempt = ++attempt;
    status('connecting');
    try {
      await ensureService();
      if (stopped || currentAttempt !== attempt || !adapter.eligible()) return;
      const current = connect({ path: socketPath });
      socket = current;
      acknowledged = false;
      let buffer = Buffer.alloc(0);
      current.on('error', () => {});
      handshake = setTimeout(() => current.destroy(), handshakeMs);
      handshake.unref?.();
      current.on('connect', () => {
        if (!adapter.eligible()) return current.destroy();
        send({ type: 'register', protocol: 1, generation: adapter.generation,
          identity: adapter.identity, state: adapter.state() });
      });
      current.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        let newline;
        while ((newline = buffer.indexOf(10)) !== -1) {
          if (newline > MAX_FRAME) return current.destroy();
          const line = buffer.subarray(0, newline);
          buffer = buffer.subarray(newline + 1);
          let frame;
          try { frame = JSON.parse(line.toString('utf8')); } catch { return current.destroy(); }
          if (!acknowledged) {
            if (frame?.type !== 'registered' || frame.protocol !== 1 || !adapter.eligible()) {
              return current.destroy();
            }
            acknowledged = true;
            clearTimeout(handshake);
            retryMs = retryInitialMs;
            status('connected');
            heartbeat = setInterval(() => {
              if (!adapter.eligible()) current.destroy();
              else send({ type: 'heartbeat' });
            }, heartbeatMs);
            heartbeat.unref?.();
            continue;
          }
          if (frame?.type !== 'request' || typeof frame.id !== 'string' ||
              frame.id.length > 128 || !['snapshot', 'prompt', 'abort'].includes(frame.method)) {
            return current.destroy();
          }
          try {
            const result = adapter[frame.method](frame.params);
            send({ type: 'response', id: frame.id, ok: true, result });
          } catch (error) {
            send({ type: 'response', id: frame.id, ok: false,
              error: { code: error.code ?? 'invalid_request',
                message: String(error.message ?? 'Request failed').slice(0, 512) } });
          }
        }
        if (buffer.length > MAX_FRAME) current.destroy();
      });
      current.on('close', () => {
        if (socket !== current) return;
        socket = undefined;
        acknowledged = false;
        clearInterval(heartbeat);
        clearTimeout(handshake);
        status('disconnected');
        schedule();
      });
    } catch {
      status('unavailable');
      schedule();
    }
  }
  return {
    start() {
      if (!stopped) return;
      stopped = false;
      unsubscribe = adapter.subscribe((frame) => {
        if (acknowledged && adapter.eligible()) send(frame);
      });
      void open();
    },
    close() {
      if (stopped) return;
      stopped = true;
      attempt++;
      clearTimeout(retryTimer);
      clearTimeout(handshake);
      clearInterval(heartbeat);
      retryTimer = undefined;
      unsubscribe?.();
      acknowledged = false;
      socket?.destroy();
      socket = undefined;
    },
  };
}
