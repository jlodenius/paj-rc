import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { accessSync, constants, existsSync, linkSync, lstatSync, mkdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfig, getPaths, loadConfig, privateDirectory, saveConfig } from './config.js';

import type { Paths } from './config.js';

const UNIT = 'paj-rc.service';
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function executeSystemctl(args: string[]) {
  return execFileSync('systemctl', ['--user', ...args], {
    encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const executeFile = promisify(execFile);

export async function executeSystemctlAsync(args: string[]) {
  const result = await executeFile('systemctl', ['--user', ...args], {
    encoding: 'utf8', timeout: 10000,
  });
  return result.stdout;
}

export function resolveExecutable(command: string, env = process.env) {
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

function unitArgument(value: string, expandDollar = true) {
  if (/[\0\r\n]/.test(value)) throw new Error('Unit paths cannot contain control characters');
  let escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
  if (expandDollar) escaped = escaped.replaceAll('$', () => '$$');
  return `"${escaped}"`;
}

export function renderUnit({ nodePath, cliPath, env = process.env }: { nodePath: string; cliPath: string; env?: NodeJS.ProcessEnv }) {
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

function serviceFileStat(paths: Paths) {
  try { return lstatSync(paths.serviceFile); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

function hasUsableServiceFile(paths: Paths) {
  try {
    const stat = statSync(paths.serviceFile);
    return stat.isFile() && stat.size > 0;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ELOOP') return false;
    throw error;
  }
}

export function managedServiceState(paths = getPaths()) {
  if (!serviceFileStat(paths)?.isSymbolicLink()) return null;
  return hasUsableServiceFile(paths) ? 'installed' : 'unavailable';
}

function assertLocalService(paths: Paths) {
  const stat = serviceFileStat(paths);
  if (stat?.isSymbolicLink()) throw new Error('Service unit is externally managed; change it in its declarative configuration');
  if (stat && (!stat.isFile() || stat.uid !== process.getuid())) {
    throw new Error('Refusing to modify a nonregular or foreign-owned service file');
  }
  return stat;
}

export async function installService({ approved = false, paths = getPaths(), env = process.env,
  nodePath = process.execPath, pajCommand = 'paj', packageDir = packageRoot,
  execute = executeSystemctl } = {}) {
  if (!approved) throw new Error('Setup requires explicit approval (--yes)');
  const existingUnit = assertLocalService(paths);
  const node = resolveExecutable(nodePath, env);
  const paj = resolveExecutable(pajCommand, env);
  const cliPath = realpathSync(join(packageDir, 'dist', 'src', 'cli.js'));
  const unit = renderUnit({ nodePath: node, cliPath, env });
  const config = { ...(loadConfig(paths) ?? defaultConfig()), pajCommand: paj };
  saveConfig(config, paths);
  privateDirectory(paths.runtimeDir);
  mkdirSync(dirname(paths.serviceFile), { recursive: true });
  assertLocalService(paths);
  const temporary = `${paths.serviceFile}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, unit, { mode: 0o600, flag: 'wx' });
    if (existingUnit) {
      const current = assertLocalService(paths);
      if (current?.ino !== existingUnit.ino || current?.dev !== existingUnit.dev) throw new Error('Service file changed during setup');
      renameSync(temporary, paths.serviceFile);
    } else linkSync(temporary, paths.serviceFile);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  execute(['daemon-reload']);
  return { configFile: paths.configFile, serviceFile: paths.serviceFile };
}

export async function ensureService({ paths = getPaths(), execute = executeSystemctlAsync } = {}) {
  if (!hasUsableServiceFile(paths) || (!loadConfig(paths) && managedServiceState(paths) !== 'installed')) return false;
  await execute(['start', UNIT]);
  return true;
}

export function serviceStatus({ paths = getPaths(), execute = executeSystemctl } = {}) {
  const configured = Boolean(loadConfig(paths));
  const managed = managedServiceState(paths);
  const installed = managed ? managed === 'installed' : configured && hasUsableServiceFile(paths);
  let active = false;
  if (installed) {
    try { active = String(execute(['is-active', UNIT])).trim() === 'active'; } catch {}
  }
  return { configured, installed, active, ...(managed ? { managed: true } : {}) };
}

export function restartService({ paths = getPaths(), execute = executeSystemctl } = {}) {
  if (!loadConfig(paths) || !hasUsableServiceFile(paths)) return false;
  execute(['try-restart', UNIT]);
  return true;
}

export function uninstallService({ approved = false, paths = getPaths(), execute = executeSystemctl } = {}) {
  if (!approved) throw new Error('Uninstall requires explicit approval (--yes)');
  const unit = assertLocalService(paths);
  if (unit) {
    execute(['disable', '--now', UNIT]);
    const current = assertLocalService(paths);
    if (current?.ino !== unit.ino || current?.dev !== unit.dev) throw new Error('Service file changed during uninstall');
    unlinkSync(paths.serviceFile);
    execute(['daemon-reload']);
  }
  return { configRetained: existsSync(paths.configFile) };
}
