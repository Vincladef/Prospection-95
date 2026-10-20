# Prospection 95

Application privée de gestion de prospection, en cours de développement.

## Dépôt et hébergement

- GitHub : https://github.com/Vincladef/Prospection-95
- Netlify : https://app.netlify.com/projects/prospection-95
- Branche de production : `main`
- Répertoire publié provisoirement : `public/` (voir `netlify.toml`)

## État actuel

Ce dépôt contient uniquement une page d'attente **sans donnée personnelle**. Il ne contient pas encore la maquette HTML V53 ni le backend.

**Ne pas publier directement le HTML V53 dans ce dépôt public :** sa structure de données embarquée contient des contacts et des historiques. Codex doit prévoir une migration contrôlée vers Neon et éviter de placer les données privées dans le frontend ou Git.

## Architecture cible

- Interface Netlify préservant la direction artistique Windows 95.
- Backend Netlify et base Neon PostgreSQL.
- Moteur Gmail SMTP/IMAP via mots de passe d'application stockés exclusivement dans les secrets serveur.
- Boîte Gmail principale avec transfert automatique et alias configurés manuellement.
- Préchauffage BobWork et diagnostics externes via les planifications ChatGPT/Neon/TinyFish.
- Pas d'API OpenAI dans le backend : la rédaction et l'analyse seront assurées par les planifications ChatGPT.

Les phases de développement sont définies dans les prompts Codex du projet.

## Sécurité

Aucun mot de passe d'application, URL PostgreSQL avec identifiants, token ou clé API ne doit être commité. Les variables de production appartiennent au gestionnaire de secrets Netlify. La mise en ligne de cette page ne permet aucun envoi d'email.
