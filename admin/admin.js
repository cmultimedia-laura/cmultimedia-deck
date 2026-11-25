'use strict';
// Éditeur visuel du deck (navigateur du Mac). Travaille sur un brouillon ; rien n'est enregistré sans validation.
const $ = (s) => document.querySelector(s);
const h = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'text') e.textContent = v; else if (k === 'style') e.style.cssText = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); } kids.forEach((k) => k && e.append(k)); return e; };
const api = async (method, route, body) => {
  const r = await fetch('/admin/api/' + route, { method, headers: { 'X-Deck': '1', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'element';

let META = null, draft = null, saved = null, selPage = null, selWidget = null;
const COLS = 12, ROWS = 8;
const WIDGET_HELP = {
  button: 'Touche : lance une action du catalogue', light: 'Voyant d\'état d\'une source', counter: 'Compteur (services ok/alerte/inconnus…)',
  gauge: 'Jauge animée (mem, disk, volume, cpu)', chart: 'Courbe temporelle (cpu, mem, disk, svc:<id>)', vumeter: 'Vumètre + commandes du micro du Mac',
  camera: 'Aperçu / photo / clip de la caméra du Mac', services: 'Liste des services surveillés avec latence',
  media: 'Zone des captures actives + arrêt', ipadcapture: 'Captures avec l\'appareil photo de l\'iPad', recordings: 'Liste des captures conservées', text: 'Titre de section',
  music: 'Musique du Mac (titre, lecture, suivant)', claude: 'Sessions Claude Code actives', alertes: 'Alertes : en cours, son'
};

function markDirty() { $('#dirty').textContent = JSON.stringify(draft) === JSON.stringify(saved) ? '' : '● Modifications non enregistrées'; }
function page() { return draft.layout.pages.find((p) => p.id === selPage); }

async function load() {
  META = await api('GET', 'config');
  draft = clone(META.config); saved = clone(META.config);
  selPage = selPage && draft.layout.pages.some((p) => p.id === selPage) ? selPage : draft.layout.home;
  $('#w-type').replaceChildren(...META.widgetTypes.map((t) => h('option', { value: t, text: t + ' — ' + (WIDGET_HELP[t] || '') })));
  renderAll(); markDirty(); status(); devices(); backups();
}
function renderAll() { renderPages(); renderGrid(); renderProps(); renderActions(); renderJsonTabs(); }

// ---------- pages
function renderPages() {
  $('#pages').replaceChildren(...draft.layout.pages.map((p) => h('li', { class: p.id === selPage ? 'sel' : '', onclick: () => { selPage = p.id; selWidget = null; renderAll(); } },
    h('span', { text: (p.id === draft.layout.home ? '⌂ ' : '') + p.title }), h('span', { class: 'id', text: p.id }))));
  $('#p-title').value = page() ? page().title : '';
}
$('#p-title').addEventListener('input', (e) => { page().title = e.target.value; renderPages(); markDirty(); });
$('#p-add').onclick = () => {
  const title = prompt('Titre de la nouvelle page ?'); if (!title) return;
  let id = slug(title), n = 2; while (draft.layout.pages.some((p) => p.id === id)) id = slug(title) + '-' + n++;
  draft.layout.pages.push({ id, title, widgets: [] }); selPage = id; renderAll(); markDirty();
};
$('#p-dup').onclick = () => {
  const p = clone(page()); let id = p.id + '-copie', n = 2; while (draft.layout.pages.some((x) => x.id === id)) id = p.id + '-copie' + n++;
  p.id = id; p.title += ' (copie)'; draft.layout.pages.splice(draft.layout.pages.indexOf(page()) + 1, 0, p); selPage = id; renderAll(); markDirty();
};
$('#p-del').onclick = () => {
  if (selPage === draft.layout.home) return alert('Impossible de supprimer la page d\'accueil : choisis d\'abord une autre page d\'accueil.');
  if (!confirm('Supprimer la page « ' + page().title + ' » ? (une sauvegarde est faite à l\'enregistrement)')) return;
  draft.layout.pages = draft.layout.pages.filter((p) => p.id !== selPage); selPage = draft.layout.home; renderAll(); markDirty();
};
const movePage = (d) => { const a = draft.layout.pages, i = a.indexOf(page()), j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; renderPages(); markDirty(); };
$('#p-up').onclick = () => movePage(-1); $('#p-down').onclick = () => movePage(1);
$('#p-home').onclick = () => { draft.layout.home = selPage; renderPages(); markDirty(); };

// ---------- grille
function renderGrid() {
  const g = $('#grid'); g.replaceChildren();
  const W = g.clientWidth, H = W * 672 / 1024, cw = W / COLS, ch = H / ROWS;
  for (let x = 0; x < COLS; x++) for (let y = 0; y < ROWS; y++) g.append(h('div', { class: 'cell', style: `left:${x * cw}px;top:${y * ch}px;width:${cw}px;height:${ch}px` }));
  (page() ? page().widgets : []).forEach((w) => {
    const d = h('div', { class: 'wg' + (w.id === selWidget ? ' sel' : ''), style: `left:${w.x * cw + 2}px;top:${w.y * ch + 2}px;width:${w.w * cw - 4}px;height:${w.h * ch - 4}px` },
      h('div', { class: 't', text: w.type + ' · ' + w.id }), h('div', { text: w.label || '' }));
    d.addEventListener('mousedown', (ev) => {
      selWidget = w.id; renderProps(); g.querySelectorAll('.wg').forEach((e) => e.classList.remove('sel')); d.classList.add('sel');
      const sx = ev.clientX, sy = ev.clientY, ox = w.x, oy = w.y;
      const move = (e) => { const nx = Math.max(0, Math.min(COLS - w.w, ox + Math.round((e.clientX - sx) / cw))), ny = Math.max(0, Math.min(ROWS - w.h, oy + Math.round((e.clientY - sy) / ch))); d.style.left = nx * cw + 2 + 'px'; d.style.top = ny * ch + 2 + 'px'; d.dataset.nx = nx; d.dataset.ny = ny; };
      const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); if (d.dataset.nx !== undefined) { w.x = +d.dataset.nx; w.y = +d.dataset.ny; markDirty(); renderGrid(); renderProps(); } };
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
    g.append(d);
  });
}
let lastGridW = 0;
new ResizeObserver(() => { const w = $('#grid').clientWidth; if (w && w !== lastGridW && draft) { lastGridW = w; renderGrid(); } }).observe($('#grid'));

function freeSpot(w, hgt) {
  const occ = new Set(); page().widgets.forEach((x) => { for (let i = x.x; i < x.x + x.w; i++) for (let j = x.y; j < x.y + x.h; j++) occ.add(i + ',' + j); });
  for (let y = 0; y + hgt <= ROWS; y++) for (let x = 0; x + w <= COLS; x++) { let ok = true; for (let i = x; i < x + w && ok; i++) for (let j = y; j < y + hgt; j++) if (occ.has(i + ',' + j)) { ok = false; break; } if (ok) return { x, y }; }
  return null;
}
$('#w-add').onclick = () => {
  const type = $('#w-type').value, size = { button: [3, 1], counter: [2, 2], gauge: [4, 4], chart: [6, 4], text: [12, 1], light: [3, 1] }[type] || [6, 4];
  const spot = freeSpot(size[0], size[1]) || freeSpot(1, 1); if (!spot) return alert('Page pleine : libère de la place.');
  let id = type, n = 2; while (page().widgets.some((x) => x.id === id)) id = type + '-' + n++;
  const w = { id, type, x: spot.x, y: spot.y, w: spot ? Math.min(size[0], COLS - spot.x) : 1, h: Math.min(size[1], ROWS - spot.y), label: type };
  if (type === 'button') w.action = draft.actions.actions[0].id;
  if (['counter', 'gauge', 'chart', 'light'].includes(type)) w.source = type === 'counter' ? 'svc.count.ok' : 'cpu';
  page().widgets.push(w); selWidget = id; renderGrid(); renderProps(); markDirty();
};
$('#w-dup').onclick = () => {
  const w = page().widgets.find((x) => x.id === selWidget); if (!w) return;
  const c = clone(w); let id = w.id + '-copie', n = 2; while (page().widgets.some((x) => x.id === id)) id = w.id + '-copie' + n++;
  const spot = freeSpot(w.w, w.h); if (!spot) return alert('Pas de place libre de la même taille.');
  Object.assign(c, { id }, spot); page().widgets.push(c); selWidget = id; renderGrid(); renderProps(); markDirty();
};
$('#w-del').onclick = () => { if (!selWidget) return; page().widgets = page().widgets.filter((x) => x.id !== selWidget); selWidget = null; renderGrid(); renderProps(); markDirty(); };

// ---------- propriétés du widget
function renderProps() {
  const box = $('#props'); const w = page() && page().widgets.find((x) => x.id === selWidget);
  if (!w) return box.replaceChildren(h('p', { class: 'hint', text: 'Aucun widget sélectionné.' }));
  const field = (label, key, type = 'text', opts) => {
    let input;
    if (opts) { input = h('select'); opts.forEach(([v, t]) => input.append(h('option', { value: v, text: t }))); input.value = w[key] ?? ''; }
    else input = h('input', { type, value: w[key] ?? '' });
    input.addEventListener('input', () => {
      let v = input.value; if (type === 'number') v = Number(v);
      if (v === '' && key !== 'label') delete w[key]; else w[key] = v;
      if (key === 'id') selWidget = v;
      renderGrid(); markDirty();
    });
    return h('label', { text: label }, input);
  };
  const srcOpts = [['', '—'], ['cpu', 'cpu (%)'], ['mem', 'mem (Go)'], ['disk', 'disk (Go)'], ['volume', 'volume (%)'], ['svc.count.ok', 'services disponibles'], ['svc.count.alert', 'services en alerte'], ['svc.count.unknown', 'services inconnus'], ['mic.level', 'niveau micro']]
    .concat(draft.connectors.monitors.map((m) => ['svc:' + m.id, 'latence ' + m.label + ' (ms)']));
  const actOpts = [['', '— aucune —']].concat(draft.actions.actions.map((a) => [a.id, a.label + ' (' + a.type + ')']));
  const th = h('div', { class: 'row' },
    h('label', { text: 'Seuil alerte (warn)' }, Object.assign(h('input', { type: 'number', value: w.thresholds?.warn ?? '' }), { oninput: (e) => { setTh('warn', e.target.value); } })),
    h('label', { text: 'Seuil critique (crit)' }, Object.assign(h('input', { type: 'number', value: w.thresholds?.crit ?? '' }), { oninput: (e) => { setTh('crit', e.target.value); } })));
  function setTh(k, v) { if (v === '') { if (w.thresholds) delete w.thresholds[k]; if (w.thresholds && !Object.keys(w.thresholds).length) delete w.thresholds; } else { w.thresholds = w.thresholds || {}; w.thresholds[k] = Number(v); } markDirty(); }
  const params = h('textarea', { rows: 3 }); params.value = w.params ? JSON.stringify(w.params) : '';
  params.addEventListener('input', () => { try { if (params.value.trim()) w.params = JSON.parse(params.value); else delete w.params; params.style.borderColor = ''; markDirty(); } catch (e) { params.style.borderColor = '#ff4f9a'; } });
  box.replaceChildren(
    h('p', { class: 'hint', text: WIDGET_HELP[w.type] || '' }),
    field('Identifiant (stable)', 'id'), field('Type', 'type', 'text', META.widgetTypes.map((t) => [t, t])), field('Libellé', 'label'), field('Icône (un emoji, touches)', 'icon'),
    field('Source', 'source', 'text', srcOpts), field('Unité', 'unit'),
    field('Action au toucher', 'action', 'text', actOpts),
    h('div', { class: 'row' }, field('Colonne x', 'x', 'number'), field('Ligne y', 'y', 'number')),
    h('div', { class: 'row' }, field('Largeur', 'w', 'number'), field('Hauteur', 'h', 'number')),
    field('Couleur (#RRGGBB, vide = accent)', 'color'), th,
    h('label', { text: 'Paramètres JSON (ex. {"window":15,"max":100} ou {"filter":"alert"})' }, params));
}

// ---------- actions
function renderActions() {
  const tb = $('#actions tbody'); tb.replaceChildren();
  draft.actions.actions.forEach((a, i) => {
    const typeSel = h('select'); META.actionTypes.forEach((t) => typeSel.append(h('option', { value: t, text: t }))); typeSel.value = a.type;
    const p = h('textarea', { rows: 2 }); p.value = JSON.stringify(a.params || {});
    const id = h('input', { value: a.id }), label = h('input', { value: a.label });
    id.oninput = () => { a.id = id.value; markDirty(); }; label.oninput = () => { a.label = label.value; markDirty(); };
    typeSel.onchange = () => { a.type = typeSel.value; markDirty(); };
    p.oninput = () => { try { a.params = JSON.parse(p.value || '{}'); p.style.borderColor = ''; markDirty(); } catch (e) { p.style.borderColor = '#ff4f9a'; } };
    tb.append(h('tr', {}, h('td', {}, id), h('td', {}, label), h('td', {}, typeSel), h('td', {}, p),
      h('td', {}, h('button', { text: 'Dupliquer', onclick: () => { const c = clone(a); c.id += '-copie'; draft.actions.actions.splice(i + 1, 0, c); renderActions(); markDirty(); } }),
        h('button', { class: 'danger', text: '✕', onclick: () => { draft.actions.actions.splice(i, 1); renderActions(); markDirty(); } }))));
  });
  $('#apps').value = JSON.stringify(draft.actions.apps, null, 2); $('#folders').value = JSON.stringify(draft.actions.folders, null, 2);
}
$('#a-add').onclick = () => { draft.actions.actions.push({ id: 'nouvelle-action', label: 'Nouvelle action', type: 'open_url', params: { url: 'https://' } }); renderActions(); markDirty(); };
const jsonArea = (sel, set) => $(sel).addEventListener('input', (e) => { try { set(JSON.parse(e.target.value)); e.target.style.borderColor = ''; markDirty(); } catch (x) { e.target.style.borderColor = '#ff4f9a'; } });
jsonArea('#apps', (v) => { draft.actions.apps = v; }); jsonArea('#folders', (v) => { draft.actions.folders = v; });
jsonArea('#settings', (v) => { draft.settings = v; }); jsonArea('#connectors', (v) => { draft.connectors = v; });
function renderJsonTabs() { $('#settings').value = JSON.stringify(draft.settings, null, 2); $('#connectors').value = JSON.stringify(draft.connectors, null, 2); }

// ---------- validation / enregistrement
function showErrors(list, okMsg) {
  const box = $('#errors'); box.replaceChildren();
  if (list && list.length) box.append(h('div', { class: 'err', text: 'Configuration refusée :\n• ' + list.join('\n• ') }));
  else if (okMsg) { box.append(h('div', { class: 'ok', text: okMsg })); setTimeout(() => box.replaceChildren(), 4000); }
}
$('#validate').onclick = async () => { const r = await api('POST', 'validate', { config: draft }); showErrors(r.errors, 'Configuration valide.'); };
$('#save').onclick = async () => {
  const r = await api('POST', 'config', { config: draft });
  if (!r.ok) return showErrors(r.errors);
  saved = clone(draft); markDirty(); showErrors([], 'Enregistré (version ' + r.version + '). L\'iPad se met à jour tout seul.'); backups(); $('#pv').contentWindow.location.reload();
};

// ---------- onglets, aperçu
document.querySelectorAll('nav [data-tab]').forEach((b) => b.onclick = () => {
  document.querySelectorAll('nav [data-tab]').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + b.dataset.tab));
  if (b.dataset.tab === 'pages') renderGrid();
});
function preview() { const hgt = Number($('#pv-size').value); $('#pv').style.height = hgt + 'px'; $('#pv-wrap').style.height = hgt * 0.75 + 'px'; $('#pv').src = '/?preview=1&page=' + encodeURIComponent(selPage || ''); }
$('#pv-size').onchange = preview; $('#pv-reload').onclick = preview;

// ---------- appareils, association, sauvegardes
async function status() {
  const s = await api('GET', 'status');
  const code = s.pairing.code;
  $('#status').replaceChildren(h('div', { text: 'iPad : ' + s.urls.ipadHttps }), h('div', {}, 'Association : ', h('b', { text: code || 'fermée' })));
  $('#pairing').replaceChildren(h('div', { class: 'pair-code', text: code || 'Association fermée' }),
    h('p', { class: 'hint', text: code ? 'Valable jusqu\'à ' + new Date(s.pairing.expires).toLocaleTimeString('fr-FR') + ', un seul appareil. À saisir sur l\'iPad (' + s.urls.ipadHttps + '). Certificat : ' + s.urls.setup : 'Ouvre l\'association seulement quand tu associes un iPad (10 minutes, un seul appareil).' }),
    h('button', { text: code ? 'Nouveau code' : 'Ouvrir l\'association (10 min)', onclick: async () => { await api('POST', 'pair'); status(); } }));
}
async function devices() {
  const r = await api('GET', 'devices');
  $('#devices tbody').replaceChildren(...r.devices.map((d) => h('tr', {}, h('td', { text: (d.revoked ? '✕ ' : r.waiting.includes(d.id) ? '● ' : '○ ') + d.name }), h('td', { text: d.id }), h('td', { text: new Date(d.createdAt).toLocaleString('fr-FR') }),
    h('td', { text: new Date(d.lastSeen).toLocaleString('fr-FR') }), h('td', { text: d.lastPage || '' }), h('td', { text: d.pairedSecure ? 'oui' : 'non' }),
    h('td', {}, d.revoked ? h('span', { text: 'révoqué' }) : h('button', { class: 'danger', text: 'Révoquer', onclick: async () => { if (confirm('Révoquer ' + d.name + ' ?')) { await api('POST', 'revoke', { device: d.id }); devices(); } } })))));
}
async function backups() {
  const r = await api('GET', 'backups');
  $('#backups').replaceChildren(...(r.backups.length ? r.backups.slice(0, 15).map((b) => h('li', {}, h('span', { text: b + '  ' }), h('button', { text: 'Restaurer', onclick: async () => { if (!confirm('Restaurer ' + b + ' ? La configuration actuelle est elle-même sauvegardée.')) return; const x = await api('POST', 'restore', { name: b }); if (!x.ok) return showErrors(x.errors); await load(); showErrors([], 'Restauré depuis ' + b); } }))) : [h('li', { class: 'hint', text: 'Aucune sauvegarde pour l\'instant (créées à chaque enregistrement).' })]));
}
$('#export').onclick = () => { const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' })), download: 'cmultimedia-deck-config-' + new Date().toISOString().slice(0, 10) + '.json' }); a.click(); };
$('#import').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { const j = JSON.parse(await f.text()); const b = j.config || j; const r = await api('POST', 'validate', { config: b }); draft = b; selPage = draft.layout?.home; renderAll(); markDirty(); showErrors(r.errors, 'Fichier importé et valide : clique « Enregistrer » pour l\'appliquer.'); }
  catch (x) { showErrors(['fichier JSON illisible : ' + x.message]); }
};
setInterval(() => { status(); devices(); }, 15000);
load().then(preview);
