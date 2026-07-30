// Regenerates js/tutorial.js (TUTORIAL_FR + TUTORIAL_EN) from a single source
// of truth: edit TUTORIAL_FR in js/tutorial.js by hand for content changes, add
// any new string to TR below, then re-run this script to refresh TUTORIAL_EN.
// Usage: node scripts/translate-tutorial.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const raw = readFileSync('js/tutorial.js', 'utf8');
const m = raw.match(/export const TUTORIAL_FR = (\{.*?\});\nexport const TUTORIAL_EN/s);
if (!m) throw new Error('TUTORIAL_FR export not found');
const fr = JSON.parse(m[1]);

const TR = {
  'Bienvenue dans Bete': 'Welcome to Bete',
  'Bete est un système de Mindmap': 'Bete is a mindmap system',
  'Simple et collaboratif': 'Simple and collaborative',
  'Tu peux me déplacer ⬆️': 'You can move me ⬆️',
  'Change moi! 👌': 'Change me! 👌',
  'Clic sur le rectangle et drag le!': 'Click the rectangle and drag it!',
  'Double Clic sur le rectangle pour changer le texte': 'Double-click the rectangle to change the text',
  'Clic Droit sur le rectangle pour changer le texte ou ajouter un lien': 'Right-click the rectangle to change the text or add a link',
  'Je suis un lien!': "I'm a link!",
  'connecté! (sans serveur) ': 'connected! (no server) ',
  'Rectangle (notes)': 'Rectangle (notes)',
  'Lien': 'Link',
  'Editer': 'Edit',
  'Effacer': 'Delete',
  'Sur mobile ?\nAppui long et clique le verrou pour modifier le board!': 'On mobile?\nLong-press and tap the lock to edit the board!',
  'Tu veux ajouter une image ? Tu peux soit la drag and drop dans un rectangle soit Copier Coller!': 'Want to add an image? Drag and drop it into a rectangle, or copy-paste it!',
  'Cercle (groupe)': 'Circle (group)',
  'Le cercle permet de rassembler des notes': 'The circle lets you group notes together',
  'Info isolé': 'Standalone info',
  'Info groupé': 'Grouped info',
  "Tu peux l'agrandir en appuyant sur le bord": 'You can resize it by dragging the edge',
  'Clic droit pour changer la couleur': 'Right-click to change the color',
  'Hexagone (liens)': 'Hexagon (links)',
  "L'hexagone permet de regrouper des blocs sans les copier": 'The hexagon lets you group blocks without copying them',
  'Par exemple tu peux faire un hexa par jour ou par personne': 'For example, you can make one hexagon per day or per person',
  'Acheter du beurre': 'Buy butter',
  'Vibe Coder': 'Vibe coding',
  'Jouer de la mandoline': 'Play the mandolin',
  "Si tu effaces / change un bloc le bloc lié s'efface aussi": 'If you delete/change a block, the linked block updates too',
  'Liaison': 'Liaison',
  'Tu peux interconnecter tes boards': 'You can interconnect your boards',
  'Tant que ton navigateur reste ouvert, ton board reste accessible à tout le monde': 'As long as your browser stays open, your board stays accessible to everyone',
  "Il leur faut juste le lien (attention à pas le partager à n'importe qui !": "They just need the link (careful not to share it with just anyone!)",
  'Les boards sont sauvegardés dans la mémoire de ton navigateur donc même sans liaison tu as toujours accès aux données': "Boards are saved in your browser's storage, so even without a liaison you always have access to your data",
  'Menu Radiale': 'Radial menu',
  'Clic droit dans le vide pour créer des blocs': 'Right-click empty space to create blocks',
  'Rectangle': 'Rectangle',
  'Panneau': 'Sign',
  'Cercle': 'Circle',
  'Hexagone': 'Hexagon',
  'Importer': 'Import',
  'Exporter': 'Export',
  'Lien boards': 'Board link',
  'Serveur': 'Server',
  'Instructions Serveur': 'Server instructions',
  'Si tu veux une connexion persistante sans laisser ton PC allumé': 'If you want a persistent connection without leaving your PC on',
  "Tu peux aussi créer un serveur (pas besoin d'ouvrir le moindre port!)": 'You can also run a server (no need to open any port!)',
  'La connexion est de Pair à Pair (peerjs) les données ne passent sur aucun serveur!': 'The connection is peer-to-peer (PeerJS) — data never passes through any server!',
  'Home': 'Home',
  'A toi de jouer voici le board par défaut mais tu peux en créer d\'autres et les partager': 'Your turn! This is the default board, but you can create others and share them',
  'Groupe': 'Group',
  'Lundi': 'Monday',
  'connecté en p2p! (sans serveur) ': 'connected via P2P! (no server) ',
  'Image': 'Image',
  "Il leur faut juste le lien (attention à pas le partager à n'importe qui !)": "They just need the link (careful not to share it with just anyone!)",
  'Paramètres': 'Settings',
  'Sélection': 'Selection',
  'Annuler': 'Undo',
  'La connexion est de Pair à Pair (peerjs) les données ne passent sur aucun serveur! (juste la mise en relation)': 'The connection is peer-to-peer (PeerJS) — data never passes through any server! (only the initial handshake does)',
  'Triangle': 'Triangle',
  'Couleur': 'Color',
  'Lien vers un board': 'Board link',
  'Mémo Vocal': 'Voice memo',
  'Supprimer': 'Delete',
  'Triangle (Beta)': 'Triangle (Beta)',
  'Le triangle est un connecteur complexe': 'The triangle is an advanced connector',
  'Interrupteur': 'Switch',
  'Afficheur': 'Readout',
  'Horloge': 'Clock',
  'Pont Réseau': 'Network bridge',
  'Afficheur affiche des informations récupéré sur le web!': 'The readout displays information fetched from the web!',
  'Ici on récupère une blague de ICANHAZDADJOKE': 'Here we fetch a joke from ICANHAZDADJOKE',
  'On peut aussi controler des interrupteur connectés localemment!': 'You can also control locally connected switches!',
  'resource: http://192.168.X.X/json/state\nmethod: POST\nheaders:\n  Content-Type: application/json\nbody_on: \'{"on":true}\'\nbody_off: \'{"on":false}\'\nstate_resource: http://192.168.X.X/json/state\nstate_path: on\npoll_interval: 3': 'resource: http://192.168.X.X/json/state\nmethod: POST\nheaders:\n  Content-Type: application/json\nbody_on: \'{"on":true}\'\nbody_off: \'{"on":false}\'\nstate_resource: http://192.168.X.X/json/state\nstate_path: on\npoll_interval: 3',
  'Voici la configuration pour une lampe Shelly': "Here's the config for a Shelly lamp",
  'Le pont réseau permet à un ordinateur distant de controler une prise en passant par un navigateur qui a accès au réseau local': 'The network bridge lets a remote computer control a plug through a browser that has access to the local network',
  "L'horloge permet d'afficher l'heure, créer des chronomètres et des comptes à rebours": 'The clock can show the time, or create stopwatches and countdowns',
  'Autres fonctionnalités': 'Other features',
  'Attention le board Home ne peut pas être partagé!': "Careful: the Home board can't be shared!",
  'Sur les boards partagés il est possible  de discuter en live': 'On shared boards you can chat live',
};

function tr(s) {
  if (s == null || s === '') return s;
  if (!(s in TR)) throw new Error('Missing translation for: ' + JSON.stringify(s));
  return TR[s];
}

function translate(obj) {
  const out = JSON.parse(JSON.stringify(obj));
  out.nodes.forEach((n) => { if (n.text) n.text = tr(n.text); });
  out.circles.forEach((c) => { if (c.description) c.description = tr(c.description); });
  out.hexagons.forEach((h) => { if (h.description) h.description = tr(h.description); });
  return out;
}

const en = translate(fr);

const header = `// Built-in demo board (read-only), one variant per language. Shown on first
// visit and via Settings > "Replay the tutorial". Regenerate/edit with
// scripts/translate-tutorial.mjs rather than hand-editing this JSON.
export const TUTORIAL_FR = ${JSON.stringify(fr)};
export const TUTORIAL_EN = ${JSON.stringify(en)};
`;
writeFileSync('js/tutorial.js', header);
console.log('tutorial.js rewritten with TUTORIAL_FR + TUTORIAL_EN');
