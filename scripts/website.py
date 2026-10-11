"""Write the static site for a document: index.html, styles.css, app.js (copied from assets/) and
data.js (window.TOO_LONG = {model, config}). Only files whose content changed are rewritten, so
a rebuild after a small edit touches data.js alone. Returns the names of the files written."""
import json
from pathlib import Path

from identity import MANIFEST

ASSETS = Path(__file__).resolve().parent.parent / "assets"
TEMPLATE = ("index.html", "styles.css", "app.js")


def data_js(model, config):
    # A script, not JSON, so the site works from file:// with no server.
    return f"window.TOO_LONG = {json.dumps({'model': model, 'config': config}, ensure_ascii=False)};\n"


def write_if_changed(path, content):
    path = Path(path)
    data = content.encode("utf-8") if isinstance(content, str) else content
    if path.exists() and path.read_bytes() == data:
        return False
    path.write_bytes(data)
    return True


def write_site(out, model, config, manifest):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    written = [name for name in TEMPLATE if write_if_changed(out / name, (ASSETS / name).read_bytes())]
    if write_if_changed(out / "data.js", data_js(model, config)):
        written.append("data.js")
    if write_if_changed(out / MANIFEST, json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"):
        written.append(MANIFEST)
    return written
