//! Ce que le produit demande d'écrire, ce qui le défait, et les valeurs qu'un
//! document porte.
//!
//! **Adressé par chemin de grammaire, jamais par numéro de ligne.** C'est
//! l'énoncé du plan de fichiers, et c'est la seule chose que ce module rend
//! structurellement vraie : il n'existe ici aucun type qui sache dire « à
//! cette ligne », donc aucune implémentation ne peut en fabriquer un sans
//! ajouter le type qui manque, sous les yeux d'un relecteur.
//!
//! **Deux formes d'édition, et la troisième n'est pas ici.** Le plan en donne
//! trois : « ces clés à ce chemin », « ces valeurs dans ce tableau à ce
//! chemin », et « ce bloc entre ces bornes ». Les deux premières vivent ici ;
//! la troisième dépend d'une syntaxe de marqueurs qui n'existe pas encore et
//! qui est la tranche suivante. L'écrire aujourd'hui figerait la forme d'une
//! trace avant les scénarios qui la contraignent.
//!
//! **La désignation d'une valeur de tableau se fait par égalité de valeur.**
//! Un indice ne survit pas plus à un réordonnancement qu'un numéro de ligne à
//! un reformatage — c'est le motif d'origine de l'interdiction du positionnel,
//! appliqué à un axe de plus.

use std::fmt;

/// Une valeur telle qu'un document en porte : ce que le produit écrit, et ce
/// qu'il retrouve pour le rétablir.
///
/// Les nombres sont gardés sous leur **texte d'origine** et non convertis :
/// `1.50` et `1.5` sont le même nombre et deux documents différents, et
/// l'inverse doit rendre les octets d'avant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Value {
    /// Une chaîne, décodée.
    Text(String),
    /// Un nombre, sous le texte que le document portait.
    Number(String),
    /// Un booléen.
    Bool(bool),
    /// L'absence de valeur, telle que le document la nomme.
    Null,
    /// Une liste de valeurs.
    List(Vec<Value>),
    /// Un objet, clés dans l'ordre du document.
    Object(Vec<(String, Value)>),
}

impl Value {
    /// Une valeur de texte, construite depuis n'importe quoi qui en donne un.
    pub fn text(value: impl Into<String>) -> Self {
        Self::Text(value.into())
    }

    /// Une valeur qui n'en contient pas d'autre. C'est de celles-là que se
    /// fait le multiensemble comparé par la post-condition : comparer un objet
    /// entier masquerait la disparition d'une de ses feuilles derrière
    /// l'apparition d'une autre.
    pub fn is_leaf(&self) -> bool {
        !matches!(self, Self::List(_) | Self::Object(_))
    }
}

impl fmt::Display for Value {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Text(text) => write!(f, "{text:?}"),
            Self::Number(raw) => write!(f, "{raw}"),
            Self::Bool(value) => write!(f, "{value}"),
            Self::Null => write!(f, "null"),
            Self::List(values) => {
                write!(f, "[")?;
                for (rang, value) in values.iter().enumerate() {
                    if rang > 0 {
                        write!(f, ", ")?;
                    }
                    write!(f, "{value}")?;
                }
                write!(f, "]")
            }
            Self::Object(entries) => {
                write!(f, "{{")?;
                for (rang, (name, value)) in entries.iter().enumerate() {
                    if rang > 0 {
                        write!(f, ", ")?;
                    }
                    write!(f, "{name}: {value}")?;
                }
                write!(f, "}}")
            }
        }
    }
}

/// Ce que le produit demande d'écrire dans un document possédé.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Edit {
    /// « Ces clés à ce chemin ». Une clé déjà présente voit sa valeur
    /// remplacée, et l'inverse porte de quoi rétablir l'ancienne.
    Keys {
        /// Le chemin de l'objet qui porte ces clés. Vide pour la racine.
        path: Vec<String>,
        /// Les clés et leurs valeurs, dans l'ordre où elles sont écrites.
        entries: Vec<(String, Value)>,
    },
    /// « Ces valeurs dans ce tableau à ce chemin ». Une valeur déjà présente
    /// n'est pas ajoutée et n'entre pas dans la trace.
    Values {
        /// Le chemin du tableau, dernier segment compris.
        path: Vec<String>,
        /// Les valeurs à y trouver ou à y mettre.
        values: Vec<String>,
    },
}

impl Edit {
    /// « Ces clés à ce chemin ».
    pub fn keys(
        path: &[&str],
        entries: impl IntoIterator<Item = (impl Into<String>, Value)>,
    ) -> Self {
        Self::Keys {
            path: chemin(path),
            entries: entries
                .into_iter()
                .map(|(name, value)| (name.into(), value))
                .collect(),
        }
    }

    /// « Ces valeurs dans ce tableau à ce chemin ».
    pub fn values(path: &[&str], values: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self::Values {
            path: chemin(path),
            values: values.into_iter().map(Into::into).collect(),
        }
    }

    /// Le chemin visé, tel qu'un refus le nomme.
    pub fn path(&self) -> &[String] {
        match self {
            Self::Keys { path, .. } | Self::Values { path, .. } => path,
        }
    }
}

/// Ce qui défait exactement l'édition qui l'a produite — et **rien d'autre**.
/// Ce que le produit n'a pas écrit n'y figure pas, donc ne peut pas en sortir.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Inverse {
    /// Retirer les clés que l'édition a ajoutées, rétablir celles dont elle a
    /// remplacé la valeur.
    Keys {
        /// Le chemin de l'objet.
        path: Vec<String>,
        /// Les clés que l'édition a créées, à retirer.
        added: Vec<String>,
        /// Les clés dont l'édition a remplacé la valeur, et cette valeur.
        replaced: Vec<(String, Value)>,
    },
    /// Retirer du tableau les valeurs que l'édition y a mises, par égalité de
    /// valeur.
    Values {
        /// Le chemin du tableau.
        path: Vec<String>,
        /// Les valeurs que l'édition a ajoutées.
        added: Vec<String>,
    },
}

impl Inverse {
    /// Rien à défaire : l'édition n'a rien écrit. C'est le cas d'une valeur
    /// qui préexistait, que le produit n'a donc pas ajoutée et ne retirera
    /// jamais.
    pub fn is_empty(&self) -> bool {
        match self {
            Self::Keys {
                added, replaced, ..
            } => added.is_empty() && replaced.is_empty(),
            Self::Values { added, .. } => added.is_empty(),
        }
    }

    /// Les valeurs que le document portait et que la trace **enregistre**,
    /// c'est-à-dire celles qu'elle sait rétablir.
    ///
    /// **Pourquoi la post-condition en a besoin.** L'exigence n'est pas que
    /// rien ne disparaisse — une mise à jour remplace une valeur par une
    /// autre, et c'est son objet. L'exigence est que la différence entre le
    /// document d'avant et celui d'après se réduise **exactement à ce que la
    /// trace enregistre**. Une valeur remplacée est donc portée par la trace,
    /// donc défaisable ; une valeur disparue sans y figurer ne l'est pas, et
    /// c'est celle-là que la post-condition doit attraper.
    pub fn recorded_values(&self) -> Vec<SemanticValue> {
        let mut valeurs = Vec::new();
        if let Self::Keys { path, replaced, .. } = self {
            for (name, value) in replaced {
                let mut chemin = path.clone();
                chemin.push(name.clone());
                flatten(value, &chemin.join("."), &mut valeurs);
            }
        }
        valeurs
    }
}

/// Rassemble les valeurs feuilles d'une valeur composée, chacune avec son
/// chemin — les éléments d'une liste partageant celui de la liste, comme dans
/// l'énumération que rend une grammaire.
fn flatten(value: &Value, path: &str, valeurs: &mut Vec<SemanticValue>) {
    match value {
        Value::List(values) => {
            for value in values {
                flatten(value, path, valeurs);
            }
        }
        Value::Object(entries) => {
            for (name, value) in entries {
                let chemin = if path.is_empty() {
                    name.clone()
                } else {
                    format!("{path}.{name}")
                };
                flatten(value, &chemin, valeurs);
            }
        }
        feuille => valeurs.push(SemanticValue::new(path, feuille.clone())),
    }
}

/// Le rendu d'une édition et la trace qui la défait, produits par la **même**
/// analyse : un second chemin de lecture divergerait de celui qui a écrit, et
/// le passage que le produit croit posséder s'élargirait en silence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Applied {
    /// Le document rendu après l'édition.
    pub rendered: String,
    /// Ce qui défait cette édition.
    pub inverse: Inverse,
}

/// Une valeur que le document porte, et le chemin où elle vit.
///
/// Les éléments d'un tableau partagent le chemin de ce tableau : leur rang
/// n'entre pas dans leur identité, pour la même raison qu'il n'entre pas dans
/// celle d'un élément qu'on retire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SemanticValue {
    path: String,
    value: Value,
}

impl SemanticValue {
    /// Une valeur à un chemin.
    pub fn new(path: impl Into<String>, value: Value) -> Self {
        Self {
            path: path.into(),
            value,
        }
    }

    /// Le chemin où elle vit.
    pub fn path(&self) -> &str {
        &self.path
    }

    /// La valeur elle-même.
    pub fn value(&self) -> &Value {
        &self.value
    }
}

impl fmt::Display for SemanticValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} = {}", self.path, self.value)
    }
}

/// Les valeurs d'`avant` que le multiensemble d'`apres` ne contient pas.
///
/// **Un multiensemble, et pas un ensemble.** Un document peut porter deux fois
/// la même valeur au même chemin — deux règles identiques dans un tableau —,
/// et en perdre une est une perte. Comparer des ensembles la rendrait
/// invisible.
pub fn values_lost(avant: &[SemanticValue], apres: &[SemanticValue]) -> Vec<SemanticValue> {
    let mut restantes: Vec<&SemanticValue> = apres.iter().collect();
    let mut perdues = Vec::new();
    for valeur in avant {
        match restantes.iter().position(|candidate| *candidate == valeur) {
            Some(rang) => {
                restantes.remove(rang);
            }
            None => perdues.push(valeur.clone()),
        }
    }
    perdues
}

fn chemin(path: &[&str]) -> Vec<String> {
    path.iter().map(|segment| (*segment).to_string()).collect()
}
