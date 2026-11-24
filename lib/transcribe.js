'use strict';
// Transcription locale des dictées du Studio : Whisper installé sur le Mac (openai-whisper), rien n'est envoyé sur Internet.
// Réglage : connectors.transcription = { engine: "whisper-local", bin: "~/…/whisper", model: "small", language: "fr" }
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const U = require('./util');

let getConf = function () { return {}; };
function init(confGetter) { getConf = confGetter; }

function transcriptionInfo() {
  const t = getConf() || {};
  const bin = U.expandHome(t.bin || '');
  const available = t.engine === 'whisper-local' && !!bin && fs.existsSync(bin);
  const cached = fs.existsSync(path.join(require('os').homedir(), '.cache/whisper', (t.model || 'small') + '.pt'));
  return { engine: t.engine || null, available: available, model: t.model, modelCached: cached, remote: false, label: available ? 'Whisper local sur le Mac (modèle ' + t.model + (cached ? '' : ', téléchargement initial nécessaire') + ') — rien n\'est envoyé sur Internet' : 'aucun moteur' };
}

function transcribe(file, onDone) {
  const t = getConf() || {};
  const info = transcriptionInfo();
  if (!info.available) return onDone(new Error('aucun moteur de transcription configuré'));
  const out = U.ensureDir(path.join(U.DATA, 'tmp', U.newId('tr', 4)));
  const proc = cp.spawn(U.expandHome(t.bin), [file, '--model', t.model || 'small', '--language', t.language || 'fr', '--output_format', 'txt', '--output_dir', out, '--fp16', 'False', '--verbose', 'False', '--condition_on_previous_text', 'False'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', function (b) { err = (err + b).slice(-2000); });
  const timer = setTimeout(function () { proc.kill('SIGTERM'); }, 600000);
  proc.on('close', function (code) {
    clearTimeout(timer);
    const txt = path.join(out, path.basename(file).replace(/\.[^.]+$/, '') + '.txt');
    let text = null; try { text = fs.readFileSync(txt, 'utf8').trim(); } catch (e) { /* absent */ }
    try { fs.readdirSync(out).forEach(function (f) { fs.unlinkSync(path.join(out, f)); }); fs.rmdirSync(out); } catch (e) { /* nettoyage du dossier temporaire du deck */ }
    if (code !== 0 || text === null) return onDone(new Error('transcription en échec' + (err ? ' : ' + err.trim().split('\n').pop().slice(0, 150) : '')));
    // Phrases inventées par Whisper sur un enregistrement sans parole (génériques de sous-titres).
    const cleaned = text.split('\n').filter(function (l) { return !/amara\.org|sous-titr(es|age)|merci d'avoir regard|abonnez-vous|^\s*\.*\s*$/i.test(l); }).join('\n').trim();
    if (!cleaned) return onDone(new Error('aucune parole détectée dans l\'enregistrement'));
    onDone(null, cleaned);
  });
  return proc;
}

module.exports = { init: init, info: transcriptionInfo, transcribe: transcribe };
