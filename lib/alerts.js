'use strict';
// Alertes affichées sur l'iPad : calculées à partir de l'état réel (surveillance des sites, captures en cours, Mac).
// Une alerte disparaît quand le problème disparaît ; « J'ai vu » la range sans l'effacer tant qu'il dure.
const path = require('path');
const U = require('./util');

const FILE = () => path.join(U.DATA, 'alerts.json');
let mem = null;   // { acked: {id: t}, first: {id: t} }
function load() { if (!mem) mem = U.readJSON(FILE(), { acked: {}, first: {} }); return mem; }
let saveTimer = null;
function save() { if (saveTimer) return; saveTimer = setTimeout(function () { saveTimer = null; try { U.writeJSON(FILE(), mem); } catch (e) { /* */ } }, 2000); }

// state : { media, services, metrics }
function compute(st) {
  load();
  const out = [];
  const now = Date.now();
  const add = function (id, level, title, detail, since) {
    if (!mem.first[id]) { mem.first[id] = since || now; save(); }
    out.push({ id: id, level: level, title: title, detail: detail || '', since: mem.first[id], acked: !!mem.acked[id] });
  };
  (st.services || []).forEach(function (s) {
    if (s.status !== 'alert') return;
    add('svc:' + s.id, 'critique', s.label + ' en panne', s.error || (s.code ? 'HTTP ' + s.code : ''), s.since);
  });
  // Micro ou caméra actifs : toujours signalés (la tuile dédiée n'est plus sur l'accueil).
  ((st.media && st.media.active) || []).forEach(function (a) {
    const kind = { 'mic-test': 'Test du micro', 'mic-record': 'Enregistrement audio', 'mic-dictation': 'Dictée', 'cam-preview': 'Aperçu caméra', 'cam-photo': 'Photo', 'cam-clip': 'Clip vidéo' }[a.kind] || a.kind;
    out.push({ id: 'media:' + a.id, level: 'attention', title: '● ' + kind + ' en cours : ' + a.source, detail: (a.recording ? 'fichier sur le Mac · ' : 'aucun fichier · ') + a.transmission, since: a.startedAt, acked: false, media: a.id });
  });
  const m = st.metrics || {};
  if (m.memPct >= 95) add('mac:mem', 'attention', 'Mémoire du Mac presque pleine', Math.round(m.memPct) + ' % utilisés');
  if (m.diskFreeGB !== null && m.diskFreeGB !== undefined && m.diskFreeGB < 25) add('mac:disk', 'attention', 'Disque du Mac presque plein', Math.round(m.diskFreeGB) + ' Go libres');
  const order = { critique: 0, attention: 1, info: 2 };
  out.sort(function (a, b) { return (a.acked - b.acked) || (order[a.level] - order[b.level]) || (b.since - a.since); });
  // Nettoyage : un problème résolu repart de zéro la prochaine fois.
  const live = {}; out.forEach(function (a) { live[a.id] = 1; });
  Object.keys(mem.first).forEach(function (id) { if (!live[id]) { delete mem.first[id]; delete mem.acked[id]; save(); } });
  return out;
}

function ack(id) { load(); if (id === '*') { Object.keys(mem.first).forEach(function (k) { mem.acked[k] = Date.now(); }); } else { const k = String(id).slice(0, 120); if (!mem.first[k]) return false; mem.acked[k] = Date.now(); } save(); return true; }

module.exports = { compute: compute, ack: ack };
