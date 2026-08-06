//! L'écriture atomique **et conditionnée** d'un document possédé.
//!
//! Trois gestes, dans cet ordre, et chacun paie une défaillance nommée.
//!
//! **Un temporaire dans le même répertoire que la cible.** Un renommage n'est
//! atomique qu'à l'intérieur d'un même système de fichiers ; écrire le
//! temporaire dans le répertoire des fichiers temporaires du système rendrait
//! le renommage non atomique sur les postes où le dossier personnel et le
//! dépôt vivent sur des volumes différents, c'est-à-dire là où on ne l'aurait
//! pas vu en le testant.
//!
//! **Une revérification de l'empreinte juste avant le renommage.** Elle porte
//! sur ce que la **capture** a lu, jamais sur une seconde lecture — une
//! seconde lecture rouvrirait la fenêtre qu'on cherche à fermer.
//!
//! **Un renommage.** Le document possédé est donc, à tout instant
//! observable, soit celui d'avant, soit celui d'après.
//!
//! **Ce que l'empreinte est ici, et pourquoi.** Le contenu lu au calcul
//! lui-même. La comparaison est alors exacte et ne peut pas se tromper, là où
//! un condensé échange cette certitude contre de la mémoire — un arbitrage
//! qui vaudrait pour des documents de taille inconnue, et qui ne vaut pas
//! pour un fichier de réglages que la capture vient de charger en entier de
//! toute façon. Le jour où il vaudra, ce type est le seul endroit à changer.

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use rigger_grammar::{merge, Edit, Grammar, Inverse, MergeError};

/// L'état d'un document au moment où le plan a été calculé.
#[derive(Clone, PartialEq, Eq)]
pub struct Fingerprint(Vec<u8>);

impl Fingerprint {
    /// L'empreinte de ces octets.
    pub fn of(bytes: &[u8]) -> Self {
        Self(bytes.to_vec())
    }
}

impl fmt::Debug for Fingerprint {
    /// Ne rend que la taille : le contenu d'un document possédé porte des
    /// jetons, et un message de diagnostic voyage plus loin qu'on ne le croit.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Fingerprint({} octets)", self.0.len())
    }
}

/// Ce que la capture a lu : le document, et son empreinte, d'**une seule**
/// lecture.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Capture {
    content: String,
    fingerprint: Fingerprint,
}

impl Capture {
    /// Le document tel qu'il était au calcul.
    pub fn content(&self) -> &str {
        &self.content
    }

    /// Son empreinte, dérivée de ce que cette lecture-là a rendu.
    pub fn fingerprint(&self) -> &Fingerprint {
        &self.fingerprint
    }
}

/// Pourquoi une écriture n'a pas eu lieu. Aucune de ces variantes ne laisse
/// une écriture partiellement appliquée.
#[derive(Debug)]
pub enum TxnError {
    /// Le document n'a pas pu être lu.
    Read {
        /// Le fichier concerné.
        path: PathBuf,
        /// Ce que le système a rapporté.
        detail: io::Error,
    },
    /// Le temporaire ou le renommage a échoué.
    Write {
        /// Le fichier concerné.
        path: PathBuf,
        /// Ce que le système a rapporté.
        detail: io::Error,
    },
    /// Le document a changé entre le calcul et l'écriture. C'est un échec, et
    /// jamais une écriture appliquée.
    Changed {
        /// Le fichier concerné.
        path: PathBuf,
    },
    /// Le document n'est pas de l'UTF-8, donc aucune grammaire servie ne le
    /// lit. Refusé plutôt que réécrit avec des octets de remplacement, qui
    /// détruiraient silencieusement ce qu'ils remplacent.
    NotUtf8 {
        /// Le fichier concerné.
        path: PathBuf,
    },
}

impl fmt::Display for TxnError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Read { path, detail } => {
                write!(f, "{} : lecture impossible — {detail}", path.display())
            }
            Self::Write { path, detail } => {
                write!(f, "{} : écriture impossible — {detail}", path.display())
            }
            Self::Changed { path } => write!(
                f,
                "{} : le document a changé entre le calcul et l'écriture — rien n'a été écrit",
                path.display()
            ),
            Self::NotUtf8 { path } => write!(
                f,
                "{} : le document n'est pas de l'UTF-8 — le produit refuse plutôt que de \
                 remplacer les octets qu'il ne sait pas lire",
                path.display()
            ),
        }
    }
}

impl std::error::Error for TxnError {}

/// Lit un document possédé et rend son contenu **et** son empreinte, d'une
/// seule lecture. C'est de cette capture-là que l'écriture se conditionne.
pub fn capture(path: &Path) -> Result<Capture, TxnError> {
    let bytes = fs::read(path).map_err(|detail| TxnError::Read {
        path: path.to_path_buf(),
        detail,
    })?;
    let content = String::from_utf8(bytes).map_err(|_| TxnError::NotUtf8 {
        path: path.to_path_buf(),
    })?;
    let fingerprint = Fingerprint::of(content.as_bytes());
    Ok(Capture {
        content,
        fingerprint,
    })
}

/// Un contenu déjà entièrement écrit à côté de sa cible, qui n'attend plus que
/// la revérification et le renommage.
///
/// Tant qu'il n'est pas validé, il se **supprime tout seul** : un temporaire
/// abandonné est un fragment de document possédé qui traîne dans le répertoire
/// de son propriétaire, et un abandon arrive aussi par une erreur plus haut ou
/// par une panique.
#[derive(Debug)]
pub struct Staged {
    target: PathBuf,
    temporary: Option<PathBuf>,
}

impl Staged {
    /// Le chemin du temporaire, dans le répertoire de la cible.
    pub fn temporary_path(&self) -> &Path {
        self.temporary
            .as_deref()
            .expect("un temporaire validé n'est plus interrogeable")
    }

    /// Revérifie l'empreinte, puis renomme. Toute divergence est un échec qui
    /// nomme le fichier, et jamais une écriture appliquée.
    pub fn commit(mut self, expected: &Fingerprint) -> Result<(), TxnError> {
        let temporary = self
            .temporary
            .take()
            .expect("un temporaire n'est validé qu'une fois");

        let actuel = fs::read(&self.target).map_err(|detail| TxnError::Read {
            path: self.target.clone(),
            detail,
        });
        let actuel = match actuel {
            Ok(actuel) => actuel,
            Err(err) => {
                let _ = fs::remove_file(&temporary);
                return Err(err);
            }
        };
        if Fingerprint::of(&actuel) != *expected {
            let _ = fs::remove_file(&temporary);
            return Err(TxnError::Changed {
                path: self.target.clone(),
            });
        }

        fs::rename(&temporary, &self.target).map_err(|detail| {
            let _ = fs::remove_file(&temporary);
            TxnError::Write {
                path: self.target.clone(),
                detail,
            }
        })
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        if let Some(temporary) = self.temporary.take() {
            let _ = fs::remove_file(temporary);
        }
    }
}

/// Écrit `contents` dans un temporaire du **répertoire de `target`**, sans
/// toucher à `target`.
pub fn stage(target: &Path, contents: &str) -> Result<Staged, TxnError> {
    let temporary = temporary_path(target);
    fs::write(&temporary, contents).map_err(|detail| TxnError::Write {
        path: temporary.clone(),
        detail,
    })?;
    Ok(Staged {
        target: target.to_path_buf(),
        temporary: Some(temporary),
    })
}

/// Le chemin du temporaire d'une cible : même répertoire, nom dérivé du sien
/// et de l'identifiant du processus.
fn temporary_path(target: &Path) -> PathBuf {
    let nom = target
        .file_name()
        .map(|nom| nom.to_string_lossy().into_owned())
        .unwrap_or_else(|| "document".to_string());
    let dossier = target.parent().unwrap_or_else(|| Path::new("."));
    dossier.join(format!(".{nom}.rigger-{}.tmp", std::process::id()))
}

/// Pourquoi une pose n'a pas eu lieu.
#[derive(Debug)]
pub enum ApplyError {
    /// La fusion n'a pas eu lieu : grammaire non admise, refus de la
    /// grammaire, ou post-condition en échec.
    Merge(MergeError),
    /// La lecture ou l'écriture du document n'a pas eu lieu.
    Txn(TxnError),
}

impl fmt::Display for ApplyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Merge(err) => write!(f, "{err}"),
            Self::Txn(err) => write!(f, "{err}"),
        }
    }
}

impl std::error::Error for ApplyError {}

impl From<MergeError> for ApplyError {
    fn from(err: MergeError) -> Self {
        Self::Merge(err)
    }
}

impl From<TxnError> for ApplyError {
    fn from(err: TxnError) -> Self {
        Self::Txn(err)
    }
}

/// Fusionne `edit` dans le document de `path` et rend la trace qui le défait.
///
/// L'enchaînement complet, et il n'y en a pas d'autre : capture, fusion —
/// porte d'admission, édition, post-condition —, temporaire, revérification,
/// renommage. Chaque étape échoue en laissant le document tel qu'il était.
pub fn merge_into_file<G: Grammar>(path: &Path, edit: &Edit) -> Result<Inverse, ApplyError> {
    let captured = capture(path)?;
    let merged = merge::<G>(captured.content(), edit)?;
    let staged = stage(path, &merged.rendered)?;
    staged.commit(captured.fingerprint())?;
    Ok(merged.inverse)
}
