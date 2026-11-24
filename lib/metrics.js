'use strict';
// Collecte des mesures du Mac (processeur, mémoire, disque, volume de sortie) et historique.
// Données réelles par défaut. Le mode démo n'est actif que si settings.demo === true et chaque mesure porte demo: true.
const os = require('os');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const U = require('./util');

const HIST_FILE = () => path.join(U.DATA, 'history.json');
const series = {};          // source -> [[t, v|null], ...]
let current = { t: 0 };
let prevCpu = null;
let timer = null, persistTimer = null;
let getSettings = function () { return {}; };
const listeners = [];

function push(source, t, v, maxAgeMs) {
  const s = series[source] || (series[source] = []);
  s.push([t, v === null || v === undefined || isNaN(v) ? null : Math.round(v * 100) / 100]);
  const limit = t - maxAgeMs;
  while (s.length && s[0][0] < limit) s.shift();
}

function cpuPercent() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  cpus.forEach(function (c) { const t = c.times; idle += t.idle; total += t.user + t.nice + t.sys + t.idle + t.irq; });
  let pct = null;
  if (prevCpu && total > prevCpu.total) pct = 100 * (1 - (idle - prevCpu.idle) / (total - prevCpu.total));
  prevCpu = { idle: idle, total: total };
  return pct === null ? null : U.clamp(pct, 0, 100);
}

// Mémoire « utilisée » au sens du Moniteur d'activité : mémoire des applications + câblée + compressée.
function memory(cb) {
  cp.execFile('/usr/bin/vm_stat', { timeout: 4000 }, function (err, out) {
    const total = os.totalmem();
    if (err) return cb({ total: total, used: total - os.freemem(), approx: true });
    const page = Number((out.match(/page size of (\d+)/) || [])[1]) || 16384;
    const get = function (label) { const m = out.match(new RegExp(label + ':\\s+(\\d+)')); return m ? Number(m[1]) : 0; };
    const anon = get('Anonymous pages'), purge = get('Pages purgeable'), wired = get('Pages wired down'), comp = get('Pages occupied by compressor');
    let used = (anon - purge + wired + comp) * page;
    if (!anon) used = (get('Pages active') + wired + comp) * page;
    cb({ total: total, used: U.clamp(used, 0, total), approx: !anon });
  });
}

function disk() {
  try {
    const target = fs.existsSync('/System/Volumes/Data') ? '/System/Volumes/Data' : '/';
    const st = fs.statfsSync(target);
    const total = st.blocks * st.bsize, free = st.bavail * st.bsize;
    return { total: total, free: free, used: total - free };
  } catch (e) { return null; }
}

function volume(cb) {
  cp.execFile('/usr/bin/osascript', ['-e', 'set v to get volume settings', '-e', 'return (output volume of v as text) & "," & (output muted of v as text)'], { timeout: 4000 }, function (err, out) {
    if (err) return cb(null);
    const parts = String(out).trim().split(',');
    const v = Number(parts[0]);
    cb({ volume: isNaN(v) ? null : v, muted: parts[1] === 'true' });
  });
}

const GB = 1024 * 1024 * 1024;
function collect() {
  const st = getSettings();
  const t = Date.now();
  const maxAge = (st.historyMinutes || 60) * 60000;
  if (st.demo) return collectDemo(t, maxAge);
  const cpu = cpuPercent();
  memory(function (m) {
    volume(function (vol) {
      const d = disk();
      current = {
        t: t, demo: false,
        cpu: cpu,
        memUsedGB: m.used / GB, memTotalGB: m.total / GB, memPct: 100 * m.used / m.total,
        diskFreeGB: d ? d.free / GB : null, diskTotalGB: d ? d.total / GB : null, diskUsedGB: d ? d.used / GB : null,
        diskPct: d ? 100 * d.used / d.total : null,
        volume: vol ? vol.volume : null, muted: vol ? vol.muted : null,
        cores: os.cpus().length, uptimeSec: os.uptime()
      };
      push('cpu', t, cpu, maxAge);
      push('mem', t, current.memUsedGB, maxAge);
      push('disk', t, current.diskUsedGB, maxAge);
      push('volume', t, current.volume, maxAge);
      emit();
    });
  });
}

let demoPhase = 0;
function collectDemo(t, maxAge) {
  demoPhase += 0.15;
  const cpu = 35 + 25 * Math.sin(demoPhase) + 10 * Math.random();
  current = { t: t, demo: true, cpu: cpu, memUsedGB: 11 + Math.sin(demoPhase / 3), memTotalGB: 18, memPct: 100 * (11 + Math.sin(demoPhase / 3)) / 18,
    diskFreeGB: 210, diskTotalGB: 494, diskUsedGB: 284, diskPct: 57, volume: 40, muted: false, cores: 12, uptimeSec: 3600 };
  push('cpu', t, cpu, maxAge); push('mem', t, current.memUsedGB, maxAge); push('disk', t, 284, maxAge); push('volume', t, 40, maxAge);
  emit();
}

function emit() { listeners.forEach(function (fn) { try { fn(current); } catch (e) { U.log('error', 'listener metrics', { e: e.message }); } }); }

function persist() {
  try { U.writeJSON(HIST_FILE(), { savedAt: Date.now(), series: series }); } catch (e) { U.log('warn', 'historique non sauvegardé', { e: e.message }); }
}

function restoreHistory(maxAgeMs) {
  const h = U.readJSON(HIST_FILE(), null);
  if (!h || !h.series) return;
  const limit = Date.now() - maxAgeMs;
  Object.keys(h.series).forEach(function (k) {
    if (!/^(cpu|mem|disk|volume|svc:[a-z0-9_-]+)$/.test(k)) return;
    series[k] = (h.series[k] || []).filter(function (p) { return Array.isArray(p) && p[0] >= limit; });
  });
}

function start(settingsGetter) {
  getSettings = settingsGetter;
  const st = getSettings();
  restoreHistory((st.historyMinutes || 60) * 60000);
  cpuPercent();
  stop();
  const loop = function () { collect(); timer = setTimeout(loop, (getSettings().metricsIntervalSec || 5) * 1000); };
  timer = setTimeout(loop, 1000);
  persistTimer = setInterval(persist, 60000);
}
function stop() { if (timer) clearTimeout(timer); if (persistTimer) clearInterval(persistTimer); timer = persistTimer = null; }

// Historique d'une source sur une fenêtre (secondes). Points nuls = trous à respecter dans la courbe.
function history(source, windowSec) {
  const s = series[source] || [];
  const limit = Date.now() - windowSec * 1000;
  return s.filter(function (p) { return p[0] >= limit; });
}

module.exports = {
  start: start, stop: stop, persist: persist, history: history, push: push,
  current: function () { return current; },
  onSample: function (fn) { listeners.push(fn); },
  refreshVolume: function (cb) { volume(function (v) { if (v) { current.volume = v.volume; current.muted = v.muted; } if (cb) cb(v); }); },
  _series: series
};
