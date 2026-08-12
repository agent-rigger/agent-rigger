# Coverage

This page is rendered from `rigger_grammar::table()` and checked byte for byte by `crates/rigger-grammar/tests/coverage.rs` — it is never edited by hand. A cell reading "never" names a limit the derivation measured, not one this page assumes; where the derivation also names why, the reason is under "Declared limits" below.

## What each grammar can express

| Grammar | Role | Preserves trivia | Corpus documents read | Designates a list element | Applies and undoes an edit | Resolution | Carries a bounded block | `merge`, these keys at this path | `merge`, this block between these bounds |
|---|---|---|---|---|---|---|---|---|---|
| `jsonc` | read-write | yes | 2 of 3 | yes | yes | independent of order | never | admitted | never |
| `toml` | read-only | never | 1 of 3 | never | never | independent of order | never | never | never |

## Declared limits

Each entry below is a refusal the derivation named, with every reason it observed, in the order it observed them. Lifting one requires the grammar to change; it is never lifted by editing this page.

- the `merge` behaviour in the form "this block between these bounds" is refused on grammar `jsonc` ; "the probe", a document this grammar reads, cannot carry a bounded block — of the four wrappings a pose writes its delimiters in, none leaves at once a block the recogniser finds again and a document this grammar still reads, so a block posed here would either have no bounds or destroy the document ; "commented.json", a document this grammar reads, cannot carry a bounded block — of the four wrappings a pose writes its delimiters in, none leaves at once a block the recogniser finds again and a document this grammar still reads, so a block posed here would either have no bounds or destroy the document ; "settings.json", a document this grammar reads, cannot carry a bounded block — of the four wrappings a pose writes its delimiters in, none leaves at once a block the recogniser finds again and a document this grammar still reads, so a block posed here would either have no bounds or destroy the document
- the `merge` behaviour in the form "these keys at this path" is refused on grammar `toml` ; the product does not write the documents of this grammar — it is read-only by product decision, and that reason is lifted by no measurement ; the round trip does not return the bytes outside the trace: the line endings (6 CRLF in, 0 out)
- the `merge` behaviour in the form "this block between these bounds" is refused on grammar `toml` ; the product does not write the documents of this grammar — it is read-only by product decision, and that reason is lifted by no measurement ; "the probe", a document this grammar reads, cannot carry a bounded block — of the four wrappings a pose writes its delimiters in, none leaves at once a block the recogniser finds again and a document this grammar still reads, so a block posed here would either have no bounds or destroy the document ; "config.toml", a document this grammar reads, cannot carry a bounded block — of the four wrappings a pose writes its delimiters in, none leaves at once a block the recogniser finds again and a document this grammar still reads, so a block posed here would either have no bounds or destroy the document
