'use strict';
// Configuration du deck : 4 fichiers séparés (réglages, actions, connecteurs, disposition).
// Validation complète avant tout enregistrement, sauvegarde de la dernière configuration valide.
const fs = require('fs');
const path = require('path');
const U = require('./util');

const FILES = ['settings', 'actions', 'connectors', 'layout'];
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const WIDGET_TYPES = ['button', 'light', 'counter', 'gauge', 'chart', 'vumeter', 'camera', 'services', 'media', 'ipadcapture', 'recordings', 'text', 'music', 'claude', 'ai', 'systems', 'codex', 'playlists', 'procs', 'sysinfo', 'apps', 'trackpad', 'keyboard'];
const ACTION_TYPES = ['open_app', 'open_folder', 'open_url', 'ipad_url', 'volume', 'keynote', 'sequence', 'page', 'media_stop', 'music'];
const SOURCE_RE = /^(cpu|mem|disk|volume|mic\.level|svc\.count\.(ok|alert|unknown)|svc:[a-z0-9_-]+)$/;
const GRID_COLS = 12, GRID_ROWS = 8;

let current = null;
let version = 0;
const listeners = [];

function dir() { return U.CONFIG_DIR; }
function backupsDir() { return path.join(U.DATA, 'config-backups'); }

function loadFromDisk() {
  const bundle = {};
  FILES.forEach(function (f) { bundle[f] = U.readJSON(path.join(dir(), f + '.json')); });
  return bundle;
}

function isStr(v, max) { return typeof v === 'string' && v.length > 0 && v.length <= (max || 200); }
function isUrl(v) { return typeof v === 'string' && /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[^\s"'<>]*)?$/.test(v) && v.length < 500; }
function isColor(v) { return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v); }

// Renvoie la liste des erreurs (vide = valide). Les messages sont en français et localisés (fichier > élément).
function validate(b) {
  const errs = [];
  const E = function (where, msg) { errs.push(where + ' : ' + msg); };
  if (!b || typeof b !== 'object') return ['configuration absente'];
  FILES.forEach(function (f) { if (!b[f] || typeof b[f] !== 'object') E(f, 'fichier manquant ou illisible'); });
  if (errs.length) return errs;

  // --- settings
  const s = b.settings;
  const num = function (k, a, z) { if (typeof s[k] !== 'number' || s[k] < a || s[k] > z) E('settings.' + k, 'nombre attendu entre ' + a + ' et ' + z); };
  num('portHttp', 1024, 65535); num('portHttps', 1024, 65535);
  num('metricsIntervalSec', 1, 300); num('httpIntervalSec', 10, 3600); num('historyMinutes', 60, 1440);
  num('maxCaptureSec', 5, 1800); num('disconnectGraceSec', 5, 300); num('previewFps', 0.2, 10); num('previewWidth', 160, 1280);
  if (s.portHttp === s.portHttps) E('settings', 'les ports HTTP et HTTPS doivent différer');
  if (!isColor(s.accent)) E('settings.accent', 'couleur #RRGGBB attendue');
  if (['normal', 'reduit', 'desactive'].indexOf(s.animations) < 0) E('settings.animations', 'normal, reduit ou desactive');
  if (typeof s.demo !== 'boolean') E('settings.demo', 'true ou false');

  // --- actions
  const a = b.actions;
  const apps = a.apps || {}, folders = a.folders || {};
  Object.keys(apps).forEach(function (k) { if (!ID_RE.test(k) || !/^[\w .\-éèàç]{1,60}$/i.test(apps[k])) E('actions.apps.' + k, 'nom d\'application invalide'); });
  Object.keys(folders).forEach(function (k) {
    const p = U.expandHome(folders[k]);
    if (!ID_RE.test(k) || typeof p !== 'string' || !path.isAbsolute(p) || p.indexOf('..') >= 0 || !p.startsWith(require('os').homedir())) E('actions.folders.' + k, 'chemin absolu sous le dossier personnel attendu');
  });
  const actionIds = {};
  if (!Array.isArray(a.actions)) E('actions.actions', 'liste attendue');
  (a.actions || []).forEach(function (x, i) {
    const w = 'actions.actions[' + (x && x.id || i) + ']';
    if (!x || !ID_RE.test(x.id || '')) return E(w, 'identifiant invalide (minuscules, chiffres, - et _)');
    if (actionIds[x.id]) E(w, 'identifiant en double');
    actionIds[x.id] = x;
    if (!isStr(x.label, 60)) E(w, 'libellé manquant (60 caractères max)');
    if (ACTION_TYPES.indexOf(x.type) < 0) return E(w, 'type inconnu « ' + x.type + ' »');
    const p = x.params || {};
    switch (x.type) {
      case 'open_app': if (!apps[p.app]) E(w, 'application non autorisée « ' + p.app + ' »'); break;
      case 'open_folder': if (!folders[p.folder]) E(w, 'dossier non autorisé « ' + p.folder + ' »'); break;
      case 'open_url': case 'ipad_url': if (!isUrl(p.url)) E(w, 'URL http(s) invalide'); break;
      case 'volume': if (['up', 'down', 'mute', 'unmute'].indexOf(p.op) < 0) E(w, 'op : up, down, mute ou unmute'); break;
      case 'keynote': if (['next', 'previous', 'play'].indexOf(p.op) < 0) E(w, 'op : next, previous ou play'); break;
      case 'page': if (!isStr(p.page, 48)) E(w, 'page cible manquante'); break;
      case 'music': if (['playpause', 'play', 'pause', 'next', 'previous', 'louder', 'quieter'].indexOf(p.op) < 0) E(w, 'op musique : playpause, play, pause, next, previous, louder, quieter'); break;
      case 'sequence': if (!Array.isArray(p.steps) || !p.steps.length || p.steps.length > 12) E(w, '1 à 12 étapes attendues'); break;
      default: break;
    }
  });
  (a.actions || []).forEach(function (x) {
    if (x && x.type === 'sequence' && x.params && Array.isArray(x.params.steps)) {
      x.params.steps.forEach(function (st) {
        if (!actionIds[st]) E('actions.actions[' + x.id + ']', 'étape inconnue « ' + st + ' »');
        else if (actionIds[st].type === 'sequence') E('actions.actions[' + x.id + ']', 'une séquence ne peut pas contenir une séquence');
      });
    }
  });

  // --- connectors
  const c = b.connectors;
  const monIds = {};
  if (!Array.isArray(c.monitors)) E('connectors.monitors', 'liste attendue');
  (c.monitors || []).forEach(function (m, i) {
    const w = 'connectors.monitors[' + (m && m.id || i) + ']';
    if (!m || !ID_RE.test(m.id || '')) return E(w, 'identifiant invalide');
    if (monIds[m.id]) E(w, 'identifiant en double');
    monIds[m.id] = true;
    if (!isStr(m.label, 60)) E(w, 'libellé manquant');
    if (m.kind === 'ping') { if (!/^[A-Za-z0-9.-]{1,253}$/.test(m.host || '')) E(w, 'hôte (nom ou IP) attendu pour un ping'); }
    else if (!isUrl(m.url)) E(w, 'URL http(s) invalide');
    if (m.kind !== undefined && ['http', 'ping'].indexOf(m.kind) < 0) E(w, 'kind : http ou ping');
    if (m.group !== undefined && !isStr(m.group, 40)) E(w, 'groupe : 40 caractères max');
    if (m.timeoutMs !== undefined && (typeof m.timeoutMs !== 'number' || m.timeoutMs < 1000 || m.timeoutMs > 60000)) E(w, 'timeoutMs entre 1000 et 60000');
    if (m.slowMs !== undefined && (typeof m.slowMs !== 'number' || m.slowMs < 100)) E(w, 'slowMs ≥ 100');
  });
  if (c.weather && (typeof c.weather.latitude !== 'number' || typeof c.weather.longitude !== 'number')) E('connectors.weather', 'latitude et longitude numériques attendues');

  // --- layout
  const L = b.layout;
  const pageIds = {};
  if (!Array.isArray(L.pages) || !L.pages.length) E('layout.pages', 'au moins une page');
  (L.pages || []).forEach(function (p, i) {
    const w = 'layout.pages[' + (p && p.id || i) + ']';
    if (!p || !ID_RE.test(p.id || '')) return E(w, 'identifiant invalide');
    if (pageIds[p.id]) E(w, 'identifiant en double');
    pageIds[p.id] = true;
    if (!isStr(p.title, 40)) E(w, 'titre manquant (40 caractères max)');
    const wids = {};
    const occupied = {};
    (p.widgets || []).forEach(function (x, j) {
      const ww = w + '.widgets[' + (x && x.id || j) + ']';
      if (!x || !ID_RE.test(x.id || '')) return E(ww, 'identifiant invalide');
      if (wids[x.id]) E(ww, 'identifiant en double dans la page');
      wids[x.id] = true;
      if (WIDGET_TYPES.indexOf(x.type) < 0) return E(ww, 'type inconnu « ' + x.type + ' »');
      ['x', 'y', 'w', 'h'].forEach(function (k) { if (typeof x[k] !== 'number' || x[k] % 1 !== 0) E(ww, k + ' entier attendu'); });
      if (x.x < 0 || x.y < 0 || x.w < 1 || x.h < 1 || x.x + x.w > GRID_COLS || x.y + x.h > GRID_ROWS) E(ww, 'hors de la grille ' + GRID_COLS + '×' + GRID_ROWS);
      else for (let cx = x.x; cx < x.x + x.w; cx++) for (let cy = x.y; cy < x.y + x.h; cy++) {
        const key = cx + ',' + cy;
        if (occupied[key]) { E(ww, 'chevauche « ' + occupied[key] + ' »'); cx = 99; break; }
        occupied[key] = x.id;
      }
      if (x.label !== undefined && typeof x.label !== 'string') E(ww, 'libellé texte attendu');
      if (x.icon !== undefined && (typeof x.icon !== 'string' || x.icon.length > 8)) E(ww, 'icône : un emoji (8 caractères max)');
      if (x.color !== undefined && x.color !== null && !isColor(x.color)) E(ww, 'couleur #RRGGBB attendue');
      if (['counter', 'gauge', 'chart', 'light'].indexOf(x.type) >= 0) {
        if (!SOURCE_RE.test(x.source || '')) E(ww, 'source invalide « ' + x.source + ' »');
        else if (/^svc:/.test(x.source) && !monIds[x.source.slice(4)]) E(ww, 'service de surveillance inconnu « ' + x.source.slice(4) + ' »');
      }
      if (x.type === 'button' && !x.action) E(ww, 'un bouton doit avoir une action');
      if (x.action && !actionIds[x.action]) E(ww, 'action inconnue « ' + x.action + ' »');
      if (x.thresholds && (typeof x.thresholds.warn !== 'number' || typeof x.thresholds.crit !== 'number')) E(ww, 'seuils warn et crit numériques attendus');
    });
  });
  if (!pageIds[L.home]) E('layout.home', 'page d\'accueil inconnue « ' + L.home + ' »');
  (a.actions || []).forEach(function (x) { if (x && x.type === 'page' && x.params && !pageIds[x.params.page]) E('actions.actions[' + x.id + ']', 'page inconnue « ' + x.params.page + ' »'); });
  return errs;
}

function load() {
  const b = loadFromDisk();
  const errs = validate(b);
  if (errs.length) {
    const last = path.join(backupsDir(), 'last-valid.json');
    if (fs.existsSync(last)) {
      U.log('warn', 'configuration invalide sur disque, dernière configuration valide chargée', { erreurs: errs.slice(0, 5) });
      current = U.readJSON(last);
      version++;
      return { ok: false, errors: errs, fallback: true };
    }
    throw new Error('Configuration invalide :\n - ' + errs.join('\n - '));
  }
  current = b;
  U.writeJSON(path.join(backupsDir(), 'last-valid.json'), b);
  version++;
  return { ok: true };
}

// Enregistre un nouveau bundle complet après validation ; archive la version précédente.
function save(bundle, origin) {
  const errs = validate(bundle);
  if (errs.length) return { ok: false, errors: errs };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (current) U.writeJSON(path.join(backupsDir(), 'config-' + stamp + '.json'), current);
  FILES.forEach(function (f) { U.writeJSON(path.join(dir(), f + '.json'), bundle[f], 0o644); });
  U.writeJSON(path.join(backupsDir(), 'last-valid.json'), bundle);
  pruneBackups();
  current = JSON.parse(JSON.stringify(bundle));
  version++;
  U.log('info', 'configuration enregistrée', { origine: origin || 'inconnue', version: version });
  listeners.forEach(function (fn) { try { fn(current); } catch (e) { U.log('error', 'listener config', { e: e.message }); } });
  return { ok: true, version: version };
}

function pruneBackups() {
  const d = backupsDir();
  const files = fs.readdirSync(d).filter(function (f) { return /^config-.*\.json$/.test(f); }).sort();
  while (files.length > 30) {
    // Archives au-delà des 30 plus récentes : déplacées dans un sous-dossier, jamais supprimées automatiquement.
    const f = files.shift();
    U.ensureDir(path.join(d, 'anciennes'));
    fs.renameSync(path.join(d, f), path.join(d, 'anciennes', f));
  }
}

function listBackups() {
  const d = backupsDir();
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter(function (f) { return /^config-.*\.json$/.test(f); }).sort().reverse();
}

// Restaure la sauvegarde la plus récente (ou celle nommée).
function restore(name) {
  const list = listBackups();
  const target = name || list[0];
  if (!target || list.indexOf(target) < 0) return { ok: false, errors: ['aucune sauvegarde « ' + (name || '') + ' »'] };
  const b = U.readJSON(path.join(backupsDir(), target));
  const res = save(b, 'restauration ' + target);
  return Object.assign({ restored: target }, res);
}

function reload() {
  const b = loadFromDisk();
  const errs = validate(b);
  if (errs.length) return { ok: false, errors: errs };
  return save(b, 'rechargement disque');
}

module.exports = {
  FILES, WIDGET_TYPES, ACTION_TYPES, GRID_COLS, GRID_ROWS, ID_RE,
  load, save, validate, restore, reload, listBackups,
  get: function () { return current; },
  version: function () { return version; },
  onChange: function (fn) { listeners.push(fn); }
};
