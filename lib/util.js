'use strict';
// Utilitaires communs du serveur CMULTIMEDIA Deck (Mac). Aucune dépendance externe.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA = process.env.DECK_DATA_DIR || path.join(ROOT, 'data');
const CONFIG_DIR = process.env.DECK_CONFIG_DIR || path.join(ROOT, 'config');

function ensureDir(d, mode) {
  fs.mkdirSync(d, { recursive: true, mode: mode || 0o700 });
  return d;
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (fallback !== undefined) return fallback; throw e; }
}

// Écriture atomique : fichier temporaire puis rename (jamais de JSON à moitié écrit).
function writeJSON(file, obj, mode) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: mode || 0o600 });
  fs.renameSync(tmp, file);
}

function newId(prefix, bytes) {
  return (prefix ? prefix + '_' : '') + crypto.randomBytes(bytes || 6).toString('hex');
}

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function safeEqual(a, b) {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function expandHome(p) {
  if (typeof p !== 'string') return p;
  return p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function lanAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  Object.keys(ifs).forEach(function (name) {
    (ifs[name] || []).forEach(function (a) {
      if (a.family === 'IPv4' && !a.internal && !/^(utun|bridge|awdl|llw|anpi)/.test(name) && !/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)) {
        out.push({ iface: name, address: a.address });
      }
    });
  });
  out.sort(function (x, y) { return (x.iface === 'en0' ? -1 : 0) - (y.iface === 'en0' ? -1 : 0); });
  return out;
}

let cachedHost = null;
function localHostName() {
  if (cachedHost) return cachedHost;
  try {
    cachedHost = require('child_process').execFileSync('/usr/sbin/scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 3000 }).trim();
  } catch (e) { cachedHost = os.hostname().replace(/\.local$/, ''); }
  return cachedHost;
}

// Journal technique : jamais de jeton, de contenu de conversation ni de chemin d'enregistrement privé.
const LOG_FILE = () => path.join(DATA, 'logs', 'deck.log');
function log(level, msg, meta) {
  let line = new Date().toISOString() + ' [' + level + '] ' + redact(String(msg));
  if (meta) line += ' ' + redact(JSON.stringify(meta));
  try { ensureDir(path.dirname(LOG_FILE())); fs.appendFileSync(LOG_FILE(), line + '\n', { mode: 0o600 }); } catch (e) { /* journal indisponible */ }
  if (process.env.DECK_LOG_STDOUT === '1') process.stdout.write(line + '\n');
}
function redact(s) {
  return s
    .replace(/(token|ticket|authorization|x-token|bearer|k)(["'=: ]+)([A-Za-z0-9._\-]{12,})/gi, '$1$2[REDACTED]')
    .replace(/\b[a-f0-9]{40,}\b/gi, '[REDACTED]');
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

module.exports = { ROOT, DATA, CONFIG_DIR, ensureDir, readJSON, writeJSON, newId, sha256, safeEqual, expandHome, lanAddresses, localHostName, log, redact, clamp };
