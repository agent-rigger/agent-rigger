//! La grammaire JSONC, servie par `jsonc-parser 0.33.1` et sa fonctionnalité
//! `cst`. JSON strict en étant un sous-ensemble, la même grammaire sert les
//! documents sans commentaire.
//!
//! **Un seul reconnaisseur.** Tout ce que ce module lit d'un document passe
//! par l'arbre concret. Une seconde lecture du même texte — par un analyseur
//! de valeurs, par exemple — divergerait de la première, et le passage que le
//! produit croit posséder s'élargirait en silence.

use jsonc_parser::cst::{CstObject, CstRootNode};
use jsonc_parser::ParseOptions;

use crate::{Grammar, GrammarError, GrammarRole, Probe, Resolution};

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

    /// Le produit écrit dans ces documents : c'est la grammaire des documents
    /// possédés par l'hôte servi — réglages et serveurs d'outils —, et la
    /// seule sur laquelle le comportement `merge` a un objet (décision du
    /// 2026-08-06, `docs/specs/refondation-multi-assistants/04-design-socle-neuf.md`
    /// § Plan de fichiers).
    ///
    /// Le chemin d'écriture lui-même arrive avec la tranche T3b
    /// (`docs/specs/socle-neuf/tasks.md` § T3) ; d'ici là ce terme est une
    /// déclaration, et [`GrammarRole`] porte la dette que cette tranche
    /// collecte.
    const ROLE: GrammarRole = GrammarRole::ReadWrite;

    /// Le critère est celui de toute la colonne, et il porte sur la
    /// **grammaire** : *aucun second candidat qu'une position départagerait*.
    ///
    /// Le format ne le donne pas — il admet qu'un nom soit défini plusieurs
    /// fois dans le même objet et laisse le comportement d'un lecteur
    /// **indéfini** (RFC 8259 § 4 : « the behavior … is unpredictable »).
    /// C'est donc l'implémentation qui le tient : la lecture refuse en
    /// nommant la clé dès qu'elle est définie deux fois sur le chemin lu,
    /// plutôt que d'honorer la première en silence. Sans ce refus, cette
    /// colonne serait peuplée par deux critères contradictoires — un sur le
    /// format ici, un sur la grammaire à côté — et le mode que C7 ferme se
    /// rouvrirait sur un document qui porte le doublon.
    ///
    /// Le fait mesuré le 2026-08-06 sur le fichier de réglages servi — sa
    /// résolution se fait **par catégorie** et non par position — reste vrai
    /// et reste sourcé (`docs/specs/socle-neuf/requirements.md` § C7,
    /// `docs/specs/refondation-multi-assistants/05-contrat-catalogue.md` § 5,
    /// sonde documentaire du 2026-08-05). Il ne peut pas peupler seul cette
    /// colonne : il porte sur **qui lit** le document, quand la condition
    /// d'admission doit se dériver de la grammaire. Une affirmation non datée
    /// sur ce point doit être tenue pour périmée.
    const RESOLUTION: Resolution = Resolution::IndependentOfOrder;

    const PROBE: Probe = Probe {
        source: PROBE_SOURCE,
        comment: "// sonde — commentaire de tête",
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
            refuse_if_defined_twice(&object, key)?;
            match object.object_value(key) {
                Some(child) => object = child,
                None => return Ok(false),
            }
        }
        refuse_if_defined_twice(&object, list_key)?;
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

/// Refuse en nommant la clé si `object` la définit plus d'une fois.
///
/// Le format admet le doublon et laisse indéfini ce qu'un lecteur en fait
/// (RFC 8259 § 4 : « the behavior … is unpredictable »). Lire la première
/// occurrence serait un arbitrage, et un arbitrage muet : le produit
/// écrirait dans un bloc dont rien ne dit qu'il est celui qui compte, la
/// trace serait identique sur deux postes dont les politiques diffèrent, et
/// le diagnostic rendrait `conforme` sur les deux. C'est le mode que C7
/// existe pour fermer, et il ne dépend pas de la façon dont un hôte lit :
/// il suffit que le format le permette.
fn refuse_if_defined_twice(object: &CstObject, key: &str) -> Result<(), GrammarError> {
    let occurrences = object
        .properties()
        .iter()
        .filter_map(|property| property.name())
        .filter(|name| name.decoded_value().is_ok_and(|decoded| decoded == key))
        .count();
    if occurrences > 1 {
        return Err(GrammarError::ambiguous(Jsonc::NAME, key, occurrences));
    }
    Ok(())
}
