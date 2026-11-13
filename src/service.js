import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_PORT, defaultOrigins, getPaths, loadConfig, privateDirectory, saveConfig } from './config.js';

const UNIT = 'paj-rc.service';
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function executeSystemctl(args) {
  return execFileSync('systemctl', ['--user', ...args], {
    encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const executeFile = promisify(execFile);

export async function executeSystemctlAsync(args) {
  const result = await executeFile('systemctl', ['--user', ...args], {
    encoding: 'utf8', timeout: 10000,
  });
  return result.stdout;
}

export function resolveExecutable(command, env = process.env) {
  if (typeof command !== 'string' || !command || /[\0\r\n]/.test(command)) {
    throw new Error('Invalid executable');
  }
  const candidates = isAbsolute(command) ? [command] : command.includes('/') ? [resolve(command)] :
    (env.PATH || '').split(':').filter(isAbsolute).map(directory => join(directory, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      const path = realpathSync(candidate);
      if (lstatSync(path).isFile()) return path;
    } catch {}
  }
  throw new Error(`Executable not found: ${command}`);
}

function unitArgument(value, expandDollar = true) {
  if (/[\0\r\n]/.test(value)) throw new Error('Unit paths cannot contain control characters');
  let escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
  if (expandDollar) escaped = escaped.replaceAll('$', () => '$$');
  return `"${escaped}"`;
}

export function renderUnit({ nodePath, cliPath, env = process.env }) {
  if (env.PAJ_RUNTIME_DIR !== undefined && (typeof env.PAJ_RUNTIME_DIR !== 'string' ||
      !isAbsolute(env.PAJ_RUNTIME_DIR) || /[\u0000-\u001f\u007f-\u009f]/.test(env.PAJ_RUNTIME_DIR))) {
    throw new Error('PAJ_RUNTIME_DIR must be an absolute path without control characters');
  }
  const environment = ['HOME', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'PAJ_RUNTIME_DIR']
    .filter(key => env[key])
    .map(key => `Environment=${unitArgument(`${key}=${env[key]}`, false)}`)
    .join('\n');
  return `[Unit]\nDescription=Private browser control for live Paj sessions\nStartLimitIntervalSec=60\nStartLimitBurst=5\n\n[Service]\nType=simple\n${environment}\nExecStart=${unitArgument(nodePath)} ${unitArgument(cliPath)} serve\nRestart=on-failure\nRestartSec=2\nUMask=0077\nNoNewPrivileges=yes\n`;
}

export async function installService({ approved = false, paths = getPaths(), env = process.env,
  nodePath = process.execPath, pajCommand = 'paj', packageDir = packageRoot,
  execute = executeSystemctl } = {}) {
  if (!approved) throw new Error('Setup requires explicit approval (--yes)');
  const node = resolveExecutable(nodePath, env);
  const paj = resolveExecutable(pajCommand, env);
  const cliPath = realpathSync(join(packageDir, 'src', 'cli.js'));
  const unit = renderUnit({ nodePath: node, cliPath, env });
  const existing = loadConfig(paths);
  const config = existing ? { ...existing, pajCommand: paj } : {
    version: 1, port: DEFAULT_PORT, idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
    allowedOrigins: defaultOrigins(DEFAULT_PORT), pairingKey: randomBytes(32).toString('base64url'),
    pajCommand: paj,
  };
  saveConfig(config, paths);
  privateDirectory(paths.runtimeDir);
  mkdirSync(dirname(paths.serviceFile), { recursive: true });
  let serviceStat;
  try { serviceStat = lstatSync(paths.serviceFile); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (serviceStat && (!serviceStat.isFile() || serviceStat.uid !== process.getuid())) {
    throw new Error('Refusing to replace a nonregular or foreign-owned service file');
  }
  const temporary = `${paths.serviceFile}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, unit, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, paths.serviceFile);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  execute(['daemon-reload']);
  return { configFile: paths.configFile, serviceFile: paths.serviceFile };
}

export async function ensureService({ paths = getPaths(), execute = executeSystemctlAsync } = {}) {
  if (!loadConfig(paths) || !existsSync(paths.serviceFile)) return false;
  await execute(['start', UNIT]);
  return true;
}

export function serviceStatus({ paths = getPaths(), execute = executeSystemctl } = {}) {
  if (!loadConfig(paths)) return { configured: false, installed: false, active: false };
  const installed = existsSync(paths.serviceFile);
  let active = false;
  if (installed) {
    try { active = String(execute(['is-active', UNIT])).trim() === 'active'; } catch {}
  }
  return { configured: true, installed, active };
}

export function restartService({ paths = getPaths(), execute = executeSystemctl } = {}) {
  if (!loadConfig(paths) || !existsSync(paths.serviceFile)) return false;
  execute(['try-restart', UNIT]);
  return true;
}

export function uninstallService({ approved = false, paths = getPaths(), execute = executeSystemctl } = {}) {
  if (!approved) throw new Error('Uninstall requires explicit approval (--yes)');
  if (existsSync(paths.serviceFile)) {
    execute(['disable', '--now', UNIT]);
    unlinkSync(paths.serviceFile);
    execute(['daemon-reload']);
  }
  return { configRetained: existsSync(paths.configFile) };
}
