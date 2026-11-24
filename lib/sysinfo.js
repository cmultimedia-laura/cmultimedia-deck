'use strict';
// Détails du Mac pour la page Performances : programmes les plus gourmands, disques, réseau, batterie, charge.
// Commandes système en lecture seule, toutes les 10 s, uniquement tant qu'un écran les demande.
const cp = require('child_process');
const os = require('os');
const U = require('./util');

let info = { t: 0 }, lastNet = null, lastAsk = 0, timer = null;
const ENV_C = Object.assign({}, process.env, { LC_ALL: 'C' });   // chiffres avec un point décimal
function run(file, args) { return new Promise(function (res) { cp.execFile(file, args, { timeout: 8000, env: ENV_C }, function (e, out) { res(e ? '' : String(out)); }); }); }

async function refresh() {
  const r = await Promise.all([
    run('/bin/ps', ['-Aceo', 'pid,pcpu,rss,comm', '-r']),
    run('/bin/df', ['-kl']),
    run('/usr/sbin/netstat', ['-ibn', '-I', 'en0']),
    run('/usr/bin/pmset', ['-g', 'batt'])
  ]);
  const ps = r[0], df = r[1], net = r[2], batt = r[3];
  const procs = ps.split('\n').slice(1).map(function (l) {
    const m = l.trim().match(/^(\d+)\s+([\d.,]+)\s+(\d+)\s+(.+)$/);
    return m ? { name: m[4].replace(/^com\.apple\./, '').slice(0, 40), cpu: Number(m[2].replace(',', '.')), memMB: Math.round(Number(m[3]) / 1024) } : null;
  }).filter(Boolean).slice(0, 8);
  const disks = df.split('\n').slice(1).map(function (l) {
    const p = l.trim().split(/\s+/); if (p.length < 9) return null;
    const mount = p.slice(8).join(' ');
    if (mount !== '/System/Volumes/Data' && (mount.indexOf('/Volumes/') !== 0 || /^\/Volumes\/(Recovery|Preboot|VM|Update)$/.test(mount))) return null;
    const total = Number(p[1]) * 1024, free = Number(p[3]) * 1024;
    return { name: mount === '/System/Volumes/Data' ? 'Disque interne' : mount.slice(9), totalGB: total / 1073741824, freeGB: free / 1073741824, pct: Math.round(100 * (total - free) / total) };
  }).filter(Boolean);
  let rx = null, tx = null;
  const nl = net.split('\n').find(function (l) { return /^en0\s.*<Link/.test(l); });
  if (nl) {
    const p = nl.trim().split(/\s+/), now = Date.now(), ib = Number(p[6]), ob = Number(p[9]);
    if (lastNet && now > lastNet.t) { rx = Math.max(0, (ib - lastNet.ib) / ((now - lastNet.t) / 1000)); tx = Math.max(0, (ob - lastNet.ob) / ((now - lastNet.t) / 1000)); }
    lastNet = { t: now, ib: ib, ob: ob };
  }
  const bm = batt.match(/(\d+)%;\s*([^;]+);/);
  let bstate = null;
  if (bm) bstate = /discharging/.test(bm[2]) ? 'sur batterie' : /not charging/.test(batt) ? 'sur secteur' : /charged/.test(bm[2]) ? 'chargée' : /charging/.test(bm[2]) ? 'en charge' : 'sur secteur';
  info = { t: Date.now(), procs: procs, disks: disks, net: { rxKBs: rx === null ? null : Math.round(rx / 1024), txKBs: tx === null ? null : Math.round(tx / 1024) },
    battery: bm ? { pct: Number(bm[1]), state: bstate } : null,
    load: os.loadavg().map(function (x) { return Math.round(x * 100) / 100; }), uptimeH: Math.round(os.uptime() / 3600), cores: os.cpus().length };
}
function get() {
  lastAsk = Date.now();
  if (!timer) {
    refresh().catch(function () {});
    timer = setInterval(function () {
      if (Date.now() - lastAsk > 60000) { clearInterval(timer); timer = null; return; }
      refresh().catch(function (e) { U.log('warn', 'sysinfo', { e: e.message }); });
    }, 10000);
  }
  return info;
}
module.exports = { get: get, refresh: refresh };
