//! Le comportement `merge`, dans sa partie **pure** : la porte d'admission,
//! l'édition, et la post-condition sur la sortie. Aucune entrée-sortie ici —
//! l'écriture conditionnée du document appartient à la caisse qui la porte.
//!
//! **Trois étapes, dans cet ordre, et l'ordre est le fond.**
//!
//! La porte d'admission d'abord : une grammaire dont l'implémentation ne rend
//! pas les octets hors trace ne doit pas atteindre le document. Le refus tombe
//! donc **avant** qu'un rendu existe, et à plus forte raison avant qu'il
//! remplace quoi que ce soit.
//!
//! L'édition ensuite, sur la structure de la grammaire.
//!
//! La post-condition enfin, et elle porte **sur la sortie**. Ce que les
//! contrôles d'entrée disent est ce qu'on a cru comprendre ; ce que la
//! post-condition dit est ce qu'on a fait. Elle compare les valeurs
//! sémantiques d'avant et d'après : constater la présence de ce qu'on a ajouté
//! ne dit **rien** de ce qu'on a détruit, et c'est par ce trou qu'une valeur
//! écrite par l'utilisateur est sortie d'un tableau.

use std::fmt;

use crate::{
    values_lost, Applied, Capabilities, Edit, Grammar, GrammarError, Inverse, MergeAdmission,
    MergeRefusal, SemanticValue,
};

/// Ce qu'une fusion réussie rend : le document à écrire, et la trace qui le
/// défait.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Merged {
    /// Le document rendu, à écrire tel quel.
    pub rendered: String,
    /// Ce qui défait cette fusion.
    pub inverse: Inverse,
}

/// Pourquoi une fusion n'a pas eu lieu. Aucune de ces trois variantes ne
/// laisse un document remplacé : la première tombe avant tout rendu, les deux
/// autres rendent un document qui n'a jamais quitté la mémoire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeError {
    /// La grammaire n'est pas admise au comportement `merge`.
    NotAdmitted(MergeRefusal),
    /// La grammaire a refusé de lire ou d'écrire, en se nommant.
    Grammar(GrammarError),
    /// La post-condition a constaté la disparition de valeurs que le document
    /// portait avant l'édition.
    ValuesLost {
        /// La grammaire qui a écrit.
        grammar: &'static str,
        /// Les valeurs disparues, avec leur chemin.
        lost: Vec<SemanticValue>,
    },
}

impl From<GrammarError> for MergeError {
    fn from(err: GrammarError) -> Self {
        Self::Grammar(err)
    }
}

impl fmt::Display for MergeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotAdmitted(refusal) => write!(f, "{refusal}"),
            Self::Grammar(err) => write!(f, "{err}"),
            Self::ValuesLost { grammar, lost } => {
                write!(
                    f,
                    "grammaire `{grammar}` : l'écriture a fait disparaître {} valeur(s) que le \
                     document portait —",
                    lost.len()
                )?;
                for valeur in lost {
                    write!(f, " {valeur}")?;
                }
                Ok(())
            }
        }
    }
}

impl std::error::Error for MergeError {}

/// Fusionne `edit` dans `source` sous la grammaire `G`.
///
/// Rend le document à écrire et sa trace inverse, ou dit pourquoi il n'y en a
/// pas — sans jamais rendre un document partiellement édité : une fusion qui
/// échoue ne rend rien du tout, et c'est ce qui fait de l'annulation la
/// conduite par défaut plutôt qu'une conduite à écrire à chaque appelant.
pub fn merge<G: Grammar>(source: &str, edit: &Edit) -> Result<Merged, MergeError> {
    // La porte est interrogée à chaque appel, et sa réponse est **mesurée**,
    // pas lue dans une table calculée ailleurs : le corpus du dépôt y est
    // retraversé. Le coût est celui de quelques documents de réglages, et il
    // est payé pour que la table ne puisse pas se tromper entre le moment où
    // elle est calculée et celui où elle sert. Le jour où il pèsera, le
    // remède est un cache — donc une invalidation à écrire, et une raison de
    // ne pas le faire avant d'avoir mesuré.
    match Capabilities::of::<G>().merge() {
        MergeAdmission::Admitted => {}
        MergeAdmission::Refused(refusal) => return Err(MergeError::NotAdmitted(refusal.clone())),
    }

    let avant = G::values(source)?;
    let Applied { rendered, inverse } = G::apply(source, edit)?;

    // Relire le rendu est ce qui rend la post-condition possible, et c'est
    // aussi ce qui prouve que la sortie est reparsable : une sortie que sa
    // propre grammaire ne relit pas est un document détruit, quoi qu'en dise
    // le reste.
    let apres = G::values(&rendered)?;
    // Ce que la trace enregistre est soustrait de ce qui a disparu : la
    // différence doit se réduire **exactement** à la trace, ni plus — une
    // valeur détruite hors trace est irretirable — ni moins — une mise à jour
    // remplace une valeur, et c'est son objet.
    let disparues = values_lost(&avant, &apres);
    let lost = values_lost(&disparues, &inverse.recorded_values());
    if !lost.is_empty() {
        return Err(MergeError::ValuesLost {
            grammar: G::NAME,
            lost,
        });
    }

    Ok(Merged { rendered, inverse })
}
