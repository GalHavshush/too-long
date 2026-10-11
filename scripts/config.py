"""The config: views and everything Claude inferred (TL;DR, notes, diagrams). Load, validate, and
tell when inferred content has gone stale because the Markdown it was based on changed.

Nothing here calls an LLM. Stale content is flagged, never rewritten: regenerating a summary or
diagram is an explicit step (Claude rewrites config.json).
"""
import hashlib
import json
import re
from pathlib import Path

from parse import section_ids, suggest_views

VIEWS = ["overview", "document", "roadmap", "tasks", "highlights", "diagrams", "files", "steps"]

# A CSS color and nothing else: hex, a color function with plain arguments, or a color name.
# (No url(), no ';', so an accent can never load a resource or add other styles.)
CSS_COLOR_RE = re.compile(r"^(#[0-9a-f]{3,8}|[a-z]{3,30}|(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([\d\s.,%/+-]*(deg|turn|rad)?[\d\s.,%/+-]*\))$", re.I)
TASK_BOX_RE = re.compile(r"^(\s*(?:[-*+]|\d+[.)])\s+)\[[ xX]\]", re.M)


class ConfigError(ValueError):
    """The config breaks a rule. The message says what to fix."""


def is_css_color(value):
    return isinstance(value, str) and bool(CSS_COLOR_RE.match(value.strip()))


def load_config(path):
    """{} when there is no config file. Invalid JSON raises ConfigError with line and column."""
    path = Path(path)
    if not path.exists():
        return {}
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ConfigError(f"{path}:{e.lineno}:{e.colno}: invalid JSON: {e.msg}") from None
    if not isinstance(config, dict):
        raise ConfigError(f"{path}: the config must be a JSON object")
    return config


def config_sha(config):
    return hashlib.sha256(json.dumps(config, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def check_config(config, model, strict=True):
    """Validate the config and enforce the fidelity rules. Returns (config, warnings).

    strict (a config Claude just wrote): unknown section ids are errors.
    not strict (an existing config, the Markdown changed since): references to sections that
    no longer exist are dropped with a warning instead, so regeneration keeps working; the
    staleness check then flags the affected inferred content."""
    warnings = []
    ids = section_ids(model)

    def unknown_id(what, i):
        if strict:
            raise ConfigError(f"config {what} has unknown section id '{i}'. Use an id from parse.py.")
        warnings.append(f"config {what} cites '{i}', which is no longer a section of the document")

    views = config.get("views") or suggest_views(model)
    unknown = [v for v in views if v not in VIEWS]
    if unknown:
        raise ConfigError(f"Unknown view(s): {', '.join(unknown)}. Choose from: {', '.join(VIEWS)}")
    if "document" not in views:  # the full, faithful document is always reachable
        views = [*views, "document"]
        warnings.append("added 'document' view (always included so no content is hidden)")
    config["views"] = list(dict.fromkeys(views))

    # Inferred content must cite real sections, or it could not be traced back to the source.
    for key in list(config.get("notes", {})):
        if key not in ids:
            unknown_id("'notes'", key)
            config["notes"].pop(key)

    if "accent" in config and not is_css_color(config["accent"]):
        raise ConfigError(f"config 'accent' must be a CSS color like \"#0f766e\", got {config['accent']!r}")

    for key in ("roadmap", "track"):
        for i in config.get(key, []):
            if i not in ids:
                unknown_id(f"'{key}'", i)
        if key in config:
            config[key] = [i for i in config[key] if i in ids]
    if config.get("roadmap"):  # stages picked by Claude instead of detected from titles
        model["roadmap"] = {"ids": config["roadmap"], "basis": "config"}

    deps = config.get("dependencies")
    if deps is not None:  # {stage: [stages it needs]}, for when the document is not explicit enough
        if not isinstance(deps, dict) or not all(isinstance(v, list) for v in deps.values()):
            raise ConfigError('config \'dependencies\' must look like {"phase-2": ["phase-1"]}')
        stages = model["roadmap"]["ids"]
        for stage in list(deps):
            for i in [stage, *deps[stage]]:
                if i not in ids:
                    unknown_id("'dependencies'", i)
                elif i not in stages:
                    warnings.append(f"config 'dependencies' mentions '{i}', which is not a roadmap stage; ignored")
            deps[stage] = [i for i in deps[stage] if i in stages and i != stage]
            if stage not in stages:
                deps.pop(stage)

    for d in config.get("diagrams", []):
        if not d.get("title") or not d.get("mermaid"):
            raise ConfigError("Each config diagram needs 'title' and 'mermaid'.")
        d["inferred"] = True  # anything in the config was written by Claude, not the document
        for src in d.get("sources", []):
            if src not in ids:
                unknown_id(f"diagram '{d['title']}'", src)
    if config.get("diagrams") and "diagrams" not in config["views"]:
        warnings.append("config has diagrams but the 'diagrams' view is not enabled")
    return config, warnings


# ---------- staleness ----------

def _norm_hash(text):
    """Hash of Markdown text, ignoring [ ] / [x] (ticking a task does not change its meaning)."""
    return hashlib.sha256(TASK_BOX_RE.sub(r"\1[ ]", text).encode()).hexdigest()[:16]


def section_hashes(model):
    """id -> hash of that part of the source. A section includes its subsections."""
    lines = model["source"].splitlines()
    marks = sorted([(s["line"], s["id"], 1) for s in model["sections"]] +
                   [(sub["line"], sub["id"], 2) for s in model["sections"] for sub in s["subsections"]])
    out = {}
    for k, (line, sid, level) in enumerate(marks):
        end = next((m[0] for m in marks[k + 1:] if m[2] <= level), len(lines) + 1)
        out[sid] = _norm_hash("\n".join(lines[line - 1:end - 1]))
    first = marks[0][0] if marks else len(lines) + 1
    out["intro"] = _norm_hash("\n".join(lines[:first - 1]))
    return out


def stamps(config, model):
    """What each inferred item was based on, as hashes. A TL;DR covers the whole document; a note
    its section; a diagram its cited sections (or the whole document when it cites none)."""
    h = section_hashes(model)
    doc = _norm_hash(model["source"])
    return {
        "tldr": doc if config.get("tldr") else None,
        "notes": {i: h.get(i) for i in config.get("notes", {})},
        "diagrams": [{s: h.get(s) for s in d.get("sources", [])} or {"*": doc} for d in config.get("diagrams", [])],
    }


def staleness(old, new):
    """Compare stamps from when the config was written (old) with now (new)."""
    return {
        "tldr": bool(old.get("tldr") and old["tldr"] != new["tldr"]),
        "notes": sorted(i for i, v in old.get("notes", {}).items() if new["notes"].get(i) != v),
        "diagrams": [k for k, d in enumerate(old.get("diagrams", []))
                     if k >= len(new["diagrams"]) or d != new["diagrams"][k]],
    }
