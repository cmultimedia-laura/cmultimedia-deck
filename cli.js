'use strict';
// ./deck — pilotage du CMULTIMEDIA Deck depuis le terminal, Claude Code ou Codex (sans simuler de clics).
const fs = require('fs');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const os = require('os');
const U = require('./lib/util');

const args = process.argv.slice(2);
const JSON_OUT = args.indexOf('--json') >= 0;
const pos = args.filter(function (a) { return a !== '--json'; });
const PID_FILE = path.join(U.DATA, 'deck.pid');
const settings = U.readJSON(path.join(U.CONFIG_DIR, 'settings.json'), { portHttp: 8710, portHttps: 8711 });
const PLIST_LABEL = 'com.cmultimedia.deck';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', PLIST_LABEL + '.plist');

function opt(name, def) { const i = pos.indexOf('--' + name); return i >= 0 && pos[i + 1] !== undefined ? pos[i + 1] : def; }
function out(obj, text) {
  if (JSON_OUT) process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  else process.stdout.write((typeof text === 'function' ? text(obj) : text || JSON.stringify(obj, null, 2)) + '\n');
}
function fail(msg, code, obj) { if (JSON_OUT) process.stdout.write(JSON.stringify(Object.assign({ ok: false, error: msg }, obj || {}), null, 2) + '\n'); else process.stderr.write('✗ ' + msg + '\n'); process.exit(code || 1); }

// Jeton d'administration créé par le serveur (data/admin.token, lisible par ce seul compte)
function adminTok() { try { return fs.readFileSync(path.join(U.DATA, 'admin.token'), 'utf8').trim(); } catch (e) { return ''; } }
function api(method, route, body, cb, timeout) {
  const data = body ? JSON.stringify(body) : null;
  const req = http.request({ host: '127.0.0.1', port: settings.portHttp, path: '/admin/api/' + route, method: method, timeout: timeout || 40000,
    headers: Object.assign({ 'X-Deck': '1', 'X-Deck-Admin': adminTok(), 'Host': '127.0.0.1:' + settings.portHttp }, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) }, function (res) {
    let s = ''; res.on('data', function (c) { s += c; }); res.on('end', function () { let j = null; try { j = JSON.parse(s); } catch (e) { /* */ } cb(null, j, res.statusCode); });
  });
  req.on('error', function (e) { cb(e); });
  req.on('timeout', function () { req.destroy(new Error('délai dépassé')); });
  if (data) req.write(data);
  req.end();
}
function need(cb) { api('GET', 'status', null, function (e, j) { if (e || !j) fail('Le deck n\'est pas démarré (./deck start).', 3); cb(j); }); }
function pidAlive() { try { const pid = Number(fs.readFileSync(PID_FILE, 'utf8')); process.kill(pid, 0); return pid; } catch (e) { return 0; } }
function t(ts) { return ts ? new Date(ts).toLocaleString('fr-FR') : 'jamais'; }

const HELP = `CMULTIMEDIA Deck — commandes (ajoute --json pour une sortie JSON)

  ./deck start                 démarre le serveur (Mac) et affiche l'adresse iPad + code d'association
  ./deck stop                  arrête le serveur (libère micro et caméra)
  ./deck status                état : appareils, captures, services, mesures
  ./deck doctor                diagnostic complet (outils, certificat, permissions)
  ./deck url                   adresses à ouvrir sur l'iPad + code d'association en cours
  ./deck pair                  génère un nouveau code d'association (10 min)
  ./deck pages                 liste des pages
  ./deck show <page>           affiche une page sur l'iPad (accusé : créée → reçue → affichée)
  ./deck actions               catalogue des actions autorisées
  ./deck run <action>          exécute une action du catalogue
  ./deck button add --page <page> --label <texte> --action <action> [--w 3 --h 1]
  ./deck reload                relit les fichiers config/*.json (validation) et met à jour l'iPad
  ./deck restore [sauvegarde]  restaure la dernière configuration sauvegardée (ou celle nommée)
  ./deck logs [-n 50]          journal technique (sans jetons ni contenus)
  ./deck devices               appareils associés et dernier contact
  ./deck revoke <appareil>     révoque un appareil (id ou nom)
  ./deck media status          captures en cours (origine, source, fichier, transmission)
  ./deck media stop            arrête immédiatement toutes les captures
  ./deck admin                 ouvre l'éditeur visuel sur le Mac
  ./deck autostart enable|disable --confirme   lancement automatique à l'ouverture de session`;

const cmd = pos[0], sub = pos[1];
switch (cmd) {
  case undefined: case 'help': case '-h': case '--help': out({ help: HELP }, HELP); break;
  case 'start': start(); break;
  case 'stop': stop(); break;
  case 'status': need(function (s) { out(s, statusText); }); break;
  case 'url': need(function (s) { out({ urls: s.urls, pairing: s.pairing }, function () { return urlText(s); }); }); break;
  case 'pair': api('POST', 'pair', {}, function (e, j) { if (e) fail('deck arrêté'); out(j, '🔑 Nouveau code d\'association : ' + j.code.code + ' (valable 10 minutes)\n   À saisir uniquement sur la page https du deck (cadenas). ./deck url donne l\'empreinte du certificat à comparer.'); }); break;
  case 'doctor': doctor(); break;
  case 'pages': api('GET', 'config', null, function (e, j) { if (e || !j) fail('deck arrêté (./deck start)', 3); const pages = j.config.layout.pages.map(function (p) { return { id: p.id, title: p.title, widgets: p.widgets.length, home: p.id === j.config.layout.home }; }); out(pages, function () { return pages.map(function (p) { return (p.home ? '⌂ ' : '  ') + p.id.padEnd(16) + p.title + ' (' + p.widgets + ' widgets)'; }).join('\n'); }); }); break;
  case 'show': show(); break;
  case 'actions': api('GET', 'config', null, function (e, j) { if (e || !j) fail('deck arrêté (./deck start)', 3); const a = j.config.actions.actions.map(function (x) { return { id: x.id, type: x.type, label: x.label }; }); out(a, function () { return a.map(function (x) { return x.id.padEnd(24) + x.type.padEnd(18) + x.label; }).join('\n'); }); }); break;
  case 'run': if (!sub) fail('usage : ./deck run <action>'); api('POST', 'run', { action: sub, pressId: 'cli' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) }, function (e, j) { if (e) fail('deck arrêté'); if (!j.ok) fail(j.error, 1, j); out(j, '✓ ' + (j.message || 'action exécutée')); }); break;
  case 'button': if (sub !== 'add') fail('usage : ./deck button add --page <page> --label <texte> --action <action>');
    api('POST', 'button', { page: opt('page'), label: opt('label'), action: opt('action'), w: Number(opt('w', 3)), h: Number(opt('h', 1)) }, function (e, j) { if (e) fail('deck arrêté'); if (!j.ok) fail((j.errors || []).join(' ; '), 1, j); out(j, '✓ Bouton « ' + opt('label') + ' » ajouté sur « ' + opt('page') + ' » (' + j.widget + ', colonne ' + j.position.x + ', ligne ' + j.position.y + ') — visible sur l\'iPad sans intervention'); }); break;
  case 'reload': api('POST', 'reload', {}, function (e, j) { if (e) fail('deck arrêté'); if (!j.ok) fail('configuration refusée :\n - ' + j.errors.join('\n - '), 1, j); out(j, '✓ Configuration rechargée (version ' + j.version + ')'); }); break;
  case 'restore': api('POST', 'restore', { name: sub }, function (e, j) { if (e) fail('deck arrêté'); if (!j.ok) fail((j.errors || []).join(' ; '), 1, j); out(j, '✓ Configuration restaurée depuis ' + j.restored); }); break;
  case 'logs': { const n = Number(opt('n', pos[1] === '-n' ? pos[2] : 50)) || 50; const f = path.join(U.DATA, 'logs', 'deck.log'); let lines = []; try { lines = fs.readFileSync(f, 'utf8').trim().split('\n').slice(-n); } catch (e) { /* */ } out({ lines: lines }, lines.join('\n') || '(journal vide)'); break; }
  case 'devices': api('GET', 'devices', null, function (e, j) { if (e) fail('deck arrêté'); out(j, function () { return j.devices.length ? j.devices.map(function (d) { return (d.revoked ? '✕ ' : (j.waiting.indexOf(d.id) >= 0 ? '● ' : '○ ')) + d.id + '  ' + d.name + '  dernier contact : ' + t(d.lastSeen) + (d.lastPage ? '  page : ' + d.lastPage : '') + (d.revoked ? '  (révoqué)' : '') + (d.pairedSecure ? '' : '  (associé sans chiffrement)'); }).join('\n') : 'Aucun appareil associé. Code : ./deck url'; }); }); break;
  case 'revoke': if (!sub) fail('usage : ./deck revoke <appareil>'); api('POST', 'revoke', { device: sub }, function (e, j) { if (e) fail('deck arrêté'); if (!j.ok) fail(j.error, 1, j); out(j, '✓ Appareil révoqué : ' + j.device.name + ' (' + j.device.id + ')'); }); break;
  case 'media':
    if (sub === 'stop') api('POST', 'media/stop', {}, function (e, j) { if (e) fail('deck arrêté'); out(j, '■ ' + j.message); });
    else api('GET', 'media', null, function (e, j) { if (e) fail('deck arrêté'); out(j, mediaText); });
    break;
  case 'admin': api('POST', 'login-link', {}, function (e, j) {   // lien à usage unique (60 s) : le navigateur reçoit le jeton en cookie
    if (e || !j || !j.ok) fail('deck arrêté ou jeton d\'administration illisible (./deck start)', 3);
    cp.execFile('/usr/bin/open', [j.url]); out({ ok: true }, 'Éditeur ouvert dans le navigateur (lien à usage unique)');
  }); break;
  case 'autostart': autostart(sub); break;
  default: fail('commande inconnue « ' + cmd + ' ». ./deck help');
}

function start() {
  const pid = pidAlive();
  if (pid) return need(function (s) { out(s, '✓ Le deck tourne déjà (pid ' + pid + ').\n' + urlText(s)); });
  U.ensureDir(path.join(U.DATA, 'logs'));
  const logFd = fs.openSync(path.join(U.DATA, 'logs', 'server.out'), 'a', 0o600);
  const child = cp.spawn(process.execPath, [path.join(U.ROOT, 'server.js')], { detached: true, stdio: ['ignore', logFd, logFd], cwd: U.ROOT, env: process.env });
  fs.writeFileSync(PID_FILE, String(child.pid), { mode: 0o600 });
  child.unref();
  let tries = 0;
  (function wait() {
    api('GET', 'status', null, function (e, s) {
      if (!e && s) return out(s, '✓ Deck démarré (pid ' + child.pid + ').\n' + urlText(s));
      if (++tries > 40) fail('le serveur ne répond pas : voir ./deck logs et data/logs/server.out');
      setTimeout(wait, 250);
    }, 2000);
  })();
}
function stop() {
  const pid = pidAlive();
  if (!pid) return out({ ok: true, running: false }, 'Le deck est déjà arrêté.');
  process.kill(pid, 'SIGTERM');
  let n = 0;
  (function wait() { try { process.kill(pid, 0); if (++n > 40) { process.kill(pid, 'SIGKILL'); } setTimeout(wait, 150); } catch (e) { try { fs.unlinkSync(PID_FILE); } catch (x) { /* */ } out({ ok: true, stopped: pid }, '■ Deck arrêté (micro et caméra libérés).'); } })();
}

function urlText(s) {
  return '  iPad (chiffré, recommandé) : ' + s.urls.ipadHttps + (s.urls.ipadHttpsIp ? '\n  iPad (par IP)              : ' + s.urls.ipadHttpsIp : '') +
    '\n  Installer le certificat    : ' + s.urls.setup + '   (à ouvrir d\'abord, en http)' +
    '\n  Éditeur (Mac uniquement)   : ' + s.urls.admin +
    '\n  🔑 Code d\'association      : ' + (s.pairing.code ? s.pairing.code + '  (expire à ' + new Date(s.pairing.expires).toLocaleTimeString('fr-FR') + ')' : 'association fermée — ./deck pair pour l\'ouvrir 10 minutes') +
    '\n  🔒 Ne saisir le code que sur la page https du deck (cadenas), jamais en http.' +
    (s.tls && s.tls.caFingerprint ? '\n  Empreinte du certificat    : ' + s.tls.caFingerprint + '\n     (à comparer avec celle du profil installé sur la tablette : Réglages > Général > Profils)' : '');
}
function statusText(s) {
  const m = s.metrics || {};
  return '● Deck ' + s.version + ' en marche depuis ' + t(s.startedAt) + ' (pid ' + s.pid + ')' + (s.demo ? '  ⚠ MODE DÉMO' : '') +
    '\n  Mesures : CPU ' + (m.cpu === null || m.cpu === undefined ? '–' : m.cpu.toFixed(0) + ' %') + ', mémoire ' + (m.memUsedGB || 0).toFixed(1) + '/' + (m.memTotalGB || 0).toFixed(0) + ' Go, disque libre ' + (m.diskFreeGB || 0).toFixed(0) + ' Go, volume ' + m.volume + ' %' + (m.muted ? ' (coupé)' : '') + ' — ' + t(m.t) +
    '\n  Services : ' + s.counts.ok + ' disponibles, ' + s.counts.alert + ' en alerte, ' + s.counts.unknown + ' inconnus' +
    '\n  Captures en cours : ' + (s.media.length ? s.media.map(function (a) { return a.kind + ' (' + a.source + ')'; }).join(', ') : 'aucune') +
    '\n  Appareils : ' + (s.devices.length ? s.devices.map(function (d) { return d.name + ' — dernier contact ' + t(d.lastSeen) + (d.lastPage ? ', page ' + d.lastPage : ''); }).join(' ; ') : 'aucun (./deck pair)') +
    '\n  HTTPS : ' + (s.tls && s.tls.ok ? 'actif' : 'INDISPONIBLE ' + (s.tls && s.tls.error || '')) + '\n' + urlText(s);
}
function mediaText(j) {
  if (!j.active.length) return '🔒 Aucune capture en cours. Dossier des captures : ' + j.capturesDir;
  return j.active.map(function (a) { return '● ' + a.kind + ' — ' + a.source + ' — depuis ' + Math.round((Date.now() - a.startedAt) / 1000) + ' s (max ' + a.maxSec + ' s) — ' + (a.recording ? 'fichier : ' + a.file : 'aucun fichier') + ' — ' + a.transmission; }).join('\n') + '\n  Arrêt immédiat : ./deck media stop';
}
function show() {
  const page = pos[1];
  if (!page) fail('usage : ./deck show <page>   (./deck pages pour la liste)');
  const wait = Number(opt('wait', 8000));
  api('POST', 'command', { type: 'show', page: page, wait: wait }, function (e, j, code) {
    if (e) fail('deck arrêté (./deck start)', 3);
    if (!j.ok) fail(j.error + (j.pages ? ' — pages : ' + j.pages.join(', ') : ''), 1, j);
    const c = j.command;
    const doneAck = c.acks.find(function (a) { return a.done && !a.error; });
    const errAck = c.acks.find(function (a) { return a.error; });
    const delivered = c.acks.find(function (a) { return a.delivered; });
    const res = Object.assign({ ok: !!doneAck, stages: { created: true, delivered: !!delivered, displayed: !!doneAck } }, j);
    out(res, function () {
      let s = '✓ Commande créée (' + c.id + ')';
      s += '\n' + (delivered ? '✓ Reçue par : ' + c.acks.filter(function (a) { return a.delivered; }).map(function (a) { return a.device; }).join(', ') : '✗ Aucun appareil ne l\'a reçue dans le délai (' + wait / 1000 + ' s)');
      s += '\n' + (doneAck ? '✓ ' + doneAck.info + ' sur ' + doneAck.device : errAck ? '✗ Erreur sur ' + errAck.device + ' : ' + errAck.error : '✗ Page non confirmée');
      if (!doneAck) s += '\n  Dernier contact connu : ' + (c.lastContact.length ? c.lastContact.map(function (d) { return d.device + ' — ' + t(d.lastSeen) + (d.lastPage ? ' (page ' + d.lastPage + ')' : ''); }).join(' ; ') : 'aucun appareil associé') + '\n  L\'iPad dort ou est hors ligne ? La commande reste valable 30 s puis expire (jamais rejouée ensuite).';
      return s;
    });
    if (!doneAck) process.exitCode = 2;
  }, wait + 5000);
}

function check(label, ok, detail, hint) { return { label: label, ok: !!ok, detail: detail || '', hint: ok ? '' : (hint || '') }; }
function doctor() {
  const r = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  r.push(check('Node.js ≥ 20', nodeMajor >= 20, process.version));
  const ff = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(function (p) { return fs.existsSync(p); });
  r.push(check('ffmpeg (micro et caméra du Mac)', ff, ff, 'brew install ffmpeg'));
  const ossl = ['/opt/homebrew/bin/openssl', '/usr/bin/openssl'].find(function (p) { return fs.existsSync(p); });
  r.push(check('openssl (certificat local)', ossl, ossl));
  const caF = path.join(U.DATA, 'tls', 'ca.crt');
  let fp = null; try { fp = cp.execFileSync(ossl, ['x509', '-in', caF, '-noout', '-fingerprint', '-sha256'], { encoding: 'utf8' }).trim().replace(/^.*=/, ''); } catch (e) { /* */ }
  r.push(check('Autorité de certification du deck', fp, fp ? 'empreinte SHA-256 ' + fp : '', 'créée au premier ./deck start'));
  const lan = U.lanAddresses();
  r.push(check('Adresse réseau local', lan.length, lan.map(function (a) { return a.iface + ' ' + a.address; }).join(', ') + ' — nom Bonjour ' + U.localHostName() + '.local', 'Mac non connecté au Wi-Fi/Ethernet'));
  let cfgOk = true, errs = [];
  try { const cfg = require('./lib/config'); const b = {}; cfg.FILES.forEach(function (f) { b[f] = U.readJSON(path.join(U.CONFIG_DIR, f + '.json')); }); errs = cfg.validate(b); cfgOk = !errs.length; } catch (e) { cfgOk = false; errs = [e.message]; }
  r.push(check('Configuration valide', cfgOk, cfgOk ? 'config/*.json' : errs.slice(0, 5).join(' ; ')));
  const conn = U.readJSON(path.join(U.CONFIG_DIR, 'connectors.json'), {});
  const tr = conn.transcription || {};
  const wb = U.expandHome(tr.bin || '');
  r.push(check('Transcription locale (Whisper)', wb && fs.existsSync(wb), wb, 'pip3 install --user openai-whisper (ou retirer la dictée)'));
  r.push(check('Modèle Whisper en cache', fs.existsSync(path.join(os.homedir(), '.cache/whisper', (tr.model || 'small') + '.pt')), (tr.model || 'small') + '.pt', 'téléchargé au premier usage (Internet nécessaire une fois)'));
  const finish = function (ollama, devicesTxt, running) {
    r.push(check('Périphériques AV détectés', devicesTxt, devicesTxt, 'ffmpeg -f avfoundation -list_devices true -i ""'));
    r.push(check('Serveur du deck', running, running ? 'en marche' : 'arrêté', './deck start'));
    r.push({ label: 'Permissions macOS micro/caméra', ok: null, detail: 'Accordées à l\'application qui lance le deck (Terminal, iTerm ou node via launchd). Réglages Système > Confidentialité et sécurité > Microphone / Caméra. Vérifiable seulement à la première capture : macOS affiche alors la demande.' });
    out({ ok: r.every(function (x) { return x.ok !== false || /native/i.test(x.label); }), checks: r }, function () { return r.map(function (x) { return (x.ok === null ? 'ℹ ' : x.ok ? '✓ ' : '✗ ') + x.label + (x.detail ? ' — ' + x.detail : '') + (x.hint ? '\n    → ' + x.hint : ''); }).join('\n'); });
  };
  http.get({ host: '127.0.0.1', port: 11434, path: '/api/tags', timeout: 3000 }, function (res) {
    let s = ''; res.on('data', function (c) { s += c; }); res.on('end', function () {
      let models = []; try { models = JSON.parse(s).models.map(function (m) { return m.name; }); } catch (e) { /* */ }
      const has = models.length > 0;
      next(has ? 'présent' : null);
    });
  }).on('error', function () { next(null); });
  function next(ollama) {
    cp.execFile(ff || 'ffmpeg', ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { timeout: 10000 }, function (e, so, se) {
      const v = (String(se).match(/\[\d+\] (?!Capture screen).+/g) || []).length;
      api('GET', 'status', null, function (err, s) { finish(ollama, v ? v + ' périphériques (caméras + micros, écrans exclus)' : null, !err && !!s); }, 2000);
    });
  }
}

function autostart(what) {
  if (what !== 'enable' && what !== 'disable') fail('usage : ./deck autostart enable|disable --confirme');
  if (pos.indexOf('--confirme') < 0) {
    fail('Action protégée (LaunchAgent com.cmultimedia.deck, démarrage automatique). Relance avec --confirme si le propriétaire du Mac le souhaite :\n  ./deck autostart ' + what + ' --confirme\n  Fichier concerné : ' + PLIST, 4);
  }
  if (what === 'enable') {
    // Lancement via Terminal : sous launchd, macOS (TCC) interdit la lecture de ~/Documents à node.
    // Terminal a déjà ce droit ; le LaunchAgent lui demande seulement d'exécuter deck-matin.command.
    const cmdFile = path.join(U.ROOT, 'deck-matin.command');
    fs.writeFileSync(cmdFile, '#!/bin/bash\n# Démarrage du CMULTIMEDIA Deck à l\'ouverture de session (lancé par Terminal).\ncd "' + U.ROOT + '" && ./deck start\nsleep 3\nexit 0\n', { mode: 0o755 });
    const logDir = path.join(os.homedir(), 'Library', 'Logs');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key><array><string>/usr/bin/open</string><string>-g</string><string>-a</string><string>Terminal</string><string>${cmdFile}</string></array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${path.join(logDir, 'cmultimedia-deck-launchd.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(logDir, 'cmultimedia-deck-launchd.log')}</string>
</dict></plist>
`;
    fs.writeFileSync(PLIST, plist, { mode: 0o644 });
    try { cp.execFileSync('/bin/launchctl', ['bootstrap', 'gui/' + process.getuid(), PLIST]); } catch (e) { fail('launchctl : ' + e.message); }
    out({ ok: true, plist: PLIST }, '✓ Démarrage automatique activé (' + PLIST + ') : à chaque ouverture de session, Terminal lance ./deck start. Aucune capture n\'est jamais relancée.');
  } else {
    try { cp.execFileSync('/bin/launchctl', ['bootout', 'gui/' + process.getuid() + '/' + PLIST_LABEL]); } catch (e) { /* déjà déchargé */ }
    if (fs.existsSync(PLIST)) fs.renameSync(PLIST, path.join(U.DATA, PLIST_LABEL + '.plist.desactive'));
    out({ ok: true }, '✓ Démarrage automatique désactivé (fichier déplacé dans data/, pas supprimé).');
  }
}
