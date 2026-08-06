//! La grammaire JSONC, servie par `jsonc-parser 0.33.1` et sa fonctionnalité
//! `cst`. JSON strict en étant un sous-ensemble, la même grammaire sert les
//! documents sans commentaire.
//!
//! **Un seul reconnaisseur.** Tout ce que ce module lit d'un document passe
//! par l'arbre concret. Une seconde lecture du même texte — par un analyseur
//! de valeurs, par exemple — divergerait de la première, et le passage que le
//! produit croit posséder s'élargirait en silence.

use jsonc_parser::cst::{CstArray, CstInputValue, CstNode, CstObject, CstRootNode};
use jsonc_parser::ParseOptions;

use crate::{
    Applied, Edit, Grammar, GrammarError, GrammarRole, Inverse, Probe, Resolution, SemanticValue,
    Value,
};

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
    /// **Cette déclaration n'est plus crue sur parole depuis T3b.** La
    /// dérivation exécute le chemin d'écriture sur la sonde : poser, relire ce
    /// qui a été posé, puis défaire en rendant la pré-image octet pour octet.
    /// Une grammaire qui déclarerait ce rôle sans ces trois-là est refusée en
    /// nommant ce qui manque.
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

    fn apply(source: &str, edit: &Edit) -> Result<Applied, GrammarError> {
        let root = parse(source)?;
        let inverse = match edit {
            Edit::Keys { path, entries } => {
                let object = object_at(&root, path)?;
                let mut added = Vec::new();
                let mut replaced = Vec::new();
                for (name, value) in entries {
                    refuse_if_defined_twice(&object, name)?;
                    match object.get(name) {
                        Some(property) => {
                            let node = property
                                .value()
                                .ok_or_else(|| GrammarError::path_not_found(Jsonc::NAME, path))?;
                            replaced.push((name.clone(), read_value(&node)?));
                            property.set_value(input_value(value));
                        }
                        None => {
                            object.append(name, input_value(value));
                            added.push(name.clone());
                        }
                    }
                }
                Inverse::Keys {
                    path: path.clone(),
                    added,
                    replaced,
                }
            }
            Edit::Values { path, values } => {
                let array = array_at(&root, path)?;
                let mut added = Vec::new();
                for value in values {
                    if find_string_element(&array, value)?.is_some() {
                        continue;
                    }
                    array.append(CstInputValue::String(value.clone()));
                    added.push(value.clone());
                }
                Inverse::Values {
                    path: path.clone(),
                    added,
                }
            }
        };
        Ok(Applied {
            rendered: root.to_string(),
            inverse,
        })
    }

    fn invert(source: &str, inverse: &Inverse) -> Result<String, GrammarError> {
        let root = parse(source)?;
        match inverse {
            Inverse::Keys {
                path,
                added,
                replaced,
            } => {
                let object = object_at(&root, path)?;
                for name in added {
                    refuse_if_defined_twice(&object, name)?;
                    if let Some(property) = object.get(name) {
                        property.remove();
                    }
                }
                for (name, value) in replaced {
                    refuse_if_defined_twice(&object, name)?;
                    match object.get(name) {
                        Some(property) => property.set_value(input_value(value)),
                        None => {
                            object.append(name, input_value(value));
                        }
                    }
                }
            }
            Inverse::Values { path, added } => {
                let array = array_at(&root, path)?;
                for value in added {
                    // Une seule occurrence par valeur enregistrée : le produit
                    // en a ajouté une, il en retire une. Retirer toutes celles
                    // qui portent la même valeur emporterait celle que
                    // l'utilisateur avait écrite avant.
                    if let Some(element) = find_string_element(&array, value)? {
                        element.remove();
                    }
                }
            }
        }
        Ok(root.to_string())
    }

    fn values(source: &str) -> Result<Vec<SemanticValue>, GrammarError> {
        let root = parse(source)?;
        let mut valeurs = Vec::new();
        if let Some(node) = root.value() {
            collect_values(&node, "", &mut valeurs)?;
        }
        Ok(valeurs)
    }
}

/// L'objet au bout de `path`, refusant en chemin toute clé définie deux fois.
///
/// La navigation est la **même** que celle de la lecture, et elle refuse pour
/// la même raison : écrire dans une des deux définitions d'une clé serait
/// écrire dans un bloc dont rien ne dit qu'il est celui qui compte.
fn object_at(root: &CstRootNode, path: &[String]) -> Result<CstObject, GrammarError> {
    let mut object = root
        .object_value()
        .ok_or_else(|| GrammarError::path_not_found(Jsonc::NAME, path))?;
    for (rang, key) in path.iter().enumerate() {
        refuse_if_defined_twice(&object, key)?;
        object = object
            .object_value(key)
            .ok_or_else(|| GrammarError::path_not_found(Jsonc::NAME, &path[..=rang]))?;
    }
    Ok(object)
}

/// Le tableau au bout de `path`, dernier segment compris.
fn array_at(root: &CstRootNode, path: &[String]) -> Result<CstArray, GrammarError> {
    let (list_key, object_path) = path
        .split_last()
        .ok_or_else(|| GrammarError::path_not_found(Jsonc::NAME, path))?;
    let object = object_at(root, object_path)?;
    refuse_if_defined_twice(&object, list_key)?;
    object
        .array_value(list_key)
        .ok_or_else(|| GrammarError::path_not_found(Jsonc::NAME, path))
}

/// Le premier élément du tableau dont la chaîne décodée vaut `value`.
///
/// Par **égalité de valeur** et jamais par indice : un indice ne survit pas
/// plus à un réordonnancement qu'un numéro de ligne à un reformatage.
fn find_string_element(array: &CstArray, value: &str) -> Result<Option<CstNode>, GrammarError> {
    for element in array.elements() {
        let Some(literal) = element.as_string_lit() else {
            continue;
        };
        let decoded = literal
            .decoded_value()
            .map_err(|err| GrammarError::malformed(Jsonc::NAME, format!("{err:?}")))?;
        if decoded == value {
            return Ok(Some(element));
        }
    }
    Ok(None)
}

/// Lit la valeur portée par un nœud, pour que l'inverse sache la rétablir.
fn read_value(node: &CstNode) -> Result<Value, GrammarError> {
    if let Some(literal) = node.as_string_lit() {
        let decoded = literal
            .decoded_value()
            .map_err(|err| GrammarError::malformed(Jsonc::NAME, format!("{err:?}")))?;
        return Ok(Value::Text(decoded));
    }
    if let Some(number) = node.as_number_lit() {
        return Ok(Value::Number(number.to_string()));
    }
    // Un mot nu — la tolérance du format sur les noms et valeurs non
    // quotés — est rendu par son texte brut : le rétablir demande d'écrire
    // ces octets-là, pas de leur donner un sens.
    if let Some(word) = node.as_word_lit() {
        return Ok(Value::Number(word.to_string()));
    }
    if let Some(boolean) = node.as_boolean_lit() {
        return Ok(Value::Bool(boolean.value()));
    }
    if node.as_null_keyword().is_some() {
        return Ok(Value::Null);
    }
    if let Some(array) = node.as_array() {
        let mut values = Vec::new();
        for element in array.elements() {
            values.push(read_value(&element)?);
        }
        return Ok(Value::List(values));
    }
    if let Some(object) = node.as_object() {
        let mut entries = Vec::new();
        for property in object.properties() {
            entries.push((property_name(&property)?, read_property_value(&property)?));
        }
        return Ok(Value::Object(entries));
    }
    Err(GrammarError::unsupported(
        Jsonc::NAME,
        "lire une valeur de cette sorte",
    ))
}

fn property_name(property: &jsonc_parser::cst::CstObjectProp) -> Result<String, GrammarError> {
    property
        .name()
        .ok_or_else(|| GrammarError::malformed(Jsonc::NAME, "propriété sans nom"))?
        .decoded_value()
        .map_err(|err| GrammarError::malformed(Jsonc::NAME, format!("{err:?}")))
}

fn read_property_value(property: &jsonc_parser::cst::CstObjectProp) -> Result<Value, GrammarError> {
    let node = property
        .value()
        .ok_or_else(|| GrammarError::malformed(Jsonc::NAME, "propriété sans valeur"))?;
    read_value(&node)
}

/// Traduit une valeur du produit vers ce que la bibliothèque sait insérer.
fn input_value(value: &Value) -> CstInputValue {
    match value {
        Value::Text(text) => CstInputValue::String(text.clone()),
        Value::Number(raw) => CstInputValue::Number(raw.clone()),
        Value::Bool(value) => CstInputValue::Bool(*value),
        Value::Null => CstInputValue::Null,
        Value::List(values) => CstInputValue::Array(values.iter().map(input_value).collect()),
        Value::Object(entries) => CstInputValue::Object(
            entries
                .iter()
                .map(|(name, value)| (name.clone(), input_value(value)))
                .collect(),
        ),
    }
}

/// Rassemble les valeurs **feuilles** du document, chacune avec son chemin.
///
/// Les éléments d'un tableau partagent le chemin de ce tableau : leur rang
/// n'entre pas dans leur identité, sans quoi ajouter un élément ferait
/// « disparaître » tous ceux qui le suivent.
fn collect_values(
    node: &CstNode,
    path: &str,
    valeurs: &mut Vec<SemanticValue>,
) -> Result<(), GrammarError> {
    if let Some(object) = node.as_object() {
        for property in object.properties() {
            let name = property_name(&property)?;
            let chemin = if path.is_empty() {
                name
            } else {
                format!("{path}.{name}")
            };
            let Some(value) = property.value() else {
                continue;
            };
            collect_values(&value, &chemin, valeurs)?;
        }
        return Ok(());
    }
    if let Some(array) = node.as_array() {
        for element in array.elements() {
            collect_values(&element, path, valeurs)?;
        }
        return Ok(());
    }
    let value = read_value(node)?;
    if value.is_leaf() {
        valeurs.push(SemanticValue::new(path, value));
    }
    Ok(())
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
