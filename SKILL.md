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

### 3. Propose, briefly

Say in 3-6 bullets how you will show *this* document: which views, what each
will contain, and anything you will add that is not in the source (a TL;DR, an
architecture diagram, notes) - marked as inferred. Only propose views the
document can fill: no roadmap for a document without stages, no tasks view
without checkboxes, no file tree for two files.

Wait for a go-ahead unless the user already said to just build it. Keep it
short; rebuilding later is cheap.

### 4. Write the config (visualization selection)

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

| View | Shows | Good for goals |
|---|---|---|
| `overview` | title, TL;DR, stats, intro, section cards with progress | 1, 4, 6 |
| `document` | the full document, collapsible sections, TOC scroll-spy, raw source toggle. **Always included.** | 1 |
| `roadmap` | stages as a timeline, status, current-focus card with next open tasks | 2, 4, 8 |
| `tasks` | every checkbox grouped by section, filters, progress (saved in the browser) | 4, 8 |
| `highlights` | decisions, risks, warnings, questions, assumptions, milestones as cards | 1, 4 |
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
  the sections in `sources`. Prefer `flowchart TD` for more than ~5 nodes (wide
  LR diagrams shrink). Draw dependencies only where the text states them
  ("after", "requires", "depends on", "blocked by").

Everything from the config is rendered with an "Inferred · not in the
original" label. That is what makes adding it safe.

### 5. Build

```bash
python3 <skill-dir>/scripts/build.py path/to/plan.md
```

Options: `--out DIR` (default `.too-long`; use `.too-long/<name>` for several
documents), `--config FILE` (default `<out>/config.json`). Fix any warnings it
prints (unknown section ids, missing view for diagrams). Then open it:

```bash
open .too-long/index.html
```

(`xdg-open` on Linux, `start` on Windows.) If you can view it in a browser
tool, check the landing view and one more view for broken rendering.

### 6. Report

Two or three lines: where the site is, which views it has, and exactly what
you added that is inferred. Mention that task checks are saved in the browser
only and that re-running build.py after editing the Markdown refreshes the
site. If `.too-long/` is not ignored by git, suggest adding it to `.gitignore`;
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
  fenced code (long blocks fold), ```` ```mermaid ```` diagrams, YAML front matter.
- Callouts: paragraphs or bullets starting with `Decision:`, `Risk:`,
  `Warning:`, `Question:`, `Note:`, `Assumption:`, `Milestone:` (bold or not),
  and GitHub alerts `> [!WARNING]`.
- Bullets under headings like "Risks", "Open Questions", "Decisions",
  "Assumptions", "Milestones" become highlights of that kind.
- Stages for the roadmap: sections whose titles read like phases ("Phase 2",
  "Step 3", "Week 1", "1. Setup"); otherwise every top-level section.
- File paths with a known extension or a trailing `/` (e.g. `src/db/client.ts`,
  `services/billing/`), plus Dockerfile, Makefile, `.env`.

## Limits

- Mermaid loads from a CDN the first time; offline, diagram source is shown instead.
- Task checks live in the browser (localStorage). They never change the Markdown.
- Inline HTML in the Markdown is shown as text, not rendered.

## Files

- `scripts/parse.py`: Markdown → content model. Run alone for a summary, `--json` for the model.
- `scripts/build.py`: model + config → site. Validates the config.
- `scripts/test_parse.py`: parser smoke test (`python3 scripts/test_parse.py`).
- `video.md`, `scripts/video.py`, `scripts/render_video.mjs`, `scripts/args.py`, `assets/video/`: video mode (`--video`).
- `assets/index.html`, `assets/styles.css`, `assets/app.js`: the site template, copied as is. `app.js` renders `data.js` into the chosen views.
