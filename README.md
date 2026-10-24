# Prospection 95

Application privée de gestion de prospection, inspirée de la maquette V53 et de son interface Windows 95. Le frontend React est hébergé sur Netlify, les fonctions serveur parlent à Neon PostgreSQL et l’authentification repose sur Neon Auth.

Le dépôt ne contient ni prospect réel, ni mot de passe Gmail, ni clé d’API. Le CSV historique et le HTML V53 sont uniquement des sources de migration locales.

## Fonctions principales

- tableau J0–R5 avec recherche, filtres, colonnes figées, édition et validation groupée ;
- campagnes, règles de cadence, attribution Gmail et tests A/B versionnés ;
- coffre AES-256-GCM pour les mots de passe d’application et clés externes, avec clé maître privée dans Netlify Blobs ;
- diagnostics de délivrabilité, comptes de réception et état BobWork sans résultat simulé ;
- import contrôlé CSV/JSON avec prévisualisation, dédoublonnage et campagnes forcées inactives ;
- historique anti-recontact, exclusions, audit append-only et arrêt d’urgence ;
- API SQL dédiée aux agents ChatGPT, sans appel OpenAI dans le backend.

Une nouvelle installation démarre avec l’expédition coupée. Sur la production actuelle, le propriétaire a autorisé le moteur : `OUTBOUND_ENABLED=true`, `app.settings.outbound_enabled=true` et pause générale désactivée. Les déploiements ne modifient pas cet état.

## Architecture

```text
React + Vite
    │ JWT Neon Auth
    ▼
Netlify Functions ─── Neon PostgreSQL
    │                 app / vault / agent_api / audit
    ├── SMTP/IMAP Gmail
    └── BobWork côté serveur / vérificateurs configurables
```

- `src/` : interface React et client API ;
- `netlify/functions/` : API authentifiée et traitements serveur ;
- `netlify/lib/` : authentification, SQL, coffre, planification et import ;
- `db/migrations/` : dix-neuf migrations PostgreSQL additives et rejouables ;
- `docs/` : contrats des agents et procédures d’exploitation.

Contrats et exploitation : [agent de prospection](AGENT_PROSPECTION.md), [agent de délivrabilité](AGENT_DELIVRABILITE.md) et [guide d’exploitation](docs/OPERATIONS.md).

## Développement local

Prérequis : Node.js 22 et un projet Neon de test.

```bash
npm install
cp .env.example .env
npm run dev
```

Contrôle complet :

```bash
npm run check
```

La variable `DATABASE_URL` doit viser une branche Neon de développement. N’appliquez pas les migrations directement sur la branche de production : préparez et validez toujours une branche temporaire.

## Variables Netlify

| Variable | Portée | Secret | Usage |
| --- | --- | --- | --- |
| `VITE_NEON_AUTH_URL` | Builds | non | URL publique de Neon Auth |
| `DATABASE_URL` | Functions | oui | connexion PostgreSQL poolée |
| `BOBWORK_API` | Functions | oui | clé de lecture de l’API officielle BobWork |
| `NEON_AUTH_JWKS_URL` | Functions | non | validation locale des JWT |
| `ADMIN_EMAIL` | Functions | non | unique administrateur autorisé |
| `APP_BASE_URL` | Functions | non | URL canonique du site |
| `APP_TIMEZONE` | Functions | non | `Europe/Paris` |
| `OUTBOUND_ENABLED` | Functions | non | `true` en production après autorisation du propriétaire |

`NEON_API_KEY` sert uniquement aux opérations d’infrastructure et n’est pas consommée par l’application. Un jeton Netlify ne doit pas être exposé au runtime des fonctions.

Au premier accès de l’administrateur, l’application initialise automatiquement une clé maître aléatoire dans un store privé Netlify Blobs, partagé par les déploiements du site et lu uniquement par les fonctions. Neon ne reçoit que les secrets chiffrés AES-256-GCM. `CREDENTIALS_ENCRYPTION_KEY` reste disponible comme remplacement local ou pour une migration contrôlée, mais n’est pas nécessaire en production.

## Import du CRM historique

Dans **Paramètres → Prospects**, choisissez le CSV puis contrôlez la prévisualisation avant de confirmer. L’import :

- conserve les vingt colonnes sources dans les tables de staging ;
- normalise les emails et sépare les liens/non-adressables ;
- transforme la blacklist en exclusions et l’historique en anti-recontact ;
- marque les contacts historiques comme déclarés mais non techniquement confirmés ;
- crée les campagnes en état inactif et ne crée aucun envoi.

Le fichier CRM ne doit jamais être ajouté à Git ou au bundle `dist/`.

## Production

- GitHub : <https://github.com/Vincladef/Prospection-95>
- Netlify : <https://app.netlify.com/projects/prospection-95>
- URL : <https://prospection-95.netlify.app>
- branche de production : `main`

Avant le premier déploiement fonctionnel : valider les migrations sur une branche Neon temporaire, les appliquer après accord explicite, renseigner les variables, ajouter le domaine Netlify aux domaines de confiance Neon Auth, puis lancer `npm run check`.

## Sécurité et limites

- aucune donnée privée n’est injectée dans le frontend ;
- les secrets sont chiffrés avant stockage et ne sont jamais relus par le navigateur ;
- chaque route privée exige un JWT valide et l’adresse `ADMIN_EMAIL` ;
- une réponse pertinente annule les relances restantes ;
- un résultat inconnu reste inconnu : l’interface ne fabrique ni connexion, ni délivrabilité, ni envoi ;
- une acceptation SMTP incertaine passe en revue manuelle, sans nouvelle tentative automatique.

Le tracking d’ouverture/clic est disponible pour les futurs emails : liens et pixel signés, clé privée Netlify Blobs et observations en base sans IP ni agent utilisateur brut. Une ouverture reste un signal technique potentiellement bruité par les proxys d’images. L’alias des brouillons, BobWork, TinyFish et le parcours réel d’un futur email suivi exigent toujours une recette avec les comptes autorisés avant d’être annoncés opérationnels.
