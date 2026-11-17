import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { fileURLToPath } from 'node:url';
import { getPaths, loadConfig } from '../dist/src/config.js';
import { ensureService } from '../dist/src/service.js';
import { createSessionAdapter, isEligible } from '../dist/src/session.js';
import type { PajAPI, SessionContext, SessionPI } from '../dist/src/session.js';
import { createConnector } from '../dist/src/connector.js';

export function installRemoteExtension(pi: ExtensionAPI, dependencies = {
  getPaths, loadConfig, ensureService, createSessionAdapter, createConnector, env: process.env,
}) {
  let ctx: ExtensionContext | undefined;
  let paj: PajAPI | undefined;
  let adapter: ReturnType<typeof createSessionAdapter> | undefined;
  let connector: ReturnType<typeof createConnector> | undefined;
  let identityKey: string | undefined;
  let status = 'inactive';
  let refreshHandle: ReturnType<typeof setImmediate> | undefined;
  let configTimer: ReturnType<typeof setInterval> | undefined;
  let setupPending = false;
  const cliPath = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url));
  const cliCommand = [process.execPath, cliPath]
    .map(value => `'${value.replaceAll("'", "'\\''")}'`).join(' ');
  const queryPaj = () => {
    let api: PajAPI | undefined;
    pi.events.emit('paj:external:v1', { reply: (value: unknown) => {
      if (value && typeof value === 'object' && 'version' in value && value.version === 1) api = value as PajAPI;
    } });
    return api;
  };

  const stopEndpoint = () => {
    connector?.close();
    adapter?.close();
    connector = undefined;
    adapter = undefined;
    identityKey = undefined;
    status = 'inactive';
  };
  const refresh = () => {
    if (!ctx) return;
    try {
      paj = queryPaj();
      const snapshot = paj?.getSnapshot();
      const config = dependencies.loadConfig();
      if (!config || !paj || !isEligible(ctx as unknown as SessionContext, snapshot, { env: dependencies.env })) {
        stopEndpoint();
        status = !config ? 'setup required: use /rc setup' : 'not an eligible main TUI';
        return;
      }
      const paths = dependencies.getPaths();
      const key = JSON.stringify([snapshot.identity, ctx.sessionManager.getSessionId(), paths.socketPath]);
      if (adapter && key === identityKey) {
        adapter.notifyState();
        return;
      }
      stopEndpoint();
      identityKey = key;
      adapter = dependencies.createSessionAdapter({ pi: pi as unknown as SessionPI, ctx: ctx as unknown as SessionContext, paj, env: dependencies.env });
      connector = dependencies.createConnector({ adapter, socketPath: paths.socketPath,
        ensureService: dependencies.ensureService,
        onStatus: (next: string) => { status = next; } });
      connector.start();
    } catch {
      stopEndpoint();
      status = `unavailable: check ${cliCommand} status`;
    }
  };
  const scheduleRefresh = () => {
    if (!ctx || refreshHandle) return;
    refreshHandle = setImmediate(() => {
      refreshHandle = undefined;
      refresh();
    });
    refreshHandle.unref?.();
  };
  const unsubscribe = pi.events.on('paj:external:changed:v1', scheduleRefresh);
  pi.on('session_start', (_event, current) => {
    stopEndpoint();
    ctx = current;
    refresh();
    clearInterval(configTimer);
    configTimer = setInterval(scheduleRefresh, 5000);
    configTimer.unref?.();
  });
  pi.on('session_shutdown', (event) => {
    ctx = undefined;
    clearImmediate(refreshHandle);
    refreshHandle = undefined;
    clearInterval(configTimer);
    configTimer = undefined;
    stopEndpoint();
    if (event.reason === 'quit' || event.reason === 'reload') unsubscribe();
  });
  pi.registerCommand('rc', {
    description: 'Remote chat setup, status and sanitized settings',
    handler: async (args, current) => {
      const notify = (message: string, level: 'info' | 'error' = 'info') => {
        if (current.hasUI) current.ui.notify(message, level);
      };
      refresh();
      const command = args.trim() || 'status';
      if (command === 'setup') {
        if (setupPending) {
          notify('Remote chat setup is already pending.');
          return;
        }
        setupPending = true;
        try {
          const setupContext = ctx;
          const eligibleSnapshot = () => {
            const snapshot = queryPaj()?.getSnapshot();
            return ctx && ctx === setupContext &&
              ctx.sessionManager.getSessionId() === current.sessionManager.getSessionId() &&
              isEligible(current as unknown as SessionContext, snapshot, { env: dependencies.env }) ? snapshot : null;
          };
          const before = eligibleSnapshot();
          if (!before) {
            notify('Setup requires a live, compatible Paj primary session in the main TUI.');
            return;
          }
          const approved = await current.ui.confirm('Set up remote chat?',
            'Install private authentication/configuration and a systemd user unit? ' +
            'It is not enabled at login. The service will start for this eligible session.\n' +
            `Command: ${cliCommand} setup --yes`, { timeout: 60000 });
          if (!approved) {
            notify('Remote chat setup canceled; nothing installed.');
            return;
          }
          if (eligibleSnapshot()?.identity.id !== before.identity.id) {
            notify('Session eligibility changed; setup canceled.');
            return;
          }
          const result = await pi.exec(process.execPath, [cliPath, 'setup', '--yes'], { timeout: 30000 });
          if (result.killed || result.code !== 0) {
            notify(`Remote chat setup failed${result.killed ? ' or timed out' : ` (exit ${result.code})`}. ` +
              `Review setup in a terminal: ${cliCommand} setup --yes`, 'error');
            return;
          }
          refresh();
          notify('Remote chat setup complete. Use /rc status to check connectivity. ' +
            `To pair, run ${cliCommand} key in a private terminal; it prints a secret.`);
        } catch {
          notify(`Remote chat setup unavailable. Review the README before running ${cliCommand} setup --yes.`, 'error');
        } finally {
          setupPending = false;
        }
        return;
      }
      if (command !== 'status' && command !== 'settings') {
        notify('Usage: /rc [status|setup|settings]');
        return;
      }
      try {
        const config = dependencies.loadConfig();
        const safeSettings = config ? JSON.stringify({ port: config.port,
          idleTimeoutMs: config.idleTimeoutMs, allowedOrigins: config.allowedOrigins }, null, 2)
          : 'Not configured; use /rc setup after reviewing the README.';
        notify(`${command === 'status' ? `Remote chat: ${status}\n` : ''}${safeSettings}\n` +
          `Inspect service: ${cliCommand} status\n` +
          `Change settings: ${cliCommand} settings --port PORT\n` +
          `Allowed origins: ${cliCommand} origin add HTTPS_ORIGIN`);
      } catch {
        notify(`Configuration unavailable. Inspect with ${cliCommand} status.`, 'error');
      }
    },
  });
}

export default function remoteExtension(pi: ExtensionAPI) {
  installRemoteExtension(pi);
}
