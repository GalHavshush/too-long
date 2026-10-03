# too-long: video mode (`--video`)

Turn the Markdown into a ~2 minute narrated explainer video. Everything runs locally:
macOS `say` for the voice, headless Chrome to draw frames, ffmpeg to encode. No cloud services,
ever. If a tool is missing, tell the user exactly what to install; never substitute a service.

```
plan.md ──parse.py──▶ content model ──(you: write storyboard.json)──▶ video.py ──▶ .too-long/video/
                                                                                    storyboard.json  narration.txt  audio/  render/  <name>-explainer.mp4
```

Same document model as the website; only the renderer differs.

## Steps

1. **Check tools.** `python3 <skill-dir>/scripts/video.py --check`. If it reports problems, show the
   user the install commands it prints (`brew install ffmpeg`, `brew install node`, Chrome) and stop.
   No `say` is not an error: the video is then captions only.
2. **Read the whole Markdown file**, then `python3 <skill-dir>/scripts/parse.py plan.md` for section ids.
3. **Find the story.** What is this, why, how is it built, in what order, what could go wrong, what does
   done look like. Pick what is worth showing; the video is not a summary of every line.
   Ask the user a question only if an ambiguity changes the result materially.
4. **Write `.too-long/video/storyboard.json`** (schema below), about 8-10 scenes and ~250 words of
   narration in total. You decide pacing, level of detail and which scenes to use.
5. **Render.** `python3 <skill-dir>/scripts/video.py plan.md` (add `--out DIR` for a non-default folder).
   It validates the storyboard against the Markdown, narrates, times the scenes, renders and encodes.
   Rendering takes a few minutes; tell the user so. Fix any "Storyboard rejected" errors and re-run.
6. **Report**: the mp4 path, its length, and what is inferred (scenes marked `"inferred": true`).
   Offer `open .too-long/video/<name>-explainer.mp4`.

## storyboard.json

```json
{
  "title": "Project name",
  "accent": "#3f9d68",
  "scenes": [
    { "id": "intro", "type": "title", "heading": "Name", "subtitle": "One line",
      "narration": "Spoken text, 1-3 short sentences." },
    { "id": "goals", "type": "points", "heading": "Goals", "items": ["short", "short"],
      "sources": ["section-id"], "narration": "..." }
  ]
}
```

Every scene has `type`, `heading`, `narration`, and (except `title`) `sources`: the section ids from
`parse.py` the scene is based on. Optional on any scene: `"inferred": true`.

| type | extra fields | use for |
|---|---|---|
| `title` | `subtitle` | opening scene |
| `points` | `items`: 2-5 strings, <= 12 words each | problem, goals, success criteria |
| `cards` | `items`: `[{kind, label, text}]`, 2-6; kind = decision, risk, question, assumption, milestone, note | decisions, risks, open questions |
| `timeline` | `phases`: `[{label, detail, milestone?}]`, 2-7 | phases, roadmap, milestones |
| `flow` | `nodes`: `[{id, label}]` (<= 8), `edges`: `[[from, to]]` | architecture, data flow, dependencies |
| `code` | `code` (<= 12 lines), `lang` | one focused snippet |
| `files` | `paths`: file paths (<= 12) | where things live |

Items appear one by one, spread across the narration, so list them in the order you talk about them.

## Rules

- **Fidelity.** Do not invent features, steps, dependencies, milestones or decisions. `video.py` rejects
  `code` lines and `files` paths that are not in the Markdown, and unknown `sources` ids.
- **Inferred.** A `flow` you drew by connecting components the text only names, or any other
  presentation inference, must set `"inferred": true` (the video then shows an "Inferred" badge).
  Draw edges only where the text states a relationship.
- **Narration** is spoken and also shown as captions: plain sentences, no markdown, no file paths read
  letter by letter, numbers written out when they should be spoken naturally ("thirty seconds").
- **On screen text** is short. Never paste paragraphs. Do not show the Markdown verbatim.
- Pacing: about 2 minutes total (scenes last as long as their narration). A tiny plan can be ~1 minute;
  a huge one should still stay near 2:30. Cut rather than speed up.
- `accent`: one color that suits the subject and reads on a dark background.
