// Starts a real server on a throwaway database and upload dir, so tests
// exercise the actual routes. Each call gets its own port and temp folder.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let nextPort = 3400 + Math.floor(Math.random() * 400);

export async function startServer(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoyo-test-'));
  const port = nextPort++;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DB_PATH: path.join(dir, 'yoyos.db'), UPLOAD_DIR: path.join(dir, 'uploads'),
      ADMIN_PASSWORD: '', READ_ONLY: '', DEMO_MODE: '', RATE_LIMIT_MAX: '', AUTH_USER: '', AUTH_PASS: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  let exited = false;
  child.once('exit', () => { exited = true; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) { // up to 30s: the suite boots many servers at once
    try { await fetch(base + '/api/config'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    // A server that crashed on boot won't come up; say so now, not after the full wait.
    if (exited) throw new Error('server exited during startup:\n' + log);
    if (i === 299) { child.kill(); throw new Error('server did not start:\n' + log); }
  }
  return {
    base, dir,
    api: (p, opts) => fetch(base + p, opts),
    stop: () => new Promise((r) => { child.once('exit', r); child.kill(); }),
  };
}

export const json = (body, headers = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

export function csvForm(text) {
  const fd = new FormData();
  fd.append('file', new Blob([text], { type: 'text/csv' }), 'import.csv');
  return { method: 'POST', body: fd };
}
