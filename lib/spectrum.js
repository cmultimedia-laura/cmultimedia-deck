'use strict';
// Spectre audio en direct pour la page Musique : démarre à la demande, s'arrête 10 s après la dernière demande.
// Aucun son n'est enregistré ni transmis : seulement 24 niveaux de bandes.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const U = require('./util');

const BIN = path.join(U.DATA, 'bin', 'spectrum');
let proc = null, bands = null, t = 0, lastAsk = 0, error = null, timer = null, buf = '';

function start() {
  if (proc || !fs.existsSync(BIN)) { if (!fs.existsSync(BIN)) error = 'analyseur absent (swiftc tools/spectrum.swift -o data/bin/spectrum)'; return; }
  proc = cp.spawn(BIN, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  error = null; buf = '';
  proc.stdout.on('data', function (d) {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1);
      if (l.indexOf('b ') === 0) { bands = l.slice(2).split(' ').map(Number); t = Date.now(); }
      else if (l.indexOf('refus') === 0) error = 'macOS refuse la capture du son : Réglages Système > Confidentialité et sécurité > Enregistrement de l\'écran et de l\'audio du système, autoriser Terminal.';
    }
  });
  proc.on('close', function () { proc = null; });
  timer = setInterval(function () { if (Date.now() - lastAsk > 10000) stop(); }, 3000);
  U.log('info', 'spectre musique : analyse démarrée (aucun enregistrement)');
}
function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  if (proc) { try { proc.stdin.end(); } catch (e) { /* */ } setTimeout(function () { if (proc) proc.kill('SIGTERM'); }, 1500); }
}
function get() {
  lastAsk = Date.now(); start();
  return { bands: bands && Date.now() - t < 1500 ? bands : null, t: t, error: error };
}
module.exports = { get: get, stop: stop };
