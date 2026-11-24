'use strict';
// Trackpad : transmet au petit pilote Swift (data/bin/mouse) des ordres de pointeur validés.
// Le pilote démarre à la première utilisation et s'arrête après 60 s sans ordre.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const U = require('./util');

const BIN = path.join(U.DATA, 'bin', 'mouse');
let proc = null, ready = null, idle = null, lastError = null;

function start() {
  if (proc) return;
  if (!fs.existsSync(BIN)) { lastError = 'pilote du pointeur absent (swiftc tools/mouse.swift -o data/bin/mouse)'; return; }
  proc = cp.spawn(BIN, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  ready = null;
  proc.stdout.on('data', function (d) {
    const s = String(d);
    if (/pret/.test(s)) { ready = true; lastError = null; }
    if (/refus/.test(s)) { ready = false; lastError = 'macOS refuse le pilotage du pointeur : Réglages Système > Confidentialité et sécurité > Accessibilité, autoriser Terminal.'; }
  });
  proc.on('close', function () { proc = null; if (idle) clearTimeout(idle); });
  proc.on('error', function (e) { lastError = e.message; proc = null; });
  U.log('info', 'trackpad : pilote démarré');
}
function stop() { if (proc) { try { proc.stdin.end(); } catch (e) { /* */ } } }

// Raccourcis autorisés : nom -> [code de touche macOS, modificateurs]. Le navigateur n'envoie qu'un nom.
const CMD = 0x100000, SHIFT = 0x20000, ALT = 0x80000, CTRL = 0x40000;
// macOS ne reconnaît une touche de fonction ou une flèche simulée dans un raccourci système qu'avec ces marqueurs.
const FN = 0x800000, NUMPAD = 0x200000, ARROW = FN | NUMPAD;
const KEYS = {
  copier: [8, CMD], coller: [9, CMD], couper: [7, CMD], annuler: [6, CMD], retablir: [6, CMD | SHIFT], tout: [0, CMD],
  enregistrer: [1, CMD], rechercher: [3, CMD], spotlight: [49, CMD], appsuivante: [48, CMD], fermer: [13, CMD], onglet: [17, CMD],
  capture: [21, CMD | SHIFT], echap: [53, 0], entree: [36, 0], tab: [48, 0], effacer: [51, 0], suppr: [117, 0], espace: [49, 0],
  gauche: [123, 0], droite: [124, 0], bas: [125, 0], haut: [126, 0], debut: [115, 0], fin: [119, 0], pageprec: [116, 0], pagesuiv: [121, 0],
  missioncontrol: [126, CTRL | ARROW], motgauche: [123, ALT], motdroite: [124, ALT],
  // Système
  bureau: [103, FN], espacegauche: [123, CTRL | ARROW], espacedroite: [124, CTRL | ARROW], captureecran: [20, CMD | SHIFT], captureoptions: [23, CMD | SHIFT],
  emoji: [49, CMD | CTRL], forcerquitter: [53, CMD | ALT], verrouiller: [12, CMD | CTRL],
  // Applications
  nouvellefenetre: [45, CMD], ouvrir: [31, CMD], imprimer: [35, CMD], preferences: [43, CMD], reduire: [46, CMD], pleinecran: [3, CMD | CTRL],
  masquer: [4, CMD], masquerautres: [4, CMD | ALT], quitter: [12, CMD],
  // Navigateur et texte
  recharger: [15, CMD], ongletsuivant: [48, CTRL], ongletprecedent: [48, CTRL | SHIFT], rouvrironglet: [17, CMD | SHIFT], adresse: [37, CMD],
  zoomplus: [24, CMD], zoommoins: [27, CMD], taillereelle: [29, CMD], retour: [33, CMD], avancer: [30, CMD], gras: [11, CMD], italique: [34, CMD], souligne: [32, CMD]
};
const num = function (v, lim) { v = Number(v); return isFinite(v) ? Math.max(-lim, Math.min(lim, Math.round(v))) : null; };
// ops : [['m', dx, dy], ['c', 'l'|'r'|'d'], ['s', dy, dx], ['d', 'down'|'up']]
function send(ops) {
  if (!Array.isArray(ops) || ops.length > 80) return { ok: false, error: 'ordres invalides' };
  start();
  if (lastError && ready === false) return { ok: false, error: lastError };
  if (!proc) return { ok: false, error: lastError || 'pilote indisponible' };
  const lines = [];
  for (const o of ops) {
    if (!Array.isArray(o)) continue;
    if (o[0] === 'm') { const dx = num(o[1], 600), dy = num(o[2], 600); if (dx !== null && dy !== null && (dx || dy)) lines.push('m ' + dx + ' ' + dy); }
    else if (o[0] === 'c' && ['l', 'r', 'd'].indexOf(o[1]) >= 0) lines.push('c ' + o[1]);
    else if (o[0] === 's') { const dy = num(o[1], 2000), dx = num(o[2] || 0, 2000); if (dy !== null) lines.push('s ' + dy + ' ' + (dx || 0)); }
    else if (o[0] === 'd' && (o[1] === 'down' || o[1] === 'up')) lines.push('d ' + o[1]);
    else if (o[0] === 'k' && Object.prototype.hasOwnProperty.call(KEYS, o[1])) { const n = Math.max(1, Math.min(50, Number(o[2]) || 1)); for (let i = 0; i < n; i++) lines.push('k ' + KEYS[o[1]][0] + ' ' + KEYS[o[1]][1]); }
    else if (o[0] === 't' && typeof o[1] === 'string' && o[1].length && o[1].length <= 500) lines.push('t ' + Buffer.from(o[1].replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ''), 'utf8').toString('base64'));
  }
  if (lines.length) proc.stdin.write(lines.join('\n') + '\n');
  if (idle) clearTimeout(idle);
  idle = setTimeout(stop, 60000); idle.unref && idle.unref();
  return { ok: true };
}
module.exports = { send: send, stop: stop, status: function () { return { running: !!proc, ready: ready, error: lastError }; } };
