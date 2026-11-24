'use strict';
// CMULTIMEDIA Deck — serveur local du Mac. Node.js ≥ 20, aucune dépendance externe.
// HTTP  (portHttp)  : interface + fonctions non sensibles + page d'installation du certificat.
// HTTPS (portHttps) : tout, y compris audio, images (exigent le chiffrement).
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const U = require('./lib/util');
const config = require('./lib/config');
const metrics = require('./lib/metrics');
const monitors = require('./lib/monitors');
const devices = require('./lib/devices');
const bus = require('./lib/bus');
const actions = require('./lib/actions');
const media = require('./lib/media');
const transcribe = require('./lib/transcribe');
const tls = require('./lib/tls');
const extras = require('./lib/extras');
const alerts = require('./lib/alerts');
const sysinfo = require('./lib/sysinfo');
const apps = require('./lib/apps');
const mouse = require('./lib/mouse');
const spectrum = require('./lib/spectrum');
const sysLogged = {};

const STARTED = Date.now();
const VERSION = '1.0.0';
const PUB = path.join(U.ROOT, 'public');
const ADMIN = path.join(U.ROOT, 'admin');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };
const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
let tlsInfo = null;

// ---------- utilitaires HTTP ----------
function send(res, code, body, type, extra) {
  const h = Object.assign({
    'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'none'"
  }, extra || {});
  if (!res.headersSent) res.writeHead(code, h);
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const J = function (res, code, obj) { send(res, code, obj); };

function readBody(req, max, cb) {
  let size = 0; const chunks = [];
  req.on('data', function (c) { size += c.length; if (size > max) { req.destroy(); } else chunks.push(c); });
  req.on('end', function () {
    if (size > max) return cb(new Error('trop volumineux'));
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return cb(null, {});
    try { cb(null, JSON.parse(raw)); } catch (e) { cb(new Error('JSON invalide')); }
  });
  req.on('error', cb);
}

function hostOf(h) { return String(h || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase(); }
function isLoopback(req) {
  if (LOOPBACK.indexOf(req.socket.remoteAddress) < 0) return false;
  const host = hostOf(req.headers.host);
  if (host !== '127.0.0.1' && host !== 'localhost') return false;   // anti DNS rebinding
  const o = req.headers.origin;
  if (o && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o)) return false;
  return true;
}
// Jeton d'administration (data/admin.token, 0600) : exigé pour l'éditeur, l'aperçu et ./deck. Le loopback seul ne suffit
// plus (un autre compte du Mac ou une app sandboxée partagent 127.0.0.1). Le navigateur le reçoit dans un cookie HttpOnly
// via un lien à usage unique ouvert par ./deck admin.
const ADMIN_TOKEN_FILE = path.join(U.DATA, 'admin.token');
let ADMIN_TOKEN = null;
const adminLinks = {};
function adminToken() {
  if (ADMIN_TOKEN) return ADMIN_TOKEN;
  try { ADMIN_TOKEN = fs.readFileSync(ADMIN_TOKEN_FILE, 'utf8').trim(); } catch (e) { ADMIN_TOKEN = null; }
  if (!ADMIN_TOKEN || ADMIN_TOKEN.length < 40) {
    ADMIN_TOKEN = require('crypto').randomBytes(32).toString('hex');
    U.ensureDir(U.DATA); fs.writeFileSync(ADMIN_TOKEN_FILE, ADMIN_TOKEN + '\n', { mode: 0o600 });
  }
  try { fs.chmodSync(ADMIN_TOKEN_FILE, 0o600); } catch (e) { /* */ }
  return ADMIN_TOKEN;
}
function cookieVal(req, name) { const m = new RegExp('(?:^|;\\s*)' + name + '=([A-Za-z0-9]+)').exec(req.headers.cookie || ''); return m ? m[1] : null; }
// Le navigateur ne reçoit jamais le jeton du fichier : une session aléatoire, en mémoire (perdue au redémarrage), 12 h.
const adminSessions = {};
function newAdminSession() {
  const s = require('crypto').randomBytes(32).toString('hex');
  adminSessions[s] = Date.now() + 12 * 3600000;
  Object.keys(adminSessions).forEach(function (k) { if (adminSessions[k] < Date.now()) delete adminSessions[k]; });
  return s;
}
function adminCookieName() { return 'deck_admin_' + config.get().settings.portHttp; }
function isAdmin(req) {
  if (!isLoopback(req)) return false;
  const h = req.headers['x-deck-admin'];
  if (h) return U.safeEqual(String(h), adminToken());
  const c = cookieVal(req, adminCookieName());
  return !!c && Object.prototype.hasOwnProperty.call(adminSessions, c) && adminSessions[c] > Date.now();
}
function isPreview(req) { return req.headers['x-deck-preview'] === '1' && isAdmin(req); }
// Requêtes intersites : l'Origin (si présente) doit correspondre à l'hôte appelé ; l'en-tête X-Deck force un pré-vol CORS jamais accordé.
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch (e) { return false; }
}
// Anti DNS rebinding pour l'API de l'iPad : seuls les noms et adresses du Mac sont acceptés.
function hostAllowed(req) {
  const h = hostOf(req.headers.host);
  if (h === '127.0.0.1' || h === 'localhost' || h === (U.localHostName() + '.local').toLowerCase()) return true;
  return U.lanAddresses().some(function (a) { return a.address === h; });
}
function clientIp(req) { return String(req.socket.remoteAddress || '').replace(/^::ffff:/, ''); }

function serveStatic(res, base, rel) {
  const p = path.normalize(path.join(base, rel));
  if (!p.startsWith(base + path.sep)) return send(res, 404, 'introuvable', 'text/plain');
  fs.readFile(p, function (err, buf) {
    if (err) return send(res, 404, 'introuvable', 'text/plain; charset=utf-8');
    send(res, 200, buf, MIME[path.extname(p)] || 'application/octet-stream', { 'Cache-Control': /\.(png|ico)$/.test(p) ? 'max-age=86400' : 'no-cache' });
  });
}

// Fichier avec prise en charge des Range (indispensable pour <audio>/<video> de Safari iOS).
function serveFile(req, res, file, type) {
  fs.stat(file, function (err, st) {
    if (err) return J(res, 404, { ok: false, error: 'fichier introuvable' });
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    let start = 0, end = st.size - 1, code = 200;
    if (range) { start = range[1] ? Number(range[1]) : st.size - Number(range[2]); end = range[1] && range[2] ? Number(range[2]) : end; code = 206; }
    if (start < 0 || start > end || end >= st.size) return send(res, 416, '', 'text/plain', { 'Content-Range': 'bytes */' + st.size });
    const h = { 'Content-Type': type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (code === 206) h['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
    res.writeHead(code, h);
    fs.createReadStream(file, { start: start, end: end }).pipe(res);
  });
}

// ---------- état poussé à l'iPad ----------
function svcLight() {
  return monitors.snapshot().map(function (s) { return { id: s.id, label: s.label, status: s.effective, raw: s.status, code: s.code, ms: s.ms, t: s.t, slow: s.slow, error: s.error, since: s.since, url: s.url, kind: s.kind, group: s.group }; });
}
// Version de l'interface iPad (date des fichiers) : l'iPad se recharge seul quand elle change.
function uiVersion() {
  let v = 0;
  ['app.js', 'style.css', 'index.html'].forEach(function (f) { try { v = Math.max(v, fs.statSync(path.join(PUB, f)).mtimeMs); } catch (e) { /* */ } });
  return Math.round(v);
}
function stateFor(secure) {
  const services = svcLight();
  const al = alerts.compute({ media: media.status(), services: services, metrics: metrics.current() });
  return {
    t: Date.now(), metrics: metrics.current(), counts: monitors.counts(), services: services, alerts: al,
    media: media.status(), music: extras.state().music, claude: secure ? extras.state().claude : null, codex: secure ? extras.state().codex : null, ai: secure ? extras.state().ai : null, weather: extras.state().weather, eph: extras.ephemeride(),
    ui: uiVersion(), configVersion: config.version(), demo: !!config.get().settings.demo
  };
}

function clientBundle() {
  const b = config.get();
  return {
    settings: b.settings, layout: b.layout,
    actions: b.actions.actions.map(function (a) { return { id: a.id, label: a.label, type: a.type, params: a.type === 'ipad_url' || a.type === 'page' ? a.params : undefined }; }),
    monitors: b.connectors.monitors.map(function (m) { return { id: m.id, label: m.label, group: m.group || 'Services' }; })
  };
}

// ---------- routes de l'iPad ----------
function deviceFor(req, url, secure) {
  if (isPreview(req)) return { id: 'apercu', name: 'Aperçu de l\'éditeur', preview: true };
  return devices.authenticate(req.headers['x-deck-token'], secure);
}
// Tout ce qui touche au son, à l'image, aux captures exige le port chiffré (l'arrêt des captures reste toujours permis).
const SECURE_ONLY = /^\/api\/(mouse|ticket|media\/(frame|file|upload|camera|mic|captures|capture|level))/;

function handleApi(req, res, url, secure) {
  const p = url.pathname;
  if (req.method === 'POST' && req.headers['x-deck'] !== '1') return J(res, 403, { ok: false, error: 'en-tête X-Deck manquant' });
  if (!hostAllowed(req)) return J(res, 403, { ok: false, error: 'hôte refusé' });
  if (!sameOrigin(req)) return J(res, 403, { ok: false, error: 'origine refusée' });

  if (p === '/api/ping') return J(res, 200, { ok: true, secure: secure, t: Date.now() });
  // Sans chiffrement, rien d'autre : le code d'association et les commandes ne circulent jamais en clair sur le Wi-Fi
  // (seul l'aperçu de l'éditeur, sur le Mac lui-même et avec le jeton d'administration, passe en http).
  if (!secure && !isAdmin(req)) return J(res, 403, { ok: false, secureRequired: true, error: 'Connexion chiffrée requise : installe le certificat (page /setup) puis ouvre l\'adresse https du deck.' });

  if (p === '/api/pair' && req.method === 'POST') {
    return readBody(req, 4096, function (e, b) {
      if (e) return J(res, 400, { ok: false, error: e.message });
      const r = devices.pair(b.code, b.name, clientIp(req), secure);
      J(res, r.ok ? 200 : r.status, r.ok ? { ok: true, token: r.token, device: r.device, secure: secure } : { ok: false, error: r.error });
    });
  }

  // Images et fichiers : ticket signé à courte durée (balises <img>/<audio> sans en-tête possible).
  if (p.indexOf('/api/apps/icon/') === 0) {
    const okI = devices.checkTicket(url.searchParams.get('k'), 'appicons') || isAdmin(req);
    const f = apps.iconFile(p.split('/')[4] || '');
    if (!okI || !f) return J(res, 401, { ok: false });
    return fs.readFile(f, function (e, buf) { if (e) return J(res, 404, { ok: false }); send(res, 200, buf, 'image/png', { 'Cache-Control': 'max-age=86400' }); });
  }
  if (p === '/api/music/artwork') {
    const okT = devices.checkTicket(url.searchParams.get('k'), 'artwork') || isAdmin(req);
    if (!okT) return J(res, 401, { ok: false });
    return fs.readFile(extras.ARTWORK, function (e, buf) { if (e) return J(res, 404, { ok: false }); send(res, 200, buf, 'image/jpeg', { 'Cache-Control': 'no-store' }); });
  }
  if (p === '/api/media/frame' || p.indexOf('/api/media/file/') === 0) {
    if (!secure) return J(res, 403, { ok: false, error: 'connexion chiffrée requise' });
    const resource = p === '/api/media/frame' ? 'frame' : 'file:' + p.split('/')[4];
    const dev = devices.checkTicket(url.searchParams.get('k'), resource) || (isAdmin(req) ? { id: 'apercu' } : null);
    if (!dev) return J(res, 401, { ok: false, error: 'ticket invalide ou expiré' });
    if (p === '/api/media/frame') {
      const f = media.previewFrame();
      if (!f) return J(res, 404, { ok: false, error: 'aucun aperçu en cours' });
      if (!f.buf) return J(res, 202, { ok: true, waiting: true });
      return send(res, 200, f.buf, 'image/jpeg', { 'X-Frame-Time': String(f.t) });
    }
    const c = media.getCapture(p.split('/')[4]);
    if (!c) return J(res, 404, { ok: false, error: 'capture introuvable' });
    const part = url.searchParams.get('part');
    const file = part === 'audio' && c.audioFile ? c.audioFile : c.file;
    const type = /\.jpe?g$/i.test(file) ? 'image/jpeg' : /\.m4a$/i.test(file) ? 'audio/mp4' : /\.mov$/i.test(file) ? 'video/quicktime' : 'video/mp4';
    return serveFile(req, res, file, type);
  }

  const dev = deviceFor(req, url, secure);
  if (!dev) return J(res, 401, { ok: false, error: 'appareil non associé', pair: true });
  if (!dev.preview) devices.touch(dev, clientIp(req), url.searchParams.get('page'));
  if (SECURE_ONLY.test(p) && !secure && !dev.preview) return J(res, 403, { ok: false, secureRequired: true, error: 'Connexion chiffrée requise pour cette fonction. Installe le certificat du deck puis ouvre l\'adresse https.' });

  if (p === '/api/bootstrap') return J(res, 200, { ok: true, device: { id: dev.id, name: dev.name }, secure: secure, version: VERSION, config: clientBundle(), state: stateFor(secure || dev.preview), seq: bus.seq(), v: bus.version() });
  if (p === '/api/poll') {
    const seq = Number(url.searchParams.get('seq')) || 0, v = Number(url.searchParams.get('v')) || 0;
    let closed = false;
    req.on('close', function () { closed = true; });
    return bus.poll(dev.id, seq, v, 25000, function (out) {
      if (closed) return;
      out.state = stateFor(secure || dev.preview);
      J(res, 200, out);
    });
  }
  if (p === '/api/config') return J(res, 200, { ok: true, config: clientBundle(), version: config.version() });
  if (p === '/api/history') {
    const src = url.searchParams.get('source') || '';
    if (!/^(cpu|mem|disk|volume|svc:[a-z0-9_-]+)$/.test(src)) return J(res, 400, { ok: false, error: 'source invalide' });
    const win = U.clamp(Number(url.searchParams.get('window')) || 900, 60, 3600 * 6);
    return J(res, 200, { ok: true, source: src, window: win, interval: src.indexOf('svc:') === 0 ? config.get().settings.httpIntervalSec : config.get().settings.metricsIntervalSec, points: metrics.history(src, win) });
  }
  if (p === '/api/ack' && req.method === 'POST') {
    return readBody(req, 4096, function (e, b) {
      if (e) return J(res, 400, { ok: false });
      J(res, 200, { ok: bus.ack(dev.id, String(b.cmd || ''), b.stage === 'error' ? 'error' : 'done', b.info) });
    });
  }
  if (p === '/api/action' && req.method === 'POST') {
    return readBody(req, 4096, function (e, b) {
      if (e) return J(res, 400, { ok: false, error: e.message });
      actions.execute(config.get(), String(b.id || ''), { origin: 'ipad:' + dev.id, pressId: b.pressId }, function (r) { J(res, 200, r); });
    });
  }
  if (p === '/api/ticket') {
    const r = url.searchParams.get('r') || '';
    if (r !== 'frame' && r !== 'artwork' && r !== 'appicons' && !/^file:cap_[a-f0-9]{10}$/.test(r)) return J(res, 400, { ok: false });
    return J(res, 200, { ok: true, k: devices.ticket(dev.id, r, 900) });
  }

  if (p === '/api/alerts/ack' && req.method === 'POST') {
    return readBody(req, 2048, function (e, b) { if (e) return J(res, 400, { ok: false }); alerts.ack(String(b.id || '')); U.log('info', 'alerte vue', { appareil: dev.name, id: String(b.id || '').replace(/^(ticket|journal):.*/, '$1') }); bus.bump(); J(res, 200, { ok: true }); });
  }
  if (p === '/api/mouse' && req.method === 'POST') {
    return readBody(req, 16384, function (e, b) { if (e) return J(res, 400, { ok: false }); J(res, 200, mouse.send(b.ops)); });
  }
  if (p === '/api/apps') return apps.list(function (e, l) { J(res, e ? 503 : 200, e ? { ok: false, error: e.message } : { ok: true, apps: l.map(function (a) { return { id: a.id, name: a.name, icon: a.icon }; }) }); });
  if (p === '/api/apps/open' && req.method === 'POST') {
    return readBody(req, 1024, function (e, b) { if (e) return J(res, 400, { ok: false }); apps.open(String(b.id || ''), function (err, out) { U.log(err ? 'warn' : 'info', 'application ' + (err ? 'refusée' : 'ouverte'), { appareil: dev.name }); J(res, 200, err ? { ok: false, error: err.message } : Object.assign({ ok: true }, out)); }); });
  }
  if (p === '/api/sysinfo' && !dev.preview && !sysLogged[dev.id]) { sysLogged[dev.id] = 1; U.log('info', 'Performances : détails demandés', { appareil: dev.name }); }
  if (p === '/api/sysinfo') return J(res, 200, Object.assign({ ok: true }, sysinfo.get()));
  if (p === '/api/clientlog' && req.method === 'POST') {
    return readBody(req, 4096, function (e, b) { if (!e) U.log(b.kind === 'boot' ? 'info' : 'warn', b.kind === 'boot' ? 'chargement iPad' : 'erreur iPad', { appareil: dev.name, msg: String(b.msg || '').slice(0, 300), ou: String(b.where || '').slice(0, 200), ua: String(b.ua || '').slice(0, 120) }); J(res, 200, { ok: true }); });
  }
  if (p === '/api/music/spectrum') return J(res, 200, Object.assign({ ok: true }, spectrum.get()));
  if (p === '/api/music/seek' && req.method === 'POST') return readBody(req, 512, function (e, b) { if (e) return J(res, 400, { ok: false }); extras.seek(b.sec, function (err, out) { J(res, 200, err ? { ok: false, error: err.message } : Object.assign({ ok: true }, out)); }); });
  if (p === '/api/music/playlists') return extras.musicPlaylists(function (e, l) { const fav = extras.musicFavorites().map(function (f) { return { id: f.id, label: f.label, kind: f.kind }; }); J(res, e ? 503 : 200, e ? { ok: false, error: e.message, favorites: fav } : { ok: true, playlists: l, favorites: fav }); });
  if (p === '/api/music/favorite' && req.method === 'POST') {
    return readBody(req, 1024, function (e, b) { if (e) return J(res, 400, { ok: false }); U.log('info', 'musique : favori', { appareil: dev.name, id: String(b.id || '').slice(0, 40) }); extras.playFavorite(String(b.id || ''), function (err, out) { J(res, 200, err ? { ok: false, error: err.message } : Object.assign({ ok: true }, out)); }); });
  }
  if (p === '/api/music/playlist' && req.method === 'POST') {
    return readBody(req, 2048, function (e, b) { if (e) return J(res, 400, { ok: false }); U.log('info', 'musique : playlist', { appareil: dev.name }); extras.playPlaylist(String(b.name || ''), function (err, out) { J(res, 200, err ? { ok: false, error: err.message } : Object.assign({ ok: true }, out)); }); });
  }
  if (p === '/api/music' && req.method === 'POST') {
    return readBody(req, 2048, function (e, b) {
      if (e) return J(res, 400, { ok: false, error: e.message });
      if (!extras.MUSIC_OPS[b.op]) return J(res, 400, { ok: false, error: 'commande musique inconnue' });
      U.log('info', 'musique : ' + b.op, { appareil: dev.name });
      extras.music(String(b.op), function (err, out) { if (err) U.log('warn', 'musique en échec', { e: err.message }); J(res, 200, err ? { ok: false, error: err.message } : Object.assign({ ok: true }, out)); });
    });
  }
  // ----- Studio -----
  if (p === '/api/media/devices') return media.listDevices(function (e, l) { J(res, e ? 500 : 200, e ? { ok: false, error: e.message } : { ok: true, devices: l, ffmpeg: media.FFMPEG }); }, url.searchParams.get('refresh') === '1');
  if (p === '/api/media/status') return J(res, 200, Object.assign({ ok: true }, media.status()));
  if (p === '/api/media/level') return J(res, 200, { ok: true, level: media.micLevel() });
  if (p === '/api/media/captures') return J(res, 200, { ok: true, captures: media.listCaptures(40).map(function (c) { return Object.assign({}, c, { levels: c.levels ? c.levels.slice(0, 600) : undefined }); }), dir: media.CAP_DIR() });
  if (p === '/api/media/upload' && req.method === 'POST') return handleUpload(req, res, url, dev);
  if (req.method === 'POST' && p.indexOf('/api/media/') === 0) {
    return readBody(req, 8192, function (e, b) {
      if (e) return J(res, 400, { ok: false, error: e.message });
      const owner = dev.preview ? null : dev.id;
      const reply = function (err, out) { J(res, err ? 409 : 200, err ? { ok: false, error: err.message } : { ok: true, result: out }); };
      if (p === '/api/media/stop') {
        if (b.id) return J(res, 200, { ok: media.stopSession(String(b.id), 'arrêt depuis ' + dev.name) });
        return J(res, 200, { ok: true, message: media.stopAll('arrêt immédiat depuis ' + dev.name) });
      }
      if (p === '/api/media/mic/start') return media.startMic({ device: String(b.device || ''), mode: String(b.mode || '') }, owner, reply);
      if (p === '/api/media/camera/preview') return media.startCameraPreview({ device: String(b.device || ''), fps: b.fps }, owner, reply);
      if (p === '/api/media/camera/photo') return media.takePhoto({ device: String(b.device || '') }, owner, reply);
      if (p === '/api/media/camera/clip') return media.startClip({ device: String(b.device || ''), withAudio: !!b.withAudio, audioDevice: String(b.audioDevice || '') }, owner, reply);
      const m = p.match(/^\/api\/media\/capture\/(cap_[a-f0-9]{10})\/(keep|trash|transcribe|play-mac|note)$/);
      if (m) return captureOp(m[1], m[2], b, res);
      J(res, 404, { ok: false, error: 'route inconnue' });
    });
  }

  J(res, 404, { ok: false, error: 'route inconnue' });
}

function captureOp(id, op, b, res) {
  const c = media.getCapture(id);
  if (!c) return J(res, 404, { ok: false, error: 'capture introuvable' });
  if (op === 'keep') return J(res, 200, { ok: true, capture: media.updateCapture(id, { draft: false }) });
  if (op === 'trash') return J(res, 200, media.trashCapture(id));
  if (op === 'note') return J(res, 200, { ok: true, capture: media.updateCapture(id, { transcript: String(b.text || '').slice(0, 9000) }) });
  if (op === 'play-mac') {
    const f = c.audioFile || c.file;
    if (!/\.(m4a|mp4|mov)$/i.test(f)) return J(res, 400, { ok: false, error: 'pas de piste audio' });
    cp.execFile('/usr/bin/afplay', ['-t', '600', f], { timeout: 610000 }, function () {});
    return J(res, 200, { ok: true, message: 'Lecture sur les haut-parleurs du Mac' });
  }
  if (op === 'transcribe') {
    const src = c.audioFile || (c.kind === 'audio' || c.kind === 'video' ? c.file : null);
    if (!src) return J(res, 400, { ok: false, error: 'aucune piste audio à transcrire' });
    if (c.transcriptStatus === 'en cours') return J(res, 200, { ok: true, already: true });
    const info = transcribe.info();
    if (!info.available) { media.updateCapture(id, { transcriptStatus: 'aucun moteur' }); return J(res, 200, { ok: false, error: 'Aucun moteur de transcription configuré : l\'enregistrement reste en brouillon, utilise la saisie texte.' }); }
    media.updateCapture(id, { transcriptStatus: 'en cours', transcriptError: null });
    transcribe.transcribe(src, function (err, text) {
      media.updateCapture(id, err ? { transcriptStatus: 'erreur', transcriptError: err.message } : { transcriptStatus: 'terminé', transcript: text });
    });
    return J(res, 200, { ok: true, engine: info.label });
  }
}

function dirSize(d) {
  let t = 0;
  try { fs.readdirSync(d, { withFileTypes: true }).forEach(function (e) { const p = path.join(d, e.name); t += e.isDirectory() ? dirSize(p) : fs.statSync(p).size; }); } catch (e) { /* absent */ }
  return t;
}
// Envoi d'une photo/vidéo depuis l'iPad : corps brut (XHR.send(File)), type vérifié, taille bornée.
function handleUpload(req, res, url, dev) {
  const type = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
  if (['image/jpeg', 'video/quicktime', 'video/mp4', 'audio/mp4', 'audio/x-m4a', 'audio/m4a'].indexOf(type) < 0) return J(res, 415, { ok: false, error: 'type non accepté (' + type + ')' });
  const max = 400 * 1024 * 1024;
  if (Number(req.headers['content-length']) > max) return J(res, 413, { ok: false, error: 'fichier trop volumineux (400 Mo max)' });
  if (dirSize(path.join(media.CAP_DIR(), 'ipad')) > 2 * 1024 * 1024 * 1024) return J(res, 507, { ok: false, error: 'quota de 2 Go atteint pour les captures iPad : fais du tri dans le Studio' });
  const purpose = url.searchParams.get('purpose') === 'dictee' ? 'dictee' : null;
  const d = U.ensureDir(path.join(media.CAP_DIR(), 'ipad', new Date().toISOString().slice(0, 10)));
  const isAudio = /^audio\//.test(type);
  const ext = type === 'image/jpeg' ? '.jpg' : isAudio ? '.m4a' : type === 'video/mp4' ? '.mp4' : '.mov';
  // Indication de source envoyée par l'app native (liste fermée) : ipad-mic | ipad-front | ipad-back
  const hint = ['ipad-mic', 'ipad-front', 'ipad-back'].indexOf(req.headers['x-deck-source']) >= 0 ? req.headers['x-deck-source'] : null;
  const file = path.join(d, (type === 'image/jpeg' ? 'photo-ipad-' : isAudio ? 'voix-ipad-' : 'video-ipad-') + Date.now() + ext);
  const out = fs.createWriteStream(file, { mode: 0o600 });
  let size = 0, tooBig = false;
  req.on('data', function (c) { size += c.length; if (size > max && !tooBig) { tooBig = true; req.destroy(new Error('trop volumineux')); } });
  require('stream').pipeline(req, out, function (err) {
    if (err || size === 0) {
      try { fs.renameSync(file, file + '.incomplet'); } catch (e) { /* */ }
      U.log('warn', 'envoi iPad interrompu', { taille: size });
      return J(res, tooBig ? 413 : 400, { ok: false, error: tooBig ? 'fichier trop volumineux (400 Mo max)' : 'envoi interrompu (fichier marqué incomplet sur le Mac)' });
    }
    media.registerIpadUpload(file, type, dev.name, purpose, hint, function (e2, entry) {
      if (e2) { try { fs.renameSync(file, file + '.refuse'); } catch (e) { /* */ } return J(res, 400, { ok: false, error: e2.message }); }
      U.log('info', 'capture reçue de l\'iPad', { type: entry.kind, taille: size });
      J(res, 200, { ok: true, capture: entry });
    });
  });
}

// ---------- routes d'administration (Mac uniquement) ----------
function handleAdmin(req, res, url) {
  if (!isLoopback(req)) return J(res, 403, { ok: false, error: 'administration réservée au Mac (127.0.0.1)' });
  const p = url.pathname;
  if ((p === '/admin' || p === '/admin/') && url.searchParams.get('n')) {
    const n = url.searchParams.get('n'), exp = adminLinks[n]; delete adminLinks[n];
    if (!exp || exp < Date.now()) return send(res, 403, 'Lien expiré : relance ./deck admin', 'text/plain; charset=utf-8');
    res.writeHead(302, { Location: '/admin/', 'Set-Cookie': adminCookieName() + '=' + newAdminSession() + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200', 'Cache-Control': 'no-store' });
    return res.end();
  }
  if ((p === '/admin' || p === '/admin/') && !isAdmin(req)) return send(res, 401, 'Éditeur verrouillé : ouvre-le avec la commande ./deck admin dans le Terminal du Mac.', 'text/plain; charset=utf-8');
  if (p === '/admin' || p === '/admin/') return serveStatic(res, ADMIN, 'index.html');
  if (!p.startsWith('/admin/api/')) return serveStatic(res, ADMIN, p.slice('/admin/'.length));
  if (req.headers['x-deck'] !== '1') return J(res, 403, { ok: false, error: 'en-tête X-Deck manquant' });
  if (!isAdmin(req)) return J(res, 401, { ok: false, error: 'jeton d\'administration requis (./deck admin)' });
  const route = p.slice('/admin/api/'.length);
  const withBody = function (fn) { readBody(req, 2 * 1024 * 1024, function (e, b) { if (e) return J(res, 400, { ok: false, error: e.message }); fn(b); }); };

  switch (route) {
    case 'status': return J(res, 200, adminStatus());
    case 'login-link': { const n = require('crypto').randomBytes(18).toString('hex'); adminLinks[n] = Date.now() + 60000; return J(res, 200, { ok: true, url: 'http://127.0.0.1:' + config.get().settings.portHttp + '/admin/?n=' + n }); }
    case 'config': if (req.method === 'GET') return J(res, 200, { ok: true, config: config.get(), version: config.version(), widgetTypes: config.WIDGET_TYPES, actionTypes: config.ACTION_TYPES, grid: [config.GRID_COLS, config.GRID_ROWS] });
      return withBody(function (b) { const r = config.save(b.config, 'éditeur'); J(res, r.ok ? 200 : 422, r); });
    case 'validate': return withBody(function (b) { const errs = config.validate(b.config); J(res, 200, { ok: !errs.length, errors: errs }); });
    case 'reload': return J(res, 200, config.reload());
    case 'restore': return withBody(function (b) { J(res, 200, config.restore(b.name)); });
    case 'backups': return J(res, 200, { ok: true, backups: config.listBackups() });
    case 'devices': return J(res, 200, { ok: true, devices: devices.list(), waiting: bus.waiting() });
    case 'revoke': return withBody(function (b) { const r = devices.revoke(String(b.device || '')); if (r.ok) bus.cancelWaiter(r.device.id); J(res, 200, r); });
    case 'pair': return J(res, 200, { ok: true, code: devices.newCode() });
    case 'command': return withBody(function (b) {
      if (['show', 'reload', 'open_url'].indexOf(b.type) < 0) return J(res, 400, { ok: false, error: 'type de commande inconnu' });
      if (b.type === 'show' && !config.get().layout.pages.some(function (pg) { return pg.id === b.page; })) return J(res, 404, { ok: false, error: 'page inconnue « ' + b.page + ' »', pages: config.get().layout.pages.map(function (pg) { return pg.id; }) });
      const c = bus.send(b.type, b.type === 'show' ? { page: b.page } : {}, b.target || 'all');
      bus.waitAck(c.id, U.clamp(Number(b.wait) || 8000, 0, 30000), function (cmd) { J(res, 200, { ok: true, command: cmdReport(cmd || c) }); });
    });
    case 'run': return withBody(function (b) { actions.execute(config.get(), String(b.action || ''), { origin: 'cli', pressId: b.pressId }, function (r) { J(res, 200, r); }); });
    case 'button': return withBody(function (b) { J(res, 200, addButton(b)); });
    case 'media': return J(res, 200, Object.assign({ ok: true }, media.status()));
    case 'media/stop': return J(res, 200, { ok: true, message: media.stopAll('arrêt depuis le Mac') });
    case 'logs': {
      const n = U.clamp(Number(url.searchParams.get('n')) || 50, 1, 500);
      let lines = []; try { lines = fs.readFileSync(path.join(U.DATA, 'logs', 'deck.log'), 'utf8').trim().split('\n').slice(-n); } catch (e) { /* vide */ }
      return J(res, 200, { ok: true, lines: lines });
    }
    default: return J(res, 404, { ok: false, error: 'route d\'administration inconnue' });
  }
}

function cmdReport(c) {
  const devs = devices.list();
  const acks = Object.keys(c.acks || {}).map(function (id) { const d = devs.find(function (x) { return x.id === id; }) || { name: id }; const a = c.acks[id]; return { device: d.name, id: id, delivered: a.delivered || null, done: a.done || null, error: a.error || null, info: a.info || null }; });
  const online = devs.filter(function (d) { return !d.revoked && Date.now() - d.lastSeen < 40000; });
  return { id: c.id, type: c.type, payload: c.payload, createdAt: c.createdAt, acks: acks, onlineDevices: online.map(function (d) { return d.name; }),
    lastContact: devs.filter(function (d) { return !d.revoked; }).map(function (d) { return { device: d.name, lastSeen: d.lastSeen, lastPage: d.lastPage }; }) };
}

function addButton(b) {
  const bundle = JSON.parse(JSON.stringify(config.get()));
  const page = bundle.layout.pages.find(function (pg) { return pg.id === b.page; });
  if (!page) return { ok: false, errors: ['page inconnue « ' + b.page + ' »'] };
  if (!bundle.actions.actions.some(function (a) { return a.id === b.action; })) return { ok: false, errors: ['action inconnue « ' + b.action + ' » (./deck actions)'] };
  const w = Number(b.w) || 3, h = Number(b.h) || 1;
  const occ = {};
  (page.widgets || []).forEach(function (x) { for (let i = x.x; i < x.x + x.w; i++) for (let j = x.y; j < x.y + x.h; j++) occ[i + ',' + j] = 1; });
  let spot = null;
  for (let y = 0; y + h <= config.GRID_ROWS && !spot; y++) for (let x = 0; x + w <= config.GRID_COLS && !spot; x++) {
    let free = true; for (let i = x; i < x + w && free; i++) for (let j = y; j < y + h; j++) if (occ[i + ',' + j]) { free = false; break; }
    if (free) spot = { x: x, y: y };
  }
  if (!spot) return { ok: false, errors: ['plus de place libre ' + w + '×' + h + ' sur la page « ' + page.id + ' »'] };
  let base = 'btn-' + String(b.label || 'bouton').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  let id = base, n = 2; while (page.widgets.some(function (x) { return x.id === id; })) id = base + '-' + n++;
  page.widgets.push({ id: id, type: 'button', x: spot.x, y: spot.y, w: w, h: h, label: String(b.label || '').slice(0, 60), action: b.action });
  const r = config.save(bundle, 'CLI button add');
  return Object.assign({ widget: id, position: spot }, r);
}

function adminStatus() {
  const st = config.get().settings;
  const lan = U.lanAddresses();
  const host = U.localHostName() + '.local';
  return {
    ok: true, version: VERSION, pid: process.pid, startedAt: STARTED, demo: st.demo,
    urls: {
      ipadHttps: 'https://' + host + ':' + st.portHttps + '/', ipadHttpsIp: lan[0] ? 'https://' + lan[0].address + ':' + st.portHttps + '/' : null,
      ipadHttp: 'http://' + host + ':' + st.portHttp + '/', setup: (lan[0] ? 'http://' + lan[0].address : 'http://' + host) + ':' + st.portHttp + '/setup',
      admin: 'http://127.0.0.1:' + st.portHttp + '/admin'
    },
    lan: lan, pairing: devices.currentCode() || { code: null, expires: null }, tls: tlsInfo ? { ok: tlsInfo.ok, names: tlsInfo.names, caFingerprint: tls.fingerprint(), error: tlsInfo.error } : null,
    devices: devices.list().filter(function (d) { return !d.revoked; }), media: media.status().active, counts: monitors.counts(),
    metrics: metrics.current(), configVersion: config.version()
  };
}

// ---------- serveur ----------
function router(secure) {
  return function (req, res) {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch (e) { return J(res, 400, { ok: false }); }
    const p = url.pathname;
    try {
      if (p.indexOf('/admin') === 0) return handleAdmin(req, res, url);
      if (p.indexOf('/api/') === 0) return handleApi(req, res, url, secure);
      if (p === '/ca.crt') return fs.readFile(tls.files().caCrt, function (e, buf) { if (e) return J(res, 404, { ok: false }); send(res, 200, buf, 'application/x-x509-ca-cert', { 'Content-Disposition': 'attachment; filename="cmultimedia-deck-ca.crt"' }); });
      if (p === '/deck.mobileconfig') {
        const st = config.get().settings;
        const url = 'https://' + U.localHostName() + '.local:' + st.portHttps + '/';
        return send(res, 200, require('./lib/mobileconfig').build(tls.files().caCrt, url), 'application/x-apple-aspen-config', { 'Content-Disposition': 'attachment; filename="cmultimedia-deck.mobileconfig"' });
      }
      if (p === '/setup') return serveStatic(res, PUB, 'setup.html');
      if (!secure && !isLoopback(req) && (p === '/' || p === '/index.html')) { res.writeHead(302, { Location: '/setup', 'Cache-Control': 'no-store' }); return res.end(); }
      // Page d'accueil servie avec la version des fichiers (le cache de Safari iOS ne peut plus garder une ancienne feuille de style)
      // Adresse sans numéro de version => redirection vers l'adresse versionnée (jamais vue par le cache de Safari)
      if ((p === '/' || p === '/index.html') && url.searchParams.get('v') !== String(uiVersion())) {
        const q = new URLSearchParams(url.search); q.set('v', String(uiVersion()));
        res.writeHead(302, { Location: '/?' + q.toString(), 'Cache-Control': 'no-store' }); return res.end();
      }
      if (p === '/' || p === '/index.html') return fs.readFile(path.join(PUB, 'index.html'), 'utf8', function (e, t) {
        if (e) return send(res, 404, 'introuvable', 'text/plain');
        const v = uiVersion();
        send(res, 200, t.replace('/style.css"', '/style.css?v=' + v + '"').replace('/app.js"', '/app.js?v=' + v + '"'), 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' });
      });
      return serveStatic(res, PUB, p.slice(1));
    } catch (e) {
      U.log('error', 'erreur de route', { route: p, e: e.message });
      J(res, 500, { ok: false, error: 'erreur interne' });
    }
  };
}

function main() {
  U.ensureDir(U.DATA);
  try { fs.chmodSync(U.DATA, 0o700); } catch (e) { /* */ }
  adminToken();
  const loaded = config.load();
  if (!loaded.ok) U.log('warn', 'configuration de secours chargée', { erreurs: loaded.errors.length });
  const S = function () { return config.get().settings; };
  devices.load();
  metrics.start(S);
  monitors.start(config.get);
  media.init({ changed: bus.bump, settings: S, lastSeen: function (id) { const d = devices.list().find(function (x) { return x.id === id; }); return d ? d.lastSeen : 0; } });
  extras.init(function () { return config.get().connectors; }, bus.bump);
  transcribe.init(function () { return config.get().connectors.transcription; });
  apps.list(function () {});   // lecture du Dock dès le démarrage (la première est lente)
  actions.setHooks({ music: extras.music, sendToDevices: function (t, pl) { return bus.send(t, pl, 'all'); }, mediaStopAll: media.stopAll, refreshVolume: function (cb) { metrics.refreshVolume(function (v) { bus.bump(); cb(v); }); } });
  metrics.onSample(function () { bus.bump(); });
  monitors.onResult(function () { bus.bump(); });
  config.onChange(function () { bus.bump(); });

  const st = S();
  http.createServer(router(false)).listen(st.portHttp, '0.0.0.0', function () { U.log('info', 'HTTP à l\'écoute sur le port ' + st.portHttp); });
  try {
    tlsInfo = tls.ensure();
    if (tlsInfo.ok) {
      https.createServer({ key: tlsInfo.key, cert: tlsInfo.cert, minVersion: 'TLSv1.2' }, router(true)).listen(st.portHttps, '0.0.0.0', function () { U.log('info', 'HTTPS à l\'écoute sur le port ' + st.portHttps); });
    }
  } catch (e) { tlsInfo = { ok: false, error: e.message }; U.log('error', 'HTTPS indisponible', { e: e.message }); }

  if (!devices.active().length) devices.newCode();   // premier lancement : association ouverte 10 min
  const code = devices.currentCode();
  const s = adminStatus();
  const banner = '\n  CMULTIMEDIA Deck ' + VERSION + ' démarré\n  iPad (chiffré)  : ' + s.urls.ipadHttps + '\n  Installer le certificat : ' + s.urls.setup + '\n  Éditeur (Mac)   : ' + s.urls.admin + '\n  Code d\'association : ' + (!code ? 'fermée (./deck pair)' : process.stdout.isTTY ? code.code + ' (10 min)' : 'voir ./deck url') + '\n';
  process.stdout.write(banner);
  U.log('info', 'serveur démarré', { pid: process.pid });

  const shutdown = function (sig) {
    U.log('info', 'arrêt du serveur (' + sig + '), libération des périphériques');
    media.stopAll('arrêt du serveur'); mouse.stop(); spectrum.stop();
    metrics.persist();
    setTimeout(function () { process.exit(0); }, 1200);
  };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  process.on('uncaughtException', function (e) { U.log('error', 'exception non gérée', { e: e.message, stack: String(e.stack).split('\n').slice(0, 3).join(' | ') }); });
}

if (require.main === module) main();
module.exports = { router: router, adminToken: adminToken, isLoopback: isLoopback, sameOrigin: sameOrigin, addButton: addButton, stateFor: stateFor };
