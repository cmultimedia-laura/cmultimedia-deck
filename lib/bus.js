'use strict';
// Bus temps réel par « long polling » XHR (compatible Safari iOS 9) et commandes avec accusés de réception.
// Une commande expire après 30 s et n'est jamais rejouée à un appareil qui l'a déjà accusée « affichée/exécutée ».
const U = require('./util');

let stateVersion = 1;
let seq = 0;
const commands = [];          // { id, seq, type, payload, target, createdAt, expiresAt, acks: { devId: {delivered, done, error} } }
const waiters = [];           // { devId, clientSeq, clientVer, respond, timer }
const ackListeners = [];
const CMD_TTL = 30000;

function bump() { stateVersion++; flush(); }

function pendingFor(devId, clientSeq) {
  const now = Date.now();
  return commands.filter(function (c) {
    if (c.expiresAt < now) return false;
    if (c.target !== 'all' && c.target !== devId) return false;
    const a = c.acks[devId];
    if (a && a.done) return false;                 // déjà exécutée : jamais rejouée
    return c.seq > clientSeq || (a && a.delivered && !a.done); // redistribuée seulement si non exécutée
  }).map(function (c) { return { id: c.id, seq: c.seq, type: c.type, payload: c.payload, createdAt: c.createdAt }; });
}

function flush() {
  for (let i = waiters.length - 1; i >= 0; i--) {
    const w = waiters[i];
    const cmds = pendingFor(w.devId, w.clientSeq);
    if (cmds.length || stateVersion > w.clientVer) { waiters.splice(i, 1); clearTimeout(w.timer); deliver(w, cmds); }
  }
}

function deliver(w, cmds) {
  const now = Date.now();
  cmds.forEach(function (c) {
    const full = commands.find(function (x) { return x.id === c.id; });
    if (full) { full.acks[w.devId] = full.acks[w.devId] || {}; if (!full.acks[w.devId].delivered) full.acks[w.devId].delivered = now; }
  });
  w.respond({ v: stateVersion, seq: seq, commands: cmds });
  if (cmds.length) fireAck();
}

// respond(payload) est appelé une seule fois : immédiatement s'il y a du neuf, sinon au plus tard après holdMs.
function poll(devId, clientSeq, clientVer, holdMs, respond) {
  // Un seul poll en attente par appareil (reconnexion = on libère l'ancien).
  for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].devId === devId) { const old = waiters.splice(i, 1)[0]; clearTimeout(old.timer); old.respond({ v: stateVersion, seq: seq, commands: [], superseded: true }); }
  const w = { devId: devId, clientSeq: clientSeq, clientVer: clientVer, respond: respond };
  const cmds = pendingFor(devId, clientSeq);
  if (cmds.length || stateVersion > clientVer) return deliver(w, cmds);
  w.timer = setTimeout(function () {
    const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1);
    respond({ v: stateVersion, seq: seq, commands: [] });
  }, holdMs);
  waiters.push(w);
}

function cancelWaiter(devId) {
  for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].devId === devId) { clearTimeout(waiters[i].timer); waiters.splice(i, 1); }
}

function send(type, payload, target) {
  const now = Date.now();
  const c = { id: U.newId('cmd', 5), seq: ++seq, type: type, payload: payload || {}, target: target || 'all', createdAt: now, expiresAt: now + CMD_TTL, acks: {} };
  commands.push(c);
  while (commands.length > 200) commands.shift();
  U.log('info', 'commande créée', { id: c.id, type: type, cible: c.target });
  flush();
  return c;
}

function ack(devId, cmdId, stage, info) {
  const c = commands.find(function (x) { return x.id === cmdId; });
  if (!c) return false;
  const a = c.acks[devId] = c.acks[devId] || {};
  if (!a.delivered) a.delivered = Date.now();
  if (stage === 'done') a.done = Date.now();
  if (stage === 'error') { a.done = Date.now(); a.error = String(info || 'erreur').slice(0, 200); }
  if (info && stage === 'done') a.info = String(info).slice(0, 200);
  fireAck();
  return true;
}
function fireAck() { ackListeners.splice(0).forEach(function (fn) { fn(); }); }

// Attend que la commande soit exécutée par au moins un appareil (ou expire). cb(commande)
function waitAck(cmdId, timeoutMs, cb) {
  const t0 = Date.now();
  const check = function () {
    const c = commands.find(function (x) { return x.id === cmdId; });
    const doneDev = c && Object.keys(c.acks).find(function (d) { return c.acks[d].done; });
    if (!c || doneDev || Date.now() - t0 >= timeoutMs) return cb(c || null);
    ackListeners.push(check);
    setTimeout(function () { const i = ackListeners.indexOf(check); if (i >= 0) { ackListeners.splice(i, 1); check(); } }, Math.max(50, timeoutMs - (Date.now() - t0)));
  };
  check();
}

module.exports = {
  bump: bump, poll: poll, send: send, ack: ack, waitAck: waitAck, cancelWaiter: cancelWaiter,
  version: function () { return stateVersion; }, seq: function () { return seq; },
  get: function (id) { return commands.find(function (x) { return x.id === id; }); },
  waiting: function () { return waiters.map(function (w) { return w.devId; }); }
};
