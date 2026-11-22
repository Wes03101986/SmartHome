// E3DC S10 per Modbus TCP lesen (ohne Zusatzpakete). Modbus muss am Gerät aktiviert sein (Protokoll "E3/DC").
const net = require('net');
function modbus(host, port, unit, reads) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host), out = []; let buf = Buffer.alloc(0), i = 0, done = false;
    const end = (err, val) => { if (done) return; done = true; sock.destroy(); err ? reject(err) : resolve(val); };
    const next = () => {
      if (i >= reads.length) return end(null, out);
      const [a, q] = reads[i], b = Buffer.alloc(12);
      b.writeUInt16BE(i + 1, 0); b.writeUInt16BE(0, 2); b.writeUInt16BE(6, 4); b[6] = unit; b[7] = 3;
      b.writeUInt16BE(a, 8); b.writeUInt16BE(q, 10); sock.write(b);
    };
    sock.setTimeout(4000, () => end(new Error('Zeitüberschreitung')));
    sock.on('connect', next); sock.on('error', end);
    sock.on('close', () => end(new Error('Verbindung geschlossen')));
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 9 || buf.length < 6 + buf.readUInt16BE(4)) return;
      if (buf[7] & 0x80) return end(new Error('Modbus-Fehlercode ' + buf[8]));
      const regs = []; for (let k = 0; k < buf[8] / 2; k++) regs.push(buf.readUInt16BE(9 + 2 * k));
      out.push(regs); buf = Buffer.alloc(0); i++; next();
    });
  });
}
const i32 = (r, i) => ((r[i + 1] << 16) | r[i]) | 0;   // E3DC: niederwertiges Wort zuerst
async function readSolar({ ip, port = 502, unit = 1 }) {
  const [magic, r] = await modbus(ip, port, unit, [[0, 1], [67, 16]]);   // 40001 = Kennung, ab 40068 die Leistungswerte
  return { magicOk: magic[0] === 0xE3DC, pv: i32(r, 0), batt: i32(r, 2), house: i32(r, 4), grid: i32(r, 6), add: i32(r, 8),
           wallbox: i32(r, 10), autarky: r[14] >> 8, selfUse: r[14] & 255, soc: r[15], ts: Date.now() };
}
module.exports = { readSolar };
