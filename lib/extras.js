'use strict';
// Fonctions « desk » façon PhoneBox : musique (app Musique du Mac), sessions Claude Code actives,
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const U = require('./util');

let getConf = function () { return {}; };
let changed = function () {};
const state = {
  music: { available: null, running: false, t: 0 },
  claude: { sessions: [], active: 0, recent: 0, t: 0 },
  ai: null,
  weather: null,
  codex: null
};
// Lectures locales facultatives (désactivées par défaut) : connectors.local = { claude: true, codex: true }
function localOn(k) { const l = getConf().local || {}; return l[k] === true; }

// ---------- musique : scripts AppleScript figés, l'app Musique n'est jamais lancée par une simple lecture d'état
const MUSIC_STATUS = [
  'if application "Music" is not running then return "off"',
  'tell application "Music"',
  'set pstate to player state as text',
  'set sh to (shuffle enabled as text)', 'set rp to "off"',
  'end tell',
  'try',
  'tell application "System Events" to tell process "Music"',
  'set mm to menu 1 of menu item "Répétition" of menu 1 of menu bar item "Commandes" of menu bar 1',
  'if value of attribute "AXMenuItemMarkChar" of menu item "Tous" of mm is not missing value then set rp to "all"',
  'if value of attribute "AXMenuItemMarkChar" of menu item "Morceau seul" of mm is not missing value then set rp to "one"',
  'end tell',
  'end try',
  'tell application "Music"',
  'if pstate is "stopped" then return "stopped||||||" & (sound volume as text) & "|" & rp & "|" & sh',
  'set t to current track',
  'return pstate & "|" & (name of t) & "|" & (artist of t) & "|" & (album of t) & "|" & ((player position as integer) as text) & "|" & ((duration of t as integer) as text) & "|" & (sound volume as text) & "|" & rp & "|" & sh',
  'end tell'
];
const MUSIC_OPS = {
  // À l'arrêt sans morceau en cours, « lecture » démarre la bibliothèque (sinon rien ne se passe).
  playpause: ['tell application "Music"', 'if player state is stopped then', 'play library playlist 1', 'else', 'playpause', 'end if', 'end tell'],
  play: ['tell application "Music"', 'if player state is stopped then', 'play library playlist 1', 'else', 'play', 'end if', 'end tell'],
  pause: ['if application "Music" is running then tell application "Music" to pause'],
  next: ['if application "Music" is running then tell application "Music" to next track'],
  previous: ['if application "Music" is running then tell application "Music" to previous track'],
  louder: ['if application "Music" is running then tell application "Music" to set sound volume to (sound volume + 10)'],
  quieter: ['if application "Music" is running then tell application "Music" to set sound volume to (sound volume - 10)'],
  // Boucle par le menu Commandes › Répétition (AppleScript « song repeat » ne relit pas l'état réel)
  repeat: ['tell application "System Events" to tell process "Music"',
    'set mm to menu 1 of menu item "Répétition" of menu 1 of menu bar item "Commandes" of menu bar 1',
    'set cur to "Désactivée"',
    'if value of attribute "AXMenuItemMarkChar" of menu item "Tous" of mm is not missing value then set cur to "Tous"',
    'if value of attribute "AXMenuItemMarkChar" of menu item "Morceau seul" of mm is not missing value then set cur to "Morceau seul"',
    'if cur is "Désactivée" then', 'click menu item "Tous" of mm', 'else if cur is "Tous" then', 'click menu item "Morceau seul" of mm', 'else', 'click menu item "Désactivée" of mm', 'end if',
    'end tell'],
  shuffle: ['tell application "Music" to set shuffle enabled to not shuffle enabled']
};
function osa(lines, cb) {
  const a = []; lines.forEach(function (l) { a.push('-e', l); });
  cp.execFile('/usr/bin/osascript', a, { timeout: 6000 }, function (e, out, err) { cb(e ? new Error(String(err || e.message).replace(/^.*execution error: /, '').slice(0, 160)) : null, String(out || '').trim()); });
}
function refreshMusic() {
  osa(MUSIC_STATUS, function (e, out) {
    const prev = JSON.stringify(state.music);
    if (e) state.music = { available: true, running: false, error: e.message, t: Date.now() };
    else if (/^stopped/.test(out)) { const q = out.split('|'); state.music = { available: true, running: true, state: 'stopped', volume: Number(q[6]), repeat: q[7] || 'off', shuffle: q[8] === 'true', t: Date.now() }; }
    else if (out === 'off') state.music = { available: true, running: false, t: Date.now() };
    else {
      const p = out.split('|');
      state.music = { available: true, running: true, state: p[0], track: p[1] || null, artist: p[2] || null, album: p[3] || null,
        position: Number(p[4]) || 0, duration: Number(p[5]) || 0, volume: Number(p[6]), repeat: p[7] || 'off', shuffle: p[8] === 'true', t: Date.now() };
    }
    const cmp = Object.assign({}, state.music, { t: 0, position: 0 });
    const art = JSON.parse(prev).artwork; if (state.music.artwork === undefined) state.music.artwork = art || null;
    refreshArtwork();
    if (JSON.stringify(Object.assign(JSON.parse(prev), { t: 0, position: 0, artwork: 0 })) !== JSON.stringify(Object.assign(cmp, { artwork: 0 }))) changed();
  });
}
// Playlists de l'app Musique (noms seulement, cache 5 min) et pochette du morceau en cours (JPEG 300 px, fichier local).
let playlists = { list: [], t: 0 };
function musicPlaylists(cb) {
  if (Date.now() - playlists.t < 300000 && playlists.list.length) return cb(null, playlists.list);
  cp.execFile('/usr/bin/osascript', ['-e', 'if application "Music" is not running then return ""', '-e', 'tell application "Music" to get name of every user playlist whose smart is false or smart is true'], { timeout: 10000 }, function (e, out) {
    if (e) return cb(new Error('playlists indisponibles'));
    playlists = { list: String(out).trim() ? String(out).trim().split(', ').slice(0, 80) : [], t: Date.now() };
    cb(null, playlists.list);
  });
}
// Le nom est passé en argument (argv) : jamais inséré dans le texte du script.
function playPlaylist(name, cb) {
  if (playlists.list.indexOf(name) < 0) return cb(new Error('playlist inconnue'));
  cp.execFile('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'set n to item 1 of argv', '-e', 'tell application "Music"', '-e', 'set p to (first user playlist whose name is n)', '-e', 'play p', '-e', 'end tell', '-e', 'end run', name], { timeout: 10000 }, function (e, out, err) {
    if (e) { U.log('warn', 'playlist en échec', { e: String(err || e.message).replace(/^.*execution error: /, '').slice(0, 160) }); return cb(new Error('lecture impossible')); }
    setTimeout(refreshMusic, 500); cb(null, { message: 'Playlist « ' + name + ' » lancée' });
  });
}
// Favoris musique (config/music-favorites.json) : station, artiste, playlist Apple Music. Seuls les identifiants
// de ce fichier sont acceptés ; l'adresse doit être sur music.apple.com, l'artiste passe en argument (argv).
function musicFavorites() {
  try { return (JSON.parse(fs.readFileSync(path.join(U.CONFIG_DIR, 'music-favorites.json'), 'utf8')).favorites || []).filter(function (f) { return f && f.id && f.label; }); } catch (e) { return []; }
}
function playFavorite(id, cb) {
  const f = musicFavorites().find(function (x) { return x.id === id; });
  if (!f) return cb(new Error('favori inconnu'));
  const done = function (msg) { return function (e, out, err) {
    if (e) { U.log('warn', 'favori musique en échec', { id: id, e: String(err || e.message).replace(/^.*execution error: /, '').slice(0, 160) }); return cb(new Error('lecture impossible')); }
    setTimeout(refreshMusic, 1500); cb(null, { message: msg });
  }; };
  if (f.kind === 'artist') {
    // Playlist « Deck · artiste » reconstruite à chaque fois avec les morceaux de la bibliothèque (rien n'est supprimé de la bibliothèque)
    return cp.execFile('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'set a to item 1 of argv', '-e', 'tell application "Music"',
      '-e', 'set pn to "Deck · " & a', '-e', 'if not (exists user playlist pn) then make new user playlist with properties {name:pn, description:"Créée par CMULTIMEDIA Deck"}',
      '-e', 'set p to user playlist pn', '-e', 'if description of p is not "Créée par CMULTIMEDIA Deck" then error "une liste du même nom existe déjà"', '-e', 'delete every track of p', '-e', 'duplicate (every track of library playlist 1 whose artist is a) to p',
      '-e', 'if (count of tracks of p) is 0 then error "aucun morceau"', '-e', 'play p', '-e', 'end tell', '-e', 'end run', String(f.artist || '')], { timeout: 20000 }, done(f.label + ' : lecture lancée'));
  }
  const m = /^https:\/\/music\.apple\.com\/([a-z]{2}\/)?(station|playlist|album)\/[A-Za-z0-9._\/-]+$/.exec(String(f.url || ''));
  if (!m) return cb(new Error('adresse de favori refusée'));
  const loc = 'itmss://' + f.url.slice(8) + '?app=music';
  cp.execFile('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'tell application "Music" to open location (item 1 of argv)', '-e', 'end run', loc], { timeout: 10000 },
    done(f.kind === 'station' ? f.label + ' : lecture lancée' : f.label + ' : ouverte sur le Mac'));
}
const ARTWORK = path.join(U.DATA, 'artwork.jpg');
let artKey = null;
function refreshArtwork() {
  const m = state.music;
  const key = m && m.running && m.track ? m.track + '|' + m.artist + '|' + m.album : null;
  if (key === artKey) return;
  artKey = key;
  if (!key) { state.music.artwork = null; return; }
  const raw = path.join(U.DATA, 'artwork.raw');
  const script = ['tell application "Music"', 'if (count of artworks of current track) = 0 then return "none"', 'set a to raw data of artwork 1 of current track', 'end tell',
    'set f to open for access POSIX file "' + raw + '" with write permission', 'set eof f to 0', 'write a to f', 'close access f', 'return "ok"'];
  osa(script, function (e, out) {
    if (e || out !== 'ok') { state.music.artwork = null; return changed(); }
    cp.execFile('/usr/bin/sips', ['-s', 'format', 'jpeg', '-Z', '300', raw, '--out', ARTWORK], { timeout: 10000 }, function (e2) {
      state.music.artwork = e2 ? null : Date.now(); changed();
    });
  });
}
// Se déplacer dans le morceau : position en secondes passée en argument (jamais dans le texte du script)
function seek(sec, cb) {
  const m = state.music || {};
  const s = Math.round(Number(sec));
  if (!m.running || !m.duration || !(s >= 0 && s <= m.duration)) return cb(new Error('position invalide'));
  cp.execFile('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'tell application "Music" to set player position to ((item 1 of argv) as integer)', '-e', 'end run', String(s)], { timeout: 6000 }, function (e) {
    if (e) return cb(new Error('déplacement impossible'));
    setTimeout(refreshMusic, 300); cb(null, { message: 'Position ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') });
  });
}
function music(op, cb) {
  if (!MUSIC_OPS[op]) return cb(new Error('commande musique inconnue'));
  osa(MUSIC_OPS[op], function (e) {
    if (e) return cb(e);
    setTimeout(function () { refreshMusic(); }, 400);
    cb(null, { message: { playpause: 'Lecture / pause', play: 'Lecture', pause: 'Pause', next: 'Morceau suivant', previous: 'Morceau précédent', louder: 'Musique plus fort', quieter: 'Musique moins fort', repeat: 'Mode boucle changé', shuffle: 'Aléatoire changé' }[op] });
  });
}

// ---------- sessions Claude Code : titre généré par Claude Code (« aiTitle ») + dates ; aucun message lu
const titles = {};   // fichier -> { size, title }
function sessionTitle(file, size) {
  const c = titles[file];
  if (c && c.size === size) return c.title;
  let title = c ? c.title : null;
  try {
    const fd = fs.openSync(file, 'r');
    const scan = function (pos, len) { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, pos); const all = b.toString('utf8').match(/"aiTitle":"((?:[^"\\]|\\.){1,120})"/g); return all ? JSON.parse('{' + all[all.length - 1] + '}').aiTitle : null; };
    const tail = Math.min(size, 512 * 1024);
    title = scan(size - tail, tail) || title || scan(0, Math.min(size, 512 * 1024));
    fs.closeSync(fd);
  } catch (e) { /* titre indisponible */ }
  titles[file] = { size: size, title: title };
  return title;
}
// ---------- (ancien) sessions Claude Code
function refreshClaude() {
  if (!localOn('claude')) { if (state.claude.recent) { state.claude = { sessions: [], active: 0, recent: 0, t: Date.now() }; changed(); } return; }
  const base = path.join(os.homedir(), '.claude', 'projects');
  const now = Date.now(), out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(base); } catch (e) { return; }
  dirs.forEach(function (d) {
    let files = [];
    try { files = fs.readdirSync(path.join(base, d)).filter(function (f) { return /\.jsonl$/.test(f); }); } catch (e) { return; }
    files.forEach(function (f) {
      let st; try { st = fs.statSync(path.join(base, d, f)); } catch (e) { return; }
      const age = now - st.mtimeMs;
      if (age < 24 * 3600000) {
        const label = d.replace(/^-Users-[^-]+-?/, '').replace(/-/g, '/') || '~ (dossier personnel)';
        const full = path.join(base, d, f), u = usage.files[full] || {};
        out.push({ project: label, title: sessionTitle(full, st.size), lastActivity: st.mtimeMs, active: age < 180000, replies: u.replies || 0, outTokens: u.out || 0 });
      }
    });
  });
  out.sort(function (a, b) { return b.lastActivity - a.lastActivity; });
  const sig = out.map(function (s) { return s.title + s.active + s.replies; }).join('|');
  const prevSig = state.claude.sessions.map(function (s) { return s.title + s.active + s.replies; }).join('|');
  state.claude = { sessions: out.slice(0, 20), active: out.filter(function (s) { return s.active; }).length, recent: out.length, t: now };
  if (sig !== prevSig) changed();
}

const usage = { day: null, files: {}, claude: { replies: 0, outTokens: 0, inTokens: 0 }, codex: { sessions: 0, active: 0, tokens: 0 } };
function today() { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
function readNew(file, onLine) {
  let st; try { st = fs.statSync(file); } catch (e) { return; }
  const f = usage.files[file] || (usage.files[file] = { off: 0 });
  if (st.size < f.off) f.off = 0;
  if (st.size === f.off) return;
  const fd = fs.openSync(file, 'r'); const len = Math.min(st.size - f.off, 64 * 1024 * 1024); const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, f.off); fs.closeSync(fd);
  const text = buf.toString('utf8'); const last = text.lastIndexOf('\n');
  if (last < 0) return;
  f.off += Buffer.byteLength(text.slice(0, last + 1));
  text.slice(0, last).split('\n').forEach(function (l) { if (l) onLine(l, f); });
}
function refreshUsage() {
  if (!localOn('claude') && !localOn('codex')) { if (state.ai) { state.ai = null; changed(); } return; }
  const day = today(), start = new Date(); start.setHours(0, 0, 0, 0);
  if (usage.day !== day) { usage.day = day; usage.files = {}; usage.claude = { replies: 0, outTokens: 0, inTokens: 0 }; }
  const base = path.join(os.homedir(), '.claude', 'projects');
  let dirs = []; try { dirs = fs.readdirSync(base); } catch (e) { /* */ }
  dirs.forEach(function (d) {
    let files = []; try { files = fs.readdirSync(path.join(base, d)); } catch (e) { return; }
    files.forEach(function (fn) {
      if (!/\.jsonl$/.test(fn)) return;
      const file = path.join(base, d, fn);
      let st; try { st = fs.statSync(file); } catch (e) { return; }
      if (st.mtimeMs < start.getTime()) return;
      readNew(file, function (l, fstate) {
        if (l.indexOf('"usage"') < 0 || l.indexOf('"assistant"') < 0) return;
        let o; try { o = JSON.parse(l); } catch (e) { return; }
        if (o.type !== 'assistant' || !o.message || !o.message.usage || !o.timestamp || Date.parse(o.timestamp) < start.getTime()) return;
        const u = o.message.usage;
        usage.claude.replies++; usage.claude.outTokens += u.output_tokens || 0;
        fstate.replies = (fstate.replies || 0) + 1; fstate.out = (fstate.out || 0) + (u.output_tokens || 0);
        usage.claude.inTokens += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      });
    });
  });
  // Codex : ~/.codex/sessions/AAAA/MM/JJ/*.jsonl, dernier total cumulé de chaque session du jour
  const d = new Date(), cdir = path.join(os.homedir(), '.codex', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  let cfiles = []; try { cfiles = fs.readdirSync(cdir).filter(function (f) { return /\.jsonl$/.test(f); }); } catch (e) { /* aucune session */ }
  let tokens = 0, active = 0;
  cfiles.forEach(function (fn) {
    const file = path.join(cdir, fn);
    readNew(file, function (l, f) {
      if (l.indexOf('total_token_usage') < 0) return;
      const m = l.match(/"total_token_usage":\{[^}]*"total_tokens":(\d+)/); if (m) f.codexTotal = Number(m[1]);
    });
    tokens += (usage.files[file] && usage.files[file].codexTotal) || 0;
    try { if (Date.now() - fs.statSync(file).mtimeMs < 180000) active++; } catch (e) { /* */ }
  });
  const sig = JSON.stringify([usage.claude, cfiles.length, active, tokens]);
  usage.codex = { sessions: cfiles.length, active: active, tokens: tokens };
  if (sig !== usage.sig) { usage.sig = sig; state.ai = { claude: usage.claude, codex: usage.codex, t: Date.now() }; changed(); }
}

// ---------- sessions Codex : nom (session_index.jsonl), date, jetons cumulés de la session ; aucun message lu
function refreshCodex() {
  if (!localOn('codex')) { if (state.codex) { state.codex = null; changed(); } return; }
  const base = path.join(os.homedir(), '.codex');
  let idx = [];
  try { idx = fs.readFileSync(path.join(base, 'session_index.jsonl'), 'utf8').trim().split('\n').slice(-200).map(function (l) { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { state.codex = { sessions: [], error: 'Codex non trouvé sur ce Mac' }; return; }
  const since = Date.now() - 7 * 86400000, files = {};
  for (let d = 0; d < 8; d++) {
    const dt = new Date(Date.now() - d * 86400000);
    const dir = path.join(base, 'sessions', String(dt.getFullYear()), String(dt.getMonth() + 1).padStart(2, '0'), String(dt.getDate()).padStart(2, '0'));
    try { fs.readdirSync(dir).forEach(function (f) { const m = f.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/); if (m) files[m[1]] = path.join(dir, f); }); } catch (e) { /* jour sans session */ }
  }
  const byId = {};
  idx.forEach(function (x) { byId[x.id] = x; });
  const list = Object.keys(byId).map(function (id) { return byId[id]; }).filter(function (x) { return Date.parse(x.updated_at) >= since; }).map(function (x) {
    const file = files[x.id]; let tokens = 0, mtime = Date.parse(x.updated_at);
    if (file) {
      readNew(file, function (l, f) { if (l.indexOf('total_token_usage') < 0) return; const m = l.match(/"total_token_usage":\{[^}]*"total_tokens":(\d+)/); if (m) f.codexTotal = Number(m[1]); });
      tokens = (usage.files[file] && usage.files[file].codexTotal) || 0;
      try { mtime = Math.max(mtime, fs.statSync(file).mtimeMs); } catch (e) { /* */ }
    }
    return { title: String(x.thread_name || 'Session sans nom').slice(0, 90), lastActivity: mtime, active: Date.now() - mtime < 180000, tokens: tokens };
  }).sort(function (a, b) { return b.lastActivity - a.lastActivity; }).slice(0, 20);
  const sig = JSON.stringify(list.map(function (x) { return x.title + x.active + x.tokens; }));
  if (sig !== (state.codex && state.codex.sig)) { state.codex = { sessions: list, sig: sig, t: Date.now() }; changed(); }
}

// ---------- éphéméride (saints et citations) + météo Open-Meteo de la ville réglée (gratuite, sans clé)
const EPH = U.readJSON(path.join(U.CONFIG_DIR, 'ephemeride.json'), { saints: {}, citations: [] });
const WMO = { 0: ['Ciel dégagé', '☀️'], 1: ['Peu nuageux', '🌤'], 2: ['Partiellement nuageux', '⛅'], 3: ['Couvert', '☁️'], 45: ['Brouillard', '🌫'], 48: ['Brouillard givrant', '🌫'],
  51: ['Bruine légère', '🌦'], 53: ['Bruine', '🌦'], 55: ['Bruine forte', '🌧'], 61: ['Pluie légère', '🌦'], 63: ['Pluie', '🌧'], 65: ['Pluie forte', '🌧'], 71: ['Neige légère', '🌨'],
  73: ['Neige', '🌨'], 75: ['Neige forte', '❄️'], 80: ['Averses légères', '🌦'], 81: ['Averses', '🌧'], 82: ['Averses fortes', '⛈'], 95: ['Orage', '⛈'], 96: ['Orage et grêle', '⛈'], 99: ['Orage et forte grêle', '⛈'] };
function ephemeride() {
  const d = new Date(), start = new Date(d.getFullYear(), 0, 0);
  const doy = Math.floor((d - start) / 86400000);
  const c = EPH.citations.length ? EPH.citations[doy % EPH.citations.length] : null;
  const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const dn = tmp.getUTCDay() || 7; tmp.setUTCDate(tmp.getUTCDate() + 4 - dn);
  const week = Math.ceil(((tmp - Date.UTC(tmp.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
  return { saint: EPH.saints[(d.getMonth() + 1) + '-' + d.getDate()] || null, citation: c ? c[0] : null, auteur: c ? c[1] : null, dayOfYear: doy, week: week };
}
function refreshWeather() {
  // Ville et coordonnées dans connectors.weather ({ city, latitude, longitude }) ; sans réglage, pas de météo
  const wc = getConf().weather || null;
  if (!wc || typeof wc.latitude !== 'number' || typeof wc.longitude !== 'number') { state.weather = null; return; }
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + wc.latitude.toFixed(2) + '&longitude=' + wc.longitude.toFixed(2) + '&current=temperature_2m,weathercode,windspeed_10m&daily=temperature_2m_max,temperature_2m_min,weathercode,sunrise,sunset&timezone=Europe%2FParis&forecast_days=2';
  fetch(url, { headers: { 'User-Agent': 'CMULTIMEDIA-Deck/1.0' }, signal: AbortSignal.timeout(10000) }).then(function (r) { return r.json(); }).then(function (j) {
    const cur = j.current || {}, dl = j.daily || {}, w = WMO[cur.weathercode] || ['', '🌡'], w2 = WMO[(dl.weathercode || [])[1]] || ['', ''];
    state.weather = { ville: String(wc.city || '').slice(0, 40), temp: Math.round(cur.temperature_2m), wind: Math.round(cur.windspeed_10m), desc: w[0], icon: w[1],
      min: Math.round((dl.temperature_2m_min || [])[0]), max: Math.round((dl.temperature_2m_max || [])[0]),
      sunrise: String((dl.sunrise || [])[0] || '').slice(11, 16), sunset: String((dl.sunset || [])[0] || '').slice(11, 16),
      tomorrow: { icon: w2[1], desc: w2[0], min: Math.round((dl.temperature_2m_min || [])[1]), max: Math.round((dl.temperature_2m_max || [])[1]) }, t: Date.now(), error: null };
    changed();
  }).catch(function (e) { state.weather = Object.assign({}, state.weather, { error: 'météo indisponible (Internet coupé ?)' }); changed(); });
}

function init(confGetter, onChange) {
  getConf = confGetter; changed = onChange || changed;
  refreshCodex(); setInterval(refreshCodex, 60000).unref();
  refreshWeather(); setInterval(refreshWeather, 30 * 60000).unref();
  refreshMusic(); refreshClaude(); refreshUsage();
  setInterval(refreshUsage, 60000).unref();
  setInterval(refreshMusic, 4000).unref();
  setInterval(refreshClaude, 15000).unref();
}

module.exports = { seek: seek, ephemeride: ephemeride, musicPlaylists: musicPlaylists, playPlaylist: playPlaylist, musicFavorites: musicFavorites, playFavorite: playFavorite, ARTWORK: ARTWORK, init: init, music: music, state: function () { return state; }, MUSIC_OPS: MUSIC_OPS };
