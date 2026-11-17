import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export interface Config {
  version: number;
  port: number;
  idleTimeoutMs: number;
  allowedOrigins: string[];
  pairingKey: string;
  pajCommand: string;
}
export type Paths = ReturnType<typeof getPaths>;

export const DEFAULT_PORT = 43187;
export const DEFAULT_IDLE_TIMEOUT_MS = 30000;

export function getPaths(env = process.env) {
  const home = env.HOME || homedir();
  const configHome = env.XDG_CONFIG_HOME || join(home, '.config');
  const runtimeHome = env.XDG_RUNTIME_DIR || join(tmpdir(), `paj-rc-${process.getuid()}`);
  if (![home, configHome, runtimeHome].every(isAbsolute)) {
    throw new Error('HOME and XDG paths must be absolute');
  }
  const configDir = join(configHome, 'paj-rc');
  const runtimeDir = env.XDG_RUNTIME_DIR ? join(runtimeHome, 'paj-rc') : runtimeHome;
  return {
    configDir,
    configFile: join(configDir, 'config.json'),
    runtimeDir,
    socketPath: join(runtimeDir, 'daemon.sock'),
    serviceFile: join(configHome, 'systemd', 'user', 'paj-rc.service'),
  };
}

export function defaultOrigins(port: number) {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`].map(origin => new URL(origin).origin);
}

export function validateOrigin(origin: string) {
  if (typeof origin !== 'string') throw new Error('Origin must be a string');
  let url;
  try { url = new URL(origin); } catch { throw new Error(`Invalid origin: ${origin}`); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.origin !== origin || url.username || url.password || origin.includes('*') ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) {
    throw new Error('Origins must be exact HTTPS or HTTP loopback origins, without paths or wildcards');
  }
  return origin;
}

export function validateConfig(config: Config) {
  if (!config || config.version !== 1) throw new Error('Unsupported configuration version');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error('Port must be an integer from 1 to 65535');
  }
  if (!Number.isInteger(config.idleTimeoutMs) || config.idleTimeoutMs < 0 || config.idleTimeoutMs > 2147483647) {
    throw new Error('idleTimeoutMs must be an integer from 0 to 2147483647');
  }
  if (!Array.isArray(config.allowedOrigins) || config.allowedOrigins.length === 0) {
    throw new Error('At least one allowed origin is required');
  }
  config.allowedOrigins.forEach(validateOrigin);
  if (typeof config.pairingKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(config.pairingKey)) {
    throw new Error('Invalid pairing key');
  }
  if (typeof config.pajCommand !== 'string' || !isAbsolute(config.pajCommand) || /[\0\r\n]/.test(config.pajCommand)) {
    throw new Error('pajCommand must be an absolute executable path');
  }
  return config;
}

export function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid()) {
    throw new Error(`Not an owner-controlled directory: ${path}`);
  }
  chmodSync(path, 0o700);
}

export function loadConfig(paths = getPaths()) {
  let stat;
  try { stat = lstatSync(paths.configFile); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error('Configuration must be an owner-private regular file');
  }
  return validateConfig(JSON.parse(readFileSync(paths.configFile, 'utf8')));
}

export function saveConfig(config: Config, paths = getPaths()) {
  validateConfig(config);
  privateDirectory(paths.configDir);
  const temporary = `${paths.configFile}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, paths.configFile);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return config;
}
