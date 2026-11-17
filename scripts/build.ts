import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

rmSync('dist', { recursive: true, force: true });
const tsc = process.env.TSC || 'node_modules/.bin/tsc';
execFileSync(tsc, ['-p', 'tsconfig.json'], { stdio: 'inherit' });
execFileSync(tsc, ['-p', 'tsconfig.browser.json'], { stdio: 'inherit' });
mkdirSync('dist/public', { recursive: true });
cpSync('public', 'dist/public', { recursive: true });
