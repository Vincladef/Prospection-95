# Audit des planifications ChatGPT — 23 octobre 2026

Les deux prompts transmis décrivent correctement la séparation générale : ChatGPT raisonne et écrit via Neon, tandis que Netlify exécute SMTP, IMAP, le suivi et BobWork. Pour une exécution fiable, les planifications doivent toutefois utiliser les contrats SQL précis de `AGENT_PROSPECTION.md` et `AGENT_DELIVRABILITE.md`, et non écrire directement dans les tables `app`.

## Chaîne de prospection vérifiée

- `agent_api.campaign_parameters` expose les campagnes, la cible, les instructions, la validation, le tracking et les comptes autorisés.
- `agent_api.register_prospect` déduplique globalement, conserve les sources et respecte l'historique ainsi que les exclusions.
- `agent_api.reserve_prospect` puis `agent_api.propose_sequence` matérialisent atomiquement J0 et R1–R5.
- La validation manuelle produit des messages en attente ; la validation automatique produit des messages préparés.
- Le backend transforme les messages arrivés à échéance en travaux idempotents, applique jours, horaires, quotas et pauses, puis envoie via le mot de passe d'application Gmail chiffré.
- La migration `014_sequence_progression_and_diagnostics` garantit qu'une étape acceptée ne masque plus la relance suivante.
- IMAP synchronise les réponses et les envois manuels. Une réponse pertinente arrête immédiatement les relances.
- Les propositions de réponse deviennent des brouillons IMAP dans le Gmail principal ou, s'il n'existe pas, dans le compte expéditeur de la conversation.
- Les ouvertures et clics sont instrumentés par des liens et pixels signés ; ils restent des observations techniques.
- Les expériences et leurs métriques par variante sont disponibles dans Neon et dans les statistiques de campagne.

## Chaîne de délivrabilité vérifiée

- Le catalogue V53 des vérificateurs, leurs limites et leurs rapports sont exposés par `agent_api`.
- `agent_api.request_diagnostic` crée une demande et, si nécessaire, un email technique idempotent dans la même file que la prospection.
- Le worker accepte désormais les travaux `diagnostic` sans campagne associée.
- BobWork est lu côté Netlify avec la variable secrète de production `BOBWORK_API`. Les ressources `mailboxes`, `stats` et `domains` sont assainies avant exposition aux agents.
- L'agent enregistre les rapports, restrictions et incidents via les fonctions dédiées ; il n'accède ni au coffre ni aux identifiants Gmail.

## Prérequis restant à la création des planifications

1. Créer un rôle PostgreSQL `LOGIN` dédié, membre uniquement de `prospection95_agent`, puis connecter le plugin Neon de chaque planification à ce rôle. La production possède actuellement le rôle de groupe, mais pas encore ce login dédié.
2. Donner à la planification de délivrabilité un outil navigateur compatible TinyFish. Neon et Netlify seuls ne peuvent pas parcourir les sites de vérification externes, relever une adresse de test ou lire leurs rapports.
3. Activer au moins une campagne et lui attribuer un compte expéditeur. À la date de l'audit, les deux campagnes sont courantes mais aucune n'est active ; une planification de prospection n'aurait donc volontairement rien à envoyer.
4. Utiliser `BOBWORK_API` comme nom réel de la variable serveur. Le nom `BOBWORK_API_KEY` présent dans le prompt transmis est descriptif mais ne correspond pas à la production ; l'agent ne doit de toute façon jamais lire cette variable.
5. Effectuer une recette réelle réponse → arrêt des relances → brouillon Gmail → envoi manuel. IMAP peut créer le brouillon avec les bons en-têtes, mais l'affichage exact du fil Gmail ne peut pas être certifié par un test unitaire.

## Futur plugin de campagnes

Le modèle de données prend déjà en charge la création et la modification des campagnes, variantes et règles A/B. L'interface privée possède les routes nécessaires. En revanche, `prospection95_agent` ne peut volontairement pas créer ou modifier arbitrairement une campagne : il peut proposer une expérience avec `agent_api.propose_experiment`, mais le futur plugin devra recevoir un petit contrat SQL dédié et validé, plutôt qu'un accès direct aux tables `app`.

## Conclusion

La recherche, le CRM, la préparation des séquences, l'envoi SMTP, la réception IMAP, le tracking, BobWork et les diagnostics ont une chaîne technique cohérente. Les deux planifications ne seront pleinement opérationnelles qu'après leur création avec le rôle agent dédié ; la planification de délivrabilité exige en plus l'outil navigateur prévu. Les contrats canoniques du dépôt doivent être joints aux prompts longs pour éviter toute ambiguïté sur les vues, fonctions et états réels.
