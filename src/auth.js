import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { privateDirectory } from './config.js';

const COOKIE_MAX_AGE = 400 * 24 * 60 * 60;
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
  let migrate = false;
  if (file) {
    privateDirectory(dirname(file));
    try {
      const info = lstatSync(file);
      if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) {
        throw new Error('Browser session store must be an owner-private regular file');
      }
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (![1, 2].includes(saved.version) || !Array.isArray(saved.sessions) || saved.sessions.length > 1000) {
        throw new Error('Invalid browser session store');
      }
      if (saved.keyId === keyId) {
        migrate = saved.version === 1;
        for (const value of saved.sessions) {
          const validExpiry = saved.version === 1 ? Number.isSafeInteger(value.expires) : value.expires === null;
          if (!/^[a-f0-9]{64}$/.test(value.hash) || !validExpiry ||
              !tokenPattern.test(value.csrfToken)) throw new Error('Invalid browser session record');
          if (saved.version === 2 || value.expires > Date.now()) sessions.set(value.hash, {
            expires: null, csrfToken: value.csrfToken,
          });
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const commit = next => {
    if (file) {
      const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify({ version: 2, keyId,
          sessions: [...next].map(([tokenHash, value]) => ({ hash: tokenHash, ...value })),
        }), { flag: 'wx', mode: 0o600 });
        renameSync(temporary, file);
      } finally {
        try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    sessions = next;
  };
  if (migrate) commit(sessions);
  const current = () => new Map(sessions);
  const cookie = (value, secure, maxAge = COOKIE_MAX_AGE) =>
    `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  return {
    read(request) {
      const token = (request.headers.cookie ?? '').split(';').map(part => part.trim())
        .find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      if (!token || !tokenPattern.test(token)) return null;
      const value = sessions.get(hash(token));
      if (!value) return null;
      return { token, ...value };
    },
    refresh(session, secure) {
      return cookie(session.token, secure);
    },
    login(input, secure) {
      if (typeof input !== 'string' || input.length > 256 || !equal(hash(input), keyId)) return null;
      const next = current();
      if (next.size >= 1000) return null;
      const token = randomBytes(32).toString('base64url');
      const csrfToken = randomBytes(32).toString('base64url');
      next.set(hash(token), { expires: null, csrfToken });
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
