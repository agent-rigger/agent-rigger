//! Limites de bibliothèques épinglées, mesurées et enregistrées ici plutôt
//! que contournées ou tues.
//!
//! `toml_edit 0.25.13` ne préserve pas les fins de ligne CRLF. Cause au
//! source, non contournable par option ni par feature : le lexeur de
//! `parser/document.rs:252` rompt sur `Newline` sans enregistrer son span,
//! et `encode.rs:337` refabrique le séparateur de ligne par `writeln!`, qui
//! écrit `\n` en dur — aucun accès au `Decor` ne permet de récupérer
//! l'octet perdu. C'est l'observable de MD-22 mot pour mot
//! (`docs/specs/refondation-multi-assistants/07-registre-modes-de-defaillance.md`
//! § MD-22), qui fait de la préservation de la trivia une condition
//! d'admission d'une grammaire au comportement `merge` : TOML n'y est donc
//! pas encore admissible sur un document en CRLF. Voir
//! `docs/specs/socle-neuf/PROGRESS.md` du 2026-08-05 pour l'arbitrage :
//! T3 tranche entre refus fail-closed sur TOML CRLF et normalisation
//! déclarée acceptable, cette seconde voie exigeant d'amender MD-22.
//!
//! Ces tests **caractérisent** ce comportement, ils ne le cautionnent pas :
//! ils passent aujourd'hui parce qu'ils décrivent ce que `toml_edit` fait
//! réellement. Le jour où `toml_edit` corrige son support CRLF, ils
//! rougissent — c'est le signal qu'on veut recevoir, pas une régression à
//! réparer en urgence.

use std::str::FromStr;

use toml_edit::DocumentMut;

/// Même contenu logique que `tests/corpus/config.toml`, converti en CRLF.
/// Volontairement hors de `tests/corpus/` : la propriété de conformance ne
/// doit pas le voir, et sa garde sur la taille du corpus (trois documents)
/// doit rester juste.
const CONFIG_CRLF: &[u8] = include_bytes!("corpus-limites/config-crlf.toml");

#[test]
fn b1_toml_edit_normalise_les_crlf_en_lf() {
    let text = std::str::from_utf8(CONFIG_CRLF).expect("la fixture doit être UTF-8");

    let cr_in = CONFIG_CRLF.iter().filter(|&&b| b == b'\r').count();
    assert_eq!(
        cr_in, 24,
        "la fixture n'a plus le nombre de CRLF attendu ({cr_in} ; 24 attendus) — \
         le test ne mesure plus ce qu'il croit mesurer"
    );

    let doc = DocumentMut::from_str(text).expect("parse TOML de la fixture CRLF");
    let output = doc.to_string();
    let output_bytes = output.as_bytes();

    let cr_out = output_bytes.iter().filter(|&&b| b == b'\r').count();
    assert_eq!(
        cr_out, 0,
        "un \\r a survécu à l'aller-retour ({cr_out} sur {cr_in} en entrée) — \
         la limite documentée ici ne serait plus le comportement réel de toml_edit"
    );

    assert_eq!(
        CONFIG_CRLF.len() - output_bytes.len(),
        cr_in,
        "la perte d'octets ne correspond plus exactement au nombre de \\r retirés \
         (entrée {} octets, sortie {} octets)",
        CONFIG_CRLF.len(),
        output_bytes.len()
    );

    // Borne de la perte : au-delà des fins de ligne, la sortie doit être
    // identique à `tests/corpus/config.toml` — la même trivia, en LF, déjà
    // vérifiée byte-identique par `conformance.rs`. Toute autre différence
    // serait une perte non documentée ici, et c'est l'information dont T3 a
    // besoin : la perte est confinée à la seule dimension des fins de ligne.
    let expected_lf = include_bytes!("corpus/config.toml");
    assert_eq!(
        output_bytes, expected_lf,
        "au-delà des fins de ligne, la sortie diverge de tests/corpus/config.toml : \
         la perte n'est plus confinée aux CRLF"
    );
}

#[test]
fn b1_toml_edit_ajoute_un_saut_de_ligne_final_absent() {
    let with_newline = include_str!("corpus/config.toml");
    let without_newline = with_newline
        .strip_suffix('\n')
        .expect("tests/corpus/config.toml doit finir par un \\n");
    assert!(
        !without_newline.ends_with('\n'),
        "l'entrée de ce test doit ne pas finir par un saut de ligne, sinon il ne teste rien"
    );

    let doc = DocumentMut::from_str(without_newline).expect("parse TOML sans saut de ligne final");
    let output = doc.to_string();

    assert!(
        output.ends_with('\n'),
        "toml_edit n'a pas ajouté le saut de ligne final attendu — la limite documentée ici a changé"
    );
    assert_eq!(
        output.len(),
        without_newline.len() + 1,
        "la sortie ({} octets) devrait ne différer de l'entrée ({} octets) que par le \\n final ajouté",
        output.len(),
        without_newline.len()
    );
    assert_eq!(
        output.as_bytes()[..without_newline.len()],
        *without_newline.as_bytes(),
        "au-delà du \\n ajouté, le contenu a divergé — la perte ne serait plus confinée au saut de ligne final"
    );
}
