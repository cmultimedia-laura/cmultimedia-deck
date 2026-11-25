'use strict';
// Nom simple pour l'iPad (ex. deck-cmulti.local), annoncé en Bonjour par le Deck lui-même via dns-sd.
// Aucun réglage réseau du Mac n'est modifié : le nom suit l'adresse actuelle du Mac et disparaît à l'arrêt.
const cp = require('child_process');
const U = require('./util');

let proc = null, current = '';

function valid(a) { return typeof a === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(a); }

function stop() { if (proc) { try { proc.kill(); } catch (e) {} proc = null; } current = ''; }

// Publie (ou republie si l'adresse a changé) <alias>.local vers la première adresse réseau du Mac.
function sync(alias, port) {
  if (!valid(alias)) { stop(); return; }
  const lan = U.lanAddresses();
  const ip = lan[0] && lan[0].address;
  const key = alias + '|' + ip + '|' + port;
  if (!ip) { stop(); return; }
  if (key === current && proc) return;
  stop();
  proc = cp.spawn('/usr/bin/dns-sd', ['-P', 'CMULTIMEDIA Deck', '_https._tcp', 'local', String(port), alias + '.local', ip], { stdio: 'ignore' });
  current = key;
  proc.on('exit', function () { if (current === key) { proc = null; current = ''; } });
  U.log('info', 'nom simple publié', { nom: alias + '.local', ip: ip });
}

module.exports = { valid, sync, stop };
