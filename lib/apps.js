'use strict';
// Écran « Applications » : les applications du Dock du Mac, avec leurs vraies icônes.
// La liste autorisée = le Dock lui-même : le navigateur n'envoie qu'un identifiant, jamais un chemin.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const U = require('./util');

const ICONS = () => U.ensureDir(path.join(U.DATA, 'app-icons'));
const BIN = path.join(U.DATA, 'bin', 'app-icons');
let cache = { t: 0, apps: [] }, building = false;

const READ_DOCK = [
  'import plistlib, subprocess, json, urllib.parse',
  'raw = subprocess.run(["/usr/bin/defaults", "export", "com.apple.dock", "-"], capture_output=True).stdout',
  'd = plistlib.loads(raw); out = []',
  'for t in d.get("persistent-apps", []):',
  '    td = t.get("tile-data", {}); u = (td.get("file-data") or {}).get("_CFURLString", "")',
  '    if u.startswith("file://"): out.append({"name": td.get("file-label") or "", "path": urllib.parse.unquote(u[7:]).rstrip("/")})',
  'print(json.dumps(out))'
].join('\n');

function list(cb) {
  if (Date.now() - cache.t < 300000 && cache.apps.length) return cb(null, cache.apps);
  cp.execFile('/usr/bin/python3', ['-I', '-c', READ_DOCK], { timeout: 10000 }, function (e, out) {
    if (e) return cb(new Error('Dock illisible'));
    let raw = []; try { raw = JSON.parse(out); } catch (x) { return cb(new Error('Dock illisible')); }
    const apps = raw.filter(function (a) { return /\.app$/.test(a.path) && fs.existsSync(a.path); }).map(function (a) {
      const id = crypto.createHash('sha1').update(a.path).digest('hex').slice(0, 12);
      return { id: id, name: (a.name || path.basename(a.path, '.app')).replace(/\.app$/, '').slice(0, 40), path: a.path, icon: fs.existsSync(path.join(ICONS(), id + '.png')) };
    });
    cache = { t: Date.now(), apps: apps };
    buildIcons(apps);
    cb(null, apps);
  });
}

// Icônes manquantes : extraites en une fois par le petit programme Swift compilé (tools/app-icons.swift).
function buildIcons(apps) {
  const missing = apps.filter(function (a) { return !a.icon; });
  if (!missing.length || building || !fs.existsSync(BIN)) return;
  building = true;
  cp.execFile(BIN, [ICONS()].concat(missing.map(function (a) { return a.id + '|' + a.path; })), { timeout: 120000 }, function (e) {
    building = false;
    if (e) U.log('warn', 'icônes d\'applications', { e: e.message });
    cache.t = 0;   // la prochaine lecture prendra les icônes
  });
}

function open(id, cb) {
  const a = cache.apps.find(function (x) { return x.id === id; });
  if (!a) return cb(new Error('application inconnue (absente du Dock)'));
  cp.execFile('/usr/bin/open', [a.path], { timeout: 15000 }, function (e) { cb(e ? new Error('ouverture impossible') : null, { message: a.name + ' ouvert sur le Mac' }); });
}
function iconFile(id) { return /^[a-f0-9]{12}$/.test(id) ? path.join(ICONS(), id + '.png') : null; }

module.exports = { list: list, open: open, iconFile: iconFile };
