"""Highlights: decisions, risks, questions, assumptions, milestones... as structured entries.

Deterministic and conservative. Only explicit labels make a highlight:

    Decision: Use PostgreSQL.                  **Decision 3 — Short leases.**
    **Risk:** Redis loses data.                ### Decision 2: Fenced claims
    > [!WARNING] ...                           a bullet under a "Risks" / "Open questions" heading

Text that describes a highlight stays with it instead of becoming a highlight of its own:
"Rejected:" alternatives, "Tradeoff:", "Rationale:" and similar labels attach to the decision
they follow. When nothing explicit ties text to a highlight, it is left alone (it is still in the
Document view). Every entry keeps its original blocks, so no content is lost.

Entry: {kind, title, number?, body?, details: [{label, text, line}], rejected: [{text, line}],
        blocks, at, section, line, from_heading?}
"""
import re

KINDS = "decision|risk|warning|caution|question|note|tip|important|assumption|milestone"
# "Decision: ...", "**Risk:** ...", "Open question: ...", "**Decision 3 — title.**" (a dash only with a number).
CALLOUT_RE = re.compile(
    rf"^(\*\*|__)?(?:[^\w\s*_]\s*)?(?:open |key )?({KINDS})s?(?:\s+(\d+))?(\*\*|__)?\s*(:|[—–]|-(?=\s))\s*(\*\*|__)?\s*(.*)$",
    re.I | re.S)
ALERT_RE = re.compile(rf"^\[!({KINDS})\]\s*(.*)$", re.I)
# A section titled "Risks" or "Open Questions" turns its top-level bullets into highlights.
# Only when the title is about that kind: it starts with the word, or uses the plural.
SECTION_KIND_RE = re.compile(
    r"^(?:open |key )?(decision|risk|question|assumption|milestone)s?\b|\b(decision|risk|question|assumption|milestone)s\b", re.I)
# "... done. **Milestone:** M1 alpha." - a bold label later in a sentence-separated text.
INLINE_RE = re.compile(rf"(?<=[.!?]\s)(\*\*|__)({KINDS})(?:\s+(\d+))?:\1\s*(.+?)(?=\s+(?:\*\*|__)[A-Z][\w /-]*:(?:\*\*|__)|$)", re.I | re.S)
# A heading that is one highlight, ADR style: "## Decision", "## Decision outcome".
SINGLE_HEADING_RE = re.compile(r"^(decision|decision outcome|risk|assumption)$", re.I)

# Labels that describe the highlight above them. canonical name -> pattern.
ATTRS = {
    "rejected": r"rejected(?: alternatives?| options?)?|alternatives(?: considered)?|considered (?:options|alternatives)|not chosen",
    "tradeoff": r"trade-?offs?",
    "rationale": r"rationale|why|reason(?:ing)?",
    "consequences": r"consequences?",
    "context": r"context",
    "status": r"status",
    "mitigation": r"mitigations?|mitigated by",
    "contingency": r"contingency|fallback",
    "likelihood": r"likelihood|probability",
    "impact": r"impact|severity",
    "owner": r"owner",
    "answer": r"answer|resolution|resolved",
}
_ATTR_ALT = "|".join(f"(?P<{k}>{v})" for k, v in ATTRS.items())
# A label counts at the start of the text or right after the end of a sentence ("... index.** Tradeoff: ...").
LABEL_RE = re.compile(
    rf"(?:^|(?<=[.!?:;)*_`]\s))(?:\*\*|__)?(?:{_ATTR_ALT})(?:\*\*|__)?\s*:(?:\*\*|__)?[ \t]*", re.I)


def match_callout(text):
    """(kind, rest, number) for 'Risk: rest', '**Decision 3 — rest**', ...; else None."""
    m = CALLOUT_RE.match(text)
    if not m or (m[5] not in ":" and not m[3]):  # "Note - x" is prose; "Decision 3 — x" is a label
        return None
    rest = m[7]
    if m[1] and not (m[4] or m[6]):  # "**Milestone 1: title.** more": keep the bold on "title."
        rest = m[1] + rest
    return m[2].lower(), rest, int(m[3]) if m[3] else None


def section_kind(title):
    if match_callout(title):
        return None  # "Decision 2: Fenced claims" is one decision, not a list of them
    m = SECTION_KIND_RE.search(strip_md(title))
    return (m[1] or m[2]).lower() if m else None


def heading_entry_kind(title):
    """'Decision 2: Fenced claims' or ADR '## Decision' -> (kind, title text, number); else None."""
    c = match_callout(title)
    if c:
        return c
    m = SINGLE_HEADING_RE.match(strip_md(title))
    return (m[1].split()[0].lower(), "", None) if m else None


def strip_md(text):
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", text)
    return re.sub(r"[*_`~]", "", text).strip()


def split_labels(text):
    """'Lead. Tradeoff: x. **Rejected:** y' -> ('Lead.', [('tradeoff', 'x.'), ('rejected', 'y')])."""
    matches = list(LABEL_RE.finditer(text))
    if not matches:
        return text.strip(), []
    segs = []
    for k, m in enumerate(matches):
        end = matches[k + 1].start() if k + 1 < len(matches) else len(text)
        segs.append((m.lastgroup, text[m.end():end].strip()))
    return text[:matches[0].start()].strip(), segs


def split_title(text):
    """'**Title.** more' -> ('Title.', 'more'); 'First sentence. More.' -> ('First sentence.', 'More.')."""
    text = text.strip()
    m = re.match(r"^(\*\*|__)(.+?)\1\s*(.*)$", text, re.S)
    if m:
        return m[2].strip(), m[3].strip()
    m = re.match(r"^(.+?[.!?])\s+(\S.*)$", text, re.S)
    return (m[1], m[2]) if m else (text, "")


class _Entry:
    """Collects one highlight while its blocks are being read."""

    def __init__(self, kind, at, sec, line, number=None, strong=False, level=None):
        self.d = {"kind": kind, "title": "", "details": [], "rejected": [], "blocks": [],
                  "at": at, "section": sec, "line": line}
        if number is not None:
            self.d["number"] = number
        self.strong = strong        # a heading, or numbered in its own section: unlabeled blocks after it belong to it
        self.level = level          # heading level, for a highlight that is a heading
        self.open_label = None      # a label waiting for its values in the next list ("Rejected:")
        self.body = []

    def add_text(self, text, line, lead_is_title=False):
        lead, segs = split_labels(text)
        if lead:
            if lead_is_title and not self.d["title"]:
                self.d["title"], rest = split_title(lead)
                if rest:
                    self.body.append({"type": "p", "text": rest, "line": line})
            else:
                self.body.append({"type": "p", "text": lead, "line": line})
        for label, value in segs:
            self.add_value(label, value, line)
        self.open_label = segs[-1][0] if segs and not segs[-1][1] else None

    def add_value(self, label, value, line):
        if not value:
            return
        if label == "rejected":
            self.d["rejected"].append({"text": value, "line": line})
        else:
            self.d["details"].append({"label": label, "text": value, "line": line})

    def add_list(self, block):
        for it in block["items"]:
            text = it["text"] + "".join(" " + c["text"] for c in it.get("children", []))
            self.add_value(self.open_label, text, it.get("line"))
        self.open_label = None

    def done(self):
        if self.body:
            self.d["body"] = self.body
        if not self.d["title"] and self.body and self.body[0]["type"] == "p":  # ADR heading: first sentence
            self.d["title"], rest = split_title(self.body[0]["text"])
            self.body[0] = {**self.body[0], "text": rest}
            if not rest:
                self.body.pop(0)
            if not self.body:
                self.d.pop("body")
        return self.d


def extract_section(title, blocks, at, sec, parent_kind=None, line=None):
    """Highlights of one section or subsection, given its heading title."""
    hk = heading_entry_kind(title)
    if hk:  # the heading itself is the highlight; its content describes it
        entry = _Entry(hk[0], at, sec, line, hk[2], strong=True)
        entry.d["title"] = hk[1]
        rest = extract(blocks, at, sec, None, entry)
        return [entry.done()] + rest
    return extract(blocks, at, sec, section_kind(title) or parent_kind)


def dedupe(entries):
    """The same statement found twice (same kind, line and title) is listed once."""
    seen, out = set(), []
    for e in entries:
        key = (e["kind"], e["line"], e["title"])
        if key not in seen:
            seen.add(key)
            out.append(e)
    return out


def _canonical(label):
    """A column header as a detail label: 'Mitigations' -> 'mitigation'; unknown headers as written."""
    label = label.strip()
    m = re.fullmatch(f"(?:{_ATTR_ALT})", label, re.I)
    return m.lastgroup if m else label.lower() or "detail"


def _starts_with_label(text):
    m = LABEL_RE.match(text)
    return m.start() == 0 if m else False


def extract(blocks, at, sec, kind=None, entry=None):
    """Highlights in a section's blocks, in document order.
    kind: the section's kind ("Risks" heading -> "risk"), for its top-level bullets.
    entry: the highlight this whole section is (a "### Decision 2: ..." heading); the caller adds it."""
    out, section = [], kind
    # An explicitly labeled highlight of the section's kind means the bullets are not highlights
    # by themselves (they are parts of the labeled ones, e.g. "Rejected:" alternatives).
    if kind and any(b["type"] == "callout" and b["kind"] == kind for b in blocks):
        kind = None
    cur = entry
    for b in blocks:
        t = b["type"]
        starter = t == "callout" and not b.get("alert") and b["blocks"] and b["blocks"][0]["type"] == "p"
        heading = heading_entry_kind(b["text"]) if t == "heading" else None
        if cur is not None and cur is not entry:
            inside = t == "heading" and cur.level and b["level"] > cur.level and not heading
            if starter or heading or t == "hr" or (t == "heading" and not inside):
                out.append(cur.done())
                cur = None
        if starter:
            # "Decision 3 — ..." in a "Decisions" section: the unlabeled paragraphs after it explain it.
            strong = b.get("number") is not None and b["kind"] == section
            cur = _Entry(b["kind"], at, sec, b.get("line"), b.get("number"), strong=strong)
            cur.d["blocks"] += b["blocks"]
            cur.add_text(b["blocks"][0]["text"], b.get("line"), lead_is_title=True)
            for inner in b["blocks"][1:]:
                _attach(cur, inner)
            continue
        if heading:
            k, title, number = heading
            cur = _Entry(k, at, sec, b.get("line"), number, strong=True, level=b["level"])
            cur.d["title"] = title
            continue
        if cur is not None and _attach(cur, b):
            if t == "list":  # explicitly labeled bullets inside it are still highlights
                out += _items(b["items"], at, sec, None, True)
            continue
        if cur is not None and cur is not entry:
            out.append(cur.done())
            cur = None
        out += _inner(b, at, sec, kind)
    if cur is not None and cur is not entry:
        out.append(cur.done())
    return out


def _attach(cur, b):
    """Add block b to the open highlight if the source ties it there. Returns True if attached."""
    t = b["type"]
    if t == "p" and _starts_with_label(b["text"]):
        cur.d["blocks"].append(b)
        cur.add_text(b["text"], b.get("line"))
        return True
    if t == "list" and cur.open_label:
        cur.d["blocks"].append(b)
        cur.add_list(b)
        return True
    if cur.strong and (t in ("p", "list", "code", "table", "quote", "mermaid")
                       or (t == "heading" and cur.level and b["level"] > cur.level)):
        cur.d["blocks"].append(b)
        if t == "p":
            cur.add_text(b["text"], b.get("line"))
        else:
            cur.body.append(b)
        return True
    return False


def _inner(b, at, sec, kind):
    """Highlights inside a block that is not part of an open highlight."""
    t = b["type"]
    if t == "callout":  # GitHub alert "> [!WARNING]" (or a callout whose body is not a paragraph)
        e = _Entry(b["kind"], at, sec, b.get("line"))
        e.d["blocks"] = b["blocks"]
        first = next((x for x in b["blocks"] if x["type"] == "p"), None)
        if first:
            e.add_text(first["text"], first.get("line"), lead_is_title=True)
        return [e.done()] + [h for x in b["blocks"] if x is not first for h in _inner(x, at, sec, None)]
    if t == "quote":
        return extract(b["blocks"], at, sec)
    if t == "list":
        return _items(b["items"], at, sec, kind, True)
    if t == "table":
        # under a "Risks" heading, or a table whose first column is "Risk", "Decision", ...
        head = re.fullmatch(rf"(?:open |key )?({KINDS})s?", strip_md(b["header"][0]).lower()) if b["header"] else None
        if kind or head:
            return _rows(b, at, sec, kind or head[1])
    if t == "p":
        return _inline(b["text"], b.get("line"), at, sec)
    return []


def _inline(text, line, at, sec):
    """'**Deliverables:** A platform. **Milestone:** M1 alpha.' -> a milestone highlight."""
    out = []
    for m in INLINE_RE.finditer(text):
        e = _Entry(m[2].lower(), at, sec, line, int(m[3]) if m[3] else None)
        e.d["blocks"] = [{"type": "p", "text": m[4].strip()}]
        e.add_text(m[4], line, lead_is_title=True)
        e.d["inline"] = True  # found inside other text, not at the start of a block
        out.append(e.done())
    return out


def _items(items, at, sec, kind, top_level):
    """Highlights in a list. A bullet that starts with a describing label ("Mitigation: ...")
    belongs to the highlight in the bullet right before it, not to a highlight of its own."""
    out, prev = [], None
    for it in items:
        item_kind = it.get("kind") or (kind if top_level else None)
        if prev is not None and not it.get("kind") and _starts_with_label(it["text"]):
            prev.d["blocks"].append({"type": "p", "text": it["text"]})
            prev.add_text(it["text"], it.get("line"))
            continue
        if prev is not None:
            out.append(prev.done())
            prev = None
        if item_kind:
            e = _Entry(item_kind, at, sec, it.get("line"), it.get("number"))
            e.d["blocks"] = [{"type": "p", "text": it["text"]}]
            if it.get("children"):
                e.d["blocks"].append({"type": "list", "items": it["children"]})
            e.add_text(it["text"], it.get("line"), lead_is_title=True)
            other = []
            for c in it.get("children", []):  # "- Risk: x" with "  - Mitigation: y" under it
                if not c.get("kind") and _starts_with_label(c["text"]):
                    e.add_text(c["text"], c.get("line"))
                else:
                    other.append(c)
            if other:
                e.body.append({"type": "list", "items": other})
            if not it.get("kind"):
                e.d["from_heading"] = True  # a highlight because of the section it sits in
            prev = e
        out += _inline(it["text"], it.get("line"), at, sec)
        out += _items(it.get("children", []), at, sec, kind, False)
        for x in it.get("blocks", []):
            out += _inner(x, at, sec, None)
    if prev is not None:
        out.append(prev.done())
    return out


def _rows(b, at, sec, kind):
    """A table under a "Decisions" / "Risks" heading: one highlight per row."""
    out = []
    for k, row in enumerate(b["rows"]):
        first = row[0] if row else ""
        bold = first.startswith(("**", "__"))
        text = (first if bold else f"**{first}**") + "".join(
            f" · {h + ': ' if len(row) > 2 and h else ''}{c}" for h, c in zip(b["header"][1:], row[1:]))
        e = _Entry(kind, at, sec, b["line"] + 2 + k)
        e.d["blocks"] = [{"type": "p", "text": text}]
        c = match_callout(first)
        title = c[1] if c else first
        m = re.fullmatch(r"(\*\*|__)(.+)\1", title.strip())
        e.d["title"] = m[2] if m else title
        for h, cell in zip(b["header"][1:], row[1:]):
            heads, cells = strip_md(h).split("/"), cell.split("/")
            if len(heads) > 1 and len(heads) == len(cells):  # "Likelihood / Impact" | "M / H"
                pairs = zip(heads, cells)
            else:
                pairs = [(strip_md(h), cell)]
            for label, value in pairs:
                if value.strip():
                    e.d["details"].append({"label": _canonical(label), "text": value.strip(), "line": e.d["line"]})
        e.d["from_heading"] = True
        out.append(e.done())
    return out
