//! La porte d'admission au comportement `merge`, en scénarios.
//!
//! Les tests préfixés d'un identifiant portent le nom du scénario de
//! `docs/specs/socle-neuf/requirements.md` qu'ils réalisent. Ceux préfixés de
//! `garde_` n'en réalisent aucun : ils vérifient que les scénarios mesurent
//! encore quelque chose, comme la garde de fixture de `conformance.rs` le
//! fait pour le corpus. Deux d'entre eux gardent une garde — la lecture des
//! sources de la caisse, sur laquelle C7 s'appuie —, parce qu'une garde qui
//! cesse de porter sans rougir est le mode qu'ils ferment.
//!
//! Ce que ces tests ne peuvent pas encore constater, et pourquoi : le
//! scénario C1 demande qu'une transaction annule « avant que le document ne
//! soit remplacé ». Aucun chemin d'écriture n'existe dans cette caisse — il
//! arrive avec T3b —, donc ce qui est constaté ici est plus fort et plus
//! étroit à la fois : le refus tombe à l'admission, avant même qu'un chemin
//! d'écriture soit atteignable.

use std::fs;
use std::path::{Path, PathBuf};

use rigger_grammar::{
    Capabilities, Grammar, GrammarError, GrammarRole, Jsonc, MergeAdmission, Probe, RefusalReason,
    Resolution, Toml,
};

/// Copie un contenu dans un fichier temporaire nommé, et rend son chemin.
/// Sert à constater qu'un document possédé n'a pas bougé pendant qu'on
/// interrogeait la porte d'admission.
fn copie_temporaire(nom: &str, contenu: &[u8]) -> PathBuf {
    let path =
        std::env::temp_dir().join(format!("rigger-grammar-{nom}-{}.tmp", std::process::id()));
    fs::write(&path, contenu)
        .unwrap_or_else(|err| panic!("écriture du témoin {} impossible — {err}", path.display()));
    path
}

/// La sonde des grammaires de test de ce fichier : de la syntaxe JSONC, avec
/// les trois dimensions de trivia hostile que la dérivation exige — fin de
/// ligne CRLF, ligne indentée, commentaire.
const SONDE_JSONC: &str = concat!(
    "{\r\n",
    "\t// sonde\r\n",
    "\t\"allow\": [\"read\"]\r\n",
    "}\r\n",
);

/// Une grammaire qui préserve tout mais dont la résolution dépend de
/// l'ordre. Elle n'existe que pour isoler la seconde condition de refus :
/// aucune des deux grammaires portées par cette caisse n'est sensible à
/// l'ordre, et une règle qui ne se vérifie que sur les grammaires du jour
/// cesserait de protéger le jour où une autre arrive.
///
/// Son aller-retour passe par un analyseur réel, et il le faut : depuis que
/// la dérivation exige qu'une grammaire refuse ce qui n'est pas un document,
/// une identité n'est plus créditée de rien — et cette grammaire-ci doit
/// **être** créditée de la préservation, sans quoi le refus mesuré ici
/// pourrait venir de C1 plutôt que de l'ordre.
struct SondeOrdonnee;

impl Grammar for SondeOrdonnee {
    const NAME: &'static str = "sonde-ordonnée";
    const ROLE: GrammarRole = GrammarRole::ReadWrite;
    const RESOLUTION: Resolution = Resolution::DependsOnOrder;
    const PROBE: Probe = Probe {
        source: SONDE_JSONC,
        comment: "// sonde",
        list_path: &["allow"],
        value_present: "read",
        value_absent: "network",
    };

    fn round_trip(source: &str) -> Result<String, GrammarError> {
        Jsonc::round_trip(source)
    }

    fn find_string_in_list(
        _source: &str,
        _path: &[&str],
        _value: &str,
    ) -> Result<bool, GrammarError> {
        Err(GrammarError::unsupported(
            Self::NAME,
            "désigner un élément de liste",
        ))
    }
}

/// Une grammaire qui annonce tout et n'implémente rien : sa résolution se
/// déclare indépendante de l'ordre, sa sonde porte les trois dimensions de
/// trivia hostile, elle lit réellement son document — et son rendu
/// reformate. C'est le seul moyen d'écrire une capacité mensongère — et la
/// dérivation doit la ramener à ce qu'elle sait faire.
struct GrammaireMenteuse;

impl Grammar for GrammaireMenteuse {
    const NAME: &'static str = "menteuse";
    const ROLE: GrammarRole = GrammarRole::ReadWrite;
    const RESOLUTION: Resolution = Resolution::IndependentOfOrder;
    const PROBE: Probe = Probe {
        source: SONDE_JSONC,
        comment: "// sonde",
        list_path: &["allow"],
        value_present: "read",
        value_absent: "network",
    };

    fn round_trip(source: &str) -> Result<String, GrammarError> {
        Ok(Jsonc::round_trip(source)?.replace("\r\n", "\n"))
    }

    fn find_string_in_list(
        _source: &str,
        _path: &[&str],
        _value: &str,
    ) -> Result<bool, GrammarError> {
        Ok(true)
    }
}

#[test]
fn c1_une_grammaire_qui_ne_preserve_pas_fait_annuler() {
    // GIVEN un document possédé, sur le disque, dans une grammaire dont
    // l'implémentation ne rend pas les octets hors trace.
    let avant = include_bytes!("corpus-limites/config-crlf.toml");
    let temoin = copie_temporaire("c1", avant);

    // WHEN une pose passe par elle.
    let capacites = Capabilities::of::<Toml>();
    let admission = capacites.merge();

    // THEN la transaction annule — ici, avant tout chemin d'écriture.
    let refus = match admission {
        MergeAdmission::Refused(refus) => refus,
        MergeAdmission::Admitted => {
            panic!("`merge` admis sur une grammaire qui ne préserve pas les octets hors trace")
        }
    };

    // AND le message nomme la grammaire et ce qui n'a pas été préservé.
    assert_eq!(refus.grammar(), Toml::NAME);
    let message = refus.to_string();
    for attendu in ["toml", "merge", "fins de ligne"] {
        assert!(
            message.contains(attendu),
            "le refus ne nomme pas « {attendu} » : {message}"
        );
    }

    // AND le document sur le disque est celui d'avant.
    let apres = fs::read(&temoin).expect("relecture du témoin");
    assert_eq!(
        apres.as_slice(),
        avant.as_slice(),
        "le document possédé a bougé pendant l'interrogation de la porte d'admission"
    );
    fs::remove_file(&temoin).expect("nettoyage du témoin");
}

#[test]
fn c7_refus_sur_une_grammaire_sensible_a_l_ordre() {
    // GIVEN une grammaire dont la table des capacités déclare que sa
    // résolution dépend de l'ordre — et qui préserve tout le reste, pour que
    // le refus ne puisse venir que de là.
    let capacites = Capabilities::of::<SondeOrdonnee>();
    assert!(
        capacites.preserves_trivia(),
        "la sonde doit préserver la trivia, sans quoi le refus mesuré ici pourrait venir de C1"
    );
    assert_eq!(capacites.resolution(), Resolution::DependsOnOrder);

    // WHEN un descripteur y déclare un `merge` par clés.
    // THEN le refus nomme la grammaire et le comportement.
    let refus = match capacites.merge() {
        MergeAdmission::Refused(refus) => refus,
        MergeAdmission::Admitted => panic!("`merge` admis sur une grammaire sensible à l'ordre"),
    };
    assert_eq!(refus.grammar(), SondeOrdonnee::NAME);
    assert_eq!(
        refus.reasons(),
        [RefusalReason::ResolutionDependsOnOrder],
        "le refus doit porter la seule raison qui le motive, et pas une autre"
    );
    let message = refus.to_string();
    for attendu in ["sonde-ordonnée", "merge", "ordre"] {
        assert!(
            message.contains(attendu),
            "le refus ne nomme pas « {attendu} » : {message}"
        );
    }
}

#[test]
fn c7_la_condition_ne_cite_aucun_nom_d_hote() {
    // GIVEN le code qui décide de ce refus — toute la source de la caisse,
    // parce que la décision lit la table et que la table est peuplée par les
    // grammaires : citer un hôte dans l'une reviendrait à décider par lui.
    let sources = sources_de_la_caisse();

    // La garde se vérifie elle-même, et pas par un plancher : un plancher se
    // franchit dans le mauvais sens sans rien casser — trois fichiers restent
    // trois fichiers quand le quatrième descend d'un cran et cesse d'être lu.
    // Ce qui est vérifié ici est **dérivé** : chaque module que la caisse
    // déclare a bien été lu. Le compilateur exige un fichier par module ; la
    // garde exige que ce fichier soit passé sous ses yeux.
    let non_lus = modules_sans_fichier(&sources);
    assert!(
        non_lus.is_empty(),
        "{} module(s) déclaré(s) par la caisse dont la source n'a pas été lue — la garde \
         ci-dessous ne porterait pas dessus :\n{}",
        non_lus.len(),
        non_lus.join("\n")
    );

    // WHEN on l'inspecte.
    // THEN il ne contient aucun nom d'hôte.
    let mut fautes = Vec::new();
    for (chemin, contenu) in &sources {
        let minuscules = contenu.to_lowercase();
        for hote in [
            "claude",
            "anthropic",
            "codex",
            "opencode",
            "cursor",
            "copilot",
            "gemini",
            "windsurf",
        ] {
            if minuscules.contains(hote) {
                fautes.push(format!("{chemin} cite l'hôte « {hote} »"));
            }
        }
    }
    assert!(
        fautes.is_empty(),
        "la condition d'admission doit se dériver d'une propriété de la grammaire, \
         jamais d'une liste d'hôtes :\n{}",
        fautes.join("\n")
    );
}

#[test]
fn c7_la_grammaire_de_l_hote_servi_n_est_pas_concernee() {
    // GIVEN la grammaire du fichier de réglages de l'hôte servi, dont la
    // résolution se fait par catégorie et non par position.
    let capacites = Capabilities::of::<Jsonc>();
    assert_eq!(capacites.resolution(), Resolution::IndependentOfOrder);

    // WHEN un descripteur y déclare un `merge` par clés.
    // THEN il est accepté.
    assert_eq!(
        capacites.merge(),
        &MergeAdmission::Admitted,
        "le `merge` doit rester ouvert sur la grammaire du seul hôte servi"
    );
}

/// Garde, pas scénario : c'est elle qui rend une capacité annoncée sans
/// implémentation impossible à faire tenir. La grammaire menteuse déclare
/// tout ; la dérivation exécute et la ramène à ce qu'elle fait réellement.
#[test]
fn garde_une_capacite_annoncee_sans_implementation_ne_tient_pas() {
    let capacites = Capabilities::of::<GrammaireMenteuse>();

    assert!(
        !capacites.preserves_trivia(),
        "une grammaire qui reformate a été créditée de la préservation de la trivia"
    );
    assert!(
        !capacites.designates_list_element(),
        "une grammaire dont la recherche répond sans regarder le document a été créditée \
         de la désignation d'un élément de liste"
    );
    assert!(
        matches!(capacites.merge(), MergeAdmission::Refused(_)),
        "une grammaire qui ne préserve rien a été admise au `merge`"
    );
}

/// Garde, pas scénario : elle vérifie que la dérivation a **mesuré** quelque
/// chose pour chaque grammaire publiée, et elle itère `table()` plutôt que
/// d'énumérer les grammaires du jour.
///
/// Ce qu'elle a remplacé, et pourquoi. La version précédente listait à la
/// main les pièges attendus de deux sondes ; elle cessait donc de protéger à
/// la troisième grammaire, celle qu'on n'a pas pensé à y ajouter — et c'est
/// exactement ainsi qu'une grammaire détruisant les commentaires a pu être
/// publiée « préserve la trivia » dans une copie de cette caisse. Les
/// dimensions sont désormais exigées par la dérivation elle-même, pour toute
/// grammaire ; ce qui reste ici est le constat qu'aucune grammaire publiée
/// n'est refusée pour un défaut d'**instrument**, c'est-à-dire qu'aucune
/// n'échappe à la mesure au lieu de la subir.
#[test]
fn garde_aucune_grammaire_publiee_n_echappe_a_la_mesure() {
    let echappees: Vec<String> = rigger_grammar::table()
        .iter()
        .filter_map(|capacites| {
            let MergeAdmission::Refused(refus) = capacites.merge() else {
                return None;
            };
            let instrument: Vec<String> = refus
                .reasons()
                .iter()
                .filter(|raison| {
                    matches!(
                        raison,
                        RefusalReason::ProbeWithoutHostileTrivia { .. }
                            | RefusalReason::ProbeCommentIsNotTrivia(_)
                            | RefusalReason::ProbeUnreadable(_)
                            | RefusalReason::MalformedDocumentAccepted
                    )
                })
                .map(|raison| raison.to_string())
                .collect();
            (!instrument.is_empty()).then(|| {
                format!(
                    "grammaire `{}` : {}",
                    capacites.grammar(),
                    instrument.join(" ; ")
                )
            })
        })
        .collect();

    assert!(
        echappees.is_empty(),
        "{} grammaire(s) publiée(s) dont la préservation n'a pas pu être mesurée — leur \
         ligne de la table ne dit rien de ce qu'elles font :\n{}",
        echappees.len(),
        echappees.join("\n")
    );
}

/// Une grammaire dont la sonde ne porte aucune trivia hostile mesurerait la
/// préservation sur un document qui n'a rien à préserver, et un aller-retour
/// qui reformate y passerait pour fidèle. Cette garde ne suffit pas comme
/// test : elle est **aussi** une règle de la dérivation, sans quoi elle ne
/// couvrirait que les grammaires qu'on a pensé à énumérer.
#[test]
fn garde_une_sonde_sans_trivia_hostile_ne_credite_rien() {
    struct SondeMuette;

    impl Grammar for SondeMuette {
        const NAME: &'static str = "sonde-muette";
        const ROLE: GrammarRole = GrammarRole::ReadWrite;
        const RESOLUTION: Resolution = Resolution::IndependentOfOrder;
        const PROBE: Probe = Probe {
            source: "allow = []\n",
            comment: "",
            list_path: &["allow"],
            value_present: "read",
            value_absent: "network",
        };

        fn round_trip(source: &str) -> Result<String, GrammarError> {
            Ok(source.to_string())
        }

        fn find_string_in_list(
            _source: &str,
            _path: &[&str],
            _value: &str,
        ) -> Result<bool, GrammarError> {
            Err(GrammarError::unsupported(
                Self::NAME,
                "désigner un élément de liste",
            ))
        }
    }

    let capacites = Capabilities::of::<SondeMuette>();
    assert!(
        !capacites.preserves_trivia(),
        "une grammaire mesurée sur une sonde sans trivia a été créditée de sa préservation"
    );
    assert!(
        matches!(capacites.merge(), MergeAdmission::Refused(_)),
        "une grammaire dont la préservation n'a pas pu être mesurée a été admise au `merge`"
    );
}

/// Garde, pas scénario : le **motif publié** d'un refus doit être celui qui
/// motive vraiment le refus.
///
/// La grammaire TOML est en lecture seule par décision produit du 2026-08-06
/// — son rôle d'écriture était le fichier de configuration d'un hôte qui
/// n'est plus servi, et aucun document possédé par l'hôte servi n'est en
/// TOML. Le plan de fichiers en tire un refus catégorique, « comme sur
/// `frontmatter_read` », qui est refusée parce qu'elle n'écrit pas et non
/// parce qu'une bibliothèque perd des octets. Un refus qui ne publie que la
/// perte des fins de ligne dit à son lecteur que corriger la bibliothèque
/// rouvrirait la porte, ce qui est faux.
#[test]
fn garde_le_refus_en_lecture_seule_nomme_la_decision_et_pas_la_bibliotheque() {
    let capacites = Capabilities::of::<Toml>();
    let refus = match capacites.merge() {
        MergeAdmission::Refused(refus) => refus,
        MergeAdmission::Admitted => panic!("`merge` admis sur une grammaire en lecture seule"),
    };

    let message = refus.to_string();
    assert!(
        message.contains("lecture seule"),
        "le refus ne publie pas la raison qui le motive — la décision produit de ne pas \
         écrire cette grammaire : {message}"
    );

    // AND les deux raisons sont publiées séparément, la catégorique d'abord :
    // celle qui ne se lève par aucune mesure, puis celle qui se mesure. Un
    // refus qui n'en donnerait qu'une laisserait croire que lever celle-là
    // suffirait.
    assert_eq!(
        refus.reasons().first(),
        Some(&RefusalReason::ReadOnlyGrammar)
    );
    assert!(
        refus
            .reasons()
            .iter()
            .any(|raison| matches!(raison, RefusalReason::TriviaNotPreserved(_))),
        "la limite mesurée sur la bibliothèque a disparu du refus : {message}"
    );
}

/// Garde, pas scénario : le corollaire du précédent, et celui qui coûte.
///
/// La conduite que ce module prescrivait était de laisser l'admission se
/// rouvrir « d'elle-même » le jour où la bibliothèque corrigerait ses fins de
/// ligne. Elle se serait rouverte sur une grammaire dont le produit a décidé
/// qu'il n'écrit pas. Cette grammaire-ci simule ce jour-là : lecture seule,
/// analyseur réel, aller-retour byte-identique, résolution indépendante de
/// l'ordre — tout ce qui se mesure est vert, et le refus tient.
#[test]
fn garde_une_bibliotheque_corrigee_ne_rouvre_pas_une_grammaire_en_lecture_seule() {
    struct LectureSeuleQuiPreserveTout;

    impl Grammar for LectureSeuleQuiPreserveTout {
        const NAME: &'static str = "lecture-seule-fidèle";
        const ROLE: GrammarRole = GrammarRole::ReadOnly;
        const RESOLUTION: Resolution = Resolution::IndependentOfOrder;
        const PROBE: Probe = Probe {
            source: SONDE_JSONC,
            comment: "// sonde",
            list_path: &["allow"],
            value_present: "read",
            value_absent: "network",
        };

        fn round_trip(source: &str) -> Result<String, GrammarError> {
            Jsonc::round_trip(source)
        }

        fn find_string_in_list(
            source: &str,
            path: &[&str],
            value: &str,
        ) -> Result<bool, GrammarError> {
            Jsonc::find_string_in_list(source, path, value)
        }
    }

    let capacites = Capabilities::of::<LectureSeuleQuiPreserveTout>();
    assert!(
        capacites.preserves_trivia(),
        "la grammaire de ce test doit préserver la trivia, sans quoi elle ne simule pas le \
         jour où la bibliothèque corrige"
    );
    assert!(capacites.designates_list_element());

    let refus = match capacites.merge() {
        MergeAdmission::Refused(refus) => refus,
        MergeAdmission::Admitted => panic!(
            "l'admission s'est rouverte sur une grammaire en lecture seule parce que tout ce \
             qui se mesure est devenu vert"
        ),
    };
    assert_eq!(refus.grammar(), LectureSeuleQuiPreserveTout::NAME);
    assert_eq!(
        refus.reasons(),
        [RefusalReason::ReadOnlyGrammar],
        "le refus doit porter la seule raison qui le motive, et pas une autre"
    );
}

/// Garde, pas scénario : une implémentation dont l'aller-retour **rend son
/// entrée telle quelle** préserve trivialement n'importe quelle sonde. Elle
/// serait créditée de la préservation de la trivia, et admise au `merge`,
/// sans qu'aucun analyseur n'existe et sans que rien du document n'ait été
/// compris. C'est la contre-preuve que cette caisse portait elle-même : sa
/// grammaire de test sensible à l'ordre avait exactement cette forme.
///
/// Ce qui distingue une grammaire d'une fonction identité est mesurable :
/// une grammaire **refuse** ce qui n'est pas un document de sa syntaxe.
#[test]
fn garde_un_aller_retour_sans_analyseur_ne_credite_rien() {
    struct SansAnalyseur;

    impl Grammar for SansAnalyseur {
        const NAME: &'static str = "sans-analyseur";
        const ROLE: GrammarRole = GrammarRole::ReadWrite;
        const RESOLUTION: Resolution = Resolution::IndependentOfOrder;
        const PROBE: Probe = Probe {
            source: SONDE_JSONC,
            comment: "// sonde",
            list_path: &["allow"],
            value_present: "read",
            value_absent: "network",
        };

        fn round_trip(source: &str) -> Result<String, GrammarError> {
            Ok(source.to_string())
        }

        fn find_string_in_list(
            _source: &str,
            _path: &[&str],
            _value: &str,
        ) -> Result<bool, GrammarError> {
            Err(GrammarError::unsupported(
                Self::NAME,
                "désigner un élément de liste",
            ))
        }
    }

    let capacites = Capabilities::of::<SansAnalyseur>();
    assert!(
        !capacites.preserves_trivia(),
        "une implémentation qui rend son entrée telle quelle a été créditée de la \
         préservation de la trivia — la mesure ne distingue pas une grammaire d'une identité"
    );
    assert!(
        matches!(capacites.merge(), MergeAdmission::Refused(_)),
        "une implémentation sans analyseur a été admise au `merge`"
    );
}

/// Garde, pas scénario : la trivia hostile a plusieurs dimensions, et une
/// sonde qui n'en porte qu'une mesure la préservation sur les seules
/// dimensions qu'elle porte. La dérivation les exige donc **toutes**,
/// d'elle-même — une garde qui énumère les grammaires à la main cesse de
/// protéger à la première qu'on oublie d'y ajouter.
#[test]
fn garde_une_sonde_muette_sur_une_dimension_ne_credite_rien() {
    /// Un analyseur réel — il refuse ce qui n'est pas un document — dont le
    /// rendu **détruit les commentaires**. Sa sonde ne porte que des fins de
    /// ligne : la destruction ne s'y voit pas.
    struct DetruitLesCommentaires;

    impl Grammar for DetruitLesCommentaires {
        const NAME: &'static str = "détruit-les-commentaires";
        const ROLE: GrammarRole = GrammarRole::ReadWrite;
        const RESOLUTION: Resolution = Resolution::IndependentOfOrder;
        const PROBE: Probe = Probe {
            source: "{\r\n\t\"allow\": [\"read\"]\r\n}\r\n",
            comment: "",
            list_path: &["allow"],
            value_present: "read",
            value_absent: "network",
        };

        fn round_trip(source: &str) -> Result<String, GrammarError> {
            let rendu = Jsonc::round_trip(source)?;
            let mut sans_commentaires: String = rendu
                .lines()
                .filter(|ligne| !ligne.trim_start().starts_with("//"))
                .collect::<Vec<_>>()
                .join("\r\n");
            if rendu.ends_with("\r\n") {
                sans_commentaires.push_str("\r\n");
            }
            Ok(sans_commentaires)
        }

        fn find_string_in_list(
            _source: &str,
            _path: &[&str],
            _value: &str,
        ) -> Result<bool, GrammarError> {
            Err(GrammarError::unsupported(
                Self::NAME,
                "désigner un élément de liste",
            ))
        }
    }

    let capacites = Capabilities::of::<DetruitLesCommentaires>();
    assert!(
        !capacites.preserves_trivia(),
        "une grammaire qui détruit les commentaires a été créditée de la préservation de la \
         trivia, parce que sa sonde n'en portait aucun"
    );
    assert!(
        matches!(capacites.merge(), MergeAdmission::Refused(_)),
        "une grammaire qui détruit les commentaires a été admise au `merge`"
    );
}

/// Garde, pas scénario : elle tient le **critère** de la colonne
/// « résolution », qui doit être le même pour toutes les grammaires.
///
/// Ce critère est : *aucun second candidat qu'une position départagerait*.
/// TOML le tient par son format, qui interdit de définir une clé deux fois.
/// JSONC ne le tient pas par le sien — le format admet le nom dupliqué et
/// laisse le comportement du lecteur indéfini —, donc il doit le tenir par
/// son implémentation : refuser en nommant la clé, plutôt qu'honorer la
/// première occurrence en silence. Sans ce refus, la colonne serait peuplée
/// par deux critères contradictoires, et une pose dans le premier bloc d'un
/// document qui en porte deux serait inopérante sans erreur et sans trace si
/// le lecteur honore le second — le rationale de C7 mot pour mot, sur une
/// règle de sécurité.
#[test]
fn garde_une_cle_dupliquee_est_refusee_plutot_qu_arbitree_en_silence() {
    // GIVEN un document où la clé du chemin lu est définie deux fois, et une
    // valeur qui n'est que dans la seconde définition.
    const DOUBLE_CLE: &str = concat!(
        "{\r\n",
        "\t\"permissions\": { \"deny\": [\"Bash(rm -rf *)\"] },\r\n",
        "\t\"permissions\": { \"deny\": [\"Read(./secrets/**)\"] }\r\n",
        "}\r\n",
    );

    // WHEN la grammaire y cherche cette valeur.
    let refus =
        Jsonc::find_string_in_list(DOUBLE_CLE, &["permissions", "deny"], "Read(./secrets/**)")
            .expect_err(
                "la valeur est dans le document et la lecture a répondu sans erreur : elle a \
             arbitré entre deux définitions de la même clé au lieu de refuser",
            );

    // THEN le refus nomme la grammaire et la clé dupliquée.
    assert_eq!(refus.grammar(), Jsonc::NAME);
    let message = refus.to_string();
    for attendu in ["jsonc", "permissions"] {
        assert!(
            message.contains(attendu),
            "le refus ne nomme pas « {attendu} » : {message}"
        );
    }

    // AND le même document sans doublon se lit normalement — sans quoi le
    // refus ci-dessus serait un refus sur tout, et ne mesurerait rien.
    const UNE_SEULE_CLE: &str = concat!(
        "{\r\n",
        "\t\"permissions\": { \"deny\": [\"Read(./secrets/**)\"] }\r\n",
        "}\r\n",
    );
    assert_eq!(
        Jsonc::find_string_in_list(
            UNE_SEULE_CLE,
            &["permissions", "deny"],
            "Read(./secrets/**)"
        ),
        Ok(true)
    );
}

/// La table publiée, entrée par entrée. Les valeurs attendues sont écrites
/// ici et **mesurées** là-bas : c'est le seul sens qui protège, l'inverse
/// laisserait la production s'aligner sur le test.
///
/// Ce test ne suffit **pas** à garder la table, et il ne l'a jamais fait :
/// une grammaire ajoutée avec une ligne mensongère le fait rougir sur une
/// égalité de vecteur, que son auteur lève en écrivant le mensonge une
/// seconde fois ici. Ce qui garde est la dérivation elle-même, et le
/// rapprochement de cette table avec le corpus, dans `conformance.rs`.
#[test]
fn la_table_publie_chaque_capacite_derivee_par_grammaire() {
    let table = rigger_grammar::table();
    let publiee: Vec<(&str, GrammarRole, bool, bool, Resolution, bool)> = table
        .iter()
        .map(|capacites| {
            (
                capacites.grammar(),
                capacites.role(),
                capacites.preserves_trivia(),
                capacites.designates_list_element(),
                capacites.resolution(),
                capacites.merge() == &MergeAdmission::Admitted,
            )
        })
        .collect();

    assert_eq!(
        publiee,
        vec![
            (
                Jsonc::NAME,
                GrammarRole::ReadWrite,
                true,
                true,
                Resolution::IndependentOfOrder,
                true
            ),
            (
                Toml::NAME,
                GrammarRole::ReadOnly,
                false,
                false,
                Resolution::IndependentOfOrder,
                false
            ),
        ]
    );
}

/// Garde de la garde : la lecture des sources doit descendre dans les
/// sous-dossiers.
///
/// Elle ne le faisait pas, et le défaut ne se voyait pas : un module qui
/// descend d'un cran — `jsonc.rs` devenant `jsonc/mod.rs`, la forme qu'il
/// prendra normalement quand la tranche T3b lui ajoutera le chemin
/// d'écriture — sortait du champ de la garde des noms d'hôtes sans que rien
/// ne rougisse. C'est mot pour mot le mode que le rationale de C7 décrit :
/// « cesse de protéger ce jour-là sans que rien ne rougisse ».
#[test]
fn garde_la_lecture_des_sources_descend_dans_les_sous_dossiers() {
    let racine = repertoire_temporaire("sources-recursif");
    fs::write(racine.join("plat.rs"), "// plat\n").expect("écriture de plat.rs");
    fs::create_dir(racine.join("niche")).expect("création du sous-dossier");
    fs::write(racine.join("niche/mod.rs"), "// niché\n").expect("écriture de niche/mod.rs");
    fs::write(racine.join("pas-du-rust.txt"), "ignoré\n").expect("écriture du leurre");

    let lues: Vec<String> = sources_rs(&racine)
        .into_iter()
        .map(|(chemin, _)| chemin)
        .collect();

    assert_eq!(
        lues,
        vec!["niche/mod.rs".to_string(), "plat.rs".to_string()],
        "la lecture n'a pas vu la même chose que le compilateur"
    );
    fs::remove_dir_all(&racine).expect("nettoyage de la fixture");
}

/// Garde de la garde : ce qui remplace le plancher `>= 3`.
///
/// Un plancher ne se franchit que par le haut : il laisse passer la
/// disparition d'un fichier du champ de lecture, qui est justement le mode
/// contre lequel il était censé protéger. Le décompte est donc dérivé de ce
/// que la caisse **déclare** : un module déclaré dont la source n'a pas été
/// lue est nommé.
#[test]
fn garde_la_lecture_des_sources_reclame_un_fichier_par_module_declare() {
    let racine = repertoire_temporaire("sources-modules");
    fs::write(
        racine.join("lib.rs"),
        "pub mod present;\nmod niche;\npub mod fantome;\n",
    )
    .expect("écriture de lib.rs");
    fs::write(racine.join("present.rs"), "// présent\n").expect("écriture de present.rs");
    fs::create_dir(racine.join("niche")).expect("création du sous-dossier");
    fs::write(racine.join("niche/mod.rs"), "// niché\n").expect("écriture de niche/mod.rs");

    let manquants = modules_sans_fichier(&sources_rs(&racine));

    assert_eq!(
        manquants.len(),
        1,
        "un seul module est sans fichier dans cette fixture, {} rapporté(s) : {manquants:?}",
        manquants.len()
    );
    assert!(
        manquants[0].contains("fantome"),
        "le module sans fichier n'est pas nommé : {}",
        manquants[0]
    );
    fs::remove_dir_all(&racine).expect("nettoyage de la fixture");
}

/// Lit la source de la caisse. Le chemin part de `CARGO_MANIFEST_DIR` : la
/// garde doit rester juste quel que soit le répertoire courant du test.
fn sources_de_la_caisse() -> Vec<(String, String)> {
    sources_rs(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"))
}

/// Lit **récursivement** les fichiers `.rs` sous `dir`, chacun rendu avec son
/// chemin relatif à `dir` et trié.
fn sources_rs(dir: &Path) -> Vec<(String, String)> {
    fn descendre(dir: &Path, prefixe: &str, lues: &mut Vec<(String, String)>) {
        let entrees = fs::read_dir(dir)
            .unwrap_or_else(|err| panic!("{}: dossier source introuvable — {err}", dir.display()));
        for entree in entrees.filter_map(|entree| entree.ok()) {
            let chemin = entree.path();
            let nom = chemin
                .file_name()
                .and_then(|nom| nom.to_str())
                .unwrap_or_default()
                .to_string();
            let relatif = if prefixe.is_empty() {
                nom
            } else {
                format!("{prefixe}/{nom}")
            };
            if chemin.is_dir() {
                descendre(&chemin, &relatif, lues);
            } else if chemin.extension().and_then(|ext| ext.to_str()) == Some("rs") {
                let contenu = fs::read_to_string(&chemin).unwrap_or_else(|err| {
                    panic!("{}: lecture impossible — {err}", chemin.display())
                });
                lues.push((relatif, contenu));
            }
        }
    }

    let mut lues = Vec::new();
    descendre(dir, "", &mut lues);
    lues.sort();
    lues
}

/// Les modules que `sources` déclare et dont aucun fichier de `sources` ne
/// porte le corps. Le compilateur exige déjà ce fichier ; ce qui est vérifié
/// ici est qu'il a été **lu**.
fn modules_sans_fichier(sources: &[(String, String)]) -> Vec<String> {
    let lus: Vec<&str> = sources.iter().map(|(chemin, _)| chemin.as_str()).collect();
    let mut manquants = Vec::new();

    for (chemin, contenu) in sources {
        // Un fichier de module — `lib.rs`, `mod.rs` — porte ses enfants dans
        // son propre dossier ; tout autre fichier les porte dans un dossier
        // à son nom.
        let dossier = match chemin.rsplit_once('/') {
            Some((parent, nom)) => match nom {
                "lib.rs" | "mod.rs" => parent.to_string(),
                _ => format!("{parent}/{}", nom.trim_end_matches(".rs")),
            },
            None => match chemin.as_str() {
                "lib.rs" | "mod.rs" => String::new(),
                autre => autre.trim_end_matches(".rs").to_string(),
            },
        };

        for module in modules_declares(contenu) {
            let candidats = if dossier.is_empty() {
                [format!("{module}.rs"), format!("{module}/mod.rs")]
            } else {
                [
                    format!("{dossier}/{module}.rs"),
                    format!("{dossier}/{module}/mod.rs"),
                ]
            };
            if !candidats.iter().any(|candidat| lus.contains(&&**candidat)) {
                manquants.push(format!(
                    "{chemin} déclare `mod {module};` — aucun de {candidats:?} n'a été lu"
                ));
            }
        }
    }

    manquants
}

/// Les noms des modules déclarés par un fichier source, c'est-à-dire ceux
/// dont le corps vit dans un autre fichier : `mod x;`, jamais `mod x { … }`.
fn modules_declares(contenu: &str) -> Vec<&str> {
    contenu
        .lines()
        .filter_map(|ligne| {
            let ligne = ligne.trim();
            let ligne = ligne
                .strip_prefix("pub(crate) ")
                .or_else(|| ligne.strip_prefix("pub "))
                .unwrap_or(ligne);
            ligne
                .strip_prefix("mod ")
                .and_then(|reste| reste.strip_suffix(';'))
                .map(str::trim)
        })
        .collect()
}

/// Crée un répertoire temporaire vide et rend son chemin.
fn repertoire_temporaire(nom: &str) -> PathBuf {
    let path =
        std::env::temp_dir().join(format!("rigger-grammar-{nom}-{}.dir", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path)
        .unwrap_or_else(|err| panic!("création de {} impossible — {err}", path.display()));
    path
}
