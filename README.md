# CMULTIMEDIA Deck

Transformez une tablette, même un vieil iPad sous iOS 9, en pupitre tactile pour votre Mac : musique,
raccourcis, trackpad, clavier, emojis, applications, surveillance de vos sites et état de la machine.

Le Mac fait tout le travail (serveur Node.js sans aucune dépendance). La tablette affiche l'interface dans Safari.
Aucun compte, aucun service en ligne : tout reste sur votre réseau local.

## Ce que fait le Deck

- **Piloter le Mac** : trackpad au doigt, clavier virtuel avec raccourcis (système, applications, navigateur),
  clavier d'emojis, ouverture des applications du Dock avec leurs icônes, volume.
- **Musique** : pochette, lecture, boucle, aléatoire, playlists et favoris (station, artiste), avec une animation
  qui suit le son joué par le Mac (cinq visualisations au choix).
- **Surveiller** : processeur, mémoire et disque du Mac en courbes ; vos sites testés en continu, alerte à
  l'écran dès qu'un site ne répond plus.
- **Studio** : photo et dictée depuis la tablette, transcription locale facultative (Whisper), micro et caméra
  du Mac en option.
- **Pages sur mesure** : éditeur visuel sur le Mac pour composer pages, touches et actions sur une grille 12 × 8.

## Compatibilité

| Appareil | État |
|---|---|
| iPad sous iOS 9 ou plus récent (iPad 2, 3, 4, mini) | essayé en conditions réelles sur un iPad 2 (iOS 9.3.5) |
| iPad récent | affichage vérifié en simulation |
| iPhone à l'horizontale | utilisable, à l'étroit |
| iPhone à la verticale | non prévu |
| Android | pages affichées dans Chrome ; certificat à installer à la main pour le trackpad, le clavier et le Studio |

## Prérequis

- Un Mac sous macOS 13 ou plus récent, et la tablette sur le même Wi-Fi
- Node.js 18 ou plus récent (https://nodejs.org)
- Facultatif : `xcode-select --install` (trackpad, icônes d'applications, animation de la page Musique)

## Installation

```bash
git clone <adresse du dépôt> cmultimedia-deck   # ou décompresser l'archive
cd cmultimedia-deck
bash install.sh
./deck start
./deck pair      # code d'association valable 10 minutes
./deck url       # adresses à ouvrir sur la tablette et empreinte du certificat
```

Sur la tablette :

1. Dans Safari, ouvrez l'adresse `http://…:8710/setup` donnée par `./deck url` et installez le profil du Deck.
   Sur iOS 10.3 ou plus récent, activez-le dans Réglages › Général › Informations › Réglages des certificats.
2. Comparez l'empreinte du certificat installé avec celle affichée par `./deck url`.
3. Ouvrez l'adresse `https://…:8711/`, ajoutez-la à l'écran d'accueil, ouvrez le Deck depuis l'icône et tapez le code.

Sur le Mac, dans Réglages Système › Confidentialité et sécurité, autorisez Terminal dans « Accessibilité »
(trackpad, clavier) et « Enregistrement de l'écran et de l'audio du système » (animation musicale :
24 niveaux sonores calculés, rien n'est enregistré). `./deck doctor` indique ce qui manque.

## Commandes

| Commande | Effet |
|---|---|
| `./deck start` · `./deck stop` | démarrer, arrêter (libère micro et caméra) |
| `./deck status` | état du serveur et des tablettes |
| `./deck pair` · `./deck devices` · `./deck revoke <nom>` | associer, lister, retirer une tablette |
| `./deck admin` | ouvrir l'éditeur visuel des pages (sur le Mac uniquement) |
| `./deck reload` | relire la configuration après modification |
| `./deck autostart enable --confirme` | démarrage automatique à l'ouverture de session |
| `./deck doctor` | diagnostic complet |

## Configuration

Tout est dans `config/` (créé par `install.sh` à partir de `config.example/`) :

- `layout.json` : pages et tuiles ; `actions.json` : touches, applications et dossiers autorisés ;
- `connectors.json` : sites surveillés (`monitors`), ville de la météo (`weather`), transcription (`transcription`),
  lectures locales facultatives des sessions Claude Code et Codex (`local`, désactivées par défaut) ;
- `music-favorites.json` : favoris de la page Musique (station ou playlist Apple Music, artiste de la bibliothèque).

## Sécurité

- Tout passe en https avec une autorité de certification créée sur votre Mac. En http, le Deck ne sert que la
  page d'installation du certificat : le code d'association et les commandes ne circulent jamais en clair.
- Chaque tablette est associée par un code à usage unique ; l'association se ferme seule et se bloque après
  des essais faux. Révoquez une tablette perdue avec `./deck revoke`.
- Les touches ne déclenchent que des actions prévues dans `actions.json`. Le clavier et le trackpad à distance,
  eux, permettent tout ce que permettent un vrai clavier et une vraie souris : n'associez que vos appareils.
- L'éditeur et la commande `./deck` utilisent un jeton d'administration propre au Mac (`data/admin.token`).
- Ne copiez jamais le dossier `data/` vers un autre ordinateur : il contient la clé du certificat et les jetons.

## Tests

```bash
node tests/run-tests.js
bash tests/smoke-test.sh     # Deck démarré
```

## Licence

MIT (fichier `LICENSE`) : libre d'utilisation, de modification et de redistribution, avec mention de l'auteur.

Conçu par CMULTIMEDIA (Aubagne) · https://www.cmultimedia.com
