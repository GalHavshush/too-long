# The document model (schema version 1)

`model.build_document()` turns a Markdown file into one JSON object. The website reads it from
`data.js` (`window.TOO_LONG = {model, config}`); any other viewer can read the same object (strip
the `window.TOO_LONG = ` prefix and trailing `;`, or call `build_document` from Python).
`model.check_invariants(model)` checks invariants 1-4 below and is run by the tests.

Fields not listed here are internal and may change.

## Document

| Field | Type | Meaning |
|---|---|---|
| `schema_version` | int | `1`. Bumped only for incompatible changes. |
| `doc_id` | string | Stable id of this document (kept in `<out>/build.json`). Survives edits and moving/renaming the Markdown. Key any per-document state by it. |
| `revision` | string | sha256 (hex) of the Markdown file's bytes. Identifies the exact version shown; task updates must name it. |
| `title`, `file` | string | Title (single `#` heading, else the file name) and the Markdown file name. |
| `source` | string | The whole Markdown, line endings normalised to `\n`. Line numbers below index into it (1-based). |
| `intro` | [block] | Blocks before the first section. |
| `sections` | [section] | Top-level sections, in order. |
| `tasks` | [task] | Every checkbox (and tracked numbered step), in document order. |
| `callouts` | [highlight] | Decisions, risks, questions, warnings, assumptions, milestones, notes. |
| `diagrams` | [diagram] | Mermaid blocks found in the document. |
| `files` | [file] | File paths the document mentions. |
| `refs` | {label: {url, title?}} | `[label]: url` reference definitions. |
| `roadmap` | {ids, basis} | Section ids shown as stages; basis `titles`, `sections` or `config`. |
| `stats` | {words, code_blocks} | |
| `warnings` | [string] | Problems found while parsing (unclosed fence, unclosed front matter). |
| `stale` | {tldr, notes, diagrams} | Inferred content whose source changed since it was written (see below). |

## Parts

- **section**: `{id, title, line, blocks, subsections: [{id, title, line, blocks}]}`. `id` is a slug,
  unique in the document (`intro` is reserved).
- **task**: `{id, text, done, line, at, section, n, sig, browser_only}`. `at` is the section or
  subsection id it sits in, `section` its top-level section, `n` the number of a numbered step
  (else `null`), `sig` a hash of the text. `line` is the line of the `- [ ]` item. `browser_only`
  is true for numbered steps tracked via config `track`: they have no checkbox in the Markdown, so
  their state cannot be written back.

## Writing task state back

`sync.update_task(md, task_id, done, expected_revision, out=...)` is the only writer. It returns
`Applied(revision, line)`, `Conflict(current_revision)` (the file is not the revision you saw;
nothing written) or `Busy()` (another too-long writer held the lock past the timeout), and raises
`TaskNotFound` / `NotATask`. It changes one character, writes atomically, and serialises writers
with an OS lock on `.<name>.too-long.lock`. `serve.py` exposes it as `POST /api/task`.
- **highlight**: `{kind, title, number?, body?, details, rejected, blocks, line, at, section, from_heading?}`.
  `title` is the labeled statement ("Claims are fenced by a CAS update."), `number` the label's
  number ("Decision 2 —"), `body` unlabeled blocks that belong to it, `details` labeled parts
  (`[{label, text, line}]`, e.g. `tradeoff`, `rationale`), `rejected` the alternatives listed under
  "Rejected:" (`[{text, line}]`). `blocks` is the original content. `from_heading` means it is a
  highlight because of the heading it sits under ("Risks"), not because of its own label.
- **diagram**: `{text, line, at, section}`.
- **file**: `{path, at: [section id], mentions: [{at, line}]}`.
- **block**: `{type, line?, ...}` with type `heading`, `p`, `list`, `code`, `mermaid`, `table`,
  `quote`, `callout`, `hr`. List items are `{text, ordered, line, n?, task?, id?, kind?, children?, blocks?}`;
  an item with `task` (true/false) is a task and carries the same `id` as in `tasks`.

## Invariants

1. Task ids are unique, and the ids in `tasks` are exactly the ids on task items in the blocks.
2. Every `at`, `section`, `roadmap.ids` entry and file `at` is `intro` or a section/subsection id.
3. Every `line` is within `source`.
4. `revision` is the sha256 of the file the model was built from (64 hex chars).
5. Nothing in the Markdown is dropped: every word of `source` appears somewhere in the model
   (checked for every fixture by `tests/test_golden.py`).

## Identity across rebuilds

`<out>/build.json` keeps `doc_id`, the previous build's tasks, and the inferred-content stamps.
On a rebuild a task keeps its id when it is in the same section with the same text (duplicates
pair up in order), or when it was edited and the match is unambiguous (each the other's best
match, similarity ≥ 0.75, ahead of the runner-up by ≥ 0.15). Otherwise it gets a new id that no
earlier task had. State that is not in the Markdown should be stored with `sig` and dropped when
`sig` no longer matches, so it never moves to a different task.

## Inferred content and staleness

The config (`views`, `accent`, `tldr`, `notes`, `diagrams`, `roadmap`, `track`) is written by
Claude; everything in it is inferred and every config diagram carries `inferred: true`. When a config
is new or changed, too-long records hashes of what each item is based on: the whole document for
the TL;DR, the cited section for a note, the cited sections for a diagram (the whole document if
it cites none). Ticking a checkbox does not count as a change. On later rebuilds with the same
config, `stale` lists the items whose basis changed:

```json
"stale": { "tldr": true, "notes": ["phase-2"], "diagrams": [0] }
```

Nothing is regenerated automatically. Updating the config (having Claude rewrite it) clears the
flags. A config that cites a section that has since been renamed keeps building (the reference is
dropped and reported); a newly written config with an unknown id is refused.
