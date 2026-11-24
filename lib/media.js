'use strict';
// Studio : micro et caméras du Mac (ffmpeg/AVFoundation) + traitement des captures envoyées par l'iPad.
// Règles : rien ne démarre seul, durée maximale, arrêt immédiat, libération des périphériques,
// arrêt automatique si l'iPad qui a lancé la capture disparaît, jamais de reprise après redémarrage.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const U = require('./util');

const FFMPEG = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(function (p) { return fs.existsSync(p); }) || 'ffmpeg';
const FFPROBE = FFMPEG.replace(/ffmpeg$/, 'ffprobe');
const CAP_DIR = () => path.join(U.DATA, 'captures');
const INDEX = () => path.join(CAP_DIR(), 'index.json');
const PIDS = () => path.join(U.DATA, 'media-pids.json');
const VIRTUAL_RE = /virtual|blackhole|steam|immersed|obs |loopback|soundflower|teams|zoom/i;

let spawnImpl = cp.spawn;
let listImpl = null;               // remplaçable par les tests (source simulée isolée)
const sessions = {};               // id -> session
let captures = [];
let devCache = null;
let hooks = { changed: function () {}, lastSeen: function () { return Date.now(); }, settings: function () { return {}; } };
let watchdog = null;

// ---------- index des captures ----------
function loadIndex() { captures = U.readJSON(INDEX(), []); }
function saveIndex() { U.writeJSON(INDEX(), captures); }
function dayDir(origin) { const d = path.join(CAP_DIR(), origin, new Date().toISOString().slice(0, 10)); U.ensureDir(d); return d; }
function stamp() { const d = new Date(); const p = function (n) { return String(n).padStart(2, '0'); }; return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }

// ---------- périphériques ----------
function parseDeviceList(text) {
  const out = { video: [], audio: [] };
  let section = null;
  String(text).split('\n').forEach(function (line) {
    if (/AVFoundation video devices/.test(line)) section = 'video';
    else if (/AVFoundation audio devices/.test(line)) section = 'audio';
    else {
      const m = line.match(/\]\s\[(\d+)\]\s(.+)$/);
      if (m && section) {
        const name = m[2].trim();
        if (section === 'video' && /^Capture screen/i.test(name)) return; // écrans : pas des caméras
        out[section].push({ index: Number(m[1]), name: name, virtual: VIRTUAL_RE.test(name), builtin: /FaceTime|MacBook|intégr/i.test(name) });
      }
    }
  });
  return out;
}

function listDevices(cb, force) {
  if (!force && devCache && Date.now() - devCache.t < 30000) return cb(null, devCache.list);
  if (listImpl) return listImpl(function (e, l) { if (!e) devCache = { t: Date.now(), list: l }; cb(e, l); });
  cp.execFile(FFMPEG, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { timeout: 10000 }, function (err, stdout, stderr) {
    const list = parseDeviceList(stderr);
    if (!list.video.length && !list.audio.length) return cb(new Error('ffmpeg ne liste aucun périphérique (' + (err ? err.message : 'sortie vide') + ')'));
    devCache = { t: Date.now(), list: list };
    cb(null, list);
  });
}
function findDevice(kind, name, cb) {
  listDevices(function (err, list) {
    if (err) return cb(err);
    const d = list[kind].find(function (x) { return x.name === name; });
    if (!d) return cb(new Error((kind === 'audio' ? 'Micro' : 'Caméra') + ' « ' + name + ' » introuvable (débranché ?)'));
    cb(null, d);
  }, true);
}

// ---------- processus ----------
function trackPids() {
  const pids = Object.keys(sessions).map(function (k) { return sessions[k].proc && sessions[k].proc.pid; }).filter(Boolean);
  try { U.writeJSON(PIDS(), pids); } catch (e) { /* non bloquant */ }
}
// Au démarrage du serveur : libère les périphériques d'une capture orpheline. Ne relance JAMAIS rien.
function killOrphans() {
  const pids = U.readJSON(PIDS(), []);
  pids.forEach(function (pid) {
    try {
      const comm = cp.execFileSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim();
      if (/ffmpeg/.test(comm)) { process.kill(pid, 'SIGKILL'); U.log('warn', 'capture orpheline arrêtée au démarrage', { pid: pid }); }
    } catch (e) { /* déjà terminé */ }
  });
  try { U.writeJSON(PIDS(), []); } catch (e) { /* non bloquant */ }
}

function explainError(stderr) {
  const s = String(stderr || '');
  if (/not authori[sz]ed|permission|denied|TCC/i.test(s)) return 'Autorisation refusée par macOS : Réglages Système > Confidentialité et sécurité > Micro / Caméra, autoriser l\'application qui lance le deck (Terminal ou node).';
  if (/in use|busy|could not lock|exclusive/i.test(s)) return 'Périphérique déjà utilisé par une autre application.';
  if (/framerate|video size/i.test(s)) return 'Format non pris en charge par la caméra.';
  if (/Input\/output error|Error opening input/i.test(s)) return 'Impossible d\'ouvrir le périphérique (débranché, occupé ou autorisation refusée).';
  return (s.trim().split('\n').pop() || 'erreur inconnue').slice(0, 200);
}

function startProc(sess, args, onData) {
  const proc = spawnImpl(FFMPEG, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  sess.proc = proc; sess.stderr = '';
  proc.stdout.on('data', function (b) { if (onData) onData(b); });
  proc.stderr.on('data', function (b) { sess.stderr = (sess.stderr + b.toString()).slice(-4000); });
  proc.on('error', function (e) { sess.error = 'ffmpeg introuvable ou bloqué : ' + e.message; });
  proc.on('close', function (code) { onExit(sess, code); });
  trackPids();
  return proc;
}

function onExit(sess, code) {
  if (!sessions[sess.id]) return;
  clearTimeout(sess.maxTimer);
  delete sessions[sess.id];
  trackPids();
  const ranFor = (Date.now() - sess.startedAt) / 1000;
  if (!sess.stopRequested && code !== 0 && code !== 255) sess.error = sess.error || explainError(sess.stderr);
  if (sess.kind === 'cam-preview' && sess.error && sess.retryRates && sess.retryRates.length && /Format non pris en charge/.test(sess.error)) {
    // Nouvelle tentative avec une autre cadence (caméras USB capricieuses).
    const again = sess.retryRates.shift();
    U.log('info', 'aperçu : nouvel essai à ' + again + ' i/s');
    return startCameraPreview(sess.params, sess.ownerDev, again, sess.retryRates);
  }
  if (sess.file) finalizeFile(sess, ranFor);
  sess.endedAt = Date.now();
  lastEnded[sess.slot] = { id: sess.id, kind: sess.kind, error: sess.error || null, reason: sess.stopReason || (sess.error ? 'erreur' : 'terminé'), at: sess.endedAt, captureId: sess.captureId || null };
  U.log(sess.error ? 'warn' : 'info', 'capture terminée', { type: sess.kind, raison: lastEnded[sess.slot].reason, erreur: sess.error });
  hooks.changed();
}
const lastEnded = {};

function finalizeFile(sess, ranFor) {
  let size = 0; try { size = fs.statSync(sess.file).size; } catch (e) { /* absent */ }
  if (!size) { sess.error = sess.error || 'aucun fichier produit'; return; }
  const entry = {
    id: U.newId('cap', 5), kind: sess.outKind, origin: 'mac', source: sess.sourceLabel, file: sess.file, size: size,
    createdAt: sess.startedAt, durationSec: Math.round(ranFor), status: sess.stopReason && /déconnect|durée/.test(sess.stopReason) ? 'interrompu' : 'complet',
    reason: sess.stopReason || null, withAudio: !!sess.withAudio, draft: true, purpose: sess.purpose || null
  };
  captures.unshift(entry); saveIndex();
  sess.captureId = entry.id;
}

function stopSession(id, reason) {
  const s = sessions[id];
  if (!s) return false;
  s.stopRequested = true; s.stopReason = reason || 'arrêt demandé';
  try { s.proc.stdin.write('q'); s.proc.stdin.end(); } catch (e) { /* déjà fermé */ }
  setTimeout(function () { if (sessions[id]) try { s.proc.kill('SIGINT'); } catch (e) { /* */ } }, 1500).unref();
  setTimeout(function () { if (sessions[id]) { try { s.proc.kill('SIGKILL'); } catch (e) { /* */ } onExit(s, -9); } }, 4000).unref();
  return true;
}
function stopAll(reason) {
  const ids = Object.keys(sessions);
  ids.forEach(function (id) { stopSession(id, reason || 'arrêt général'); });
  return ids.length ? ids.length + ' capture(s) arrêtée(s)' : 'Aucune capture en cours';
}
function slotBusy(slot) { return Object.keys(sessions).map(function (k) { return sessions[k]; }).find(function (s) { return s.slot === slot; }); }

function newSession(kind, slot, params, ownerDev) {
  const st = hooks.settings();
  const max = Math.min(Number(params.maxSec) || st.maxCaptureSec || 120, st.maxCaptureSec || 120);
  const s = { id: U.newId('med', 5), kind: kind, slot: slot, params: params, ownerDev: ownerDev || null, startedAt: Date.now(), maxSec: max, level: 0, peak: 0, levelT: 0 };
  s.maxTimer = setTimeout(function () { stopSession(s.id, 'durée maximale atteinte (' + max + ' s)'); }, (max + 3) * 1000);
  s.maxTimer.unref && s.maxTimer.unref();
  sessions[s.id] = s;
  return s;
}

// ---------- micro du Mac ----------
// mode : 'test' (aucun fichier) | 'record' | 'dictation' (fichier transcrit et gardé sur le Mac)
function startMic(params, ownerDev, cb) {
  if (slotBusy('mic')) return cb(new Error('Le micro du Mac est déjà en cours d\'utilisation par le deck'));
  if (['test', 'record', 'dictation'].indexOf(params.mode) < 0) return cb(new Error('mode inconnu'));
  findDevice('audio', params.device, function (err, d) {
    if (err) return cb(err);
    if (slotBusy('mic')) return cb(new Error('Le micro du Mac est déjà en cours d\'utilisation par le deck'));
    const s = newSession(params.mode === 'test' ? 'mic-test' : (params.mode === 'dictation' ? 'mic-dictation' : 'mic-record'), 'mic', params, ownerDev);
    s.sourceLabel = d.name + ' (Mac)'; s.deviceName = d.name;
    const args = ['-hide_banner', '-nostats', '-loglevel', 'error', '-f', 'avfoundation', '-i', ':' + d.index, '-t', String(s.maxSec),
      '-map', '0:a', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'];
    if (params.mode !== 'test') {
      s.file = path.join(dayDir('mac'), (params.mode === 'dictation' ? 'dictee-' : 'audio-') + stamp() + '.m4a');
      s.outKind = 'audio'; s.purpose = params.mode === 'dictation' ? 'dictee' : null;
      args.push('-map', '0:a', '-ac', '1', '-c:a', 'aac', '-b:a', '128k', s.file);
    }
    let rest = Buffer.alloc(0);
    startProc(s, args, function (chunk) {
      rest = Buffer.concat([rest, chunk]);
      const win = 3200; // 100 ms en 16 kHz mono 16 bits
      while (rest.length >= win) {
        const block = rest.subarray(0, win); rest = rest.subarray(win);
        let sum = 0, pk = 0;
        for (let i = 0; i < block.length; i += 2) { const v = block.readInt16LE(i) / 32768; sum += v * v; if (Math.abs(v) > pk) pk = Math.abs(v); }
        const rms = Math.sqrt(sum / (block.length / 2));
        const db = rms > 0 ? 20 * Math.log10(rms) : -90;
        s.level = U.clamp((db + 60) / 60, 0, 1); s.db = Math.round(db); s.peak = Math.max(s.peak * 0.95, pk); s.levelT = Date.now();
        if (rms > 0) s.signalSeen = true;
      }
    });
    U.log('info', 'capture démarrée', { type: s.kind, source: 'mac', fichier: !!s.file });
    hooks.changed();
    cb(null, describe(s));
  });
}

// ---------- caméra du Mac ----------
function startCameraPreview(params, ownerDev, rate, retry, cb) {
  cb = cb || function () {};
  const busy = slotBusy('cam');
  if (busy) return cb(new Error('La caméra du Mac est déjà utilisée par le deck (' + busy.kind + ')'));
  findDevice('video', params.device, function (err, d) {
    if (err) return cb(err);
    const st = hooks.settings();
    const fps = U.clamp(Number(params.fps) || st.previewFps || 2, 0.2, 10);
    const width = U.clamp(Number(params.width) || st.previewWidth || 480, 160, 1280);
    const s = newSession('cam-preview', 'cam', params, ownerDev);
    s.maxSec = Math.max(s.maxSec, 600);   // l'aperçu s'arrête seul sans demande d'image (voir watchdog)
    clearTimeout(s.maxTimer);
    s.sourceLabel = d.name + ' (Mac)'; s.deviceName = d.name; s.lastRequest = Date.now();
    s.retryRates = retry === undefined ? [15, 25, 60] : retry;
    const args = ['-hide_banner', '-nostats', '-loglevel', 'error', '-f', 'avfoundation', '-framerate', String(rate || 30), '-i', String(d.index),
      '-an', '-vf', 'fps=' + fps + ',scale=' + width + ':-2', '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '7', 'pipe:1'];
    let buf = Buffer.alloc(0);
    startProc(s, args, function (chunk) {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const a = buf.indexOf(Buffer.from([0xff, 0xd8]));
        if (a < 0) { buf = Buffer.alloc(0); break; }
        const b = buf.indexOf(Buffer.from([0xff, 0xd9]), a + 2);
        if (b < 0) { if (a > 0) buf = buf.subarray(a); break; }
        s.frame = Buffer.from(buf.subarray(a, b + 2)); s.frameT = Date.now(); s.frameN = (s.frameN || 0) + 1;
        buf = buf.subarray(b + 2);
      }
    });
    hooks.changed();
    cb(null, describe(s));
  });
}

function takePhoto(params, ownerDev, cb) {
  const busy = slotBusy('cam');
  const resume = busy && busy.kind === 'cam-preview' ? { params: busy.params, owner: busy.ownerDev } : null;
  if (busy && !resume) return cb(new Error('La caméra du Mac enregistre déjà un clip'));
  const go = function () {
    findDevice('video', params.device, function (err, d) {
      if (err) return cb(err);
      const s = newSession('cam-photo', 'cam', params, ownerDev);
      s.sourceLabel = d.name + ' (Mac)'; s.outKind = 'photo';
      s.file = path.join(dayDir('mac'), 'photo-' + stamp() + '.jpg');
      startProc(s, ['-hide_banner', '-nostats', '-loglevel', 'error', '-f', 'avfoundation', '-framerate', '30', '-i', String(d.index),
        '-vf', 'select=gte(n\\,20)', '-frames:v', '1', '-q:v', '2', s.file]);
      s.proc.on('close', function () {
        setTimeout(function () {
          if (resume) startCameraPreview(resume.params, resume.owner);
          if (s.error || !s.captureId) return cb(new Error(s.error || 'photo non produite'));
          cb(null, captures.find(function (c) { return c.id === s.captureId; }));
        }, 50);
      });
      hooks.changed();
    });
  };
  if (resume) { stopSession(busy.id, 'photo demandée'); waitFree('cam', go); } else go();
}

function startClip(params, ownerDev, cb) {
  const busy = slotBusy('cam');
  if (busy && busy.kind !== 'cam-preview') return cb(new Error('La caméra du Mac est déjà utilisée'));
  if (params.withAudio && slotBusy('mic')) return cb(new Error('Le micro du Mac est déjà utilisé : arrête-le ou fais un clip sans son'));
  const go = function () {
    findDevice('video', params.device, function (err, d) {
      if (err) return cb(err);
      const withAudio = !!params.withAudio;
      const next = function (aud) {
        const s = newSession('cam-clip', 'cam', params, ownerDev);
        s.sourceLabel = d.name + ' (Mac)' + (aud ? ' + ' + aud.name : ' (sans son)'); s.outKind = 'video'; s.withAudio = !!aud;
        s.file = path.join(dayDir('mac'), 'clip-' + stamp() + '.mp4');
        startProc(s, ['-hide_banner', '-nostats', '-loglevel', 'error', '-f', 'avfoundation', '-framerate', '30', '-i', d.index + ':' + (aud ? aud.index : 'none'),
          '-t', String(s.maxSec), '-pix_fmt', 'yuv420p', '-c:v', 'h264_videotoolbox', '-b:v', '4M'].concat(aud ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']).concat(['-movflags', '+faststart', s.file]));
        hooks.changed();
        cb(null, describe(s));
      };
      if (!withAudio) return next(null);
      findDevice('audio', params.audioDevice, function (e2, a) { if (e2) return cb(e2); next(a); });
    });
  };
  if (busy) { stopSession(busy.id, 'clip demandé'); waitFree('cam', go); } else go();
}

function waitFree(slot, fn, n) {
  n = n || 0;
  if (!slotBusy(slot) || n > 50) return fn();
  setTimeout(function () { waitFree(slot, fn, n + 1); }, 100);
}

function previewFrame(sessId) {
  const s = sessId ? sessions[sessId] : slotBusy('cam');
  if (!s || s.kind !== 'cam-preview') return null;
  s.lastRequest = Date.now();
  return s.frame ? { buf: s.frame, t: s.frameT, n: s.frameN } : { buf: null, t: null };
}
function micLevel() {
  const s = slotBusy('mic');
  if (!s) return null;
  return { id: s.id, kind: s.kind, level: s.level, db: s.db, peak: s.peak, t: s.levelT, elapsed: (Date.now() - s.startedAt) / 1000, maxSec: s.maxSec, source: s.sourceLabel,
    noSignal: !s.signalSeen && Date.now() - s.startedAt > 3000 };
}

// ---------- surveillance des sessions ----------
function tick() {
  const st = hooks.settings();
  const grace = (st.disconnectGraceSec || 20) * 1000;
  Object.keys(sessions).forEach(function (id) {
    const s = sessions[id];
    if (s.ownerDev && Date.now() - hooks.lastSeen(s.ownerDev) > grace) stopSession(id, 'iPad déconnecté pendant la capture');
    else if (s.kind === 'cam-preview' && Date.now() - s.lastRequest > 15000) stopSession(id, 'aperçu fermé (plus aucune image demandée)');
  });
}

// ---------- captures venant de l'iPad ----------
function lensFromExif(buf) {
  // Lecture minimale de l'EXIF : LensModel (0xA434) et Model (0x0110). Aucune dépendance.
  try {
    let off = 2;
    while (off < buf.length - 4) {
      if (buf[off] !== 0xff) return null;
      const marker = buf[off + 1], len = buf.readUInt16BE(off + 2);
      if (marker === 0xe1 && buf.toString('ascii', off + 4, off + 10) === 'Exif\0\0') {
        const t = off + 10;
        const le = buf.toString('ascii', t, t + 2) === 'II';
        const r16 = function (o) { return le ? buf.readUInt16LE(o) : buf.readUInt16BE(o); };
        const r32 = function (o) { return le ? buf.readUInt32LE(o) : buf.readUInt32BE(o); };
        const res = {};
        const seen = new Set();
        // Bornes contre un JPEG piégé : IFD jamais relu, profondeur 2, 512 entrées, lecture dans le tampon.
        const readIfd = function (ifd, depth) {
          if (depth > 2 || seen.has(ifd) || t + ifd + 2 > buf.length) return;
          seen.add(ifd);
          const n = Math.min(r16(t + ifd), 512);
          if (t + ifd + 2 + n * 12 > buf.length) return;
          for (let i = 0; i < n; i++) {
            const e = t + ifd + 2 + i * 12;
            const tag = r16(e), cnt = r32(e + 4), val = r32(e + 8);
            if (tag === 0x8769) readIfd(val, depth + 1);
            if (tag === 0xa434 || tag === 0x0110) {
              if (cnt > 128 || (cnt > 4 && t + val + cnt > buf.length)) continue;
              const s = cnt <= 4 ? buf.toString('ascii', e + 8, e + 8 + cnt) : buf.toString('ascii', t + val, t + val + cnt);
              res[tag === 0xa434 ? 'lens' : 'model'] = s.replace(/\0+$/, '');
            }
          }
        };
        readIfd(r32(t + 4), 0);
        return res;
      }
      off += 2 + len;
    }
  } catch (e) { /* EXIF illisible */ }
  return null;
}

function ipadCameraLabel(text) {
  if (/front|avant/i.test(text || '')) return 'Caméra avant de l\'iPad';
  if (/back|arri[eè]re|rear/i.test(text || '')) return 'Caméra arrière de l\'iPad';
  return 'Caméra de l\'iPad (côté non indiqué par iOS)';
}

function probe(file, cb) {
  cp.execFile(FFPROBE, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], { timeout: 20000 }, function (e, out) {
    if (e) return cb(null);
    try { cb(JSON.parse(out)); } catch (x) { cb(null); }
  });
}

// Courbe de niveau a posteriori (pas de direct possible depuis Safari iOS 9) : RMS toutes les 100 ms.
function levelEnvelope(file, cb) {
  const p = spawnImpl(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-t', '600', '-f', 's16le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const levels = []; let rest = Buffer.alloc(0);
  p.stdout.on('data', function (b) {
    rest = Buffer.concat([rest, b]);
    while (rest.length >= 1600) {
      const blk = rest.subarray(0, 1600); rest = rest.subarray(1600);
      let sum = 0; for (let i = 0; i < blk.length; i += 2) { const v = blk.readInt16LE(i) / 32768; sum += v * v; }
      const db = 20 * Math.log10(Math.sqrt(sum / 800) || 1e-9);
      levels.push(Math.round(U.clamp((db + 60) / 60, 0, 1) * 100) / 100);
    }
  });
  p.on('close', function () { cb(levels); });
  p.on('error', function () { cb([]); });
}

// file : fichier déjà écrit sur le Mac ; mime déclaré par l'iPad (vérifié ici par ffprobe/EXIF).
function registerIpadUpload(file, mime, devName, purpose, hint, cb) {
  if (typeof hint === 'function') { cb = hint; hint = null; }
  const isImage = /^image\//.test(mime), isVideo = /^video\//.test(mime), isAudio = /^audio\//.test(mime);
  const hinted = { 'ipad-front': 'Caméra avant de l\'iPad', 'ipad-back': 'Caméra arrière de l\'iPad' }[hint];
  const entry = { id: U.newId('cap', 5), origin: 'ipad', device: devName, file: file, size: fs.statSync(file).size, createdAt: Date.now(), status: 'complet', draft: true, purpose: purpose || null };
  if (isImage) {
    const head = Buffer.alloc(Math.min(entry.size, 256 * 1024));
    const fd = fs.openSync(file, 'r'); fs.readSync(fd, head, 0, head.length, 0); fs.closeSync(fd);
    if (head[0] !== 0xff || head[1] !== 0xd8) return cb(new Error('fichier image non JPEG refusé'));
    const ex = lensFromExif(head) || {};
    entry.kind = 'photo'; entry.source = ex.lens ? ipadCameraLabel(ex.lens) : (hinted || ipadCameraLabel('')); entry.exif = { lens: ex.lens || null, model: ex.model || null };
    saveEntry(entry); return cb(null, entry);
  }
  if (isAudio) {
    // Audio du compagnon natif (micro de l'iPad) : vérifié par ffprobe, courbe de niveau calculée sur le Mac.
    return probe(file, function (info) {
      if (!info || !info.streams || !info.streams.some(function (s) { return s.codec_type === 'audio'; }) || info.streams.some(function (s) { return s.codec_type === 'video'; })) return cb(new Error('audio illisible'));
      entry.kind = 'audio'; entry.source = 'Micro de l\'iPad'; entry.withAudio = true; entry.durationSec = Math.round(Number(info.format.duration) || 0);
      levelEnvelope(file, function (levels) { entry.levels = levels; saveEntry(entry); cb(null, entry); });
    });
  }
  if (!isVideo) return cb(new Error('type de fichier refusé'));
  probe(file, function (info) {
    if (!info || !info.streams) return cb(new Error('vidéo illisible'));
    const tags = JSON.stringify((info.format && info.format.tags) || {}) + JSON.stringify(info.streams.map(function (s) { return s.tags || {}; }));
    const hasAudio = info.streams.some(function (s) { return s.codec_type === 'audio'; });
    entry.kind = 'video'; entry.withAudio = hasAudio; entry.durationSec = Math.round(Number(info.format.duration) || 0);
    entry.source = ipadCameraLabel(tags) + (hasAudio ? ' + Micro de l\'iPad' : ' (sans son)');
    if (!hasAudio) { saveEntry(entry); return cb(null, entry); }
    // Piste audio extraite pour l'écoute et la dictée (le micro de l'iPad est la source).
    const audio = file.replace(/\.[^.]+$/, '') + '-audio.m4a';
    cp.execFile(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-vn', '-ac', '1', '-c:a', 'aac', '-b:a', '128k', audio], { timeout: 120000 }, function (e) {
      if (!e) { entry.audioFile = audio; entry.audioSource = 'Micro de l\'iPad'; }
      levelEnvelope(file, function (levels) { entry.levels = levels; saveEntry(entry); cb(null, entry); });
    });
  });
}
function saveEntry(e) { captures.unshift(e); saveIndex(); hooks.changed(); }

function listCaptures(limit) { return captures.slice(0, limit || 50); }
function getCapture(id) { return captures.find(function (c) { return c.id === id; }); }
function updateCapture(id, patch) {
  const c = getCapture(id); if (!c) return null;
  ['draft', 'transcript', 'transcriptStatus', 'transcriptError', 'note'].forEach(function (k) { if (k in patch) c[k] = patch[k]; });
  saveIndex(); hooks.changed(); return c;
}
// Suppression = déplacement dans la Corbeille du Mac (récupérable), jamais d'effacement définitif.
function trashCapture(id) {
  const c = getCapture(id); if (!c) return { ok: false, error: 'capture introuvable' };
  const trash = path.join(os.homedir(), '.Trash');
  [c.file, c.audioFile, c.thumb].filter(Boolean).forEach(function (f) {
    try { fs.renameSync(f, path.join(trash, path.basename(f).replace(/(\.[^.]+)$/, '-' + Date.now() + '$1'))); } catch (e) { U.log('warn', 'déplacement corbeille impossible', { e: e.code }); }
  });
  captures = captures.filter(function (x) { return x.id !== id; }); saveIndex(); hooks.changed();
  return { ok: true, message: 'Capture placée dans la Corbeille du Mac' };
}

function describe(s) {
  const transmit = { 'cam-preview': 'Images JPEG envoyées à l\'iPad sur le réseau local', 'mic-test': 'Niveau sonore seulement, aucun fichier', 'mic-record': 'Fichier audio enregistré sur le Mac', 'mic-dictation': 'Fichier audio enregistré sur le Mac (dictée)', 'cam-photo': 'Photo enregistrée sur le Mac', 'cam-clip': 'Vidéo enregistrée sur le Mac' }[s.kind];
  return { id: s.id, kind: s.kind, origin: 'mac', source: s.sourceLabel, startedAt: s.startedAt, maxSec: s.maxSec, recording: !!s.file, file: s.file || null, transmission: transmit, ownerDev: s.ownerDev, withAudio: !!s.withAudio };
}
function status() {
  return { active: Object.keys(sessions).map(function (k) { return describe(sessions[k]); }), lastEnded: lastEnded, capturesDir: CAP_DIR() };
}

function init(h) {
  hooks = Object.assign(hooks, h || {});
  U.ensureDir(CAP_DIR());
  loadIndex();
  killOrphans();
  if (watchdog) clearInterval(watchdog);
  watchdog = setInterval(tick, 2000); watchdog.unref && watchdog.unref();
}

module.exports = {
  init: init, listDevices: listDevices, parseDeviceList: parseDeviceList, startMic: startMic, startCameraPreview: function (p, o, cb) { startCameraPreview(p, o, 30, undefined, cb); },
  takePhoto: takePhoto, startClip: startClip, stopSession: stopSession, stopAll: stopAll, status: status, micLevel: micLevel, previewFrame: previewFrame,
  registerIpadUpload: registerIpadUpload, listCaptures: listCaptures, getCapture: getCapture, updateCapture: updateCapture, trashCapture: trashCapture,
  lensFromExif: lensFromExif, ipadCameraLabel: ipadCameraLabel, tick: tick, FFMPEG: FFMPEG, CAP_DIR: CAP_DIR,
  _setSpawn: function (fn) { spawnImpl = fn; }, _setList: function (fn) { listImpl = fn; devCache = null; }
};
