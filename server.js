// KNX/IP + Philips Hue Bridge -> Web-Dashboard (Node >= 18)
const http = require('http'), fs = require('fs'), path = require('path'), knx = require('knx');
const cfg = require('./config.json');
const { readSolar } = require('./solar.js');
const { spawn } = require('child_process');
const SOLAR = { enabled: true, mode: 'rscp', ip: '192.168.0.61', port: 502, unit: 1, bridgePort: 5051, ...cfg.solar };   // E3DC S10 SE
const state = {};              // id -> { on, level }
const clients = new Set();
const push = () => clients.forEach(r => r.write(`data: ${JSON.stringify(snapshot())}\n\n`));
const snapshot = () => ({ knx: cfg.devices.map(d => ({ ...d, ...state[d.id] })), hue: hueLights, knxOk, hueOk, solar, solarOk });
let knxOk = false, hueOk = false, hueLights = [], solar = null, solarOk = false;

// ---------- KNX ----------
// Welche Statuswerte je Gerätetyp aus welchen Gruppenadressen gelesen werden: [Schlüssel, config-Feld, Datentyp]
const SPEC = {
  switch:  [['on', 'status_ga', 'DPT1.001']],
  dimmer:  [['on', 'status_ga', 'DPT1.001'], ['level', 'dim_status_ga', 'DPT5.001']],
  blind:   [['pos', 'pos_ga', 'DPT5.001']],
  gate:    [['pos', 'pos_ga', 'DPT5.001']],
  sensor:  [['value', 'ga', null]],
  heating: [['temp', 'temp_ga', 'DPT9.001'], ['soll', 'soll_ga', 'DPT9.001'], ['stell', 'stell_ga', 'DPT5.001'], ['shift', 'shift_ga', 'DPT9.002']]
};
const dpCache = {};
const dp = (ga, dpt) => dpCache[ga + dpt] ??= new knx.Datapoint({ ga, dpt }, conn);
const send = (ga, dpt, v) => ga && dp(ga, dpt).write(v);
const conn = knx.Connection({
  ipAddr: cfg.knx.ip, ipPort: cfg.knx.port, physAddr: '15.15.200', suppress_ack_ldatareq: true,
  handlers: {
    connected() {
      knxOk = true; console.log('KNX verbunden');
      for (const d of cfg.devices) {
        state[d.id] = {};
        for (const [key, field, dpt] of SPEC[d.type] || []) {
          const ga = d[field] || (key === 'on' && d.ga); if (!ga) continue;
          const p = dp(ga, dpt || d.dpt);
          p.on('change', (_, v) => { state[d.id][key] = typeof v === 'number' ? Math.round(v * 10) / 10 : v; push(); });
          p.read();
        }
      }
      push();
    },
    error(e) { knxOk = false; console.error('KNX-Fehler:', e); push(); }
  }
});
const COMMANDS = {                       // Befehl -> Aktion (Gerät d, Wert v)
  on:    (d, v) => send(d.ga, 'DPT1.001', v ? 1 : 0),
  dim:   (d, v) => send(d.dim_ga, 'DPT3.007', { decr_incr: v === 'up' ? 1 : 0, data: v === 'stop' ? 0 : 1 }), // relatives Dimmen
  move:  (d, v) => send(d.move_ga || d.ga, 'DPT1.001', v === 'down' || v === 'open' ? 1 : 0),
  stop:  d => send(d.stop_ga, 'DPT1.001', 1),
  shift: (d, v) => send(d.shift_ga, 'DPT9.002', Math.max(-5, Math.min(5, v)))
};

// ---------- Hue (API v1, HTTPS im LAN) ----------
const https = require('https');
const hueAgent = new https.Agent({ rejectUnauthorized: false }); // Bridge nutzt selbst signiertes Zertifikat (nur LAN)
const hue = (p, method = 'GET', payload) => new Promise((resolve, reject) => {
  const data = payload ? JSON.stringify(payload) : null;
  const req = https.request({ host: cfg.hue.bridge, path: `/api/${cfg.hue.user}${p}`, method, agent: hueAgent,
    headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, res => {
    let s = ''; res.on('data', c => s += c); res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(new Error(s.slice(0, 100))); } });
  });
  req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('Timeout')));
  if (data) req.write(data); req.end();
});
async function pollHue() {
  try {
    const l = await hue('/lights'); if (Array.isArray(l)) throw new Error(l[0]?.error?.description);
    const g = await hue('/groups').catch(() => ({})), roomOf = {};   // Hue-Räume -> Zuordnung der Leuchten
    if (!Array.isArray(g)) for (const grp of Object.values(g)) if (grp.type === 'Room') (grp.lights || []).forEach(i => roomOf[i] = grp.name);
    hueLights = Object.entries(l).map(([id, x]) => ({ id, name: x.name, room: cfg.hueRooms?.[x.name] ?? cfg.hueRooms?.[roomOf[id]] ?? roomOf[id], reachable: x.state.reachable,
      on: x.state.on, bri: x.state.bri ?? 0, color: !!x.state.hue || !!x.state.xy, hue: x.state.hue, sat: x.state.sat, ct: x.state.ct }));
    hueOk = true;
  } catch (e) { hueOk = false; console.error('Hue-Fehler:', e.message); }
  push();
}
setInterval(pollHue, 4000); pollHue();

// ---------- Solar (E3DC per Modbus TCP) ----------
let solarErr = '';
async function pollSolar() {
  try {
    solar = SOLAR.mode === 'modbus' ? await readSolar(SOLAR) : await readRscp(); solarOk = true; solarErr = '';
    if (!solar.magicOk) console.warn('Solar: Gerät antwortet, aber nicht im E3/DC-Modbus-Format (Modbus-Protokoll prüfen).');
  } catch (e) { solarOk = false; if (e.message !== solarErr) console.error('Solar-Fehler:', e.message); solarErr = e.message; }
  push();
}
const readRscp = async () => {            // Werte von der Python-Brücke (e3dc_bridge.py)
  const j = await (await fetch(`http://127.0.0.1:${SOLAR.bridgePort}/`)).json();
  if (j.error) throw new Error(j.error);
  return { ...j, magicOk: true, ts: Date.now() };
};
let bridge;
function startBridge() {                 // Python-Brücke starten (probiert mehrere Programmnamen)
  const cmds = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
  const tryStart = i => {
    if (i >= cmds.length) return console.error('Solar: Python nicht gefunden. Bitte Python 3 installieren (python.org) und "pip install pye3dc" ausführen.');
    bridge = spawn(cmds[i], [path.join(__dirname, 'e3dc_bridge.py')], { stdio: ['ignore', 'inherit', 'inherit'] });
    bridge.on('error', () => tryStart(i + 1));
  };
  tryStart(0); process.on('exit', () => bridge && bridge.kill());
}
if (SOLAR.enabled) { if (SOLAR.mode !== 'modbus') startBridge(); setInterval(pollSolar, 5000); setTimeout(pollSolar, 2000); }

// ---------- HTTP ----------
const body = req => new Promise(r => { let s = ''; req.on('data', c => s += c); req.on('end', () => r(JSON.parse(s || '{}'))); });
http.createServer(async (req, res) => {
  if (req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    clients.add(res); req.on('close', () => clients.delete(res)); return res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  }
  if (req.method === 'POST' && req.url === '/api/knx') {
    const { id, cmd, value } = await body(req), d = cfg.devices.find(x => x.id === id);
    if (d && COMMANDS[cmd]) COMMANDS[cmd](d, value);
    return res.end('{}');
  }
  if (req.method === 'POST' && req.url === '/api/hue') {
    const { id, ...s } = await body(req); await hue(`/lights/${id}/state`, 'PUT', s); pollHue(); return res.end('{}');
  }
  const f = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url.replace(/\.\./g, ''));
  fs.readFile(f, (e, d) => e ? (res.writeHead(404), res.end()) : res.end(d));
}).listen(cfg.port, () => console.log(`Dashboard: http://localhost:${cfg.port}`));
