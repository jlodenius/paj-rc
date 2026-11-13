import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { privateDirectory } from './config.js';

const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const cookieName = 'paj_rc_session';
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const hash = value => createHash('sha256').update(value).digest('hex');

function equal(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createAuth(key, { file } = {}) {
  const keyId = hash(key);
  let sessions = new Map();
  if (file) {
    privateDirectory(dirname(file));
    try {
      const info = lstatSync(file);
      if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) {
        throw new Error('Browser session store must be an owner-private regular file');
      }
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.sessions) || saved.sessions.length > 1000) {
        throw new Error('Invalid browser session store');
      }
      if (saved.keyId === keyId) {
        for (const value of saved.sessions) {
          if (!/^[a-f0-9]{64}$/.test(value.hash) || !Number.isSafeInteger(value.expires) ||
              !tokenPattern.test(value.csrfToken)) throw new Error('Invalid browser session record');
          if (value.expires > Date.now()) sessions.set(value.hash, {
            expires: value.expires, csrfToken: value.csrfToken,
          });
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const commit = next => {
    if (file) {
      const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify({ version: 1, keyId,
          sessions: [...next].map(([tokenHash, value]) => ({ hash: tokenHash, ...value })),
        }), { flag: 'wx', mode: 0o600 });
        renameSync(temporary, file);
      } finally {
        try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    sessions = next;
  };
  const current = () => new Map([...sessions].filter(([, value]) => value.expires > Date.now()));
  const cookie = (value, secure, maxAge = MAX_AGE / 1000) =>
    `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  return {
    read(request) {
      const token = (request.headers.cookie ?? '').split(';').map(part => part.trim())
        .find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      if (!token || !tokenPattern.test(token)) return null;
      const value = sessions.get(hash(token));
      if (!value || value.expires <= Date.now()) return null;
      return { token, ...value };
    },
    login(input, secure) {
      if (typeof input !== 'string' || input.length > 256 || !equal(hash(input), keyId)) return null;
      const next = current();
      if (next.size >= 1000) return null;
      const token = randomBytes(32).toString('base64url');
      const csrfToken = randomBytes(32).toString('base64url');
      next.set(hash(token), { expires: Date.now() + MAX_AGE, csrfToken });
      commit(next);
      return { cookie: cookie(token, secure), csrfToken };
    },
    verifyCsrf(session, input) {
      return typeof input === 'string' && tokenPattern.test(input) && equal(input, session.csrfToken);
    },
    logout(session, secure) {
      const next = current();
      next.delete(hash(session.token));
      commit(next);
      return cookie('', secure, 0);
    },
  };
}
