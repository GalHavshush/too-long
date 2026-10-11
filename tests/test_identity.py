#!/usr/bin/env python3
"""Document and task identity:  python3 tests/test_identity.py"""
import shutil
import tempfile
from pathlib import Path

import _path  # noqa: F401
from identity import apply_identity, doc_id_for, reconcile

OUT = Path(__file__).resolve().parent
from parse import build_model


def tasks(md):
    return build_model(md, "p")["tasks"]


def ids_after(old_md, new_md):
    """Build old, then new with old's manifest. Returns ({old text: id}, [(new text, id)])."""
    m1 = build_model(old_md, "p")
    man = apply_identity(m1, __file__, {}, OUT)
    m2 = build_model(new_md, "p")
    apply_identity(m2, __file__, man, OUT)
    return [(t["text"], t["id"]) for t in m1["tasks"]], [(t["text"], t["id"]) for t in m2["tasks"]]


HEAD = "# P\n\n## Work\n\n"

# Unchanged document: same ids.
old, new = ids_after(HEAD + "- [ ] Write the parser\n- [ ] Add tests\n", HEAD + "- [ ] Write the parser\n- [ ] Add tests\n")
assert old == new

# Reordered and inserted tasks keep their ids; the new one gets a fresh id.
old, new = ids_after(HEAD + "- [ ] Write the parser\n- [ ] Add tests\n",
                     HEAD + "- [ ] Add tests\n- [ ] Brand new task\n- [ ] Write the parser\n")
o, n = dict(old), dict(new)
assert n["Add tests"] == o["Add tests"] and n["Write the parser"] == o["Write the parser"]
assert n["Brand new task"] not in o.values()

# A small edit (rename) keeps the id.
old, new = ids_after(HEAD + "- [ ] Write the Markdown parser\n- [ ] Ship it\n",
                     HEAD + "- [ ] Write the Markdown parser (stdlib)\n- [ ] Ship it\n")
assert new[0][1] == old[0][1]

# Duplicates pair up in order; removing the first keeps an id from the pair, never a new one.
old, new = ids_after(HEAD + "- [ ] Install dependencies\n- [ ] Install dependencies\n",
                     HEAD + "- [ ] Install dependencies\n")
assert new[0][1] == old[0][1]

# Two similar renames in one section are ambiguous: fresh ids, no transfer.
old, new = ids_after(HEAD + "- [ ] Deploy service alpha\n- [ ] Deploy service beta\n",
                     HEAD + "- [ ] Deploy service gamma\n- [ ] Deploy service delta\n")
assert not {i for _, i in new} & {i for _, i in old}, (old, new)

# Mass rewrite: nothing carries over.
old, new = ids_after(HEAD + "- [ ] Set up CI\n- [ ] Write docs\n", HEAD + "- [ ] Migrate the database\n- [ ] Rotate keys\n")
assert not {i for _, i in new} & {i for _, i in old}

# A new task whose slug equals a deleted task's id must not inherit that id.
prev = [{"id": "t-work-a-task", "text": "A task", "at": "work"}]
new_tasks = [{"id": "t-work-a-task", "text": "A task!!", "at": "work"}, {"id": "t-work-zzz", "text": "zzz", "at": "work"}]
mapping = reconcile(prev, new_tasks[1:])  # "A task" removed, unrelated "zzz" added
assert mapping == {"t-work-zzz": "t-work-zzz"}
mapping = reconcile([{"id": "t-work-zzz", "text": "old zzz text that changed a lot", "at": "work"}],
                    [{"id": "t-work-zzz", "text": "zzz", "at": "work"}])
assert mapping["t-work-zzz"] != "t-work-zzz", mapping

# Same section only: an identical task moved to another section is a different task.
old, new = ids_after("# P\n\n## A\n\n- [ ] Review\n\n## B\n\nText.\n", "# P\n\n## A\n\nText.\n\n## B\n\n- [ ] Review\n")
assert new[0][1] != old[0][1]

# Ids in the document blocks match model.tasks, and every task gets a sig.
m = build_model(HEAD + "- [ ] One\n  - [x] Nested\n", "p")
apply_identity(m, __file__, {"doc_id": "abc", "source": "test_identity.py",
                             "tasks": [{"id": "keep-me", "text": "Nested", "at": "work"}]}, OUT)
item = m["sections"][0]["blocks"][0]["items"][0]
assert item["children"][0]["id"] == "keep-me" == m["tasks"][1]["id"]
assert all(len(t["sig"]) == 10 for t in m["tasks"])

# Document ids: kept for the same file and after a move; new when the folder is reused for another file.
with tempfile.TemporaryDirectory() as d:
    a, b = Path(d, "a.md"), Path(d, "b.md")
    a.write_text("# A\n")
    b.write_text("# B\n")
    out = Path(d, ".too-long")
    first = doc_id_for(a, {}, out)
    man = {"doc_id": first, "source": "../a.md"}
    assert doc_id_for(a, man, out) == first
    assert doc_id_for(b, man, out) != first  # a.md still exists: b.md is a different document
    moved = Path(d, "renamed.md")
    shutil.move(a, moved)
    assert doc_id_for(moved, man, out) == first  # a.md is gone: treat it as moved
print("ok")
