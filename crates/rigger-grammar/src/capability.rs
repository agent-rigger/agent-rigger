//! La table de ce que chaque grammaire sait exprimer, **dérivée des
//! implémentations** partout où cela se mesure, et déclarée avec sa source
//! là où cela ne se mesure pas.
//!
//! **Le point entier de ce module.** Répondre à « cette grammaire préserve-t-elle
//! la trivia ? » **exécute** l'aller-retour sur la sonde de la grammaire et
//! compare les octets. Répondre à « sait-elle désigner un élément de liste ? »
//! **exécute** la recherche. Il n'existe aucun autre constructeur de
//! [`Capabilities`] que [`Capabilities::of`] : une capacité ne peut pas être
//! **annoncée** ailleurs que là où elle est **exécutée**. C'est ce que la
//! tranche T3a existe pour fermer — un test de caractérisation décrit une
//! limite, il ne l'impose pas.
//!
//! **Ce que la dérivation garantit, et ce qu'elle ne garantit pas.** La
//! phrase « une capacité annoncée sans implémentation est impossible à
//! écrire » a figuré ici, et elle était fausse : la sonde comme l'aller-retour
//! sont fournis par la grammaire jugée, donc une implémentation qui rend son
//! entrée telle quelle sur une sonde édulcorée se créditait de tout. Ce que
//! `measure_trivia` exige désormais coûte quelque chose à qui voudrait
//! recommencer — trois dimensions de trivia hostile dans la sonde, un
//! fragment de commentaire dont l'optionalité est **exécutée**, et le refus
//! d'un document qui n'en est pas un, qui est ce qui distingue un analyseur
//! d'une fonction identité. Aucune de ces épreuves ne rend la tricherie
//! impossible ; toutes la rendent visible et coûteuse. Le second témoin est
//! ailleurs, et il est délibérément hors de portée de l'auteur d'une
//! grammaire : `tests/conformance.rs` exige de toute grammaire publiée ici
//! qu'elle traverse le corpus du dépôt, dont les pièges sont gardés par un
//! test qui ne lui appartient pas.
//!
//! **Deux termes ne s'exécutent pas.** La sensibilité à l'ordre de la
//! [`Resolution`] est une propriété de qui lit le document et non du code qui
//! l'écrit. Le [`GrammarRole`] est une **décision** produit sur ce que le
//! produit s'autorise à écrire, et non une mesure. Les deux sont déclarés par
//! chaque grammaire avec sa source datée, et la décision d'admission les lit
//! dans cette table — jamais dans une liste d'hôtes.

use std::fmt;

use crate::{Grammar, Jsonc, Toml};

/// Ce que le produit s'autorise à faire des documents d'une grammaire.
///
/// Ce terme-ci est **déclaré**, comme [`Resolution`] et pour une raison du
/// même ordre : il n'est pas mesurable par cette caisse aujourd'hui, parce
/// qu'**aucune** grammaire n'y a de chemin d'écriture — celui de JSONC arrive
/// avec la tranche T3b. Le mesurer sur l'existant reviendrait à refuser
/// toutes les grammaires, ce que le scénario nominal de C7 interdit.
///
/// **La dette que cela laisse, et qui la collecte.** Le jour où un chemin
/// d'écriture existe, l'admission doit l'exiger en plus de cette déclaration
/// — une grammaire qui se déclare [`GrammarRole::ReadWrite`] sans en avoir un
/// serait alors une capacité annoncée sans implémentation, et c'est
/// exactement ce que ce module existe pour rendre faux. C'est écrit ici parce
/// que T3b passe par ce fichier.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrammarRole {
    /// Le produit lit ces documents et n'y écrit jamais. Décision produit :
    /// le refus est catégorique et ne dépend d'aucune mesure — ni d'une
    /// bibliothèque, ni d'un octet perdu.
    ReadOnly,
    /// Le produit écrit dans ces documents.
    ReadWrite,
}

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
    /// Le produit n'écrit pas les documents de cette grammaire. Raison
    /// **catégorique** : elle ne se lève par aucune mesure, et surtout pas
    /// par la correction d'une bibliothèque.
    ReadOnlyGrammar,
    /// L'aller-retour sur la sonde n'a pas rendu les octets hors trace.
    TriviaNotPreserved(TriviaDivergence),
    /// La résolution du document dépend de l'ordre d'apparition.
    ResolutionDependsOnOrder,
    /// La lecture de la sonde a elle-même échoué : une grammaire qui ne sait
    /// pas relire son propre document ne peut rien promettre de ce qu'elle y
    /// écrirait.
    ProbeUnreadable(crate::GrammarError),
    /// La sonde ne porte pas la dimension de trivia hostile nommée, donc la
    /// préservation ne s'y mesure pas sur cette dimension : un aller-retour
    /// qui la détruit y passerait pour fidèle.
    ProbeWithoutHostileTrivia {
        /// La dimension absente.
        dimension: &'static str,
    },
    /// La grammaire a accepté un document qui n'en est pas un. Il n'y a donc
    /// pas d'analyseur derrière son aller-retour, et une fonction identité
    /// rendrait n'importe quelle sonde à l'octet près sans avoir rien
    /// compris du document.
    MalformedDocumentAccepted,
    /// Le fragment que la sonde déclare comme commentaire ne l'est pas : le
    /// document privé de ce fragment n'est plus lisible, donc ce fragment
    /// porte de la donnée et la dimension « commentaire » n'est pas mesurée.
    ProbeCommentIsNotTrivia(crate::GrammarError),
}

impl fmt::Display for RefusalReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ReadOnlyGrammar => write!(
                f,
                "le produit n'écrit pas les documents de cette grammaire — elle est en lecture \
                 seule par décision produit, et cette raison ne se lève par aucune mesure"
            ),
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
            Self::ProbeWithoutHostileTrivia { dimension } => write!(
                f,
                "la sonde de la grammaire ne porte pas la dimension « {dimension} » — la \
                 préservation des octets hors trace n'y est pas mesurable"
            ),
            Self::MalformedDocumentAccepted => write!(
                f,
                "la grammaire a accepté un document qui n'en est pas un — son aller-retour ne \
                 passe par aucun analyseur, et rendrait sa sonde à l'octet près sans rien en \
                 avoir compris"
            ),
            Self::ProbeCommentIsNotTrivia(err) => write!(
                f,
                "le fragment que la sonde déclare commentaire porte de la donnée : le document \
                 privé de ce fragment n'est plus lisible — {err}"
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
    role: GrammarRole,
    trivia: Result<(), RefusalReason>,
    designates_list_element: bool,
    resolution: Resolution,
    merge: MergeAdmission,
}

impl Capabilities {
    /// Mesure les capacités de `G` en exécutant ses propriétés sur sa sonde.
    pub fn of<G: Grammar>() -> Self {
        let probe = G::PROBE;

        let trivia = measure_trivia::<G>();

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

        // Les raisons sont accumulées de la plus catégorique à la plus
        // contingente, et toutes sont portées : un refus qui n'en donne
        // qu'une laisse croire que lever celle-là suffirait. La lecture
        // seule vient donc en tête — elle ne se lève par aucune mesure.
        let mut reasons = Vec::new();
        if G::ROLE == GrammarRole::ReadOnly {
            reasons.push(RefusalReason::ReadOnlyGrammar);
        }
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
            role: G::ROLE,
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

    /// Ce que le produit s'autorise à faire de ses documents.
    pub fn role(&self) -> GrammarRole {
        self.role
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

/// Mesure la préservation de la trivia de `G`, en cinq épreuves qui vont de
/// l'instrument vers la mesure.
///
/// **Les trois premières portent sur l'instrument**, et elles existent parce
/// que la sonde comme l'aller-retour sont fournis par la grammaire jugée. Une
/// sonde édulcorée, ou une implémentation qui rend son entrée telle quelle,
/// rendrait la réponse trivialement vraie ; ces trois épreuves sont ce qui
/// coûte quelque chose à qui voudrait annoncer une capacité qu'il n'a pas.
/// Elles ne rendent pas l'annonce mensongère impossible — voir l'en-tête du
/// module —, elles la rendent mesurablement fausse sur ce qui est mesurable.
fn measure_trivia<G: Grammar>() -> Result<(), RefusalReason> {
    let probe = G::PROBE;

    // 1. L'instrument porte les trois dimensions de trivia hostile. Les deux
    //    premières se reconnaissent sans rien savoir de la grammaire ; la
    //    troisième est déclarée, et vérifiée en 3.
    for (dimension, present) in [
        ("fin de ligne CRLF", probe.source.contains("\r\n")),
        (
            "ligne indentée",
            probe
                .source
                .lines()
                .any(|line| line.starts_with(' ') || line.starts_with('\t')),
        ),
        (
            "commentaire",
            !probe.comment.is_empty() && probe.source.contains(probe.comment),
        ),
    ] {
        if !present {
            return Err(RefusalReason::ProbeWithoutHostileTrivia { dimension });
        }
    }

    // 2. Un analyseur existe. Ce qui distingue une grammaire d'une fonction
    //    identité n'est pas ce qu'elle rend, c'est ce qu'elle **refuse** :
    //    une identité rend n'importe quelle sonde à l'octet près et serait
    //    créditée de tout. Le refus est donc une condition de la mesure, pas
    //    une propriété distincte.
    //
    //    Conséquence assumée, écrite ici plutôt que découverte plus tard :
    //    une grammaire dont le langage accepte **tout texte** échoue cette
    //    épreuve et n'est pas admise. C'est le bon sens du refus — sa
    //    préservation ne se mesure pas par un aller-retour, elle se mesurera
    //    sur son chemin d'écriture, et l'admission se rouvrira alors avec un
    //    motif au lieu d'avoir été accordée par défaut.
    let not_a_document = format!("{}{}", crate::NOT_A_DOCUMENT, probe.source);
    if G::round_trip(&not_a_document).is_ok() {
        return Err(RefusalReason::MalformedDocumentAccepted);
    }

    // 3. Le fragment déclaré commentaire en est un. Retiré, le document doit
    //    rester lisible — sinon il portait de la donnée, et la dimension
    //    « commentaire » n'était portée que dans la déclaration.
    if let Err(err) = G::round_trip(&probe.source.replace(probe.comment, "")) {
        return Err(RefusalReason::ProbeCommentIsNotTrivia(err));
    }

    // 4 et 5. La mesure elle-même : la sonde est relue, et les octets rendus
    //    sont comparés aux octets d'entrée.
    match G::round_trip(probe.source) {
        Err(err) => Err(RefusalReason::ProbeUnreadable(err)),
        Ok(rendered) => match TriviaDivergence::measure(probe.source, &rendered) {
            Some(divergence) => Err(RefusalReason::TriviaNotPreserved(divergence)),
            None => Ok(()),
        },
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
