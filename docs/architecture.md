# Architecture

too-long is a small pipeline with a reusable core and thin interfaces on top. Everything is the
Python standard library plus vanilla browser JS; Node is used only for video frames and browser
tests.

```
             ┌──────────── core (no HTTP, no browser, no printing) ────────────┐
plan.md ───▶ │ parse.py ─▶ model.py ◀─ config.py   identity.py   website.py   │ ───▶ .too-long/
             │   (blocks,   build_document   (validate,  (doc_id, task   (write   │      index.html styles.css
             │    lines)    → JSON model)     staleness)  ids, build.json) files)  │      app.js data.js build.json
             │                    ▲                                              │
             │              regen.py: Regenerator.refresh() + subscribe()        │
             │              sync.py:  update_task()  (writes [x] to plan.md)     │
             └─────────────────────────────────────────────────────────────────┘
interfaces:  build.py   watch.py (PollingWatcher → Debouncer → Regenerator)   serve.py (HTTP → sync / regen)
             too_long.py (one CLI over all of them)   video.py (storyboard → mp4, reuses parse/config)
```

## Core modules

| Module | Responsibility | Depends on |
|---|---|---|
| `parse.py` | Markdown → blocks and indexes (tasks, callouts, diagrams, files), each with its source line. Reads files (`read_markdown`, clear errors). | stdlib |
| `config.py` | Load and validate the config (`ConfigError`), mark inferred content, compute staleness stamps. | parse |
| `identity.py` | `doc_id` per output folder; reconcile task ids with the previous build; `build.json`. | stdlib |
| `model.py` | `build_document(md, config, manifest, out)`: one pure function producing the documented model (`docs/model.md`); `check_invariants`. | parse, config, identity |
| `website.py` | Write the template and `data.js`, only the files whose bytes changed. | identity |
| `regen.py` | `Regenerator`: refresh when inputs changed, one refresh at a time, notify subscribers. | model, website, config |
| `sync.py` | `update_task`: the only code that writes the Markdown. | model, config, identity |

## Flows

**Build** (`build.py`, or the skill): `Regenerator.refresh(force=True)` → `build_document` →
`write_site`. Claude's only part is `config.json` (views and inferred extras).

**Watch** (`watch.py`): `PollingWatcher` notices an mtime/size change on the Markdown or config →
`Debouncer` waits 300 ms of quiet → `Regenerator.refresh()`, which does nothing if the bytes are
unchanged. One watch per file (a registry), and refreshes never overlap (a lock). The change
source is a parameter: anything with `start()`/`stop()` that calls the callback can replace polling.

**Serve** (`serve.py`): serves the output folder and runs a watch. `POST /api/task` calls
`sync.update_task` and then `refresh()`. The page polls `/api/state` and reloads when the revision
changes, keeping its route (hash), scroll position and browser-only state.

**Sync** (`sync.update_task`):

1. Take the OS lock (`.<name>.too-long.lock`).
2. Compare the file's revision (sha256 of its bytes) with the one the caller saw. If they differ, return `Conflict` and write nothing.
3. Find the task by id, using the same ids the viewer shows.
4. Flip the one box character.
5. Write a temp file, then re-check the original (in case an editor that ignores the lock wrote to it).
6. Rename the temp file over the original.

## Decisions

- **Own parser, no Markdown library.** The skill installs with `git clone` and runs on any Python
  3.9+. A library would need pip, which Homebrew's Python refuses outside a virtualenv (PEP 668),
  and too-long needs a structural model with line numbers, not HTML. The cost is a documented
  subset of Markdown, guarded by golden-file tests and a "no word dropped" check.
- **Static first.** The site works from `file://` with no server; the server only adds write-back
  and live reload. `data.js` is a script so `file://` pages can load it.
- **Markdown is authoritative.** In served mode, checkbox state comes from the file. Browser storage
  holds only what the Markdown cannot (numbered steps, "understood" marks, file:// checks), stored
  with a text hash so it never moves to a different task.
- **Strict writes.** `update_task` refuses on any revision mismatch rather than merging. A retry is
  cheap; silently overwriting someone's edit is not.
- **No LLM in the loop.** Rebuilding is deterministic. Inferred content (TL;DR, notes, diagrams) is
  flagged as stale when its sources change, never regenerated automatically.
- **Security.**
  - All document text is escaped before any tag is added, and links pass a scheme allowlist checked with the browser's URL parser.
  - Mermaid runs in `strict` mode, pinned with a Subresource Integrity (SRI) hash.
  - The server binds to 127.0.0.1, checks Host/Origin, needs a per-run token, and can write only the one Markdown file it was given.

## Reusing the core elsewhere

An editor integration (for example a side panel that shows the current plan) needs no HTTP. It can:

- call `Regenerator(md, out).refresh()` from its own file-change events (or after it edits the plan), and `subscribe()` to get each result
- render the model from `regen.document.model`, following `docs/model.md`, or embed the generated site
- call `sync.update_task(md, id, done, model["revision"], out=out)` when a checkbox is clicked; on `Conflict`, refresh and render again
- key its own UI state by `doc_id` and task id (with `sig`)

## Tests

| Layer | File | Covers |
|---|---|---|
| Parser | `tests/test_golden.py`, `test_parse.py`, `test_traceability.py` | fixtures vs golden JSON, nothing dropped, large plans, line numbers |
| Core | `test_identity.py`, `test_build.py`, `test_regen.py` | ids across edits, config rules, regeneration, debounce, watcher swap, staleness, model invariants |
| Writes | `test_sync.py`, `test_serve.py` | byte-exact edits, conflicts, cross-process locking, HTTP guards |
| CLI | `test_cli.py` | actionable errors, doctor |
| Browser | `e2e.test.mjs` | every view, persistence, migrations, XSS fixtures, served mode, console errors |
| Video | `test_video.py` | argument parsing, storyboard validation, timing |
