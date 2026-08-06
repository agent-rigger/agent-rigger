//! La table de ce que chaque grammaire sait exprimer, **dérivée des
//! implémentations** et non déclarée à la main.
//!
//! **Le point entier de ce module.** Répondre à « cette grammaire préserve-t-elle
//! la trivia ? » **exécute** l'aller-retour sur la sonde de la grammaire et
//! compare les octets. Répondre à « sait-elle désigner un élément de liste ? »
//! **exécute** la recherche. Il n'existe aucun autre constructeur de
//! [`Capabilities`] que [`Capabilities::of`] : une capacité annoncée sans
//! implémentation n'est pas seulement détectée, elle est **impossible à
//! écrire**. C'est ce que la tranche T3a existe pour fermer — un test de
//! caractérisation décrit une limite, il ne l'impose pas.
//!
//! Un seul terme n'est pas exécutable : la sensibilité à l'ordre de la
//! **résolution**, qui est une propriété de qui lit le document et non du code
//! qui l'écrit. Elle est déclarée par chaque grammaire, avec sa source datée,
//! et la décision d'admission la lit dans cette table — jamais dans une liste
//! d'hôtes.

use std::fmt;

use crate::{Grammar, Jsonc, Toml};

/// La sensibilité à l'ordre de la résolution d'un document.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resolution {
    /// L'ordre d'apparition décide de ce qui l'emporte. Poser une clé au
    /// mauvais rang y est inopérant sans erreur et sans trace.
    DependsOnOrder,
    /// L'ordre n'entre pas dans la résolution.
    IndependentOfOrder,
}

/// Ce qui a divergé quand l'aller-retour n'a pas rendu les octets. Mesuré,
/// jamais supposé : c'est ce que le refus nomme.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TriviaDivergence {
    first_divergent_offset: usize,
    crlf_in: usize,
    crlf_out: usize,
    bytes_in: usize,
    bytes_out: usize,
}

impl TriviaDivergence {
    fn measure(input: &str, output: &str) -> Option<Self> {
        if input == output {
            return None;
        }
        let (input, output) = (input.as_bytes(), output.as_bytes());
        let first_divergent_offset = input
            .iter()
            .zip(output.iter())
            .position(|(a, b)| a != b)
            .unwrap_or_else(|| input.len().min(output.len()));
        Some(Self {
            first_divergent_offset,
            crlf_in: input.iter().filter(|&&b| b == b'\r').count(),
            crlf_out: output.iter().filter(|&&b| b == b'\r').count(),
            bytes_in: input.len(),
            bytes_out: output.len(),
        })
    }
}

impl fmt::Display for TriviaDivergence {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Le libellé se déduit de la mesure : nommer « les fins de ligne »
        // quand ce sont elles qui manquent, et le seul offset quand la perte
        // est ailleurs. Un libellé écrit à la main survivrait à un changement
        // de cause en désignant toujours la mauvaise.
        if self.crlf_out < self.crlf_in {
            write!(
                f,
                "les fins de ligne ({} CRLF en entrée, {} en sortie)",
                self.crlf_in, self.crlf_out
            )
        } else {
            write!(
                f,
                "les octets à partir de l'offset {} (entrée {} octets, sortie {})",
                self.first_divergent_offset, self.bytes_in, self.bytes_out
            )
        }
    }
}

/// Pourquoi le comportement `merge` est refusé sur une grammaire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefusalReason {
    /// L'aller-retour sur la sonde n'a pas rendu les octets hors trace.
    TriviaNotPreserved(TriviaDivergence),
    /// La résolution du document dépend de l'ordre d'apparition.
    ResolutionDependsOnOrder,
    /// La lecture de la sonde a elle-même échoué : une grammaire qui ne sait
    /// pas relire son propre document ne peut rien promettre de ce qu'elle y
    /// écrirait.
    ProbeUnreadable(crate::GrammarError),
    /// La sonde ne porte pas de trivia hostile, donc la préservation ne s'y
    /// mesure pas : un aller-retour qui reformate y passerait pour fidèle.
    ProbeWithoutHostileTrivia,
}

impl fmt::Display for RefusalReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TriviaNotPreserved(divergence) => write!(
                f,
                "l'aller-retour ne rend pas les octets hors trace : {divergence}"
            ),
            Self::ResolutionDependsOnOrder => write!(
                f,
                "la résolution du document dépend de l'ordre d'apparition — une pose par clés y \
                 serait inopérante sans erreur et sans trace"
            ),
            Self::ProbeUnreadable(err) => {
                write!(f, "la sonde de la grammaire n'est pas relisible : {err}")
            }
            Self::ProbeWithoutHostileTrivia => write!(
                f,
                "la sonde de la grammaire ne porte aucune fin de ligne CRLF — la préservation \
                 des octets hors trace n'y est pas mesurable"
            ),
        }
    }
}

/// Le refus lui-même : il nomme la grammaire, le comportement, et chaque
/// raison. Chaque raison est portée séparément, parce qu'un refus qui n'en
/// donne qu'une laisse croire que lever celle-là suffirait.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeRefusal {
    grammar: &'static str,
    reasons: Vec<RefusalReason>,
}

impl MergeRefusal {
    /// La grammaire refusée.
    pub fn grammar(&self) -> &'static str {
        self.grammar
    }

    /// Les raisons du refus, dans l'ordre où elles ont été constatées.
    pub fn reasons(&self) -> &[RefusalReason] {
        &self.reasons
    }
}

impl fmt::Display for MergeRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "le comportement `merge` est refusé sur la grammaire `{}`",
            self.grammar
        )?;
        for reason in &self.reasons {
            write!(f, " ; {reason}")?;
        }
        Ok(())
    }
}

/// L'admission d'une grammaire au comportement `merge`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeAdmission {
    /// La grammaire est admise.
    Admitted,
    /// La grammaire est refusée, en la nommant.
    Refused(MergeRefusal),
}

/// Ce qu'une grammaire sait exprimer.
///
/// Les champs sont privés et [`Capabilities::of`] est le seul chemin qui en
/// construit une. Ce n'est pas une précaution de style : c'est la garantie
/// qu'aucune capacité ne peut être **annoncée** ailleurs que là où elle est
/// **exécutée**.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Capabilities {
    grammar: &'static str,
    trivia: Result<(), RefusalReason>,
    designates_list_element: bool,
    resolution: Resolution,
    merge: MergeAdmission,
}

impl Capabilities {
    /// Mesure les capacités de `G` en exécutant ses propriétés sur sa sonde.
    pub fn of<G: Grammar>() -> Self {
        let probe = G::PROBE;

        // La sonde est l'instrument de mesure. Un instrument sans trivia
        // hostile répondrait « préservée » à n'importe quelle implémentation,
        // et la table mentirait sans qu'aucun test ne rougisse. La fin de
        // ligne CRLF est la dimension sur laquelle une bibliothèque épinglée a
        // réellement échoué (`tests/limites_connues.rs`) : c'est donc elle que
        // la sonde doit porter pour que la question ait un sens.
        let trivia = if !probe.source.contains("\r\n") {
            Err(RefusalReason::ProbeWithoutHostileTrivia)
        } else {
            match G::round_trip(probe.source) {
                Err(err) => Err(RefusalReason::ProbeUnreadable(err)),
                Ok(rendered) => match TriviaDivergence::measure(probe.source, &rendered) {
                    Some(divergence) => Err(RefusalReason::TriviaNotPreserved(divergence)),
                    None => Ok(()),
                },
            }
        };

        // Désigner un élément de liste, c'est trouver celui qui y est et ne
        // pas trouver celui qui n'y est pas. Une implémentation qui répond
        // sans regarder le document échoue sur la seconde moitié.
        let designates_list_element = matches!(
            G::find_string_in_list(probe.source, probe.list_path, probe.value_present),
            Ok(true)
        ) && matches!(
            G::find_string_in_list(probe.source, probe.list_path, probe.value_absent),
            Ok(false)
        );

        let mut reasons = Vec::new();
        if let Err(reason) = &trivia {
            reasons.push(reason.clone());
        }
        if G::RESOLUTION == Resolution::DependsOnOrder {
            reasons.push(RefusalReason::ResolutionDependsOnOrder);
        }
        let merge = if reasons.is_empty() {
            MergeAdmission::Admitted
        } else {
            MergeAdmission::Refused(MergeRefusal {
                grammar: G::NAME,
                reasons,
            })
        };

        Self {
            grammar: G::NAME,
            trivia,
            designates_list_element,
            resolution: G::RESOLUTION,
            merge,
        }
    }

    /// Le nom de la grammaire mesurée.
    pub fn grammar(&self) -> &'static str {
        self.grammar
    }

    /// La grammaire rend-elle les octets hors trace à l'identique.
    pub fn preserves_trivia(&self) -> bool {
        self.trivia.is_ok()
    }

    /// La grammaire sait-elle désigner un élément de liste par sa valeur.
    pub fn designates_list_element(&self) -> bool {
        self.designates_list_element
    }

    /// La sensibilité à l'ordre de la résolution de ses documents.
    pub fn resolution(&self) -> Resolution {
        self.resolution
    }

    /// L'admission au comportement `merge`, et son refus nommé le cas échéant.
    pub fn merge(&self) -> &MergeAdmission {
        &self.merge
    }
}

/// La table des capacités des grammaires que cette caisse porte aujourd'hui.
///
/// Elle en portera d'autres — le bloc borné par marqueurs et la lecture
/// d'entête —, et chacune s'ajoutera ici par une ligne d'appel, sa mesure
/// venant de son implémentation.
pub fn table() -> Vec<Capabilities> {
    vec![Capabilities::of::<Jsonc>(), Capabilities::of::<Toml>()]
}
