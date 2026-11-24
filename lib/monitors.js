'use strict';
// Contrôles HTTP des services configurés : code, durée de réponse, date, état (ok / alert / unknown).
const http = require('http');
const https = require('https');
const U = require('./util');
const metrics = require('./metrics');

const state = {};           // id -> { id, label, url, status, code, ms, t, error, since }
let timer = null;
let getBundle = null;
const listeners = [];
let extra = [];             // moniteurs ajoutés par un module (aucun par défaut)
function setExtra(list) { extra = Array.isArray(list) ? list : []; }
// État fourni par une source externe (aucune par défaut) : id -> { id, label, url, group, status, ms, t }
let external = {};
function setExternal(list) {
  const next = {};
  const maxAge = ((getBundle && getBundle().settings.historyMinutes) || 60) * 60000;
  (list || []).forEach(function (x) {
    const prev = external[x.id];
    if (x.t && (!prev || prev.t !== x.t)) metrics.push('svc:' + x.id, x.t, x.status === 'ok' ? x.ms : null, maxAge);
    next[x.id] = Object.assign({}, x, { since: prev && prev.status === x.status ? prev.since : Date.now(), external: true });
  });
  external = next;
}

// Sonde ping (ICMP) pour les serveurs et le réseau : aucune connexion SSH, rien qui puisse déclencher fail2ban.
function ping(m, cb) {
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(m.host || '')) return cb({ code: null, ms: null, error: 'hôte invalide' });
  require('child_process').execFile('/sbin/ping', ['-c', '1', '-t', '3', m.host], { timeout: 5000 }, function (e, out) {
    const t = String(out || '').match(/time=([0-9.]+) ms/);
    if (e || !t) return cb({ code: null, ms: null, error: 'pas de réponse au ping' });
    cb({ code: 'ping', ms: Math.round(Number(t[1])), error: null });
  });
}

function check(m, cb) {
  if (m.kind === 'ping') return ping(m, cb);
  const lib = m.url.indexOf('https:') === 0 ? https : http;
  const t0 = process.hrtime.bigint();
  let done = false;
  const finish = function (code, err) {
    if (done) return; done = true;
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    cb({ code: code, ms: err ? null : Math.round(ms), error: err || null });
  };
  let req;
  try {
    req = lib.request(m.url, { method: 'GET', timeout: m.timeoutMs || 10000, headers: { 'User-Agent': 'CMULTIMEDIA-Deck/1.0 (surveillance locale)', 'Accept': 'text/html,*/*' } }, function (res) {
      res.resume();
      res.on('end', function () { finish(res.statusCode, null); });
      res.on('error', function (e) { finish(res.statusCode, e.code || e.message); });
      setTimeout(function () { req.destroy(); finish(res.statusCode, null); }, 3000).unref();
    });
  } catch (e) { return finish(null, 'URL invalide'); }
  req.on('timeout', function () { req.destroy(); finish(null, 'délai dépassé'); });
  req.on('error', function (e) { finish(null, e.code === 'ENOTFOUND' ? 'DNS introuvable (Internet coupé ?)' : (e.code || e.message)); });
  req.end();
}

function runAll() {
  const b = getBundle();
  const st = b.settings;
  const maxAge = (st.historyMinutes || 60) * 60000;
  const ids = {};
  const now = Date.now();
  (b.connectors.monitors || []).concat(extra).forEach(function (m) {
    if (m.enabled === false) return;
    ids[m.id] = true;
    // Fréquence propre (everySec) : les sites importés sont contrôlés moins souvent que les systèmes principaux.
    if (m.everySec && state[m.id] && state[m.id].t && now - state[m.id].t < m.everySec * 1000 - 3000) return;
    const prev = state[m.id] || { id: m.id, status: 'unknown', since: Date.now() };
    state[m.id] = Object.assign(prev, { id: m.id, label: m.label, url: m.url || null, host: m.host || null, kind: m.kind || 'http', group: m.group || 'Services', everySec: m.everySec || null, imported: !!m.imported });
    check(m, function (r) {
      const t = Date.now();
      let status = 'ok';
      if (r.error || !r.code || (r.code !== 'ping' && (r.code >= 500 || (r.code >= 400 && r.code !== 401 && r.code !== 403)))) status = 'alert';
      const slow = r.ms !== null && m.slowMs && r.ms > m.slowMs;
      const s = state[m.id];
      if (!s) return;
      const changed = s.status !== status;
      Object.assign(s, { status: status, slow: !!slow, code: r.code, ms: r.ms, t: t, error: r.error });
      if (changed) { s.since = t; U.log('info', 'service ' + m.id + ' → ' + status, { code: r.code, erreur: r.error }); }
      metrics.push('svc:' + m.id, t, status === 'ok' ? r.ms : null, maxAge);
      listeners.forEach(function (fn) { fn(s, changed); });
    });
  });
  Object.keys(state).forEach(function (id) { if (!ids[id]) delete state[id]; });
}

// Une mesure plus vieille que 3 intervalles devient « inconnu » mais garde son horodatage.
function snapshot() {
  const b = getBundle();
  const stale = (b.settings.httpIntervalSec || 60) * 3000;
  const now = Date.now();
  return Object.keys(state).map(function (id) {
    const s = Object.assign({}, state[id]);
    s.stale = !s.t || now - s.t > Math.max(stale, (s.everySec || 0) * 3000);
    s.effective = s.stale ? 'unknown' : s.status;
    return s;
  }).concat(Object.keys(external).map(function (id) {
    const s = Object.assign({}, external[id]);
    s.stale = !s.t || now - s.t > 15 * 60000;      // Monitor contrôle toutes les quelques minutes
    s.effective = s.stale ? 'unknown' : s.status;
    return s;
  }));
}

function counts() {
  const c = { ok: 0, alert: 0, unknown: 0 };
  snapshot().forEach(function (s) { c[s.effective]++; });
  return c;
}

function start(bundleGetter) {
  getBundle = bundleGetter;
  stop();
  const loop = function () { runAll(); timer = setTimeout(loop, (getBundle().settings.httpIntervalSec || 60) * 1000); };
  timer = setTimeout(loop, 1500);
}
function stop() { if (timer) clearTimeout(timer); timer = null; }

module.exports = { setExternal: setExternal, setExtra: setExtra, start: start, stop: stop, snapshot: snapshot, counts: counts, runAll: runAll, check: check, onResult: function (fn) { listeners.push(fn); } };
