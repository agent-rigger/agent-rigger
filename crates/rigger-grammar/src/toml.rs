//! The TOML grammar, served by `toml_edit 0.25.13`, **read-only**.
//!
//! **Why it does not write** (settled on 2026-08-06,
//! `docs/specs/refondation-multi-assistants/04-design-socle-neuf.md`
//! § Plan de fichiers). Its writing role was the configuration file of a host
//! that is no longer served, and no document owned by the host that is served
//! is in TOML. It serves the reading of the catalogue file and of the
//! descriptors, and nothing else.
//!
//! **What refuses `merge`, and in what order.** Read-only is the
//! **categorical** reason: it comes from the decision above, it is carried by
//! [`GrammarRole::ReadOnly`](crate::GrammarRole), and no measurement lifts it.
//! It is the refusal the file plan asks for — "a `merge` declared on this
//! grammar is refused by name, as on `frontmatter_read`" — and
//! `frontmatter_read` is refused because it does not write, never because a
//! library would lose bytes.
//!
//! **What that makes of the limit measured at T1.** `toml_edit 0.25.13`
//! normalises every CRLF line ending to LF **on render** — a cause at the
//! source, not avoidable by any option, characterized in
//! `tests/known_limits.rs`. That limit is no longer an obstacle in production,
//! and it is no longer what closes the gate either: it is a **second** reason,
//! measured on the probe below, published alongside the first. The day the
//! library fixes it, that reason will disappear from the refusal and admission
//! **will not reopen** — a grammar the product has decided not to write has no
//! gate to reopen. The two reasons are published separately precisely so that a
//! reader does not mistake the second for the first.

use std::str::FromStr;

use toml_edit::DocumentMut;

use crate::{Grammar, GrammarError, GrammarRole, Probe, Resolution};

/// The TOML grammar.
pub struct Toml;

/// The probe: the same hostile trivia as the corpus, in CRLF, because that is
/// exactly the dimension on which preservation is lost.
const PROBE_SOURCE: &str = concat!(
    "# probe — leading comment\r\n",
    "[sandbox]\r\n",
    "allow = [\r\n",
    "    \"read\",\r\n",
    "    \"write\",\r\n",
    "]  # locked\r\n",
);

impl Grammar for Toml {
    const NAME: &'static str = "toml";

    /// Read-only, settled on 2026-08-06
    /// (`docs/specs/refondation-multi-assistants/04-design-socle-neuf.md`
    /// § Plan de fichiers, and `docs/specs/socle-neuf/requirements.md` § C1).
    /// The product reads the catalogue file and the descriptors with this
    /// grammar; it writes into no TOML document, because no document owned by
    /// the host that is served is one.
    const ROLE: GrammarRole = GrammarRole::ReadOnly;

    /// No value here is arbitrated by its rank: the format forbids defining a
    /// key more than once (TOML v1.0.0 § Keys, "Defining a key multiple times
    /// is invalid"), so there exists no second candidate that a position would
    /// have to separate.
    const RESOLUTION: Resolution = Resolution::IndependentOfOrder;

    const PROBE: Probe = Probe {
        source: PROBE_SOURCE,
        comment: "# probe — leading comment",
        list_path: &["sandbox", "allow"],
        value_present: "read",
        value_absent: "network",
    };

    fn round_trip(source: &str) -> Result<String, GrammarError> {
        DocumentMut::from_str(source)
            .map(|document| document.to_string())
            .map_err(|err| GrammarError::malformed(Self::NAME, err))
    }

    /// Not implemented, and this is not a gap to be filled: designating a list
    /// element serves to record its inverse, which a grammar with no write path
    /// has no business doing.
    fn find_string_in_list(
        _source: &str,
        _path: &[&str],
        _value: &str,
    ) -> Result<bool, GrammarError> {
        Err(GrammarError::unsupported(
            Self::NAME,
            "designating a list element",
        ))
    }
}
