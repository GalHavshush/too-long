# too-long

**Too long. Just show me.**

A [Claude Code](https://claude.com/claude-code) skill that turns a long Markdown plan or technical document (the kind Claude writes before implementing something) into an interactive local website: roadmap, task tracker, decisions and risks, diagrams, file tree, step-by-step walkthrough, plus the full document. Or, with `--video`, a narrated two-minute explainer.

No npm, no build step. The output is a static folder you open by double-clicking `index.html`.

### Before and after

The input is ordinary Markdown ([`examples/trailhead-plan.md`](examples/trailhead-plan.md), 95 lines):

```markdown
## Phase 1: Foundations

Set up the project and the trail catalogue that everything else hangs off.

- [x] Create the SvelteKit app in `web/` with TypeScript and Vitest
- [x] Add Postgres + PostGIS via `docker-compose.yml`
- [x] Import trail geometries from OpenStreetMap into `trails` with `scripts/import_osm.py`
- [ ] Trail search endpoint `GET /api/trails?q=` in `web/src/routes/api/trails/+server.ts`
```

The output is a site built from it, here the roadmap view:

![Roadmap view of the example plan](docs/screenshots/roadmap.png)

### Why not just ask Claude for an HTML dashboard?

You can, and you get a one-off page that drifts from the plan the moment the plan changes. too-long is different:

- **Rebuilt from the Markdown, without an LLM.** Edit the plan and run `build` (or leave `watch` running). Claude is only involved in choosing views and writing the clearly labelled extras.
- **Nothing is dropped.** The Document view always renders every block, and the tests check that every word of each fixture survives parsing.
- **Inferred content is labelled and tracked.** A TL;DR, notes and diagrams Claude adds carry an "Inferred" badge, and are marked "May be outdated" when the sections they were based on change.
- **Traceable.** Every task, highlight, diagram and file mention links to its line in the Markdown.
- **Task state that can live in the Markdown.** Served locally, ticking a task writes `[x]` into the file (atomically, refusing if the file changed underneath).
- **Safe rendering.** Links are checked against an allowlist of schemes, raw HTML is shown as text, and the only third-party script (Mermaid) is pinned with an integrity hash.

## Installation

You need [Claude Code](https://claude.com/claude-code) and Python 3.9+ (standard library only; tested on 3.9, 3.11 and 3.14).

### One prompt

Paste this into Claude Code:

```text
Install the too-long skill from https://github.com/GalHavshush/too-long: clone it into ~/.claude/skills/too-long (create ~/.claude/skills if it doesn't exist; if too-long is already there, run git pull in it instead). Then check that ~/.claude/skills/too-long/SKILL.md exists and tell me how to use it.
```

### Manually

For every project (personal skill):

```bash
git clone https://github.com/GalHavshush/too-long ~/.claude/skills/too-long
```

For one project only (commit it so your team gets it too):

```bash
git clone https://github.com/GalHavshush/too-long .claude/skills/too-long
```

Video mode (`--video`) needs a few extra local tools; see [Video mode](#video-mode). Everything else works with Python alone.

Start a new Claude Code session afterwards so the skill is picked up. To update:

```bash
git -C ~/.claude/skills/too-long pull
```

## Usage

Ask Claude Code in plain words and name the file:

```text
Use too-long on plan.md
too-long this plan
Make docs/spec.md easier to understand with too-long
Use too-long to turn this into a visual roadmap
```

Add `--video` for a narrated explainer video instead of a website (`Use too-long on plan.md --video`).

Claude reads the whole document, then asks what you want the visual version to help you do (unless you already said), for example:

- make it easier to read and navigate
- show it as a roadmap or timeline
- visualize architecture and relationships
- turn it into an implementation dashboard and track progress
- learn it step by step
- present it

You can pick several. Claude proposes which views fit *this* document, builds the site into `.too-long/`, and opens it.

You can also run it yourself with one command, `scripts/too_long.py`:

```bash
python3 ~/.claude/skills/too-long/scripts/too_long.py build plan.md    # build .too-long/
python3 ~/.claude/skills/too-long/scripts/too_long.py watch plan.md    # rebuild on every save
python3 ~/.claude/skills/too-long/scripts/too_long.py serve plan.md    # ticking a task writes [x] into plan.md
python3 ~/.claude/skills/too-long/scripts/too_long.py parse plan.md    # structure summary
python3 ~/.claude/skills/too-long/scripts/too_long.py doctor           # what is installed, what needs it
```

Output goes to `.too-long/` in the current folder (`--out DIR` to change it). The individual scripts (`build.py`, `watch.py`, `serve.py`, `parse.py`, `video.py`) take the same arguments.

## Example

[`examples/trailhead-plan.md`](examples/trailhead-plan.md) is a made-up plan for a trail-conditions app: four phases with checkboxes, decisions, risks, open questions, a table, a Mermaid diagram and file paths. The prompt was:

```text
Use too-long on examples/trailhead-plan.md. I want to track implementation, see the architecture, and be able to walk a new teammate through it.
```

The generated site is committed in [`examples/trailhead-site/`](examples/trailhead-site/). Clone the repo and open `examples/trailhead-site/index.html` to click around. Its [`config.json`](examples/trailhead-site/config.json) shows what Claude chose.

**Roadmap:** phases detected from the headings, with progress and a "current focus" card listing the next open tasks.

![Roadmap view](docs/screenshots/roadmap.png)

**Tasks:** every checkbox, grouped by section, with filters and a link to each task's source line. Opened as a file, checks are saved in your browser; served with `too_long.py serve`, they are written to the Markdown.

![Tasks view](docs/screenshots/tasks.png)

**Highlights:** decisions, risks, warnings, assumptions, questions and milestones pulled out as cards, each linking back to where it appears.

![Highlights view](docs/screenshots/highlights.png)

**Diagrams:** Mermaid diagrams from the document, plus diagrams Claude drew from the text, clearly labelled as inferred.

![Diagrams view, dark mode](docs/screenshots/diagrams.png)

**Step by step:** one section per screen, arrow-key navigation, and "mark as understood".

![Step-by-step view](docs/screenshots/steps.png)

**Document:** the full document with collapsible sections, a scroll-synced table of contents, search, and a raw Markdown toggle.

![Document view, dark mode](docs/screenshots/document.png)

## Video mode

Add `--video` to get a ~2 minute narrated explainer video instead of a website:

```text
/too-long plan.md --video
```

Claude finds the story in your plan, writes a short script and a storyboard (title, goals, decisions, a diagram, the phases, risks, what success looks like), then renders it locally to `.too-long/video/<name>-explainer.mp4`. 
**Watch the example:** [`examples/trailhead-video/trailhead-plan-explainer.mp4`](examples/trailhead-video/trailhead-plan-explainer.mp4) (1:51, narrated) is made from the same Trailhead plan. Its [`storyboard.json`](examples/trailhead-video/storyboard.json) and [`narration.txt`](examples/trailhead-video/narration.txt) sit next to it.

![Frames from the example video](docs/screenshots/video-frames.png)

Everything stays on your machine: the voice is macOS `say`, frames are drawn by headless Chrome, and ffmpeg encodes the result. No cloud services. Without `say` (Linux, Windows) you still get a captioned video. What you need, on macOS:

```bash
brew install ffmpeg      # encodes the video
brew install node        # Node 22+ (drives Chrome; no npm packages)
```

plus Google Chrome (or Chromium/Edge/Brave). `python3 ~/.claude/skills/too-long/scripts/too_long.py doctor` checks all of it and prints the install command for your OS. Video rendering has been tested on macOS only. Rendering takes a few minutes. The same source-fidelity rules apply: code snippets and file paths must exist in your Markdown, and anything Claude had to infer gets an "Inferred" badge on screen.

## Views

Only the views that fit the document and your goal are generated.

| View | What it shows |
|---|---|
| Overview | Title, TL;DR, stats, intro, section cards with progress |
| Document | The whole document. Always included |
| Roadmap | Stages as a timeline with status and current focus |
| Tasks | All checkboxes (or numbered steps you choose to track), with progress |
| Highlights | Decisions, risks, warnings, questions, assumptions, milestones |
| Diagrams | Mermaid from the document + inferred diagrams |
| Files | Tree of every file path the document mentions |
| Step by step | One section at a time, for learning or presenting |

Every site has search, light/dark mode, works on phones, and has a Source view (`#/source/<line>`) showing the Markdown exactly as written; the "L42" links on tasks, highlights, diagrams and files open it at that line.

## Keeping the site in sync

| How you open it | Task checks | When the Markdown changes |
|---|---|---|
| `index.html` from disk (file://) | Saved in this browser only. The Markdown is not changed. | Run `build` again, then reload |
| `too_long.py watch plan.md` + `index.html` | Same as above | Rebuilt on every save; reload the page |
| `too_long.py serve plan.md`, open `http://127.0.0.1:8765/` | Written to the Markdown (`- [ ]` ↔ `- [x]`) | The open page reloads itself |

Details of served mode:

- Only the checkbox character changes; line endings, spacing and everything else stay byte-for-byte.
- If the file changed since the page loaded, the write is refused and the page reloads.
- Writers are serialised with an OS lock on a `.plan.md.too-long.lock` file next to the Markdown.
- The server listens on 127.0.0.1 only, needs a per-run token, and refuses cross-site requests.
- Numbered steps you chose to track (config `track`) have no checkbox in the Markdown, so their checks always stay in the browser.

Browser state is keyed by a document id kept in `.too-long/build.json`, so two plans with the same title never share checks, and checks follow tasks through edits. Delete that file to start fresh.

## Configuration

Claude writes `.too-long/config.json`; you can edit it too. Every field is optional.

| Field | Meaning |
|---|---|
| `views` | Which views, in order; the first is the landing page. `document` is always added. |
| `accent` | A CSS color (`"#0f766e"`, `"teal"`, `"oklch(60% 0.1 190)"`). |
| `tldr` | Bullets for the overview. Inferred. |
| `notes` | `{section-id: text}` shown at the top of a section. Inferred. |
| `diagrams` | `[{title, description, mermaid, sources: [section-id]}]`. Inferred. |
| `roadmap` | Section ids to use as roadmap stages, when heading detection picks the wrong ones. |
| `track` | Section ids whose numbered `1. 2. 3.` steps become tasks. |

Section ids come from `too_long.py parse plan.md`. A config that cites an unknown id is refused when it is new. If the config was valid and a heading was renamed later, the build continues and warns instead. The page template lives in `assets/` (`index.html`, `styles.css`, `app.js`, plain HTML/CSS/JS); change it there to customise every site.

## Supported Markdown

too-long uses its own small parser (Python standard library only), so the supported syntax is a documented subset:

- Headings: `#`…`######`, and `===`/`---` setext. A single `#` is the title; the next level down are the sections, and the level below that the subsections.
- Lists: `-` `*` `+` and `1.` `1)`, nested by indentation (tabs count as 4 spaces). Task lists `- [ ]` / `- [x]` at any depth, and inside blockquotes.
- Code: fenced (backticks or tildes, inside lists too) and 4-space indented. ```` ```mermaid ```` blocks become diagrams.
- Tables: pipe tables, with `\|` and `` `a|b` `` inside cells.
- Links: inline `[text](url)`, reference `[text][ref]` / `[ref]`, `<https://…>` and bare URLs, plus images.
- Other blocks: blockquotes, GitHub alerts (`> [!WARNING]`), horizontal rules, YAML front matter.
- Callouts: paragraphs or bullets starting with `Decision:`, `Risk:`, `Warning:`, `Question:`, `Note:`, `Assumption:`, `Milestone:`, and bullets under headings like "Risks" or "Open questions".
- Not supported: raw HTML (shown as text), footnotes, definition lists. An unclosed code fence runs to the end of the file (as in CommonMark) and is reported as a warning.

## Faithful to the source

The Markdown is the source of truth. too-long never removes content (the Document view always shows everything) and never invents requirements, tasks, decisions or dependencies. Anything Claude adds, like a TL;DR, a section note or an architecture diagram, is labelled **"Inferred · not in the original"**. When the part of the document it was based on changes, it is also marked **"May be outdated"**. It is never rewritten automatically; ask Claude to update the config.

## How it works

```
plan.md ──parse.py──▶ content model ──(Claude: pick views, write config.json)──▶ build.py ──▶ .too-long/
                                                                                              index.html
                                                                                              styles.css
                                                                                              app.js
                                                                                              data.js
```

1. **`scripts/parse.py`** turns Markdown into a JSON content model: sections, blocks with source line numbers, and indexes of tasks, callouts, diagrams and file paths.
2. **Claude** picks the views for your goal and writes `config.json`.
3. **`scripts/build.py`** validates the config, keeps ids stable across builds (`build.json`), flags stale inferred content, and writes the site. `assets/app.js` (vanilla JS) renders the views from `data.js`.

The core modules have no HTTP, browser or printing in them, so the CLI, the watcher, the local server, and later an editor integration all share them. [`docs/architecture.md`](docs/architecture.md) explains the pieces, and [`docs/model.md`](docs/model.md) documents the JSON model and its invariants. [`SKILL.md`](SKILL.md) holds the instructions Claude follows.

```
too-long/
├── SKILL.md            # what Claude follows
├── scripts/
│   ├── parse.py        # Markdown → content model
│   ├── build.py        # content model + config → site
│   ├── watch.py        # rebuild on every save
│   ├── serve.py        # local server: task checks written to the Markdown (sync.py)
│   ├── config.py identity.py model.py regen.py website.py sync.py  # the reusable core (docs/model.md)
│   ├── args.py         # parses "<file.md> [--video]"
│   ├── video.py        # storyboard → narration → timing → mp4 (video mode)
│   ├── render_video.mjs# frame capture via headless Chrome
│   ├── cdp.mjs         # tiny Chrome DevTools client (video frames, browser tests)
│   ├── too_long.py     # the command line: build, watch, serve, parse, video, doctor
│   └── run_tests.py    # runs everything in tests/: python3 scripts/run_tests.py
├── video.md            # what Claude follows in video mode (storyboard schema)
├── tests/              # parser fixtures + golden files, unit tests, browser tests (e2e.test.mjs)
├── assets/             # site template (HTML, CSS, vanilla JS) + assets/video/ frame player
├── examples/           # example plan + generated site
└── docs/                 # architecture.md, model.md, screenshots/
```

## Testing

```bash
python3 scripts/run_tests.py
```

This runs everything:

- golden-file parser tests over readable fixtures in `tests/fixtures/`
- unit tests for identity, config, regeneration, sync, the server and the CLI
- browser tests (`tests/e2e.test.mjs`) that build sites and drive headless Chrome over the DevTools protocol, with no npm packages

The browser tests need Node 22+ and Chrome and skip themselves without them. After an intended parser change, regenerate the golden files with `python3 tests/test_golden.py --update` and review the diff.

## Troubleshooting

| Problem | Fix |
|---|---|
| `... is not UTF-8 text` | Re-save the file as UTF-8 (the message includes an `iconv` command). |
| `config 'notes' has unknown section id` | Use an id from `too_long.py parse plan.md`; headings changed since the config was written. |
| `config.json:3:14: invalid JSON` | Fix the JSON at that line and column (often a trailing comma). |
| Diagrams show their source instead of a picture | Mermaid loads from cdn.jsdelivr.net the first time; you're offline, it's blocked, or the diagram has a syntax error. |
| Ticking a task doesn't change the Markdown | That only happens with `too_long.py serve`; a page opened from disk saves checks in the browser. |
| "The Markdown changed since this page loaded" | Someone (or Claude) edited the file; the page reloads, then tick again. |
| `Could not listen on 127.0.0.1:8765` | Something else uses the port: `serve plan.md --port 8766`. |
| Checks disappeared after a rebuild | The task's text changed, or `.too-long/build.json` was deleted; too-long won't carry a check over to a task it can't match with confidence. |
| Video tools missing | `too_long.py doctor` lists what's missing and the install command for your OS. |

## Limits

- Mermaid diagrams load mermaid.js (pinned, integrity-checked) from a CDN the first time. Offline, the diagram source is shown instead.
- Opened as a file, task checks are stored in the browser only; writing them to the Markdown needs `serve`.
- Raw HTML inside the Markdown is shown as text.
- The parser covers the subset above, not all of CommonMark.

## License

[MIT](LICENSE)
