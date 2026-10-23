# Consignes de reprise — Prospection 95

## Objet du dépôt

Application privée de prospection B2B : React/Vite sur Netlify, fonctions Netlify, Neon PostgreSQL et Neon Auth. Les deux planifications ChatGPT n'appellent jamais Gmail directement ; elles passent uniquement par le contrat SQL `agent_api`.

## Invariants non négociables

- Ne jamais envoyer d'email commercial sans accord explicite du propriétaire.
- Conserver `OUTBOUND_ENABLED=false` et `app.settings.outbound_enabled=false` pendant la recette. Le statut de pause métier est piloté par le propriétaire dans l'interface et ne doit jamais être réactivé automatiquement lors d'un déploiement.
- Ne jamais ajouter à Git un export CRM, un secret, un mot de passe d'application ou une donnée personnelle réelle.
- Une ligne importée « Envoyé » n'est pas une confirmation technique.
- Seul le backend peut appeler `app.confirm_smtp_acceptance` et créer un véritable brouillon Gmail.
- Les rôles agents ne doivent jamais accéder à `vault`, aux tables `app` ou aux fonctions SMTP privilégiées.
- Un résultat externe non vérifié reste `unknown` ; ne jamais fabriquer un succès Gmail, BobWork ou délivrabilité.
- Toute opération reprise par un worker ou un agent doit avoir une clé d'idempotence stable.

## Organisation

- `src/` : interface et client API.
- `netlify/functions/` : API et workers planifiés.
- `netlify/lib/` : authentification, SQL, coffre, Gmail/IMAP, BobWork et import.
- `db/migrations/` : migrations additives dans l'ordre lexical.
- `db/verify.sql` : assertions non destructives après migration.
- `AGENT_PROSPECTION.md` et `AGENT_DELIVRABILITE.md` : contrats des planifications.
- `docs/OPERATIONS.md` : exploitation, recette et retour arrière.

## Méthode de modification

1. Lire le code et la migration concernés avant de modifier.
2. Ajouter une nouvelle migration ; ne pas réécrire l'historique déjà appliqué en production.
3. Tester les migrations sur une branche Neon temporaire, exécuter `db/verify.sql`, puis inspecter le diff.
4. Demander l'accord explicite avant toute application sur la branche principale.
5. Exécuter au minimum `npm run check`, `git diff --check` et un build Netlify hors ligne.
6. Distinguer dans le compte rendu : test unitaire, validation sur branche Neon, build Netlify et recette réelle externe.

## Base et permissions

- `prospection95_app` : rôle de groupe du backend.
- `prospection95_agent` : rôle de groupe strictement limité à `agent_api`.
- Créer des rôles LOGIN distincts et leur accorder un seul rôle de groupe.
- L'URL `DATABASE_URL` de production doit utiliser le rôle applicatif, pas le propriétaire Neon.
- Les migrations utilisent temporairement le propriétaire et sont appliquées séparément du runtime.

## Envois et synchronisation

- Les échéances R1–R5 partent de l'acceptation SMTP précédente.
- Une réponse pertinente ou un envoi manuel Gmail annule les travaux restants.
- Un résultat SMTP ambigu devient `uncertain` et n'est jamais reloué automatiquement.
- Les workers sont courts, incrémentaux et reprenables ; aucun processus IMAP permanent.
- Les brouillons sont créés dans le Gmail principal avec l'identité de la conversation. L'association au fil et la sélection réelle de l'alias doivent rester non vérifiées tant qu'une recette Gmail n'a pas eu lieu.

## État de sécurité initial

Le dépôt peut être déployé avec les envois coupés. L'ajout de secrets Gmail/BobWork doit rester désactivé tant que la clé maître AES n'est disponible que côté serveur, soit dans le store privé Netlify Blobs `prospection95-vault-keys`, soit via `CREDENTIALS_ENCRYPTION_KEY` limitée aux Functions. Ne jamais contourner ce prérequis avec une variable publique ou préfixée `VITE_`.
