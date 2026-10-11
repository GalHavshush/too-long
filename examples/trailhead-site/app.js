/* too-long frontend.
   Renders window.TOO_LONG = { model, config } (written by scripts/build.py).
   Flow: location.hash -> route() -> a view function returns an HTML string -> #view.
   Markdown content is rendered by block() / inline(); views only arrange it. */
(() => {
  "use strict";
  const { model, config } = window.TOO_LONG;
  const main = document.getElementById("view");

  const VIEW_LABELS = {
    overview: "Overview", document: "Document", roadmap: "Roadmap", tasks: "Tasks",
    highlights: "Highlights", diagrams: "Diagrams", files: "Files", steps: "Step by step",
  };
  const KIND_ORDER = ["decision", "risk", "warning", "caution", "question", "assumption", "milestone", "important", "note", "tip"];
  // Pinned and integrity-checked: the browser refuses the file if the CDN ever serves different bytes.
  const MERMAID_SRC = "https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js";
  const MERMAID_SRI = "sha384-EOXBFmc3gx5mb+vn0vPvvGqACToJD24hhacX5Yx+8NUUQrHIle/Qi5Bg9o3zKwW2";

  // ---------- lookups ----------
  const nodes = { intro: { id: "intro", title: "Introduction", blocks: model.intro } };
  model.sections.forEach(s => {
    nodes[s.id] = s;
    s.subsections.forEach(sub => { nodes[sub.id] = { ...sub, parent: s.id }; });
  });
  const fileSet = new Set(model.files.map(f => f.path));
  const refs = model.refs || {};  // [label]: url definitions (older data.js files have none)
  const has = v => config.views.includes(v);

  // ---------- per-browser state (never written back to the Markdown) ----------
  // Keyed by the document's stable id (from build.json), so plans that share a title never share state.
  const KEY = "too-long:" + (model.doc_id || model.title);
  try {  // one-time copy of state saved before documents had ids (it was keyed by title)
    const legacy = "too-long:" + model.title;
    if (model.doc_id && !localStorage.getItem(`${KEY}:migrated`)) {
      ["tasks", "steps"].forEach(k => {
        const v = localStorage.getItem(`${legacy}:${k}`);
        if (v !== null && localStorage.getItem(`${KEY}:${k}`) === null) localStorage.setItem(`${KEY}:${k}`, v);
      });
      localStorage.setItem(`${KEY}:migrated`, "1");
    }
  } catch {}
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(`${KEY}:${k}`)) ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(`${KEY}:${k}`, JSON.stringify(v)); } catch {} };
  let checks = load("tasks", {});      // task id -> {done, sig}, overrides the Markdown's [ ] / [x]
  let understood = load("steps", {});  // section id -> true

  const taskById = Object.fromEntries(model.tasks.map(t => [t.id, t]));
  // Served by serve.py (it adds the token): checkboxes are written to the Markdown, which stays the source of
  // truth. Opened as a file: checks are saved in this browser only. Tracked numbered steps have no checkbox
  // in the Markdown, so they are always browser-only.
  const TOKEN = document.querySelector('meta[name="too-long-token"]')?.content;
  const synced = id => !!TOKEN && !!taskById[id] && !taskById[id].browser_only;
  // A saved check applies only while the task's text is unchanged (sig), so it never lands on a different
  // task. Plain booleans are checks saved before sigs existed.
  const isDone = t => {
    if (synced(t.id)) return taskById[t.id].done;
    const c = checks[t.id];
    if (c == null) return t.done;
    if (typeof c === "boolean") return c;
    return c.sig === taskById[t.id]?.sig ? c.done : t.done;
  };
  const tasksIn = id => id === "all" ? model.tasks : model.tasks.filter(t => t.at === id || t.section === id);
  const progress = ts => {
    const done = ts.filter(isDone).length;
    return { done, total: ts.length, pct: ts.length ? Math.round((done / ts.length) * 100) : 0 };
  };

  // ---------- Markdown rendering ----------
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const plain = s => String(s).replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`~]/g, "");
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

  // URL schemes a link may use. Anything else (javascript:, data:, vbscript:, unknown) becomes "#".
  // Checked with the browser's own URL parser, after removing the control characters and spaces
  // browsers ignore, so "\x01javascript:" or "java\tscript:" cannot slip through.
  const SAFE_LINK = ["http:", "https:", "mailto:", "file:"];
  const SAFE_IMAGE = /^data:image\/(png|gif|jpe?g|webp);/i;
  function href(u, image = false) {
    const clean = String(u).replace(/[\u0000-\u0020\u007f-\u009f]/g, "");
    if (image && SAFE_IMAGE.test(clean)) return clean;
    let url;
    try { url = new URL(clean, location.href); } catch { return "#"; }
    if (!SAFE_LINK.includes(url.protocol)) return "#";
    if (/^([a-z][\w+.-]*:|#|\/)/i.test(clean)) return clean;
    return (model.base && model.base !== "." ? esc(model.base) + "/" : "") + clean;  // relative to the .md file (clean is already escaped)
  }

  const emphasis = s => s
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`)
    .replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_(?!\s)(.+?)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~(.+?)~~/g, "<del>$1</del>");

  // Markdown inline -> HTML. Everything is escaped first; the only tags that appear are the ones made
  // here. Code spans and finished links are set aside as placeholders so later passes (emphasis) never
  // run inside a tag or an attribute.
  function inline(md) {
    const codes = [], html = [];
    const keep = h => `\u0001${html.push(h) - 1}\u0001`;
    let s = String(md).replace(/[\u0000\u0001]/g, "");
    s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, __, c) => `\u0000${codes.push(c.trim()) - 1}\u0000`);
    s = s.replace(/<(https?:\/\/[^>\s]+)>/g, "[$1]($1)");  // <https://...> autolinks
    s = s.replace(/(!?)\[([^\]]+)\](?:\[([^\]]*)\])?(?![(:])/g, (m, bang, text, ref) => {  // [text][ref], [text][], [ref]
      const u = refs[(ref || text).trim().toLowerCase()]?.url;
      return u ? `${bang}[${text}](${u})` : m;
    });
    s = esc(s);
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, alt, src) => keep(`<img src="${href(src, true)}" alt="${alt}">`));
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, text, u) => {
      const h = href(u);
      return keep(`<a href="${h}"${/^https?:/i.test(h) ? ' target="_blank" rel="noopener"' : ""}>`) + text + keep("</a>");
    });
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)\u0001]+)/g, (_, pre, u) => pre + keep(`<a href="${href(u)}" target="_blank" rel="noopener">${u}</a>`));
    s = emphasis(s);
    return s.replace(/\u0001(\d+)\u0001/g, (_, i) => html[i]).replace(/\u0000(\d+)\u0000/g, (_, i) => {
      const c = codes[i];
      return fileSet.has(c.replace(/^\.\//, "")) && has("files")
        ? `<code class="file-ref" data-file="${esc(c.replace(/^\.\//, ""))}" title="Show in file tree">${esc(c)}</code>`
        : `<code>${esc(c)}</code>`;
    });
  }

  const blocks = list => (list || []).map(block).join("");

  function block(b) {
    switch (b.type) {
      case "heading": { const l = Math.min(b.level + 1, 6); return `<h${l} dir="auto">${inline(b.text)}</h${l}>`; }
      case "p": return `<p dir="auto">${inline(b.text)}</p>`;
      case "hr": return "<hr>";
      case "code": return codeBlock(b);
      case "mermaid": return diagram(b.text);
      case "list": return list(b.items);
      case "quote": return `<blockquote>${blocks(b.blocks)}</blockquote>`;
      case "callout": return callout(b.kind, blocks(b.blocks));
      case "table":
        return `<div class="table-wrap"><table><thead><tr>${b.header.map(c => `<th dir="auto">${inline(c)}</th>`).join("")}</tr></thead>` +
          `<tbody>${b.rows.map(r => `<tr>${r.map(c => `<td dir="auto">${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    }
    return "";
  }

  function codeBlock(b) {
    const n = b.text.split("\n").length;
    const label = esc(b.label || b.lang || "code");
    const body = `<pre><code>${esc(b.text)}</code></pre>`;
    const copy = `<button class="copy" type="button" data-act="copy">Copy</button>`;
    // Long code is folded so it doesn't bury the prose around it.
    return n > 24
      ? `<details class="code"><summary><span>${label}</span><span class="muted">${n} lines</span>${copy}</summary>${body}</details>`
      : `<figure class="code"><figcaption><span>${label}</span>${copy}</figcaption>${body}</figure>`;
  }

  const diagram = text =>
    `<figure class="diagram"><pre class="mermaid">${esc(text)}</pre>` +
    `<figcaption class="offline-note">Showing diagram source: Mermaid could not load (it needs internet the first time) or the diagram has a syntax error.</figcaption></figure>`;

  function list(items) {
    const ordered = items[0]?.ordered;
    const tag = ordered ? "ol" : "ul";
    const start = ordered && items[0].n !== 1 ? ` start="${items[0].n}"` : "";
    const cls = items.some(i => "task" in i) ? ' class="tasklist"' : "";
    return `<${tag}${start}${cls}>${items.map(li).join("")}</${tag}>`;
  }

  const num = n => n != null ? `<span class="num">${n}.</span> ` : "";

  function li(it) {
    const chip = (it.ordered && "task" in it ? num(it.n) : "") + (it.kind ? kindChip(it.kind) : "");
    const rest = blocks(it.blocks) + (it.children?.length ? list(it.children) : "");
    if (!("task" in it)) return `<li dir="auto">${chip}${inline(it.text)}${rest}</li>`;
    return `<li dir="auto" class="task">${checkbox(it.id, isDone({ id: it.id, done: it.task }))}<div><span class="t">${chip}${inline(it.text)}</span>${rest}</div></li>`;
  }

  const checkbox = (id, done) => `<input type="checkbox" data-task="${esc(id)}"${done ? " checked" : ""} aria-label="Done">`;
  const kindChip = k => `<span class="chip" data-kind="${esc(k)}">${esc(cap(k))}</span>`;
  const callout = (kind, html) =>
    `<aside class="callout" data-kind="${esc(kind)}"><div class="callout-label">${esc(cap(kind))}</div><div class="callout-body">${html}</div></aside>`;

  // Everything Claude wrote (config) is labelled as inferred, and as possibly outdated once the part of the
  // Markdown it was based on has changed (model.stale, computed by build.py; nothing is rewritten for you).
  const stale = model.stale || { tldr: false, notes: [], diagrams: [] };
  const staleBadge = on => on ? ` <span class="badge stale" title="The Markdown this was based on changed after it was written. Ask Claude to update the config.">May be outdated</span>` : "";
  const inferred = (label, html, isStale = false) =>
    `<aside class="callout inferred"><div class="callout-label">${label} <span class="badge">Inferred · not in the original</span>${staleBadge(isStale)}</div><div class="callout-body">${html}</div></aside>`;
  const note = id => config.notes?.[id] ? inferred("Claude's note", paragraphs(config.notes[id]), stale.notes.includes(id)) : "";
  const paragraphs = t => Array.isArray(t)
    ? `<ul>${t.map(x => `<li>${inline(x)}</li>`).join("")}</ul>`
    : String(t).split(/\n{2,}/).map(p => `<p>${inline(p)}</p>`).join("");

  const progressEl = scope => tasksIn(scope).length ? `<span class="progress" data-scope="${esc(scope)}"></span>` : "";
  function refreshProgress() {
    document.querySelectorAll("[data-scope]").forEach(el => {
      const p = progress(tasksIn(el.dataset.scope));
      el.innerHTML = `<span class="bar"><span style="width:${p.pct}%"></span></span><span class="count">${p.done}/${p.total}</span>`;
      el.classList.toggle("complete", p.total > 0 && p.done === p.total);
    });
  }

  function excerpt(node, max = 170) {
    const p = node.blocks.find(b => b.type === "p");
    if (!p) return "";
    const t = plain(p.text);
    return `<p class="excerpt" dir="auto">${esc(t.length > max ? t.slice(0, max).replace(/\s+\S*$/, "") + "…" : t)}</p>`;
  }

  const link = id => `<a href="#/document/${esc(id)}">${inline(nodes[id]?.title ?? id)}</a>`;
  // Where an item came from in the Markdown: "L42" opens the source at that line.
  const lineRef = n => n ? `<a class="where" href="#/source/${n}" title="Line ${n} of ${esc(model.file)}">L${n}</a>` : "";
  const plainText = b => !b ? "" :
    b.type === "list" ? b.items.map(i => [i.text, ...(i.blocks || []).map(plainText), plainText({ type: "list", items: i.children || [] })].join(" ")).join(" ") :
    b.type === "table" ? [...b.header, ...b.rows.flat()].join(" ") :
    b.blocks ? b.blocks.map(plainText).join(" ") : plain(b.text || "");

  // ---------- views ----------

  function viewOverview() {
    const p = progress(model.tasks);
    const mins = Math.max(1, Math.round(model.stats.words / 230));
    const kinds = countKinds();
    const stats = [
      [model.sections.length, "sections"],
      ...(p.total ? [[`${p.pct}%`, `${p.done} of ${p.total} tasks done`]] : []),
      ...["decision", "risk", "question"].filter(k => kinds[k]).map(k => [kinds[k], k + (kinds[k] > 1 ? "s" : "")]),
      ...(model.files.length ? [[model.files.length, "files referenced"]] : []),
    ];
    return `
      <header class="hero">
        <p class="eyebrow">${esc(model.file)} · ${mins} min read</p>
        <h1 dir="auto">${inline(model.title)}</h1>
      </header>
      ${config.tldr ? inferred("TL;DR", paragraphs(config.tldr), stale.tldr) : ""}
      <div class="stats">${stats.map(([n, l]) => `<div class="stat"><strong>${n}</strong><span>${esc(l)}</span></div>`).join("")}</div>
      ${p.total ? `<div class="overall">${progressEl("all")}</div>` : ""}
      ${model.intro.length ? `<section class="prose intro">${blocks(model.intro)}</section>` : ""}
      <h2 class="label">Sections</h2>
      <div class="cards">${model.sections.map(s => {
        const k = countKinds(s.id);
        return `<a class="card" href="#/document/${esc(s.id)}">
          <h3 dir="auto">${inline(s.title)}</h3>
          ${excerpt(s)}
          <div class="card-meta">
            ${s.subsections.length ? `<span class="muted">${s.subsections.length} parts</span>` : ""}
            ${Object.entries(k).map(([kind, n]) => `<span class="chip" data-kind="${esc(kind)}">${n} ${esc(kind)}</span>`).join("")}
          </div>
          ${progressEl(s.id)}
        </a>`;
      }).join("")}</div>`;
  }

  function countKinds(section) {
    const out = {};
    model.callouts.filter(c => !section || c.section === section).forEach(c => { out[c.kind] = (out[c.kind] || 0) + 1; });
    return out;
  }

  function sectionHTML(node, level) {
    return `<details class="sec l${level}" id="${esc(node.id)}" open>
      <summary><h${level} dir="auto">${inline(node.title)}</h${level}>${progressEl(node.id)}</summary>
      <div class="sec-body">
        ${note(node.id)}
        ${blocks(node.blocks)}
        ${(node.subsections || []).map(sub => sectionHTML(sub, level + 1)).join("")}
      </div>
    </details>`;
  }

  function viewDocument() {
    return `<article class="doc prose">
      <header class="doc-head">
        <h1 dir="auto">${inline(model.title)}</h1>
        <div class="tools">
          <button type="button" data-act="expand">Expand all</button>
          <button type="button" data-act="collapse">Collapse all</button>
          <button type="button" data-act="raw">Markdown source</button>
        </div>
      </header>
      <pre class="raw" hidden>${esc(model.source)}</pre>
      <div id="intro">${note("intro")}${blocks(model.intro)}</div>
      ${model.sections.map(s => sectionHTML(s, 2)).join("")}
    </article>`;
  }

  // ---------- roadmap status ----------
  // done: every task checked. in progress: some checked. With stated dependencies (model.roadmap.dependencies),
  // an unstarted stage is ready when every stage it needs is done, blocked when one is not. A stage whose
  // dependencies are unknown, that sits in a cycle, or that needs a stage without tasks gets no ready/blocked
  // claim. Qualified dependencies ("the fast path needs P4") are shown but never block.
  const R = model.roadmap;
  const DEPS = R.dependencies || {};
  const hasDeps = Object.keys(DEPS).length > 0;
  const inCycle = new Set((R.cycles || []).flat());
  const shortName = id => {
    const t = plain(nodes[id]?.title ?? id);
    const m = t.match(/\b(phase|stage|step|sprint|week|milestone|iteration|wave)\s*(\d+)/i);
    return m ? `${cap(m[1].toLowerCase())} ${m[2]}` : t;
  };
  function stageStatus(id, seen = new Set()) {
    const p = progress(tasksIn(id));
    if (p.total && p.done === p.total) return "done";
    if (p.done > 0) return "in progress";
    if (!(id in DEPS) || inCycle.has(id) || seen.has(id)) return "not started";
    const hard = DEPS[id].filter(d => !d.qualified).map(d => d.id);
    const states = hard.map(d => stageStatus(d, new Set([...seen, id])));
    if (states.every(st => st === "done")) return "ready";
    if (hard.some((d, k) => states[k] !== "done" && tasksIn(d).length)) return "blocked";
    return "not started";  // waiting on a stage that has no tasks to check: can't tell
  }

  // Waves: stages at the same depth of the stated dependency graph can run at the same time.
  // Only when every stage's dependencies are known and there is no cycle.
  function waves() {
    if (!R.ids.every(id => id in DEPS) || inCycle.size) return null;
    const level = {};
    const depth = id => level[id] ??= 1 + Math.max(0, ...DEPS[id].filter(d => !d.qualified).map(d => depth(d.id)));
    const out = [];
    R.ids.forEach(id => { (out[depth(id) - 1] ??= []).push(id); });
    return out.filter(Boolean);
  }

  function viewRoadmap() {
    const status = {};
    if (hasDeps) R.ids.forEach(id => { status[id] = tasksIn(id).length || id in DEPS ? stageStatus(id) : ""; });
    else {  // no stated dependencies: document order, the first unfinished stage is the current one
      let current = null;
      R.ids.forEach(id => {
        const p = progress(tasksIn(id));
        status[id] = !p.total ? "" : p.done === p.total ? "done" : current ? "upcoming" : "current";
        if (status[id] === "current") current = id;
      });
    }
    const focus = R.ids.filter(id => status[id] === "current" || status[id] === "in progress");
    const ready = R.ids.filter(id => status[id] === "ready");
    const basis = {
      titles: "Stages are the sections whose titles read like phases or steps.",
      sections: "Each top-level section is shown as a stage, in document order.",
      config: "Stages are the parts of the document chosen for this roadmap, in document order.",
    }[R.basis];
    const rules = hasDeps
      ? "Status comes from the task checkboxes and the dependencies each stage states: <b>ready</b> means everything it needs is done, <b>blocked</b> that something it needs is not."
      : "The plan states no dependencies between stages, so they are shown in document order.";
    const chip = (d, cls = "") => {
      const st = status[d.id] ?? "";
      const inferredDep = d.source === "config";
      const title = [d.qualified ? `Only partly: ${d.qualified}` : "", inferredDep ? "Inferred: from config.json, not stated in the document" : ""].filter(Boolean).join(" · ");
      return `<a class="dep ${cls} ${d.qualified ? "qualified" : ""} ${inferredDep ? "inferred" : ""}" data-status="${esc(st)}" href="#/document/${esc(d.id)}"${title ? ` title="${esc(title)}"` : ""}>${st === "done" ? "✓ " : ""}${esc(shortName(d.id))}${d.qualified ? " (partly)" : ""}</a>`;
    };
    const card = id => {
      const i = R.ids.indexOf(id);
      const s = nodes[id], st = status[id];
      const deps = DEPS[id];
      const hard = (deps || []).filter(d => !d.qualified && status[d.id] !== "done" && tasksIn(d.id).length).map(d => shortName(d.id));
      const milestones = model.callouts.filter(c => c.kind === "milestone" && (c.at === id || c.section === id));
      const subs = s.subsections || [];
      const depLine = deps?.find(d => d.line)?.line;
      return `<li class="phase ${st.replace(" ", "-")}">
        <span class="node">${st === "done" ? "✓" : i + 1}</span>
        <div class="phase-body">
          <div class="phase-head"><h3 dir="auto">${link(id)}</h3>${st ? `<span class="status">${st}</span>` : ""}</div>
          ${excerpt(s, 220)}
          ${progressEl(id)}
          ${hasDeps ? `<p class="deps small">${deps === undefined ? `<span class="muted">Dependencies not stated</span>`
            : deps.length ? `<span class="muted">Needs</span> ${deps.map(d => chip(d)).join("")} ${lineRef(depLine)}`
            : `<span class="muted">Needs nothing before it</span> ${lineRef(depLine)}`}
            ${(R.parallel?.[id] || []).length ? `<span class="muted">· parallel with</span> ${R.parallel[id].map(p => chip({ id: p }, "par")).join("")}` : ""}
            ${inCycle.has(id) ? `<span class="warn">· in a dependency cycle, status unclear</span>` : ""}</p>` : ""}
          ${st === "blocked" ? `<p class="small blocked-by">Waiting for ${esc(hard.join(", "))}</p>` : ""}
          ${subs.length ? `<div class="subs">${subs.map(sub => `<a class="sub-chip" href="#/document/${esc(sub.id)}">${inline(sub.title)}</a>`).join("")}</div>` : ""}
          ${milestones.map(m => `<p class="milestone" dir="auto">◆ ${inline(m.title || plainText(m))} ${lineRef(m.line)}</p>`).join("")}
        </div>
      </li>`;
    };
    const w = hasDeps ? waves() : null;
    const timeline = w
      ? w.map((ids, k) => `<li class="wave"><p class="wave-head">Wave ${k + 1}${ids.length > 1 ? ` · ${ids.length} stages can run in parallel` : ""}</p>
          <ol class="timeline">${ids.map(card).join("")}</ol></li>`).join("")
      : R.ids.map(card).join("");
    return `
      <header class="page-head"><h1>Roadmap</h1><p class="muted">${basis} ${rules}</p></header>
      ${focus.length ? `<section class="focus">
        <p class="eyebrow">${focus.length > 1 ? "In progress" : "Current focus"}</p>
        ${focus.map(id => `<h2 dir="auto">${link(id)}</h2>${progressEl(id)}
          <ul class="tasklist">${tasksIn(id).filter(t => !isDone(t)).slice(0, focus.length > 1 ? 3 : 4).map(t =>
            `<li class="task">${checkbox(t.id, false)}<div><span class="t">${num(t.n)}${inline(t.text)}</span></div></li>`).join("")}</ul>`).join("")}
      </section>` : ""}
      ${ready.length ? `<p class="ready-list"><span class="eyebrow">Ready to start</span> ${ready.map(id => chip({ id })).join("")}</p>` : ""}
      ${w ? `<ol class="waves">${timeline}</ol>` : `<ol class="timeline">${timeline}</ol>`}`;
  }

  function viewTasks(filter = "all") {
    const keep = t => filter === "open" ? !isDone(t) : filter === "done" ? isDone(t) : true;
    const order = ["intro", ...model.sections.flatMap(s => [s.id, ...s.subsections.map(sub => sub.id)])];
    const groups = order
      .map(id => ({ id, ts: model.tasks.filter(t => t.at === id && keep(t)) }))
      .filter(g => g.ts.length);
    const tracked = (config.track || []).map(id => `“${plain(nodes[id].title)}”`).join(", ");
    const tab = (f, label) => `<a href="#/tasks/${f}" class="${filter === f ? "on" : ""}">${label}</a>`;
    return `
      <header class="page-head">
        <h1>Tasks</h1>
        <div class="overall">${progressEl("all")}</div>
        <div class="toolbar">
          <div class="tabs">${tab("all", "All")}${tab("open", "Open")}${tab("done", "Done")}</div>
          <button type="button" data-act="reset">Reset to Markdown</button>
        </div>
        <p class="muted small">${TOKEN
          ? `Checks are written to ${esc(model.file)}.${tracked ? ` Numbered steps in ${esc(tracked)} are shown as tasks; they have no checkbox in the Markdown, so their checks stay in this browser.` : ""}`
          : `${tracked ? `Numbered steps in ${esc(tracked)} are shown as tasks. ` : ""}Checks are saved in this browser only. The Markdown file is not changed.`}</p>
      </header>
      ${groups.length ? groups.map(g => `<section class="task-group">
        <div class="group-head"><h2 dir="auto">${nodes[g.id].parent ? `<span class="muted">${inline(nodes[nodes[g.id].parent].title)} ›</span> ` : ""}${link(g.id)}</h2>${progressEl(g.id)}</div>
        <ul class="tasklist">${g.ts.map(t => `<li class="task">${checkbox(t.id, isDone(t))}<div><span class="t">${num(t.n)}${inline(t.text)}</span> ${lineRef(t.line)}</div></li>`).join("")}</ul>
      </section>`).join("") : `<p class="empty">Nothing here.</p>`}`;
  }

  function viewHighlights(only) {
    const counts = countKinds();
    const kinds = Object.keys(counts).sort((a, b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b));
    const shown = kinds.filter(k => !only || k === only);
    return `
      <header class="page-head">
        <h1>Highlights</h1>
        <p class="muted">Decisions, risks, questions and other callouts found in the document.</p>
        <div class="tabs"><a href="#/highlights" class="${only ? "" : "on"}">All</a>${kinds.map(k =>
          `<a href="#/highlights/${k}" class="${only === k ? "on" : ""}">${cap(k)} <span class="muted">${counts[k]}</span></a>`).join("")}</div>
      </header>
      ${shown.map(k => `<section class="hl-group">
        <h2>${cap(k)}s</h2>
        <div class="hl-grid">${model.callouts.filter(c => c.kind === k).map(c => `
          <article class="hl" data-kind="${esc(k)}">
            <div class="hl-body">${blocks(c.blocks)}</div>
            <footer>${link(c.at)} ${lineRef(c.line)}${c.from_heading ? ` <span class="muted small">· listed under that heading</span>` : ""}</footer>
          </article>`).join("")}</div>
      </section>`).join("")}`;
  }

  function viewDiagrams() {
    const fromDoc = model.diagrams.map(d => `<section class="diagram-card">
      <header><h2 dir="auto">${link(d.at)} ${lineRef(d.line)}</h2><span class="badge source">From the document</span></header>
      ${diagram(d.text)}</section>`);
    const fromClaude = (config.diagrams || []).map((d, k) => `<section class="diagram-card inferred">
      <header><h2 dir="auto">${inline(d.title)}</h2><span class="badge">Inferred · drawn by Claude</span>${staleBadge(stale.diagrams.includes(k))}</header>
      ${d.description ? `<p class="muted" dir="auto">${inline(d.description)}</p>` : ""}
      ${diagram(d.mermaid)}
      ${d.sources?.length ? `<p class="small muted">Based on: ${d.sources.map(link).join(", ")}</p>` : ""}
    </section>`);
    return `<header class="page-head"><h1>Diagrams</h1></header>${[...fromDoc, ...fromClaude].join("") || `<p class="empty">No diagrams.</p>`}`;
  }

  function viewFiles(target) {
    const root = { dirs: {}, files: [] };
    model.files.forEach(f => {
      const parts = f.path.split("/").filter(Boolean);
      const name = f.path.endsWith("/") ? null : parts.pop();
      let node = root;
      parts.forEach(p => { node = node.dirs[p] ??= { dirs: {}, files: [] }; });
      if (name) node.files.push({ name, ...f });
      else node.refs = f.mentions || f.at.map(at => ({ at }));
    });
    const refs = ms => (ms || []).map(m => `<a class="ref" href="#/document/${esc(m.at)}">${inline(nodes[m.at]?.title ?? m.at)}</a>${lineRef(m.line)}`).join("");
    const tree = node => `<ul class="tree">${
      Object.entries(node.dirs).sort().map(([name, d]) =>
        `<li><details open><summary><span class="dir">${esc(name)}/</span>${refs(d.refs)}</summary>${tree(d)}</details></li>`).join("") +
      node.files.sort((a, b) => a.name.localeCompare(b.name)).map(f =>
        `<li class="file${f.path === target ? " hit" : ""}" id="file:${esc(f.path)}"><code>${esc(f.name)}</code>${refs(f.mentions || f.at.map(at => ({ at })))}</li>`).join("")
    }</ul>`;
    return `<header class="page-head"><h1>Files</h1><p class="muted">Every file path the document mentions, and where it is mentioned.</p></header>
      <div class="tree-wrap">${tree(root)}</div>`;
  }

  function viewSteps(n) {
    const steps = model.sections;
    if (!steps.length) return `<p class="empty">No sections to step through.</p>`;
    const i = Math.min(Math.max((parseInt(n, 10) || 1) - 1, 0), steps.length - 1);
    const s = steps[i];
    const nav = (j, label) => j >= 0 && j < steps.length
      ? `<a class="step-link" href="#/steps/${j + 1}">${label}</a>` : `<span></span>`;
    return `<div class="steps">
      <nav class="dots" aria-label="Steps">${steps.map((x, j) =>
        `<a href="#/steps/${j + 1}" class="${j === i ? "on" : ""} ${understood[x.id] ? "ok" : ""}" title="${esc(plain(x.title))}"></a>`).join("")}</nav>
      <p class="eyebrow">Step ${i + 1} of ${steps.length}</p>
      <article class="prose step">
        <h1 dir="auto">${inline(s.title)}</h1>
        ${progressEl(s.id)}
        ${note(s.id)}
        ${blocks(s.blocks)}
        ${s.subsections.map(sub => sectionHTML(sub, 2)).join("")}
      </article>
      <footer class="step-nav">
        ${nav(i - 1, "← Previous")}
        <button type="button" data-act="understood" data-id="${esc(s.id)}" class="${understood[s.id] ? "on" : ""}">${understood[s.id] ? "✓ Understood" : "Mark as understood"}</button>
        ${nav(i + 1, "Next →")}
      </footer>
    </div>`;
  }

  function viewSearch(q) {
    const needle = q.toLowerCase();
    const hits = [];
    Object.values(nodes).forEach(node => {
      if (plain(node.title).toLowerCase().includes(needle)) hits.push({ id: node.id, snippet: "" });
      node.blocks.forEach(b => {
        const t = plainText(b);
        const k = t.toLowerCase().indexOf(needle);
        if (k >= 0) hits.push({ id: node.id, snippet: t.slice(Math.max(0, k - 60), k + needle.length + 90) });
      });
    });
    const mark = s => esc(s).replace(new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), m => `<mark>${m}</mark>`);
    return `<header class="page-head"><h1>Search</h1><p class="muted">${hits.length} result${hits.length === 1 ? "" : "s"} for “${esc(q)}”</p></header>
      <div class="hits">${hits.slice(0, 80).map(h => `<a class="hit" href="#/document/${esc(h.id)}">
        <strong dir="auto">${inline(nodes[h.id].title)}</strong>${h.snippet ? `<span dir="auto">…${mark(h.snippet)}…</span>` : ""}</a>`).join("")}</div>`;
  }

  // Always available (not a menu view): the Markdown with line numbers, one line highlighted.
  function viewSource(n) {
    const hit = parseInt(n, 10) || 0;
    return `<header class="page-head"><h1>Source</h1><p class="muted">${esc(model.file)}${hit ? ` · line ${hit}` : ""} · exactly as written</p></header>
      <ol class="src">${model.source.split("\n").map((l, k) =>
        `<li id="L${k + 1}"${k + 1 === hit ? ' class="hit"' : ""}><code dir="auto">${esc(l) || " "}</code></li>`).join("")}</ol>`;
  }

  const VIEWS = {
    overview: viewOverview, document: viewDocument, roadmap: viewRoadmap, tasks: viewTasks,
    highlights: viewHighlights, diagrams: viewDiagrams, files: viewFiles, steps: viewSteps, source: viewSource,
  };

  // ---------- chrome: sidebar, routing, events ----------

  function sidebar() {
    document.title = plain(model.title);
    document.getElementById("brand").innerHTML = `<span>${inline(model.title)}</span>`;
    if (config.accent) document.documentElement.style.setProperty("--accent", config.accent);
    const badge = v => {
      if (v === "tasks") { const p = progress(model.tasks); return `${p.done}/${p.total}`; }
      if (v === "highlights") return model.callouts.length;
      return "";
    };
    document.getElementById("views").innerHTML = config.views.map(v =>
      `<a href="#/${esc(v)}" data-view="${esc(v)}">${VIEW_LABELS[v]}<span class="muted" data-badge="${esc(v)}">${badge(v)}</span></a>`).join("");
    document.getElementById("toc").innerHTML = `<p class="label">Contents</p>` + model.sections.map(s =>
      `<a href="#/document/${esc(s.id)}" data-id="${esc(s.id)}" dir="auto">${inline(s.title)}</a>` +
      s.subsections.map(sub => `<a href="#/document/${esc(sub.id)}" data-id="${esc(sub.id)}" class="sub" dir="auto">${inline(sub.title)}</a>`).join("")).join("");
  }

  function parseRoute() {
    const h = decodeURIComponent(location.hash);
    if (h.length > 1 && !h.startsWith("#/")) return { view: "document", arg: h.slice(1) };  // plain #anchor from the Markdown
    const [view, ...rest] = h.replace(/^#\/?/, "").split("/");
    return { view: has(view) || view === "source" ? view : config.views[0], arg: rest.join("/") };
  }

  let spy;
  function render(keepScroll = false) {
    const { view, arg } = parseRoute();
    const y = window.scrollY;
    main.innerHTML = VIEWS[view](arg);
    main.className = "view-" + view;
    document.querySelectorAll("#views a").forEach(a => a.classList.toggle("active", a.dataset.view === view));
    document.querySelector('[data-badge="tasks"]')?.replaceChildren(`${progress(model.tasks).done}/${model.tasks.length}`);
    refreshProgress();
    renderMermaid();
    scrollSpy(view === "document");
    const target = view === "document" && arg ? document.getElementById(arg)
      : view === "files" && arg ? document.getElementById("file:" + arg)
      : view === "source" && arg ? document.getElementById("L" + arg) : null;
    if (target) {
      for (let d = target.closest("details"); d; d = d.parentElement.closest("details")) d.open = true;
      target.scrollIntoView({ block: view === "source" ? "center" : "start" });
    } else window.scrollTo(0, keepScroll ? y : 0);
  }

  function scrollSpy(on) {
    spy?.disconnect();
    document.querySelectorAll("#toc a").forEach(a => a.classList.remove("active"));
    if (!on) return;
    spy = new IntersectionObserver(entries => entries.forEach(e => {
      if (!e.isIntersecting) return;
      document.querySelectorAll("#toc a").forEach(a => a.classList.toggle("active", a.dataset.id === e.target.parentElement.id));
    }), { rootMargin: "0px 0px -70% 0px" });
    main.querySelectorAll("details.sec > summary").forEach(s => spy.observe(s));
  }

  // Mermaid is the only external resource, loaded only when a diagram is on screen.
  let mermaidReady;
  function renderMermaid() {
    const els = [...main.querySelectorAll("pre.mermaid:not([data-processed])")];
    if (!els.length) return;
    mermaidReady ??= new Promise((ok, fail) => {
      const s = Object.assign(document.createElement("script"),
        { src: MERMAID_SRC, integrity: MERMAID_SRI, crossOrigin: "anonymous", referrerPolicy: "no-referrer", onload: ok, onerror: fail });
      document.head.append(s);
    }).then(() => window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: isDark() ? "dark" : "neutral" }));
    mermaidReady
      .then(() => window.mermaid.run({ nodes: els, suppressErrors: true }))
      .catch(() => {})
      .finally(() => els.forEach(el => { if (!el.querySelector("svg")) el.closest(".diagram")?.classList.add("offline"); }));
  }

  const isDark = () => document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);

  // ---------- served mode: write to the Markdown, follow its changes ----------
  const api = (path, body) => fetch(path, {
    method: body ? "POST" : "GET",
    headers: { "X-Too-Long-Token": TOKEN, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body && JSON.stringify(body),
  }).then(r => r.json().then(j => ({ ...j, ok: r.ok, status: r.status })));

  // New data.js on disk: reload, keeping the place (the route is in the hash; checks are in localStorage).
  function reloadKeepingPlace() {
    try { sessionStorage.setItem("too-long:scroll", String(window.scrollY)); } catch {}
    location.reload();
  }

  function notify(text) {
    let el = document.getElementById("notice");
    if (!el) {
      el = Object.assign(document.createElement("div"), { id: "notice", role: "status" });
      document.body.append(el);
    }
    el.textContent = text;
    el.hidden = false;
    clearTimeout(notify.t);
    notify.t = setTimeout(() => { el.hidden = true; }, 4000);
  }

  function writeTask(box) {
    const id = box.dataset.task, done = box.checked;
    document.querySelectorAll(`[data-task="${CSS.escape(id)}"]`).forEach(b => { b.disabled = true; });
    api("/api/task", { id, done, revision: model.revision }).then(r => {
      if (r.ok) return reloadKeepingPlace();
      throw r;
    }).catch(r => {
      document.querySelectorAll(`[data-task="${CSS.escape(id)}"]`).forEach(b => { b.checked = !done; b.disabled = false; });
      if (r.status === 409) { notify("The Markdown changed since this page loaded. Reloading…"); setTimeout(reloadKeepingPlace, 1200); }
      else notify(`Not saved: ${r.error || "the too-long server is not reachable"}`);
    });
  }

  if (TOKEN) {  // follow edits made in an editor (serve.py rebuilds on save)
    setInterval(() => {
      if (document.hidden) return;
      api("/api/state").then(r => { if (r.ok && r.revision && r.revision !== model.revision) reloadKeepingPlace(); }).catch(() => {});
    }, 1500);
  }

  document.addEventListener("change", e => {
    const id = e.target.dataset?.task;
    if (!id) return;
    if (synced(id)) return writeTask(e.target);
    checks[id] = { done: e.target.checked, sig: taskById[id]?.sig };
    save("tasks", checks);
    const { view } = parseRoute();
    if (view === "roadmap" || view === "overview") return render(true);
    document.querySelectorAll(`[data-task="${CSS.escape(id)}"]`).forEach(b => { b.checked = e.target.checked; });
    document.querySelector('[data-badge="tasks"]')?.replaceChildren(`${progress(model.tasks).done}/${model.tasks.length}`);
    refreshProgress();
  });

  document.addEventListener("click", e => {
    const file = e.target.closest("code.file-ref");
    if (file) { location.hash = "#/files/" + file.dataset.file; return; }
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === "copy") {
      e.preventDefault();
      navigator.clipboard?.writeText(btn.closest(".code").querySelector("pre").textContent)
        .then(() => { btn.textContent = "Copied"; setTimeout(() => { btn.textContent = "Copy"; }, 1200); });
    } else if (act === "expand" || act === "collapse") {
      main.querySelectorAll("details.sec").forEach(d => { d.open = act === "expand"; });
    } else if (act === "raw") {
      const raw = main.querySelector(".raw");
      raw.hidden = !raw.hidden;
      btn.textContent = raw.hidden ? "Markdown source" : "Hide source";
    } else if (act === "understood") {
      understood[btn.dataset.id] = !understood[btn.dataset.id];
      save("steps", understood);
      render(true);
    } else if (act === "reset" && confirm(TOKEN
      ? "Clear the checks saved in this browser (numbered steps)? Checkboxes in the Markdown are not changed."
      : "Clear the checks saved in this browser and go back to the Markdown's [ ] / [x]?")) {
      checks = {};
      save("tasks", checks);
      render(true);
    }
  });

  document.getElementById("theme").addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("too-long:theme", next); } catch {}
  });

  const search = document.getElementById("search");
  search.addEventListener("input", () => {
    const q = search.value.trim();
    if (q.length < 2) return render();
    main.innerHTML = viewSearch(q);
    main.className = "view-search";
  });

  document.addEventListener("keydown", e => {
    const typing = /input|textarea/i.test(document.activeElement?.tagName);
    if (e.key === "/" && !typing) { e.preventDefault(); search.focus(); return; }
    if (e.key === "Escape" && document.activeElement === search) { search.value = ""; search.blur(); render(); return; }
    if (typing || parseRoute().view !== "steps") return;
    const n = (parseInt(parseRoute().arg, 10) || 1) + (e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0);
    if (n >= 1 && n <= model.sections.length && e.key.startsWith("Arrow")) location.hash = "#/steps/" + n;
  });

  window.addEventListener("hashchange", () => { search.value = ""; render(); });
  sidebar();
  render();
  try {  // back to where the reader was before a served-mode reload
    const y = sessionStorage.getItem("too-long:scroll");
    if (y !== null) { sessionStorage.removeItem("too-long:scroll"); window.scrollTo(0, +y); }
  } catch {}
})();
