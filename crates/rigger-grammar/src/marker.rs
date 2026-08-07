//! The bounded block: the marker that delimits it, the **single** recogniser
//! that reads it, and the post-condition that guards its removal.
//!
//! This is the third shape of trace the file plan names — "this block between
//! these bounds". It does not go through a [`Grammar`](crate::Grammar), and
//! that is a consequence rather than a shortcut: a bounded block needs
//! delimiters the document knows how to carry, and the settings document that
//! is served is **strict JSON**, measured on 2026-08-06, where a comment gets
//! the file rejected. The documents this shape has an object on are therefore
//! the text ones — instruction files — whose structure is their lines. So the
//! analysis here is on text, and it owes the same guarantees as a grammar owes.
//!
//! **Not going through a grammar is not the same as answering to nothing.**
//! Writing a block never renders through a parser, but whether a document is
//! *able to carry* the delimiters is a property of its format, and a format is
//! what a grammar embodies. That question is therefore answered in
//! [`crate::capability`], with the rest of what a grammar can express, and it
//! is answered by **running** [`delimiters`] and [`read`] on a document of that
//! grammar. Two reasons for putting it there rather than here. An admission
//! decision must read **one** table: a capacity answered somewhere else would
//! be a second table of the same thing, and two of those drift apart. And C7
//! turns on the two forms of `merge` being refused for **different** reasons —
//! a comparison only the place that holds both can make.
//!
//! **One single recogniser, and it is structural, not a promise.** Everything
//! this module knows about a document comes out of [`scan`], called from
//! [`read_with`], which is the only public analysis. `place` and `remove` both
//! go through it; there exists no other function here that looks at the text.
//! Two recognisers of the same text drift apart, and the passage the product
//! believes it owns widens in silence — at removal, where it destroys.
//!
//! **Lexing first, recognition second, and that separation is the substance.**
//! [`regions`] cuts the document into disjoint stretches — a comment occupying
//! its lines whole, or a plain line — and it is **not** a recognition branch:
//! it knows nothing of markers. Each branch then reads one kind and only that
//! kind, so no branch can cover another.
//!
//! **Being a comment exempts nothing.** A stretch that carries no delimiter is
//! made of lines its author wrote, comment syntax or not, and every one of them
//! is a value the post-conditions weigh. In an instruction file `//` is two
//! characters somebody typed, and the exemption that once stood in [`scan`] let
//! removal destroy such lines while returning `Ok`.
//!
//! That shape was not the first one written, and the mutation trial is what
//! rejected the first. Branches that each demanded a whole line shape looked
//! exclusive and were not: switching off the block-comment branch left the bare
//! branch matching the token **inside** a spanning comment, whose middle line
//! is a bare token to anyone not tracking comments. The four wrappings stayed
//! green under mutation — a second read path, found by the one test whose
//! object is to check that the others measure something.
//!
//! **What the post-conditions are for.** The input checks say what we thought
//! we understood; the post-condition on the output says what we did. [`remove`]
//! therefore reads its **own rendering** back and refuses when a value the
//! trace does not record has disappeared — never deducing anything from the
//! success of what came before.
//!
//! [`place`] owes the same, and for a while did not. Its update path rewrites
//! its own bounds, so it destroys whatever the owner added inside them; on the
//! same document, removal called that line a value of the user and refused. It
//! now reads its rendering back too, which closes a second failure besides:
//! a marker the recogniser cannot find in what the writer just produced
//! delimits nothing — invisible, therefore unremovable, and duplicated by every
//! further pose.
//!
//! **A delimiter carries no value, so no comparison of values can see one go.**
//! Bounds that straddle the delimiter of another catalogue leave that block
//! unbalanced — owned by nobody, unremovable for good — with every value in the
//! document still in place. Both writes therefore also compare what the
//! document says about the **other** markers, before and after.

use std::fmt;
use std::ops::Range;

use crate::{values_lost, SemanticValue, Value};

/// The word that opens the delimiter of a posed block.
const OPEN_WORD: &str = "agent-rigger:begin";
/// The word that closes it.
const CLOSE_WORD: &str = "agent-rigger:end";
/// The label of the provenance field.
const PROVENANCE_FIELD: &str = "catalogue=";
/// The label of the entry field.
const ENTRY_FIELD: &str = "entry=";

/// The identity a pose carries **inside the document**: the provenance of the
/// catalogue and the entry identifier, and never the entry identifier alone.
///
/// **Why both, and why in clear.** Two catalogues may legitimately carry an
/// entry of the same name — `context/agents` is a name two independent authors
/// will choose. If they produced the same marker, two distinct blocks would
/// read as one, and removing the first would take the values of the second with
/// no recovery, since the marker is precisely what told them apart.
///
/// **One type for two shapes of trace, on purpose.** It delimits a bounded
/// block here, and it is lodged inside an object element of a list in
/// [`crate::element`]. What it identifies is the same thing — a pose — and the
/// hazard it closes is the same one; two definitions of it would drift, and the
/// drift would show at removal, where it destroys. What differs between the two
/// is only how a document **carries** it, which is a property of the document
/// and not of the identity — the same reason [`Wrapping`] is not part of it.
///
/// The form stays **readable** because the marker lives in a file its owner
/// opens: provenance and entry, separated and in clear. An opaque digest would
/// discriminate just as well while telling that owner "this belongs to the
/// product" without telling them *to what*.
///
/// The effective root is deliberately **not** in it: inside a given file it is
/// constant, since it is what designated that file. The residual case — two
/// distinct roots designating the same document — is closed by a refusal in
/// [`place`], not by a wider marker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Marker {
    provenance: String,
    entry: String,
}

impl Marker {
    /// The marker of a pose, from the provenance of its catalogue and its entry
    /// identifier.
    ///
    /// **Nothing is validated here, and that is where the check would be
    /// weakest.** Whether a marker is legible is not a property of its
    /// characters: an entry carrying a space is unreadable under every
    /// wrapping, while one carrying `*/` is unreadable only inside a block
    /// comment — the same identity, legal in one document and not in the next.
    /// A check here would have to be a list of forbidden characters, which is
    /// the shape of rule this crate refuses to write. So legibility is measured
    /// where it is decidable: [`place`] reads its own rendering back, and
    /// refuses when the recogniser cannot find the block the writer just wrote.
    pub fn new(provenance: impl Into<String>, entry: impl Into<String>) -> Self {
        Self {
            provenance: provenance.into(),
            entry: entry.into(),
        }
    }

    /// The provenance of the catalogue that published the entry.
    pub fn provenance(&self) -> &str {
        &self.provenance
    }

    /// The identifier of the entry, as its catalogue names it.
    pub fn entry(&self) -> &str {
        &self.entry
    }

    /// The token that opens the passage, without any wrapping.
    pub fn open(&self) -> String {
        format!("{OPEN_WORD} {self}")
    }

    /// The token that closes the passage, without any wrapping.
    pub fn close(&self) -> String {
        format!("{CLOSE_WORD} {self}")
    }
}

impl fmt::Display for Marker {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{PROVENANCE_FIELD}{} {ENTRY_FIELD}{}",
            self.provenance, self.entry
        )
    }
}

/// Which end of the passage a delimiter is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Open,
    Close,
}

/// How a document carries a delimiter. Four shapes, because a document's
/// grammar decides what a line may be: some admit a line comment, some a block
/// comment, some nothing at all.
///
/// The wrapping is a property of the **document**, not of the marker: the same
/// identity is recognised under all four, which is what C3 demands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wrapping {
    /// `// token`
    LineComment,
    /// `/* token */`, on one line.
    BlockCommentInline,
    /// `/*`, the token, `*/`, on three lines.
    BlockCommentSpanning,
    /// The token alone, for documents with no comment syntax.
    Bare,
}

impl Wrapping {
    /// The four wrappings. Written once here so that a test covering "all of
    /// them" cannot silently cover three.
    pub const ALL: &'static [Wrapping] = &[
        Wrapping::LineComment,
        Wrapping::BlockCommentInline,
        Wrapping::BlockCommentSpanning,
        Wrapping::Bare,
    ];

    /// The recognition branch that reads this wrapping. Two wrappings share
    /// one: an inline block comment and a spanning one are the same syntax, so
    /// they are read by the same code and fall together under mutation.
    pub fn branch(self) -> Branch {
        match self {
            Self::LineComment => Branch::LineComment,
            Self::BlockCommentInline | Self::BlockCommentSpanning => Branch::BlockComment,
            Self::Bare => Branch::Bare,
        }
    }

    /// Renders `token` in this wrapping, with `eol` as line ending.
    fn render(self, token: &str, eol: &str) -> String {
        match self {
            Self::LineComment => format!("// {token}"),
            Self::BlockCommentInline => format!("/* {token} */"),
            Self::BlockCommentSpanning => format!("/*{eol}{token}{eol}*/"),
            Self::Bare => token.to_string(),
        }
    }
}

/// The two delimiters of `marker`, with nothing between them, written the way
/// `source` writes its lines.
///
/// **Why this is public.** Whether a document is able to *carry* a bounded
/// block is a question the capability table answers, and it answers it by
/// measurement: it writes the delimiters into a document of the grammar and
/// asks whether what comes out is still one. That measurement must write the
/// **same** bytes a pose writes. A second renderer built for the trial would
/// drift from this one, and the drift would credit a document with carrying
/// something no pose would ever put in it — the capacity would then be
/// announced rather than executed, which is the one thing the table exists to
/// prevent.
pub fn delimiters(source: &str, marker: &Marker, wrapping: Wrapping) -> String {
    render_block(marker, wrapping, &[], line_ending(source))
}

/// A branch of the recogniser. Switching one off is what the mutation trial of
/// C3 does, and it is the only reason this type is public: a trial that had to
/// be run by hand-editing the source would be a ritual, not a measurement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Branch {
    /// Delimiters carried by a line comment.
    LineComment,
    /// Delimiters carried by a block comment, on one line or on three.
    BlockComment,
    /// Delimiters carried bare.
    Bare,
}

impl Branch {
    /// Every branch — what production reads with. [`read`] passes exactly this.
    pub const ALL: &'static [Branch] = &[Branch::LineComment, Branch::BlockComment, Branch::Bare];
}

/// What the recogniser concluded about **one** marker in the document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Recognition {
    /// No delimiter of this marker is in the document.
    Absent,
    /// One opening and one closing delimiter, in that order.
    Unique {
        /// The bytes the product owns, delimiters included, from the start of
        /// the opening line to the end of the closing one.
        bounds: Range<usize>,
        /// The wrapping the document carries the delimiters in.
        wrapping: Wrapping,
    },
    /// The marker delimits more than one passage. The product refuses rather
    /// than pick: nothing says which of the two it wrote.
    Duplicated {
        /// The marker found more than once.
        marker: Marker,
        /// How many opening delimiters were found.
        opens: usize,
        /// How many closing delimiters were found.
        closes: usize,
    },
    /// The delimiters do not pair up: one is missing, or the closing one comes
    /// first. No bounds can be derived, so nothing is owned.
    Unbalanced {
        /// The marker whose delimiters do not pair up.
        marker: Marker,
        /// How many opening delimiters were found.
        opens: usize,
        /// How many closing delimiters were found.
        closes: usize,
    },
}

impl Recognition {
    /// The classification, stripped of everything that varies with the
    /// wrapping. This is what the four wrappings must agree on: byte bounds
    /// cannot be compared across documents that differ by the length of their
    /// delimiters, but the verdict can, and so can the values.
    pub fn classification(&self) -> Classification {
        match self {
            Self::Absent => Classification::Absent,
            Self::Unique { .. } => Classification::Unique,
            Self::Duplicated { .. } => Classification::Duplicated,
            Self::Unbalanced { .. } => Classification::Unbalanced,
        }
    }

    /// The bytes owned, when there are any.
    pub fn bounds(&self) -> Option<&Range<usize>> {
        match self {
            Self::Unique { bounds, .. } => Some(bounds),
            _ => None,
        }
    }
}

/// The verdict alone. `Unique` here and `Absent` there on the same document
/// under a different wrapping is exactly the divergence C3 forbids.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Classification {
    /// Nothing of this marker is in the document.
    Absent,
    /// One passage, bounded.
    Unique,
    /// Several passages under one marker.
    Duplicated,
    /// Delimiters that do not pair up.
    Unbalanced,
}

/// Everything one analysis of a document yields: the verdict, the bounds, the
/// values, and every marker of the product the document carries.
///
/// They come out **together** because they must come from the same read. Values
/// read by one pass and bounds by another would drift, and the drift would only
/// show at removal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reading {
    /// What was concluded about the marker that was asked for.
    pub recognition: Recognition,
    /// Every marker of the product found in the document, whoever it belongs
    /// to, in the order they appear. This is what [`place`] checks against the
    /// registry.
    pub markers: Vec<Marker>,
    /// The values living **inside** the owned passage.
    pub inside: Vec<SemanticValue>,
    /// The values living **outside** it. When nothing is owned, every value is
    /// here.
    pub outside: Vec<SemanticValue>,
}

/// Reads `source` for `marker`, with every recognition branch.
///
/// `address` is what a refusal names alongside a value — the address the trace
/// records, never a line number.
pub fn read(source: &str, address: &str, marker: &Marker) -> Reading {
    read_with(source, address, marker, Branch::ALL)
}

/// The same read, with only `branches` switched on.
///
/// **The one and only analysis of this module.** [`read`] is this function with
/// every branch; `place` and `remove` call it and read nothing themselves. The
/// parameter exists for the mutation trial of C3, and for nothing else: it is
/// how "switching off one branch reddens a test" becomes something a suite runs
/// rather than something a reviewer promises.
pub fn read_with(source: &str, address: &str, marker: &Marker, branches: &[Branch]) -> Reading {
    let segments = scan(source, branches);

    let mut markers: Vec<Marker> = Vec::new();
    let mut opens: Vec<(usize, Range<usize>, Wrapping)> = Vec::new();
    let mut closes: Vec<(usize, Range<usize>)> = Vec::new();
    for (rank, segment) in segments.iter().enumerate() {
        let Segment::Marker {
            kind,
            marker: found,
            wrapping,
            span,
        } = segment
        else {
            continue;
        };
        if !markers.contains(found) {
            markers.push(found.clone());
        }
        if found != marker {
            continue;
        }
        match kind {
            Kind::Open => opens.push((rank, span.clone(), *wrapping)),
            Kind::Close => closes.push((rank, span.clone())),
        }
    }

    let recognition = classify(marker, &opens, &closes);
    let bounds = recognition.bounds().cloned();

    let mut inside = Vec::new();
    let mut outside = Vec::new();
    for segment in &segments {
        let Segment::Content { text, span } = segment else {
            continue;
        };
        let value = SemanticValue::new(address, Value::Text(text.clone()));
        match &bounds {
            Some(bounds) if span.start >= bounds.start && span.end <= bounds.end => {
                inside.push(value);
            }
            _ => outside.push(value),
        }
    }

    Reading {
        recognition,
        markers,
        inside,
        outside,
    }
}

/// Turns the delimiters found into a verdict. Written apart so that the four
/// cases are visible side by side: the one that owns bytes is the only one that
/// gives any, and it demands the pair to be complete, unique and in order.
fn classify(
    marker: &Marker,
    opens: &[(usize, Range<usize>, Wrapping)],
    closes: &[(usize, Range<usize>)],
) -> Recognition {
    let (open_count, close_count) = (opens.len(), closes.len());
    if open_count == 0 && close_count == 0 {
        return Recognition::Absent;
    }
    if open_count > 1 || close_count > 1 {
        return Recognition::Duplicated {
            marker: marker.clone(),
            opens: open_count,
            closes: close_count,
        };
    }
    let unbalanced = Recognition::Unbalanced {
        marker: marker.clone(),
        opens: open_count,
        closes: close_count,
    };
    let (Some((open_rank, open_span, wrapping)), Some((close_rank, close_span))) =
        (opens.first(), closes.first())
    else {
        return unbalanced;
    };
    if close_rank < open_rank {
        return unbalanced;
    }
    Recognition::Unique {
        bounds: open_span.start..close_span.end,
        wrapping: *wrapping,
    }
}

/// What one line, or one group of lines, is.
#[derive(Debug)]
enum Segment {
    /// A delimiter of the product.
    Marker {
        kind: Kind,
        marker: Marker,
        wrapping: Wrapping,
        span: Range<usize>,
    },
    /// A non-blank line the document carries, which is a value of whoever wrote
    /// it.
    Content { text: String, span: Range<usize> },
}

/// A line of the source, with the bytes it occupies, terminator included.
struct Line<'a> {
    text: &'a str,
    start: usize,
    end: usize,
}

fn lines_of(source: &str) -> Vec<Line<'_>> {
    let mut lines = Vec::new();
    let mut start = 0;
    while start < source.len() {
        let end = match source[start..].find('\n') {
            Some(offset) => start + offset + 1,
            None => source.len(),
        };
        let text = source[start..end]
            .strip_suffix('\n')
            .unwrap_or(&source[start..end]);
        let text = text.strip_suffix('\r').unwrap_or(text);
        lines.push(Line { text, start, end });
        start = end;
    }
    lines
}

/// The one normalisation of a line, applied to **both** sides of the
/// subtraction the post-conditions perform.
///
/// [`regions`] normalises what it reads out of a document; [`BlockTrace`]
/// normalises what the registry recorded. Were the two to differ — a trim on
/// one side only — a body line carrying indentation would never subtract from
/// itself: the block would be permanently unremovable while the product accused
/// itself of destroying a value of its owner. Indentation is the norm in a
/// fragment of an instruction file, so that is not a corner.
///
/// Trimming, rather than keeping the bytes, is what makes the comparison a
/// comparison of **values**: re-indenting a document is not destroying it, and
/// C1 already forbids the product to reformat what it did not write.
fn normalise(line: &str) -> &str {
    line.trim()
}

/// A stretch of the document, as **lexing** cuts it — before any question
/// about markers is asked.
#[derive(Debug)]
enum Region {
    /// A comment occupying its lines whole, and what it encloses.
    Comment {
        /// What the comment encloses, introducers stripped: the only thing a
        /// delimiter could be read out of.
        interior: String,
        /// The wrapping a delimiter would be carried in here.
        wrapping: Wrapping,
        span: Range<usize>,
        /// The lines the comment is made of, as the document carries them.
        ///
        /// A comment that turns out not to be a delimiter is **not a region at
        /// all**: it is the lines it was cut out of, and they belong to whoever
        /// wrote them. Keeping them here is what lets the analysis hand them
        /// back one by one instead of as one lump, so that a body the product
        /// itself wrote — recorded line by line in its trace — still subtracts
        /// from what a later read gives back.
        lines: Vec<(String, Range<usize>)>,
    },
    /// Anything else: a line of the document, which is a value of whoever
    /// wrote it.
    Line { text: String, span: Range<usize> },
}

/// Cuts the document into regions. **This is not a recognition branch**: it
/// knows nothing of markers, and switching a branch off does not change what it
/// returns. Its only job is to say what is a comment, so that the branches read
/// disjoint kinds and no branch can stand in for another.
///
/// A block comment must occupy its lines **whole** — nothing but whitespace
/// before the opening, nothing but whitespace after the closing. One sharing a
/// line with something else is not a delimiter of the product, since the bounds
/// would then cover bytes the product did not write. An unterminated opening is
/// an ordinary line, because guessing where it ends would be inventing the
/// bounds.
fn regions(source: &str) -> Vec<Region> {
    let lines = lines_of(source);
    let mut regions = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        if let Some((consumed, region)) = block_comment(&lines, index) {
            regions.push(region);
            index += consumed;
            continue;
        }
        let line = &lines[index];
        let trimmed = normalise(line.text);
        let span = line.start..line.end;
        match trimmed.strip_prefix("//") {
            Some(interior) => regions.push(Region::Comment {
                interior: normalise(interior).to_string(),
                wrapping: Wrapping::LineComment,
                span: span.clone(),
                lines: vec![(trimmed.to_string(), span)],
            }),
            None => regions.push(Region::Line {
                text: trimmed.to_string(),
                span,
            }),
        }
        index += 1;
    }
    regions
}

/// A block comment starting at `index`, and how many lines it takes.
fn block_comment(lines: &[Line<'_>], index: usize) -> Option<(usize, Region)> {
    let first = lines.get(index)?;
    let mut interior = String::new();
    let mut closing = index;
    loop {
        let line = lines.get(closing)?;
        let text = if closing == index {
            line.text.trim_start().strip_prefix("/*")?
        } else {
            line.text
        };
        let Some(offset) = text.find("*/") else {
            interior.push_str(text);
            interior.push(' ');
            closing += 1;
            continue;
        };
        if !normalise(&text[offset + 2..]).is_empty() {
            return None;
        }
        interior.push_str(&text[..offset]);
        let raw = lines[index..=closing]
            .iter()
            .map(|line| (normalise(line.text).to_string(), line.start..line.end))
            .collect();
        return Some((
            closing - index + 1,
            Region::Comment {
                interior: normalise(&interior).to_string(),
                wrapping: if closing == index {
                    Wrapping::BlockCommentInline
                } else {
                    Wrapping::BlockCommentSpanning
                },
                span: first.start..line.end,
                lines: raw,
            },
        ));
    }
}

/// The single analysis. Every region is offered to the **one** branch that
/// reads its kind; a region no branch claims is made of lines, and every
/// non-blank one of them is a value of whoever wrote it.
///
/// **A comment no branch claims is not exempt from that**, and the exemption
/// that used to stand here is what this rule replaces. The documents this shape
/// has an object on are text files — instruction files — where `//` is not
/// comment syntax but two characters somebody typed, and `/* … */` encloses
/// prose rather than code. Exempting them made removal destroy those lines
/// while returning `Ok`: the post-condition compares values, and a line that is
/// no value cannot be seen to disappear.
///
/// The exemption was justified by a case that cannot arise: switching a branch
/// off would turn a delimiter into a value, and removal would report a loss
/// where there was none. But removal reads through [`read`], which passes
/// [`Branch::ALL`]; the branch parameter exists for the mutation trial, and the
/// trial never removes. A reason that derives from no property of the code is
/// the mechanical lie this crate exists to close, and it cost the silent
/// destruction above.
fn scan(source: &str, branches: &[Branch]) -> Vec<Segment> {
    let mut segments = Vec::new();
    for region in regions(source) {
        match region {
            Region::Comment {
                interior,
                wrapping,
                span,
                lines,
            } => match delimiter(&interior, wrapping, span, branches) {
                Some(segment) => segments.push(segment),
                None => segments.extend(lines.into_iter().filter_map(|(text, span)| {
                    (!text.is_empty()).then_some(Segment::Content { text, span })
                })),
            },
            Region::Line { text, span } => {
                match delimiter(&text, Wrapping::Bare, span.clone(), branches) {
                    Some(segment) => segments.push(segment),
                    None if !text.is_empty() => segments.push(Segment::Content { text, span }),
                    None => {}
                }
            }
        }
    }
    segments
}

/// Reads a delimiter out of one region, if the branch that serves this wrapping
/// is switched on.
fn delimiter(
    interior: &str,
    wrapping: Wrapping,
    span: Range<usize>,
    branches: &[Branch],
) -> Option<Segment> {
    if !branches.contains(&wrapping.branch()) {
        return None;
    }
    let (kind, marker) = parse_token(interior)?;
    Some(Segment::Marker {
        kind,
        marker,
        wrapping,
        span,
    })
}

/// Reads a token and the identity it carries. `text` must be the token entire:
/// what precedes and what follows has already been stripped by the branch that
/// calls this.
fn parse_token(text: &str) -> Option<(Kind, Marker)> {
    let (kind, rest) = match text.strip_prefix(OPEN_WORD) {
        Some(rest) => (Kind::Open, rest),
        None => (Kind::Close, text.strip_prefix(CLOSE_WORD)?),
    };
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let fields = rest.trim();
    let (provenance, tail) = fields.strip_prefix(PROVENANCE_FIELD)?.split_once(' ')?;
    let entry = tail.trim_start().strip_prefix(ENTRY_FIELD)?;
    if provenance.is_empty() || entry.is_empty() {
        return None;
    }
    if provenance.contains(char::is_whitespace) || entry.contains(char::is_whitespace) {
        return None;
    }
    Some((kind, Marker::new(provenance, entry)))
}

/// What the registry records for a posed block: its identity, where it was
/// posed, and the values the product itself wrote there.
///
/// **The values are what makes the post-condition of removal possible.** The
/// requirement is not that nothing disappear — the passage does, and that is
/// the point. It is that what disappears reduces exactly to what the trace
/// records.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockTrace {
    marker: Marker,
    address: String,
    values: Vec<String>,
}

impl BlockTrace {
    /// The trace of a block posed at `address`, carrying `values`.
    pub fn new(
        marker: Marker,
        address: impl Into<String>,
        values: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        Self {
            marker,
            address: address.into(),
            values: values.into_iter().map(Into::into).collect(),
        }
    }

    /// The identity of the block.
    pub fn marker(&self) -> &Marker {
        &self.marker
    }

    /// Where it was posed.
    pub fn address(&self) -> &str {
        &self.address
    }

    /// The values the trace records, in the shape the reading yields them, so
    /// the two can be subtracted from one another.
    ///
    /// [`normalise`] is applied here for that reason and no other: it is the
    /// same function the reading applies, and a body line the product itself
    /// wrote must subtract from itself or the block it belongs to can never be
    /// removed. A blank line is dropped for the same reason — the reading
    /// yields no value for one, so a trace carrying it would be comparing
    /// against something that cannot appear.
    pub fn recorded_values(&self) -> Vec<SemanticValue> {
        self.values
            .iter()
            .map(|value| normalise(value))
            .filter(|value| !value.is_empty())
            .map(|value| SemanticValue::new(&self.address, Value::Text(value.to_string())))
            .collect()
    }
}

/// The identity of a pose, everything it needs to be legitimate, and what it
/// writes.
#[derive(Debug, Clone)]
pub struct Pose<'a> {
    /// The identity the block will carry.
    pub marker: &'a Marker,
    /// The address of the document, as the trace records it.
    pub address: &'a str,
    /// The effective roots that designated this document. More than one
    /// distinct root is the residual case C4 closes by refusing.
    pub roots: &'a [&'a str],
    /// The markers the registry holds a trace for. A marker found in the
    /// document and absent from here makes the pose refuse.
    pub traced: &'a [Marker],
    /// What the registry records for a block of this marker **already posed in
    /// this document**, when there is one.
    ///
    /// An update rewrites the interior of its own bounds. Without this, it has
    /// no way of telling the lines it wrote there itself from lines the owner
    /// added inside them, and it destroys the second kind in silence — which
    /// removal, on the very same document, refuses to do. The asymmetry is the
    /// defect: one path calls such a line a value of the user, the other
    /// overwrites it without looking.
    pub posed: Option<&'a BlockTrace>,
    /// The lines the product writes inside its bounds.
    pub body: &'a [&'a str],
    /// The wrapping the document can carry.
    pub wrapping: Wrapping,
}

/// A pose that happened: the document to write, and the trace that undoes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Placed {
    /// The rendered document, to be written as is.
    pub rendered: String,
    /// What the registry must record in order to be able to remove it.
    pub trace: BlockTrace,
}

/// Why a pose did not happen. None of these leaves a document written: this
/// function performs no input or output, and returns nothing at all when it
/// refuses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlaceError {
    /// Two distinct roots designate the same document. The marker cannot tell
    /// them apart — the effective root is not in it — so the pose refuses by
    /// naming them rather than write two blocks no later read could separate.
    AmbiguousRoots {
        /// The document both roots designate.
        address: String,
        /// The roots, as they were given.
        roots: Vec<String>,
    },
    /// The document carries a marker of the product for which the registry
    /// holds no trace. Adopting it would be claiming bytes the product did not
    /// write, and granting itself the right to destroy them later.
    UntracedMarker {
        /// The marker found.
        marker: Marker,
        /// The document it was found in.
        address: String,
    },
    /// The delimiters of this marker do not describe one single passage.
    NotSeparable {
        /// The marker at fault.
        marker: Marker,
        /// The document.
        address: String,
        /// What the recogniser concluded.
        classification: Classification,
    },
    /// **A post-condition on the output.** The rendering was read back and the
    /// block it was supposed to carry is not there, or is not one single
    /// passage. Whatever was written delimits nothing, so no later read can
    /// find it and no removal can undo it.
    NotRecognised {
        /// The marker that was to be written.
        marker: Marker,
        /// The document.
        address: String,
        /// What the recogniser concluded about the rendering.
        classification: Classification,
    },
    /// **A post-condition on the output.** The rendering lost values that
    /// neither the block already posed here nor the new body accounts for: the
    /// owner wrote them inside the bounds, and an update would erase them.
    ValuesLost {
        /// The marker being posed.
        marker: Marker,
        /// The values that would disappear, each with its path.
        lost: Vec<SemanticValue>,
    },
    /// **A post-condition on the output.** The write changed what the document
    /// says about the block of another catalogue.
    NeighbourBroken {
        /// The marker being posed.
        marker: Marker,
        /// The block of the other catalogue.
        neighbour: Marker,
        /// What that block was before the write.
        was: Classification,
        /// What it is after.
        now: Classification,
    },
}

impl fmt::Display for PlaceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AmbiguousRoots { address, roots } => write!(
                f,
                "`{address}` is designated by {} distinct roots — {} — and the marker does not \
                 carry the root, so two blocks posed here could never be told apart on a later \
                 read. The pose refuses rather than write them",
                roots.len(),
                roots.join(", ")
            ),
            Self::UntracedMarker { marker, address } => write!(
                f,
                "`{address}` carries the marker `{marker}`, and the registry holds no trace of \
                 it. The pose refuses: those bytes were not written by this product, which \
                 therefore does not take them over and does not grant itself the right to \
                 destroy them later"
            ),
            Self::NotSeparable {
                marker,
                address,
                classification,
            } => write!(
                f,
                "`{address}`: the delimiters of `{marker}` do not describe one single passage \
                 ({classification:?}), and nothing says which bytes the product owns"
            ),
            Self::NotRecognised {
                marker,
                address,
                classification,
            } => write!(
                f,
                "the block written for `{marker}` in `{address}` reads back as {classification:?}, \
                 not as one single passage: the recogniser cannot find what the writer just wrote. \
                 Such a block delimits nothing — no later read finds it, no removal undoes it, and \
                 every further pose appends another copy. The pose aborts"
            ),
            Self::ValuesLost { marker, lost } => {
                write!(
                    f,
                    "posing `{marker}` would make {} value(s) disappear that no trace records —",
                    lost.len()
                )?;
                for value in lost {
                    write!(f, " {value}")?;
                }
                write!(
                    f,
                    ". They live inside the bounds and the product did not write them, so it does \
                     not overwrite them"
                )
            }
            Self::NeighbourBroken {
                marker,
                neighbour,
                was,
                now,
            } => write!(
                f,
                "posing `{marker}` would leave the block of `{neighbour}` {now:?} where it was \
                 {was:?}. A delimiter carries no value, so nothing else in this check can see it \
                 go — and a block whose delimiters no longer pair up belongs to nobody and can \
                 never be removed"
            ),
        }
    }
}

impl std::error::Error for PlaceError {}

/// Poses a bounded block, or says why it does not.
///
/// Two refusals come **before** any rendering exists, and they are the two C4
/// demands: two roots on one document, and a marker with no trace. Three more
/// come **after**, and they bear on the rendering rather than on anything
/// decided before it — the same doctrine removal follows, for the same reason:
/// the input checks say what we thought we understood, the post-conditions say
/// what the write did. A pose that returned the first three and skipped the
/// last three was destroying, on its update path, exactly what removal refuses
/// to destroy on the same document.
pub fn place(source: &str, pose: &Pose<'_>) -> Result<Placed, PlaceError> {
    let mut distinct: Vec<&str> = Vec::new();
    for root in pose.roots {
        if !distinct.contains(root) {
            distinct.push(root);
        }
    }
    if distinct.len() > 1 {
        return Err(PlaceError::AmbiguousRoots {
            address: pose.address.to_string(),
            roots: distinct.iter().map(|root| (*root).to_string()).collect(),
        });
    }

    let reading = read(source, pose.address, pose.marker);
    for found in &reading.markers {
        if !pose.traced.contains(found) {
            return Err(PlaceError::UntracedMarker {
                marker: found.clone(),
                address: pose.address.to_string(),
            });
        }
    }

    let eol = line_ending(source);
    let block = render_block(pose.marker, pose.wrapping, pose.body, eol);
    let rendered = match &reading.recognition {
        // The marker is already there and the registry knows it: this is an
        // update, and its bounds are the ones the same read just gave.
        Recognition::Unique { bounds, .. } => {
            let mut rendered = String::with_capacity(source.len() + block.len());
            rendered.push_str(&source[..bounds.start]);
            rendered.push_str(&block);
            rendered.push_str(&source[bounds.end..]);
            rendered
        }
        Recognition::Absent => {
            let mut rendered = String::with_capacity(source.len() + block.len() + eol.len());
            rendered.push_str(source);
            if !source.is_empty() && !source.ends_with('\n') {
                rendered.push_str(eol);
            }
            rendered.push_str(&block);
            rendered
        }
        Recognition::Duplicated { .. } | Recognition::Unbalanced { .. } => {
            return Err(PlaceError::NotSeparable {
                marker: pose.marker.clone(),
                address: pose.address.to_string(),
                classification: reading.recognition.classification(),
            })
        }
    };

    // Read the rendering back with the **same** recogniser. A block the writer
    // produced and the recogniser cannot find is the worst of the failures this
    // module has: it is invisible, therefore unremovable, and the next pose
    // appends a second copy of it. Nothing about the marker's characters is
    // judged here — legality is whether the document can carry it, which
    // depends on the wrapping, so it is measured rather than listed.
    let after = read(&rendered, pose.address, pose.marker);
    let classification = after.recognition.classification();
    if classification != Classification::Unique {
        return Err(PlaceError::NotRecognised {
            marker: pose.marker.clone(),
            address: pose.address.to_string(),
            classification,
        });
    }

    // What the update overwrote, minus what the block already posed here
    // recorded. The remainder is what the owner wrote inside the bounds.
    let disappeared = values_lost(&all_values(&reading), &all_values(&after));
    let recorded = pose
        .posed
        .map(BlockTrace::recorded_values)
        .unwrap_or_default();
    let lost = values_lost(&disappeared, &recorded);
    if !lost.is_empty() {
        return Err(PlaceError::ValuesLost {
            marker: pose.marker.clone(),
            lost,
        });
    }

    if let Some((neighbour, was, now)) =
        neighbour_broken(&reading, source, &rendered, pose.address, pose.marker)
    {
        return Err(PlaceError::NeighbourBroken {
            marker: pose.marker.clone(),
            neighbour,
            was,
            now,
        });
    }

    Ok(Placed {
        rendered,
        trace: BlockTrace::new(pose.marker.clone(), pose.address, pose.body.iter().copied()),
    })
}

/// What a write did to the blocks of the **other** catalogues, if it did
/// anything.
///
/// A delimiter carries no value, so the value post-conditions cannot see one
/// disappear. A write whose bounds straddle the delimiter of another marker
/// therefore leaves that block unbalanced — its bytes owned by nobody and
/// unremovable for good — while every value in the document is still where it
/// was and nothing goes red. That is the damage C4 names, and it is observed
/// the way everything else here is: by reading the output back with the same
/// recogniser, and comparing the verdict to the one before the write.
///
/// The markers come from the reading that was already performed; only their
/// classification is measured again, once per neighbour. A document carrying
/// many blocks therefore pays one scan per block at each write — visible if a
/// document ever carries many, and the remedy is for the reading to yield the
/// delimiter counts it already computes rather than for this to guess.
fn neighbour_broken(
    before: &Reading,
    source: &str,
    rendered: &str,
    address: &str,
    mine: &Marker,
) -> Option<(Marker, Classification, Classification)> {
    before
        .markers
        .iter()
        .filter(|other| *other != mine)
        .find_map(|other| {
            let was = read(source, address, other).recognition.classification();
            let now = read(rendered, address, other).recognition.classification();
            (was != now).then(|| (other.clone(), was, now))
        })
}

/// A removal that happened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Removed {
    /// The rendered document, to be written as is.
    pub rendered: String,
}

/// Why a removal did not happen. None of these returns a document, so none of
/// them can be written by mistake.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoveError {
    /// No passage of this marker is in the document.
    NotFound {
        /// The marker that was looked for.
        marker: Marker,
        /// The document it was looked for in.
        address: String,
    },
    /// The delimiters do not describe one single passage.
    NotSeparable {
        /// The marker at fault.
        marker: Marker,
        /// The document.
        address: String,
        /// What the recogniser concluded.
        classification: Classification,
    },
    /// **The post-condition on the output.** The write made values disappear
    /// that the recorded trace does not carry, so the product destroyed
    /// something it never wrote and could not restore.
    ValuesLost {
        /// The marker being removed.
        marker: Marker,
        /// The values that disappeared, each with its path.
        lost: Vec<SemanticValue>,
    },
    /// **A post-condition on the output.** The write changed what the document
    /// says about the block of another catalogue.
    NeighbourBroken {
        /// The marker being removed.
        marker: Marker,
        /// The block of the other catalogue.
        neighbour: Marker,
        /// What that block was before the write.
        was: Classification,
        /// What it is after.
        now: Classification,
    },
    /// The write returned a document where the passage is still recognised.
    /// Reporting the entry as removed would leave a machine that believes
    /// itself clean.
    StillPresent {
        /// The marker still recognised.
        marker: Marker,
        /// The document.
        address: String,
    },
}

impl fmt::Display for RemoveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound { marker, address } => write!(
                f,
                "`{address}` carries no passage of `{marker}`, and the product does not guess at \
                 bytes to remove"
            ),
            Self::NotSeparable {
                marker,
                address,
                classification,
            } => write!(
                f,
                "`{address}`: the delimiters of `{marker}` do not describe one single passage \
                 ({classification:?}), and nothing says which bytes the product owns"
            ),
            Self::ValuesLost { marker, lost } => {
                write!(
                    f,
                    "removing `{marker}` made {} value(s) disappear that its trace does not \
                     record —",
                    lost.len()
                )?;
                for value in lost {
                    write!(f, " {value}")?;
                }
                write!(
                    f,
                    ". The transaction aborts: what the input checks said is what we thought we \
                     understood, and this is what the write did"
                )
            }
            Self::NeighbourBroken {
                marker,
                neighbour,
                was,
                now,
            } => write!(
                f,
                "removing `{marker}` would leave the block of `{neighbour}` {now:?} where it was \
                 {was:?}. A delimiter carries no value, so the check above cannot see it go — and \
                 a block whose delimiters no longer pair up belongs to nobody and can never be \
                 removed. The transaction aborts"
            ),
            Self::StillPresent { marker, address } => write!(
                f,
                "after the write, `{address}` still carries the passage of `{marker}` — reporting \
                 this entry as removed would leave a machine that believes itself clean"
            ),
        }
    }
}

impl std::error::Error for RemoveError {}

/// Removes the passage the trace describes, and refuses if the write destroyed
/// anything the trace does not record.
pub fn remove(source: &str, trace: &BlockTrace) -> Result<Removed, RemoveError> {
    remove_by(source, trace, excise)
}

/// The same removal, with the excision supplied by the caller.
///
/// **Why this seam exists.** C3 demands that the failure be observed **on the
/// output** and never deduced from the success of the input checks. A test can
/// only show that by handing in a write that every input check accepts and that
/// destroys something anyway — which is what a real defect looks like, and what
/// no fixture can otherwise reproduce. Production goes through [`remove`],
/// which supplies the excision this module writes.
pub fn remove_by(
    source: &str,
    trace: &BlockTrace,
    excise: impl Fn(&str, &Range<usize>) -> String,
) -> Result<Removed, RemoveError> {
    let before = read(source, &trace.address, &trace.marker);
    let bounds = match &before.recognition {
        Recognition::Unique { bounds, .. } => bounds.clone(),
        Recognition::Absent => {
            return Err(RemoveError::NotFound {
                marker: trace.marker.clone(),
                address: trace.address.clone(),
            })
        }
        Recognition::Duplicated { .. } | Recognition::Unbalanced { .. } => {
            return Err(RemoveError::NotSeparable {
                marker: trace.marker.clone(),
                address: trace.address.clone(),
                classification: before.recognition.classification(),
            })
        }
    };

    let rendered = excise(source, &bounds);

    // The post-condition, and it bears on the rendering rather than on
    // anything decided above. Reading it back with the **same** recogniser is
    // what makes the comparison mean something: a second reader could agree
    // with the write while both were wrong.
    let after = read(&rendered, &trace.address, &trace.marker);

    let before_values = all_values(&before);
    let after_values = all_values(&after);
    let disappeared = values_lost(&before_values, &after_values);
    // What the trace records is subtracted from what disappeared: the passage
    // is supposed to go, and only what goes beyond it is a destruction.
    let lost = values_lost(&disappeared, &trace.recorded_values());
    if !lost.is_empty() {
        return Err(RemoveError::ValuesLost {
            marker: trace.marker.clone(),
            lost,
        });
    }

    if let Some((neighbour, was, now)) =
        neighbour_broken(&before, source, &rendered, &trace.address, &trace.marker)
    {
        return Err(RemoveError::NeighbourBroken {
            marker: trace.marker.clone(),
            neighbour,
            was,
            now,
        });
    }

    // Naming a destroyed value comes first, because that is what its owner
    // recognises. A passage still standing comes last, and it is the other half
    // of the same post-condition.
    if after.recognition.classification() != Classification::Absent {
        return Err(RemoveError::StillPresent {
            marker: trace.marker.clone(),
            address: trace.address.clone(),
        });
    }

    Ok(Removed { rendered })
}

/// Every value the document carries, wherever it lives. The multiset the
/// post-condition compares must not depend on the bounds, or moving a bound
/// would look like a loss.
fn all_values(reading: &Reading) -> Vec<SemanticValue> {
    let mut values = reading.outside.clone();
    values.extend(reading.inside.iter().cloned());
    values
}

/// The excision production uses: the owned bytes, and nothing else.
fn excise(source: &str, bounds: &Range<usize>) -> String {
    let mut rendered = String::with_capacity(source.len());
    rendered.push_str(&source[..bounds.start]);
    rendered.push_str(&source[bounds.end..]);
    rendered
}

/// Renders the block the pose writes, delimiters included.
fn render_block(marker: &Marker, wrapping: Wrapping, body: &[&str], eol: &str) -> String {
    let mut block = String::new();
    block.push_str(&wrapping.render(&marker.open(), eol));
    block.push_str(eol);
    for line in body {
        block.push_str(line);
        block.push_str(eol);
    }
    block.push_str(&wrapping.render(&marker.close(), eol));
    block.push_str(eol);
    block
}

/// The line ending the document uses. Writing LF into a document in CRLF would
/// be exactly the reformatting C1 forbids, on the lines the product adds.
fn line_ending(source: &str) -> &'static str {
    if source.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}
