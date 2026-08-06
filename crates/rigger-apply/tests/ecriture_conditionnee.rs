//! L'écriture d'un document possédé, en scénarios.
//!
//! Les tests préfixés d'un identifiant portent le nom du scénario de
//! `docs/specs/socle-neuf/requirements.md` qu'ils réalisent. Ceux de C1 et C2
//! qui vivent ici sont ceux dont le constat porte sur le **disque** — « le
//! document sur le disque est celui d'avant » ne se mesure nulle part
//! ailleurs.
//!
//! Chaque test travaille dans son propre répertoire : le temporaire d'une
//! écriture vit à côté de sa cible, donc deux tests qui partageraient un
//! répertoire se verraient mutuellement.

use std::fs;
use std::path::{Path, PathBuf};

use rigger_apply::{capture, merge_into_file, stage, ApplyError, Fingerprint, TxnError};
use rigger_grammar::{
    Applied, Edit, Grammar, GrammarError, GrammarRole, Inverse, Jsonc, MergeError, Probe,
    Resolution, SemanticValue, Toml, Value,
};

/// Un document de réglages tel qu'un utilisateur le tient.
const REGLAGES: &str = concat!(
    "{\n",
    "\t\"modele\": \"acme/modele-petit\", // perso — ne pas toucher\n",
    "\t\"instructions\": [\"AGENTS.md\", \"docs/regles.md\"]\n",
    "}\n",
);

/// Un répertoire de travail vide, propre à ce test.
fn repertoire(nom: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("rigger-apply-{nom}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).expect("création du répertoire de travail");
    path
}

/// Les fichiers présents dans un répertoire, triés — de quoi constater
/// qu'aucun temporaire ne subsiste.
fn fichiers(dir: &Path) -> Vec<String> {
    let mut noms: Vec<String> = fs::read_dir(dir)
        .expect("lecture du répertoire")
        .filter_map(|entree| entree.ok())
        .map(|entree| entree.file_name().to_string_lossy().into_owned())
        .collect();
    noms.sort();
    noms
}

fn document(dir: &Path, contenu: &str) -> PathBuf {
    let path = dir.join("reglages.json");
    fs::write(&path, contenu).expect("écriture du document possédé");
    path
}

fn fragment() -> Edit {
    Edit::values(&["instructions"], ["docs/pose.md"])
}

#[test]
fn c8_le_nominal() {
    // GIVEN un document que personne ne touche pendant l'opération.
    let dir = repertoire("nominal");
    let cible = document(&dir, REGLAGES);

    // WHEN la pose s'exécute.
    let trace = merge_into_file::<Jsonc>(&cible, &fragment()).expect("la pose doit réussir");

    // THEN elle réussit, et la garde n'a produit ni avertissement ni détour :
    // le document porte ce que la trace enregistre, et rien d'autre.
    let apres = fs::read_to_string(&cible).expect("relecture");
    assert!(apres.contains("docs/pose.md"));
    assert!(apres.contains("// perso — ne pas toucher"));
    assert_eq!(
        Jsonc::invert(&apres, &trace).expect("l'inverse doit s'appliquer"),
        REGLAGES,
        "la trace ne rend pas le document d'avant"
    );
    assert_eq!(fichiers(&dir), vec!["reglages.json".to_string()]);
    fs::remove_dir_all(&dir).expect("nettoyage");
}

#[test]
fn c8_le_document_a_change_entre_le_calcul_et_l_ecriture() {
    // GIVEN un plan calculé sur un document dont l'empreinte a été relevée.
    let dir = repertoire("tiers");
    let cible = document(&dir, REGLAGES);
    let capture = capture(&cible).expect("la capture doit réussir");

    // AND ce document réécrit par un tiers avant l'écriture.
    const PAR_LE_TIERS: &str = "{\n\t\"modele\": \"acme/modele-grand\"\n}\n";
    fs::write(&cible, PAR_LE_TIERS).expect("réécriture par un tiers");

    // WHEN l'écriture s'exécute.
    let staged = stage(&cible, "{\n\t\"pose\": true\n}\n").expect("le temporaire doit s'écrire");
    let echec = staged
        .commit(capture.fingerprint())
        .expect_err("l'écriture s'est appliquée sur un document qui avait changé");

    // THEN elle échoue en nommant le fichier.
    assert!(
        matches!(&echec, TxnError::Changed { path } if path == &cible),
        "l'échec ne nomme pas le fichier : {echec}"
    );
    assert!(echec.to_string().contains("reglages.json"));

    // AND le document porte ce que le tiers y a écrit, intact.
    assert_eq!(fs::read_to_string(&cible).expect("relecture"), PAR_LE_TIERS);

    // AND aucun fichier temporaire ne subsiste.
    assert_eq!(fichiers(&dir), vec!["reglages.json".to_string()]);
    fs::remove_dir_all(&dir).expect("nettoyage");
}

#[test]
fn c8_l_ecriture_est_atomique() {
    // GIVEN une écriture arrêtée entre l'écriture du temporaire et le
    // renommage — c'est-à-dire l'instant que ce découpage rend observable.
    let dir = repertoire("atomique");
    let cible = document(&dir, REGLAGES);
    let capture = capture(&cible).expect("la capture doit réussir");
    const APRES: &str = "{\n\t\"pose\": true\n}\n";
    let staged = stage(&cible, APRES).expect("le temporaire doit s'écrire");

    // WHEN on inspecte le disque.
    // THEN le document possédé est celui d'avant, en entier, et le contenu
    // d'après est déjà entièrement écrit ailleurs : il n'existe aucun instant
    // où la cible porte un état intermédiaire.
    assert_eq!(fs::read_to_string(&cible).expect("relecture"), REGLAGES);
    assert_eq!(
        fs::read_to_string(staged.temporary_path()).expect("relecture du temporaire"),
        APRES
    );

    // Et après le renommage, elle porte celui d'après, en entier.
    staged.commit(capture.fingerprint()).expect("le renommage");
    assert_eq!(fs::read_to_string(&cible).expect("relecture"), APRES);
    assert_eq!(fichiers(&dir), vec!["reglages.json".to_string()]);
    fs::remove_dir_all(&dir).expect("nettoyage");
}

#[test]
fn c8_le_temporaire_vit_dans_le_meme_repertoire() {
    // GIVEN une écriture en cours.
    let dir = repertoire("meme-repertoire");
    let cible = document(&dir, REGLAGES);
    let staged = stage(&cible, "{}\n").expect("le temporaire doit s'écrire");

    // WHEN on inspecte le disque.
    // THEN le fichier temporaire est dans le répertoire du document cible —
    // un renommage n'étant atomique qu'à l'intérieur d'un même système de
    // fichiers.
    assert_eq!(
        staged.temporary_path().parent(),
        cible.parent(),
        "le temporaire ne vit pas dans le répertoire du document cible"
    );
    assert!(staged.temporary_path().exists());
    assert_ne!(staged.temporary_path(), cible);

    // Et il disparaît avec la transaction abandonnée : un temporaire laissé
    // derrière est un fragment de document possédé qui traîne.
    let temporaire = staged.temporary_path().to_path_buf();
    drop(staged);
    assert!(!temporaire.exists());
    assert_eq!(fichiers(&dir), vec!["reglages.json".to_string()]);
    fs::remove_dir_all(&dir).expect("nettoyage");
}

#[test]
fn c8_l_empreinte_se_derive_de_la_capture() {
    // GIVEN un comportement dont la capture a lu l'état du document.
    let dir = repertoire("empreinte");
    let cible = document(&dir, REGLAGES);
    let capture = capture(&cible).expect("la capture doit réussir");

    // WHEN l'écriture se conditionne.
    // THEN elle se conditionne sur ce que la capture a lu, et le document
    // n'est pas relu une seconde fois pour cela : l'empreinte se calcule sur
    // le contenu que la capture rend.
    assert_eq!(
        capture.fingerprint(),
        &Fingerprint::of(capture.content().as_bytes()),
        "l'empreinte ne se dérive pas de ce que la capture a lu"
    );

    // Et elle ne bouge pas quand le document bouge : une seconde lecture
    // rouvrirait la fenêtre qu'on cherche à fermer.
    fs::write(&cible, "{}\n").expect("réécriture");
    assert_eq!(
        capture.fingerprint(),
        &Fingerprint::of(REGLAGES.as_bytes()),
        "l'empreinte a suivi le document au lieu de suivre la capture"
    );
    fs::remove_dir_all(&dir).expect("nettoyage");
}

#[test]
fn c1_une_grammaire_qui_ne_preserve_pas_fait_annuler_avant_de_remplacer_le_document() {
    // GIVEN un document possédé et une grammaire dont l'implémentation ne
    // rend pas les octets hors trace.
    let dir = repertoire("non-preservante");
    let cas_dur = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../rigger-grammar/tests/corpus-limites/config-crlf.toml");
    let avant = fs::read(&cas_dur).expect("lecture du document du cas dur");
    let cible = dir.join("config.toml");
    fs::write(&cible, &avant).expect("écriture du document possédé");

    // WHEN une pose passe par elle.
    let echec = merge_into_file::<Toml>(&cible, &fragment())
        .expect_err("une grammaire qui ne préserve pas a écrit dans un document possédé");

    // THEN la transaction annule avant que le document ne soit remplacé, et
    // le message nomme la grammaire et ce qui n'a pas été préservé.
    let message = echec.to_string();
    for attendu in ["toml", "merge", "fins de ligne"] {
        assert!(
            message.contains(attendu),
            "le refus ne nomme pas « {attendu} » : {message}"
        );
    }
    assert!(matches!(
        echec,
        ApplyError::Merge(MergeError::NotAdmitted(_))
    ));

    // AND le document sur le disque est celui d'avant, et rien n'a été écrit
    // à côté.
    assert_eq!(fs::read(&cible).expect("relecture"), avant);
    assert_eq!(fichiers(&dir), vec!["config.toml".to_string()]);
    fs::remove_dir_all(&dir).expect("nettoyage");
}

/// Une grammaire qui écrit **par du texte** au lieu d'écrire par la structure,
/// et qui fait donc sortir du document une valeur que l'utilisateur y avait
/// mise. C'est le mode que la post-condition existe pour attraper, reproduit
/// dans sa forme la plus directe.
///
/// Tout le reste est celui de JSONC, y compris la sonde : cette grammaire doit
/// **passer la porte d'admission**, sans quoi le refus mesuré ci-dessous
/// viendrait de l'admission et ne dirait rien de la post-condition. La sonde
/// ne porte pas la valeur détruite, donc la destruction ne s'y voit pas — et
/// c'est exactement pour cela qu'un constat sur la **sortie** est le seul qui
/// dise ce qu'on a fait.
struct GrammaireDestructrice;

impl Grammar for GrammaireDestructrice {
    const NAME: &'static str = "destructrice";
    const ROLE: GrammarRole = GrammarRole::ReadWrite;
    const RESOLUTION: Resolution = Resolution::IndependentOfOrder;
    const PROBE: Probe = Jsonc::PROBE;

    fn round_trip(source: &str) -> Result<String, GrammarError> {
        Jsonc::round_trip(source)
    }

    fn find_string_in_list(source: &str, path: &[&str], value: &str) -> Result<bool, GrammarError> {
        Jsonc::find_string_in_list(source, path, value)
    }

    fn apply(source: &str, edit: &Edit) -> Result<Applied, GrammarError> {
        let applied = Jsonc::apply(source, edit)?;
        Ok(Applied {
            rendered: applied.rendered.replace("\"docs/regles.md\", ", ""),
            inverse: applied.inverse,
        })
    }

    fn invert(source: &str, inverse: &Inverse) -> Result<String, GrammarError> {
        Jsonc::invert(source, inverse)
    }

    fn values(source: &str) -> Result<Vec<SemanticValue>, GrammarError> {
        Jsonc::values(source)
    }
}

#[test]
fn c2_la_post_condition_compare_les_valeurs_semantiques() {
    // GIVEN une pose dont l'écriture fait disparaître une valeur préexistante.
    let dir = repertoire("post-condition");
    let cible = document(&dir, REGLAGES);

    // WHEN la post-condition s'exécute.
    let echec = merge_into_file::<GrammaireDestructrice>(&cible, &fragment())
        .expect_err("une valeur de l'utilisateur est sortie du document sans que rien ne rougisse");

    // THEN elle échoue en nommant la valeur disparue et son chemin.
    let message = echec.to_string();
    for attendu in ["docs/regles.md", "instructions"] {
        assert!(
            message.contains(attendu),
            "l'échec ne nomme pas « {attendu} » : {message}"
        );
    }
    match &echec {
        ApplyError::Merge(MergeError::ValuesLost { lost, .. }) => {
            assert_eq!(lost.len(), 1, "{lost:?}");
            assert_eq!(lost[0].path(), "instructions");
            assert_eq!(lost[0].value(), &Value::text("docs/regles.md"));
        }
        autre => panic!("l'échec ne vient pas de la post-condition : {autre:?}"),
    }

    // AND la transaction annule : le document sur le disque est celui d'avant.
    assert_eq!(fs::read_to_string(&cible).expect("relecture"), REGLAGES);
    assert_eq!(fichiers(&dir), vec!["reglages.json".to_string()]);
    fs::remove_dir_all(&dir).expect("nettoyage");
}
