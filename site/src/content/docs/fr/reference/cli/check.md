---
title: check
description: L'audit en lecture seule des guardrails et du context installés face à leur état enregistré, avec un statut de catalog indicatif.
---

## Synopsis

```
rigger check [--scope=<user|project>] [--assistant=<claude|opencode>]
rigger <resource> check [--scope=<user|project>] [--assistant=<claude|opencode>]
```

`check` audite si les [guardrails](/fr/reference/glossary/#guardrail) et le
[context](/fr/reference/glossary/#context) dont il a la charge sont correctement installés et
correspondent toujours à leur état enregistré. Il n'écrit rien dans le harness et n'exécute jamais
une commande déclarée par le catalog, mais il n'est pas hors ligne : il récupère chaque catalog
configuré et lance `git ls-remote` par catalog (un accès réseau en lecture seule) pour calculer les
sections indicatives ci-dessous. La forme ressource restreint l'audit à une seule
[nature](/fr/reference/glossary/#nature).

## Arguments

`check` ne prend aucun argument positionnel. Dans la forme ressource, le token de ressource
sélectionne la nature à auditer (par exemple `rigger guardrails check`).

## Flags

| Flag          | Effet                                                                                                                                                                                                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--scope`     | Auditer le scope `user` ou `project` ; `user` par défaut.                                                                                                                                                                                                                                                                       |
| `--assistant` | Auditer en tant que `claude` ou `opencode`. Lorsqu'il est omis, l'assistant est lu depuis le [manifest](/fr/reference/glossary/#manifest) quand chaque entrée auditée a été installée pour un seul assistant ; sinon il est résolu comme décrit dans la [vue d'ensemble](/fr/reference/cli/overview/#résolution-de-lassistant). |

## Ce qu'il audite

`check` audite la base de gouvernance que les catalogs déclarent
([required](/fr/reference/glossary/#required) et [recommended](/fr/reference/glossary/#recommended),
packs déployés), plus tout guardrail ou context déjà installé pour l'assistant résolu, afin que le
[drift](/fr/reference/glossary/#drift) reste détecté. Une entrée disponible mais non déclarée et non
installée est laissée telle quelle : ajouter un second catalog ne fait donc pas passer `check` au
rouge à lui seul. (Pourquoi un catalog liste ce qu'un poste _pourrait_ installer plutôt que ce qu'il
_doit_ installer est traité dans les [concepts fondamentaux](/fr/concepts/core-concepts/#ce-qui-est-installé--le-manifest).)

## Sections indicatives

Après l'audit, `check` peut afficher deux sections indicatives calculées à partir du manifest et des
catalogs configurés :

- `--- Catalogs ---` : une ligne de statut par catalog configuré (à jour, une mise à jour
  disponible, joignable, ou injoignable).
- `--- Updates ---` : une ligne par artifact installé en retard sur la dernière version de son
  catalog.

Ces sections sont informatives. Elles ne changent jamais l'exit code : un catalog en retard ou
injoignable laisse tout de même `check` à `0` quand tout ce qui est audité est présent et concordant.

## Codes de sortie

| Code | Condition                                                                                                |
| ---- | -------------------------------------------------------------------------------------------------------- |
| `0`  | Tout ce qui est audité est présent et correspond à son état enregistré (ou il n'y avait rien à auditer). |
| `3`  | Une ou plusieurs entrées auditées sont manquantes ou driftées.                                           |
| `2`  | Un fichier nécessaire à l'audit est un JSON invalide ou le manifest est malformé.                        |

Sans catalog configuré, `check` affiche ce qui suit et sort en `0` :

```
no catalog configured — run `rigger init`
```

Voir [codes de sortie](/fr/reference/exit-codes) pour le contrat commun.

## En CI

`check` n'écrit rien dans le harness et n'exécute jamais une commande déclarée par le catalog, mais
il accède bien au réseau (fetch git et `ls-remote` en lecture seule) pour résoudre le statut des
catalogs.

Pour conditionner un pipeline au drift, voir [En CI et scripts](/fr/guides/ci-and-scripts/).

## Exemple

```
rigger check --scope=project
```
