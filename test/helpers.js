'use strict';
// Boots the REAL server (src/server.js) on a temp database, for end-to-end tests.
const { spawn } = require('child_process');
const path = require('path');

async function boot({ dbDir, port }) {
  const logs = [];
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_DIR: dbDir, PORT: String(port), DISABLE_SCHEDULER: 'true', NODE_ENV: 'test',
      JWT_SECRET: 'test_secret_that_is_long_enough_123', SUPERADMIN_PASSWORD: 'Sup3r!secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  const base = `http://127.0.0.1:${port}/api/v1`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/health')).ok) break; } catch (_) { /* booting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  let token = null;
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch (_) { json = text; }
    return { status: res.status, body: json };
  };
  return { child, logs, call, port, token: () => token, setToken: (t) => { token = t; }, stop: () => child.kill() };
}

module.exports = { boot };
