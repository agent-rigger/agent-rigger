# agent-rigger — working conventions

`agent-rigger` is a harness package manager: a team decides once what it shares — skills, sub-agents,
tool servers, instructions, guardrails — and the tool poses that on every equipped root, reversibly,
traceably, without destroying what its owner wrote.

**This repository is public and Apache-2.0.** Everything in it is read by people who were not in the
room when it was written, and who do not share our language.

## Language — English, everywhere in this repository

**Identifiers, doc comments, inline comments, test names, error messages, commit messages: English.**
No exceptions. A public repository whose code is half in another language is a repository whose
contributors have to be recruited from one country.

This convention was written down on 2026-08-06, after three slices had been delivered in French and
had to be translated. It was nobody's mistake — it had never been written anywhere, and this file did
not exist. That is the actual lesson: a convention that lives only in someone's head is not a
convention, and the cost of writing it down is always smaller than the cost of the retrofit.

**Design notes and specifications live in a separate, private repository, and they are in French.**
That boundary is deliberate: what ships is English, what is deliberated is in the language it was
deliberated in. It has one consequence to handle rather than hide — a contributor reading this code
cannot follow a requirement identifier back to its prose. So **the code must stand on its own**. A
doc comment that says *why*, in English, is not a nicety here; it is the only account a reader gets.

### Requirement identifiers

Tests are named after the requirement they realise, in English, prefixed by its identifier:

```rust
#[test]
fn c1_a_grammar_that_does_not_preserve_aborts() { … }
```

The **identifier** carries the traceability — that is why they are flat and never renumbered — and
the English name carries the meaning. Do not transliterate the French scenario title; state what the
test establishes.

## Quality gates

Run all three from the repository root. A change is not done until the three are green.

```bash
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test --all
```

Never disable, skip, or comment out a test to get green. If a test fails, the finding is the failure,
not the test.

## Branching

Never work on `main` — one feature branch per change. A merge to `main` in this repository is an act
of publication.

## What this code is, in one paragraph

The product **assembles**; a catalogue decides what is posed. It exposes a closed, compiler-locked set
of behaviours, each a quadruplet — grammar, inverse, capture, restoration. It knows *where* to pose,
never *what* to pose. It undoes what it posed by **replaying a recorded trace**, never by recognising
shapes on disk: a lost or silently rewritten trace does not degrade the service, it makes a posed
thing permanently unremovable with no error and nobody noticing. Every guarantee in this crate exists
to keep that from happening.

## The rule that costs the most, and why it is kept

**No claim about a host's behaviour without its source.** Not a preference — three unsourced claims
have already been paid for here, one of which travelled through four internal documents before the
official documentation contradicted it. A cell nobody measured stays empty; it is never filled by
analogy with a host that resembles it.

The same discipline applies inside the code. A rule that refuses something must derive from a
**property** — of the grammar, of the document — and never from a list of host names. A list of names
stops protecting the day a host changes, and nothing goes red.
