/* CMULTIMEDIA Deck — interface tablette. JavaScript ES5 pour Safari iOS 9.3.5 :
   XMLHttpRequest, Canvas 2D, aucune dépendance, aucun module, ni fetch, ni Promise, ni Intl. */
(function () {
  'use strict';

  // ------------------------------------------------------------------ utilitaires
  var D = document, W = window;
  function $(id) { return D.getElementById(id); }
  function el(tag, cls, text, parent) {
    var e = D.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    if (parent) parent.appendChild(e);
    return e;
  }
  function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); }
  function find(arr, fn) { for (var i = 0; i < (arr || []).length; i++) if (fn(arr[i])) return arr[i]; return null; }
  function extend(a, b) { for (var k in b) if (b.hasOwnProperty(k)) a[k] = b[k]; return a; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function hhmm(t) { var d = new Date(t); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function hhmmss(t) { var d = new Date(t); return hhmm(t) + ':' + pad2(d.getSeconds()); }
  function dateFr(t) { var d = new Date(t); return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + ' ' + hhmm(t); }
  function num(v, dec) { if (v === null || v === undefined || isNaN(v)) return '–'; return Number(v).toFixed(dec || 0).replace('.', ','); }
  function ago(t) { if (!t) return 'jamais'; var s = Math.round((Date.now() - t) / 1000); if (s < 60) return 'il y a ' + s + ' s'; if (s < 3600) return 'il y a ' + Math.round(s / 60) + ' min'; return 'le ' + dateFr(t); }
  function dur(sec) { sec = Math.max(0, Math.floor(sec)); return pad2(Math.floor(sec / 60)) + ':' + pad2(sec % 60); }
  function rid() { var s = ''; for (var i = 0; i < 20; i++) s += 'abcdefghijklmnopqrstuvwxyz0123456789'.charAt(Math.floor(Math.random() * 36)); return s; }
  function store(k, v) { try { if (v === undefined) return W.localStorage.getItem(k); if (v === null) W.localStorage.removeItem(k); else W.localStorage.setItem(k, v); } catch (e) { return null; } return null; }
  // iPad 2 (iOS 9, écran non Retina) : effets graphiques allégés pour rester fluide
  var LOWFX = /OS [5-9]_/.test(navigator.userAgent) || (W.devicePixelRatio || 1) < 2 && /iPad|iPhone/.test(navigator.userAgent);
  var raf = W.requestAnimationFrame || W.webkitRequestAnimationFrame || function (f) { return setTimeout(function () { f(Date.now()); }, 33); };
  function now() { return Date.now(); }

  // ------------------------------------------------------------------ réseau
  var token = store('deckToken');
  var preview = /[?&]preview=1/.test(W.location.search);
  var secure = W.location.protocol === 'https:';

  function xhr(method, url, body, cb, opts) {
    opts = opts || {};
    var x = new XMLHttpRequest();
    x.open(method, url, true);
    x.timeout = opts.timeout || 20000;
    if (token) x.setRequestHeader('X-Deck-Token', token);
    if (preview) x.setRequestHeader('X-Deck-Preview', '1');
    x.setRequestHeader('X-Deck', '1');
    if (body && !opts.raw) x.setRequestHeader('Content-Type', 'application/json');
    if (opts.raw && opts.type) x.setRequestHeader('Content-Type', opts.type);
    if (opts.progress && x.upload) x.upload.onprogress = function (e) { if (e.lengthComputable) opts.progress(e.loaded / e.total); };
    var done = false;
    function fin(err, data, status) { if (done) return; done = true; cb(err, data, status); }
    x.onreadystatechange = function () {
      if (x.readyState !== 4) return;
      if (x.status === 0) return fin('réseau', null, 0);
      var data = null;
      try { data = JSON.parse(x.responseText); } catch (e) { data = null; }
      if (x.status === 401 && data && data.pair) { forgetToken(); return fin('non associé', data, 401); }
      if (x.status >= 400 && x.status !== 409) return fin((data && data.error) || ('HTTP ' + x.status), data, x.status);
      fin(null, data, x.status);
    };
    x.ontimeout = function () { fin('délai dépassé', null, 0); };
    x.send(opts.raw ? body : (body ? JSON.stringify(body) : null));
    return x;
  }

  // Remontée des erreurs JavaScript de l'iPad dans le journal technique du Mac (diagnostic à distance).
  var errSent = 0;
  function report(msg, where) {
    if (errSent++ > 20) return;
    try { xhr('POST', '/api/clientlog', { msg: String(msg).slice(0, 300), where: String(where || '').slice(0, 200), ua: navigator.userAgent.slice(0, 120) }, function () {}); } catch (e) { /* */ }
  }
  W.onerror = function (msg, src, line, col) { report(msg, (src || '').split('/').pop() + ':' + line + ':' + col); };

  // ------------------------------------------------------------------ état global
  var CFG = null, STATE = null, currentPage = null, widgets = [], lastSeq = Number(store('deckSeq') || 0), stateVer = 0;
  var online = false, lastContact = 0, pollFails = 0;
  var executed = {};
  var series = {};     // cache client des séries (source -> [[t,v]])
  var animMode = 'normal';
  var tickets = {};

  // ------------------------------------------------------------------ toast
  var toastTimer = null;
  function toast(msg, kind) {
    var t = $('toast'); t.textContent = msg; t.className = kind || '';
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.className = 'hidden'; }, kind === 'err' ? 6000 : 3500);
  }

  // ------------------------------------------------------------------ toucher : enfoncement visuel + anti double pression
  function tap(e, fn) {
    var start = 0, moved = false, sx = 0, sy = 0;
    e.addEventListener('touchstart', function (ev) { start = now(); moved = false; sx = ev.touches[0].clientX; sy = ev.touches[0].clientY; e.classList.add('pressed'); }, false);
    e.addEventListener('touchmove', function (ev) { if (Math.abs(ev.touches[0].clientX - sx) > 12 || Math.abs(ev.touches[0].clientY - sy) > 12) { moved = true; e.classList.remove('pressed'); } }, false);
    e.addEventListener('touchend', function (ev) { e.classList.remove('pressed'); if (!moved) { ev.preventDefault(); fire(ev); } }, false);
    e.addEventListener('touchcancel', function () { e.classList.remove('pressed'); }, false);
    e.addEventListener('click', function (ev) { if (now() - start > 800) fire(ev); }, false);  // souris (aperçu sur le Mac)
    var last = 0;
    function fire(ev) { if (now() - last < 400) return; last = now(); if (e.classList.contains('disabled')) return; fn(ev); }
    return e;
  }
  function button(parent, label, cls, fn) { return tap(el('span', 'b ' + (cls || ''), label, parent), fn); }

  // ------------------------------------------------------------------ association
  function forgetToken() { token = null; store('deckToken', null); }
  function showPair(msg) {
    var p = $('pair'); clear(p); p.className = '';
    el('h1', null, 'Associer cet iPad au Mac', p);
    el('p', null, 'Saisis le code à 6 chiffres affiché sur le Mac (commande ./deck url ou éditeur). Le code change toutes les 10 minutes.', p);
    if (W.navigator.standalone === false) el('p', 't-warn', 'Conseil : ajoute d\'abord le deck à l\'écran d\'accueil (bouton Partager > Sur l\'écran d\'accueil), puis associe depuis l\'icône : l\'icône garde sa propre association.', p);
    if (!secure) el('p', 't-warn', 'Connexion non chiffrée : micro, caméra et captures seront bloqués. Installe le certificat (page /setup) puis ouvre l\'adresse https.', p);
    var codeEl = el('div', 'code', '', p);
    var err = el('p', 't-alert', msg || '', p);
    var code = '';
    var keys = el('div', 'keys', null, p);
    function upd() { codeEl.textContent = code + '······'.slice(code.length); }
    upd();
    '123456789C0⌫'.split('').forEach(function (k) {
      button(keys, k === 'C' ? 'Eff.' : k, '', function () {
        if (k === '⌫') code = code.slice(0, -1); else if (k === 'C') code = ''; else if (code.length < 6) code += k;
        upd();
        if (code.length === 6) {
          err.textContent = 'Vérification…';
          xhr('POST', '/api/pair', { code: code, name: 'iPad 2 (' + (W.navigator.standalone ? 'icône' : 'Safari') + ')' }, function (e, d) {
            if (e || !d || !d.ok) { code = ''; upd(); err.textContent = (d && d.error) || e; return; }
            token = d.token; store('deckToken', token);
            p.className = 'hidden'; boot();
          });
        }
      });
    });
  }

  // ------------------------------------------------------------------ démarrage
  function boot() {
    if (!token && !preview) return showPair();
    xhr('GET', '/api/bootstrap', null, function (e, d, status) {
      if (status === 401) return showPair('Cet appareil n\'est plus associé (révoqué ou nouvelle installation).');
      if (e || !d) { setConn(false); setTimeout(boot, 3000); return; }
      CFG = d.config; secure = d.secure || preview;
      // Diagnostic : version réellement chargée par l'appareil (feuille de style, taille appliquée aux emojis)
      try {
        var probe = el('span', 'emokey', 'x', D.body), css = '';
        for (var si = 0; si < D.styleSheets.length; si++) css += (D.styleSheets[si].href || '').split('/').pop() + ' ';
        xhr('POST', '/api/clientlog', { kind: 'boot', msg: 'chargement : ' + css + '| emoji ' + W.getComputedStyle(probe).fontSize + ' | ' + (W.navigator.standalone ? 'icône' : 'Safari'), where: 'boot' }, function () {});
        D.body.removeChild(probe);
      } catch (x) { /* diagnostic facultatif */ }   // l'aperçu de l'éditeur tourne sur le Mac lui-même
      applySettings();
      onState(d.state);
      stateVer = d.v;
      if (!lastSeq || lastSeq > d.seq) lastSeq = d.seq;   // ne rejoue pas l'historique de commandes au premier lancement
      var start = W.location.hash ? W.location.hash.slice(1) : store('deckPage');   // #page dans l'adresse = page de départ
      go(pageExists(start) ? start : CFG.layout.home);
      setConn(true);
      poll();
    });
  }
  function pageExists(id) { return !!(id && CFG && find(CFG.layout.pages, function (p) { return p.id === id; })); }

  function applySettings() {
    var s = CFG.settings;
    animMode = store('deckAnim') || s.animations;
    D.body.className = (W.navigator.standalone ? 'standalone ' : '') + 'anim-' + animMode + (LOWFX ? ' lowfx' : '');
    var sec = $('h-secure');
    var enc = W.location.protocol === 'https:';
    sec.textContent = preview ? 'Aperçu Mac' : enc ? '🔒 Chiffré' : 'Non chiffré';
    sec.className = 'badge ' + (enc || preview ? 'ok' : 'warn');
  }

  // ------------------------------------------------------------------ long polling
  var pollX = null;
  function poll() {
    if (pollX) return;
    pollX = xhr('GET', '/api/poll?seq=' + lastSeq + '&v=' + stateVer + '&page=' + encodeURIComponent(currentPage || ''), null, function (e, d, status) {
      pollX = null;
      if (status === 401) return showPair('Association révoquée depuis le Mac.');
      if (e || !d) { pollFails++; setConn(false); setTimeout(poll, Math.min(5000, 1000 * pollFails)); return; }
      pollFails = 0; setConn(true);
      if (d.superseded) return setTimeout(poll, 500);
      stateVer = d.v;
      (d.commands || []).forEach(function (c) { try { runCommand(c); } catch (x) { report(x.message, 'commande ' + c.type); } });
      try { if (d.state) onState(d.state); } catch (x) { report(x.message, 'onState'); }
      if (d.seq > lastSeq) { lastSeq = d.seq; store('deckSeq', String(lastSeq)); }
      setTimeout(poll, 50);
    }, { timeout: 30000 });
  }
  function setConn(on) {
    var c = $('h-conn');
    if (on) { online = true; lastContact = now(); c.textContent = '● Mac connecté'; c.className = 'conn on'; }
    else { online = false; c.textContent = '○ Mac injoignable' + (lastContact ? ' depuis ' + hhmm(lastContact) : ''); c.className = 'conn off'; }
  }

  // Commandes poussées par Claude Code / Codex (./deck show …) : exécutées une seule fois, puis accusées.
  function runCommand(c) {
    if (executed[c.id]) return ack(c.id, 'done', 'déjà exécutée');
    executed[c.id] = 1;
    if (c.type === 'show') {
      if (!pageExists(c.payload.page)) return ack(c.id, 'error', 'page inconnue');
      go(c.payload.page);
      return ack(c.id, 'done', 'page « ' + c.payload.page + ' » affichée');
    }
    if (c.type === 'reload') { reloadConfig(function () { ack(c.id, 'done', 'configuration rechargée'); }); return; }
    ack(c.id, 'error', 'commande inconnue');
  }
  function ack(id, stage, info) { xhr('POST', '/api/ack', { cmd: id, stage: stage, info: info }, function () {}); }

  function reloadConfig(cb) {
    xhr('GET', '/api/config', null, function (e, d) {
      if (e || !d) return cb && cb();
      CFG = d.config; applySettings();
      go(pageExists(currentPage) ? currentPage : CFG.layout.home, true);
      toast('Configuration mise à jour depuis le Mac');
      if (cb) cb();
    });
  }

  // ------------------------------------------------------------------ état reçu
  var lastCfgVer = null, uiVer = null;
  function onState(s) {
    if (uiVer === null) uiVer = s.ui;
    else if (s.ui && s.ui !== uiVer) { W.location.replace('/?v=' + s.ui + (preview ? '&preview=1' : '') + W.location.hash); return; }   // nouvelle version de l'interface : rechargement automatique
    var prev = STATE; STATE = s;
    if (lastCfgVer !== null && s.configVersion !== lastCfgVer) reloadConfig();
    lastCfgVer = s.configVersion;
    var m = s.metrics;
    if (m && m.t && (!prev || !prev.metrics || prev.metrics.t !== m.t)) {
      appendPoint('cpu', m.t, m.cpu); appendPoint('mem', m.t, m.memUsedGB); appendPoint('disk', m.t, m.diskUsedGB); appendPoint('volume', m.t, m.volume);
    }
    (s.services || []).forEach(function (sv) {
      var old = prev && find(prev.services, function (x) { return x.id === sv.id; });
      if (sv.t && (!old || old.t !== sv.t)) appendPoint('svc:' + sv.id, sv.t, sv.raw === 'ok' ? sv.ms : null);
    });
    $('h-demo').className = s.demo || (m && m.demo) ? 'badge demo' : 'badge demo hidden';
    var me = $('h-measure');
    if (m && m.t) {
      var stale = now() - m.t > (CFG ? CFG.settings.metricsIntervalSec * 3000 : 15000);
      me.textContent = (stale ? '⚠ Mesure périmée ' : 'Mesure ') + hhmmss(m.t); me.className = 'measure' + (stale ? ' stale' : '');
    }
    try { updateAlerts(s); } catch (x) { report(x.message, 'alertes'); }
    try { updateEph(s); } catch (x) { report(x.message, 'éphéméride'); }
    for (var i = 0; i < widgets.length; i++) if (widgets[i].update) { try { widgets[i].update(s, prev); } catch (x) { report(x.message, 'widget ' + (widgets[i].cfg && widgets[i].cfg.type)); } }
  }
  function appendPoint(src, t, v) {
    var s = series[src]; if (!s) return;
    if (s.length && s[s.length - 1][0] >= t) return;
    s.push([t, v === undefined ? null : v]);
    var limit = now() - 3600 * 1000 - 60000;
    while (s.length && s[0][0] < limit) s.shift();
  }
  function loadSeries(src, windowSec, cb) {
    xhr('GET', '/api/history?source=' + encodeURIComponent(src) + '&window=' + windowSec, null, function (e, d) {
      if (e || !d) return cb && cb(null);
      var have = series[src] || [];
      var pts = d.points;
      // fusion : on garde les points plus récents déjà reçus par le poll
      var lastT = pts.length ? pts[pts.length - 1][0] : 0;
      for (var i = 0; i < have.length; i++) if (have[i][0] > lastT) pts.push(have[i]);
      series[src] = pts;
      if (cb) cb(d);
    });
  }

  // ------------------------------------------------------------------ navigation
  function go(pageId, force) {
    if (!pageExists(pageId)) pageId = CFG.layout.home;
    if (pageId === currentPage && !force) return;
    widgets.forEach(function (w) { if (w.destroy) w.destroy(); });
    widgets = [];
    currentPage = pageId; store('deckPage', pageId);
    var page = find(CFG.layout.pages, function (p) { return p.id === pageId; });
    $('h-title').textContent = page.title;
    renderPage(page);
    closeOverlay();
  }

  function geometry() {
    var pg = $('page');
    var Wd = pg.clientWidth, H = pg.clientHeight, gap = 8, pad = 8, cols = 12, rows = 8;
    return { cw: (Wd - pad * 2 - gap * (cols - 1)) / cols, ch: (H - pad * 2 - gap * (rows - 1)) / rows, gap: gap, pad: pad };
  }
  function renderPage(page) {
    var pg = $('page'); clear(pg);
    var g = geometry();
    (page.widgets || []).forEach(function (cfg) {
      var box = el('div', 'w w-' + cfg.type, null, pg);
      var x = g.pad + cfg.x * (g.cw + g.gap), y = g.pad + cfg.y * (g.ch + g.gap);
      var w = cfg.w * g.cw + (cfg.w - 1) * g.gap, h = cfg.h * g.ch + (cfg.h - 1) * g.gap;
      box.style.left = Math.round(x) + 'px'; box.style.top = Math.round(y) + 'px'; box.style.width = Math.round(w) + 'px'; box.style.height = Math.round(h) + 'px';
      var f = FACTORIES[cfg.type];
      if (!f) { el('div', 'w-title', 'Type inconnu : ' + cfg.type, box); return; }
      var inst;
      try { inst = f(box, cfg, Math.round(w), Math.round(h)) || {}; } catch (x) { report(x.message, 'création ' + cfg.type); el('div', 'w-title', cfg.label + ' (erreur)', box); inst = {}; }
      inst.cfg = cfg;
      widgets.push(inst);
      if (inst.update && STATE) inst.update(STATE, null);
    });
  }
  W.addEventListener('orientationchange', function () { setTimeout(function () { if (CFG) go(currentPage, true); }, 400); }, false);
  W.addEventListener('resize', function () { clearTimeout(W.__rs); W.__rs = setTimeout(function () { if (CFG) go(currentPage, true); }, 300); }, false);

  // ------------------------------------------------------------------ boucle d'animation (suspendue hors écran)
  var animating = [];
  // Une seule boucle d'images à la fois : sans ce verrou, chaque relance pouvait ouvrir une boucle de plus
  // (le spectre était alors dessiné plusieurs fois par image et l'iPad 2 saccadait)
  var loopOn = false;
  function animate(fn) { if (animating.indexOf(fn) < 0) animating.push(fn); if (!loopOn) { loopOn = true; raf(loop); } }
  function loop(ts) {
    loopOn = false;
    if (D.hidden) { animating = []; return; }
    var list = animating; animating = [];
    for (var i = 0; i < list.length; i++) if (list[i](ts) && animating.indexOf(list[i]) < 0) animating.push(list[i]);
    if (animating.length && !loopOn) { loopOn = true; raf(loop); }
  }
  D.addEventListener('visibilitychange', function () { if (!D.hidden && CFG) go(currentPage, true); }, false);
  function animMs() { return animMode === 'desactive' ? 0 : animMode === 'reduit' ? 200 : 700; }
  function ease(t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; }

  // ------------------------------------------------------------------ actions
  function runAction(id, btn) {
    var a = find(CFG.actions, function (x) { return x.id === id; });
    if (!a) return toast('Action inconnue : ' + id, 'err');
    if (a.type === 'page') { if (a.params.kbTab !== undefined) store('kbTab', String(a.params.kbTab)); return go(a.params.page); }
    if (a.type === 'ipad_url') { openOutside(a.params.url); return; }
    if (btn) { if (btn.classList.contains('busy')) return; btn.classList.add('busy'); }
    xhr('POST', '/api/action', { id: id, pressId: rid() }, function (e, r) {
      if (btn) btn.classList.remove('busy');
      if (e || !r) { flash(btn, false); return toast('Échec : ' + (e || 'réponse vide'), 'err'); }
      if (!r.ok) { flash(btn, false); return toast(r.error || 'Échec', 'err'); }
      flash(btn, true);
      if (r.client) {
        if (r.client.page) go(r.client.page);
        if (r.client.openUrl) openOutside(r.client.openUrl);
      }
      if (r.message) toast(r.message, 'ok');
    }, { timeout: 30000 });
  }
  // Lien externe : ouvert dans Safari (window.open), jamais dans l'icône du deck, qui resterait sinon bloquée sur le site.
  function openOutside(url) { var w = W.open(url, '_blank'); if (!w) toast('Autorise les fenêtres dans Safari pour ouvrir ce lien', 'err'); }
  function flash(btn, ok) { if (!btn) return; btn.classList.add(ok ? 'okflash' : 'errflash'); setTimeout(function () { btn.classList.remove('okflash'); btn.classList.remove('errflash'); }, 700); }

  // ------------------------------------------------------------------ surcouche
  function openOverlay(title, builder, onClose) {
    $('ov-title').textContent = title; var b = $('ov-body'); clear(b);
    $('overlay').className = '';
    overlayClose = onClose || null;
    builder(b);
  }
  var overlayClose = null;
  function closeOverlay() { $('overlay').className = 'hidden'; clear($('ov-body')); if (overlayClose) { var f = overlayClose; overlayClose = null; f(); } }
  tap($('ov-close'), closeOverlay);

  tap($('h-menu'), function () {
    openOverlay('Pages et réglages', function (b) {
      var grid = el('div', 'menu-grid', null, b);
      CFG.layout.pages.forEach(function (p) { button(grid, p.title, p.id === currentPage ? 'go' : '', function () { go(p.id); }); });
      el('h3', null, 'Animations', b);
      var anim = el('div', 'win', null, b);
      [['normal', 'Normales'], ['reduit', 'Réduites'], ['desactive', 'Désactivées']].forEach(function (m) {
        button(anim, m[1], m[0] === animMode ? 'sel' : '', function () { store('deckAnim', m[0]); applySettings(); go(currentPage, true); });
      });
      el('h3', null, 'Son des alertes', b);
      var on = store('alertSound') === '1';
      button(b, on ? '🔔 Bip des alertes : activé (toucher pour couper)' : '🔕 Bip des alertes : coupé (toucher pour activer)', on ? 'go' : '', function () {
        if (store('alertSound') === '1') { store('alertSound', '0'); toast('Bip des alertes coupé', 'ok'); }
        else { unlockAudio(); store('alertSound', audioCtx ? '1' : '0'); toast(audioCtx ? 'Bip des alertes activé' : 'Son indisponible sur cet iPad', audioCtx ? 'ok' : 'err'); }
        closeOverlay();
      });
      el('h3', null, 'Cet appareil', b);
      el('div', 'line', 'Connexion : ' + (secure ? 'chiffrée (https)' : 'NON chiffrée (http) — fonctions sensibles bloquées'), b);
      el('div', 'line', 'Mode : ' + (W.navigator.standalone ? 'icône d\'écran d\'accueil' : 'Safari'), b);
      button(b, 'Oublier l\'association de cet iPad', 'stop', function () { forgetToken(); closeOverlay(); showPair('Association supprimée sur cet iPad. Pense aussi à ./deck revoke sur le Mac.'); });
    });
  });

  // ------------------------------------------------------------------ dessin des courbes
  function setupCanvas(cv, w, h) {
    var r = W.devicePixelRatio || 1;
    cv.width = Math.round(w * r); cv.height = Math.round(h * r); cv.style.width = w + 'px'; cv.style.height = h + 'px';
    var ctx = cv.getContext('2d'); ctx.setTransform(r, 0, 0, r, 0, 0); return ctx;
  }
  // Dessine une série temporelle ; trou dans la courbe si absence de mesure (null ou écart > 2,5 intervalles).
  function drawSeries(ctx, o) {
    var pts = o.points || [], x0 = o.x, y0 = o.y, w = o.w, h = o.h, span = o.tEnd - o.tStart;
    if (o.grid) {
      ctx.strokeStyle = '#17305a'; ctx.lineWidth = 1; ctx.fillStyle = '#6f84a8'; ctx.font = '11px -apple-system, Helvetica';
      for (var g = 0; g <= 4; g++) {
        var gy = Math.round(y0 + h - h * g / 4) + 0.5;
        ctx.beginPath(); ctx.moveTo(x0, gy); ctx.lineTo(x0 + w, gy); ctx.stroke();
        ctx.fillText(num(o.vMax * g / 4, o.vMax < 10 ? 1 : 0) + (g === 4 && o.unit ? ' ' + o.unit : ''), x0 + 3, gy - 3);
      }
    }
    var gapMs = (o.interval || 5) * 2500;
    var X = function (t) { return x0 + (t - o.tStart) / span * w; };
    var Y = function (v) { return y0 + h - Math.min(1, Math.max(0, v / o.vMax)) * h; };
    ctx.lineWidth = o.lineWidth || 2; ctx.strokeStyle = o.color; ctx.lineJoin = 'round';
    ctx.shadowColor = o.color; ctx.shadowBlur = !LOWFX && animMode === 'normal' && (o.lineWidth || 2) >= 2 ? 8 : 0;   // trait néon (sauf iPad 2)
    var seg = [];
    var flush = function () {
      if (!seg.length) return;
      ctx.beginPath(); ctx.moveTo(X(seg[0][0]), Y(seg[0][1]));
      for (var k = 1; k < seg.length; k++) ctx.lineTo(X(seg[k][0]), Y(seg[k][1]));
      ctx.stroke();
      if (o.fill) {
        ctx.lineTo(X(seg[seg.length - 1][0]), y0 + h); ctx.lineTo(X(seg[0][0]), y0 + h); ctx.closePath();
        ctx.fillStyle = o.fill; ctx.fill();
      }
      if (seg.length === 1) { ctx.fillStyle = o.color; ctx.fillRect(X(seg[0][0]) - 1.5, Y(seg[0][1]) - 1.5, 3, 3); }
      seg = [];
    };
    var prevT = null;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (p[0] < o.tStart - gapMs) { prevT = p[0]; continue; }
      if (p[1] === null || (prevT !== null && p[0] - prevT > gapMs)) flush();
      if (p[1] !== null) seg.push(p);
      prevT = p[0];
    }
    flush();
  }
  // Markdown simple -> texte lisible (affiché en textContent, jamais en HTML)
  function plain(t) { return String(t).replace(/\*\*([^*]+)\*\*/g, '$1').replace(/^\s*[*-]\s+/gm, '• ').replace(/^#+\s*/gm, ''); }
  function hexA(hex, a) { var n = parseInt(hex.slice(1), 16); return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'; }
  function colorFor(cfg, v) {
    var t = cfg.thresholds;
    if (t && v !== null && v !== undefined) { if (v >= t.crit) return '#ff4f9a'; if (v >= t.warn) return '#ffc163'; }
    return cfg.color || CFG.settings.accent;
  }
  function sourceMax(src) {
    var m = STATE && STATE.metrics;
    if (src === 'cpu' || src === 'volume') return 100;
    if (src === 'mem') return m && m.memTotalGB ? m.memTotalGB : 16;
    if (src === 'disk') return m && m.diskTotalGB ? m.diskTotalGB : 500;
    var s = series[src] || [], mx = 0; for (var i = 0; i < s.length; i++) if (s[i][1] > mx) mx = s[i][1];
    return Math.max(500, Math.ceil(mx * 1.2 / 250) * 250);
  }
  function sourceInterval(src) { return src.indexOf('svc:') === 0 ? CFG.settings.httpIntervalSec : CFG.settings.metricsIntervalSec; }
  function srcValue(src) {
    var m = STATE && STATE.metrics || {};
    if (src === 'cpu') return m.cpu; if (src === 'mem') return m.memUsedGB; if (src === 'disk') return m.diskUsedGB; if (src === 'volume') return m.volume;
    if (src.indexOf('svc.count.') === 0) return STATE && STATE.counts ? STATE.counts[src.slice(10)] : null;
    if (src.indexOf('svc:') === 0) { var sv = find(STATE && STATE.services, function (x) { return x.id === src.slice(4); }); return sv ? sv.ms : null; }
    return null;
  }
  function pctOf(src, v) { var mx = sourceMax(src); return v === null || v === undefined ? null : 100 * v / mx; }

  // ------------------------------------------------------------------ fabriques de widgets
  var FACTORIES = {};

  FACTORIES.text = function (box, cfg) { el('div', 'w-title', cfg.label, box); return {}; };

  FACTORIES.button = function (box, cfg, w, h) {
    box.style.background = 'transparent'; box.style.border = '0';
    var b = el('div', 'btn' + (cfg.icon ? ' key' + (h < 90 ? ' inline' : '') : ''), cfg.icon ? null : cfg.label, box);
    if (cfg.icon) { el('div', 'ico', cfg.icon, b); el('div', 'klbl', cfg.label, b); }
    b.style.left = '0'; b.style.top = '0'; b.style.right = '0'; b.style.bottom = '0';
    if (cfg.color) b.className += ' colored';   // touche d'alerte (ex. Stop captures) : verre rose néon
    tap(b, function () { runAction(cfg.action, b); });
    return {};
  };

  FACTORIES.light = function (box, cfg) {
    el('div', 'w-title', cfg.label, box);
    var line = el('div', 'line', null, box); line.style.position = 'absolute'; line.style.left = '14px'; line.style.top = '40px';
    var dot = el('span', 'dot', null, line), txt = el('span', null, '', line);
    if (cfg.action) tap(box, function () { runAction(cfg.action); });
    return { update: function () {
      var v = srcValue(cfg.source), status = 'unknown';
      if (cfg.source.indexOf('svc:') === 0) { var sv = find(STATE.services, function (x) { return x.id === cfg.source.slice(4); }); status = sv ? sv.status : 'unknown'; }
      else if (v !== null && v !== undefined) { status = cfg.thresholds && pctOf(cfg.source, v) >= cfg.thresholds.crit ? 'alert' : 'ok'; }
      dot.className = 'dot st-' + status;
      txt.textContent = ({ ok: '✓ Normal', alert: '⚠ Alerte', unknown: '? Inconnu' })[status] + (v !== null && v !== undefined ? ' — ' + num(v, 1) + ' ' + (cfg.unit || '') : '');
    } };
  };

  FACTORIES.counter = function (box, cfg, w, h) {
    box.className += ' counter' + (h < 80 ? ' compact' : '');
    var n = el('div', 'num', '–', box); n.style.color = cfg.color || '#fff';
    el('div', 'lbl', cfg.label, box);
    var last = null;
    tap(box, function () {
      if (cfg.action) return runAction(cfg.action);
      if (cfg.params && cfg.params.filter) openServiceList(cfg.params.filter);
    });
    return { update: function () {
      var v = srcValue(cfg.source);
      if (v === last) return;
      var up = last !== null && v > last;
      if (last === null || animMode === 'desactive') { n.textContent = v === null || v === undefined ? '–' : v; }
      else { n.classList.add('bump'); setTimeout(function () { n.textContent = v; n.classList.remove('bump'); }, animMs() / 2); }
      if (up && cfg.source === 'svc.count.alert') { box.classList.remove('pulse'); void box.offsetWidth; box.classList.add('pulse'); }
      last = v;
    } };
  };

  FACTORIES.gauge = function (box, cfg, w, h) {
    el('div', 'w-title', cfg.label, box);
    var cv = el('canvas', null, null, box); cv.style.position = 'absolute'; cv.style.left = '0'; cv.style.top = '28px';
    var small = w < 230;   // petite jauge (accueil dense) : textes réduits, sans chevauchement
    var gh = h - 28 - (small ? 40 : 54), ctx = setupCanvas(cv, w, gh);
    var main = el('div', null, '', box); main.style.cssText = 'position:absolute;left:0;right:0;text-align:center;font-weight:300;white-space:nowrap;bottom:' + (small ? '22px;font-size:15px' : '30px;font-size:24px');
    var sub = el('div', 'sub', '', box); sub.style.cssText = 'position:absolute;left:4px;right:4px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;bottom:6px' + (small ? ';font-size:11px' : '');
    var shown = 0, from = 0, target = 0, t0 = 0;
    if (cfg.action) tap(box, function () { runAction(cfg.action); });
    function draw() {
      ctx.clearRect(0, 0, w, gh);
      var cx = w / 2, cy = gh * 0.58, r = Math.min(w * 0.38, gh * 0.5), a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
      ctx.lineCap = 'round'; ctx.lineWidth = Math.max(10, r * 0.18);
      ctx.strokeStyle = '#17305a'; ctx.beginPath(); ctx.arc(cx, cy, r, a0, a1); ctx.stroke();
      ctx.strokeStyle = colorFor(cfg, shown); ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = !LOWFX && animMode === 'normal' ? 12 : 0;
      ctx.beginPath(); ctx.arc(cx, cy, r, a0, a0 + (a1 - a0) * Math.max(0.001, Math.min(1, shown / 100))); ctx.stroke(); ctx.shadowBlur = 0;
      ctx.fillStyle = '#fff'; ctx.font = '300 ' + Math.round(r * 0.42) + 'px -apple-system, Helvetica'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(num(shown, 0) + ' %', cx, cy);
    }
    function step(ts) {
      var d = animMs(), p = d ? Math.min(1, (now() - t0) / d) : 1;
      shown = from + (target - from) * ease(p); draw(); return p < 1;
    }
    draw();
    return { update: function () {
      var m = STATE.metrics || {}, pct = null;
      if (cfg.source === 'mem') { pct = m.memPct; main.textContent = num(m.memUsedGB, 1) + (small ? '/' : ' Go / ') + num(m.memTotalGB, 0) + ' Go'; sub.textContent = small ? 'disque : ' + num(m.diskFreeGB, 0) + ' Go libres' : 'Disque : ' + num(m.diskFreeGB, 0) + ' Go libres sur ' + num(m.diskTotalGB, 0) + ' Go'; }
      else if (cfg.source === 'disk') { pct = m.diskPct; main.textContent = num(m.diskUsedGB, 0) + ' Go utilisés'; sub.textContent = num(m.diskFreeGB, 0) + ' Go libres sur ' + num(m.diskTotalGB, 0) + ' Go'; }
      else if (cfg.source === 'volume') { pct = m.volume; main.textContent = m.muted ? '🔇 Son coupé' : '🔊 Sortie audio du Mac'; sub.textContent = 'Le micro se règle dans le Studio'; }
      else if (cfg.source === 'cpu') { pct = m.cpu; main.textContent = num(m.cpu, 0) + ' %'; sub.textContent = (m.cores || '?') + ' cœurs'; }
      else { var v = srcValue(cfg.source); pct = pctOf(cfg.source, v); main.textContent = num(v, 0) + ' ' + (cfg.unit || ''); }
      if (pct === null || pct === undefined) { main.textContent = 'Pas de mesure'; return; }
      if (Math.abs(pct - target) < 0.05) return;
      from = shown; target = pct; t0 = now(); animate(step);
    } };
  };

  FACTORIES.chart = function (box, cfg, w, h, big) {
    var src = cfg.source, winMin = (cfg.params && cfg.params.window) || 15;
    el('div', 'w-title', cfg.label + ' — ' + winMin + ' min', box);
    var val = el('div', null, '', box); val.style.cssText = 'position:absolute;right:14px;top:4px;text-align:right';
    var vb = el('span', 'big', '–', val); vb.style.fontSize = h > 200 ? '40px' : '28px'; el('span', 'unit', cfg.unit || '', val);
    var cv = el('canvas', null, null, box); cv.style.position = 'absolute'; cv.style.left = '0'; cv.style.top = '0';
    var ctx = setupCanvas(cv, w, h);
    var top = h > 200 ? 56 : 40;
    var viewEnd = now(), targetEnd = now(), endFrom = 0, endT0 = 0;
    var alive = true;
    function draw() {
      if (!alive) return;
      ctx.clearRect(0, 0, w, h);
      var mx = (cfg.params && cfg.params.max) || sourceMax(src), color = colorFor(cfg, srcValue(src));
      drawSeries(ctx, { x: 8, y: top, w: w - 16, h: h - top - 10, points: series[src], tStart: viewEnd - winMin * 60000, tEnd: viewEnd, vMax: mx, color: color, fill: hexA(color, 0.15), grid: true, unit: cfg.unit, interval: sourceInterval(src), lineWidth: 2.5 });
    }
    function step() { var d = animMs(), p = d ? Math.min(1, (now() - endT0) / d) : 1; viewEnd = endFrom + (targetEnd - endFrom) * ease(p); draw(); return p < 1 && alive; }
    loadSeries(src, winMin * 60, function () { var s = series[src]; viewEnd = targetEnd = s && s.length ? s[s.length - 1][0] : now(); draw(); });
    tap(box, function () { if (cfg.action) runAction(cfg.action); else openChartDetail(cfg); });
    return {
      update: function () {
        var v = srcValue(src); vb.textContent = num(v, src === 'mem' ? 1 : 0);
        var s = series[src]; if (!s || !s.length) return;
        var t = Math.max(s[s.length - 1][0], now() - 1000);
        if (t - targetEnd < 500) return;
        endFrom = viewEnd; targetEnd = t; endT0 = now(); animate(step);
      },
      destroy: function () { alive = false; }
    };
  };

  // Détail d'une courbe : fenêtres 5/15/60 min, lecture de la valeur horodatée au toucher.
  function openChartDetail(cfg) {
    var src = cfg.source, winMin = (cfg.params && cfg.params.window) || 15;
    openOverlay(cfg.label + ' (' + (cfg.unit || '') + ')', function (b) {
      var bar = el('div', 'win', null, b);
      var info = el('div', 'line', 'Touchez la courbe pour lire une valeur.', b);
      var cv = el('canvas', null, null, b);
      var w = b.clientWidth - 24, h = b.clientHeight - 130, ctx = setupCanvas(cv, w, h);
      var cursor = null, pts = [];
      function draw() {
        ctx.clearRect(0, 0, w, h);
        var tEnd = now(), tStart = tEnd - winMin * 60000, mx = (cfg.params && cfg.params.max) || sourceMax(src);
        drawSeries(ctx, { x: 40, y: 10, w: w - 50, h: h - 40, points: pts, tStart: tStart, tEnd: tEnd, vMax: mx, color: cfg.color || CFG.settings.accent, fill: hexA(cfg.color || CFG.settings.accent, 0.15), grid: true, unit: cfg.unit, interval: sourceInterval(src), lineWidth: 2.5 });
        ctx.fillStyle = '#6f84a8'; ctx.font = '12px -apple-system, Helvetica'; ctx.textAlign = 'left';
        for (var i = 0; i <= 5; i++) { var t = tStart + (tEnd - tStart) * i / 5; ctx.fillText(hhmm(t), 40 + (w - 50) * i / 5 - (i === 5 ? 34 : 0), h - 12); }
        if (cursor) {
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(cursor.x + 0.5, 10); ctx.lineTo(cursor.x + 0.5, h - 30); ctx.stroke();
        }
      }
      function pick(clientX) {
        var r = cv.getBoundingClientRect(), x = clientX - r.left;
        var tEnd = now(), tStart = tEnd - winMin * 60000, t = tStart + (x - 40) / (w - 50) * (tEnd - tStart);
        var best = null; for (var i = 0; i < pts.length; i++) if (!best || Math.abs(pts[i][0] - t) < Math.abs(best[0] - t)) best = pts[i];
        cursor = { x: x };
        if (!best || Math.abs(best[0] - t) > sourceInterval(src) * 2500) info.textContent = hhmmss(t) + ' — aucune mesure (trou dans l\'historique)';
        else info.textContent = hhmmss(best[0]) + ' — ' + (best[1] === null ? 'pas de mesure' : num(best[1], src === 'mem' ? 2 : 1) + ' ' + (cfg.unit || ''));
        draw();
      }
      cv.addEventListener('touchstart', function (e) { e.preventDefault(); pick(e.touches[0].clientX); }, false);
      cv.addEventListener('touchmove', function (e) { e.preventDefault(); pick(e.touches[0].clientX); }, false);
      cv.addEventListener('mousedown', function (e) { pick(e.clientX); }, false);
      function load() { xhr('GET', '/api/history?source=' + encodeURIComponent(src) + '&window=' + winMin * 60, null, function (e, d) { pts = d && d.points || []; cursor = null; draw(); }); }
      [5, 15, 60].forEach(function (m) {
        var bt = button(bar, m + ' min', m === winMin ? 'sel' : '', function () { winMin = m; var bs = bar.childNodes; for (var i = 0; i < bs.length; i++) bs[i].classList.remove('sel'); bt.classList.add('sel'); load(); });
      });
      load();
    });
  }

  // ------------------------------------------------------------------ surveillance
  function statusText(s) { return s.status === 'ok' ? (s.slow ? '✓ Lent' : '✓ Disponible') : s.status === 'alert' ? '⚠ Alerte' : '? Inconnu'; }
  function svcRow(parent, sv) {
    var row = el('div', 'row', null, parent);
    var name = el('div', 'name', null, row); var d = el('span', 'dot st-' + (sv.status === 'ok' && sv.slow ? 'slow' : sv.status), null, name); el('span', null, sv.label, name);
    var info = el('div', 'info', null, row);
    el('div', 't-' + sv.status, statusText(sv) + (sv.kind === 'ping' ? ' · ping' : sv.code ? ' · HTTP ' + sv.code : ''), info);
    el('div', null, (sv.ms !== null && sv.ms !== undefined ? sv.ms + ' ms · ' : '') + (sv.t ? hhmmss(sv.t) : 'pas encore mesuré') + (sv.error ? ' · ' + sv.error : ''), info);
    var cv = el('canvas', 'spark', null, row);
    tap(row, function () { openChartDetail({ source: 'svc:' + sv.id, label: 'Latence ' + sv.label, unit: 'ms', params: { window: 15 } }); });
    return { row: row, cv: cv, dot: d };
  }
  function drawSpark(cv, src) {
    var w = cv.clientWidth || 200, h = 40, ctx = setupCanvas(cv, w, h);
    drawSeries(ctx, { x: 2, y: 2, w: w - 4, h: h - 4, points: series[src], tStart: now() - 15 * 60000, tEnd: now(), vMax: sourceMax(src), color: CFG.settings.accent, interval: sourceInterval(src), lineWidth: 1.5 });
  }
  function openServiceList(filter) {
    var title = ({ ok: 'Services disponibles', alert: 'Services en alerte', unknown: 'Services à l\'état inconnu' })[filter];
    openOverlay(title, function (b) {
      var list = (STATE.services || []).filter(function (s) { return s.status === filter; });
      if (!list.length) el('div', 'line', 'Aucun service dans cet état.', b);
      list.forEach(function (sv) { var r = svcRow(b, sv); loadSeries('svc:' + sv.id, 900, function () { drawSpark(r.cv, 'svc:' + sv.id); }); });
      if (filter === 'unknown') el('div', 'sub', 'Inconnu = jamais mesuré ou mesure plus vieille que 3 intervalles (Internet coupé ?). L\'horodatage de la dernière mesure est conservé.', b);
    });
  }

  FACTORIES.services = function (box, cfg) {
    el('div', 'w-title', cfg.label + ' — latence 15 min', box);
    var list = el('div', 'list', null, box), rows = {}, alive = true;
    function build() {
      clear(list); rows = {};
      var groups = [], byG = {};
      (STATE.services || []).forEach(function (sv) { var g = sv.group || 'Services'; if (!byG[g]) { byG[g] = []; groups.push(g); } byG[g].push(sv); });
      groups.forEach(function (g) {
        var ok = 0, al = 0; byG[g].forEach(function (sv) { if (sv.status === 'ok') ok++; else if (sv.status === 'alert') al++; });
        var hd = el('div', 'ghead', null, list);
        el('span', null, g, hd); el('span', al ? 't-alert' : 't-ok', '  ' + ok + '/' + byG[g].length + (al ? ' · ' + al + ' en alerte' : ''), hd);
        byG[g].forEach(function (sv) { rows[sv.id] = { sv: sv, r: svcRow(list, sv) }; });
      });
      Object.keys(rows).forEach(function (id) { loadSeries('svc:' + id, 900, function () { if (alive && rows[id]) drawSpark(rows[id].r.cv, 'svc:' + id); }); });
    }
    var sig = '';
    return {
      update: function (s, prev) {
        var nsig = (s.services || []).map(function (x) { return x.id + x.status + x.t; }).join('|');
        if (nsig === sig) return;
        var alertIds = (s.services || []).filter(function (x) { return x.status === 'alert' && !(prev && find(prev.services, function (p) { return p.id === x.id && p.status === 'alert'; })); }).map(function (x) { return x.id; });
        sig = nsig; build();
        alertIds.forEach(function (id) { if (rows[id] && prev) rows[id].r.row.classList.add('pulse'); });
      },
      destroy: function () { alive = false; }
    };
  };

  // ------------------------------------------------------------------ zone média (accueil) : origine, état, arrêt
  function mediaLabel(a) {
    return ({ 'mic-test': 'Test du niveau', 'mic-record': 'Enregistrement audio', 'mic-dictation': 'Dictée', 'cam-preview': 'Aperçu caméra', 'cam-photo': 'Photo', 'cam-clip': 'Clip vidéo' + (a.withAudio ? ' avec son' : ' sans son') })[a.kind] || a.kind;
  }
  function stopAllMedia(cb) {
    xhr('POST', '/api/media/stop', {}, function (e, r) { toast(e ? 'Arrêt impossible : ' + e : (r.message || 'Arrêté'), e ? 'err' : 'ok'); if (cb) cb(); });
  }
  FACTORIES.media = function (box, cfg) {
    box.className += ' media-zone';
    var t = el('div', 'w-title', cfg.label, box);
    var body = el('div', null, null, box); body.style.cssText = 'position:absolute;left:12px;right:150px;top:32px;bottom:6px;overflow:hidden';
    var stop = el('div', 'btn', '■ Arrêter', box); stop.style.cssText = 'right:10px;top:30px;bottom:10px;width:130px;background:#8c1d48;border-color:#c2306a';
    tap(stop, function () { stopAllMedia(); });
    var timer = null;
    function render() {
      var act = STATE.media && STATE.media.active || [];
      clear(body);
      body.style.right = act.length ? '150px' : '12px';
      if (!act.length) { box.classList.remove('active'); stop.className = 'btn hidden'; el('div', 'line', '🔒 Inactifs : rien n\'est capté', body).style.color = '#9fb3d1'; return; }
      box.classList.add('active'); stop.className = 'btn';
      act.forEach(function (a) {
        el('div', 'line', '● ' + mediaLabel(a) + ' — ' + a.source + ' — ' + dur((now() - a.startedAt) / 1000) + ' / ' + dur(a.maxSec), body).className = 'line rec';
        el('div', 'sub', 'Origine : ' + (a.origin === 'mac' ? 'Mac' : 'iPad') + ' · ' + (a.recording ? 'enregistre un fichier sur le Mac' : 'aucun fichier') + ' · ' + a.transmission, body);
      });
    }
    timer = setInterval(function () { if (STATE.media && STATE.media.active.length) render(); }, 1000);
    return { update: render, destroy: function () { clearInterval(timer); } };
  };

  // ------------------------------------------------------------------ Studio : micro du Mac (facultatif)
  var devicesCache = null;
  function loadDevices(cb, refresh) {
    if (devicesCache && !refresh) return cb(devicesCache);
    xhr('GET', '/api/media/devices' + (refresh ? '?refresh=1' : ''), null, function (e, d) { devicesCache = e || !d ? { error: e || 'erreur', video: [], audio: [] } : d.devices; cb(devicesCache); });
  }
  function deviceSelect(parent, list, key) {
    var s = el('select', null, null, parent);
    if (!list.length) { var o = el('option', null, 'Aucun périphérique détecté', s); o.value = ''; return s; }
    list.forEach(function (d) { var o = el('option', null, d.name + (d.virtual ? ' (virtuel)' : d.builtin ? ' (intégré)' : ''), s); o.value = d.name; });
    var saved = store(key); if (saved && find(list, function (d) { return d.name === saved; })) s.value = saved;
    else { var pref = find(list, function (d) { return d.builtin; }) || find(list, function (d) { return !d.virtual; }); if (pref) s.value = pref.name; }
    s.addEventListener('change', function () { store(key, s.value); }, false);
    return s;
  }
  function micActive() { return find(STATE && STATE.media && STATE.media.active, function (a) { return a.kind.indexOf('mic-') === 0; }); }

  FACTORIES.vumeter = function (box, cfg) {
    el('div', 'w-title', cfg.label, box);
    var p = el('div', 'panel', null, box), alive = true, levelTimer = null;
    var head = el('div', 'line', 'Recherche des micros du Mac…', p);
    var sel = null;
    var vu = el('div', 'vu', null, p), bar = el('div', 'bar', null, vu), pk = el('div', 'pk', null, vu);
    var info = el('div', 'line', '', p);
    var chrono = el('span', 'chrono', '00:00', info); var src = el('span', 'sub', '  Aucune capture', info);
    var btns = el('div', null, null, p);
    var bTest = button(btns, 'Tester le niveau', 'go', function () { startMic('test'); });
    var bRec = button(btns, '● Enregistrer', '', function () { startMic('record'); });
    var bDict = button(btns, 'Dicter (texte sur le Mac)', '', function () { startMic('dictation'); });
    var bStop = button(btns, '■ Arrêter', 'stop', function () { var a = micActive(); xhr('POST', '/api/media/stop', a ? { id: a.id } : {}, function () {}); });
    var note = el('div', 'sub', '« Tester le niveau » ne crée aucun fichier. « Enregistrer » et « Dicter » écrivent sur le Mac, dans le dossier des captures.', p);
    loadDevices(function (d) {
      if (!alive) return;
      if (d.error) { head.textContent = 'Périphériques du Mac indisponibles : ' + d.error; head.className = 'errbox'; return; }
      head.textContent = 'Micro du Mac : '; sel = deviceSelect(head, d.audio, 'macMic');
    });
    function startMic(mode) {
      if (!sel || !sel.value) return toast('Aucun micro du Mac sélectionné', 'err');
      xhr('POST', '/api/media/mic/start', { device: sel.value, mode: mode }, function (e, r) {
        if (e || !r || !r.ok) return toast('Micro du Mac : ' + ((r && r.error) || e), 'err');
        if (mode === 'dictation') store('pendingDictation', '1');
        toast(mode === 'test' ? 'Test du niveau : parle, aucun fichier n\'est créé' : 'Enregistrement sur le Mac démarré', 'ok');
      });
    }
    function pollLevel() {
      if (!alive) return;
      xhr('GET', '/api/media/level', null, function (e, d) {
        if (!alive) return;
        var L = d && d.level;
        if (L) {
          bar.style.width = Math.round(L.level * 100) + '%'; bar.className = 'bar' + (L.level > 0.92 ? ' clip' : L.level > 0.75 ? ' hot' : '');
          pk.style.left = Math.round(Math.min(1, (20 * Math.log(L.peak || 1e-6) / Math.LN10 + 60) / 60) * 100) + '%';
          chrono.textContent = dur(L.elapsed);
          src.textContent = '  ' + L.source + ' · ' + (L.kind === 'mic-test' ? 'test, aucun fichier' : '● enregistrement') + (L.noSignal ? ' · ⚠ aucun signal : micro coupé ou autorisation macOS refusée' : '');
          levelTimer = setTimeout(pollLevel, 150);
        } else { bar.style.width = '0'; src.textContent = '  Aucune capture'; levelTimer = null; }
      }, { timeout: 3000 });
    }
    return {
      update: function () {
        var a = micActive();
        bStop.className = 'b stop' + (a ? '' : ' disabled');
        [bTest, bRec, bDict].forEach(function (b) { if (a) b.classList.add('disabled'); else b.classList.remove('disabled'); });
        if (a && !levelTimer) pollLevel();
        var le = STATE.media && STATE.media.lastEnded && STATE.media.lastEnded.mic;
        if (!a && le && le.error && now() - le.at < 60000) { note.textContent = '⚠ ' + le.error; note.className = 'errbox'; }
        else if (!a && le && now() - le.at < 60000 && le.reason) { note.textContent = 'Dernière capture : ' + le.reason + '.'; note.className = 'sub'; }
      },
      destroy: function () { alive = false; clearTimeout(levelTimer); }
    };
  };

  // ------------------------------------------------------------------ Studio : caméra du Mac (facultative)
  function getTicket(r, cb) {
    var t = tickets[r]; if (t && now() - t.at < 600000) return cb(t.k);
    xhr('GET', '/api/ticket?r=' + encodeURIComponent(r), null, function (e, d) { if (e || !d) return cb(null); tickets[r] = { k: d.k, at: now() }; cb(d.k); });
  }
  function camActive() { return find(STATE && STATE.media && STATE.media.active, function (a) { return a.kind.indexOf('cam-') === 0; }); }

  FACTORIES.camera = function (box, cfg) {
    el('div', 'w-title', cfg.label, box);
    var p = el('div', 'panel', null, box), alive = true;
    if (!secure) { el('div', 'warnbox', 'Aperçu et photos de la caméra du Mac : connexion chiffrée requise (installe le certificat, page /setup).', p); }
    var head = el('div', 'line', 'Recherche des caméras du Mac…', p), sel = null, aud = null;
    var btns = el('div', null, null, p);
    var bPrev = button(btns, 'Aperçu', 'go', function () { if (!sel || !sel.value) return; xhr('POST', '/api/media/camera/preview', { device: sel.value, fps: CFG.settings.previewFps }, function (e, r) { if (e || !r.ok) toast('Caméra : ' + ((r && r.error) || e), 'err'); }); });
    var bPhoto = button(btns, 'Prendre une photo', '', function () {
      if (!sel || !sel.value) return; bPhoto.classList.add('disabled');
      xhr('POST', '/api/media/camera/photo', { device: sel.value }, function (e, r) {
        bPhoto.classList.remove('disabled');
        if (e || !r.ok) return toast('Photo : ' + ((r && r.error) || e), 'err');
        showLast(r.result); toast('Photo enregistrée sur le Mac (reste locale)', 'ok');
      }, { timeout: 30000 });
    });
    var withAudio = false;
    var bAud = button(btns, 'Clip : sans son', 'small', function () { withAudio = !withAudio; bAud.textContent = withAudio ? 'Clip : avec le micro du Mac' : 'Clip : sans son'; });
    var bClip = button(btns, '● Enregistrer un clip', '', function () {
      if (!sel || !sel.value) return;
      xhr('POST', '/api/media/camera/clip', { device: sel.value, withAudio: withAudio, audioDevice: store('macMic') || '' }, function (e, r) { if (e || !r.ok) toast('Clip : ' + ((r && r.error) || e), 'err'); else toast('Clip en cours d\'enregistrement sur le Mac', 'ok'); });
    });
    var bStop = button(btns, '■ Arrêter', 'stop', function () { var a = camActive(); xhr('POST', '/api/media/stop', a ? { id: a.id } : {}, function () {}); });
    var stat = el('div', 'sub', 'Aucune caméra active. Rien ne s\'allume à l\'ouverture de la page.', p);
    var img = el('img', 'preview hidden', null, p);
    var lastBox = el('div', null, null, p);
    var frameTimer = null, loading = false, lastFrameOk = 0;
    loadDevices(function (d) {
      if (!alive) return;
      if (d.error) { head.textContent = 'Caméras du Mac indisponibles : ' + d.error; head.className = 'errbox'; return; }
      head.textContent = 'Caméra du Mac : '; sel = deviceSelect(head, d.video, 'macCam');
    });
    function nextFrame() {
      if (!alive || loading) return;
      var a = camActive(); if (!a || a.kind !== 'cam-preview') { img.className = 'preview hidden'; frameTimer = null; return; }
      getTicket('frame', function (k) {
        if (!k) return;
        loading = true;
        var i2 = new Image();
        i2.onload = function () { loading = false; if (!alive) return; img.src = i2.src; img.className = 'preview'; lastFrameOk = now(); stat.textContent = '● Aperçu en direct — ' + a.source + ' — dernière image ' + hhmmss(now()) + ' — images envoyées à l\'iPad sur le réseau local, non enregistrées'; frameTimer = setTimeout(nextFrame, 1000 / CFG.settings.previewFps); };
        i2.onerror = function () { loading = false; if (!alive) return; stat.textContent = 'Aperçu : en attente d\'image… (dernière : ' + (lastFrameOk ? hhmmss(lastFrameOk) : 'aucune') + ')'; frameTimer = setTimeout(nextFrame, 1000); };
        i2.src = '/api/media/frame?k=' + encodeURIComponent(k) + '&t=' + now();
      });
    }
    function showLast(c) {
      clear(lastBox); if (!c) return;
      el('div', 'line', 'Dernière photo : ' + c.source + ' — ' + dateFr(c.createdAt), lastBox);
      getTicket('file:' + c.id, function (k) { if (k) { var im = el('img', 'thumb', null, lastBox); im.src = '/api/media/file/' + c.id + '?k=' + encodeURIComponent(k); } });
      el('div', 'sub', 'Stockée sur le Mac : ' + c.file, lastBox);
    }
    return {
      update: function () {
        var a = camActive();
        bStop.className = 'b stop' + (a ? '' : ' disabled');
        if (a && a.kind === 'cam-preview' && !frameTimer && !loading && secure) nextFrame();
        if (a && a.kind === 'cam-clip') stat.textContent = '● Clip en cours — ' + a.source + ' — fichier sur le Mac — ' + dur((now() - a.startedAt) / 1000) + ' / ' + dur(a.maxSec);
        if (!a) { img.className = 'preview hidden'; var le = STATE.media.lastEnded && STATE.media.lastEnded.cam; stat.textContent = le && le.error && now() - le.at < 60000 ? '⚠ ' + le.error : 'Aucune caméra active. Rien ne s\'allume à l\'ouverture de la page.'; }
      },
      destroy: function () {
        alive = false; clearTimeout(frameTimer);
        // Fermer la page arrête les transferts ; le serveur coupe l'aperçu après 15 s sans demande d'image.
      }
    };
  };

  // ------------------------------------------------------------------ Studio : capteurs de l'iPad (sélecteur natif iOS)
  function uploadFile(file, purpose, progressEl, cb) {
    var type = file.type || (/\.mov$/i.test(file.name) ? 'video/quicktime' : 'image/jpeg');
    xhr('POST', '/api/media/upload' + (purpose ? '?purpose=' + purpose : ''), file, function (e, r) { cb(e || (r && !r.ok ? r.error : null), r && r.capture); },
      { raw: true, type: type, timeout: 300000, progress: function (f) { progressEl.style.width = Math.round(f * 100) + '%'; } });
  }
  // Bouton de capture iOS : le champ fichier transparent recouvre le bouton et reçoit directement le toucher
  // (Safari iOS 9 n'ouvre pas toujours le sélecteur sur un .click() programmatique).
  function fileButton(parent, label, cls, accept, onFile) {
    var b = el('span', 'b ' + (cls || ''), label, parent); b.style.position = 'relative'; b.style.overflow = 'hidden';
    var i = el('input', null, null, b); i.type = 'file'; i.accept = accept;
    i.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;opacity:0;font-size:200px';
    i.addEventListener('change', function () { if (i.files && i.files[0]) onFile(i.files[0]); i.value = ''; }, false);
    return b;
  }
  function drawLevels(cv, levels, w) {
    var h = 40, ctx = setupCanvas(cv, w, h); ctx.fillStyle = CFG.settings.accent;
    var n = levels.length || 1, bw = w / n;
    for (var i = 0; i < levels.length; i++) { var bh = Math.max(1, levels[i] * h); ctx.fillRect(i * bw, h - bh, Math.max(1, bw - 0.5), bh); }
  }

  FACTORIES.ipadcapture = function (box, cfg) {
    el('div', 'w-title', cfg.label, box);
    var p = el('div', 'panel', null, box), alive = true;
    if (!secure) { el('div', 'errbox', 'Envoi depuis l\'iPad bloqué : connexion non chiffrée. Installe le certificat du deck (page /setup) puis ouvre l\'adresse https.', p); return {}; }
    el('div', 'sub', 'Safari iOS 9 ne donne pas accès au micro ni à la caméra en direct : chaque capture passe par l\'appareil photo d\'iOS (bouton de bascule avant/arrière dans l\'appareil photo), puis est envoyée au Mac pour validation.', p);
    var row = el('div', null, null, p);
    fileButton(row, '📷 Photo avec l\'iPad', 'go', 'image/*', function (f) { send(f, null); });
    fileButton(row, '🎙 Parler (vidéo courte, micro de l\'iPad)', 'go', 'video/*', function (f) { send(f, null); });
    el('div', 'sub', 'Choisis « Prendre une photo ou une vidéo », bascule avant/arrière dans l\'appareil photo d\'iOS, puis « Utiliser ». Aucun basculement automatique vers le Mac.', p);
    var prog = el('div', 'progress hidden', null, p), progBar = el('div', null, null, prog);
    var res = el('div', null, null, p);
    function send(file, purpose) {
      prog.className = 'progress'; progBar.style.width = '0'; clear(res);
      el('div', 'line', 'Envoi au Mac (' + Math.round(file.size / 1024) + ' Ko)…', res);
      uploadFile(file, purpose, progBar, function (e, c) {
        prog.className = 'progress hidden'; clear(res);
        if (e) { el('div', 'errbox', 'Envoi interrompu : ' + e + '. Rien n\'a été transmis ailleurs que vers le Mac.', res); return; }
        showCapture(res, c, true);
      });
    }
    var last = store('lastIpadCapture');
    if (last) xhr('GET', '/api/media/captures', null, function (e, d) { if (!alive || e || !d) return; var c = find(d.captures, function (x) { return x.id === last; }); if (c) showCapture(res, c, false); });
    return { destroy: function () { alive = false; } };
  };

  // Affiche une capture (photo ou vidéo/son) avec les décisions explicites : écouter, transcrire, conserver, supprimer, envoyer.
  function showCapture(parent, c, fresh) {
    clear(parent); store('lastIpadCapture', c.id);
    el('div', 'srcbox', null, parent).innerHTML = '';
    var sb = parent.lastChild; el('b', null, c.source, sb); el('span', 'sub', ' · ' + dateFr(c.createdAt) + (c.durationSec ? ' · ' + dur(c.durationSec) : '') + (c.draft ? ' · brouillon' : ' · conservée'), sb);
    if (c.kind === 'photo') {
      getTicket('file:' + c.id, function (k) { if (k) { var im = el('img', 'thumb', null, parent); im.src = '/api/media/file/' + c.id + '?k=' + encodeURIComponent(k); parent.insertBefore(im, sb.nextSibling); } });
    }
    if (c.levels && c.levels.length) { var cv = el('canvas', null, null, parent); drawLevels(cv, c.levels, Math.min(480, parent.clientWidth || 400)); el('div', 'sub', 'Niveau du micro de l\'iPad mesuré après l\'envoi (pas de direct possible sur iOS 9).', parent); }
    var player = null;
    var actions = el('div', null, null, parent);
    if (c.audioFile || c.kind === 'audio') {
      button(actions, '▶ Écouter sur l\'iPad', 'small', function () {
        getTicket('file:' + c.id, function (k) {
          if (!k) return;
          if (!player) { player = el('audio', null, null, parent); player.controls = true; }
          player.src = '/api/media/file/' + c.id + '?part=audio&k=' + encodeURIComponent(k); player.play();
        });
      });
      button(actions, '▶ Sur le Mac', 'small', function () { xhr('POST', '/api/media/capture/' + c.id + '/play-mac', {}, function (e, r) { toast(e || r.message, e ? 'err' : 'ok'); }); });
      button(actions, 'Transcrire', 'small go', function () { transcribeCapture(c, parent); });
    }
    if (c.draft) button(actions, 'Conserver', 'small', function () { xhr('POST', '/api/media/capture/' + c.id + '/keep', {}, function (e, r) { if (!e && r.ok) { toast('Capture conservée sur le Mac', 'ok'); showCapture(parent, r.capture); } }); });
    button(actions, 'Supprimer', 'small stop', function (ev) {
      var b = ev && ev.target; if (b && !b.__confirm) { b.__confirm = 1; b.textContent = 'Confirmer la suppression'; return; }
      xhr('POST', '/api/media/capture/' + c.id + '/trash', {}, function (e, r) { toast(e || r.message, e ? 'err' : 'ok'); clear(parent); store('lastIpadCapture', null); });
    });
    if (c.kind === 'photo') {
    }
    el('div', 'sub', 'Stockée uniquement sur le Mac : ' + c.file, parent);
    if (c.transcript) transcriptEditor(parent, c);
    else if (fresh && c.purpose === 'dictee' && (c.audioFile || c.kind === 'audio')) transcribeCapture(c, parent);
  }

  function transcribeCapture(c, parent) {
    var st = el('div', 'line', 'Transcription locale en cours (Whisper sur le Mac, rien n\'est envoyé sur Internet)…', parent);
    xhr('POST', '/api/media/capture/' + c.id + '/transcribe', {}, function (e, r) {
      if (e || !r.ok) { st.className = 'warnbox'; st.textContent = (r && r.error) || e; transcriptEditor(parent, c); return; }
      var tries = 0;
      (function wait() {
        xhr('GET', '/api/media/captures', null, function (e2, d) {
          var x = d && find(d.captures, function (y) { return y.id === c.id; });
          if (x && x.transcriptStatus === 'terminé') { st.parentNode && st.parentNode.removeChild(st); transcriptEditor(parent, x); return; }
          if (x && x.transcriptStatus === 'erreur') { st.className = 'errbox'; st.textContent = 'Transcription en échec : ' + x.transcriptError + '. Saisie texte possible.'; transcriptEditor(parent, x); return; }
          if (++tries > 200) { st.textContent = 'Transcription trop longue, réessaie plus tard.'; return; }
          setTimeout(wait, 2000);
        });
      })();
    });
  }

  // Transcription modifiable : rien n'est envoyé sans une pression explicite.
  function transcriptEditor(parent, c) {
    var box = el('div', 'srcbox', null, parent);
    el('div', 'line', 'Texte (modifiable avant tout envoi) :', box);
    var ta = el('textarea', null, null, box); ta.value = c.transcript || '';
    var r = el('div', null, null, box);
    button(r, 'Garder ce texte sur le Mac', 'small', function () { xhr('POST', '/api/media/capture/' + c.id + '/note', { text: ta.value }, function (e) { toast(e ? 'Échec : ' + e : 'Texte gardé avec la capture', e ? 'err' : 'ok'); }); });
  }

  FACTORIES.recordings = function (box, cfg) {
    el('div', 'w-title', cfg.label, box);
    var list = el('div', 'list', null, box), alive = true, sig = '';
    function load() {
      xhr('GET', '/api/media/captures', null, function (e, d) {
        if (!alive) return; clear(list);
        if (e || !d) { el('div', 'line', 'Liste indisponible : ' + e, list); return; }
        el('div', 'sub', 'Dossier sur le Mac : ' + d.dir, list);
        if (!d.captures.length) el('div', 'line', 'Aucune capture pour le moment.', list);
        d.captures.slice(0, 12).forEach(function (c) {
          var row = el('div', 'row', null, list);
          el('div', 'name', ({ photo: '📷 ', video: '🎬 ', audio: '🎙 ' })[c.kind] + dateFr(c.createdAt), row);
          el('div', 'info', c.source + (c.status === 'interrompu' ? ' · interrompu (' + (c.reason || '') + ')' : ''), row).style.width = '45%';
          el('div', 'sub', c.draft ? 'brouillon' : 'conservée', row);
          tap(row, function () { openOverlay('Capture du ' + dateFr(c.createdAt), function (b) { showCapture(b, c, false); }); });
        });
      });
    }
    load();
    return {
      update: function (s) { var n = s.media ? s.media.active.length + ':' + (s.media.lastEnded && s.media.lastEnded.mic ? s.media.lastEnded.mic.at : '') + ':' + (s.media.lastEnded && s.media.lastEnded.cam ? s.media.lastEnded.cam.at : '') : ''; if (n !== sig) { sig = n; load(); } },
      destroy: function () { alive = false; }
    };
  };

  // ------------------------------------------------------------------ musique (app Musique du Mac)
  function musicCmd(op) { xhr('POST', '/api/music', { op: op, pressId: rid() }, function (e, r) { if (e || !r || !r.ok) toast('Musique : ' + ((r && r.error) || e), 'err'); }); }
  FACTORIES.music = function (box, cfg, w, h) {
    if (cfg.params && cfg.params.compact) {
      el('div', 'w-title', cfg.label, box);
      var mini = el('img', 'mthumb hidden', null, box), miniVer = null;
      var tt = el('div', 'tl1', '…', box); tt.style.bottom = 'auto'; tt.style.top = '30px'; tt.style.fontWeight = '600'; tt.style.fontSize = '15px';
      var ta = el('div', 'tl2', '', box); ta.style.bottom = 'auto'; ta.style.top = '50px';
      var rw = el('div', null, null, box); rw.style.cssText = 'position:absolute;left:8px;right:8px;bottom:6px;text-align:center';
      // Volume rapide : sortie audio générale du Mac (pas le micro), par pas de 6 %
      rw.style.textAlign = 'left';
      button(rw, '⏮', 'small', function () { musicCmd('previous'); });
      var bp = button(rw, '▶', 'small go', function () { musicCmd('playpause'); });
      button(rw, '⏭', 'small', function () { musicCmd('next'); });
      var vg = el('span', 'volgrp', null, rw);
      button(vg, '−', 'small vol', function () { runAction('volume-moins'); });
      var vol = el('span', 'volval', '–', vg);
      button(vg, '+', 'small vol', function () { runAction('volume-plus'); });
      // Toucher la pochette ou le titre ouvre la page Musique ; les boutons gardent leur rôle
      if (cfg.action) tap(box, function (ev) { if (ev && ev.target && rw.contains(ev.target)) return; runAction(cfg.action); });
      return { update: function (s) {
        var m = s.music; if (!m) return;
        var mt = s.metrics || {};
        vol.textContent = mt.volume === null || mt.volume === undefined ? '–' : (mt.muted ? 'coupé' : mt.volume + ' %');
        if (m.artwork !== miniVer) {
          miniVer = m.artwork;
          if (!m.artwork || !m.running) { mini.className = 'mthumb hidden'; tt.style.left = ta.style.left = '14px'; }
          else getTicket('artwork', function (k) { if (k) { mini.src = '/api/music/artwork?k=' + encodeURIComponent(k) + '&v=' + m.artwork; mini.className = 'mthumb'; tt.style.left = ta.style.left = '78px'; } });
        }
        if (!m.running) { tt.textContent = 'Musique fermée'; ta.textContent = '▶ pour lancer'; bp.textContent = '▶'; return; }
        tt.textContent = m.track || 'À l\'arrêt'; ta.textContent = m.artist || ''; bp.textContent = m.state === 'playing' ? '⏸' : '▶';
      } };
    }
    if (cfg.params && cfg.params.full) return musicFull(box, cfg, w, h);
    el('div', 'w-title', cfg.label, box);
    var p = el('div', 'panel', null, box);
    var big = false, art = null, artVer = null;
    var title = el('div', 'mtitle', '…', p), artist = el('div', 'sub', '', p);
    var bar = el('div', 'progress', null, p), fill = el('div', null, null, bar);
    var times = el('div', 'sub', '', p);
    var row = el('div', 'mrow', null, p);
    button(row, '⏮', 'mbtn', function () { musicCmd('previous'); });
    var bPlay = button(row, '▶', 'mbtn go', function () { musicCmd('playpause'); });
    button(row, '⏭', 'mbtn', function () { musicCmd('next'); });
    var last = null, timer = setInterval(tickPos, 1000);
    function tickPos() {
      if (!last || last.state !== 'playing' || !last.duration) return;
      var pos = Math.min(last.duration, last.position + (now() - last.t) / 1000);
      fill.style.width = Math.round(100 * pos / last.duration) + '%';
      times.textContent = dur(pos) + ' / ' + dur(last.duration);
    }
    return {
      update: function (s) {
        var m = s.music; if (!m) return; last = m;
        if (!m.running) { title.textContent = 'Musique fermée'; artist.textContent = '« ▶ » lance l\'app Musique du Mac'; fill.style.width = '0'; times.textContent = ''; bPlay.textContent = '▶'; return; }
        if (m.state === 'stopped' || !m.track) { title.textContent = 'À l\'arrêt'; artist.textContent = ''; } else { title.textContent = m.track; artist.textContent = (m.artist || '') + (m.album ? ' · ' + m.album : ''); }
        bPlay.textContent = m.state === 'playing' ? '⏸' : '▶';
        tickPos();
      },
      destroy: function () { clearInterval(timer); }
    };
  };

  // Lecteur complet (page Musique) : pochette, spectre en direct, progression tactile, boucle, aléatoire
  function musicFull(box, cfg, w, h) {
    el('div', 'w-title', cfg.label, box);
    var top = el('div', 'mftop', null, box);
    var art = el('img', 'mfart hidden', null, top), artPh = el('div', 'mfart ph', '♪', top), artVer = null;
    var info = el('div', 'mfinfo', null, top);
    var title = el('div', 'mftitle', '…', info), artist = el('div', 'mfartist', '', info), album = el('div', 'sub', '', info);
    var modes = el('div', 'mfmodes', null, info);
    var bShuf = button(modes, '🔀 Aléatoire', 'mtoggle', function () { musicCmd('shuffle'); });
    var bRep = button(modes, '🔁 Boucle : non', 'mtoggle', function () { musicCmd('repeat'); });
    var cv = el('canvas', 'mfspec', null, box), sw = w - 24, sh = Math.max(80, h - 192 - 142);   // zone propre, au-dessus de la progression
    cv.style.height = sh + 'px'; var ctx = setupCanvas(cv, sw, sh);
    var specNote = el('div', 'mfnote', '', box);
    var seekBar = el('div', 'mfseek', null, box), seekFill = el('div', 'mfseekfill', null, seekBar), seekKnob = el('div', 'mfknob', null, seekBar);
    var times = el('div', 'mftimes', null, box), tL = el('span', null, '0:00', times), tR = el('span', 'r', '0:00', times);
    var ctr = el('div', 'mfctr', null, box);
    button(ctr, '⏮', 'mround', function () { musicCmd('previous'); });
    var bPlay = button(ctr, '▶', 'mround main', function () { musicCmd('playpause'); });
    button(ctr, '⏭', 'mround', function () { musicCmd('next'); });
    var vg = el('span', 'volgrp mfvol', null, box);
    button(vg, '−', 'small vol', function () { runAction('volume-moins'); });
    var vol = el('span', 'volval', '–', vg);
    button(vg, '+', 'small vol', function () { runAction('volume-plus'); });
    var last = null, alive = true, bands = null, shown = [], specT = null, specBusy = false;
    for (var i = 0; i < 24; i++) shown.push(0);
    function pos() { if (!last || !last.duration) return 0; return Math.min(last.duration, last.position + (last.state === 'playing' ? (now() - last.t) / 1000 : 0)); }
    function seekFrom(clientX) {
      if (!last || !last.duration) return;
      var r = seekBar.getBoundingClientRect(), f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      xhr('POST', '/api/music/seek', { sec: Math.round(f * last.duration) }, function (e, res) { if (e || !res.ok) toast('Musique : ' + ((res && res.error) || e), 'err'); });
    }
    seekBar.addEventListener('touchend', function (e) { e.preventDefault(); seekFrom(e.changedTouches[0].clientX); }, false);
    seekBar.addEventListener('click', function (e) { seekFrom(e.clientX); }, false);
    // Plusieurs visualisations au choix, mémorisées sur l'iPad
    var VIS = [['barres', 'Barres'], ['miroir', 'Miroir'], ['leds', 'Égaliseur'], ['onde', 'Onde'], ['cercle', 'Cercle']];
    var visI = 0, peaks = [], st = store('specVis');
    for (var vi = 0; vi < VIS.length; vi++) if (VIS[vi][0] === st) visI = vi;
    for (var pk = 0; pk < 24; pk++) peaks.push(0);
    var bVis = button(modes, '✨ ' + VIS[visI][1], 'mtoggle on', function () {
      visI = (visI + 1) % VIS.length; store('specVis', VIS[visI][0]); bVis.textContent = '✨ ' + VIS[visI][1];
    });
    // Dégradés et colonne de LED préparés une seule fois (l'iPad 2 peine à les recréer à chaque image)
    var GR = null;
    function prep() {
      var base = sh * 0.82, g = ctx.createLinearGradient(0, 0, 0, base);
      g.addColorStop(0, '#ff2a8a'); g.addColorStop(0.55, '#8a5cff'); g.addColorStop(1, '#00f0ff');
      var gm = ctx.createLinearGradient(0, 0, 0, sh);
      gm.addColorStop(0, '#ff2a8a'); gm.addColorStop(0.5, '#00f0ff'); gm.addColorStop(1, '#ff2a8a');
      var n = 24, gap = 4, bw = (sw - gap * (n - 1)) / n, seg = 7, rows = Math.floor(base / seg);
      var led = D.createElement('canvas'); led.width = Math.ceil(bw); led.height = rows * seg;
      var lc = led.getContext('2d');
      for (var r = 0; r < rows; r++) { var f = r / rows; lc.fillStyle = f > 0.8 ? '#ff2a8a' : f > 0.55 ? '#ffc163' : '#00f0ff'; lc.fillRect(0, (rows - 1 - r) * seg + 1, led.width, seg - 2); }
      GR = { g: g, gm: gm, led: led, rows: rows, seg: seg };
    }
    var fpsN = 0, fpsT0 = 0, fpsMode = '';
    function fpsMeasure() {   // fluidité réelle, envoyée une fois par visualisation (diagnostic)
      var t = now(), m = VIS[visI][0];
      if (m !== fpsMode) { fpsMode = m; fpsN = 0; fpsT0 = t; return; }
      fpsN++;
      if (fpsT0 && t - fpsT0 > 5000) {
        xhr('POST', '/api/clientlog', { kind: 'boot', msg: 'spectre ' + m + ' : ' + Math.round(fpsN * 1000 / (t - fpsT0)) + ' images/s', where: 'musique' }, function () {});
        fpsT0 = 0;
      }
    }
    var skip = false;
    function draw() {
      if (!GR) prep();
      var n = 24, gap = 4, bw = (sw - gap * (n - 1)) / n, base = sh * 0.82, playing = last && last.state === 'playing', i;
      for (i = 0; i < n; i++) {
        var target = bands && playing ? bands[i] / 99 : 0.03;
        shown[i] += (target - shown[i]) * (target > shown[i] ? 0.85 : 0.35);
        peaks[i] = shown[i] > peaks[i] ? shown[i] : Math.max(0, peaks[i] - 0.02);
      }
      ctx.clearRect(0, 0, sw, sh);
      var mode = VIS[visI][0], x, hh;
      if (mode === 'barres') {
        ctx.fillStyle = GR.g;
        for (i = 0; i < n; i++) { hh = Math.max(2, shown[i] * base); ctx.fillRect(i * (bw + gap), base - hh, bw, hh); }
        ctx.fillStyle = 'rgba(0, 240, 255, .18)';
        for (i = 0; i < n; i++) { hh = Math.max(2, shown[i] * base); ctx.fillRect(i * (bw + gap), base + 3, bw, Math.min(sh - base - 3, hh * 0.35)); }
      } else if (mode === 'miroir') {
        var mid = sh / 2, bw2 = (sw - gap * (2 * n - 1)) / (2 * n);
        ctx.fillStyle = GR.gm;
        for (i = 0; i < n; i++) {   // graves au centre, aigus vers les bords
          hh = Math.max(2, shown[i] * mid * 0.95);
          ctx.fillRect(sw / 2 + gap / 2 + i * (bw2 + gap), mid - hh, bw2, hh * 2);
          ctx.fillRect(sw / 2 - gap / 2 - (i + 1) * bw2 - i * gap, mid - hh, bw2, hh * 2);
        }
      } else if (mode === 'leds') {
        var rows = GR.rows, seg = GR.seg, colH = rows * seg;
        ctx.fillStyle = '#ffffff';
        for (i = 0; i < n; i++) {
          x = Math.round(i * (bw + gap)); var lit = Math.round(shown[i] * rows) * seg;
          if (lit > 0) ctx.drawImage(GR.led, 0, colH - lit, GR.led.width, lit, x, base - lit, GR.led.width, lit);
          ctx.fillRect(x, base - Math.max(1, Math.round(peaks[i] * rows)) * seg - 2, bw, 3);   // crête qui retombe
        }
      } else if (mode === 'onde') {
        ctx.beginPath(); ctx.moveTo(0, base);
        var px = 0, py = base - Math.max(2, shown[0] * base * 0.95), step = sw / (n - 1);
        ctx.lineTo(px, py);
        for (i = 1; i < n; i++) { var nx = i * step, ny = base - Math.max(2, shown[i] * base * 0.95); ctx.quadraticCurveTo(px, py, (px + nx) / 2, (py + ny) / 2); px = nx; py = ny; }
        ctx.lineTo(px, py); ctx.lineTo(sw, base); ctx.closePath();
        ctx.globalAlpha = 0.45; ctx.fillStyle = GR.g; ctx.fill(); ctx.globalAlpha = 1;
        ctx.lineWidth = 3; ctx.strokeStyle = '#00f0ff'; ctx.stroke();
      } else {   // cercle : rayons autour d'un disque qui pulse avec les graves (3 tracés seulement)
        var cx = sw / 2, cy = sh / 2, R = Math.min(sw, sh) * 0.22, bass = (shown[0] + shown[1] + shown[2]) / 3, L = Math.min(sw, sh) * 0.26;
        ctx.beginPath(); ctx.arc(cx, cy, R * (0.8 + bass * 0.35), 0, Math.PI * 2); ctx.fillStyle = 'rgba(138, 92, 255, .35)'; ctx.fill();
        ctx.lineWidth = Math.max(3, (Math.PI * 2 * R) / (n * 2) - 3);
        var cols = ['#00f0ff', '#8a5cff', '#ff2a8a'];
        for (var c = 0; c < 3; c++) {
          ctx.beginPath();
          for (i = 0; i < n * 2; i++) {
            var k = i < n ? i : 2 * n - 1 - i; if ((k / 8 | 0) !== c) continue;
            var a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2, len = 4 + shown[k] * L, ca = Math.cos(a), sa = Math.sin(a);
            ctx.moveTo(cx + ca * R, cy + sa * R); ctx.lineTo(cx + ca * (R + len), cy + sa * (R + len));
          }
          ctx.strokeStyle = cols[c]; ctx.stroke();
        }
      }
    }
    // L'animation ne tourne que pendant la lecture (ou le temps que les barres retombent) : économie pour l'iPad 2
    function loopDraw() {
      if (!alive) return false;
      var moving = false; for (var j = 0; j < 24; j++) if (shown[j] > 0.04 || peaks[j] > 0.04) moving = true;
      var go_ = (last && last.state === 'playing') || moving;
      skip = !skip; if (LOWFX && skip) return go_;   // iPad 2 : une image sur deux (30 images/s régulières)
      fpsMeasure(); draw(); return go_;
    }
    animate(loopDraw);
    function pollSpec() {
      if (!alive) return;
      if (!last || last.state !== 'playing') { bands = null; specT = setTimeout(pollSpec, 1000); return; }
      if (specBusy) { specT = setTimeout(pollSpec, 100); return; }
      specBusy = true;
      xhr('GET', '/api/music/spectrum', null, function (e, d) {
        specBusy = false; if (!alive) return;
        if (d && d.error) specNote.textContent = '⚠ ' + d.error;
        else if (d && d.bands) { bands = d.bands; specNote.textContent = ''; }
        specT = setTimeout(pollSpec, LOWFX ? 70 : 30);
        animate(loopDraw);
      }, { timeout: 3000 });
    }
    pollSpec();
    var clock = setInterval(function () {
      if (!last || !last.duration) return;
      var p = pos(); seekFill.style.width = (100 * p / last.duration) + '%'; seekKnob.style.left = (100 * p / last.duration) + '%';
      tL.textContent = dur(p); tR.textContent = '-' + dur(last.duration - p);
    }, 500);
    return {
      update: function (s) {
        var mt = s.metrics || {};
        vol.textContent = mt.volume === null || mt.volume === undefined ? '–' : (mt.muted ? 'coupé' : mt.volume + ' %');
        var m = s.music; if (!m) return; last = m;
        if (!m.running) { title.textContent = 'Musique fermée'; artist.textContent = 'Touchez ▶ pour lancer l\'app Musique du Mac'; album.textContent = ''; bPlay.textContent = '▶'; return; }
        title.textContent = m.track || 'À l\'arrêt'; artist.textContent = m.artist || ''; album.textContent = m.album || '';
        bPlay.textContent = m.state === 'playing' ? '⏸' : '▶';
        if (m.shuffle) bShuf.classList.add('on'); else bShuf.classList.remove('on');
        bRep.textContent = '🔁 Boucle : ' + ({ off: 'non', all: 'la liste', one: 'ce morceau' })[m.repeat || 'off'];
        if (m.repeat && m.repeat !== 'off') bRep.classList.add('on'); else bRep.classList.remove('on');
        if (m.artwork !== artVer) {
          artVer = m.artwork;
          if (!m.artwork) { art.className = 'mfart hidden'; artPh.className = 'mfart ph'; }
          else getTicket('artwork', function (k) { if (k) { art.src = '/api/music/artwork?k=' + encodeURIComponent(k) + '&v=' + m.artwork; art.className = 'mfart'; artPh.className = 'mfart ph hidden'; } });
        }
      },
      destroy: function () { alive = false; clearTimeout(specT); clearInterval(clock); }
    };
  }

  // ------------------------------------------------------------------ sessions Claude Code (activité seulement, jamais le contenu)
  FACTORIES.claude = function (box, cfg) {
    el('div', 'w-title', cfg.label, box);
    var head = el('div', null, null, box); head.style.cssText = 'position:absolute;right:12px;top:4px';
    var big = el('span', 'big', '–', head); big.style.fontSize = '30px'; el('span', 'unit', 'active(s)', head);
    var list = el('div', 'list', null, box);
    return { update: function (s) {
      var c = s.claude; if (!c) return;
      big.textContent = c.active; clear(list);
      if (!c.sessions.length) { el('div', 'line', 'Aucune session Claude Code depuis une heure.', list); return; }
      c.sessions.forEach(function (x) {
        var row = el('div', 'row', null, list);
        var n = el('div', 'name', null, row); n.style.width = '64%'; el('span', 'dot ' + (x.active ? 'st-ok' : 'st-unknown'), null, n);
        var tt = el('span', null, x.title || 'Session sans titre', n); tt.style.fontWeight = '600';
        if (x.project && x.project.indexOf('dossier personnel') < 0) el('div', 'sub', x.project, n);
        el('div', 'info', (x.active ? '● active' : ago(x.lastActivity)) + (x.replies ? ' · ' + x.replies + ' rép. · ' + kfmt(x.outTokens) + ' jetons' : ''), row).style.width = '36%';
      });
    } };
  };

  // ------------------------------------------------------------------ tuile façon widget iPhone
  function tile(box, cfg, title, dest) {
    box.className += ' tile';
    el('div', 'w-title', title, box);
    var big = el('div', 'tbig', '–', box), l1 = el('div', 'tl1', '', box), l2 = el('div', 'tl2', '', box);
    tap(box, function () { if (cfg.action) runAction(cfg.action); else if (dest) go(dest); });
    return { big: big, l1: l1, l2: l2 };
  }

  FACTORIES.playlists = function (box, cfg) {
    el('div', 'w-title', cfg.label, box);
    var list = el('div', 'list', null, box), alive = true;
    function load() {
      xhr('GET', '/api/music/playlists', null, function (e, d) {
        if (!alive) return; clear(list);
        if (d && d.favorites && d.favorites.length) {   // favoris en tête : station, artistes, Replay
          el('div', 'sub', 'Favoris', list);
          d.favorites.forEach(function (f) {
            var row = el('div', 'row fav', null, list); el('div', 'name', f.label, row).style.width = '100%';
            tap(row, function () { toast('Musique : ' + f.label + '…', 'ok'); xhr('POST', '/api/music/favorite', { id: f.id }, function (e2, r) { toast(e2 || !r.ok ? 'Musique : ' + ((r && r.error) || e2) : r.message, e2 || !r.ok ? 'err' : 'ok'); }, { timeout: 25000 }); });
          });
          el('div', 'sub', 'Mes playlists', list);
        }
        if (e || !d) { el('div', 'warnbox', 'Playlists indisponibles. Ouvre l\'app Musique (▶) puis reviens.', list); button(list, 'Réessayer', 'small', load); return; }
        if (!d.playlists.length) { el('div', 'line', 'Aucune playlist (ou app Musique fermée : touche ▶).', list); button(list, 'Réessayer', 'small', load); return; }
        d.playlists.forEach(function (n) {
          var row = el('div', 'row', null, list); el('div', 'name', '🎵 ' + n, row).style.width = '100%';
          tap(row, function () { xhr('POST', '/api/music/playlist', { name: n }, function (e2, r) { toast(e2 || !r.ok ? 'Musique : ' + ((r && r.error) || e2) : r.message, e2 || !r.ok ? 'err' : 'ok'); }); });
        });
      });
    }
    load();
    return { destroy: function () { alive = false; } };
  };

  // Page Performances : programmes gourmands et détails du Mac (lus toutes les 10 s tant que la page est ouverte)
  function sysPoll(fn) {
    var alive = true, t = null;
    (function loop() { xhr('GET', '/api/sysinfo', null, function (e, d) { if (!alive) return; if (!e && d && d.t) fn(d); t = setTimeout(loop, d && d.t ? 10000 : 2000); }); })();
    return function () { alive = false; clearTimeout(t); };
  }
  FACTORIES.procs = function (box, cfg) {
    el('div', 'w-title', cfg.label, box);
    var list = el('div', 'list', null, box);
    var stop = sysPoll(function (d) {
      clear(list);
      d.procs.forEach(function (p) {
        var row = el('div', 'row', null, list);
        el('div', 'name', p.name, row).style.width = '58%';
        var c = el('div', 'info', num(p.cpu, 1) + ' % CPU', row); c.style.width = '22%'; c.className = 'info ' + (p.cpu > 80 ? 't-alert' : p.cpu > 40 ? 't-warn' : '');
        el('div', 'info', (p.memMB >= 1024 ? num(p.memMB / 1024, 1) + ' Go' : p.memMB + ' Mo'), row).style.width = '20%';
      });
    });
    return { destroy: stop };
  };
  FACTORIES.sysinfo = function (box, cfg) {
    el('div', 'w-title', cfg.label, box);
    var p = el('div', 'panel', null, box);
    var stop = sysPoll(function (d) {
      clear(p);
      d.disks.forEach(function (k) {
        el('div', 'line', '💾 ' + k.name + ' : ' + num(k.freeGB, 0) + ' Go libres sur ' + num(k.totalGB, 0) + ' Go', p);
        var bar = el('div', 'progress', null, p), f = el('div', null, null, bar); f.style.width = k.pct + '%'; if (k.pct > 90) f.style.background = '#ff4f9a';
      });
      el('div', 'line', '🌐 Réseau : ↓ ' + (d.net.rxKBs === null ? '…' : d.net.rxKBs + ' Ko/s') + '  ↑ ' + (d.net.txKBs === null ? '…' : d.net.txKBs + ' Ko/s'), p);
      if (d.battery) el('div', 'line', '🔋 Batterie : ' + d.battery.pct + ' % · ' + d.battery.state, p);
      el('div', 'line', '⚙️ Charge : ' + d.load.join(' / ') + ' (' + d.cores + ' cœurs)', p);
      el('div', 'line', '⏱ Allumé depuis ' + (d.uptimeH >= 48 ? Math.round(d.uptimeH / 24) + ' jours' : d.uptimeH + ' h'), p);
      el('div', 'sub', 'Mis à jour à ' + hhmmss(d.t), p);
    });
    return { destroy: stop };
  };

  // Applications du Dock du Mac, avec leurs vraies icônes : un toucher ouvre l'application sur le Mac
  FACTORIES.apps = function (box, cfg, w, h) {
    el('div', 'w-title', cfg.label, box);
    var grid = el('div', 'list appgrid', null, box), alive = true, tries = 0;
    function load() {
      xhr('GET', '/api/apps', null, function (e, d) {
        if (!alive) return; clear(grid);
        if (e || !d) { el('div', 'warnbox', 'Applications indisponibles : ' + e, grid); return; }
        getTicket('appicons', function (k) {
          var missing = 0;
          d.apps.forEach(function (a) {
            var t = el('div', 'appkey', null, grid);
            if (a.icon && k) { var im = el('img', 'appico', null, t); im.src = '/api/apps/icon/' + a.id + '?k=' + encodeURIComponent(k); }
            else { missing++; el('div', 'appico ph', a.name.charAt(0), t); }
            el('div', 'appname', a.name, t);
            tap(t, function () {
              t.classList.add('busy');
              xhr('POST', '/api/apps/open', { id: a.id }, function (e2, r) { t.classList.remove('busy'); toast(e2 || !r.ok ? 'Ouverture : ' + ((r && r.error) || e2) : r.message, e2 || !r.ok ? 'err' : 'ok'); });
            });
          });
          if (missing && tries++ < 5) setTimeout(load, 8000);   // icônes en cours d'extraction sur le Mac
        });
      });
    }
    load();
    return { destroy: function () { alive = false; } };
  };

  // File d'ordres clavier vers le Mac : envoyés dans l'ordre, un lot à la fois
  var kq = [], kbusy = false;
  function macKeys(ops) {
    kq = kq.concat(ops);
    if (kbusy) return;
    var batch = kq.splice(0, 60); if (!batch.length) return;
    kbusy = true;
    xhr('POST', '/api/mouse', { ops: batch }, function (e, r) { kbusy = false; if (e || !r || !r.ok) toast('Clavier : ' + ((r && r.error) || e), 'err'); if (kq.length) macKeys([]); }, { timeout: 8000 });
  }
  var SHORTCUTS = { copier: '⌘C Copier', coller: '⌘V Coller', couper: '⌘X Couper', annuler: '⌘Z Annuler', retablir: '⇧⌘Z Rétablir', tout: '⌘A Tout',
    enregistrer: '⌘S Enregistrer', rechercher: '⌘F Rechercher', spotlight: '⌘␣ Spotlight', appsuivante: '⌘⇥ App suivante', fermer: '⌘W Fermer', onglet: '⌘T Onglet',
    capture: '⇧⌘4 Capture', missioncontrol: 'Mission Control', echap: 'Échap', entree: '↵ Entrée', tab: '⇥ Tab', effacer: '⌫', suppr: '⌦ Suppr', espace: 'Espace',
    gauche: '←', droite: '→', haut: '↑', bas: '↓', motgauche: '⌥← Mot', motdroite: '⌥→ Mot', debut: '⇱ Début', fin: '⇲ Fin', pageprec: 'Page ↑', pagesuiv: 'Page ↓',
    bureau: 'Afficher le bureau', espacegauche: '⌃← Bureau préc.', espacedroite: '⌃→ Bureau suiv.', captureecran: '⇧⌘3 Écran entier', captureoptions: '⇧⌘5 Options capture',
    emoji: '⌃⌘␣ Emoji', forcerquitter: '⌥⌘⎋ Forcer à quitter', verrouiller: '🔒 Verrouiller', nouvellefenetre: '⌘N Nouvelle fenêtre', ouvrir: '⌘O Ouvrir', imprimer: '⌘P Imprimer',
    preferences: '⌘, Préférences', reduire: '⌘M Réduire', pleinecran: '⌃⌘F Plein écran', masquer: '⌘H Masquer', masquerautres: '⌥⌘H Masquer autres', quitter: '⌘Q Quitter l\'app',
    recharger: '⌘R Recharger', ongletsuivant: '⌃⇥ Onglet suiv.', ongletprecedent: '⌃⇧⇥ Onglet préc.', rouvrironglet: '⇧⌘T Rouvrir onglet', adresse: '⌘L Barre d\'adresse',
    zoomplus: '⌘+ Zoom +', zoommoins: '⌘− Zoom −', taillereelle: '⌘0 Taille réelle', retour: '⌘[ Retour', avancer: '⌘] Avancer', gras: '⌘B Gras', italique: '⌘I Italique', souligne: '⌘U Souligné' };
  var CONFIRM = { quitter: 1, verrouiller: 1, forcerquitter: 1 };   // second toucher obligatoire
  function shortcutRow(parent, names, cls) {
    var row = el('div', 'kbrow ' + (cls || ''), null, parent);
    names.forEach(function (n) {
      var b = button(row, SHORTCUTS[n] || n, 'small kb' + (CONFIRM[n] ? ' stop' : ''), function () {
        if (CONFIRM[n] && !b.__armed) { b.__armed = 1; b.textContent = 'Encore pour confirmer'; setTimeout(function () { b.__armed = 0; b.textContent = SHORTCUTS[n]; }, 3000); return; }
        b.__armed = 0; b.textContent = SHORTCUTS[n] || n; macKeys([['k', n]]);
      });
    });
    return row;
  }

  // Clavier du Mac : frappe directe depuis le clavier de l'iPad + raccourcis
  FACTORIES.keyboard = function (box, cfg) {
    el('div', 'w-title', cfg.label, box);
    var p = el('div', 'panel', null, box);
    var line = el('div', 'kbline', null, p);
    var inp = el('input', 'kbinput', null, line); inp.type = 'text'; inp.placeholder = 'Touchez ici et tapez : chaque lettre s\'écrit sur le Mac';
    inp.setAttribute('autocorrect', 'off'); inp.setAttribute('autocapitalize', 'off'); inp.setAttribute('autocomplete', 'off'); inp.setAttribute('spellcheck', 'false');
    var prev = '';
    inp.addEventListener('input', function () {
      var cur = inp.value, i = 0;
      while (i < prev.length && i < cur.length && prev.charAt(i) === cur.charAt(i)) i++;
      var del = prev.length - i, add = cur.slice(i), ops = [];
      if (del > 0) ops.push(['k', 'effacer', del]);
      if (add) ops.push(['t', add]);
      if (ops.length) macKeys(ops);
      prev = cur;
      if (cur.length > 200) { inp.value = ''; prev = ''; }
    }, false);
    inp.addEventListener('keydown', function (e) {
      if (e.keyCode === 13) { e.preventDefault(); macKeys([['k', 'entree']]); inp.value = ''; prev = ''; }
      else if (e.keyCode === 8 && !inp.value) { macKeys([['k', 'effacer']]); }
    }, false);
    button(line, 'Vider', 'small', function () { inp.value = ''; prev = ''; });
    button(line, '🖱', 'small', function () { go('trackpad'); });
    el('div', 'sub', 'Le texte s\'écrit là où se trouve le curseur sur le Mac. Les raccourcis ci-dessous agissent sur l\'application au premier plan.', p);
    var GROUPS = [
      ['Texte', [['entree', 'tab', 'effacer', 'suppr', 'echap', 'espace'], ['copier', 'coller', 'couper', 'tout', 'annuler', 'retablir'], ['enregistrer', 'rechercher', 'motgauche', 'motdroite', 'debut', 'fin'], ['gauche', 'haut', 'bas', 'droite', 'pageprec', 'pagesuiv']]],
      ['Système', [['missioncontrol', 'bureau', 'espacegauche', 'espacedroite', 'spotlight', 'appsuivante'], ['captureecran', 'capture', 'captureoptions', 'emoji', 'forcerquitter', 'verrouiller']]],
      ['Applis', [['nouvellefenetre', 'onglet', 'ouvrir', 'enregistrer', 'imprimer', 'preferences'], ['reduire', 'pleinecran', 'masquer', 'masquerautres', 'fermer', 'quitter']]],
      ['😀 Emoji', 'emoji'],
      ['Navigateur', [['retour', 'avancer', 'recharger', 'adresse', 'onglet', 'rouvrironglet'], ['ongletprecedent', 'ongletsuivant', 'zoommoins', 'zoomplus', 'taillereelle', 'fermer'], ['gras', 'italique', 'souligne', 'copier', 'coller', 'annuler']]]
    ];
    // Onglet Emoji : grille par thèmes, les plus utilisés remontent dans « Fréquents » (mémorisés sur l'iPad)
    // Uniquement des emojis affichables par iOS 9 (Unicode 8 au plus) : les plus récents seraient des cases vides sur l'iPad 2
    var EMOJI = {
      'Smileys': '😀 😃 😄 😁 😆 😅 😂 😊 😇 🙂 🙃 😉 😍 😘 😗 😋 😜 😎 🤓 🤗 🤔 😐 😏 🙄 😬 😴 😷 🤒 😱 😢 😭 😤 😡 😠 😳 😈 👻 🤖 💩',
      'Gestes': '👍 👎 👌 ✌️ 👏 🙌 🙏 💪 👋 👉 👈 👆 👇 ☝️ ✋ 🖐 ✊ 👊 ✍️ 👀 💅 🤘',
      'Cœurs': '❤️ 💛 💚 💙 💜 💖 💗 💓 💕 💞 💘 💔 💯 ✨ 💫 ⭐ 🌟 🔥 💥 🎀',
      'Travail': '✅ ☑️ ❌ ⚠️ 🚨 📌 📎 📝 📄 📊 📈 📉 🗂 📁 📅 ⏰ ⏳ 💡 🔧 🛠 🔒 🔑 💻 🖥 📱 ☎️ 📞 ✉️ 📧 💬 🚀 🎯 🏆 💼 💶 💰 🤖',
      'Nature et fête': '☀️ ⛅ ☁️ 🌧 ⛈ ❄️ 🌈 🌊 🌸 🌻 🌹 🍀 🌴 🐶 🐱 🦄 🍕 🍔 🌮 🍰 ☕ 🍷 🍾 🎉 🎊 🎁 🎂 🎄 🎵 🎬 ✈️ 🚗 🚕 🏖',
      'Symboles': '➡️ ⬅️ ⬆️ ⬇️ ↩️ 🔄 ➕ ➖ ✖️ ➗ ❓ ❗ ‼️ 🆕 🆗 🔴 🔵 ⚫ ⚪ 🔶 🔷 ✔️ ©️ ®️ ™️ 💲 💱'
    };
    // Safari iOS 9 dessine les emojis bien plus petits que la police demandée : on les dessine dans un canevas,
    // on recadre sur l'encre réelle et on l'agrandit pour remplir la case (image mise en cache).
    var emoCache = {}, emoInk = '';
    function emojiPic(e) {
      if (emoCache[e] !== undefined) return emoCache[e];
      var out = null;
      try {
        // Deux façons de dessiner : police 64 px, ou police 16 px agrandie 4 fois par le canevas.
        // On garde celle qui donne le plus grand dessin (le plus net une fois mis à la taille de la case).
        var S = 128, best = null, tries = [[64, 1], [16, 4], [32, 2]], inks = [];
        for (var t = 0; t < tries.length; t++) {
          var c = D.createElement('canvas'); c.width = S; c.height = S;
          var x = c.getContext('2d');
          x.scale(tries[t][1], tries[t][1]);
          x.font = tries[t][0] + 'px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
          x.fillText(e, S / 2 / tries[t][1], S / 2 / tries[t][1]);
          var d = x.getImageData(0, 0, S, S).data, x0 = S, y0 = S, x1 = -1, y1 = -1;
          for (var yy = 0; yy < S; yy++) for (var xx = 0; xx < S; xx++) {
            if (d[(yy * S + xx) * 4 + 3] > 8) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy; }
          }
          inks.push(x1 >= x0 ? (x1 - x0 + 1) : 0);
          if (x1 >= x0 && (!best || x1 - x0 > best.x1 - best.x0)) best = { c: c, x0: x0, y0: y0, x1: x1, y1: y1 };
        }
        if (!emoInk) emoInk = inks.join('/');
        if (best) {
          var c = best.c, x0 = best.x0, y0 = best.y0, x1 = best.x1, y1 = best.y1;
          var w = x1 - x0 + 1, h = y1 - y0 + 1, T = 64, f = Math.min(T / w, T / h);
          var o = D.createElement('canvas'); o.width = T; o.height = T;
          var ox = o.getContext('2d');
          ox.drawImage(c, x0, y0, w, h, (T - w * f) / 2, (T - h * f) / 2, w * f, h * f);
          out = o.toDataURL('image/png');
        }
      } catch (err) { out = null; }
      emoCache[e] = out;
      return out;
    }
    function emojiZone(zone) {
      var freq = {}; try { freq = JSON.parse(store('emojiFreq') || '{}'); } catch (e) { freq = {}; }
      var cats = ['Fréquents'].concat(Object.keys(EMOJI)), sub = el('div', 'emotabs', null, zone), grid = el('div', 'emogrid', null, zone);
      function showCat(c) {
        clear(grid); store('emoCat', c);
        var list = c === 'Fréquents' ? Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; }).slice(0, 40) : EMOJI[c].split(' ');
        if (!list.length) el('div', 'sub', 'Les emojis que tu utilises apparaîtront ici.', grid);
        list.forEach(function (e) {
          var k = el('span', 'emokey', null, grid), src = emojiPic(e);
          if (src) { var im = el('img', 'emoimg', null, k); im.src = src; im.alt = e; } else el('span', 'emog', e, k);
          tap(k, function () { macKeys([['t', e]]); freq[e] = (freq[e] || 0) + 1; store('emojiFreq', JSON.stringify(freq)); });
        });
        var bs = sub.childNodes; for (var i = 0; i < bs.length; i++) { if (bs[i].textContent === c) bs[i].classList.add('sel'); else bs[i].classList.remove('sel'); }
      }
      cats.forEach(function (c) { button(sub, c, 'small', function () { showCat(c); }); });
      setTimeout(function () {   // diagnostic : rendu des emojis sur l'iPad
        var k = grid.querySelector('.emokey'); if (!k || !k.firstChild) return;
        xhr('POST', '/api/clientlog', { kind: 'boot', msg: 'emoji grille : ' + (k.firstChild.tagName === 'IMG' ? 'image ' + k.firstChild.offsetWidth + 'x' + k.firstChild.offsetHeight + ', encre ' + emoInk : 'texte (dessin indisponible)') + ', case ' + k.offsetWidth + 'x' + k.offsetHeight, where: 'emoji' }, function () {});
      }, 800);
      showCat(store('emoCat') || (Object.keys(freq).length ? 'Fréquents' : 'Smileys'));
    }
    var tabs = el('div', 'kbtabs win', null, p), zone = el('div', null, null, p), tabBtns = [];
    function show(i) {
      store('kbTab', String(i)); clear(zone);
      tabBtns.forEach(function (b, j) { if (j === i) b.classList.add('sel'); else b.classList.remove('sel'); });
      if (GROUPS[i][1] === 'emoji') emojiZone(zone); else GROUPS[i][1].forEach(function (r) { shortcutRow(zone, r); });
    }
    GROUPS.forEach(function (g, i) { tabBtns.push(button(tabs, g[0], '', function () { show(i); })); });
    show(Math.min(GROUPS.length - 1, Number(store('kbTab') || 0)));
    return {};
  };

  // Trackpad : un doigt = pointeur, toucher = clic, deux doigts = défilement (toucher à deux doigts = clic droit)
  FACTORIES.trackpad = function (box, cfg, w, h) {
    el('div', 'w-title', cfg.label, box);
    shortcutRow(box, ['copier', 'coller', 'annuler', 'tout', 'appsuivante', 'spotlight', 'echap', 'entree'], 'tptop');
    var pad = el('div', 'tpad', null, box);
    el('div', 'tphint', 'Glisser un doigt : pointeur · Toucher : clic · Deux doigts : défiler · Toucher à deux doigts : clic droit', pad);
    var bar = el('div', 'tpbar', null, box);
    var speed = Number(store('tpSpeed') || 2), pending = [], acc = { x: 0, y: 0, s: 0, sx: 0 }, inflight = false, alive = true, dragOn = false;
    function queue(op) { pending.push(op); flush(); }
    function flush() {
      if (inflight || !alive) return;
      var ops = pending; pending = [];
      if (Math.abs(acc.x) >= 1 || Math.abs(acc.y) >= 1) { ops.push(['m', Math.round(acc.x), Math.round(acc.y)]); acc.x -= Math.round(acc.x); acc.y -= Math.round(acc.y); }
      if (Math.abs(acc.s) >= 1 || Math.abs(acc.sx) >= 1) { ops.push(['s', Math.round(acc.s), Math.round(acc.sx)]); acc.s = 0; acc.sx = 0; }
      if (!ops.length) return;
      inflight = true;
      xhr('POST', '/api/mouse', { ops: ops }, function (e, r) {
        inflight = false;
        if (e || !r || !r.ok) { toast('Trackpad : ' + ((r && r.error) || e), 'err'); return; }
        if (pending.length || Math.abs(acc.x) >= 1 || Math.abs(acc.y) >= 1 || Math.abs(acc.s) >= 1) flush();
      }, { timeout: 5000 });
    }
    var t0 = 0, moved = 0, lx = 0, ly = 0, fingers = 0, lastTap = 0;
    pad.addEventListener('touchstart', function (e) {
      e.preventDefault();
      fingers = e.touches.length; t0 = now(); moved = 0;
      lx = e.touches[0].clientX; ly = e.touches[0].clientY;
      pad.classList.add('on');
    }, false);
    pad.addEventListener('touchmove', function (e) {
      e.preventDefault();
      var x = e.touches[0].clientX, y = e.touches[0].clientY, dx = x - lx, dy = y - ly; lx = x; ly = y;
      moved += Math.abs(dx) + Math.abs(dy);
      fingers = Math.max(fingers, e.touches.length);
      if (e.touches.length >= 2) { acc.s += -dy * 3; acc.sx += -dx * 3; }
      else { var a = speed * (1 + Math.min(3, (Math.abs(dx) + Math.abs(dy)) / 12)); acc.x += dx * a; acc.y += dy * a; }
      flush();
    }, false);
    pad.addEventListener('touchend', function (e) {
      e.preventDefault();
      if (e.touches.length) return;
      pad.classList.remove('on');
      if (now() - t0 < 250 && moved < 10) {
        if (fingers >= 2) queue(['c', 'r']);
        else if (now() - lastTap < 350) { queue(['c', 'd']); lastTap = 0; }
        else { queue(['c', 'l']); lastTap = now(); }
      }
    }, false);
    // Souris (aperçu sur le Mac)
    var md = false;
    pad.addEventListener('mousedown', function (e) { md = true; lx = e.clientX; ly = e.clientY; t0 = now(); moved = 0; }, false);
    pad.addEventListener('mousemove', function (e) { if (!md) return; var dx = e.clientX - lx, dy = e.clientY - ly; lx = e.clientX; ly = e.clientY; moved += Math.abs(dx) + Math.abs(dy); acc.x += dx * speed; acc.y += dy * speed; flush(); }, false);
    pad.addEventListener('mouseup', function () { md = false; if (now() - t0 < 250 && moved < 5) queue(['c', 'l']); }, false);
    button(bar, 'Clic', 'go', function () { queue(['c', 'l']); });
    button(bar, 'Clic droit', '', function () { queue(['c', 'r']); });
    button(bar, 'Double-clic', '', function () { queue(['c', 'd']); });
    var bDrag = button(bar, 'Glisser-déposer : non', '', function () { dragOn = !dragOn; queue(['d', dragOn ? 'down' : 'up']); bDrag.textContent = 'Glisser-déposer : ' + (dragOn ? 'OUI (bouton maintenu)' : 'non'); if (dragOn) bDrag.classList.add('stop'); else bDrag.classList.remove('stop'); });
    button(bar, '⌨ Clavier', '', function () { go('clavier'); });
    var sp = el('span', 'tpspeed', null, bar);
    button(sp, '−', 'small vol', function () { speed = Math.max(0.5, speed - 0.5); store('tpSpeed', String(speed)); sv.textContent = 'vitesse ' + speed; });
    var sv = el('span', 'volval', 'vitesse ' + speed, sp);
    button(sp, '+', 'small vol', function () { speed = Math.min(6, speed + 0.5); store('tpSpeed', String(speed)); sv.textContent = 'vitesse ' + speed; });
    return { destroy: function () { alive = false; if (dragOn) xhr('POST', '/api/mouse', { ops: [['d', 'up']] }, function () {}); } };
  };

  // Sessions Codex (nom donné par Codex, date, jetons)
  FACTORIES.codex = function (box, cfg) {
    el('div', 'w-title', cfg.label, box);
    var list = el('div', 'list', null, box);
    return { update: function (s) {
      var c = s.codex; clear(list);
      if (!c) { el('div', 'line', 'Lecture…', list); return; }
      if (c.error) { el('div', 'warnbox', c.error, list); return; }
      if (!c.sessions.length) { el('div', 'line', 'Aucune session Codex sur 7 jours.', list); return; }
      c.sessions.forEach(function (x) {
        var row = el('div', 'row', null, list);
        var n = el('div', 'name', null, row); n.style.width = '64%'; el('span', 'dot ' + (x.active ? 'st-ok' : 'st-unknown'), null, n);
        el('span', null, x.title, n).style.fontWeight = '600';
        el('div', 'info', (x.active ? '● active' : ago(x.lastActivity)) + (x.tokens ? ' · ' + kfmt(x.tokens) + ' jetons' : ''), row).style.width = '36%';
      });
    } };
  };

  // Tuile Systèmes : disponibles / en alerte / inconnus, chaque chiffre ouvre la liste filtrée
  FACTORIES.systems = function (box, cfg) {
    box.className += ' tile';
    el('div', 'w-title', cfg.label, box);
    var cells = {};
    [['ok', 'disponibles', '#7de3a8'], ['alert', 'en alerte', '#ff4f9a'], ['unknown', 'inconnus', '#9fb3d1']].forEach(function (x, i) {
      var c = el('div', 'scell', null, box); c.style.left = (4 + i * 32) + '%';
      var n = el('div', 'snum', '–', c); n.style.color = x[2]; el('div', 'slbl', x[1], c);
      tap(c, function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); box._skip = now(); openServiceList(x[0]); });
      cells[x[0]] = n;
    });
    tap(box, function () { if (now() - (box._skip || 0) > 600) go('surveillance'); });   // hors des trois chiffres : page Surveillance
    var last = {};
    return { update: function (s) {
      var c = s.counts || {};
      ['ok', 'alert', 'unknown'].forEach(function (k) { cells[k].textContent = c[k] === undefined ? '–' : c[k]; });
      if (c.alert > (last.alert || 0)) { box.classList.remove('pulse'); void box.offsetWidth; box.classList.add('pulse'); }
      last = c;
    } };
  };

  // Claude et Codex (usage du jour), façon PhoneBox
  function kfmt(n) { return n >= 1e6 ? num(n / 1e6, 1) + ' M' : n >= 1e3 ? num(n / 1e3, 0) + ' k' : String(n); }
  FACTORIES.ai = function (box, cfg) {
    var t = tile(box, cfg, cfg.label, 'desk');
    return { update: function (s) {
      var a = s.ai, c = s.claude;
      if (!a) { t.big.textContent = '…'; return; }
      t.big.textContent = (c ? c.active : 0) + (a.codex.active ? ' + ' + a.codex.active : '');
      t.big.style.color = '#00C4D9';
      t.l1.textContent = 'Claude : ' + (c ? c.active : 0) + ' active(s) · ' + a.claude.replies + ' réponses · ' + kfmt(a.claude.outTokens) + ' jetons générés';
      t.l2.textContent = 'Codex : ' + a.codex.active + ' active(s) · ' + a.codex.sessions + ' session(s) du jour · ' + kfmt(a.codex.tokens) + ' jetons';
    } };
  };

  // ------------------------------------------------------------------ alertes à l'écran (bandeau + flash + bip)
  var audioCtx = null, unlockTried = false, lastAlertSig = null, knownAlerts = null;
  function unlockAudio() {
    if (audioCtx || unlockTried) return;
    unlockTried = true;   // une seule tentative, jamais en boucle
    var AC = W.AudioContext || W.webkitAudioContext; if (!AC) return;
    try { audioCtx = new AC(); var b = audioCtx.createBuffer(1, 1, 22050), s = audioCtx.createBufferSource(); s.buffer = b; s.connect(audioCtx.destination); if (s.start) s.start(0); else s.noteOn(0); } catch (e) { audioCtx = null; }
  }
  // Plus de déverrouillage automatique du son à chaque toucher (affichait l'icône de sonnerie d'iOS en boucle sur l'iPad 2).
  // Le bip des alertes s'active une fois, volontairement, dans ☰ Pages.
  function beep() {
    if (!audioCtx || store('alertSound') !== '1') return;
    try {
      [0, 0.35].forEach(function (d) {
        var o = audioCtx.createOscillator(), g = audioCtx.createGain(), t = audioCtx.currentTime + d;
        o.frequency.value = 880; o.connect(g); g.connect(audioCtx.destination);
        g.gain.setValueAtTime(0.25, t); g.gain.linearRampToValueAtTime(0, t + 0.25);
        if (o.start) { o.start(t); o.stop(t + 0.26); } else { o.noteOn(t); o.noteOff(t + 0.26); }
      });
    } catch (e) { /* son indisponible */ }
  }
  function ackAlert(id, cb) { xhr('POST', '/api/alerts/ack', { id: id }, function () { if (cb) cb(); }); }
  function showAlerts() {
    var list = (STATE && STATE.alerts) || [];
    openOverlay('Alertes (' + list.length + ')', function (b) {
      if (!list.length) el('div', 'line t-ok', '✓ Aucune alerte en cours.', b);
      list.forEach(function (a) {
        var box = el('div', 'alertrow lv-' + a.level + (a.acked ? ' acked' : ''), null, b);
        el('div', 'atitle', ({ critique: '🔴 ', attention: '🟠 ', info: '🔵 ' })[a.level] + a.title, box);
        el('div', 'sub', (a.detail ? a.detail + ' · ' : '') + 'depuis ' + hhmm(a.since) + (a.acked ? ' · vue' : ''), box);
        if (a.media) button(box, '■ Arrêter cette capture', 'small stop', function () { xhr('POST', '/api/media/stop', { id: a.media }, function () { toast('Capture arrêtée', 'ok'); closeOverlay(); }); });
        else if (!a.acked) button(box, 'J\'ai vu', 'small', function () { ackAlert(a.id, function () { box.className += ' acked'; }); });
      });
      if (list.length) button(b, 'Tout marquer comme vu', 'small', function () { ackAlert('*', closeOverlay); });
    });
  }
  tap($('alertbar'), showAlerts);
  function updateAlerts(s) {
    var list = s.alerts || [], pending = list.filter(function (a) { return !a.acked; });
    var bar = $('alertbar');
    var sig = pending.map(function (a) { return a.id; }).join('|');
    var visible = pending.length > 0;
    if (visible !== !bar.classList.contains('hidden')) { bar.className = visible ? '' : 'hidden'; $('page').style.top = visible ? '102px' : '62px'; if (CFG) go(currentPage, true); }
    if (visible) {
      var top = pending[0];
      bar.className = 'lv-' + top.level;
      bar.textContent = ({ critique: '🔴 ', attention: '🟠 ', info: '🔵 ' })[top.level] + top.title + (pending.length > 1 ? '  (+' + (pending.length - 1) + ' autre' + (pending.length > 2 ? 's' : '') + ')' : '') + '   · toucher pour voir';
    }
    // Nouvelle alerte critique : flash plein écran + bip (pas au tout premier chargement)
    if (knownAlerts) {
      var fresh = pending.filter(function (a) { return !knownAlerts[a.id] && a.level !== 'info'; });
      if (fresh.length) {
        var f = $('flash'); f.textContent = fresh[0].title; f.className = 'lv-' + fresh[0].level;
        setTimeout(function () { f.className = 'hidden'; }, animMode === 'desactive' ? 4000 : 6000);
        if (fresh[0].level === 'critique') beep();
      }
    }
    knownAlerts = {}; list.forEach(function (a) { knownAlerts[a.id] = 1; });
    lastAlertSig = sig;
  }
  tap($('flash'), function () { $('flash').className = 'hidden'; showAlerts(); });

  // ------------------------------------------------------------------ éphéméride et météo (en-tête)
  var JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'], MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  function updateEph(s) {
    var d = new Date(), e = s.eph || {}, w = s.weather;
    var txt = JOURS[d.getDay()] + ' ' + d.getDate() + ' ' + MOIS[d.getMonth()] + (e.saint ? ' · St ' + e.saint : '') + ' · S' + (e.week || '');
    if (w && !isNaN(w.temp)) txt += '   ' + w.icon + ' ' + w.temp + '° ' + w.ville + ' (' + w.min + '/' + w.max + '°)' + (w.sunrise ? ' · ☀ ' + w.sunrise.replace(':', 'h') + '–' + w.sunset.replace(':', 'h') : '');
    $('h-eph').textContent = txt;
  }
  tap($('h-center'), function () {
    var s = STATE || {}, e = s.eph || {}, w = s.weather;
    openOverlay('Éphéméride et météo', function (b) {
      var d = new Date();
      el('div', 'bsyn', JOURS[d.getDay()] + ' ' + d.getDate() + ' ' + MOIS[d.getMonth()] + ' ' + d.getFullYear() + ' · jour ' + e.dayOfYear + ' · semaine ' + e.week + (e.saint ? ' · bonne fête aux ' + e.saint : ''), b);
      if (e.citation) el('div', 'answer', '« ' + e.citation + ' »' + (e.auteur ? '  — ' + e.auteur : ''), b);
      if (w) {
        if (w.error) el('div', 'warnbox', w.error, b);
        el('div', 'line', w.icon + ' ' + w.ville + ' : ' + w.desc + ', ' + w.temp + ' °C, vent ' + w.wind + ' km/h, min ' + w.min + ' °C, max ' + w.max + ' °C', b);
        el('div', 'line', '☀ Lever ' + w.sunrise + ' · coucher ' + w.sunset, b);
        if (w.tomorrow && w.tomorrow.icon) el('div', 'line', 'Demain : ' + w.tomorrow.icon + ' ' + w.tomorrow.desc + ', ' + w.tomorrow.min + '/' + w.tomorrow.max + ' °C', b);
        el('div', 'sub', 'Météo Open-Meteo, mise à jour ' + hhmm(w.t), b);
      }
    });
  });

  // ------------------------------------------------------------------ horloge
  function clock() { $('h-clock').textContent = hhmm(now()); if (!online && lastContact) setConn(false); }
  setInterval(clock, 1000); clock();

  D.body.addEventListener('touchstart', function () {}, false);   // active :active sur iOS
  if (W.navigator.standalone) D.body.className += ' standalone';
  boot();
})();
