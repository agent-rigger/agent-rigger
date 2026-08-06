//! Les propriétés que **toute** grammaire passe. Ajouter une grammaire est
//! une ligne d'appel ; ajouter un document est un fichier déposé dans un des
//! deux répertoires de corpus.
//!
//! **Aller-retour byte-identique** (T1) : pour chaque document de
//! `tests/corpus/`, `parse` puis `render` sans aucune édition, et l'octet de
//! sortie doit être identique à l'octet d'entrée. La comparaison porte sur
//! des `Vec<u8>`, jamais sur des `String` normalisées, pour ne pas masquer
//! une fin de ligne convertie de CRLF en LF.
//!
//! **Refus nommé sur document malformé** (T3a) : pour chaque document des
//! **deux** répertoires, une version rendue illisible doit faire refuser la
//! grammaire en se nommant.
//!
//! `tests/corpus/` porte les documents dont la grammaire préserve la trivia ;
//! `tests/corpus-limites/` porte ceux dont elle ne la préserve pas, et le
//! second est câblé ici à ce que la table des capacités en dit — un document
//! qui ne serait exercé par aucune propriété resterait testé pour une
//! propriété unique, pour toujours.
//!
//! `docs/specs/socle-neuf/tasks.md` § T1 : aucun octet du corpus n'est
//! recopié depuis un fichier réel de la machine, et les propriétés testées ne
//! lisent jamais une valeur — la neutralité du contenu ne coûte donc rien à
//! la mesure.
//!
//! Ce fichier porte aussi une garde de fixture (`garde_pieges_du_corpus_...`,
//! tout en bas) : elle vérifie que le corpus porte encore ses pièges, pas
//! que la grammaire les préserve. Les deux tests sont volontairement
//! distincts, jamais mélangés dans une même assertion.
//!
//! La limite mesurée de `toml_edit` sur les fins de ligne CRLF n'est pas
//! ici : elle est enregistrée comme test de caractérisation dans
//! `tests/limites_connues.rs`, qui porte sur la **bibliothèque**, là où ce
//! fichier porte sur la caisse.

use std::fs;
use std::path::{Path, PathBuf};

use rigger_grammar::{Capabilities, Grammar, GrammarError, Jsonc, MergeAdmission, Toml};

/// Le préfixe qui rend un document illisible dans les deux grammaires. Il
/// vient de la caisse — `rigger_grammar::NOT_A_DOCUMENT` —, parce que la
/// dérivation des capacités s'en sert comme épreuve d'existence d'un
/// analyseur : deux définitions dériveraient, et la propriété vérifiée ici ne
/// serait plus celle que la table exige là-bas.
const PREFIXE_MALFORME: &str = rigger_grammar::NOT_A_DOCUMENT;

/// La grammaire d'un document du corpus, déduite de son extension. C'est le
/// seul aiguillage : les propriétés ci-dessous ne connaissent que ce type.
#[derive(Clone, Copy, Debug)]
enum Grammaire {
    Jsonc,
    Toml,
}

impl Grammaire {
    /// Les grammaires que ce fichier sait aiguiller. Écrite à la main, comme
    /// `table()` l'est en face — et c'est pour cela que
    /// `garde_toute_grammaire_publiee_traverse_le_corpus` compare les deux :
    /// deux listes qui décrivent le même jeu sans se rencontrer divergent, et
    /// la divergence prend la forme d'une grammaire publiée « mesurée » que
    /// le corpus n'a jamais traversée.
    const TOUTES: [Self; 2] = [Self::Jsonc, Self::Toml];

    fn pour(path: &Path) -> Result<Self, String> {
        match path.extension().and_then(|ext| ext.to_str()) {
            Some("json") => Ok(Self::Jsonc),
            Some("toml") => Ok(Self::Toml),
            other => Err(format!(
                "{}: extension de corpus non reconnue ({:?}) — aucune grammaire ne sait la servir",
                path.display(),
                other
            )),
        }
    }

    fn round_trip(self, source: &str) -> Result<String, GrammarError> {
        match self {
            Self::Jsonc => Jsonc::round_trip(source),
            Self::Toml => Toml::round_trip(source),
        }
    }

    fn capacites(self) -> Capabilities {
        match self {
            Self::Jsonc => Capabilities::of::<Jsonc>(),
            Self::Toml => Capabilities::of::<Toml>(),
        }
    }
}

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

fn lire_utf8(path: &Path) -> Result<(Vec<u8>, String), String> {
    let input =
        fs::read(path).map_err(|err| format!("{}: lecture impossible — {err}", path.display()))?;
    let text = std::str::from_utf8(&input)
        .map_err(|err| format!("{}: le corpus doit être UTF-8 — {err}", path.display()))?
        .to_string();
    Ok((input, text))
}

fn check_round_trip(path: &Path) -> Result<(), String> {
    let grammaire = Grammaire::pour(path)?;
    let (input, text) = lire_utf8(path)?;
    let output = grammaire
        .round_trip(&text)
        .map_err(|err| format!("{}: {err}", path.display()))?;
    compare_byte_identical(path, &input, output.as_bytes())
}

fn corpus_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/corpus")
}

fn corpus_limites_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/corpus-limites")
}

fn documents_de(dir: &Path) -> Vec<PathBuf> {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .unwrap_or_else(|err| panic!("{}: dossier corpus introuvable — {err}", dir.display()))
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .collect();
    entries.sort();
    entries
}

fn corpus_entries() -> Vec<PathBuf> {
    documents_de(&corpus_dir())
}

/// Tous les documents, les deux répertoires confondus. C'est cette
/// énumération que prennent les propriétés qui ne dépendent pas de la
/// préservation de la trivia.
fn tous_les_documents() -> Vec<PathBuf> {
    let mut documents = corpus_entries();
    documents.extend(documents_de(&corpus_limites_dir()));
    documents
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
        .filter_map(|path| check_round_trip(path).err())
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

/// Deuxième propriété commune : un document que la grammaire ne sait pas
/// lire produit un refus qui **la nomme**. Elle porte sur les deux
/// répertoires, ce qui est le seul câblage par lequel `corpus-limites/` est
/// exercé par une propriété de conformité et non par son seul test de
/// caractérisation.
#[test]
fn refus_nomme_sur_document_malforme() {
    let documents = tous_les_documents();
    assert!(
        documents.len() > corpus_entries().len(),
        "aucun document dans {} — la propriété ne porterait que sur le corpus admis",
        corpus_limites_dir().display()
    );

    let failures: Vec<String> = documents
        .iter()
        .filter_map(|path| {
            let grammaire = Grammaire::pour(path).ok()?;
            let (_, text) = lire_utf8(path).ok()?;
            let malforme = format!("{PREFIXE_MALFORME}{text}");
            match grammaire.round_trip(&malforme) {
                Ok(_) => Some(format!(
                    "{}: document malformé accepté par la grammaire `{}`",
                    path.display(),
                    grammaire.capacites().grammar()
                )),
                Err(err) => {
                    let nom = grammaire.capacites().grammar();
                    let message = err.to_string();
                    if err.grammar() == nom && message.contains(nom) {
                        None
                    } else {
                        Some(format!(
                            "{}: le refus ne nomme pas la grammaire `{nom}` — {message}",
                            path.display()
                        ))
                    }
                }
            }
        })
        .collect();

    if !failures.is_empty() {
        panic!(
            "{} document(s) dont le refus n'est pas nommé :\n\n{}",
            failures.len(),
            failures.join("\n\n")
        );
    }
}

/// Le câblage lui-même : un document vit dans `corpus-limites/` parce que sa
/// grammaire ne rend pas ses octets, et c'est ce que la table des capacités
/// doit dire de cette grammaire. Sans ce test, la table pourrait admettre au
/// `merge` une grammaire dont le dépôt porte la contre-preuve.
#[test]
fn les_documents_de_corpus_limites_confirment_la_table() {
    let documents = documents_de(&corpus_limites_dir());
    assert!(
        !documents.is_empty(),
        "{} est vide — le seul document portant le cas dur aurait disparu",
        corpus_limites_dir().display()
    );

    let mut failures = Vec::new();
    for path in &documents {
        let grammaire = match Grammaire::pour(path) {
            Ok(grammaire) => grammaire,
            Err(err) => {
                failures.push(err);
                continue;
            }
        };
        let capacites = grammaire.capacites();

        // Ce que la table déclare.
        if capacites.preserves_trivia() {
            failures.push(format!(
                "{}: la table crédite `{}` de la préservation de la trivia",
                path.display(),
                capacites.grammar()
            ));
        }
        if capacites.merge() == &MergeAdmission::Admitted {
            failures.push(format!(
                "{}: la table admet `{}` au comportement `merge`",
                path.display(),
                capacites.grammar()
            ));
        }

        // Ce que le document en dit, sur pièces : l'aller-retour réel doit
        // diverger, sans quoi la table refuserait sur une limite que ce
        // dépôt ne porte plus.
        if check_round_trip(path).is_ok() {
            failures.push(format!(
                "{}: l'aller-retour est byte-identique — ce document n'a plus de raison de \
                 vivre hors de tests/corpus/, et la table refuse `{}` sur une limite disparue",
                path.display(),
                capacites.grammar()
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "{} désaccord(s) entre le corpus des limites et la table des capacités :\n\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}

/// Garde de câblage, pas propriété de grammaire : la table des capacités et
/// l'aiguillage de ce fichier sont **deux listes écrites à la main**, et rien
/// ne les rapprochait. Une grammaire pouvait donc être publiée sans qu'aucune
/// des propriétés de ce fichier ne la traverse jamais.
///
/// **Ce que cette garde ne fait plus, et pourquoi.** Elle exigeait qu'au moins
/// un document du corpus **s'aiguille** vers chaque grammaire publiée, et cet
/// aiguillage se fait par extension de fichier. Le second témoin qu'elle
/// prétendait apporter était donc choisi par l'auteur de la grammaire jugée :
/// il lui suffisait de déposer un document docile portant l'extension qu'il
/// déclarait pour n'être jamais exercé sur les documents hostiles du dépôt. Le
/// second témoin vit désormais dans la dérivation elle-même — toute grammaire
/// se voit proposer `SHARED_CORPUS` en entier, sans considération
/// d'extension — et ce qui est vérifié ici est qu'elle en a bien lu quelque
/// chose.
#[test]
fn garde_toute_grammaire_publiee_traverse_le_corpus() {
    let table = rigger_grammar::table();

    let mut publiees: Vec<&str> = table.iter().map(|capacites| capacites.grammar()).collect();
    publiees.sort_unstable();

    let mut aiguillees: Vec<&str> = Grammaire::TOUTES
        .iter()
        .map(|grammaire| grammaire.capacites().grammar())
        .collect();
    aiguillees.sort_unstable();

    assert_eq!(
        publiees, aiguillees,
        "la table des capacités et l'aiguillage du corpus ne décrivent pas le même jeu de \
         grammaires — l'une des deux publie ou exerce une grammaire que l'autre ignore"
    );

    let orphelines: Vec<&str> = table
        .iter()
        .filter(|capacites| capacites.shared_corpus_documents_read() == 0)
        .map(|capacites| capacites.grammar())
        .collect();

    assert!(
        orphelines.is_empty(),
        "{} grammaire(s) publiée(s) qui ne lisent aucun document du dépôt — ce que la table en \
         dit ne repose que sur leur propre sonde : {}",
        orphelines.len(),
        orphelines.join(", ")
    );
}

/// Garde de câblage : le corpus que la dérivation embarque doit être celui que
/// le dépôt porte, document pour document et octet pour octet.
///
/// Sans elle, un document ajouté à `tests/corpus/` serait exercé par les
/// propriétés de ce fichier mais jamais proposé aux grammaires, et un document
/// embarqué depuis un état antérieur du dépôt ferait mesurer la préservation
/// sur des octets que plus personne ne relit. Les deux se lisent de la même
/// façon depuis ici : la liste embarquée et le dossier ne décrivent plus le
/// même jeu.
#[test]
fn garde_le_corpus_embarque_est_celui_du_depot() {
    let sur_disque: Vec<(String, Vec<u8>)> = corpus_entries()
        .iter()
        .map(|path| {
            let nom = path
                .file_name()
                .and_then(|nom| nom.to_str())
                .unwrap_or_else(|| panic!("{}: nom de fichier non UTF-8", path.display()))
                .to_string();
            let octets = fs::read(path)
                .unwrap_or_else(|err| panic!("{}: lecture impossible — {err}", path.display()));
            (nom, octets)
        })
        .collect();

    let embarque: Vec<(String, Vec<u8>)> = rigger_grammar::SHARED_CORPUS
        .iter()
        .map(|(nom, source)| ((*nom).to_string(), source.as_bytes().to_vec()))
        .collect();

    let noms = |jeu: &[(String, Vec<u8>)]| -> Vec<String> {
        jeu.iter().map(|(nom, _)| nom.clone()).collect()
    };
    assert_eq!(
        noms(&embarque),
        noms(&sur_disque),
        "le corpus embarqué par la dérivation ne nomme pas les mêmes documents que {}",
        corpus_dir().display()
    );

    let divergents: Vec<&str> = embarque
        .iter()
        .zip(sur_disque.iter())
        .filter(|((_, embarques), (_, disque))| embarques != disque)
        .map(|((nom, _), _)| nom.as_str())
        .collect();
    assert!(
        divergents.is_empty(),
        "{} document(s) embarqué(s) dont les octets ne sont plus ceux du dépôt : {}",
        divergents.len(),
        divergents.join(", ")
    );
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
