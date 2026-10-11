"""Dependencies between roadmap stages, from what the Markdown states (or config.json).

    ### Phase 5 — Redis queue
    - **Dependencies:** P2. The API fast path needs P4.        -> needs phase 2; phase 4 qualified
    - **Dependencies:** P4, P6. Can run in parallel with P7.   -> needs 4 and 6; parallel with 7
    - **Dependencies:** All prior phases.                       -> every earlier stage
    - **Dependencies:** None.                                   -> known to have none

Only a labeled line counts (Dependencies / Depends on / Requires / Prerequisites / Blocked by).
Its first sentence lists what the stage needs. A later sentence that names stages with "needs",
"requires" or "after" adds a qualified dependency (it applies to part of the stage). A sentence
about running "in parallel" lists parallel stages, never dependencies. Stages are referred to as
"P3", "Phase 3", "Stage 3", "Step 3", or by their exact title. Nothing is guessed: a stage
without such a line has unknown dependencies.

Adds to model["roadmap"]:
    dependencies {stage: [{id, line, source, qualified?}]}   only stages whose dependencies are known
    parallel     {stage: [stage]}
    cycles       [[stage, ...]]
"""
import re

from highlights import strip_md

DEP_LABEL_RE = re.compile(
    r"^(?:\*\*|__)?(dependencies|dependency|depends on|requires|prerequisites?|blocked by)(?:\*\*|__)?\s*:(?:\*\*|__)?\s*(.*)$",
    re.I | re.S)
NUMBER_RE = re.compile(r"\b(?:phase|stage|step|sprint|milestone|iteration|wave|part|week)\s*(\d+)\b|^\s*(\d+)[.):]?\s", re.I)
REF_RE = re.compile(r"\b(?:P|(?:phase|stage|step|sprint|week)\s*)(\d+)(?:\s*[–-]\s*(?:P|(?:phase|stage|step)\s*)?(\d+))?\b", re.I)
NONE_RE = re.compile(r"^(none|n/?a|nothing|no dependencies|-|—)\.?$", re.I)
ALL_PRIOR_RE = re.compile(r"\ball (?:the )?(?:prior|previous|earlier|preceding|other) (?:phases|stages|steps)\b", re.I)
NEEDS_RE = re.compile(r"\b(needs?|requires?|depends?|after|blocked)\b", re.I)


def stage_number(title):
    m = NUMBER_RE.search(strip_md(title))
    return int(m[1] or m[2]) if m else None


def _dep_lines(node):
    """(text, line) of each labeled dependency line in a stage (paragraphs and top-level bullets)."""
    for b in node["blocks"]:
        if b["type"] == "p" and (m := DEP_LABEL_RE.match(b["text"])):
            yield m[2], b.get("line")
        elif b["type"] == "list":
            for it in b["items"]:
                if m := DEP_LABEL_RE.match(it["text"]):
                    yield m[2], it.get("line")


def _refs(sentence, stage, ids, by_number, by_title, warnings):
    out = []
    for m in REF_RE.finditer(sentence):
        lo = int(m[1])
        hi = int(m[2]) if m[2] else lo
        for n in range(lo, hi + 1):
            target = by_number.get(n)
            if target is None:
                warnings.append(f"roadmap: '{stage}' refers to stage {n}, which is not a roadmap stage")
            elif target != stage:
                out.append(target)
    if ALL_PRIOR_RE.search(sentence):
        out += ids[:ids.index(stage)]
    for part in re.split(r",|\band\b", strip_md(sentence)):
        target = by_title.get(part.strip(" .").lower())
        if target and target != stage:
            out.append(target)
    return list(dict.fromkeys(out))


def add_dependencies(model, config):
    """Fill model["roadmap"] with dependencies, parallel stages and cycles. Returns warnings."""
    roadmap, warnings = model["roadmap"], []
    ids = roadmap["ids"]
    nodes = {s["id"]: s for s in model["sections"]}
    nodes.update({sub["id"]: sub for s in model["sections"] for sub in s["subsections"]})
    by_number = {}
    for i in ids:
        n = stage_number(nodes[i]["title"])
        if n is not None:
            if n in by_number:
                warnings.append(f"roadmap: two stages are numbered {n}; references to {n} are ignored")
                by_number[n] = None
            else:
                by_number[n] = i
    by_number = {n: i for n, i in by_number.items() if i}
    by_title = {re.sub(r"^.*?(?:\d+\s*[—–:.-]\s*)", "", strip_md(nodes[i]["title"])).lower(): i for i in ids}

    deps, parallel = {}, {}
    for stage in ids:
        for text, line in _dep_lines(nodes[stage]):
            found, understood = [], False
            sentences = [s for s in re.split(r"(?<=[.;])\s+", text.strip()) if s]
            for k, sentence in enumerate(sentences):
                if NONE_RE.match(strip_md(sentence)):
                    understood = understood or k == 0
                    continue
                refs = _refs(sentence, stage, ids, by_number, by_title, warnings)
                understood = understood or (k == 0 and bool(refs))
                if re.search(r"\bparallel\b", sentence, re.I):
                    parallel.setdefault(stage, []).extend(r for r in refs if r not in parallel.get(stage, []))
                elif k == 0:
                    found += [{"id": r, "line": line, "source": "document"} for r in refs]
                elif refs and NEEDS_RE.search(sentence):
                    found += [{"id": r, "line": line, "source": "document", "qualified": sentence}
                              for r in refs if r not in [d["id"] for d in found]]
            if understood:
                deps.setdefault(stage, []).extend(d for d in found if d["id"] not in [x["id"] for x in deps[stage]])
            else:  # "Dependencies: the auth work, probably" names no stage: unknown, not "none"
                warnings.append(f"roadmap: could not tell which stages '{stage}' depends on from {text.strip()!r}; "
                                f"set config 'dependencies' if it matters")

    # config.json "dependencies" (written by Claude) replaces what was found for that stage.
    for stage, needs in (config.get("dependencies") or {}).items():
        if stage in ids:
            deps[stage] = [{"id": r, "source": "config"} for r in needs if r in ids and r != stage]

    roadmap["dependencies"] = deps
    roadmap["parallel"] = parallel
    roadmap["cycles"] = find_cycles({s: [d["id"] for d in ds if "qualified" not in d] for s, ds in deps.items()})
    for c in roadmap["cycles"]:
        warnings.append(f"roadmap: dependency cycle {' -> '.join(c + [c[0]])}; these stages are shown without a status")
    return warnings


def find_cycles(graph):
    """Each cycle once, as a list of stage ids."""
    cycles, state, stack = [], {}, []

    def visit(n):
        state[n] = 1
        stack.append(n)
        for m in graph.get(n, []):
            if state.get(m) == 1:
                cyc = stack[stack.index(m):]
                if sorted(cyc) not in [sorted(c) for c in cycles]:
                    cycles.append(cyc)
            elif not state.get(m):
                visit(m)
        stack.pop()
        state[n] = 2

    for n in graph:
        if not state.get(n):
            visit(n)
    return cycles
