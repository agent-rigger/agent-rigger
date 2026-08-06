//! Énumère les documents de `tests/corpus/` et en écrit la liste que
//! `src/capability.rs` embarque sous le nom `SHARED_CORPUS`.
//!
//! **Pourquoi elle est générée et non écrite.** Deux raisons, et chacune
//! suffirait.
//!
//! La première est la divergence. Une liste écrite à la main dans la source et
//! un dossier de documents décrivent le même jeu sans se rencontrer : un
//! document ajouté au dépôt et oublié dans la liste ne serait jamais proposé à
//! une grammaire, et la mesure retomberait en silence sur les seuls documents
//! déjà connus. C'est le mode que la table des capacités existe pour fermer,
//! transposé à son propre instrument.
//!
//! La seconde est que le nom d'un de ces fichiers est un nom d'hôte. Le
//! scénario C7 (`docs/specs/socle-neuf/requirements.md`) exige que la
//! condition d'admission se dérive d'une propriété de la grammaire et
//! **qu'aucun nom d'hôte n'apparaisse dans la source de la caisse** — une
//! garde le vérifie fichier par fichier. Énumérer le dossier plutôt que le
//! recopier est ce qui rend cette exigence tenable : la caisse ne nomme aucun
//! document, elle les prend tous.

use std::env;
use std::fmt::Write as _;
use std::fs;
use std::path::Path;

fn main() {
    let manifest = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let corpus = Path::new(&manifest).join("tests/corpus");

    // Le dossier entier, et pas seulement ses fichiers : un document déposé
    // après coup doit relancer cette génération, sans quoi la liste embarquée
    // serait celle d'un état antérieur du dépôt.
    println!("cargo::rerun-if-changed={}", corpus.display());

    let mut documents: Vec<_> = fs::read_dir(&corpus)
        .unwrap_or_else(|err| panic!("{}: dossier corpus illisible — {err}", corpus.display()))
        .map(|entry| entry.expect("entrée de dossier lisible").path())
        .filter(|path| path.is_file())
        .collect();
    documents.sort();

    assert!(
        !documents.is_empty(),
        "{}: aucun document — la dérivation des capacités n'aurait plus de second témoin",
        corpus.display()
    );

    // Les durées de vie sont élidées : dans une constante elles valent
    // `'static`, et `clippy::redundant_static_lifetimes` refuse qu'on les
    // écrive. Le code généré passe les mêmes portes que le code écrit.
    let mut rendu = String::from("pub const SHARED_CORPUS: &[(&str, &str)] = &[\n");
    for path in &documents {
        let nom = path
            .file_name()
            .and_then(|nom| nom.to_str())
            .unwrap_or_else(|| panic!("{}: nom de fichier non UTF-8", path.display()));
        let chemin = path
            .to_str()
            .unwrap_or_else(|| panic!("{}: chemin non UTF-8", path.display()));
        writeln!(rendu, "    ({nom:?}, include_str!({chemin:?})),")
            .expect("écriture en mémoire infaillible");
        println!("cargo::rerun-if-changed={chemin}");
    }
    rendu.push_str("];\n");

    let out = Path::new(&env::var("OUT_DIR").expect("OUT_DIR")).join("shared_corpus.rs");
    fs::write(&out, rendu)
        .unwrap_or_else(|err| panic!("{}: écriture impossible — {err}", out.display()));
}
