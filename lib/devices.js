'use strict';
// Association des appareils (code temporaire affiché sur le Mac), jetons, révocation, dernier contact.
const path = require('path');
const crypto = require('crypto');
const U = require('./util');

const FILE = () => path.join(U.DATA, 'devices.json');
const SECRET_FILE = () => path.join(U.DATA, 'secret.key');
const CODE_TTL = 10 * 60000;
let devices = [];
let pairing = null;           // { code, expires }
const attempts = {};          // ip -> [timestamps]
let failuresSinceCode = 0;
const GLOBAL_FAIL_LIMIT = 10;
let secret = null;

function load() {
  devices = U.readJSON(FILE(), []);
  const fs = require('fs');
  if (!fs.existsSync(SECRET_FILE())) { U.ensureDir(U.DATA); fs.writeFileSync(SECRET_FILE(), crypto.randomBytes(32).toString('hex'), { mode: 0o600 }); }
  secret = fs.readFileSync(SECRET_FILE(), 'utf8').trim();
}
function save() { U.writeJSON(FILE(), devices); }

function newCode() {
  pairing = { code: String(crypto.randomInt(0, 1000000)).padStart(6, '0'), expires: Date.now() + CODE_TTL };
  failuresSinceCode = 0;
  U.log('info', 'nouveau code d\'association généré (valable 10 min)');
  return pairing;
}
// Association OUVERTE seulement sur demande (./deck pair, éditeur, ou premier lancement sans appareil).
function currentCode() {
  if (pairing && pairing.expires < Date.now()) pairing = null;
  return pairing;
}
function closePairing(reason) { pairing = null; U.log('info', 'association fermée (' + reason + ')'); }

function rateLimited(ip) {
  const now = Date.now();
  const list = (attempts[ip] || []).filter(function (t) { return now - t < CODE_TTL; });
  attempts[ip] = list;
  return list.length >= 5;
}

// Retourne { ok, token, device } ou { ok:false, error, status }
function pair(code, name, ip, secure) {
  if (rateLimited(ip)) return { ok: false, status: 429, error: 'Trop de tentatives. Patiente 10 minutes ou génère un nouveau code sur le Mac (./deck pair).' };
  const p = currentCode();
  if (!p) return { ok: false, status: 403, error: 'Association fermée. Sur le Mac : ./deck pair (code valable 10 minutes).' };
  if (typeof code !== 'string' || !/^\d{6}$/.test(code) || !U.safeEqual(code, p.code)) {
    attempts[ip] = (attempts[ip] || []).concat(Date.now());
    failuresSinceCode++;
    if (failuresSinceCode >= GLOBAL_FAIL_LIMIT) closePairing(GLOBAL_FAIL_LIMIT + ' échecs');
    U.log('warn', 'échec d\'association', { ip: ip });
    return { ok: false, status: 403, error: 'Code incorrect ou expiré. Le code est affiché sur le Mac (./deck url).' };
  }
  const token = crypto.randomBytes(32).toString('hex');
  const dev = {
    id: U.newId('dev', 4),
    name: String(name || 'iPad').replace(/[^\w À-ÿ'’.-]/g, '').slice(0, 40) || 'iPad',
    tokenHash: U.sha256(token), createdAt: Date.now(), lastSeen: Date.now(), lastIp: ip,
    pairedSecure: !!secure, revoked: false, lastPage: null
  };
  devices.push(dev);
  save();
  closePairing('appareil associé');   // un code ne sert qu'une fois
  U.log('info', 'appareil associé', { id: dev.id, nom: dev.name, chiffre: !!secure });
  return { ok: true, token: token, device: publicView(dev) };
}

// Un jeton obtenu en http (circulé en clair) n'est jamais accepté sur le port chiffré, et inversement.
function authenticate(token, secure) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  const h = U.sha256(token);
  for (let i = 0; i < devices.length; i++) {
    if (!devices[i].revoked && !!devices[i].pairedSecure === !!secure && U.safeEqual(devices[i].tokenHash, h)) return devices[i];
  }
  return null;
}

let dirty = false;
function touch(dev, ip, page) {
  dev.lastSeen = Date.now(); dev.lastIp = ip;
  if (page) dev.lastPage = page;
  if (!dirty) { dirty = true; setTimeout(function () { dirty = false; save(); }, 15000).unref(); }
}

function revoke(idOrName) {
  const d = devices.find(function (x) { return !x.revoked && (x.id === idOrName || x.name === idOrName); });
  if (!d) return { ok: false, error: 'appareil introuvable : ' + idOrName };
  d.revoked = true; d.revokedAt = Date.now();
  save();
  U.log('info', 'appareil révoqué', { id: d.id });
  return { ok: true, device: publicView(d) };
}

function publicView(d) {
  return { id: d.id, name: d.name, createdAt: d.createdAt, lastSeen: d.lastSeen, lastIp: d.lastIp, pairedSecure: d.pairedSecure, revoked: d.revoked, lastPage: d.lastPage };
}

// Tickets signés à durée courte pour les <img>/<audio> (le jeton principal ne passe jamais dans une URL).
function ticket(devId, resource, ttlSec) {
  const exp = Math.floor(Date.now() / 1000) + (ttlSec || 600);
  const sig = crypto.createHmac('sha256', secret).update(devId + '|' + resource + '|' + exp).digest('hex').slice(0, 32);
  return devId + '.' + exp + '.' + sig;
}
function checkTicket(t, resource) {
  const parts = String(t || '').split('.');
  if (parts.length !== 3) return null;
  const exp = Number(parts[1]);
  if (!exp || exp < Date.now() / 1000) return null;
  const sig = crypto.createHmac('sha256', secret).update(parts[0] + '|' + resource + '|' + exp).digest('hex').slice(0, 32);
  if (!U.safeEqual(sig, parts[2])) return null;
  const d = devices.find(function (x) { return x.id === parts[0] && !x.revoked; });
  return d || null;
}

module.exports = {
  load: load, pair: pair, closePairing: closePairing, authenticate: authenticate, touch: touch, revoke: revoke, newCode: newCode, currentCode: currentCode,
  ticket: ticket, checkTicket: checkTicket,
  list: function () { return devices.map(publicView); },
  active: function () { return devices.filter(function (d) { return !d.revoked; }); },
  _reset: function () { devices = []; pairing = null; Object.keys(attempts).forEach(function (k) { delete attempts[k]; }); }
};
