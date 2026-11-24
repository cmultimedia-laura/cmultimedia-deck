'use strict';
// Tests automatisés du deck. Sources SIMULÉES et isolées : dossier de données temporaire, faux ffmpeg,
// aucune vraie capture micro/caméra, aucune application ouverte, aucun appel réseau extérieur.
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-test-'));
process.env.DECK_DATA_DIR = path.join(TMP, 'data');
process.env.DECK_CONFIG_DIR = path.join(TMP, 'config');
fs.mkdirSync(process.env.DECK_CONFIG_DIR, { recursive: true });
['settings', 'actions', 'connectors', 'layout'].forEach((f) => fs.copyFileSync(path.join(ROOT, fs.existsSync(path.join(ROOT, 'config', 'settings.json')) ? 'config' : 'config.example', f + '.json'), path.join(process.env.DECK_CONFIG_DIR, f + '.json')));

const U = require('../lib/util');
const config = require('../lib/config');
const devices = require('../lib/devices');
const bus = require('../lib/bus');
const actions = require('../lib/actions');
const media = require('../lib/media');
const monitors = require('../lib/monitors');
const metrics = require('../lib/metrics');

const clone = (o) => JSON.parse(JSON.stringify(o));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ configuration
test('configuration livrée valide', () => {
  const r = config.load();
  assert.ok(r.ok, 'la configuration par défaut doit être valide');
  assert.deepStrictEqual(config.validate(config.get()), []);
});

test('configuration d\'exemple (installation neuve) valide et sans adresse interne', () => {
  const ex = path.join(__dirname, '..', 'config.example'), b = {};
  config.FILES.forEach(function (f) { b[f] = JSON.parse(fs.readFileSync(path.join(ex, f + '.json'), 'utf8')); });
  assert.deepStrictEqual(config.validate(b), []);
  const all = fs.readdirSync(ex).map(function (f) { return fs.readFileSync(path.join(ex, f), 'utf8'); }).join('\n');
  assert.ok(!/\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|\.ts\.net|ubuntu@/.test(all), 'aucune adresse Tailscale ni accès SSH dans l\'exemple');
});
test('validation : chevauchement, action inconnue, URL invalide, séquence imbriquée refusés', () => {
  const b = clone(config.get());
  b.layout.pages[0].widgets.push({ id: 'chevauche', type: 'button', x: 0, y: 0, w: 2, h: 1, label: 'x', action: 'go-accueil' });
  b.layout.pages[0].widgets.push({ id: 'fantome', type: 'button', x: 0, y: 7, w: 1, h: 1, label: 'x', action: 'action-inexistante' });
  b.actions.actions.push({ id: 'mauvaise-url', label: 'x', type: 'open_url', params: { url: 'file:///etc/passwd' } });
  b.actions.actions.push({ id: 'imbrique', label: 'x', type: 'sequence', params: { steps: ['demarrer-journee'] } });
  b.actions.folders.dehors = '/etc';
  const errs = config.validate(b).join('\n');
  assert.match(errs, /chevauche/); assert.match(errs, /action inconnue/); assert.match(errs, /URL http\(s\) invalide/);
  assert.match(errs, /séquence ne peut pas contenir/); assert.match(errs, /sous le dossier personnel/);
});

test('enregistrement avec sauvegarde puis restauration de la configuration', () => {
  const before = clone(config.get());
  const b = clone(before);
  b.layout.pages[0].title = 'Accueil modifié';
  const r = config.save(b, 'test');
  assert.ok(r.ok);
  assert.ok(config.listBackups().length >= 1);
  assert.strictEqual(config.get().layout.pages[0].title, 'Accueil modifié');
  const bad = clone(b); bad.layout.home = 'inexistante';
  assert.strictEqual(config.save(bad, 'test').ok, false, 'une configuration invalide n\'est jamais enregistrée');
  const rr = config.restore();
  assert.ok(rr.ok, JSON.stringify(rr));
  assert.strictEqual(config.get().layout.pages[0].title, before.layout.pages[0].title);
});

test('fichier corrompu sur disque : la dernière configuration valide est chargée', () => {
  const f = path.join(process.env.DECK_CONFIG_DIR, 'layout.json');
  const good = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, JSON.stringify({ home: 'x', pages: [] }));
  const r = config.load();
  assert.strictEqual(r.fallback, true);
  assert.ok(config.get().layout.pages.length > 0);
  fs.writeFileSync(f, good); config.load();
});

// ------------------------------------------------------------------ compatibilité Safari iOS 9
test('interface iPad en ES5 strict (aucune syntaxe ou API récente)', () => {
  ['public/app.js', 'public/setup.js'].forEach((f) => {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const forbidden = [[/=>/, 'fonction fléchée'], [/\blet\s/, 'let'], [/\bconst\s/, 'const'], [/`/, 'gabarit'], [/\bclass\s+[A-Z]/, 'class'], [/\basync\b|\bawait\b/, 'async/await'],
      [/\bfetch\(/, 'fetch'], [/\.find\(/, 'Array.find'], [/\.includes\(/, 'includes'], [/Object\.assign/, 'Object.assign'], [/padStart/, 'padStart'], [/\bPromise\b/, 'Promise'],
      [/\.\.\.[a-zA-Z]/, 'décomposition'], [/for\s*\([^)]*\bof\b/, 'for…of'], [/\bIntl\b|toLocale/, 'Intl'], [/serviceWorker/, 'service worker'], [/\bimport\s|\bexport\s/, 'modules']];
    forbidden.forEach(([re, name]) => assert.ok(!re.test(src), f + ' utilise ' + name));
    new Function(fs.readFileSync(path.join(ROOT, f), 'utf8'));   // syntaxe valide
  });
  const css = fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf8');
  assert.ok(!/var\(--|display:\s*grid|@supports/.test(css), 'CSS : pas de variables ni de Grid');
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  assert.ok(!/https?:\/\/(?!www\.w3)/.test(html.replace(/<meta[^>]*>/g, '')), 'aucune ressource externe (CDN)');
  assert.match(html, /apple-mobile-web-app-capable/); assert.match(html, /apple-touch-icon/);
});

// ------------------------------------------------------------------ association
test('chaque type de tuile a son code d\'affichage dans l\'interface iPad', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const missing = config.WIDGET_TYPES.filter((t) => !new RegExp('FACTORIES\\.' + t + '\\s*=').test(src));
  assert.deepStrictEqual(missing, [], 'types sans affichage : ' + missing.join(', '));
  config.get().layout.pages.forEach((p) => p.widgets.forEach((w) => assert.ok(config.WIDGET_TYPES.includes(w.type), w.type)));
});

test('association : code faux, limitation des tentatives, révocation', () => {
  devices.load(); devices._reset();
  assert.strictEqual(devices.pair('123456', 'x', '10.0.0.8', true).ok, false, 'association fermée par défaut');
  const code = devices.newCode().code;
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.strictEqual(devices.pair(wrong, 'x', '10.0.0.9', true).ok, false);
  assert.strictEqual(devices.pair(devices.currentCode().code, 'x', '10.0.0.9', true).status, 429, 'IP bloquée après 5 essais');
  const ok = devices.pair(devices.newCode().code, 'iPad test', '10.0.0.10', true);
  assert.ok(ok.ok); assert.match(ok.token, /^[a-f0-9]{64}$/);
  assert.strictEqual(devices.pair(code, 'y', '10.0.0.11', true).ok, false, 'un code ne sert qu\'une fois');
  assert.strictEqual(devices.currentCode(), null, 'association refermée après usage');
  const dev = devices.authenticate(ok.token, true); assert.ok(dev);
  assert.strictEqual(devices.authenticate(ok.token, false), null, 'jeton https refusé en http');
  const insecure = devices.pair(devices.newCode().code, 'iPad http', '10.0.0.12', false);
  assert.strictEqual(devices.authenticate(insecure.token, true), null, 'jeton obtenu en clair refusé sur le port chiffré');
  assert.ok(!JSON.stringify(devices.list()).includes(ok.token), 'le jeton n\'est jamais exposé');
  const t = devices.ticket(dev.id, 'frame', 60);
  assert.ok(devices.checkTicket(t, 'frame')); assert.strictEqual(devices.checkTicket(t, 'file:cap_0000000000'), null);
  devices.revoke(dev.id);
  assert.strictEqual(devices.authenticate(ok.token, true), null);
  assert.strictEqual(devices.checkTicket(t, 'frame'), null);
});

// ------------------------------------------------------------------ bus et accusés
test('commande : livrée, exécutée une seule fois, jamais rejouée après reconnexion', async () => {
  const c = bus.send('show', { page: 'studio' }, 'all');
  const first = await new Promise((r) => bus.poll('devA', 0, bus.version(), 1000, r));
  assert.strictEqual(first.commands.length, 1);
  // reconnexion avant exécution : redistribuée
  const again = await new Promise((r) => bus.poll('devA', first.seq, bus.version(), 50, r));
  assert.strictEqual(again.commands.length, 1, 'non exécutée -> redistribuée');
  bus.ack('devA', c.id, 'done', 'page affichée');
  const after = await new Promise((r) => bus.poll('devA', 0, bus.version(), 50, r));
  assert.strictEqual(after.commands.length, 0, 'exécutée -> jamais rejouée');
  const rep = await new Promise((r) => bus.waitAck(c.id, 100, r));
  assert.ok(rep.acks.devA.done);
});

test('commande pour un iPad endormi : expire sans être rejouée', async () => {
  const c = bus.send('show', { page: 'mac' }, 'all');
  bus.get(c.id).expiresAt = Date.now() - 1;
  const r = await new Promise((res) => bus.poll('devB', 0, bus.version(), 50, res));
  assert.ok(!r.commands.some((x) => x.id === c.id), 'la commande expirée n\'est pas distribuée');
});

// ------------------------------------------------------------------ actions
test('actions : inconnue refusée, double pression dédoublonnée, échec de séquence localisé', async () => {
  const b = config.get();
  const r1 = await new Promise((r) => actions.execute(b, '; rm -rf /', {}, r));
  assert.strictEqual(r1.ok, false);
  const pid = 'press' + Date.now();
  const a = await new Promise((r) => actions.execute(b, 'ipad-carte', { pressId: pid }, r));
  const a2 = await new Promise((r) => actions.execute(b, 'ipad-carte', { pressId: pid }, r));
  assert.ok(a.ok); assert.strictEqual(a2.duplicate, true);
  const bb = clone(b);
  bb.actions.folders.absent = '~/dossier-qui-n-existe-pas-deck-test';
  bb.actions.actions.push({ id: 'etape-absente', label: 'Dossier absent', type: 'open_folder', params: { folder: 'absent' } });
  bb.actions.actions.push({ id: 'seq-test', label: 'Séquence test', type: 'sequence', params: { steps: ['ipad-carte', 'etape-absente'] } });
  const s = await new Promise((r) => actions.execute(bb, 'seq-test', {}, r));
  assert.strictEqual(s.ok, false); assert.strictEqual(s.failedStep, 2); assert.match(s.error, /étape 2/);
});

// ------------------------------------------------------------------ Studio (faux ffmpeg)
function fakeSpawnFactory(opts) {
  const procs = [];
  const fn = function (bin, args) {
    const p = new EventEmitter();
    p.pid = 999999; p.stdout = new PassThrough(); p.stderr = new PassThrough();
    p.stdin = new PassThrough(); p.args = args; procs.push(p);
    let closed = false;
    const close = (code) => { if (closed) return; closed = true; clearInterval(timer); p.stdout.end(); setImmediate(() => p.emit('close', code)); };
    p.kill = () => close(255);
    p.stdin.on('data', (d) => { if (String(d).includes('q')) { const out = args[args.length - 1]; if (out && out.startsWith('/')) fs.writeFileSync(out, 'faux-audio'); close(0); } });
    let timer = null;
    if (opts.fail) setTimeout(() => { p.stderr.write(opts.fail); close(1); }, 20);
    else timer = setInterval(() => { const b = Buffer.alloc(3200); for (let i = 0; i < 1600; i++) b.writeInt16LE(Math.round(Math.sin(i / 5) * 8000), i * 2); p.stdout.write(b); }, 20);
    return p;
  };
  fn.procs = procs;
  return fn;
}
const FAKE_DEVICES = { video: [{ index: 0, name: 'Caméra simulée', builtin: true, virtual: false }], audio: [{ index: 0, name: 'Micro simulé', builtin: true, virtual: false }] };

test('listing AVFoundation : écrans exclus, virtuels marqués', () => {
  const l = media.parseDeviceList('[AVFoundation indev @ 0x1] AVFoundation video devices:\n[AVFoundation indev @ 0x1] [0] Caméra FaceTime HD\n[AVFoundation indev @ 0x1] [1] OBS Virtual Camera\n[AVFoundation indev @ 0x1] [2] Capture screen 0\n[AVFoundation indev @ 0x1] AVFoundation audio devices:\n[AVFoundation indev @ 0x1] [0] Micro MacBook Pro\n[AVFoundation indev @ 0x1] [1] BlackHole 2ch');
  assert.strictEqual(l.video.length, 2); assert.ok(l.video[1].virtual); assert.ok(l.audio[1].virtual); assert.ok(l.audio[0].builtin);
});

test('micro : le test du niveau ne crée aucun fichier et mesure un niveau réel', async () => {
  let lastSeen = Date.now();
  media.init({ changed() {}, settings: () => ({ maxCaptureSec: 60, disconnectGraceSec: 1 }), lastSeen: () => lastSeen });
  media._setList((cb) => cb(null, FAKE_DEVICES));
  const spawn = fakeSpawnFactory({}); media._setSpawn(spawn);
  const s = await new Promise((r, j) => media.startMic({ device: 'Micro simulé', mode: 'test' }, null, (e, x) => e ? j(e) : r(x)));
  assert.strictEqual(s.recording, false); assert.strictEqual(s.file, null);
  assert.ok(!spawn.procs[0].args.some((a) => /\.m4a$/.test(a)), 'aucune sortie fichier en mode test');
  await wait(150);
  const lv = media.micLevel(); assert.ok(lv && lv.level > 0, 'niveau mesuré');
  media.stopAll('test'); await wait(50);
  assert.strictEqual(media.status().active.length, 0, 'périphérique libéré');
});

test('iPad déconnecté pendant un enregistrement : arrêt automatique, fichier gardé et marqué interrompu', async () => {
  let lastSeen = Date.now();
  media.init({ changed() {}, settings: () => ({ maxCaptureSec: 60, disconnectGraceSec: 1 }), lastSeen: () => lastSeen });
  media._setList((cb) => cb(null, FAKE_DEVICES)); media._setSpawn(fakeSpawnFactory({}));
  await new Promise((r, j) => media.startMic({ device: 'Micro simulé', mode: 'record' }, 'dev_ipad', (e, x) => e ? j(e) : r(x)));
  lastSeen = Date.now() - 5000;          // l'iPad ne donne plus signe de vie
  media.tick(); await wait(100);
  assert.strictEqual(media.status().active.length, 0);
  assert.match(media.status().lastEnded.mic.reason, /iPad déconnecté/);
  const cap = media.listCaptures(1)[0];
  assert.strictEqual(cap.status, 'interrompu'); assert.ok(fs.existsSync(cap.file));
});

test('micro refusé par macOS et caméra occupée : messages explicites', async () => {
  media.init({ changed() {}, settings: () => ({ maxCaptureSec: 60, disconnectGraceSec: 20 }), lastSeen: () => Date.now() });
  media._setList((cb) => cb(null, FAKE_DEVICES));
  media._setSpawn(fakeSpawnFactory({ fail: 'Failed to create AV capture input device: not authorized to capture audio' }));
  await new Promise((r) => media.startMic({ device: 'Micro simulé', mode: 'test' }, null, r));
  await wait(120);
  assert.match(media.status().lastEnded.mic.error, /Autorisation refusée par macOS/);
  media._setSpawn(fakeSpawnFactory({ fail: 'Could not lock device for configuration: device is in use by another application' }));
  await new Promise((r) => media.startCameraPreview({ device: 'Caméra simulée' }, null, r));
  await wait(120);
  assert.match(media.status().lastEnded.cam.error, /déjà utilisé/);
  const busy = await new Promise((r) => media.startMic({ device: 'Micro inconnu', mode: 'test' }, null, (e) => r(e)));
  assert.match(busy.message, /introuvable/);
});

test('EXIF piégé (IFD en boucle et imbriqués) : analyse bornée en quelques millisecondes', () => {
  // JPEG minimal : APP1 Exif, IFD0 de 300 entrées pointant toutes vers l'IFD0 lui-même (0x8769)
  const n = 300, tiff = Buffer.alloc(8 + 2 + n * 12 + 4);
  tiff.write('II', 0); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4); tiff.writeUInt16LE(n, 8);
  for (let i = 0; i < n; i++) { const e = 10 + i * 12; tiff.writeUInt16LE(0x8769, e); tiff.writeUInt16LE(4, e + 2); tiff.writeUInt32LE(1, e + 4); tiff.writeUInt32LE(8, e + 8); }
  const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const len = Buffer.alloc(2); len.writeUInt16BE(app1.length + 2);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), len, app1, Buffer.from([0xff, 0xd9])]);
  const t0 = Date.now(); media.lensFromExif(jpg);
  assert.ok(Date.now() - t0 < 50, 'analyse en ' + (Date.now() - t0) + ' ms');
});

test('EXIF : caméra avant/arrière de l\'iPad reconnue', () => {
  assert.strictEqual(media.ipadCameraLabel('iPad 2 back camera 4.28mm f/2.4'), 'Caméra arrière de l\'iPad');
  assert.strictEqual(media.ipadCameraLabel('iPad 2 front camera'), 'Caméra avant de l\'iPad');
  assert.match(media.ipadCameraLabel(''), /non indiqué/);
});

// ------------------------------------------------------------------ surveillance
test('service inaccessible : alerte avec erreur lisible et trou dans la courbe', async () => {
  const b = clone(config.get());
  b.connectors.monitors = [{ id: 'ferme', label: 'Port fermé', url: 'http://127.0.0.1:9/', timeoutMs: 2000 }];
  config.save(b, 'test surveillance');
  monitors.start(config.get); monitors.stop();
  monitors.runAll(); await wait(600);
  const s = monitors.snapshot().find((x) => x.id === 'ferme');
  assert.strictEqual(s.effective, 'alert'); assert.ok(s.error);
  const pts = metrics.history('svc:ferme', 600);
  assert.strictEqual(pts[pts.length - 1][1], null, 'absence de mesure = trou');
  config.restore();
});

// ------------------------------------------------------------------ serveur HTTP : accès et protections
test('serveur : https obligatoire hors aperçu, association chiffrée, CSRF, jeton d\'administration', async () => {
  config.load(); devices.load(); devices._reset(); devices.newCode();
  const server = require('../server');
  const ADM = server.adminToken();
  // router(true) sur un serveur http simule le port chiffré (le drapeau secure est celui du routeur)
  const mk = async (secure) => { const s = http.createServer(server.router(secure)); await new Promise((r) => s.listen(0, '127.0.0.1', r)); return s; };
  const plain = await mk(false), sec = await mk(true);
  const call = (srv, method, p, headers = {}, body) => new Promise((r) => {
    const port = srv.address().port;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: Object.assign({ Host: '127.0.0.1:' + port }, headers) }, (res) => { let s = ''; res.on('data', (c) => s += c); res.on('end', () => { let b = null; try { b = JSON.parse(s); } catch (e) { b = s; } r({ code: res.statusCode, body: b, headers: res.headers }); }); });
    if (body) req.write(JSON.stringify(body)); req.end();
  });
  // En clair : rien d'autre que ping, association comprise
  assert.strictEqual((await call(plain, 'GET', '/api/ping')).code, 200);
  const hp = await call(plain, 'POST', '/api/pair', { 'X-Deck': '1', 'Content-Type': 'application/json' }, { code: devices.currentCode().code, name: 'http' });
  assert.strictEqual(hp.code, 403, 'association refusée en http'); assert.ok(hp.body.secureRequired);
  assert.strictEqual((await call(plain, 'GET', '/api/bootstrap')).code, 403);
  // Aperçu : l'en-tête seul ne donne plus rien, il faut le jeton d'administration
  assert.strictEqual((await call(plain, 'GET', '/api/journal', { 'X-Deck-Preview': '1' })).code, 403, 'aperçu sans jeton refusé');
  assert.strictEqual((await call(plain, 'GET', '/api/bootstrap', { 'X-Deck-Preview': '1', 'X-Deck-Admin': 'faux' })).code, 403);
  assert.strictEqual((await call(plain, 'GET', '/api/bootstrap', { 'X-Deck-Preview': '1', 'X-Deck-Admin': ADM })).code, 200, 'aperçu avec jeton');
  assert.strictEqual((await call(plain, 'GET', '/api/bootstrap', { 'X-Deck-Preview': '1', Cookie: 'deck_admin_' + config.get().settings.portHttp + '=' + ADM })).code, 403, 'le jeton du fichier n\'est jamais accepté en cookie');
  assert.strictEqual((await call(plain, 'GET', '/api/music/artwork')).code, 403, 'pochette sans ticket refusée');
  assert.strictEqual((await call(sec, 'GET', '/api/music/artwork')).code, 401, 'pochette sans ticket refusée (https)');
  // Port chiffré
  assert.strictEqual((await call(sec, 'GET', '/api/bootstrap')).code, 401);
  assert.strictEqual((await call(sec, 'POST', '/api/pair', {}, { code: '123456' })).code, 403, 'sans X-Deck');
  assert.strictEqual((await call(sec, 'POST', '/api/pair', { 'X-Deck': '1', Origin: 'http://malveillant.example' }, { code: '123456' })).code, 403, 'origine étrangère');
  const p = await call(sec, 'POST', '/api/pair', { 'X-Deck': '1', 'Content-Type': 'application/json' }, { code: devices.currentCode().code, name: 'test' });
  assert.strictEqual(p.code, 200, JSON.stringify(p.body));
  const T = { 'X-Deck-Token': p.body.token, 'X-Deck': '1' };
  assert.strictEqual((await call(sec, 'GET', '/api/bootstrap', T)).code, 200);
  assert.strictEqual((await call(plain, 'GET', '/api/bootstrap', T)).code, 403, 'jeton chiffré inutilisable en clair');
  const shell = await call(sec, 'POST', '/api/action', T, { id: 'open -a Calculator', pressId: 'pressSHELL01' });
  assert.strictEqual(shell.body.ok, false, 'aucune commande libre');
  assert.strictEqual((await call(sec, 'GET', '/api/bootstrap', Object.assign({}, T, { Host: 'rebinding.evil.example' }))).code, 403, 'hôte étranger refusé');
  assert.strictEqual((await call(sec, 'POST', '/api/media/stop', T, {})).code, 200, 'arrêt des captures permis');
  // Administration : loopback ET jeton
  assert.strictEqual((await call(plain, 'GET', '/admin/api/status', { 'X-Deck': '1' })).code, 401, 'admin sans jeton refusée');
  const A = { 'X-Deck': '1', 'X-Deck-Admin': ADM };
  assert.strictEqual((await call(plain, 'GET', '/admin/api/status', A)).code, 200);
  assert.strictEqual((await call(plain, 'GET', '/admin/api/status', Object.assign({}, A, { Host: 'deck.evil.example' }))).code, 403, 'anti DNS rebinding');
  assert.strictEqual((await call(plain, 'GET', '/admin/api/config', Object.assign({}, A, { Origin: 'https://evil.example' }))).code, 403);
  assert.strictEqual((await call(plain, 'GET', '/admin/')).code, 401, 'éditeur verrouillé sans jeton');
  const link = await call(plain, 'POST', '/admin/api/login-link', A, {});
  const n = new URL(link.body.url).search;
  const open1 = await call(plain, 'GET', '/admin/' + n);
  assert.strictEqual(open1.code, 302); assert.ok(/HttpOnly; SameSite=Strict/.test(open1.headers['set-cookie'][0]));
  const ck = /(deck_admin_\d+)=([a-f0-9]+)/.exec(open1.headers['set-cookie'][0]); const CK = ck[1], sess = ck[2];
  assert.notStrictEqual(sess, ADM, 'cookie = session distincte du jeton');
  assert.strictEqual((await call(plain, 'GET', '/api/bootstrap', { 'X-Deck-Preview': '1', Cookie: CK + '=' + sess })).code, 200, 'aperçu avec la session');
  assert.strictEqual((await call(plain, 'GET', '/admin/', { Cookie: CK + '=' + sess })).code, 200, 'éditeur ouvert avec la session');
  assert.strictEqual((await call(plain, 'GET', '/admin/' + n)).code, 403, 'lien à usage unique');
  const add = await call(plain, 'POST', '/admin/api/button', Object.assign({ 'Content-Type': 'application/json' }, A), { page: 'commandes', label: 'Test CLI', action: 'go-accueil' });
  assert.ok(add.body.ok, JSON.stringify(add.body));
  // État sans chiffrement : aucun titre de ticket ni session
  const st = server.stateFor(false);
  assert.strictEqual(st.claude, null); assert.strictEqual(st.codex, null);
  const log = fs.readFileSync(path.join(process.env.DECK_DATA_DIR, 'logs', 'deck.log'), 'utf8');
  assert.ok(!log.includes(p.body.token) && !log.includes(ADM), 'aucun jeton dans le journal technique');
  plain.close(); sec.close();
});

test('archive d\'installation : extraction sans erreur, README public, aucune donnée privée', () => {
  const cp = require('child_process'), os = require('os');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-pkg-'));
  cp.execFileSync('/bin/bash', [path.join(__dirname, '..', 'tools', 'package.sh'), '--sortie', out], { stdio: 'pipe' });
  const arch = fs.readdirSync(out).find((f) => f.endsWith('.tar.gz'));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-x-'));
  const r = cp.spawnSync('/usr/bin/tar', ['-xzf', path.join(out, arch), '-C', dest], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0); assert.strictEqual(r.stderr, '', 'extraction sans message d\'erreur');
  const root = path.join(dest, 'cmultimedia-deck');
  assert.ok(fs.existsSync(path.join(root, 'README.md')) && fs.existsSync(path.join(root, 'tests', 'smoke-test.sh')) && fs.existsSync(path.join(root, 'install.sh')));
  ['data', 'config', 'remote', 'native-ipad'].forEach((x) => assert.ok(!fs.existsSync(path.join(root, x)), x + ' ne doit pas être livré'));
  assert.ok(!/Règle 9|miss-secu/.test(fs.readFileSync(path.join(root, 'README.md'), 'utf8')), 'README public');
});

test('alertes : « J\'ai vu » refusé pour une alerte inconnue (fichier borné)', () => {
  const alerts = require('../lib/alerts');
  assert.strictEqual(alerts.ack('inexistante-' + 'x'.repeat(50)), false);
});

test('alertes : panne signalée, « J\'ai vu », alerte retirée une fois réglée', () => {
  const alerts = require('../lib/alerts');
  const st = { services: [{ id: 'x', label: 'Site X', status: 'alert', error: 'délai dépassé', since: Date.now() }], metrics: { memPct: 50, diskFreeGB: 200 } };
  assert.ok(alerts.compute(st).some((x) => x.id === 'svc:x' && x.level === 'critique'));
  assert.ok(alerts.ack('svc:x'));
  assert.ok(alerts.compute(st).find((x) => x.id === 'svc:x').acked);
  st.services = [];
  assert.ok(!alerts.compute(st).some((x) => x.id === 'svc:x'), 'problème résolu : alerte retirée');
});

test.after(() => { media.stopAll('fin des tests'); metrics.stop(); monitors.stop(); setTimeout(() => process.exit(process.exitCode || 0), 2000).unref(); });
