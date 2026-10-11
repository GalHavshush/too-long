#!/usr/bin/env python3
"""too-long, step 1: Markdown -> content model.

The content model is plain dicts and lists (JSON-ready). Nothing from the
source is dropped: every non-blank line ends up in some block, so the
Document view can always show the whole file.

    python3 parse.py plan.md          # human-readable summary (Claude reads this)
    python3 parse.py plan.md --json   # the full model

Model shape:
    title, intro: [block], sections: [{id, title, blocks, subsections: [{id, title, blocks}]}]
    tasks, callouts, files, diagrams: indexes pointing back into sections by id ("at")
    roadmap: {ids, basis}, stats, source (the raw Markdown)

Block types: heading, p, list, code, mermaid, table, quote, callout, hr.
"""
import json
import re
import sys
from pathlib import Path

from highlights import ALERT_RE, dedupe, extract_section, match_callout, section_kind, strip_md

# ---------- line patterns ----------

FENCE_RE = re.compile(r"^\s*(`{3,}|~{3,})\s*([^`\s]*)")
HEADING_RE = re.compile(r"^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$")
HR_RE = re.compile(r"^\s{0,3}([-*_])(\s*\1){2,}\s*$")
SETEXT_RE = re.compile(r"^\s*(=+|-+)\s*$")
LIST_RE = re.compile(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$")
TASK_RE = re.compile(r"^\[([ xX])\]\s+(.*)$")
TABLE_SEP_RE = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")
# "[label]: https://url 'optional title'" - a link reference definition.
REF_DEF_RE = re.compile(r"""^\s{0,3}\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?\s*$""")

# Section titles that read like steps of a plan.
PHASE_RE = re.compile(
    r"^\s*(?:(?:phase|stage|step|milestone|sprint|week|day|iteration|wave|part)\b|v\d+\b|\d+[.):]?\s)", re.I)
# ...and only by a word, not just a number ("1. Executive summary" is a numbered section, not a phase).
PHASE_WORD_RE = re.compile(r"^\s*(?:\d+[.):]?\s+)?(?:phase|stage|step|milestone|sprint|week|day|iteration|wave)\s*\d", re.I)

# File references: a path with a known extension or a trailing slash, or a well-known filename.
EXTS = ("py|js|mjs|cjs|ts|tsx|jsx|json|jsonc|md|mdx|yml|yaml|toml|ini|cfg|conf|css|scss|sass|less|"
        "html|vue|svelte|astro|go|rs|rb|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|ps1|sql|"
        "prisma|graphql|gql|proto|tf|txt|csv|xml|lock|env|gradle|dart|ex|exs|lua|ipynb")
PATH_RE = re.compile(r"(?<![\w/.:@-])((?:\.{1,2}/|~/)?(?:[\w@.-]+/)+[\w@.-]*)")
NAME_RE = re.compile(rf"(?<![\w/.:@-])([\w@-][\w@.-]*\.(?:{EXTS})|Dockerfile|Makefile|Procfile|\.env(?:\.\w+)?|\.gitignore)(?![\w/-])")
EXT_RE = re.compile(rf"\.(?:{EXTS})$")
# ponytail: stoplist for library names that look like files; extend if false positives show up.
NOT_FILES = re.compile(r"^(node|next|vue|react|express|nuxt|three|d3|chart|p5|alpine|ember|angular|solid|deno|socket|backbone)\.js$", re.I)


# ---------- block parsing ----------

def indent_of(s):
    return len(s.expandtabs(4)) - len(s.expandtabs(4).lstrip())


def dedent(line, n):
    return line[min(indent_of(line), n):]


def is_block_start(line):
    return bool(FENCE_RE.match(line) or HEADING_RE.match(line) or HR_RE.match(line)
                or LIST_RE.match(line) or line.lstrip().startswith(">"))


def text_block(text):
    """A paragraph, or a callout if it starts with 'Decision:', 'Risk:', ..."""
    c = match_callout(text)
    if c:
        block = {"type": "callout", "kind": c[0], "blocks": [{"type": "p", "text": c[1]}]}
        if c[2] is not None:
            block["number"] = c[2]  # "Decision 3 — ..."
        return block
    return {"type": "p", "text": text}


def parse_blocks(lines, base=0):
    """base: how many source lines come before lines[0], so every block gets its 1-based source `line`."""
    blocks, i = [], 0
    while i < len(lines):
        line, start, count = lines[i], i, len(blocks)
        if not line.strip():
            i += 1
        elif m := FENCE_RE.match(line):
            i, b = parse_fence(lines, i, m)
            blocks.append(b)
        elif m := HEADING_RE.match(line):
            blocks.append({"type": "heading", "level": len(m[1]), "text": m[2]})
            i += 1
        elif HR_RE.match(line):
            blocks.append({"type": "hr"})
            i += 1
        elif LIST_RE.match(line):
            i, b = parse_list(lines, i, base)
            blocks.append(b)
        elif line.lstrip().startswith(">"):
            i, b = parse_quote(lines, i, base)
            blocks.append(b)
        elif "|" in line and i + 1 < len(lines) and TABLE_SEP_RE.match(lines[i + 1]):
            i, b = parse_table(lines, i)
            blocks.append(b)
        elif indent_of(line) >= 4:  # indented code (it can't interrupt a paragraph, so it starts a block here)
            i, b = parse_indented_code(lines, i)
            blocks.append(b)
        else:
            i, b = parse_paragraph(lines, i)
            blocks.append(b)
        if len(blocks) > count:
            blocks[-1]["line"] = base + start + 1
    return blocks


def parse_fence(lines, i, m):
    fence, lang = m[1], m[2]
    indent = indent_of(lines[i])
    close = re.compile(rf"^\s*{re.escape(fence[0])}{{{len(fence)},}}\s*$")
    body = []
    i += 1
    while i < len(lines) and not close.match(lines[i]):
        body.append(dedent(lines[i], indent))
        i += 1
    kind = "mermaid" if lang.lower() == "mermaid" else "code"
    block = {"type": kind, "lang": lang, "text": "\n".join(body)}
    if i >= len(lines):
        block["unclosed"] = True  # runs to the end of the document, as in CommonMark
    return i + 1, block


def parse_indented_code(lines, i):
    body = []
    while i < len(lines) and (indent_of(lines[i]) >= 4 or not lines[i].strip()):
        body.append(dedent(lines[i], 4))
        i += 1
    while body and not body[-1].strip():
        body.pop()
    return i, {"type": "code", "lang": "", "text": "\n".join(body)}


def parse_paragraph(lines, i):
    buf = []
    while i < len(lines) and lines[i].strip():
        line = lines[i]
        if buf and SETEXT_RE.match(line):  # "Title\n=====" style heading
            return i + 1, {"type": "heading", "level": 1 if "=" in line else 2, "text": " ".join(buf)}
        if buf and (is_block_start(line) or ("|" in line and i + 1 < len(lines) and TABLE_SEP_RE.match(lines[i + 1]))):
            break
        buf.append(line.strip())
        i += 1
    return i, text_block(" ".join(buf))


def parse_quote(lines, i, base):
    first, inner = i, []
    while i < len(lines) and lines[i].lstrip().startswith(">"):
        inner.append(re.sub(r"^\s*> ?", "", lines[i]))
        i += 1
    m = ALERT_RE.match(inner[0].strip())
    if m:  # GitHub alert: > [!WARNING]
        return i, {"type": "callout", "kind": m[1].lower(), "alert": True,
                   "blocks": parse_blocks([m[2]] + inner[1:], base + first)}
    blocks = parse_blocks(inner, base + first)
    if len(blocks) == 1 and blocks[0]["type"] == "callout":
        return i, blocks[0]
    return i, {"type": "quote", "blocks": blocks}


def split_row(line):
    """Cells of a table row. `\\|` and pipes inside `code spans` are part of a cell."""
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|") and not line.endswith("\\|"):
        line = line[:-1]
    cells, cur, tick, k = [], "", 0, 0
    while k < len(line):
        c = line[k]
        if c == "\\" and line[k + 1:k + 2] == "|":
            cur, k = cur + "|", k + 2
            continue
        if c == "`":
            run = len(line[k:]) - len(line[k:].lstrip("`"))
            tick = 0 if tick == run else (tick or run)
            cur, k = cur + "`" * run, k + run
            continue
        if c == "|" and not tick:
            cells.append(cur.strip())
            cur = ""
        else:
            cur += c
        k += 1
    return cells + [cur.strip()]


def parse_table(lines, i):
    header, rows = split_row(lines[i]), []
    i += 2
    while i < len(lines) and lines[i].strip() and "|" in lines[i]:
        rows.append(split_row(lines[i]))
        i += 1
    return i, {"type": "table", "header": header, "rows": rows}


def make_item(marker, text):
    item = {"text": text, "ordered": marker[0].isdigit()}
    if item["ordered"]:
        item["n"] = int(re.match(r"\d+", marker)[0])
    if m := TASK_RE.match(item["text"]):
        item["task"] = m[1] != " "
        item["text"] = m[2]
    if c := match_callout(item["text"]):
        item["kind"], item["text"] = c[0], c[1]
        if c[2] is not None:
            item["number"] = c[2]
    return item


def add_text(item, text, new_para, line):
    """Continuation line of a list item: extend its text or start a paragraph inside it."""
    blocks = item.get("blocks")
    if new_para or (blocks and blocks[-1]["type"] != "p"):
        item.setdefault("blocks", []).append({"type": "p", "text": text, "line": line})
    elif blocks:
        blocks[-1]["text"] += " " + text
    else:
        item["text"] += " " + text


def parse_list(lines, i, base=0):
    """Nested lists by indentation (base: source line offset, as in parse_blocks). Items: {text, ordered, n?, task?, kind?, children?, blocks?}."""
    indent = indent_of(LIST_RE.match(lines[i])[1])
    items = []
    stack = [(indent, items)]  # (indent of the items in this list, the list)
    last, after_blank = None, False
    while i < len(lines):
        line = lines[i]
        m = LIST_RE.match(line)
        if m and not HR_RE.match(line):
            d = indent_of(m[1])
            if d <= indent and items and items[0]["ordered"] != m[2][0].isdigit():
                break  # "-" list followed by "1." list: two separate lists
            if d >= stack[-1][0] + 2 and last is not None:
                last["children"] = []
                stack.append((d, last["children"]))
            else:
                while len(stack) > 1 and d < stack[-1][0]:
                    stack.pop()
            last = make_item(m[2], m[3])
            last["line"] = base + i + 1
            stack[-1][1].append(last)
            after_blank = False
            i += 1
        elif not line.strip():
            j = i + 1
            while j < len(lines) and not lines[j].strip():
                j += 1
            nxt = lines[j] if j < len(lines) else ""
            if (LIST_RE.match(nxt) and not HR_RE.match(nxt)) or indent_of(nxt) > indent:
                after_blank, i = True, j
            else:
                break
        elif indent_of(line) > indent and (fm := FENCE_RE.match(line)):
            b_line = base + i + 1
            i, b = parse_fence(lines, i, fm)
            b["line"] = b_line
            last.setdefault("blocks", []).append(b)
            after_blank = False
        elif indent_of(line) > indent or (not after_blank and not is_block_start(line)):
            add_text(last, line.strip(), after_blank, base + i + 1)
            after_blank = False
            i += 1
        else:
            break
    return i, {"type": "list", "items": items}


def take_ref_defs(lines):
    """Pull out "[label]: url" definitions (outside code fences). They become model["refs"];
    the line is left blank so the rest of the document keeps its shape."""
    refs, out, fence = {}, [], None
    for line in lines:
        m = FENCE_RE.match(line)
        if m and (fence is None or line.strip().startswith(fence)):
            fence = m[1][0] * 3 if fence is None else None
        d = None if fence or (m and fence is None) else REF_DEF_RE.match(line)
        if d:
            title = d[3] or d[4] or d[5]
            refs.setdefault(d[1].strip().lower(), {"url": d[2], **({"title": title} if title else {})})
            out.append("")
        else:
            out.append(line)
    return out, refs


# ---------- content model ----------

def slugify(text, used):
    base = re.sub(r"[^\w\s-]", "", strip_md(text).lower()).strip()
    base = re.sub(r"[\s_-]+", "-", base)[:60].strip("-") or "section"
    slug, n = base, 2
    while slug in used:
        slug, n = f"{base}-{n}", n + 1
    used.add(slug)
    return slug


BRACE_RE = re.compile(r"([\w@./-]*/[\w@.-]*)\{([^{}\s,][^{}]*,[^{}]*)\}([\w@.-]*)")


def expand_braces(text):
    """'src/app/{main,cli}.py' -> 'src/app/main.py src/app/cli.py' (shell-style shorthand in plans)."""
    return BRACE_RE.sub(lambda m: " ".join(m[1] + part.strip() + m[3] for part in m[2].split(",")), text)


def find_files(text):
    text = expand_braces(re.sub(r"https?://\S+", " ", text))
    found = [p for p in PATH_RE.findall(text) if p.endswith("/") or EXT_RE.search(p)]
    found += [n for n in NAME_RE.findall(text) if not NOT_FILES.match(n)]
    return [re.sub(r"^\./", "", p) for p in found]


def file_index(files):
    """{path: [(at, line)]} -> model["files"]. A shortened reference ("config.py", "db/models.py") is
    merged into the one longer path it ends with ("src/app/config.py") and listed in its `aliases`.
    When it could be several files, it stays separate with those `candidates`."""
    paths = sorted(files)
    alias_of, candidates = {}, {}
    for p in paths:
        if p.startswith(("../", "~/", "/")):
            continue
        longer = [q for q in paths if q != p and q.endswith("/" + p)]
        longest = [q for q in longer if not any(r != q and r.endswith("/" + q) for r in longer)]
        if len(longest) == 1:
            alias_of[p] = longest[0]
        elif longest:
            candidates[p] = longest
    merged = {}
    for p in paths:
        target = alias_of.get(p, p)
        entry = merged.setdefault(target, {"path": target, "mentions": [], "aliases": []})
        entry["mentions"] += [{"at": a, "line": n} for a, n in files[p]]
        if p != target:
            entry["aliases"].append(p)
    out = []
    for p in sorted(merged):
        e = merged[p]
        e["mentions"].sort(key=lambda m: m["line"])
        # at: where each file is mentioned (section ids); mentions: the same, with source lines
        f = {"path": p, "at": list(dict.fromkeys(m["at"] for m in e["mentions"])), "mentions": e["mentions"]}
        if e["aliases"]:
            f["aliases"] = e["aliases"]
        if p in candidates:
            f["candidates"] = candidates[p]
        out.append(f)
    return out


def build_model(md, name="document", track=()):
    """track: section ids whose top-level numbered items should be tracked as tasks."""
    lines = md.splitlines()
    front, warnings, offset = [], [], 0
    if lines and lines[0].strip() == "---":  # YAML front matter: keep it, as a code block
        end = next((k for k in range(1, len(lines)) if lines[k].strip() in ("---", "...")), None)
        if end:
            front = [{"type": "code", "lang": "yaml", "label": "Front matter", "text": "\n".join(lines[1:end]), "line": 1}]
            lines, offset = lines[end + 1:], end + 1
        else:
            warnings.append("front matter '---' on the first line is never closed; it is shown as text")
    lines, refs = take_ref_defs(lines)
    blocks = front + parse_blocks(lines, offset)

    # Heading levels: a single H1 is the title; the next level used is "section", the one below "subsection".
    headings = [b for b in blocks if b["type"] == "heading"]
    h1s = [b for b in headings if b["level"] == 1]
    title_block = h1s[0] if len(h1s) == 1 else None
    top = min((b["level"] for b in headings if b is not title_block), default=2)

    used = {"intro"}
    intro, sections = [], []
    container = intro
    for b in blocks:
        if b is title_block:
            continue
        if b["type"] == "heading" and b["level"] <= top + 1:
            node = {"id": slugify(b["text"], used), "title": b["text"], "line": b["line"], "blocks": []}
            if b["level"] == top or not sections:
                node["subsections"] = []
                sections.append(node)
            else:
                sections[-1]["subsections"].append(node)
            container = node["blocks"]
        else:
            container.append(b)

    # Indexes. Every entry points back to where it lives: at = section/subsection id, section = top-level id.
    tasks, diagrams, files = [], [], {}
    task_ids = set()
    code_blocks = 0

    def note_files(text, at, line):
        for p in find_files(text):
            mentions = files.setdefault(p, [])
            if (at, line) not in mentions:
                mentions.append((at, line))

    def walk(blocks, at, sec, line=None):
        """Tasks, files and diagrams. line: the enclosing block's line, for inner blocks without one."""
        nonlocal code_blocks
        for b in blocks:
            t = b["type"]
            b_line = b.get("line", line)
            if t in ("p", "heading"):
                note_files(b["text"], at, b_line)
            elif t == "list":
                walk_items(b["items"], at, sec, True)
            elif t == "table":
                for cell in b["header"]:
                    note_files(cell, at, b["line"])
                for k, row in enumerate(b["rows"]):  # row k is source line table + 2 + k
                    for cell in row:
                        note_files(cell, at, b["line"] + 2 + k)
            elif t in ("quote", "callout"):
                walk(b["blocks"], at, sec, b_line)
            elif t == "mermaid":
                diagrams.append({"text": b["text"], "at": at, "section": sec, "line": b["line"]})
            elif t == "code":
                code_blocks += 1
            if b.get("unclosed"):
                warnings.append(f"the code fence on line {b['line']} is never closed; everything after it is shown as code")

    def walk_items(items, at, sec, top_level):
        for it in items:
            note_files(it["text"], at, it["line"])
            browser_only = False
            if top_level and it["ordered"] and "task" not in it and (at in track or sec in track):
                it["task"] = False  # a numbered step the reader asked to track (config "track")
                browser_only = True  # no checkbox in the Markdown, so its state can only live in the viewer
            if "task" in it:
                it["id"] = slugify(f"t-{at}-{it['text'][:40]}", task_ids)
                tasks.append({"id": it["id"], "text": it["text"], "done": it["task"], "at": at, "section": sec,
                              "n": it.get("n"), "line": it["line"], "browser_only": browser_only})
            walk_items(it.get("children", []), at, sec, False)
            walk(it.get("blocks", []), at, sec, it["line"])

    walk(intro, "intro", "intro")
    for s in sections:
        walk(s["blocks"], s["id"], s["id"])
        for sub in s["subsections"]:
            walk(sub["blocks"], sub["id"], s["id"])

    # Highlights (decisions, risks, questions...): see highlights.py.
    callouts = extract_section("", intro, "intro", "intro")
    for s in sections:
        callouts += extract_section(s["title"], s["blocks"], s["id"], s["id"], line=s["line"])
        for sub in s["subsections"]:
            callouts += extract_section(sub["title"], sub["blocks"], sub["id"], s["id"], section_kind(s["title"]), sub["line"])
    callouts = dedupe(callouts)

    # Stages: phase-like section titles. When the phases are subsections ("## 14. Roadmap" holding
    # "### Phase 1 — ..."), those win over numbered top-level sections.
    phases = [s["id"] for s in sections if PHASE_RE.search(strip_md(s["title"]))]
    named = [s["id"] for s in sections if PHASE_WORD_RE.search(strip_md(s["title"]))]
    sub_phases = [x["id"] for s in sections for x in s["subsections"] if PHASE_WORD_RE.search(strip_md(x["title"]))]
    if len(sub_phases) >= 2 and len(named) < 2:
        phases = sub_phases
    roadmap = ({"ids": phases, "basis": "titles"} if len(phases) >= 2
               else {"ids": [s["id"] for s in sections], "basis": "sections"})

    return {
        "title": strip_md(title_block["text"]) if title_block else re.sub(r"[-_]+", " ", name).strip().title(),
        "file": name,
        "intro": intro,
        "sections": sections,
        "tasks": tasks,
        "callouts": callouts,
        "diagrams": diagrams,
        "files": file_index(files),
        "refs": refs,
        "warnings": warnings,
        "roadmap": roadmap,
        "stats": {"words": len(re.findall(r"\w+", md)), "code_blocks": code_blocks},
        "source": md,
    }


def section_ids(model):
    """Every id a config, storyboard or link may cite: intro, sections, subsections."""
    return {"intro"} | {s["id"] for s in model["sections"]} | {
        sub["id"] for s in model["sections"] for sub in s["subsections"]}


class InputError(ValueError):
    """The Markdown file can't be read. The message says what to do."""


def read_markdown(path):
    """(bytes, text) of a Markdown file; text has \\n line endings, like open() in text mode."""
    path = Path(path)
    if path.is_dir():
        raise InputError(f"{path} is a folder. Pass the Markdown file inside it, e.g. {path / 'plan.md'}")
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        raise InputError(f"{path}: no such file (relative paths start from {Path.cwd()})") from None
    except PermissionError:
        raise InputError(f"{path}: permission denied, cannot read it") from None
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as e:
        raise InputError(f"{path} is not UTF-8 text (invalid byte at position {e.start}). Re-save it as UTF-8, "
                         f"e.g. iconv -f latin1 -t utf-8 '{path}' > fixed.md") from None
    return data, text.replace("\r\n", "\n").replace("\r", "\n")


def parse_file(path, track=()):
    path = Path(path)
    model = build_model(read_markdown(path)[1], path.stem, track)
    model["file"] = path.name
    return model


def suggest_views(model):
    """A starting point only. Claude picks the real views from the user's goal."""
    views = ["overview", "document"]
    if model["roadmap"]["basis"] == "titles" or len(model["sections"]) >= 4:
        views.append("roadmap")
    if model["tasks"]:
        views.append("tasks")
    if model["callouts"]:
        views.append("highlights")
    if model["diagrams"]:
        views.append("diagrams")
    if len(model["files"]) >= 3:
        views.append("files")
    if len(model["sections"]) >= 3:
        views.append("steps")
    return views


def dependency_summary(model):
    """Which stages state their dependencies (so Claude knows whether config 'dependencies' is needed)."""
    from roadmap import add_dependencies  # imported here: roadmap imports highlights, which parse imports

    warnings = add_dependencies(model, {})
    r = model["roadmap"]
    if not r["dependencies"]:
        return ["Stage dependencies: none stated (the roadmap is shown in document order)"]
    return [f"Stage dependencies: stated for {len(r['dependencies'])} of {len(r['ids'])} stages"] + \
        [f"  {w}" for w in warnings]


def summary(model):
    done = sum(t["done"] for t in model["tasks"])
    kinds = {}
    for c in model["callouts"]:
        kinds[c["kind"]] = kinds.get(c["kind"], 0) + 1
    out = [
        f"Title: {model['title']}",
        f"Words: {model['stats']['words']} (~{max(1, model['stats']['words'] // 230)} min read)",
        f"Sections: {len(model['sections'])}  Tasks: {done}/{len(model['tasks'])} done  "
        f"Code blocks: {model['stats']['code_blocks']}  Mermaid: {len(model['diagrams'])}  Files: {len(model['files'])}",
        "Highlights: " + (", ".join(f"{k} {n}" for k, n in kinds.items()) or "none"),
        *[f"Warning: {w}" for w in model["warnings"]],
        "",
        "Section ids (use these in config notes / diagram sources):",
    ]
    for s in model["sections"]:
        n = [t for t in model["tasks"] if t["section"] == s["id"]]
        out.append(f"  {s['id']:<40} {strip_md(s['title'])}" + (f"  [{sum(t['done'] for t in n)}/{len(n)} tasks]" if n else ""))
        for sub in s["subsections"]:
            out.append(f"    {sub['id']:<38} {strip_md(sub['title'])}")
    out += [
        "",
        f"Roadmap basis: {model['roadmap']['basis']} ({len(model['roadmap']['ids'])} stages)",
        *dependency_summary(model),
        f"Files: {', '.join(f['path'] for f in model['files'][:15])}" + (" ..." if len(model["files"]) > 15 else ""),
        f"Suggested views: {', '.join(suggest_views(model))}",
    ]
    return "\n".join(out)


def main():
    args = [a for a in sys.argv[1:] if a != "--json"]
    if len(args) != 1:
        sys.exit("usage: parse.py FILE.md [--json]")
    try:
        m = parse_file(args[0])
    except InputError as e:
        sys.exit(str(e))
    print(json.dumps(m, indent=2, ensure_ascii=False) if "--json" in sys.argv else summary(m))


if __name__ == "__main__":
    main()
