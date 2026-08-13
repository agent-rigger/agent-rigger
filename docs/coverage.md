# Coverage

This page is rendered by `rigger-cli`, and it is never edited by hand. The matrix and "Declared limits" come from `rigger_grammar::table()`, checked byte for byte against everything above "What the product cannot observe" by `crates/rigger-grammar/tests/coverage.rs`; that section is not derived from any grammar's table, so the whole page — it included — is instead checked by `crates/rigger-cli/tests/coverage_command.rs`, which runs the compiled binary and compares its stdout to this file. A cell reading "never" in the matrix names a limit the derivation measured, not one this page assumes; where the derivation also names why, the reason is under "Declared limits" below.

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

## What the product cannot observe

None of the lines below come from a grammar's capability table, and none is lifted by a grammar changing. Each names something the product itself never does or never asks a host — never a claim about what any host does on its own.

- The product poses the files a behaviour names and records their trace; it never asks a host anything about what becomes of them afterwards. So it cannot know, and this page cannot say, whether what it posed is read one file at a time, as a whole directory, or at all.
