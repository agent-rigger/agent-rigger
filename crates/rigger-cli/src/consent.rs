//! The one [`Consent`] every command in this binary hands to the registry
//! today — shared rather than declared once per command, because the two
//! existing callers ([`crate::install`] and [`crate::remove`]) need the exact
//! same answer for the exact same reason, stated once here instead of twice.

use rigger_registry::{Consent, Decision, Proposal};

/// Grants every proposal.
///
/// Neither command in this binary reads a terminal yet, so there is no
/// prompt to ask and nothing to decide against — an interactive mode that
/// actually asks is a command-surface feature, not part of the wiring either
/// tracer bullet lays down.
pub struct AlwaysGranted;

impl Consent for AlwaysGranted {
    fn decide(&self, _: &Proposal<'_>) -> Decision {
        Decision::Granted
    }
}
