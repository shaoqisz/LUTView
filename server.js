import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { parseLut, nativeSelection } from './lut.js';

const home = path.dirname(fileURLToPath(import.meta.url));
const token = randomBytes(32).toString('hex');
const port = Number(process.env.PORT ?? 3210);
const exe = path.join(home, 'native', 'bin', 'Release', 'net9.0-windows', 'LUTBridge.exe');
const filenames = { main: 'correctionLUT.xml', touch: 'TSCorrectionLUT.xml' };
let bridge;
let bridgeError = 'Native bridge not built. Run npm run build:native (requires .NET 9 SDK).';
let sequence = 0;
let pending = null;
let busy = false;
let status = { active: false, error: null };
if (existsSync(exe)) {
  bridge = spawn(exe, [], { cwd: home, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  bridge.stderr.on('data', (d) => console.error(`Native: ${d}`));
  createInterface({ input: bridge.stdout }).on('line', (line) => {
    try {
      const message = JSON.parse(line);
      if (message.event) {
        status = message;
        if (message.error) console.error(`Native: ${message.error}`);
      } else if (pending?.id === message.id) {
        const current = pending;
        pending = null;
        clearTimeout(current.timer);
        if (message.state) status = message.state;
        if (message.error) current.reject(new Error(message.error));
        else {
          if (message.result?.active !== undefined) status = message.result;
          current.resolve(message.result);
        }
      }
    } catch (error) { console.error(`Native protocol: ${error.message}`); }
  });
  function unavailable(error) {
    bridgeError = error;
    status = { ...status, unknown: true, error };
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error(error)); pending = null; }
    bridge = null;
  }
  bridge.on('error', (error) => unavailable(error.message));
  bridge.on('exit', (code) => unavailable(`Native bridge exited (${code}); inspect terminal and restart.`));
}

function native(command) {
  if (!bridge) throw new Error(bridgeError);
  if (pending) throw new Error('Native request in progress');
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending = null;
      status = { ...status, unknown: true, error: 'Display API timed out; hardware state is unknown. Restore or restart to recover.' };
      reject(new Error('Display API timed out. No success assumed; check native status before retrying.'));
    }, 20000);
    pending = { id, resolve, reject, timer };
    bridge.stdin.write(JSON.stringify({ id, ...command }) + '\n');
  });
}

async function load(kind) {
  if (!Object.hasOwn(filenames, kind)) throw new Error('Unknown LUT kind');
  return parseLut(await readFile(path.join(home, filenames[kind]), 'utf8'), filenames[kind]);
}
function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, {
    'Content-Type': type, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'"
  });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/mapping.js': ['mapping.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8']
};
const server = http.createServer(async (req, res) => {
  try {
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`)
      return send(res, 403, { error: 'Local host only' });
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.method === 'GET') {
      if (url.pathname === '/api/session') return send(res, 200, { token });
      if (url.pathname === '/api/lut') return send(res, 200, await load(url.searchParams.get('kind')));
      if (url.pathname === '/api/status') return send(res, 200, status);
      if (url.pathname === '/api/displays') {
        if (busy) return send(res, 409, { error: 'Hardware request in progress' });
        busy = true;
        try { return send(res, 200, await native({ action: 'list' })); }
        finally { busy = false; }
      }
      if (Object.hasOwn(staticFiles, url.pathname)) {
        const [file, type] = staticFiles[url.pathname];
        return send(res, 200, await readFile(path.join(home, 'public', file)), type);
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/hardware') {
      if (req.headers['x-lut-token'] !== token ||
          (req.headers.origin !== `http://127.0.0.1:${port}` && req.headers.origin !== `http://localhost:${port}`))
        return send(res, 403, { error: 'Invalid local session/origin' });
      if (busy) return send(res, 409, { error: 'Hardware request in progress' });
      busy = true;
      try {
        let text = '';
        for await (const chunk of req) {
          text += chunk;
          if (text.length > 4096) throw new Error('Request too large');
        }
        const input = JSON.parse(text);
        if (input.action === 'restore') return send(res, 200, await native({ action: 'restore' }));
        if (!['gamma', 'brightness'].includes(input.action)) throw new Error('Unknown hardware action');
        if (input.confirm !== true) throw new Error('Explicit confirmation required');
        if (!['intel', 'gdi'].includes(input.backend)) throw new Error('Unknown backend');
        const model = await load(input.kind);
        if (input.digest !== model.digest) throw new Error('XML changed since preview. Reload XML before applying.');
        const selection = nativeSelection(model, input.indices);
        return send(res, 200, await native({
          action: input.action, backend: input.backend, display: input.display,
          rows: selection.rows, brightness: selection.backlight
        }));
      } finally { busy = false; }
    }
    send(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error.message);
    if (!res.headersSent) send(res, 400, { error: error.message });
  }
});
server.listen(port, '127.0.0.1', () => console.log(`LUTView: http://127.0.0.1:${port}\nHardware is unchanged until explicitly requested in the UI.`));
server.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
  if (bridge) bridge.stdin.end();
});
function shutdown() {
  server.close();
  // EOF asks the bridge to restore its snapshots before exiting.
  if (bridge) bridge.stdin.end();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
