//! La tranche `merge` sur JSONC, en scénarios.
//!
//! Les tests préfixés d'un identifiant portent le nom du scénario de
//! `docs/specs/socle-neuf/requirements.md` qu'ils réalisent ; ceux préfixés de
//! `garde_` n'en réalisent aucun et vérifient que les scénarios mesurent
//! encore quelque chose.
//!
//! **Ce que ce fichier ne fait pas, et où cela vit.** Les scénarios de C1, C2
//! et C8 qui portent sur le **disque** — la transaction qui annule avant que
//! le document ne soit remplacé, le document d'avant retrouvé intact — vivent
//! dans `rigger-apply`, la caisse qui porte l'entrée-sortie. Celle-ci reste
//! pure : ce qu'elle mesure est l'édition, l'inverse et la post-condition,
//! sur des chaînes.
//!
//! **La localité est mesurée par soustraction, jamais par ressemblance.**
//! [`ecart`] rend ce qui a disparu et ce qui est apparu entre deux rendus, en
//! retirant le plus long préfixe et le plus long suffixe communs. Un document
//! ré-émis en entier fait sortir tout le document des deux côtés ; une
//! édition locale fait sortir deux fragments courts. C'est plus fort qu'une
//! égalité du reste, qui peut être obtenue par chance sur un document simple.

use rigger_grammar::{merge, Edit, Grammar, Jsonc, MergeError, Value};

/// Ce qui a disparu et ce qui est apparu entre `avant` et `apres`, le plus
/// long préfixe et le plus long suffixe communs retirés. Les deux fragments
/// rendus sont **contigus** par construction : si l'un d'eux porte une partie
/// du document que l'édition ne devait pas toucher, c'est que le rendu l'a
/// déplacée ou réécrite.
fn ecart(avant: &str, apres: &str) -> (String, String) {
    let (a, b) = (avant.as_bytes(), apres.as_bytes());
    let prefixe = a.iter().zip(b.iter()).take_while(|(x, y)| x == y).count();
    let reste = a.len().min(b.len()) - prefixe;
    let suffixe = a
        .iter()
        .rev()
        .zip(b.iter().rev())
        .take_while(|(x, y)| x == y)
        .count()
        .min(reste);
    (
        String::from_utf8_lossy(&a[prefixe..a.len() - suffixe]).into_owned(),
        String::from_utf8_lossy(&b[prefixe..b.len() - suffixe]).into_owned(),
    )
}

/// Les valeurs sémantiques d'un document, rendues sous une forme comparable
/// dans un message d'échec.
fn valeurs(source: &str) -> Vec<String> {
    Jsonc::values(source)
        .expect("le document doit être lisible")
        .iter()
        .map(|valeur| valeur.to_string())
        .collect()
}

/// Un document de réglages tel qu'un utilisateur le tient : indenté par
/// tabulations, portant un commentaire de fin de ligne sur une clé que le
/// produit ne touche pas.
const REGLAGES: &str = concat!(
    "{\n",
    "\t\"modele\": \"acme/modele-petit\", // perso — ne pas toucher\n",
    "\t\"permissions\": {\n",
    "\t\t\"deny\": [\"Bash(rm -rf *)\"]\n",
    "\t}\n",
    "}\n",
);

/// Le même document, toutes fins de ligne en CRLF.
const REGLAGES_CRLF: &str = concat!(
    "{\r\n",
    "\t\"modele\": \"acme/modele-petit\", // perso — ne pas toucher\r\n",
    "\t\"permissions\": {\r\n",
    "\t\t\"deny\": [\"Bash(rm -rf *)\"]\r\n",
    "\t}\r\n",
    "}\r\n",
);

/// Le fragment que le produit fusionne dans ces scénarios : une clé à la
/// racine, et sa valeur.
fn fragment() -> Edit {
    Edit::keys(&[], [("garde", Value::text("scripts/garde.sh"))])
}

#[test]
fn c1_commentaire_et_indentation_d_un_document_possede() {
    // GIVEN un document de réglages indenté par tabulations, portant un
    // commentaire de fin de ligne sur une clé que le produit ne touche pas.
    // WHEN le produit y fusionne son fragment.
    let fusion = merge::<Jsonc>(REGLAGES, &fragment()).expect("la fusion doit réussir");

    // THEN la clé ajoutée est présente.
    assert!(
        valeurs(&fusion.rendered).contains(&"garde = \"scripts/garde.sh\"".to_string()),
        "la clé ajoutée est absente du rendu : {:?}",
        valeurs(&fusion.rendered)
    );

    // AND le reste du document est identique octet pour octet à ce qu'il
    // était : rien n'a disparu, et ce qui est apparu est le fragment.
    let (disparu, apparu) = ecart(REGLAGES, &fusion.rendered);
    assert_eq!(
        disparu, "",
        "des octets hors trace ont disparu du document possédé"
    );
    assert!(
        apparu.contains("garde"),
        "ce qui est apparu n'est pas le fragment posé : {apparu:?}"
    );
    assert!(
        fusion.rendered.contains("// perso — ne pas toucher"),
        "le commentaire de fin de ligne a disparu"
    );

    // AND les tabulations n'ont pas été remplacées : celles du document
    // d'avant sont toutes encore là, et les seules qui s'ajoutent viennent du
    // fragment.
    let tabulations = |texte: &str| texte.matches('\t').count();
    assert_eq!(
        tabulations(&fusion.rendered) - tabulations(&apparu),
        tabulations(REGLAGES),
        "les tabulations du document d'avant n'ont pas toutes survécu"
    );

    // AND l'inverse rend le document d'avant, octet pour octet.
    assert_eq!(
        Jsonc::invert(&fusion.rendered, &fusion.inverse).expect("l'inverse doit s'appliquer"),
        REGLAGES
    );
}

#[test]
fn c1_fins_de_ligne_d_un_document_en_crlf() {
    // GIVEN un document possédé dont toutes les fins de ligne sont CRLF.
    let crlf_avant = REGLAGES_CRLF.matches("\r\n").count();
    assert_eq!(
        REGLAGES_CRLF.matches('\n').count(),
        crlf_avant,
        "la fixture doit être intégralement en CRLF, sans quoi le scénario ne mesure rien"
    );

    // WHEN le produit y fusionne son fragment.
    let fusion = merge::<Jsonc>(REGLAGES_CRLF, &fragment()).expect("la fusion doit réussir");

    // THEN toutes les fins de ligne du document rendu sont CRLF.
    assert_eq!(
        fusion.rendered.matches('\n').count(),
        fusion.rendered.matches("\r\n").count(),
        "une fin de ligne du document rendu n'est plus CRLF : {:?}",
        fusion.rendered
    );
    assert!(
        fusion.rendered.matches("\r\n").count() > crlf_avant,
        "le fragment posé n'a pas apporté sa propre fin de ligne"
    );

    // AND le nombre d'octets du document n'a pas diminué hors de ce que la
    // trace ajoute.
    let (disparu, _) = ecart(REGLAGES_CRLF, &fusion.rendered);
    assert_eq!(
        disparu, "",
        "des octets hors trace ont disparu d'un document en CRLF"
    );
    assert_eq!(
        Jsonc::invert(&fusion.rendered, &fusion.inverse).expect("l'inverse doit s'appliquer"),
        REGLAGES_CRLF
    );
}

/// Un document de deux cents lignes, dont chacune porte une clé et sa valeur.
fn document_de_deux_cents_lignes() -> String {
    let mut document = String::from("{\n");
    for rang in 0..200 {
        document.push_str(&format!("\t\"cle{rang:03}\": \"valeur{rang:03}\",\n"));
    }
    document.push_str("\t\"fin\": true\n}\n");
    document
}

#[test]
fn c1_le_document_n_est_pas_reemis_en_entier() {
    // GIVEN un document possédé de deux cents lignes dont le produit modifie
    // une clé.
    let avant = document_de_deux_cents_lignes();
    // La clé modifiée vit à la racine ; le chemin vide la désigne.
    let edit = Edit::keys(&[], [("cle100", Value::text("valeur remplacée"))]);

    // WHEN la pose s'exécute.
    let fusion = merge::<Jsonc>(&avant, &edit).expect("la fusion doit réussir");

    // THEN ce qui change dans le fichier se limite au voisinage de cette clé.
    let (disparu, apparu) = ecart(&avant, &fusion.rendered);
    assert!(
        !disparu.contains('\n') && !apparu.contains('\n'),
        "le changement déborde de la ligne de la clé modifiée : {disparu:?} → {apparu:?}"
    );
    assert!(
        disparu.len() < 32 && apparu.len() < 32,
        "le changement ne se limite pas au voisinage de la clé : {disparu:?} → {apparu:?}"
    );

    // Et il porte bien sur la ligne de cette clé : les 199 autres lignes de
    // valeur sont rendues telles quelles.
    let lignes_changees = avant
        .lines()
        .zip(fusion.rendered.lines())
        .filter(|(a, b)| a != b)
        .count();
    assert_eq!(
        lignes_changees, 1,
        "{lignes_changees} lignes ont changé pour une seule clé modifiée"
    );
    assert!(
        fusion.rendered.contains("\"cle100\": \"valeur remplacée\""),
        "la clé modifiée ne porte pas sa nouvelle valeur"
    );

    // AND l'inverse rétablit la valeur d'avant, octet pour octet.
    assert_eq!(
        Jsonc::invert(&fusion.rendered, &fusion.inverse).expect("l'inverse doit s'appliquer"),
        avant
    );
}

/// Les quatre dispositions du même document. Elles sont le **même document**
/// pour une grammaire et **quatre documents différents** pour un découpage en
/// lignes : les écrire toutes est ce qui distingue une implémentation
/// structurelle d'une implémentation qui a l'air de marcher.
///
/// Ce que « le point d'insertion » veut dire ici : l'endroit où la valeur
/// posée atterrit dans le tableau. Les marqueurs qui borneront un bloc posé
/// n'existent pas encore — leur syntaxe et leurs quatre emballages sont la
/// tranche T3c —, donc les constats de C2 qui portent sur eux ne sont pas
/// réalisés ici, et c'est écrit plutôt que passé sous silence.
const DISPOSITIONS: [(&str, &str); 4] = [
    (
        "valeur préexistante avant le point d'insertion, sur la même ligne",
        concat!(
            "{\n",
            "  \"instructions\": [\"AGENTS.md\", \"docs/regles.md\"],\n",
            "  \"modele\": \"acme/modele-petit\"\n",
            "}\n",
        ),
    ),
    (
        "valeur préexistante après le point d'insertion, sur la même ligne",
        concat!(
            "{\n",
            "  \"instructions\": [\"docs/regles.md\"], \"modele\": \"acme/modele-petit\"\n",
            "}\n",
        ),
    ),
    (
        "commentaire de fin de ligne collé au tableau",
        concat!(
            "{\n",
            "  \"instructions\": [\"AGENTS.md\", \"docs/regles.md\"], // garder\n",
            "  \"modele\": \"acme/modele-petit\"\n",
            "}\n",
        ),
    ),
    (
        "tableau entier sur une ligne, sans espace",
        "{\"instructions\":[\"AGENTS.md\",\"docs/regles.md\"],\"modele\":\"acme/modele-petit\"}\n",
    ),
];

#[test]
fn c2_les_quatre_dispositions_sont_le_meme_document() {
    // GIVEN chacune des quatre dispositions, et une entrée dont le fragment
    // déclare poser une valeur dans le tableau `instructions`.
    let edit = Edit::values(&["instructions"], ["docs/pose.md"]);

    for (disposition, avant) in DISPOSITIONS {
        // WHEN la pose s'exécute.
        let fusion = merge::<Jsonc>(avant, &edit)
            .unwrap_or_else(|err| panic!("{disposition} : la fusion a échoué — {err}"));

        // THEN la valeur préexistante est toujours une **valeur** du tableau,
        // pas un commentaire — et aucune valeur préexistante n'a été passée
        // en commentaire.
        let apres = valeurs(&fusion.rendered);
        for valeur in valeurs(avant) {
            assert!(
                apres.contains(&valeur),
                "{disposition} : la valeur {valeur} n'est plus une valeur du document rendu"
            );
        }
        assert!(
            apres.contains(&"instructions = \"docs/pose.md\"".to_string()),
            "{disposition} : la valeur posée n'est pas dans le tableau — {apres:?}"
        );

        // AND rien du document d'avant n'a disparu : ce qui change se réduit
        // à ce que la trace ajoute.
        let (disparu, apparu) = ecart(avant, &fusion.rendered);
        assert_eq!(
            disparu, "",
            "{disposition} : des octets hors trace ont disparu"
        );
        assert!(
            apparu.contains("docs/pose.md"),
            "{disposition} : ce qui est apparu n'est pas la valeur posée — {apparu:?}"
        );

        // AND l'inverse rend le document d'avant, octet pour octet : c'est ce
        // qui fait du retrait un retrait effectif plutôt qu'un « laisser en
        // place ».
        assert_eq!(
            Jsonc::invert(&fusion.rendered, &fusion.inverse)
                .unwrap_or_else(|err| panic!("{disposition} : l'inverse a échoué — {err}")),
            avant,
            "{disposition} : l'inverse ne rend pas le document d'avant"
        );
    }
}

#[test]
fn c2_commentaire_de_fin_de_ligne_colle_au_tableau() {
    // GIVEN le même document, avec `// garder` en fin de ligne collé au
    // tableau.
    let (_, avant) = DISPOSITIONS[2];
    assert!(avant.contains("], // garder"));

    // WHEN la pose s'exécute.
    let fusion = merge::<Jsonc>(avant, &Edit::values(&["instructions"], ["docs/pose.md"]))
        .expect("la fusion doit réussir");

    // THEN `// garder` est toujours présent, à la même place relative — collé
    // à la fermeture du tableau, et non absorbé dans le passage que le
    // produit s'attribue.
    assert!(
        fusion.rendered.contains("], // garder"),
        "le commentaire a changé de place relative : {}",
        fusion.rendered
    );
    assert!(
        fusion.rendered.contains("\"docs/pose.md\"], // garder"),
        "la valeur posée n'est pas entrée avant la fermeture du tableau : {}",
        fusion.rendered
    );
}

#[test]
fn c2_une_valeur_deja_presente_n_entre_pas_dans_la_trace() {
    // GIVEN une entrée dont le fragment déclare poser `AGENTS.md`, qui est
    // déjà la première valeur du tableau.
    let (_, avant) = DISPOSITIONS[0];

    // WHEN la pose s'exécute.
    let fusion = merge::<Jsonc>(avant, &Edit::values(&["instructions"], ["AGENTS.md"]))
        .expect("la fusion doit réussir");

    // THEN le document ne bouge pas, et la trace n'enregistre rien : le
    // produit ne retire que ce qu'il a lui-même ajouté, et une valeur qu'il
    // n'a pas ajoutée ne doit pas sortir du document au retrait.
    assert_eq!(fusion.rendered, avant);
    assert!(
        fusion.inverse.is_empty(),
        "la trace revendique une valeur que le produit n'a pas ajoutée : {:?}",
        fusion.inverse
    );
}

/// Garde, pas scénario : le doublon de clé est admis par le format, qui laisse
/// indéfini ce qu'un lecteur en fait. Le chemin de **lecture** le refuse
/// depuis T3a ; le chemin d'**écriture** doit le refuser aussi, sans quoi il
/// écrirait dans une occurrence dont rien ne dit qu'elle est celle qui compte
/// — inopérant sans erreur et sans trace.
#[test]
fn garde_le_chemin_d_ecriture_refuse_une_cle_dupliquee() {
    const DOUBLE_CLE: &str = concat!(
        "{\n",
        "  \"instructions\": [\"docs/a.md\"],\n",
        "  \"instructions\": [\"docs/b.md\"]\n",
        "}\n",
    );

    let echec = merge::<Jsonc>(
        DOUBLE_CLE,
        &Edit::values(&["instructions"], ["docs/pose.md"]),
    )
    .expect_err("l'écriture a arbitré entre deux définitions de la même clé");

    let message = echec.to_string();
    for attendu in ["jsonc", "instructions"] {
        assert!(
            message.contains(attendu),
            "le refus ne nomme pas « {attendu} » : {message}"
        );
    }
}

/// Garde, pas scénario : un chemin qui n'existe pas fait refuser en le
/// nommant, plutôt que de fabriquer la structure manquante. Le produit
/// n'écrit que là où il a été confirmé qu'il écrirait.
#[test]
fn garde_un_chemin_absent_fait_refuser_en_le_nommant() {
    let echec = merge::<Jsonc>(REGLAGES, &Edit::values(&["absent", "deny"], ["x"]))
        .expect_err("un chemin absent doit faire refuser");
    let message = echec.to_string();
    assert!(
        message.contains("absent"),
        "le refus ne nomme pas le chemin : {message}"
    );
    assert!(
        matches!(echec, MergeError::Grammar(_)),
        "le refus doit venir de la grammaire : {echec:?}"
    );
}
