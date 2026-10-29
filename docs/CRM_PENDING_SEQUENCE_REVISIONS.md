# Révision des séquences individualisées en attente (migration 027)

Le plugin Prospection 95 v1.4.0 utilise les deux interfaces suivantes :

- Lecture : `crm_api.pending_sequences`. Une ligne par prospect ; affiche les six messages J0 à R5, leurs identifiants et versions, et les éléments utiles à la personnalisation.
- Révision : `crm_api.crm_pending_sequence_revise(campaign_id, prospect_id, expected_prospect_version, payload)`. Insère six nouvelles versions de messages, puis incrémente la version du prospect.

## Périmètre

Uniquement les campagnes en **validation manuelle**, les séquences à **six brouillons** terminés et **non envoyés**, et les conversations sans opposition, réponse, désinscription, approbation, expédition ni travail SMTP en cours. La fonction ne modifie ni la campagne, ni les expériences A/B/C, ni les itérations terminées. Elle **n'approuve ni ne programme aucun envoi**.

Les brouillons précédents restent dans `app.email_messages`, avec leur version d'origine. Les nouveaux messages ont `status = pending_approval` et `source = agent`. Un journal d'audit référence les anciennes et nouvelles lignes.

## Relecture avant modification

```sql
SET LOCAL ROLE prospection95_crm;
SELECT campaign_name, prospect_id, prospect_version, full_name, organization_name, messages
FROM crm_api.pending_sequences
WHERE campaign_id = '8b9e4e73-3ec0-4c72-bcf0-9cf3583b784d'::uuid;
```

## Écriture (dans une transaction)

```sql
SET LOCAL ROLE prospection95_crm;
SELECT crm_api.crm_pending_sequence_revise(
  '<uuid-campagne>'::uuid,
  '<uuid-prospect>'::uuid,
  <version-lue>,
  '{"subject":"Objet personnalisé","steps":["J0","R1","R2","R3","R4","R5"]}'::jsonb
);
```

Remplacer chaque étape par un corps complet et vérifier les faits cités ; n'utiliser ce script que pour un prospect éligible et une version réellement lue.

## Recette recommandée avant mise en production

1. Préparer la migration 027 dans une branche Neon temporaire (bloquée actuellement par la limite de branches), sans modifier la base principale.
2. Vérifier que la vue ne renvoie que les séquences éligibles ; les statuts envoyés/validés et les conversations disposant d'un travail en cours sont exclus.
3. Réviser un prospect de test ; contrôler six nouvelles versions, le statut en attente, les messages antérieurs conservés et la progression d'itérations inchangée.
4. Réessayer avec une version périmée : la fonction doit échouer sans insertion.
5. Vérifier qu'une opération émanant de `prospection95_crm` ne peut ni accéder aux tables `app` ni déclencher un envoi.
6. Vérifier les vues CRM et les tests de non-régression applicatifs.

La migration doit être explicitement autorisée avant application sur la branche de production ; ne pas forcer un déploiement en contournant les tests.