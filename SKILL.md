---
name: too-long
argument-hint: <file.md> [--video]
description: "Too long, just show me. Turns a long Markdown plan or technical document into a polished, interactive local website (.too-long/index.html, no build step), or with --video a ~2 minute narrated explainer video (.too-long/video/, rendered locally) with views chosen for the reader's goal - overview, roadmap/timeline, task tracker, decisions & risks, architecture/dependency diagrams, file tree, step-by-step learning. Use when the user says 'too-long', 'too-long this', 'use too-long on X.md', or asks to visualize a Markdown plan, make a long or dense plan/spec/PRD/RFC/design doc easier to read or understand, turn a plan into a local website or dashboard, make a technical document interactive, make a Claude-generated implementation plan readable, build a roadmap view from Markdown, visualize a project's architecture from a plan, or turn a plan into an explainer video."
---

# too-long

*Too long. Just show me.*

## Arguments

Arguments: `$ARGUMENTS`. Parse them with `python3 <skill-dir>/scripts/args.py "$ARGUMENTS"`
(prints `{"file": ..., "video": ...}`; `--video` may come before or after the file).

- No `--video`: continue with the website workflow below, unchanged.
- `--video`: do **not** build the website. Read [video.md](video.md) and follow it instead.

Turn one Markdown file into a local static site that shows the document in the
ways the user actually needs. The Markdown stays the source of truth; the site
is a set of lenses over it.

Pipeline (each step is a separate, readable piece):

```
plan.md ──parse.py──▶ content model ──(you: pick views, write config.json)──▶ build.py ──▶ .too-long/
           step 1                         step 2: visualization selection        step 3     index.html styles.css app.js data.js
```

`<skill-dir>` below is this skill's base directory (shown when the skill loads;
normally `~/.claude/skills/too-long`).

## Workflow

### 1. Read the whole document

Read the entire Markdown file with the Read tool (all of it, paging if long).
Then get its structure:

```bash
python3 <skill-dir>/scripts/parse.py path/to/plan.md
```

This prints the title, section ids, task counts, detected highlights
(decisions, risks, questions...), Mermaid blocks, referenced files, and
suggested views. Use the section ids in the config.

### 2. Understand what the user wants from the visual version

If the request already says what experience they want ("as a roadmap",
"help me implement it step by step", "show the architecture"), skip the
question and go to step 3.

Otherwise ask once. With AskUserQuestion use `multiSelect: true` and offer the
four goals most relevant to *this* document (the free-text option covers
combinations and the rest). Without it, ask with a numbered list and say they
can combine. The goals:

1. Make it easier to read and navigate
2. Show it as a roadmap or timeline
3. Visualize architecture and relationships
4. Turn it into an implementation dashboard
5. Learn it step by step
6. Presentation-style, visually impressive
7. Show dependencies between components
8. Track implementation progress

Recommend based on content: a plan with phases and checkboxes suggests 2/4/8;
a design doc with components suggests 1/3; a dense spec suggests 1/5.

### 3. Decide what is worth adding

The scripts already handle everything explicit: structure, tasks, labeled decisions
(with their "Rejected:" alternatives and tradeoffs), risks with mitigations, open
questions, milestones, stated stage dependencies, file references. Check the parse
summary (`Highlights:`, `Roadmap basis:`, `Stage dependencies:`, warnings). Your job is
what the scripts cannot do, and only where it helps the reader's goal:

- **Dependencies the text implies but does not label.** If stages depend on each other
  in prose ("once auth is in place...") and `Stage dependencies` says none or few are
  stated, write config `dependencies` for the ones the text supports, and a dependency
  diagram when the graph is more than a straight line. Never add an edge the text does
  not support; when it is ambiguous, leave it out and say so in your report.
- **Architecture** the text describes in words: one `flowchart TD` of the named
  components and the relationships the text states.
- **Why it matters**: a note on the few sections where a decision or risk has
  consequences elsewhere ("the fencing in §7 relies on this"). Lead with the most
  important decisions and risks, not all of them.
- **A TL;DR** for long documents: the 3-5 facts a reader needs first. Do not repeat
  what the overview's stats and highlights already show.

Skip what would only restate the document: no diagram that redraws a list, no note
that paraphrases its section, no view the document can't fill. Fewer, better additions
beat filling every slot.

### 4. Propose, briefly

Say in 3-6 bullets how you will show *this* document: which views, what each
will contain, and anything you will add that is not in the source (a TL;DR, an
architecture diagram, notes) - marked as inferred. Only propose views the
document can fill: no roadmap for a document without stages, no tasks view
without checkboxes, no file tree for two files.

Wait for a go-ahead unless the user already said to just build it. Keep it
short; rebuilding later is cheap.

### 5. Write the config (visualization selection)

Write `.too-long/config.json` (create the folder):

```json
{
  "views": ["overview", "roadmap", "tasks", "highlights", "document"],
  "accent": "#0f766e",
  "tldr": ["One bullet per key point.", "Plain language, from the document only."],
  "notes": { "phase-2-sync-engine": "Why this section matters / how its parts relate." },
  "diagrams": [{
    "title": "Architecture",
    "description": "Components named in the plan and how data flows between them.",
    "mermaid": "flowchart TD\n  A[Client] --> B[API]",
    "sources": ["phase-1-local-store"]
  }]
}
```

All fields are optional. The first view is the landing page. Two more:

- `"roadmap": ["foundation", "auth-tenancy", ...]`: pick the roadmap stages yourself
  (sections or subsections) when title detection picks the wrong ones; check the
  `Roadmap basis` line of the parse summary.
- `"track": ["implementation-steps"]`: show the top-level numbered items in these
  sections (and their subsections) as tasks with checkboxes. Use it when the plan
  lists its steps as `1. 2. 3.` instead of `- [ ]` and the user wants to track progress.
- `"dependencies": {"phase-4": ["phase-2", "phase-3"]}`: what each roadmap stage needs,
  when the document does not state it on a `Dependencies:` line. It replaces what was
  found for that stage, drives the roadmap's ready/blocked status, and is shown as
  inferred. Only stages and edges the text supports.

| View | Shows | Good for goals |
|---|---|---|
| `overview` | title, TL;DR, stats, intro, section cards with progress | 1, 4, 6 |
| `document` | the full document, collapsible sections, TOC scroll-spy, raw source toggle. **Always included.** | 1 |
| `roadmap` | stages with progress, dependencies, ready/blocked status, parallel waves, focus card | 2, 4, 7, 8 |
| `tasks` | every checkbox grouped by section, filters, progress (saved in the browser) | 4, 8 |
| `highlights` | decisions (with rejected alternatives), risks (with mitigations), questions, assumptions, milestones | 1, 4 |
| `diagrams` | Mermaid blocks from the document + diagrams you add (labelled inferred) | 3, 7 |
| `files` | tree of every file path mentioned, linked to where it is mentioned | 3, 4 |
| `steps` | one section per screen, prev/next, arrow keys, "mark as understood" | 5, 6 |

Choosing the rest:

- `accent`: one color that suits the subject (calm teal for infra, deep blue for
  backend, warm orange for product...). Must read on light and dark backgrounds.
  Leave it out to use the default.
- `tldr`: 2-5 bullets, only facts stated in the document. Include it when the
  document is long or the goal is reading, learning, or presenting.
- `notes`: keyed by section/subsection id. Use for learning goals: what a
  section is for, how it connects to others. Never add requirements.
- `diagrams`: for architecture or dependency goals when the document describes
  components but has no diagram. Nodes and edges must come from the text; cite
  the sections in `sources` (a diagram without sources is checked against the whole
  document for staleness). Prefer `flowchart TD` for more than ~5 nodes (wide
  LR diagrams shrink). Draw dependencies only where the text states them
  ("after", "requires", "depends on", "blocked by"); use a dashed edge with a label
  for a partial one ("fast path"). If the document already has a Mermaid diagram of
  the same thing, don't draw another.

Everything from the config is rendered with an "Inferred · not in the
original" label. That is what makes adding it safe.

Everything extracted from the Markdown (tasks, highlights, diagrams, file
mentions) links to its source line ("L42"), which opens `#/source/42`: the
Markdown exactly as written, with that line highlighted.

### 6. Build

```bash
python3 <skill-dir>/scripts/build.py path/to/plan.md
```

Options: `--out DIR` (default `.too-long`; use `.too-long/<name>` for several
documents), `--config FILE` (default `<out>/config.json`). It refuses a config
whose notes, diagram sources, roadmap or track cite an unknown section id; fix
it and re-run. Fix any warnings it prints too. Then open it:

```bash
open .too-long/index.html
```

(`xdg-open` on Linux, `start` on Windows.) If you can view it in a browser
tool, check the landing view and one more view for broken rendering.

To keep the site current while the Markdown is being edited:
`python3 <skill-dir>/scripts/watch.py path/to/plan.md [--out DIR]` rebuilds on every
save (no LLM involved). When a section that your TL;DR, a note or a diagram is based
on changes, build.py and watch.py report it and the site marks that item "May be
outdated". Nothing is rewritten automatically: update config.json yourself when the
user wants it refreshed (a changed config clears the flags).

### 7. Report

Two or three lines: where the site is, which views it has, and exactly what
you added that is inferred (and anything you left out because the text was
ambiguous). Mention that, opened as a file, task checks are
saved in the browser only and re-running build.py refreshes the site; and that
`python3 <skill-dir>/scripts/serve.py path/to/plan.md` serves it on
127.0.0.1 so ticking a task writes `[x]` into the Markdown and edits to the
Markdown show up in the open page. If `.too-long/` is not ignored by git, suggest adding it to `.gitignore`;
don't edit it yourself.

## Fidelity rules

The Markdown is the source of truth.

- Never remove content. The Document view renders every block; other views
  only rearrange it.
- Never invent requirements, decisions, tasks, dependencies, or architecture.
- Anything you infer goes in the config (TL;DR, notes, diagrams), where it is
  labelled as inferred. Never edit the Markdown to make the site look better.
- If the document is ambiguous about something you would like to show (e.g.
  phase order), show what it says and mention the ambiguity in your report.

## What the parser recognizes

- `#` title (when there is exactly one), the next heading level as sections,
  the level below as subsections. Documents using only `##`/`###`, or several
  `#`s, also work.
- `- [ ]` / `- [x]` tasks, nested lists, ordered lists, tables, blockquotes,
  fenced and 4-space indented code (long blocks fold), ```` ```mermaid ```` diagrams, YAML front
  matter, `[text][ref]` reference links, `\|` and `` `a|b` `` inside table cells. Unclosed fences or
  front matter are kept and reported as warnings by parse.py and build.py.
- Highlights: paragraphs or bullets starting with `Decision:`, `Risk:`,
  `Warning:`, `Question:`, `Note:`, `Assumption:`, `Milestone:` (bold or not, also
  numbered: `**Decision 3 — title.**`), headings `### Decision 2: title` and ADR
  `## Decision`, GitHub alerts `> [!WARNING]`, and bold labels later in a sentence
  (`... **Milestone:** M1`). Labels that follow attach to the highlight above them:
  `Rejected:` (alternatives, inline or as the list after it), `Tradeoff:`,
  `Rationale:`, `Mitigation:`, `Likelihood:`, `Impact:`, `Answer:` and similar.
- Bullets under headings like "Risks", "Open Questions", "Decisions",
  "Assumptions", "Milestones" become highlights of that kind, unless the section
  labels its items explicitly; tables whose first column is "Risk"/"Decision" too.
- Stages for the roadmap: sections whose titles read like phases ("Phase 2",
  "Step 3", "Week 1", "1. Setup"), or `### Phase N` subsections when top-level
  sections are only numbered; otherwise every top-level section. A stage's
  `Dependencies:` / `Depends on:` / `Requires:` line gives what it needs ("P2, P3",
  "Phase 1", "All prior phases", "None"); "in parallel with" is never a dependency.
- File paths with a known extension or a trailing `/` (e.g. `src/db/client.ts`,
  `services/billing/`, `src/x/{a,b}.py`), plus Dockerfile, Makefile, `.env`. A short
  reference (`config.py`) is merged with the one longer path it can mean; each file
  is marked on disk / not on disk / ambiguous.

## Limits

- Mermaid (pinned version, integrity-checked) loads from a CDN the first time; offline, the
  diagram source is shown instead. It is the only network request the site makes.
- Links may use http(s), mailto, file or relative paths; any other scheme (javascript:, data:...)
  is turned into a dead link. `accent` must be a plain CSS color.
- Opened as a file (file://), task checks live in the browser (localStorage) and never
  change the Markdown. Served with `serve.py`, checkboxes are written to the Markdown
  (one character, atomically, refused if the file changed since the page loaded) and
  the page follows edits. Numbered steps shown via `track` have no checkbox, so they
  stay browser-only either way. `serve.py` leaves a `.<name>.too-long.lock` file next
  to the Markdown (used to serialise writers).
- That state is keyed by a document id kept in `<out>/build.json` (with the task ids of the
  last build, so checks follow tasks through edits). Keep the file; deleting it starts fresh.
- Inline HTML in the Markdown is shown as text, not rendered.

## Files

- `scripts/too_long.py`: one command line for all of it (`build`, `watch`, `serve`, `parse`, `video`,
  `doctor`). Needs Python 3.9+ only; video also needs Node 22+, Chrome and ffmpeg.
- `scripts/parse.py`: Markdown → content model. Run alone for a summary, `--json` for the model.
- `scripts/build.py`: model + config → site (thin command over `regen.py`). `scripts/watch.py`: rebuild on change.
- Core modules (no HTTP, no browser): `config.py` (load/validate config, staleness), `identity.py`
  (doc and task ids, `build.json`), `model.py` (`build_document`, schema in `docs/model.md`),
  `regen.py` (`Regenerator`), `website.py` (writes the site files), `sync.py` (`update_task`:
  writes a checkbox to the Markdown). `scripts/serve.py`: local server, a thin transport over them.
- `scripts/pane.py`: JSON interface (`model`, `task`, `open`) for the Claude Code side pane in `hooks/`.
- `scripts/run_tests.py`: runs every test in `tests/` (`python3 scripts/run_tests.py`).
- `video.md`, `scripts/video.py`, `scripts/render_video.mjs`, `scripts/args.py`, `assets/video/`: video mode (`--video`).
- `assets/index.html`, `assets/styles.css`, `assets/app.js`: the site template, copied as is. `app.js` renders `data.js` into the chosen views.
