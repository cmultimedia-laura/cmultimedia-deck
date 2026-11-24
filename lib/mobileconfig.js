'use strict';
// Profil de configuration iOS (non signé) : autorité du deck + icône « Deck » plein écran sur l'écran d'accueil.
// L'iPad affiche le contenu du profil et demande « Installer » : rien n'est appliqué sans l'accord de la personne qui tient la tablette.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const U = require('./util');

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function uuid(seed) { const h = crypto.createHash('sha1').update(seed).digest('hex'); return (h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-a' + h.slice(17, 20) + '-' + h.slice(20, 32)).toUpperCase(); }

function build(caPemFile, url) {
  const openssl = ['/opt/homebrew/bin/openssl', '/usr/bin/openssl'].find(function (p) { return fs.existsSync(p); });
  const der = cp.execFileSync(openssl, ['x509', '-in', caPemFile, '-outform', 'DER']).toString('base64');
  const icon = fs.readFileSync(path.join(U.ROOT, 'public', 'icon-152.png')).toString('base64');
  const seed = crypto.createHash('sha256').update(der).digest('hex');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n' +
    '<key>PayloadContent</key><array>\n' +
    '<dict><key>PayloadType</key><string>com.apple.security.root</string><key>PayloadVersion</key><integer>1</integer>' +
    '<key>PayloadIdentifier</key><string>com.cmultimedia.deck.ca</string><key>PayloadUUID</key><string>' + uuid(seed + 'ca') + '</string>' +
    '<key>PayloadDisplayName</key><string>Certificat du CMULTIMEDIA Deck</string><key>PayloadCertificateFileName</key><string>cmultimedia-deck-ca.cer</string>' +
    '<key>PayloadContent</key><data>' + der + '</data></dict>\n' +
    '<dict><key>PayloadType</key><string>com.apple.webClip.managed</string><key>PayloadVersion</key><integer>1</integer>' +
    '<key>PayloadIdentifier</key><string>com.cmultimedia.deck.webclip</string><key>PayloadUUID</key><string>' + uuid(seed + 'clip' + url) + '</string>' +
    '<key>PayloadDisplayName</key><string>Icône Deck</string><key>Label</key><string>Deck</string><key>URL</key><string>' + esc(url) + '</string>' +
    '<key>Icon</key><data>' + icon + '</data><key>FullScreen</key><true/><key>Precomposed</key><true/><key>IsRemovable</key><true/></dict>\n' +
    '</array>\n<key>PayloadType</key><string>Configuration</string><key>PayloadVersion</key><integer>1</integer>' +
    '<key>PayloadIdentifier</key><string>com.cmultimedia.deck</string><key>PayloadUUID</key><string>' + uuid(seed + 'profil') + '</string>' +
    '<key>PayloadDisplayName</key><string>CMULTIMEDIA Deck</string><key>PayloadOrganization</key><string>CMULTIMEDIA</string>' +
    '<key>PayloadDescription</key><string>Installe le certificat local du pupitre (connexion chiffrée avec le Mac) et l\'icône Deck en plein écran.</string>' +
    '<key>PayloadRemovalDisallowed</key><false/>\n</dict></plist>\n';
}
module.exports = { build: build };
