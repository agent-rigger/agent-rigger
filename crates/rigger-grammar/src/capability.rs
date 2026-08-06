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
//! `measure_trivia` exige coûte quelque chose à qui voudrait recommencer —
//! trois dimensions de trivia hostile dans la sonde, un fragment de
//! commentaire dont l'optionalité est **exécutée**, et le refus de documents
//! qui n'en sont pas, qui est ce qui distingue un analyseur d'une fonction
//! identité.
//!
//! **Deux choses que la sonde seule ne pouvait pas fermer, et qui sont
//! fermées ici.** Elles ont toutes deux la même cause : ce sur quoi la mesure
//! porte était choisi par celui qu'elle juge.
//!
//! *La sonde ne porte que la trivia que son auteur y met.* Les trois
//! dimensions exigées nomment des catégories, pas des formes : une grammaire
//! dont le rendu détruit les commentaires de **bloc**, avec une sonde ne
//! portant qu'un commentaire de ligne, passait les trois et se créditait de
//! la préservation. La mesure porte donc aussi sur [`SHARED_CORPUS`], les
//! documents du dépôt — que l'auteur d'une grammaire ne choisit pas, dont les
//! pièges sont gardés par `tests/conformance.rs`, et que **toute** grammaire
//! se voit proposer quelle que soit leur extension. Ce qu'une grammaire lit
//! d'eux, elle doit le rendre à l'octet près ; et une grammaire qui n'en lit
//! aucun n'est mesurée que sur elle-même, donc n'est pas mesurée.
//!
//! *Un refus se contrefait.* Refuser un document préfixé d'une constante
//! publique ne demande pas de savoir lire : `starts_with` suffit, et une
//! fonction identité s'en trouvait créditée d'un analyseur. Les documents
//! dont le refus est exigé sont donc **dérivés du document lui-même** — voir
//! [`mutations`] : suivi de ce qui n'est pas un document, et concaténé à
//! lui-même, deux formes qui commencent par les mêmes octets que l'original
//! et que seule une lecture de la structure distingue.
//!
//! Aucune de ces épreuves ne rend la tricherie impossible : le corpus du
//! dépôt est lisible, et ses mutations sont énumérables par qui veut les
//! recopier en dur. Toutes la rendent visible et coûteuse, et aucune ne se
//! satisfait plus d'un document que l'auteur de la grammaire a apporté.
//!
//! **Deux termes ne s'exécutent pas.** La sensibilité à l'ordre de la
//! [`Resolution`] est une propriété de qui lit le document et non du code qui
//! l'écrit. Le [`GrammarRole`] est une **décision** produit sur ce que le
//! produit s'autorise à écrire, et non une mesure. Les deux sont déclarés par
//! chaque grammaire avec sa source datée, et la décision d'admission les lit
//! dans cette table — jamais dans une liste d'hôtes.

use std::fmt;

use crate::{Grammar, Jsonc, Toml};

/// Les documents du dépôt, embarqués dans la caisse : le second témoin de la
/// dérivation, et le seul qui ne soit pas fourni par la grammaire jugée.
///
/// **Pourquoi ils vivent dans la bibliothèque et pas dans un test.** La porte
/// d'admission doit être mécanique (`docs/specs/socle-neuf/tasks.md` § T3a) :
/// une table qui se trompe pendant qu'un test rougit reste une table qui se
/// trompe pour qui l'appelle. La mesure a donc besoin des documents au moment
/// où elle répond, pas au moment où la suite tourne.
///
/// **Pourquoi ils restent physiquement dans `tests/corpus/`.** C'est le
/// domicile que le plan de fichiers de T1 leur donne, et les gardes de
/// fixture qui vérifient qu'ils portent encore leurs pièges y sont attachées.
/// `tests/conformance.rs` vérifie que cette liste nomme chaque fichier du
/// dossier : une liste et un dossier qui décrivent le même jeu sans se
/// rencontrer divergeraient, et la divergence prendrait la forme d'un
/// document ajouté au dépôt que la dérivation ne verrait jamais.
///
/// Ils sont proposés à **toute** grammaire, sans considération d'extension :
/// aiguiller un document vers une grammaire par son nom rendrait à l'auteur
/// d'une grammaire le choix de ce sur quoi il est jugé.
///
/// **La liste est énumérée par `build.rs`, jamais recopiée** — le script dit
/// les deux raisons, dont l'une est que le nom d'un de ces fichiers est un nom
/// d'hôte, que le scénario C7 interdit d'écrire dans cette source.
pub const SHARED_CORPUS: &[(&str, &str)] = genere::SHARED_CORPUS;

/// La liste écrite par `build.rs` à la compilation. Elle vit dans son propre
/// module pour que la documentation de [`SHARED_CORPUS`] reste ici, où elle se
/// lit avec le reste de la dérivation.
mod genere {
    include!(concat!(env!("OUT_DIR"), "/shared_corpus.rs"));
}

/// Les documents dérivés de `source` dont la dérivation exige le **refus**.
///
/// Ce que chacun coûte à contrefaire, qui est la seule raison de leur choix.
/// Le premier est préfixé de [`crate::NOT_A_DOCUMENT`] : il se refuse par un
/// `starts_with`, et il ne prouve donc rien à lui seul — il reste parce qu'un
/// document qui commence par ce qui n'en est pas un doit être refusé, et que
/// c'est la forme la plus lisible de l'épreuve. Les deux autres commencent
/// par les **mêmes octets que l'original** : les refuser demande de lire au
/// moins jusqu'à l'endroit où ils cessent d'être un document, c'est-à-dire
/// d'analyser. La concaténation à soi-même n'emploie aucune constante de
/// cette caisse : elle ne se reconnaît pas au motif, seulement à la structure
/// — deux racines en JSON, une clé ou une table définie deux fois en TOML.
pub fn mutations(source: &str) -> [(&'static str, String); 3] {
    [
        (
            "préfixé de ce qui n'est pas un document",
            format!("{}{source}", crate::NOT_A_DOCUMENT),
        ),
        (
            "suivi de ce qui n'est pas un document",
            format!("{source}{}", crate::NOT_A_DOCUMENT),
        ),
        ("concaténé à lui-même", format!("{source}{source}")),
    ]
}

/// Ce que le produit s'autorise à faire des documents d'une grammaire.
///
/// Ce terme-ci reste **déclaré**, comme [`Resolution`] : ce que le produit
/// s'autorise à écrire est une décision, et aucune mesure ne la remplace. Une
/// bibliothèque qui deviendrait fidèle ne rouvrirait pas une grammaire que le
/// produit a décidé de ne pas écrire.
///
/// **Ce que la déclaration ne suffit plus à obtenir, depuis T3b.** Elle ne
/// donne que le droit d'être mesurée. Une grammaire qui se déclare
/// [`GrammarRole::ReadWrite`] voit son chemin d'écriture **exécuté** par
/// [`Capabilities::of`] — poser, relire ce qui a été posé, défaire en rendant
/// la pré-image octet pour octet —, et le manque de l'un des trois la fait
/// refuser en le nommant. C'est la dette que ce module portait par écrit tant
/// qu'aucune grammaire n'avait de chemin d'écriture, et elle est collectée.
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
    MalformedDocumentAccepted {
        /// Le document dont la mutation a été acceptée.
        document: &'static str,
        /// La mutation acceptée, nommée — voir [`mutations`].
        mutation: &'static str,
    },
    /// Un document du corpus du dépôt que la grammaire **lit** n'a pas été
    /// rendu à l'octet près. C'est la mesure que sa propre sonde ne peut pas
    /// donner : elle ne porte que la trivia que son auteur y a mise.
    SharedCorpusNotPreserved {
        /// Le document du dépôt qui n'a pas été rendu.
        document: &'static str,
        /// Ce qui a divergé, mesuré.
        divergence: TriviaDivergence,
    },
    /// La grammaire ne lit aucun document du corpus du dépôt. Sa préservation
    /// n'est donc mesurée que sur la sonde qu'elle fournit elle-même, ce qui
    /// laisse à son auteur le choix de ce sur quoi il est jugé.
    NoSharedCorpusDocument,
    /// Le fragment que la sonde déclare comme commentaire ne l'est pas : le
    /// document privé de ce fragment n'est plus lisible, donc ce fragment
    /// porte de la donnée et la dimension « commentaire » n'est pas mesurée.
    ProbeCommentIsNotTrivia(crate::GrammarError),
    /// La grammaire se déclare en écriture et n'a pas de chemin d'écriture :
    /// son édition refuse. C'est une capacité annoncée sans implémentation, et
    /// c'est la dette que ce module devait collecter le jour où un chemin
    /// d'écriture existerait.
    NoWritePath(crate::GrammarError),
    /// L'édition a été appliquée mais le rendu ne porte pas ce qu'elle
    /// demandait d'écrire, ou n'est plus lisible par sa propre grammaire.
    EditNotApplied(&'static str),
    /// L'inverse de l'édition a refusé de s'appliquer : ce que la grammaire a
    /// écrit, elle ne sait pas le défaire.
    InverseUnusable(crate::GrammarError),
    /// L'inverse s'applique mais ne rend pas la pré-image octet pour octet :
    /// le retrait reformaterait le document du propriétaire, à l'endroit où
    /// personne ne regarde.
    InverseNotByteIdentical(TriviaDivergence),
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
            Self::MalformedDocumentAccepted { document, mutation } => write!(
                f,
                "la grammaire a accepté « {document} » {mutation}, qui n'est pas un document — \
                 son aller-retour ne passe par aucun analyseur, et rendrait sa sonde à l'octet \
                 près sans rien en avoir compris"
            ),
            Self::SharedCorpusNotPreserved {
                document,
                divergence,
            } => write!(
                f,
                "l'aller-retour sur « {document} », document du dépôt que cette grammaire lit, \
                 ne rend pas les octets hors trace : {divergence}"
            ),
            Self::NoSharedCorpusDocument => write!(
                f,
                "la grammaire ne lit aucun document du dépôt — sa préservation n'est mesurée \
                 que sur la sonde qu'elle fournit elle-même"
            ),
            Self::ProbeCommentIsNotTrivia(err) => write!(
                f,
                "le fragment que la sonde déclare commentaire porte de la donnée : le document \
                 privé de ce fragment n'est plus lisible — {err}"
            ),
            Self::NoWritePath(err) => write!(
                f,
                "la grammaire se déclare en écriture et n'a pas de chemin d'écriture — {err}"
            ),
            Self::EditNotApplied(detail) => {
                write!(f, "l'édition n'a pas été appliquée à la sonde : {detail}")
            }
            Self::InverseUnusable(err) => write!(
                f,
                "l'inverse de l'édition ne s'applique pas — ce que la grammaire écrit, elle ne \
                 sait pas le défaire : {err}"
            ),
            Self::InverseNotByteIdentical(divergence) => write!(
                f,
                "l'inverse de l'édition ne rend pas la pré-image octet pour octet : {divergence}"
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
    trivia: Vec<RefusalReason>,
    shared_corpus_documents_read: usize,
    designates_list_element: bool,
    applies_edits: bool,
    resolution: Resolution,
    merge: MergeAdmission,
}

impl Capabilities {
    /// Mesure les capacités de `G` en exécutant ses propriétés sur sa sonde.
    pub fn of<G: Grammar>() -> Self {
        let probe = G::PROBE;

        let TriviaMeasure {
            reasons: trivia,
            shared_corpus_documents_read,
        } = measure_trivia::<G>();

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
        //
        // Le chemin d'écriture n'est mesuré que sur une grammaire qui se
        // déclare en écriture. Sur une grammaire en lecture seule, l'absence
        // d'un chemin d'écriture n'est pas un défaut mais la décision
        // elle-même, et la publier en second motif laisserait croire qu'en
        // écrire un rouvrirait la porte.
        let write = if G::ROLE == GrammarRole::ReadWrite {
            measure_write_path::<G>()
        } else {
            Vec::new()
        };
        let applies_edits = G::ROLE == GrammarRole::ReadWrite && write.is_empty();

        let mut reasons = Vec::new();
        if G::ROLE == GrammarRole::ReadOnly {
            reasons.push(RefusalReason::ReadOnlyGrammar);
        }
        reasons.extend(trivia.iter().cloned());
        reasons.extend(write);
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
            shared_corpus_documents_read,
            designates_list_element,
            applies_edits,
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
        self.trivia.is_empty()
    }

    /// Combien de documents de [`SHARED_CORPUS`] cette grammaire lit.
    ///
    /// Zéro veut dire que sa préservation n'a été mesurée que sur la sonde
    /// qu'elle fournit elle-même — c'est un défaut d'instrument, et il est
    /// porté comme tel par [`RefusalReason::NoSharedCorpusDocument`].
    pub fn shared_corpus_documents_read(&self) -> usize {
        self.shared_corpus_documents_read
    }

    /// La grammaire sait-elle désigner un élément de liste par sa valeur.
    pub fn designates_list_element(&self) -> bool {
        self.designates_list_element
    }

    /// La grammaire sait-elle écrire une édition **et la défaire** en rendant
    /// la pré-image octet pour octet. Mesuré en exécutant les deux sur sa
    /// sonde, jamais déduit de son rôle déclaré.
    pub fn applies_edits(&self) -> bool {
        self.applies_edits
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

/// Ce que la mesure de la trivia rapporte : les raisons de refuser, toutes,
/// et le nombre de documents du dépôt que la grammaire a lus.
///
/// **Toutes les raisons, et non la première.** Les épreuves ne s'arrêtent plus
/// à la première qui échoue, et ce n'est pas une commodité de rapport : le
/// décompte des documents du dépôt lus doit être établi même quand la sonde a
/// déjà échoué, sans quoi une grammaire refusée sur sa sonde passerait pour
/// une grammaire qui ne lit rien du dépôt, et les deux défauts d'instrument
/// deviendraient indistinguables.
struct TriviaMeasure {
    reasons: Vec<RefusalReason>,
    shared_corpus_documents_read: usize,
}

/// Mesure la préservation de la trivia de `G`, en épreuves qui vont de
/// l'instrument vers la mesure, et sur deux jeux de documents dont un seul
/// appartient à la grammaire jugée.
///
/// **Les épreuves d'instrument** existent parce que la sonde comme
/// l'aller-retour sont fournis par la grammaire jugée. Une sonde édulcorée, ou
/// une implémentation qui rend son entrée telle quelle, rendrait la réponse
/// trivialement vraie. Elles ne rendent pas l'annonce mensongère impossible —
/// voir l'en-tête du module —, elles la rendent mesurablement fausse sur ce
/// qui est mesurable.
///
/// **Les épreuves sur [`SHARED_CORPUS`]** portent sur des documents que
/// l'auteur d'une grammaire ne choisit pas. C'est la seule partie de la mesure
/// dont il ne fournit pas l'instrument, et c'est pour cela qu'elle attrape ce
/// que la sonde laisse passer : une forme de trivia que la sonde ne contient
/// pas, et un refus contrefait qui n'a jamais eu à lire un document réel.
fn measure_trivia<G: Grammar>() -> TriviaMeasure {
    let probe = G::PROBE;
    let mut reasons = Vec::new();

    // 1. L'instrument porte les trois dimensions de trivia hostile. Les deux
    //    premières se reconnaissent sans rien savoir de la grammaire ; la
    //    troisième est déclarée, et vérifiée en 3. Ces trois dimensions
    //    nomment des catégories et non des formes — un commentaire de bloc
    //    absent de la sonde reste invisible ici, et c'est l'épreuve 5 qui le
    //    rattrape.
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
            reasons.push(RefusalReason::ProbeWithoutHostileTrivia { dimension });
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
    reasons.extend(refused_mutations::<G>("la sonde", probe.source));

    // 3. Le fragment déclaré commentaire en est un. Retiré, le document doit
    //    rester lisible — sinon il portait de la donnée, et la dimension
    //    « commentaire » n'était portée que dans la déclaration.
    if !probe.comment.is_empty() {
        if let Err(err) = G::round_trip(&probe.source.replace(probe.comment, "")) {
            reasons.push(RefusalReason::ProbeCommentIsNotTrivia(err));
        }
    }

    // 4. La mesure sur la sonde : elle est relue, et les octets rendus sont
    //    comparés aux octets d'entrée.
    match G::round_trip(probe.source) {
        Err(err) => reasons.push(RefusalReason::ProbeUnreadable(err)),
        Ok(rendered) => {
            if let Some(divergence) = TriviaDivergence::measure(probe.source, &rendered) {
                reasons.push(RefusalReason::TriviaNotPreserved(divergence));
            }
        }
    }

    // 5. La mesure sur le corpus du dépôt. Chaque document est proposé, et un
    //    document refusé n'est pas un défaut : une grammaire ne lit pas les
    //    documents d'une autre. Ce qui est exigé porte sur ceux qu'elle
    //    **accepte** — les rendre à l'octet près, et refuser leurs mutations.
    let mut shared_corpus_documents_read = 0;
    for &(document, source) in SHARED_CORPUS {
        let Ok(rendered) = G::round_trip(source) else {
            continue;
        };
        shared_corpus_documents_read += 1;
        if let Some(divergence) = TriviaDivergence::measure(source, &rendered) {
            reasons.push(RefusalReason::SharedCorpusNotPreserved {
                document,
                divergence,
            });
        }
        reasons.extend(refused_mutations::<G>(document, source));
    }
    if shared_corpus_documents_read == 0 {
        reasons.push(RefusalReason::NoSharedCorpusDocument);
    }

    TriviaMeasure {
        reasons,
        shared_corpus_documents_read,
    }
}

/// Mesure le chemin d'écriture de `G` en l'**exécutant** sur sa sonde : une
/// valeur que la sonde déclare absente y est posée, puis retirée par l'inverse
/// que l'édition a rendu.
///
/// **Ce que cette mesure ferme.** Le rôle d'une grammaire est une décision
/// produit, donc déclarée ; tant qu'aucune grammaire n'avait de chemin
/// d'écriture, se déclarer en écriture ne coûtait rien et rien ne pouvait le
/// contredire. C'est la dette que ce module portait par écrit. Une grammaire
/// qui se déclare en écriture doit désormais **écrire**, **relire ce qu'elle a
/// écrit**, et **rendre la pré-image octet pour octet** en le défaisant.
///
/// **Ce qu'elle ne ferme pas.** La sonde appartient à la grammaire jugée, donc
/// une édition triviale sur un document docile reste possible ici. C'est
/// `tests/conformance.rs` qui exerce la même propriété sur les documents du
/// dépôt, que l'auteur d'une grammaire ne choisit pas.
fn measure_write_path<G: Grammar>() -> Vec<RefusalReason> {
    let probe = G::PROBE;
    let edit = crate::Edit::values(probe.list_path, [probe.value_absent]);

    let applied = match G::apply(probe.source, &edit) {
        Ok(applied) => applied,
        Err(err) => return vec![RefusalReason::NoWritePath(err)],
    };

    // La relecture passe par l'énumération des valeurs, et non par la
    // recherche dans une liste : c'est le témoin dont la post-condition se
    // sert, donc c'est lui qui doit exister. Une grammaire qui écrit sans
    // savoir relire ce qu'elle a écrit ne peut rien promettre de ce qu'elle a
    // détruit.
    let mut reasons = Vec::new();
    let posee = crate::SemanticValue::new(
        probe.list_path.join("."),
        crate::Value::Text(probe.value_absent.to_string()),
    );
    match G::values(&applied.rendered) {
        Err(_) => reasons.push(RefusalReason::EditNotApplied(
            "le rendu n'est plus lisible par sa propre grammaire",
        )),
        Ok(valeurs) => {
            if !valeurs.contains(&posee) {
                reasons.push(RefusalReason::EditNotApplied(
                    "la valeur posée est absente du rendu",
                ));
            }
        }
    }

    match G::invert(&applied.rendered, &applied.inverse) {
        Err(err) => reasons.push(RefusalReason::InverseUnusable(err)),
        Ok(defait) => {
            if let Some(divergence) = TriviaDivergence::measure(probe.source, &defait) {
                reasons.push(RefusalReason::InverseNotByteIdentical(divergence));
            }
        }
    }

    reasons
}

/// Exige de `G` qu'elle refuse chaque mutation de `source`, et nomme celles
/// qu'elle a acceptées.
fn refused_mutations<G: Grammar>(document: &'static str, source: &str) -> Vec<RefusalReason> {
    mutations(source)
        .into_iter()
        .filter(|(_, mutant)| G::round_trip(mutant).is_ok())
        .map(|(mutation, _)| RefusalReason::MalformedDocumentAccepted { document, mutation })
        .collect()
}

/// La table des capacités des grammaires que cette caisse porte aujourd'hui.
///
/// Elle en portera d'autres — le bloc borné par marqueurs et la lecture
/// d'entête —, et chacune s'ajoutera ici par une ligne d'appel, sa mesure
/// venant de son implémentation.
pub fn table() -> Vec<Capabilities> {
    vec![Capabilities::of::<Jsonc>(), Capabilities::of::<Toml>()]
}
