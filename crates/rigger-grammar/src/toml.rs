//! La grammaire TOML, servie par `toml_edit 0.25.13`, **en lecture seule**.
//!
//! **Pourquoi elle n'écrit pas** (tranché le 2026-08-06,
//! `docs/specs/refondation-multi-assistants/04-design-socle-neuf.md`
//! § Plan de fichiers). Son rôle d'écriture était un fichier de configuration
//! d'un hôte qui n'est plus servi, et aucun document possédé par l'hôte servi
//! n'est en TOML. Elle sert la lecture du fichier de catalogue et des
//! descripteurs, et rien d'autre.
//!
//! **Ce qui refuse le `merge`, et dans quel ordre.** La lecture seule est la
//! raison **catégorique** : elle vient de la décision ci-dessus, elle est
//! portée par [`GrammarRole::ReadOnly`](crate::GrammarRole), et aucune mesure
//! ne la lève. C'est le refus que le plan de fichiers demande — « un `merge`
//! déclaré sur cette grammaire est refusé en la nommant, comme sur
//! `frontmatter_read` » —, et `frontmatter_read` est refusée parce qu'elle
//! n'écrit pas, jamais parce qu'une bibliothèque perdrait des octets.
//!
//! **Ce que cela fait de la limite mesurée à T1.** `toml_edit 0.25.13`
//! normalise toute fin de ligne CRLF en LF **au rendu** — cause au source,
//! non contournable par option, caractérisée dans
//! `tests/limites_connues.rs`. Cette limite n'est plus un obstacle de
//! production, et elle n'est plus non plus ce qui ferme la porte : elle est
//! une **seconde** raison, mesurée sur la sonde ci-dessous, publiée à côté de
//! la première. Le jour où la bibliothèque corrige, cette raison-là
//! disparaîtra du refus et l'admission **ne se rouvrira pas** — une grammaire
//! dont le produit a décidé qu'il n'écrit pas n'a pas de porte à rouvrir.
//! Les deux raisons sont publiées séparément précisément pour qu'un lecteur
//! ne prenne pas la seconde pour la première.

use std::str::FromStr;

use toml_edit::DocumentMut;

use crate::{Grammar, GrammarError, GrammarRole, Probe, Resolution};

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

    /// Lecture seule, tranché le 2026-08-06
    /// (`docs/specs/refondation-multi-assistants/04-design-socle-neuf.md`
    /// § Plan de fichiers, et `docs/specs/socle-neuf/requirements.md` § C1).
    /// Le produit lit avec cette grammaire le fichier de catalogue et les
    /// descripteurs ; il n'écrit dans aucun document en TOML, parce
    /// qu'aucun document possédé par l'hôte servi n'en est.
    const ROLE: GrammarRole = GrammarRole::ReadOnly;

    /// Aucune valeur n'y est arbitrée par son rang : le format interdit de
    /// définir une clé plusieurs fois (TOML v1.0.0 § Keys, « Defining a key
    /// multiple times is invalid »), donc il n'existe pas de second candidat
    /// qu'une position départagerait.
    const RESOLUTION: Resolution = Resolution::IndependentOfOrder;

    const PROBE: Probe = Probe {
        source: PROBE_SOURCE,
        comment: "# sonde — commentaire de tête",
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
