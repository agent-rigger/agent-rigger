//! La grammaire JSONC, servie par `jsonc-parser 0.33.1` et sa fonctionnalité
//! `cst`. JSON strict en étant un sous-ensemble, la même grammaire sert les
//! documents sans commentaire.
//!
//! **Un seul reconnaisseur.** Tout ce que ce module lit d'un document passe
//! par l'arbre concret. Une seconde lecture du même texte — par un analyseur
//! de valeurs, par exemple — divergerait de la première, et le passage que le
//! produit croit posséder s'élargirait en silence.

use jsonc_parser::cst::CstRootNode;
use jsonc_parser::ParseOptions;

use crate::{Grammar, GrammarError, Probe, Resolution};

/// La grammaire JSONC.
pub struct Jsonc;

/// La sonde : un document minuscule qui porte la trivia que la préservation
/// doit rendre — CRLF, commentaire de tête, commentaire de fin de ligne,
/// indentation par tabulation, virgule traînante. Elle est écrite ici, à la
/// main, et jamais copiée d'un fichier de la machine.
const PROBE_SOURCE: &str = concat!(
    "{\r\n",
    "\t// sonde — commentaire de tête\r\n",
    "\t\"permissions\": {\r\n",
    "\t\t\"deny\": [\"Bash(rm -rf *)\", \"Read(./secrets/**)\"], // garder\r\n",
    "\t},\r\n",
    "}\r\n",
);

impl Grammar for Jsonc {
    const NAME: &'static str = "jsonc";

    /// Fait mesuré le 2026-08-06 sur le fichier de réglages servi : sa
    /// résolution se fait **par catégorie** et non par position. Source :
    /// `docs/specs/socle-neuf/requirements.md` § C7 et
    /// `docs/specs/refondation-multi-assistants/05-contrat-catalogue.md` § 5
    /// (sonde documentaire du 2026-08-05). Une affirmation non datée sur ce
    /// point doit être tenue pour périmée.
    const RESOLUTION: Resolution = Resolution::IndependentOfOrder;

    const PROBE: Probe = Probe {
        source: PROBE_SOURCE,
        list_path: &["permissions", "deny"],
        value_present: "Bash(rm -rf *)",
        value_absent: "Bash(true)",
    };

    fn round_trip(source: &str) -> Result<String, GrammarError> {
        Ok(parse(source)?.to_string())
    }

    fn find_string_in_list(source: &str, path: &[&str], value: &str) -> Result<bool, GrammarError> {
        let root = parse(source)?;
        let Some((list_key, object_keys)) = path.split_last() else {
            return Ok(false);
        };
        let Some(mut object) = root.object_value() else {
            return Ok(false);
        };
        for key in object_keys {
            match object.object_value(key) {
                Some(child) => object = child,
                None => return Ok(false),
            }
        }
        let Some(list) = object.array_value(list_key) else {
            return Ok(false);
        };
        Ok(list
            .elements()
            .iter()
            .filter_map(|element| element.as_string_lit())
            .any(|literal| {
                literal
                    .decoded_value()
                    .is_ok_and(|decoded| decoded == value)
            }))
    }
}

fn parse(source: &str) -> Result<CstRootNode, GrammarError> {
    CstRootNode::parse(source, &ParseOptions::default())
        .map_err(|err| GrammarError::malformed(Jsonc::NAME, err))
}
