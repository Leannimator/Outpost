'use strict';
// Shared by the server tests: start a real copy of the app with a temporary database.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PASSWORD = 'test-only-Correct-Horse-9!';

async function startServer(extraEnv = {}) {
  const port = 3800 + Math.floor(Math.random() * 1000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-test-'));
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { PATH: process.env.PATH, PORT: String(port), DATA_DIR: dir, ADMIN_PASSWORD: PASSWORD, BASE_URL: `http://localhost:${port}`, ...extraEnv },
    stdio: 'ignore',
  });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(base + '/api/settings')).ok; } catch { /* not up yet */ } if (!up) await sleep(100); }
  if (!up) { proc.kill('SIGKILL'); throw new Error('server did not start'); }
  const stop = () => { proc.kill('SIGKILL'); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } };
  const alive = () => proc.exitCode === null && proc.signalCode === null;
  async function j(method, url, body, headers = {}) {
    const t = Date.now();
    const res = await fetch(base + url, { method, redirect: 'manual', headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, ms: Date.now() - t };
  }
  return { base, dir, proc, stop, alive, j };
}

module.exports = { startServer, sleep, PASSWORD };
