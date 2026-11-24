'use strict';
// Exécution des actions NOMMÉES du catalogue. Aucune commande shell, aucun AppleScript libre,
// aucun chemin venant du navigateur : uniquement execFile avec des arguments construits ici.
const fs = require('fs');
const cp = require('child_process');
const U = require('./util');

const OPEN = '/usr/bin/open';
const OSA = '/usr/bin/osascript';
const presses = new Map();      // pressId -> { t, result } (anti double pression / reconnexion)
const running = {};             // actionId -> true
let hooks = { sendToDevices: null, mediaStopAll: null, refreshVolume: null, music: null };

// Scripts AppleScript figés (jamais construits à partir d'une saisie).
const VOLUME_SCRIPTS = {
  up: ['set v to output volume of (get volume settings)', 'set volume output volume (v + 6)', 'set volume without output muted'],
  down: ['set v to output volume of (get volume settings)', 'set volume output volume (v - 6)'],
  mute: ['set volume with output muted'],
  unmute: ['set volume without output muted']
};
const KEYNOTE_SCRIPTS = {
  next: ['if application "Keynote" is not running then error "Keynote n\'est pas ouvert"', 'tell application "Keynote" to show next'],
  previous: ['if application "Keynote" is not running then error "Keynote n\'est pas ouvert"', 'tell application "Keynote" to show previous'],
  play: ['if application "Keynote" is not running then error "Keynote n\'est pas ouvert"', 'tell application "Keynote"', 'if (count of documents) is 0 then error "Aucune présentation ouverte dans Keynote"', 'start front document', 'end tell']
};

function run(file, args, cb) {
  cp.execFile(file, args, { timeout: 15000 }, function (err, stdout, stderr) {
    if (err) return cb(new Error(cleanErr(stderr) || (err.killed ? 'délai dépassé' : err.message)));
    cb(null, String(stdout).trim());
  });
}
function cleanErr(s) {
  s = String(s || '').trim();
  const m = s.match(/execution error: (.*?) \(-?\d+\)/);
  return (m ? m[1] : s).slice(0, 200);
}
function osa(lines, cb) { const args = []; lines.forEach(function (l) { args.push('-e', l); }); run(OSA, args, cb); }

function appExists(name) {
  const dirs = ['/Applications', '/System/Applications', '/System/Applications/Utilities', '/Applications/Utilities', require('os').homedir() + '/Applications', '/System/Library/CoreServices'];
  return dirs.some(function (d) { return fs.existsSync(d + '/' + name + '.app'); });
}

function execOne(bundle, action, ctx, cb) {
  const p = action.params || {};
  const A = bundle.actions;
  switch (action.type) {
    case 'open_app': {
      const name = A.apps[p.app];
      if (!name) return cb(new Error('application non autorisée'));
      if (!appExists(name)) return cb(new Error('« ' + name + ' » n\'est pas installée sur ce Mac'));
      return run(OPEN, ['-a', name], function (e) { cb(e, { message: name + ' ouvert sur le Mac' }); });
    }
    case 'open_folder': {
      const dir = U.expandHome(A.folders[p.folder] || '');
      if (!dir) return cb(new Error('dossier non autorisé'));
      let st = null; try { st = fs.statSync(dir); } catch (e) { /* absent */ }
      if (!st || !st.isDirectory()) return cb(new Error('dossier introuvable sur le Mac'));
      return run(OPEN, [dir], function (e) { cb(e, { message: 'Dossier ouvert sur le Mac' }); });
    }
    case 'open_url':
      if (!/^https?:\/\//.test(p.url || '')) return cb(new Error('URL refusée'));
      return run(OPEN, [p.url], function (e) { cb(e, { message: 'Ouvert sur le Mac' }); });
    case 'ipad_url':
      return cb(null, { client: { openUrl: p.url }, message: 'Ouverture sur l\'iPad' });
    case 'page':
      if (ctx.origin === 'cli' && hooks.sendToDevices) {
        const c = hooks.sendToDevices('show', { page: p.page });
        return cb(null, { message: 'Page « ' + p.page + ' » demandée aux appareils', command: c.id });
      }
      return cb(null, { client: { page: p.page } });
    case 'volume':
      if (!VOLUME_SCRIPTS[p.op]) return cb(new Error('opération de volume inconnue'));
      return osa(VOLUME_SCRIPTS[p.op], function (e) {
        if (e) return cb(e);
        if (hooks.refreshVolume) hooks.refreshVolume(function (v) { cb(null, { message: v ? ('Volume de sortie : ' + v.volume + ' %' + (v.muted ? ' (coupé)' : '')) : 'Volume modifié', volume: v }); });
        else cb(null, { message: 'Volume modifié' });
      });
    case 'keynote':
      if (!KEYNOTE_SCRIPTS[p.op]) return cb(new Error('opération Keynote inconnue'));
      if (!appExists('Keynote')) return cb(new Error('Keynote n\'est pas installé sur ce Mac'));
      return osa(KEYNOTE_SCRIPTS[p.op], function (e) { cb(e, { message: 'Keynote : ' + ({ next: 'diapo suivante', previous: 'diapo précédente', play: 'diaporama lancé' })[p.op] }); });
    case 'music':
      if (!hooks.music) return cb(new Error('module musique indisponible'));
      return hooks.music(p.op, cb);
    case 'media_stop':
      if (!hooks.mediaStopAll) return cb(new Error('module média indisponible'));
      return cb(null, { message: hooks.mediaStopAll('action ' + action.id) });
    default: return cb(new Error('type d\'action non pris en charge'));
  }
}

// Point d'entrée : exécute une action du catalogue, gère séquences, doubles pressions et verrous.
function execute(bundle, actionId, ctx, cb) {
  ctx = ctx || {};
  const now = Date.now();
  for (const [k, v] of presses) if (now - v.t > 600000) presses.delete(k);
  if (ctx.pressId) {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(ctx.pressId)) return cb({ ok: false, error: 'identifiant de pression invalide' });
    const seen = presses.get(ctx.pressId);
    if (seen) return cb(Object.assign({ duplicate: true }, seen.result || { ok: true, pending: true, message: 'Déjà en cours' }));
    presses.set(ctx.pressId, { t: now, result: null });
  }
  const action = (bundle.actions.actions || []).find(function (a) { return a.id === actionId; });
  const finish = function (res) {
    if (ctx.pressId && presses.has(ctx.pressId)) presses.get(ctx.pressId).result = res;
    U.log(res.ok ? 'info' : 'warn', 'action ' + actionId + (res.ok ? ' réussie' : ' en échec'), { origine: ctx.origin, erreur: res.error, etape: res.failedStep });
    cb(res);
  };
  if (!action) return finish({ ok: false, error: 'action inconnue « ' + actionId + ' »' });
  if (running[actionId]) return finish({ ok: false, busy: true, error: 'Cette action est déjà en cours' });
  running[actionId] = true;
  const done = function (res) { delete running[actionId]; finish(res); };

  if (action.type !== 'sequence') {
    return execOne(bundle, action, ctx, function (err, out) {
      done(err ? { ok: false, error: err.message } : Object.assign({ ok: true }, out || {}));
    });
  }
  const steps = action.params.steps;
  const results = [];
  const client = {};
  (function next(i) {
    if (i >= steps.length) return done({ ok: true, message: action.label + ' : ' + steps.length + ' étape(s) réussie(s)', steps: results, client: Object.keys(client).length ? client : undefined });
    const st = (bundle.actions.actions || []).find(function (a) { return a.id === steps[i]; });
    execOne(bundle, st, ctx, function (err, out) {
      if (err) {
        results.push({ step: i + 1, action: steps[i], ok: false, error: err.message });
        return done({ ok: false, error: 'Échec à l\'étape ' + (i + 1) + ' (« ' + (st ? st.label : steps[i]) + ' ») : ' + err.message, failedStep: i + 1, steps: results });
      }
      results.push({ step: i + 1, action: steps[i], ok: true });
      if (out && out.client) Object.assign(client, out.client);
      next(i + 1);
    });
  })(0);
}

module.exports = { execute: execute, setHooks: function (h) { hooks = Object.assign(hooks, h); }, appExists: appExists, VOLUME_SCRIPTS: VOLUME_SCRIPTS };
