//! Une seule propriété active sur la grammaire : pour chaque document du
//! corpus, `parse` puis `render` sans aucune édition, et l'octet de sortie
//! doit être identique à l'octet d'entrée. La comparaison porte sur des
//! `Vec<u8>`, jamais sur des `String` normalisées, pour ne pas masquer une
//! fin de ligne convertie de CRLF en LF.
//!
//! `docs/specs/socle-neuf/tasks.md` § T1 : aucun octet du corpus n'est
//! recopié depuis un fichier réel de la machine, et la propriété testée ne
//! lit jamais une valeur — la neutralité du contenu ne coûte donc rien à la
//! mesure.
//!
//! Ce fichier porte aussi une garde de fixture (`garde_pieges_du_corpus_...`,
//! tout en bas) : elle vérifie que le corpus porte encore ses pièges, pas
//! que la grammaire les préserve. Les deux tests sont volontairement
//! distincts, jamais mélangés dans une même assertion.
//!
//! La limite mesurée de `toml_edit` sur les fins de ligne CRLF n'est pas
//! ici : elle est enregistrée comme test de caractérisation dans
//! `tests/limites_connues.rs`, hors de ce corpus.

use std::fs;
use std::path::Path;
use std::str::FromStr;

use jsonc_parser::cst::CstRootNode;
use jsonc_parser::ParseOptions;
use toml_edit::DocumentMut;

/// Compare deux tampons d'octets et retourne, en cas de divergence, un
/// message qui nomme le fichier et l'offset du premier octet divergent —
/// jamais un simple « not equal » qui ne dit pas où regarder.
fn compare_byte_identical(path: &Path, input: &[u8], output: &[u8]) -> Result<(), String> {
    if input == output {
        return Ok(());
    }
    let mismatch_at = input
        .iter()
        .zip(output.iter())
        .position(|(a, b)| a != b)
        .unwrap_or_else(|| input.len().min(output.len()));
    let context = |buf: &[u8], at: usize| -> String {
        let end = (at + 24).min(buf.len());
        String::from_utf8_lossy(&buf[at..end]).into_owned()
    };
    Err(format!(
        "{}: aller-retour non byte-identique — premier octet divergent à l'offset {} \
         (entrée {} octets, sortie {} octets)\n  entrée  depuis l'offset : {:?}\n  sortie  depuis l'offset : {:?}",
        path.display(),
        mismatch_at,
        input.len(),
        output.len(),
        context(input, mismatch_at),
        context(output, mismatch_at),
    ))
}

fn check_jsonc(path: &Path) -> Result<(), String> {
    let input =
        fs::read(path).map_err(|err| format!("{}: lecture impossible — {err}", path.display()))?;
    let text = std::str::from_utf8(&input)
        .map_err(|err| format!("{}: le corpus doit être UTF-8 — {err}", path.display()))?;
    let root = CstRootNode::parse(text, &ParseOptions::default())
        .map_err(|err| format!("{}: échec du parse JSONC — {err}", path.display()))?;
    let output = root.to_string();
    compare_byte_identical(path, &input, output.as_bytes())
}

fn check_toml(path: &Path) -> Result<(), String> {
    let input =
        fs::read(path).map_err(|err| format!("{}: lecture impossible — {err}", path.display()))?;
    let text = std::str::from_utf8(&input)
        .map_err(|err| format!("{}: le corpus doit être UTF-8 — {err}", path.display()))?;
    let doc = DocumentMut::from_str(text)
        .map_err(|err| format!("{}: échec du parse TOML — {err}", path.display()))?;
    let output = doc.to_string();
    compare_byte_identical(path, &input, output.as_bytes())
}

fn corpus_dir() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/corpus")
}

fn corpus_entries() -> Vec<std::path::PathBuf> {
    let dir = corpus_dir();
    let mut entries: Vec<_> = fs::read_dir(&dir)
        .unwrap_or_else(|err| panic!("{}: dossier corpus introuvable — {err}", dir.display()))
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .collect();
    entries.sort();
    entries
}

#[test]
fn aller_retour_sans_edition_est_byte_identique() {
    let entries = corpus_entries();

    // Un seul énoncé de l'invariant de taille du corpus : trois documents
    // connus, et le nombre d'entrées lues ne peut structurellement pas s'en
    // écarter puisque chaque entrée est soit vérifiée soit nommée en échec
    // ci-dessous — pas de troisième formulation redondante.
    assert_eq!(
        entries.len(),
        3,
        "le corpus attendu compte trois documents (opencode.json, settings.json, config.toml), {} trouvés dans {}",
        entries.len(),
        corpus_dir().display()
    );

    // Chaque document est vérifié même si un précédent a échoué : un seul
    // échec ne doit pas masquer les suivants dans le rapport de passe.
    let failures: Vec<String> = entries
        .iter()
        .filter_map(|path| {
            let result = match path.extension().and_then(|ext| ext.to_str()) {
                Some("json") => check_jsonc(path),
                Some("toml") => check_toml(path),
                other => Err(format!(
                    "{}: extension de corpus non reconnue ({:?}) — aucune grammaire ne sait la servir",
                    path.display(),
                    other
                )),
            };
            result.err()
        })
        .collect();

    if !failures.is_empty() {
        panic!(
            "{} document(s) sur {} non byte-identiques après aller-retour sans édition :\n\n{}",
            failures.len(),
            entries.len(),
            failures.join("\n\n")
        );
    }
}

/// Garde de fixture, pas une propriété de grammaire : un `opencode.json`
/// passé par un « format on save », ou dont les commentaires auraient
/// disparu, rendrait l'aller-retour trivialement vrai et ferait mentir le
/// test au-dessus sans qu'il ne rougisse jamais. Cette garde vérifie que
/// les pièges sont encore là ; elle ne vérifie rien sur `jsonc-parser` ou
/// `toml_edit`.
///
/// Chaque aiguille ancre le piège qu'elle nomme, avec assez de contexte
/// pour être non ambiguë — jamais une classe de caractères. Une aiguille
/// `b"//"` resterait vraie même si `// perso — ne pas toucher` (le GIVEN
/// de MD-22) disparaissait, tant que `// garder` (MD-24) reste dans le
/// fichier : elle prouverait un piège absent en pointant sur un autre.
/// Toutes les aiguilles sont vérifiées même si une précédente manque,
/// pour la même raison qu'A3 juste au-dessus : un seul piège perdu ne
/// doit pas masquer les suivants dans le rapport.
#[test]
fn garde_pieges_du_corpus_toujours_presents() {
    let opencode = fs::read(corpus_dir().join("opencode.json")).expect("lecture opencode.json");
    let settings = fs::read(corpus_dir().join("settings.json")).expect("lecture settings.json");
    let config = fs::read(corpus_dir().join("config.toml")).expect("lecture config.toml");

    let mut missing: Vec<String> = Vec::new();

    // Fin de ligne CRLF : un compte, pas une présence. Depuis A2, l'aiguille
    // du bloc multiligne ci-dessous contient elle-même trois `\r\n` ; une
    // simple présence de `b"\r\n"` ne pourrait donc plus jamais être le
    // piège qui manque — le compte attrape en prime une conversion
    // partielle, qu'aucune aiguille de présence ne peut voir. Même idiome
    // que `limites_connues.rs` pour les 24 CR de `config-crlf.toml`.
    let cr_count = opencode.iter().filter(|&&b| b == b'\r').count();
    if cr_count != 22 {
        missing.push(format!(
            "opencode.json: piège « fin de ligne CRLF » affaibli — {cr_count} \\r trouvés, 22 attendus"
        ));
    }

    for (file, haystack, label, needle) in [
        (
            "opencode.json",
            &opencode,
            "commentaire MD-22 attaché à theme (\"// perso — ne pas toucher\")",
            b"// perso \xe2\x80\x94 ne pas toucher\r\n  \"theme\"" as &[u8],
        ),
        (
            "opencode.json",
            &opencode,
            "commentaire de bloc multiligne, CRLF interne au token",
            b"/*\r\n         * revu manuellement\r\n         * ne pas retirer\r\n         */",
        ),
        (
            "opencode.json",
            &opencode,
            "virgule finale avant accolade fermante",
            b",\r\n}",
        ),
        (
            "opencode.json",
            &opencode,
            "premier élément du tableau instructions partage sa ligne (MD-24)",
            b"\"instructions\": [\"AGENTS.md\"",
        ),
        (
            "opencode.json",
            &opencode,
            "commentaire de fin de ligne // garder, sur le tableau instructions (MD-24 § AND)",
            b"\"docs/notes.md\"], // garder",
        ),
        (
            "opencode.json",
            &opencode,
            "indentation 2 espaces après l'ouverture de l'objet",
            b"{\r\n  \"",
        ),
        (
            "settings.json",
            &settings,
            "indentation par tabulation",
            b"\t\"",
        ),
        (
            "settings.json",
            &settings,
            "bloc indenté en espaces",
            b"        \"temperature\"",
        ),
        ("settings.json", &settings, "clé \"model\"", b"\"model\":"),
        ("settings.json", &settings, "clé \"models\"", b"\"models\":"),
        (
            "config.toml",
            &config,
            "commentaire de section « # sécurité »",
            b"\n# s\xc3\xa9curit\xc3\xa9",
        ),
        (
            "config.toml",
            &config,
            "commentaire de fin de ligne, ancré sur la valeur de name",
            b"\"  # verrouill\xc3\xa9",
        ),
        (
            "config.toml",
            &config,
            "tableau multiligne à virgule traînante",
            b"\"exec\",\n]",
        ),
        (
            "config.toml",
            &config,
            "table inline server_pool",
            b"server_pool = { primary =",
        ),
        (
            "config.toml",
            &config,
            "table standard [server], préfixe partagé avec server_pool",
            b"\n[server]\n",
        ),
    ] {
        if !windows_contain(haystack, needle) {
            missing.push(format!(
                "{file}: piège « {label} » absent — la mesure ne porterait plus sur la trivia hostile attendue"
            ));
        }
    }

    // "model" avant "theme" (GIVEN MD-22) : les deux clés sont loin l'une de
    // l'autre, donc pas une seule aiguille contiguë — une comparaison de
    // position, tout aussi non ambiguë.
    match (
        find_bytes(&opencode, b"\"model\":"),
        find_bytes(&opencode, b"\"theme\":"),
    ) {
        (Some(model_at), Some(theme_at)) if model_at < theme_at => {}
        (Some(_), Some(_)) => missing.push(
            "opencode.json: \"model\" n'est plus avant \"theme\" — l'ordre non alphabétique du GIVEN MD-22 a disparu".to_string(),
        ),
        _ => missing.push(
            "opencode.json: \"model\" et/ou \"theme\" introuvables — impossible de vérifier leur ordre".to_string(),
        ),
    }

    if !missing.is_empty() {
        panic!(
            "{} piège(s) perdu(s) sur le corpus :\n\n{}",
            missing.len(),
            missing.join("\n")
        );
    }
}

fn windows_contain(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}
