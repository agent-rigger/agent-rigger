//! La porte d'admission au comportement `merge`, en scénarios.
//!
//! Chaque test porte le nom du scénario de
//! `docs/specs/socle-neuf/requirements.md` qu'il réalise. Les deux gardes de
//! fin de fichier n'en réalisent aucun : elles vérifient que les scénarios
//! ci-dessus mesurent encore quelque chose, comme la garde de fixture de
//! `conformance.rs` le fait pour le corpus.
//!
//! Ce que ces tests ne peuvent pas encore constater, et pourquoi : le
//! scénario C1 demande qu'une transaction annule « avant que le document ne
//! soit remplacé ». Aucun chemin d'écriture n'existe dans cette caisse — il
//! arrive avec T3b —, donc ce qui est constaté ici est plus fort et plus
//! étroit à la fois : le refus tombe à l'admission, avant même qu'un chemin
//! d'écriture soit atteignable.

use std::fs;
use std::path::PathBuf;

use rigger_grammar::{
    Capabilities, Grammar, GrammarError, Jsonc, MergeAdmission, Probe, RefusalReason, Resolution,
    Toml,
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

/// Une grammaire qui préserve tout mais dont la résolution dépend de
/// l'ordre. Elle n'existe que pour isoler la seconde condition de refus :
/// aucune des deux grammaires portées par cette caisse n'est sensible à
/// l'ordre, et une règle qui ne se vérifie que sur les grammaires du jour
/// cesserait de protéger le jour où une autre arrive.
struct SondeOrdonnee;

impl Grammar for SondeOrdonnee {
    const NAME: &'static str = "sonde-ordonnée";
    const RESOLUTION: Resolution = Resolution::DependsOnOrder;
    const PROBE: Probe = Probe {
        source: "# sonde\r\nallow = [\r\n    \"read\",\r\n]\r\n",
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

/// Une grammaire qui annonce tout et n'implémente rien : sa résolution se
/// déclare indépendante de l'ordre, sa sonde porte la trivia hostile, et son
/// aller-retour reformate. C'est le seul moyen d'écrire une capacité
/// mensongère — et la dérivation doit la ramener à ce qu'elle sait faire.
struct GrammaireMenteuse;

impl Grammar for GrammaireMenteuse {
    const NAME: &'static str = "menteuse";
    const RESOLUTION: Resolution = Resolution::IndependentOfOrder;
    const PROBE: Probe = Probe {
        source: "# sonde\r\nallow = [\r\n    \"read\",\r\n]\r\n",
        list_path: &["allow"],
        value_present: "read",
        value_absent: "network",
    };

    fn round_trip(source: &str) -> Result<String, GrammarError> {
        Ok(source.replace("\r\n", "\n"))
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
    assert!(
        sources.len() >= 3,
        "{} fichier(s) source lu(s) — la garde ne porterait sur rien",
        sources.len()
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

/// Garde, pas scénario : une sonde édulcorée rendrait la dérivation
/// trivialement vraie et la table mentirait sans qu'aucun test ne rougisse.
/// Même raison d'être que `garde_pieges_du_corpus_toujours_presents`, sur le
/// seul document que la dérivation regarde vraiment.
#[test]
fn garde_les_sondes_portent_la_trivia_hostile() {
    let mut manquants = Vec::new();

    for (grammaire, sonde, aiguilles) in [
        (
            Jsonc::NAME,
            Jsonc::PROBE,
            [
                ("fin de ligne CRLF", "\r\n"),
                ("commentaire de ligne", "//"),
                ("indentation par tabulation", "\t"),
                ("virgule traînante", ",\r\n}"),
            ],
        ),
        (
            Toml::NAME,
            Toml::PROBE,
            [
                ("fin de ligne CRLF", "\r\n"),
                ("commentaire de ligne", "#"),
                ("indentation par espaces", "    \""),
                ("virgule traînante", ",\r\n]"),
            ],
        ),
    ] {
        for (libelle, aiguille) in aiguilles {
            if !sonde.source.contains(aiguille) {
                manquants.push(format!(
                    "sonde de {grammaire} : piège « {libelle} » absent — la dérivation ne \
                     mesurerait plus la préservation sur de la trivia hostile"
                ));
            }
        }
        if !sonde.source.contains(sonde.value_present) {
            manquants.push(format!(
                "sonde de {grammaire} : la valeur présente « {} » n'est pas dans le document",
                sonde.value_present
            ));
        }
        if sonde.source.contains(sonde.value_absent) {
            manquants.push(format!(
                "sonde de {grammaire} : la valeur absente « {} » est dans le document",
                sonde.value_absent
            ));
        }
    }

    assert!(
        manquants.is_empty(),
        "{} sonde(s) affaiblie(s) :\n{}",
        manquants.len(),
        manquants.join("\n")
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
        const RESOLUTION: Resolution = Resolution::IndependentOfOrder;
        const PROBE: Probe = Probe {
            source: "allow = []\n",
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

/// La table publiée, entrée par entrée. Les valeurs attendues sont écrites
/// ici et **mesurées** là-bas : c'est le seul sens qui protège, l'inverse
/// laisserait la production s'aligner sur le test.
#[test]
fn la_table_publie_les_quatre_capacites_par_grammaire() {
    let table = rigger_grammar::table();
    let publiee: Vec<(&str, bool, bool, Resolution, bool)> = table
        .iter()
        .map(|capacites| {
            (
                capacites.grammar(),
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
                true,
                true,
                Resolution::IndependentOfOrder,
                true
            ),
            (
                Toml::NAME,
                false,
                false,
                Resolution::IndependentOfOrder,
                false
            ),
        ]
    );
}

/// Lit la source de la caisse. Le chemin part de `CARGO_MANIFEST_DIR` : la
/// garde doit rester juste quel que soit le répertoire courant du test.
fn sources_de_la_caisse() -> Vec<(String, String)> {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut fichiers: Vec<(String, String)> = fs::read_dir(&dir)
        .unwrap_or_else(|err| panic!("{}: dossier source introuvable — {err}", dir.display()))
        .filter_map(|entree| entree.ok())
        .map(|entree| entree.path())
        .filter(|chemin| chemin.extension().and_then(|ext| ext.to_str()) == Some("rs"))
        .map(|chemin| {
            let contenu = fs::read_to_string(&chemin)
                .unwrap_or_else(|err| panic!("{}: lecture impossible — {err}", chemin.display()));
            (
                chemin
                    .file_name()
                    .and_then(|nom| nom.to_str())
                    .unwrap_or_default()
                    .to_string(),
                contenu,
            )
        })
        .collect();
    fichiers.sort();
    fichiers
}
