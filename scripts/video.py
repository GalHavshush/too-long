#!/usr/bin/env python3
"""too-long video mode: storyboard.json -> narration -> timing -> frames -> .mp4. All local.

    python3 video.py plan.md [--out .too-long/video] [--check] [--no-render]

Same shape as the website path, with a different renderer:

    plan.md ──parse.py──▶ content model ──(Claude writes storyboard.json)──▶ video.py ──▶ <out>/
                                                                                        storyboard.json   (input, from Claude)
                                                                                        narration.txt     (what is spoken)
                                                                                        audio/            (macOS `say`, one file per scene)
                                                                                        render/           (player.html + data.js: the frame source)
                                                                                        <name>-explainer.mp4

Pipeline: validate against the Markdown -> narrate (say) -> time scenes from audio length ->
headless Chrome draws each frame (render_video.mjs) -> ffmpeg encodes and muxes the audio.
Nothing leaves the machine. Missing tools are reported with install commands, never replaced by a service.
"""
import argparse
import json
import math
import re
import shutil
import subprocess
import sys
from pathlib import Path

from parse import parse_file

HERE = Path(__file__).resolve().parent
ASSETS = HERE.parent / "assets" / "video"
FPS = 30
SIZE = (1280, 720)
LEAD, TAIL, MIN_SCENE = 0.5, 0.8, 3.5   # seconds before the voice starts, after it ends, shortest scene
WORDS_PER_SEC = 2.7                     # fallback reading speed when there is no voice

# scene type -> fields it needs (see assets/video/player.js for how each is drawn)
SCENES = {
    "title": ["heading"],
    "points": ["heading", "items"],
    "cards": ["heading", "items"],
    "timeline": ["heading", "phases"],
    "flow": ["heading", "nodes", "edges"],
    "code": ["heading", "code"],
    "files": ["heading", "paths"],
}


# ---------- tools ----------

def find_chrome():
    for p in ("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
              "/Applications/Chromium.app/Contents/MacOS/Chromium",
              "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
              "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"):
        if Path(p).exists():
            return p
    return next((w for n in ("google-chrome", "chromium", "chromium-browser") if (w := shutil.which(n))), None)


def node_major():
    node = shutil.which("node")
    if not node:
        return None
    out = subprocess.run([node, "-v"], capture_output=True, text=True).stdout
    return int(re.match(r"v(\d+)", out)[1]) if out else None


def check_tools():
    """Returns (tools, problems). A problem is an exact thing to install."""
    tools = {"chrome": find_chrome(), "ffmpeg": shutil.which("ffmpeg"), "node": shutil.which("node"),
             "say": shutil.which("say") if shutil.which("afinfo") else None}
    problems = []
    if not tools["ffmpeg"]:
        problems.append("ffmpeg is missing. Install it: brew install ffmpeg")
    if not tools["node"] or (node_major() or 0) < 22:
        problems.append("Node.js 22 or newer is required (frame capture uses its built-in WebSocket). "
                        "Install it: brew install node")
    if not tools["chrome"]:
        problems.append("Google Chrome (or Chromium/Edge/Brave) is missing. Install it: brew install --cask google-chrome")
    return tools, problems


# ---------- storyboard ----------

def norm(s):
    return re.sub(r"\s+", " ", s).strip()


def validate(model, sb):
    """Fidelity checks. Returns (errors, warnings). Errors stop the render."""
    errors, warnings = [], []
    ids = {"intro"} | {s["id"] for s in model["sections"]} | {
        sub["id"] for s in model["sections"] for sub in s["subsections"]}
    source = norm(model["source"])
    scenes = sb.get("scenes") or []
    if len(scenes) < 3:
        errors.append("storyboard needs at least 3 scenes")
    for i, sc in enumerate(scenes, 1):
        where = f"scene {i} ({sc.get('id', sc.get('type'))})"
        kind = sc.get("type")
        if kind not in SCENES:
            errors.append(f"{where}: unknown type '{kind}'. Choose from: {', '.join(SCENES)}")
            continue
        for f in SCENES[kind] + ["narration"]:
            if not sc.get(f):
                errors.append(f"{where}: missing '{f}'")
        if kind != "title" and not sc.get("sources"):
            errors.append(f"{where}: needs 'sources' (section ids this scene is based on)")
        for s in sc.get("sources", []):
            if s not in ids:
                errors.append(f"{where}: unknown source section id '{s}'")
        if kind == "code":  # code must be quoted from the document
            missing = [ln for ln in sc.get("code", "").splitlines() if ln.strip() and norm(ln) not in source]
            if missing:
                errors.append(f"{where}: code line not in the Markdown: {missing[0].strip()!r}")
        if kind == "files":
            missing = [p for p in sc.get("paths", []) if p.rstrip("/") not in source]
            if missing:
                errors.append(f"{where}: path not in the Markdown: {missing[0]}")
        if kind == "flow":
            names = {n.get("id") for n in sc.get("nodes", [])}
            for a, b in sc.get("edges", []):
                if a not in names or b not in names:
                    errors.append(f"{where}: edge {a}->{b} uses an unknown node id")
        if kind == "flow" and not sc.get("inferred") and not any(n.get("label", "") in source for n in sc.get("nodes", [])):
            warnings.append(f"{where}: no node label appears in the Markdown; set \"inferred\": true if you drew it")
    words = sum(len(sc.get("narration", "").split()) for sc in scenes)
    if words > 380:
        warnings.append(f"narration is {words} words, about {round(words / 2.7)}s of speech; aim for ~250 (2 minutes)")
    if scenes and scenes[0].get("type") != "title":
        warnings.append("first scene is not a 'title' scene")
    return errors, warnings


# ---------- narration + timing ----------

def synthesize(scenes, audio_dir):
    """macOS `say` per scene. Returns {index: seconds}; scenes without audio are absent."""
    audio_dir.mkdir(parents=True, exist_ok=True)
    out = {}
    for i, sc in enumerate(scenes):
        f = audio_dir / f"scene-{i + 1:02d}.aiff"
        if subprocess.run(["say", "-r", "170", "-o", str(f), sc["narration"]], capture_output=True).returncode:
            return {}  # all-or-nothing: a half-narrated video is worse than a captioned one
        info = subprocess.run(["afinfo", str(f)], capture_output=True, text=True).stdout
        m = re.search(r"estimated duration:\s*([\d.]+)", info)
        if not m:
            return {}
        out[i] = float(m[1])
    return out


def timeline(scenes, voice):
    t = 0.0
    for i, sc in enumerate(scenes):
        speech = voice.get(i, len(sc["narration"].split()) / WORDS_PER_SEC)
        sc["speech"] = round(speech, 2)
        sc["start"] = round(t, 2)
        sc["dur"] = round(max(MIN_SCENE, LEAD + speech + TAIL), 2)
        t += sc["dur"]
    return round(t, 2)


# ---------- render ----------

def write_render_source(out, sb, scenes, total, voice):
    rdir = out / "render"
    rdir.mkdir(parents=True, exist_ok=True)
    for name in ("player.html", "player.css", "player.js"):
        shutil.copy(ASSETS / name, rdir / name)
    data = {"title": sb.get("title") or "", "accent": sb.get("accent") or "#c2410c",
            "scenes": scenes, "total": total, "lead": LEAD, "width": SIZE[0], "height": SIZE[1]}
    (rdir / "data.js").write_text(f"window.VIDEO = {json.dumps(data, ensure_ascii=False)};\n", encoding="utf-8")
    return rdir / "player.html"


def render(tools, page, out, scenes, total, mp4, voice):
    frames = math.ceil(total * FPS)
    cap = subprocess.Popen([tools["node"], str(HERE / "render_video.mjs"), tools["chrome"], str(page),
                            str(FPS), str(frames), str(SIZE[0]), str(SIZE[1])], stdout=subprocess.PIPE)
    cmd = [tools["ffmpeg"], "-y", "-loglevel", "error", "-framerate", str(FPS), "-f", "image2pipe", "-c:v", "mjpeg", "-i", "-"]
    if voice:
        files = [out / "audio" / f"scene-{i + 1:02d}.aiff" for i in range(len(scenes))]
        for f in files:
            cmd += ["-i", str(f)]
        pads = ";".join(  # delay each narration by LEAD and pad it to the scene length
            f"[{i + 1}:a]aresample=44100,adelay={int(LEAD * 1000)}:all=1,apad=whole_dur={sc['dur']}[a{i}]"
            for i, sc in enumerate(scenes))
        joined = "".join(f"[a{i}]" for i in range(len(scenes)))
        cmd += ["-filter_complex", f"{pads};{joined}concat=n={len(scenes)}:v=0:a=1[a]", "-map", "0:v", "-map", "[a]",
                "-c:a", "aac", "-b:a", "160k"]
    cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", str(mp4)]
    enc = subprocess.run(cmd, stdin=cap.stdout)
    cap.stdout.close()
    if cap.wait() or enc.returncode:
        sys.exit("Render failed (see messages above).")


def main():
    ap = argparse.ArgumentParser(description="Render a too-long explainer video (local only).")
    ap.add_argument("markdown", nargs="?")
    ap.add_argument("--out", default=".too-long/video")
    ap.add_argument("--check", action="store_true", help="only check that the local tools exist")
    ap.add_argument("--no-render", action="store_true", help="validate, narrate and time, but skip the render")
    args = ap.parse_args()

    tools, problems = check_tools()
    if args.check or not args.markdown:
        print("\n".join(f"ok       {k}: {v}" if v else f"missing  {k}" for k, v in tools.items()))
        print("\n".join(problems) or "All required tools found.")
        if not tools["say"]:
            print("note: macOS `say` not found, so the video will have captions but no voice.")
        sys.exit(1 if problems else 0)
    if problems and not args.no_render:
        sys.exit("Cannot render the video yet:\n  - " + "\n  - ".join(problems))

    md, out = Path(args.markdown), Path(args.out)
    sb_path = out / "storyboard.json"
    if not sb_path.exists():
        sys.exit(f"No storyboard at {sb_path}. Write it first (see SKILL.md, video mode).")
    model, sb = parse_file(md), json.loads(sb_path.read_text(encoding="utf-8"))
    errors, warnings = validate(model, sb)
    for w in warnings:
        print(f"warning: {w}")
    if errors:
        sys.exit("Storyboard rejected:\n  - " + "\n  - ".join(errors))

    scenes = [dict(sc) for sc in sb["scenes"]]
    voice = synthesize(scenes, out / "audio") if tools["say"] else {}
    if not voice:
        print("note: no local narration available; the video will use captions only.")
    total = timeline(scenes, voice)
    (out / "narration.txt").write_text("\n\n".join(sc["narration"] for sc in scenes) + "\n", encoding="utf-8")
    page = write_render_source(out, sb, scenes, total, voice)
    print(f"{len(scenes)} scenes, {total:.0f}s, {'narrated' if voice else 'captions only'}")
    if args.no_render:
        return
    mp4 = out / f"{md.stem}-explainer.mp4"
    render(tools, page, out, scenes, total, mp4, voice)
    print(f"Rendered {mp4}")


if __name__ == "__main__":
    main()
