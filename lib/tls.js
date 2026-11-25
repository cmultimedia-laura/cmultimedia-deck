'use strict';
// Transport chiffré local : petite autorité de certification propre au deck + certificat serveur
// (RSA 2048, SHA-256, TLS 1.2 : compatible Safari iOS 9). Aucune exposition Internet, aucun transfert de port.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const U = require('./util');

const DIR = () => path.join(U.DATA, 'tls');
const OPENSSL = ['/opt/homebrew/bin/openssl', '/usr/bin/openssl'].find(function (p) { return fs.existsSync(p); });

function files() {
  const d = DIR();
  return { caKey: path.join(d, 'ca.key'), caCrt: path.join(d, 'ca.crt'), key: path.join(d, 'server.key'), crt: path.join(d, 'server.crt'), meta: path.join(d, 'server.json') };
}

function ssl(args) { return cp.execFileSync(OPENSSL, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).toString(); }

function wantedNames(alias) {
  const host = U.localHostName();
  const ips = U.lanAddresses().map(function (a) { return a.address; });
  const dns = [host + '.local', 'localhost'];
  if (alias) dns.push(alias + '.local');
  return { dns: dns, ips: ips.concat(['127.0.0.1']) };
}

// Crée la CA si besoin et (re)génère le certificat serveur si les noms/IP ont changé.
function ensure(alias) {
  if (!OPENSSL) return { ok: false, error: 'openssl introuvable' };
  const f = files();
  U.ensureDir(DIR());
  if (!fs.existsSync(f.caKey) || !fs.existsSync(f.caCrt)) {
    ssl(['genrsa', '-out', f.caKey, '2048']);
    fs.chmodSync(f.caKey, 0o600);
    ssl(['req', '-x509', '-new', '-key', f.caKey, '-sha256', '-days', '3650', '-subj', '/CN=CMULTIMEDIA Deck CA locale/O=CMULTIMEDIA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-out', f.caCrt]);
    U.log('info', 'autorité de certification locale créée');
  }
  const want = wantedNames(alias);
  const meta = U.readJSON(f.meta, null);
  const same = meta && JSON.stringify(meta.names) === JSON.stringify(want) && fs.existsSync(f.crt) && meta.expires > Date.now() + 30 * 86400000;
  if (!same) {
    const csr = path.join(DIR(), 'server.csr'), ext = path.join(DIR(), 'server.ext');
    ssl(['genrsa', '-out', f.key, '2048']);
    fs.chmodSync(f.key, 0o600);
    ssl(['req', '-new', '-key', f.key, '-subj', '/CN=' + want.dns[0] + '/O=CMULTIMEDIA', '-out', csr]);
    const san = want.dns.map(function (d) { return 'DNS:' + d; }).concat(want.ips.map(function (i) { return 'IP:' + i; })).join(',');
    fs.writeFileSync(ext, 'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=' + san + '\n');
    // 800 jours : sous la limite de 825 jours des iOS récents, sans effet sur iOS 9.
    // Début de validité antidaté de 2 jours : une tablette dont l'horloge retarde ne voit pas un certificat « pas encore valable ».
    const stamp = function (t) { return new Date(t).toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z'; };
    const base = ['x509', '-req', '-in', csr, '-CA', f.caCrt, '-CAkey', f.caKey, '-CAcreateserial', '-out', f.crt, '-sha256', '-extfile', ext];
    try { ssl(base.concat(['-not_before', stamp(Date.now() - 2 * 86400000), '-not_after', stamp(Date.now() + 800 * 86400000)])); }
    catch (e) { ssl(base.concat(['-days', '800'])); }   // openssl sans -not_before (LibreSSL du système)
    U.writeJSON(f.meta, { names: want, created: Date.now(), expires: Date.now() + 800 * 86400000 });
    U.log('info', 'certificat serveur (re)généré', { noms: want.dns, ips: want.ips });
  }
  return { ok: true, key: fs.readFileSync(f.key), cert: fs.readFileSync(f.crt), ca: f.caCrt, names: want, regenerated: !same };
}

function fingerprint() {
  try { return ssl(['x509', '-in', files().caCrt, '-noout', '-fingerprint', '-sha256']).trim().replace(/^.*=/, ''); } catch (e) { return null; }
}

module.exports = { ensure: ensure, files: files, fingerprint: fingerprint };
