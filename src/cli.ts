#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultOrigins, getPaths, loadConfig, saveConfig, validateOrigin } from './config.js';
import { installService, restartService, serviceStatus, uninstallService } from './service.js';

import type { Paths } from './config.js';
import type { startDaemon } from './daemon.js';

interface MainOptions {
  paths?: Paths;
  output?: (message: string) => void;
  execute?: (args: string[]) => string;
  daemonFactory?: typeof startDaemon;
}

const HELP = `Usage: paj-rc COMMAND

setup --yes [--paj PATH]       Install private config and systemd user unit (not enabled)
status                        Show installation/service status
settings                      Show settings without secrets
settings --port N [--idle-timeout-ms N]
origin add|remove ORIGIN       Change exact allowed browser origins
key                           Show the permanent pairing key explicitly
rotate                        Revoke browser cookies and replace pairing key (not shown)
uninstall --yes               Stop/remove unit; retain private config
serve                         Run the daemon (normally managed by systemd)
`;

function options(args: string[], allowed: string[]) {
  const result: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!allowed.includes(key) || key in result) throw new Error(`Unknown or duplicate option: ${key}`);
    if (key === '--yes') result[key] = true;
    else {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${key}`);
      result[key] = args[++i];
    }
  }
  return result;
}

function integer(value: string | true, label: string) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error(`${label} must be an integer`);
  return Number(value);
}

export async function main(args = process.argv.slice(2), { paths = getPaths(),
  output = console.log, execute, daemonFactory }: MainOptions = {}) {
  const [command, ...rest] = args;
  const serviceOptions = { paths, ...(execute ? { execute } : {}) };
  if (!command || command === '--help' || command === 'help') { output(HELP); return; }
  if (command === 'setup') {
    const flags = options(rest, ['--yes', '--paj']);
    await installService({ ...serviceOptions, approved: flags['--yes'] === true, pajCommand: String(flags['--paj'] || 'paj') });
    output('Setup complete. Service is not enabled at login. Start an eligible Pi session, then run key to pair.');
    return;
  }
  if (command === 'status') {
    options(rest, []);
    output(JSON.stringify(serviceStatus(serviceOptions), null, 2));
    return;
  }
  if (command === 'uninstall') {
    const flags = options(rest, ['--yes']);
    uninstallService({ ...serviceOptions, approved: flags['--yes'] === true });
    output(`Service removed. Private configuration retained at ${paths.configFile}`);
    return;
  }
  const config = loadConfig(paths);
  if (!config) throw new Error('Not configured. Run setup --yes after reviewing the README.');
  if (command === 'key') {
    options(rest, []);
    output(config.pairingKey);
  } else if (command === 'settings') {
    const flags = options(rest, ['--port', '--idle-timeout-ms']);
    if (flags['--port']) {
      const port = integer(flags['--port'], 'port');
      config.allowedOrigins = [...new Set([
        ...config.allowedOrigins.filter(origin => !defaultOrigins(config.port).includes(origin)),
        ...defaultOrigins(port),
      ])];
      config.port = port;
    }
    if (flags['--idle-timeout-ms']) config.idleTimeoutMs = integer(flags['--idle-timeout-ms'], 'idle timeout');
    if (Object.keys(flags).length) {
      saveConfig(config, paths);
      restartService(serviceOptions);
    }
    const { pairingKey, ...safe } = config;
    output(JSON.stringify(safe, null, 2));
  } else if (command === 'origin') {
    const [action, origin, extra] = rest;
    if (!['add', 'remove'].includes(action) || !origin || extra) throw new Error('Usage: origin add|remove ORIGIN');
    validateOrigin(origin);
    config.allowedOrigins = action === 'add' ? [...new Set([...config.allowedOrigins, origin])] :
      config.allowedOrigins.filter(value => value !== origin);
    saveConfig(config, paths);
    restartService(serviceOptions);
    output('Allowed origins updated.');
  } else if (command === 'rotate') {
    options(rest, []);
    config.pairingKey = randomBytes(32).toString('base64url');
    saveConfig(config, paths);
    restartService(serviceOptions);
    output('Pairing key rotated; existing browser sessions revoked. Run key explicitly to pair again.');
  } else if (command === 'serve') {
    options(rest, []);
    const factory = daemonFactory || (await import('./daemon.js')).startDaemon;
    let daemon: Awaited<ReturnType<typeof startDaemon>>;
    daemon = await factory(config, { paths, onIdle: async () => { await daemon.close(); } });
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => { Promise.resolve(daemon.close()).catch(error => {
        console.error(error.message);
        process.exitCode = 1;
      }); });
    }
    return daemon;
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
}

let isEntry = false;
try { isEntry = !!process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url); } catch {}
if (isEntry) {
  main().catch(error => {
    console.error(`paj-rc: ${error.message}`);
    process.exitCode = 1;
  });
}
