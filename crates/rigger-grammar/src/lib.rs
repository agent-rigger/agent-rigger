//! La frontière de grammaire : ce que le produit sait lire et rendre d'un
//! document possédé par quelqu'un d'autre. Cette caisse ne connaît ni
//! assistant, ni catalogue, ni registre.
//!
//! **Ce qui n'est pas ici, et pourquoi.** Le plan de fichiers
//! (`docs/specs/refondation-multi-assistants/04-design-socle-neuf.md`
//! § Plan de fichiers) donne à ce module un trait `Document` portant
//! `parse`, `apply(Edit) -> Inverse` et `render`. `Edit` et `Inverse` sortent
//! des scénarios de la famille C, et leur chemin d'écriture est la tranche
//! T3b. Ce que T3a a besoin de nommer est plus étroit : ce qu'une grammaire
//! sait faire **sans** chemin d'écriture, parce que c'est de cela que se
//! dérive son admission au comportement `merge`.

pub mod capability;
pub mod jsonc;
pub mod toml;

pub use capability::{
    table, Capabilities, MergeAdmission, MergeRefusal, RefusalReason, Resolution, TriviaDivergence,
};
pub use jsonc::Jsonc;
pub use toml::Toml;

use std::fmt;

/// Le document sur lequel une capacité se mesure. Il appartient à la
/// grammaire, parce qu'il est écrit dans sa syntaxe, et il porte de la trivia
/// hostile : une sonde édulcorée rendrait la mesure trivialement vraie.
#[derive(Debug, Clone, Copy)]
pub struct Probe {
    /// Le document, dans la syntaxe de la grammaire.
    pub source: &'static str,
    /// Le chemin d'une liste de chaînes présente dans `source`.
    pub list_path: &'static [&'static str],
    /// Une valeur que cette liste contient.
    pub value_present: &'static str,
    /// Une valeur que cette liste ne contient pas.
    pub value_absent: &'static str,
}

/// Ce qu'une grammaire refuse, en se nommant. Un refus qui ne nomme pas la
/// grammaire laisse son lecteur chercher, et c'est le mode que le registre
/// enregistre sous « refus muet ».
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GrammarError {
    /// Le document n'est pas lisible par cette grammaire.
    Malformed {
        /// La grammaire qui refuse.
        grammar: &'static str,
        /// Ce que la bibliothèque d'analyse a rapporté.
        detail: String,
    },
    /// L'opération demandée n'a pas d'implémentation dans cette grammaire.
    Unsupported {
        /// La grammaire qui refuse.
        grammar: &'static str,
        /// L'opération demandée, nommée.
        operation: &'static str,
    },
}

impl GrammarError {
    /// Refus de lecture, nommant la grammaire et ce que l'analyse a rapporté.
    pub fn malformed(grammar: &'static str, detail: impl fmt::Display) -> Self {
        Self::Malformed {
            grammar,
            detail: detail.to_string(),
        }
    }

    /// Refus d'opération, nommant la grammaire et l'opération.
    pub fn unsupported(grammar: &'static str, operation: &'static str) -> Self {
        Self::Unsupported { grammar, operation }
    }

    /// La grammaire qui a refusé.
    pub fn grammar(&self) -> &'static str {
        match self {
            Self::Malformed { grammar, .. } | Self::Unsupported { grammar, .. } => grammar,
        }
    }
}

impl fmt::Display for GrammarError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Malformed { grammar, detail } => {
                write!(f, "grammaire `{grammar}` : document malformé — {detail}")
            }
            Self::Unsupported { grammar, operation } => write!(
                f,
                "grammaire `{grammar}` : {operation} n'est pas implémenté"
            ),
        }
    }
}

impl std::error::Error for GrammarError {}

/// Une grammaire d'écriture ou de lecture, du point de vue de ce que la table
/// des capacités doit pouvoir **exécuter** pour répondre à son sujet.
///
/// Les deux capacités que ce trait sert — préserver la trivia, désigner un
/// élément de liste — ne se déclarent pas : elles se mesurent en faisant
/// tourner l'implémentation sur [`Probe`]. Une grammaire qui ne les
/// implémente pas ne peut donc pas les annoncer.
///
/// La troisième, [`Resolution`], est le seul terme déclaré, parce qu'aucun
/// code de cette caisse ne peut l'exécuter : elle décrit comment le document
/// est **résolu par qui le lit**, ce qui se mesure sur ce lecteur et se cite,
/// jamais ne se devine. Chaque implémentation doit donner sa source datée.
pub trait Grammar {
    /// Le nom sous lequel cette grammaire est nommée dans un refus.
    const NAME: &'static str;

    /// La sensibilité à l'ordre de la résolution des documents de cette
    /// grammaire. Fait mesuré, cité par l'implémentation.
    const RESOLUTION: Resolution;

    /// Le document sur lequel les capacités exécutables se mesurent.
    const PROBE: Probe;

    /// Analyse puis rend, sans aucune édition. Le rendu doit être identique
    /// octet pour octet à l'entrée quand la grammaire préserve la trivia.
    fn round_trip(source: &str) -> Result<String, GrammarError>;

    /// Dit si la liste de chaînes à `path` contient `value`. La désignation
    /// se fait par égalité de valeur et jamais par indice — un indice ne
    /// survit pas plus à un réordonnancement qu'un numéro de ligne à un
    /// reformatage.
    fn find_string_in_list(source: &str, path: &[&str], value: &str) -> Result<bool, GrammarError>;
}
