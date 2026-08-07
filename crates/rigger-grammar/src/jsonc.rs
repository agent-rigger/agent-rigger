//! The JSONC grammar, served by `jsonc-parser 0.33.1` and its `cst` feature.
//! Strict JSON being a subset of it, the same grammar serves documents without
//! comments.
//!
//! **One single recogniser.** Everything this module reads of a document goes
//! through the concrete syntax tree. A second read of the same text — by a
//! value parser, say — would drift from the first, and the passage the product
//! believes it owns would widen in silence.

use jsonc_parser::cst::{CstArray, CstInputValue, CstNode, CstObject, CstRootNode};
use jsonc_parser::ParseOptions;

use crate::element::IDENTITY_KEY;
use crate::marker::Marker;
use crate::{
    Applied, Edit, ElementUndo, Grammar, GrammarError, GrammarRole, Inverse, Probe, Resolution,
    SemanticValue, Value,
};

/// The JSONC grammar.
pub struct Jsonc;

/// The probe: a tiny document carrying the trivia that preservation must return
/// — CRLF, leading comment, end-of-line comment, tab indentation, trailing
/// comma. It is written here, by hand, and never copied from a file on the
/// machine.
const PROBE_SOURCE: &str = concat!(
    "{\r\n",
    "\t// probe — leading comment\r\n",
    "\t\"permissions\": {\r\n",
    "\t\t\"deny\": [\"Bash(rm -rf *)\", \"Read(./secrets/**)\"], // keep\r\n",
    "\t},\r\n",
    "}\r\n",
);

impl Grammar for Jsonc {
    const NAME: &'static str = "jsonc";

    /// The product writes into these documents: this is the grammar of the
    /// documents owned by the host that is served — settings and tool servers —
    /// and the only one on which the `merge` behaviour has an object (a
    /// product decision made on 2026-08-06).
    ///
    /// **This declaration is no longer taken on trust since T3b.** The
    /// derivation runs the write path on the probe: write, read back what was
    /// written, then undo while returning the pre-image byte for byte. A
    /// grammar declaring this role without those three is refused, by naming
    /// what is missing.
    const ROLE: GrammarRole = GrammarRole::ReadWrite;

    /// The criterion is that of the whole column, and it bears on the
    /// **grammar**: *no second candidate that a position would have to
    /// separate*.
    ///
    /// The format does not give it — it admits that a name be defined more than
    /// once in the same object and leaves a reader's behaviour **undefined**
    /// (RFC 8259 § 4: "the behavior … is unpredictable"). So it is the
    /// implementation that holds it: the read refuses, by naming the key, as
    /// soon as it is defined twice on the path being read, rather than honour
    /// the first one in silence. Without that refusal, this column would be
    /// populated by two contradictory criteria — one about the format here, one
    /// about the grammar next to it — and the mode C7 closes would reopen on a
    /// document carrying the duplicate.
    ///
    /// The fact measured on 2026-08-06 on the settings file that is served —
    /// its resolution goes **by category** and not by position — remains true
    /// and remains sourced: C7 refuses a key-based `merge` as soon as the
    /// resolution of a document depends on the order of its keys, the
    /// catalogue contract carries that refusal for what a catalogue may
    /// declare, and both rest on a documentary probe of 2026-08-05 quoting the
    /// host's own documentation. It cannot populate this column on its own: it
    /// bears on **who reads** the document, whereas the admission condition
    /// must derive from the grammar. An undated claim on this point must be
    /// held to be stale.
    const RESOLUTION: Resolution = Resolution::IndependentOfOrder;

    const PROBE: Probe = Probe {
        source: PROBE_SOURCE,
        comment: "// probe — leading comment",
        list_path: &["permissions", "deny"],
        value_present: "Bash(rm -rf *)",
        value_absent: "Bash(true)",
    };

    fn round_trip(source: &str) -> Result<String, GrammarError> {
        Ok(parse(source)?.to_string())
    }

    fn find_string_in_list(source: &str, path: &[&str], value: &str) -> Result<bool, GrammarError> {
        let root = parse(source)?;
        let Some((list_key, object_keys)) = path.split_last() else {
            return Ok(false);
        };
        let Some(mut object) = root.object_value() else {
            return Ok(false);
        };
        for key in object_keys {
            refuse_if_defined_twice(&object, key)?;
            match object.object_value(key) {
                Some(child) => object = child,
                None => return Ok(false),
            }
        }
        refuse_if_defined_twice(&object, list_key)?;
        let Some(list) = object.array_value(list_key) else {
            return Ok(false);
        };
        Ok(list
            .elements()
            .iter()
            .filter_map(|element| element.as_string_lit())
            .any(|literal| {
                literal
                    .decoded_value()
                    .is_ok_and(|decoded| decoded == value)
            }))
    }

    fn find_element_by_identity(
        source: &str,
        path: &[String],
        identity: &Marker,
    ) -> Result<Option<Vec<(String, Value)>>, GrammarError> {
        let root = parse(source)?;
        let array = array_at(&root, path)?;
        let Some(element) = identified_element(&array, path, identity)? else {
            return Ok(None);
        };
        Ok(Some(read_fields(&element)?))
    }

    fn apply(source: &str, edit: &Edit) -> Result<Applied, GrammarError> {
        let root = parse(source)?;
        let inverse = match edit {
            Edit::Keys { path, entries } => {
                let object = object_at(&root, path)?;
                let mut added = Vec::new();
                let mut replaced = Vec::new();
                for (name, value) in entries {
                    refuse_if_defined_twice(&object, name)?;
                    match object.get(name) {
                        Some(property) => {
                            let node = property
                                .value()
                                .ok_or_else(|| GrammarError::path_not_found(Jsonc::NAME, path))?;
                            // What the trace keeps of the pre-image is its
                            // **semantic** value: the library offers no way to
                            // insert raw bytes anywhere other than inside a
                            // literal, so a comment or an escape living inside
                            // the replaced value is not restored. Such a
                            // replacement must therefore not reach the
                            // document, and this is not where that is decided:
                            // `merge` runs this inverse on the rendering and
                            // refuses when the bytes from before do not come
                            // back. The refusal is thus measured on the real
                            // document rather than deduced from a list of
                            // shapes we would have thought of.
                            replaced.push((name.clone(), read_value(&node)?));
                            property.set_value(input_value(value));
                        }
                        None => {
                            object.append(name, input_value(value));
                            added.push(name.clone());
                        }
                    }
                }
                Inverse::Keys {
                    path: path.clone(),
                    added,
                    replaced,
                }
            }
            Edit::Values { path, values } => {
                let array = array_at(&root, path)?;
                let mut added = Vec::new();
                for value in values {
                    if find_string_element(&array, value)?.is_some() {
                        continue;
                    }
                    array.append(CstInputValue::String(value.clone()));
                    added.push(value.clone());
                }
                Inverse::Values {
                    path: path.clone(),
                    added,
                }
            }
            Edit::Element {
                path,
                identity,
                fields,
            } => {
                // A fragment able to write the identity field could forge an
                // identity, or overwrite the one that tells another
                // catalogue's element apart from its own. The refusal derives
                // from a property of the edit — it declares the field the
                // product reserves — and not from anything about the document.
                if fields.iter().any(|(name, _)| name == IDENTITY_KEY) {
                    return Err(GrammarError::ReservedField {
                        grammar: Jsonc::NAME,
                        field: IDENTITY_KEY,
                    });
                }
                let array = array_at(&root, path)?;
                let undo = match identified_element(&array, path, identity)? {
                    // The element is already there: this is an update, and it
                    // writes field by field, exactly as a key does. Replacing
                    // the whole element would destroy the trivia its owner put
                    // inside it, which `merge` would then refuse — rightly, and
                    // for the whole update.
                    Some(element) => {
                        let mut added = Vec::new();
                        let mut replaced = Vec::new();
                        for (name, value) in fields {
                            refuse_if_defined_twice(&element, name)?;
                            match element.get(name) {
                                Some(property) => {
                                    let node = property.value().ok_or_else(|| {
                                        GrammarError::path_not_found(Jsonc::NAME, path)
                                    })?;
                                    replaced.push((name.clone(), read_value(&node)?));
                                    property.set_value(input_value(value));
                                }
                                None => {
                                    element.append(name, input_value(value));
                                    added.push(name.clone());
                                }
                            }
                        }
                        ElementUndo::Restore { added, replaced }
                    }
                    // No element carries the identity: one is appended, and it
                    // carries the identity **first**, because the marker lives
                    // in a file its owner opens and the first thing they should
                    // read of an element the product wrote is whose it is.
                    None => {
                        let mut entries = vec![(
                            IDENTITY_KEY.to_string(),
                            CstInputValue::String(identity.to_string()),
                        )];
                        entries.extend(
                            fields
                                .iter()
                                .map(|(name, value)| (name.clone(), input_value(value))),
                        );
                        array.append(CstInputValue::Object(entries));
                        ElementUndo::Remove
                    }
                };
                Inverse::Element {
                    path: path.clone(),
                    identity: identity.clone(),
                    undo,
                }
            }
        };
        Ok(Applied {
            rendered: root.to_string(),
            inverse,
        })
    }

    fn invert(source: &str, inverse: &Inverse) -> Result<String, GrammarError> {
        let root = parse(source)?;
        match inverse {
            Inverse::Keys {
                path,
                added,
                replaced,
            } => {
                let object = object_at(&root, path)?;
                for name in added {
                    refuse_if_defined_twice(&object, name)?;
                    if let Some(property) = object.get(name) {
                        property.remove();
                    }
                }
                for (name, value) in replaced {
                    refuse_if_defined_twice(&object, name)?;
                    match object.get(name) {
                        Some(property) => property.set_value(input_value(value)),
                        None => {
                            object.append(name, input_value(value));
                        }
                    }
                }
            }
            Inverse::Values { path, added } => {
                let array = array_at(&root, path)?;
                for value in added {
                    // One occurrence per recorded value: the product added one,
                    // it removes one. Removing every element carrying the same
                    // value would take away the one the user had written before.
                    if let Some(element) = find_string_element(&array, value)? {
                        element.remove();
                    }
                }
            }
            Inverse::Element {
                path,
                identity,
                undo,
            } => {
                let array = array_at(&root, path)?;
                // The element is found by its identity. An element that does
                // not carry it is not the product's, whatever it looks like,
                // and is never touched here.
                let Some(element) = identified_element(&array, path, identity)? else {
                    return Ok(root.to_string());
                };
                match undo {
                    ElementUndo::Remove => element.remove(),
                    ElementUndo::Restore { added, replaced } => {
                        for name in added {
                            refuse_if_defined_twice(&element, name)?;
                            if let Some(property) = element.get(name) {
                                property.remove();
                            }
                        }
                        for (name, value) in replaced {
                            refuse_if_defined_twice(&element, name)?;
                            match element.get(name) {
                                Some(property) => property.set_value(input_value(value)),
                                None => {
                                    element.append(name, input_value(value));
                                }
                            }
                        }
                    }
                }
            }
        }
        Ok(root.to_string())
    }

    fn values(source: &str) -> Result<Vec<SemanticValue>, GrammarError> {
        let root = parse(source)?;
        let mut values = Vec::new();
        if let Some(node) = root.value() {
            collect_values(&node, "", &mut values)?;
        }
        Ok(values)
    }
}

/// The object at the end of `path`, refusing along the way any key defined
/// twice.
///
/// The navigation is the **same** as the one used for reading, and it refuses
/// for the same reason: writing into one of the two definitions of a key would
/// be writing into a block that nothing says is the one that counts.
fn object_at(root: &CstRootNode, path: &[String]) -> Result<CstObject, GrammarError> {
    let mut object = root
        .object_value()
        .ok_or_else(|| GrammarError::path_not_found(Jsonc::NAME, path))?;
    for (rank, key) in path.iter().enumerate() {
        refuse_if_defined_twice(&object, key)?;
        object = object
            .object_value(key)
            .ok_or_else(|| GrammarError::path_not_found(Jsonc::NAME, &path[..=rank]))?;
    }
    Ok(object)
}

/// The array at the end of `path`, last segment included.
fn array_at(root: &CstRootNode, path: &[String]) -> Result<CstArray, GrammarError> {
    let (list_key, object_path) = path
        .split_last()
        .ok_or_else(|| GrammarError::path_not_found(Jsonc::NAME, path))?;
    let object = object_at(root, object_path)?;
    refuse_if_defined_twice(&object, list_key)?;
    object
        .array_value(list_key)
        .ok_or_else(|| GrammarError::path_not_found(Jsonc::NAME, path))
}

/// The first element of the array whose decoded string equals `value`.
///
/// By **value equality** and never by index: an index survives a reordering no
/// better than a line number survives a reformat.
fn find_string_element(array: &CstArray, value: &str) -> Result<Option<CstNode>, GrammarError> {
    for element in array.elements() {
        let Some(literal) = element.as_string_lit() else {
            continue;
        };
        let decoded = literal
            .decoded_value()
            .map_err(|err| GrammarError::malformed(Jsonc::NAME, format!("{err:?}")))?;
        if decoded == value {
            return Ok(Some(element));
        }
    }
    Ok(None)
}

/// The element of the array carrying `identity` inside it, and the only way an
/// object element of a list is ever designated here.
///
/// **The whole array is traversed, on purpose.** Stopping at the first match
/// would let a second element carrying the same identity go unseen, and the
/// removal would then take one of two elements nothing tells apart. The refusal
/// costs one traversal and buys the only thing that matters on a list somebody
/// else owns: the product removes the element it wrote, or it removes none.
fn identified_element(
    array: &CstArray,
    path: &[String],
    identity: &Marker,
) -> Result<Option<CstObject>, GrammarError> {
    let wanted = identity.to_string();
    let mut found: Option<CstObject> = None;
    let mut occurrences = 0;
    for element in array.elements() {
        let Some(object) = element.as_object() else {
            continue;
        };
        refuse_if_defined_twice(&object, IDENTITY_KEY)?;
        let Some(property) = object.get(IDENTITY_KEY) else {
            continue;
        };
        let Some(node) = property.value() else {
            continue;
        };
        // The identity is a string and nothing else. An element carrying
        // anything else under that name was not written by this product, so it
        // is not claimed — reading it as an identity would be claiming bytes
        // somebody else wrote.
        let Some(literal) = node.as_string_lit() else {
            continue;
        };
        let decoded = literal
            .decoded_value()
            .map_err(|err| GrammarError::malformed(Jsonc::NAME, format!("{err:?}")))?;
        if decoded != wanted {
            continue;
        }
        occurrences += 1;
        if found.is_none() {
            found = Some(object);
        }
    }
    if occurrences > 1 {
        return Err(GrammarError::duplicated_identity(
            Jsonc::NAME,
            path,
            identity,
            occurrences,
        ));
    }
    Ok(found)
}

/// The fields of an element, identity excluded: what the product wrote there,
/// as the document carries it now.
fn read_fields(element: &CstObject) -> Result<Vec<(String, Value)>, GrammarError> {
    let mut fields = Vec::new();
    for property in element.properties() {
        let name = property_name(&property)?;
        if name == IDENTITY_KEY {
            continue;
        }
        // A field defined twice inside one element leaves undefined which one a
        // reader honours, exactly as at any other path. Comparing against the
        // first would report a divergence, or fail to report one, according to
        // an order nothing guarantees.
        refuse_if_defined_twice(element, &name)?;
        fields.push((name, read_property_value(&property)?));
    }
    Ok(fields)
}

/// Reads the value carried by a node, so that the inverse knows how to restore
/// it.
fn read_value(node: &CstNode) -> Result<Value, GrammarError> {
    if let Some(literal) = node.as_string_lit() {
        let decoded = literal
            .decoded_value()
            .map_err(|err| GrammarError::malformed(Jsonc::NAME, format!("{err:?}")))?;
        return Ok(Value::Text(decoded));
    }
    if let Some(number) = node.as_number_lit() {
        return Ok(Value::Number(number.to_string()));
    }
    // A bare word — the format's tolerance for unquoted names and values — is
    // returned as its raw text: restoring it means writing those bytes back,
    // not giving them a meaning.
    if let Some(word) = node.as_word_lit() {
        return Ok(Value::Number(word.to_string()));
    }
    if let Some(boolean) = node.as_boolean_lit() {
        return Ok(Value::Bool(boolean.value()));
    }
    if node.as_null_keyword().is_some() {
        return Ok(Value::Null);
    }
    if let Some(array) = node.as_array() {
        let mut values = Vec::new();
        for element in array.elements() {
            values.push(read_value(&element)?);
        }
        return Ok(Value::List(values));
    }
    if let Some(object) = node.as_object() {
        let mut entries = Vec::new();
        for property in object.properties() {
            entries.push((property_name(&property)?, read_property_value(&property)?));
        }
        return Ok(Value::Object(entries));
    }
    Err(GrammarError::unsupported(
        Jsonc::NAME,
        "reading a value of this kind",
    ))
}

fn property_name(property: &jsonc_parser::cst::CstObjectProp) -> Result<String, GrammarError> {
    property
        .name()
        .ok_or_else(|| GrammarError::malformed(Jsonc::NAME, "property with no name"))?
        .decoded_value()
        .map_err(|err| GrammarError::malformed(Jsonc::NAME, format!("{err:?}")))
}

fn read_property_value(property: &jsonc_parser::cst::CstObjectProp) -> Result<Value, GrammarError> {
    let node = property
        .value()
        .ok_or_else(|| GrammarError::malformed(Jsonc::NAME, "property with no value"))?;
    read_value(&node)
}

/// Translates a value of the product into what the library can insert.
fn input_value(value: &Value) -> CstInputValue {
    match value {
        Value::Text(text) => CstInputValue::String(text.clone()),
        Value::Number(raw) => CstInputValue::Number(raw.clone()),
        Value::Bool(value) => CstInputValue::Bool(*value),
        Value::Null => CstInputValue::Null,
        Value::List(values) => CstInputValue::Array(values.iter().map(input_value).collect()),
        Value::Object(entries) => CstInputValue::Object(
            entries
                .iter()
                .map(|(name, value)| (name.clone(), input_value(value)))
                .collect(),
        ),
    }
}

/// Gathers the **leaf** values of the document, each with its path.
///
/// The elements of an array share the path of that array: their rank does not
/// enter their identity, failing which adding one element would make every
/// element after it "disappear".
fn collect_values(
    node: &CstNode,
    path: &str,
    values: &mut Vec<SemanticValue>,
) -> Result<(), GrammarError> {
    if let Some(object) = node.as_object() {
        for property in object.properties() {
            let name = property_name(&property)?;
            let child_path = if path.is_empty() {
                name
            } else {
                format!("{path}.{name}")
            };
            let Some(value) = property.value() else {
                continue;
            };
            collect_values(&value, &child_path, values)?;
        }
        return Ok(());
    }
    if let Some(array) = node.as_array() {
        for element in array.elements() {
            collect_values(&element, path, values)?;
        }
        return Ok(());
    }
    let value = read_value(node)?;
    if value.is_leaf() {
        values.push(SemanticValue::new(path, value));
    }
    Ok(())
}

fn parse(source: &str) -> Result<CstRootNode, GrammarError> {
    CstRootNode::parse(source, &ParseOptions::default())
        .map_err(|err| GrammarError::malformed(Jsonc::NAME, err))
}

/// Refuses, by naming the key, if `object` defines it more than once.
///
/// The format admits the duplicate and leaves undefined what a reader makes of
/// it (RFC 8259 § 4: "the behavior … is unpredictable"). Reading the first
/// occurrence would be an arbitration, and a silent one: the product would
/// write into a block that nothing says is the one that counts, the trace would
/// be identical on two machines whose policies differ, and the diagnosis would
/// report both as compliant. That is the mode C7 exists to close, and it does
/// not depend on how a host reads: it is enough that the format permits it.
fn refuse_if_defined_twice(object: &CstObject, key: &str) -> Result<(), GrammarError> {
    let occurrences = object
        .properties()
        .iter()
        .filter_map(|property| property.name())
        .filter(|name| name.decoded_value().is_ok_and(|decoded| decoded == key))
        .count();
    if occurrences > 1 {
        return Err(GrammarError::ambiguous(Jsonc::NAME, key, occurrences));
    }
    Ok(())
}
