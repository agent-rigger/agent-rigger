//! La grammaire TOML, servie par `toml_edit 0.25.13`, **en lecture seule**.
//!
//! **Pourquoi elle n'écrit pas** (tranché le 2026-08-06,
//! `docs/specs/refondation-multi-assistants/04-design-socle-neuf.md`
//! § Plan de fichiers). Son rôle d'écriture était un fichier de configuration
//! d'un hôte qui n'est plus servi, et aucun document possédé par l'hôte servi
//! n'est en TOML. Elle sert la lecture du fichier de catalogue et des
//! descripteurs, et rien d'autre.
//!
//! **Ce que cela fait de la limite mesurée à T1.** `toml_edit 0.25.13`
//! normalise toute fin de ligne CRLF en LF **au rendu** — cause au source,
//! non contournable par option, caractérisée dans
//! `tests/limites_connues.rs`. Cette limite n'est donc plus un obstacle de
//! production : elle est la raison, mesurée sur la sonde ci-dessous, pour
//! laquelle la table des capacités refuse le comportement `merge` sur cette
//! grammaire. Le refus est **exécuté**, pas déclaré : le jour où la
//! bibliothèque corrige, l'aller-retour de la sonde rendra les octets et
//! l'admission se rouvrira d'elle-même, avec un motif.

use std::str::FromStr;

use toml_edit::DocumentMut;

use crate::{Grammar, GrammarError, Probe, Resolution};

/// La grammaire TOML.
pub struct Toml;

/// La sonde : même trivia hostile que le corpus, en CRLF, parce que c'est
/// exactement la dimension sur laquelle la préservation se perd.
const PROBE_SOURCE: &str = concat!(
    "# sonde — commentaire de tête\r\n",
    "[sandbox]\r\n",
    "allow = [\r\n",
    "    \"read\",\r\n",
    "    \"write\",\r\n",
    "]  # verrouillé\r\n",
);

impl Grammar for Toml {
    const NAME: &'static str = "toml";

    /// Aucune valeur n'y est arbitrée par son rang : le format interdit de
    /// définir une clé plusieurs fois (TOML v1.0.0 § Keys, « Defining a key
    /// multiple times is invalid »), donc il n'existe pas de second candidat
    /// qu'une position départagerait.
    const RESOLUTION: Resolution = Resolution::IndependentOfOrder;

    const PROBE: Probe = Probe {
        source: PROBE_SOURCE,
        list_path: &["sandbox", "allow"],
        value_present: "read",
        value_absent: "network",
    };

    fn round_trip(source: &str) -> Result<String, GrammarError> {
        DocumentMut::from_str(source)
            .map(|document| document.to_string())
            .map_err(|err| GrammarError::malformed(Self::NAME, err))
    }

    /// Non implémenté, et ce n'est pas un manque à combler : désigner un
    /// élément de liste sert à en enregistrer l'inverse, ce qu'une grammaire
    /// sans chemin d'écriture n'a rien à faire.
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
