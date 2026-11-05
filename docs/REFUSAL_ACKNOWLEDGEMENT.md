# Remerciement après refus — migration 048 appliquée

La migration 048 autorise `negative` dans le cycle de réponse existant.
Elle ne change ni les exclusions ni les campagnes, ni leurs modes de réponse.
Une opposition explicite reste bloquée ; un envoi manuel ou une nouvelle
réponse empêche le traitement de l’ancienne source. Les relances restent arrêtées.
Les consignes GPT limitent cette réponse à un seul remerciement courtois,
sans nouvelle proposition ni demande. Aucun message n’est envoyé par la migration.

Validation : migration appliquée sur la branche Neon `br-steep-wave-bao99dg2` ;
cinq cas vérifiés : refus éligible, opposition bloquée, réponse positive éligible,
refus déjà répondu manuellement bloqué, ancienne réponse devenue obsolète bloquée.
`db/verify.sql` exécuté : protections confirmées. Son assertion historique
`migration_created_no_outbound_work` est fausse sur cette copie active, car
elle vérifie l’absence globale de travaux existants, pas un différentiel.
La migration ne contient aucune création de travail d’envoi.

Application en production le 5 novembre 2026 après accord explicite du propriétaire.
Relecture avec le rôle runtime : migration enregistrée, refus simples autorisés,
oppositions non éligibles ; exclusions, contrôles de fraîcheur et d’envoi manuel
préservés. Les réglages d’envoi et de pause sont inchangés.
Aucune ancienne classification ni exclusion n’est corrigée
automatiquement. Un ancien refus classé `opposition` conserve donc sa protection
tant qu’il n’a pas fait l’objet d’une revue distincte.
