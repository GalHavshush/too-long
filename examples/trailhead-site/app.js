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
  const MERMAID_SRC = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";

  // ---------- lookups ----------
  const nodes = { intro: { id: "intro", title: "Introduction", blocks: model.intro } };
  model.sections.forEach(s => {
    nodes[s.id] = s;
    s.subsections.forEach(sub => { nodes[sub.id] = { ...sub, parent: s.id }; });
  });
  const fileSet = new Set(model.files.map(f => f.path));
  const has = v => config.views.includes(v);

  // ---------- per-browser state (never written back to the Markdown) ----------
  const KEY = "too-long:" + model.title;
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(`${KEY}:${k}`)) ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(`${KEY}:${k}`, JSON.stringify(v)); } catch {} };
  let checks = load("tasks", {});      // task id -> checked, overrides the Markdown's [ ] / [x]
  let understood = load("steps", {});  // section id -> true

  const isDone = t => checks[t.id] ?? t.done;
  const tasksIn = id => id === "all" ? model.tasks : model.tasks.filter(t => t.at === id || t.section === id);
  const progress = ts => {
    const done = ts.filter(isDone).length;
    return { done, total: ts.length, pct: ts.length ? Math.round((done / ts.length) * 100) : 0 };
  };

  // ---------- Markdown rendering ----------
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const plain = s => String(s).replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`~]/g, "");
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

  function href(u) {
    if (/^\s*(javascript|data|vbscript):/i.test(u)) return "#";
    if (/^([a-z][\w+.-]*:|#|\/)/i.test(u)) return u;
    return (model.base && model.base !== "." ? model.base + "/" : "") + u;  // relative to the .md file
  }

  function inline(md) {
    const codes = [];
    let s = String(md).replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, __, c) => `\u0000${codes.push(c.trim()) - 1}\u0000`);
    s = esc(s);
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, alt, src) => `<img src="${href(src)}" alt="${alt}">`);
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, text, u) =>
      `<a href="${href(u)}"${/^https?:/.test(u) ? ' target="_blank" rel="noopener"' : ""}>${text}</a>`);
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    s = s.replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`);
    s = s.replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^\w])_(?!\s)(.+?)_(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/~~(.+?)~~/g, "<del>$1</del>");
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => {
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

  const checkbox = (id, done) => `<input type="checkbox" data-task="${id}"${done ? " checked" : ""} aria-label="Done">`;
  const kindChip = k => `<span class="chip" data-kind="${k}">${cap(k)}</span>`;
  const callout = (kind, html) =>
    `<aside class="callout" data-kind="${kind}"><div class="callout-label">${cap(kind)}</div><div class="callout-body">${html}</div></aside>`;

  // Everything Claude wrote (config) is labelled as inferred.
  const inferred = (label, html) =>
    `<aside class="callout inferred"><div class="callout-label">${label} <span class="badge">Inferred · not in the original</span></div><div class="callout-body">${html}</div></aside>`;
  const note = id => config.notes?.[id] ? inferred("Claude's note", paragraphs(config.notes[id])) : "";
  const paragraphs = t => Array.isArray(t)
    ? `<ul>${t.map(x => `<li>${inline(x)}</li>`).join("")}</ul>`
    : String(t).split(/\n{2,}/).map(p => `<p>${inline(p)}</p>`).join("");

  const progressEl = scope => tasksIn(scope).length ? `<span class="progress" data-scope="${scope}"></span>` : "";
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

  const link = id => `<a href="#/document/${id}">${inline(nodes[id]?.title ?? id)}</a>`;
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
      ${config.tldr ? inferred("TL;DR", paragraphs(config.tldr)) : ""}
      <div class="stats">${stats.map(([n, l]) => `<div class="stat"><strong>${n}</strong><span>${esc(l)}</span></div>`).join("")}</div>
      ${p.total ? `<div class="overall">${progressEl("all")}</div>` : ""}
      ${model.intro.length ? `<section class="prose intro">${blocks(model.intro)}</section>` : ""}
      <h2 class="label">Sections</h2>
      <div class="cards">${model.sections.map(s => {
        const k = countKinds(s.id);
        return `<a class="card" href="#/document/${s.id}">
          <h3 dir="auto">${inline(s.title)}</h3>
          ${excerpt(s)}
          <div class="card-meta">
            ${s.subsections.length ? `<span class="muted">${s.subsections.length} parts</span>` : ""}
            ${Object.entries(k).map(([kind, n]) => `<span class="chip" data-kind="${kind}">${n} ${kind}</span>`).join("")}
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
    return `<details class="sec l${level}" id="${node.id}" open>
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

  function viewRoadmap() {
    const phases = model.roadmap.ids.map(id => ({ s: nodes[id], p: progress(tasksIn(id)) }));
    let current = null;
    phases.forEach(x => {
      x.status = !x.p.total ? "" : x.p.done === x.p.total ? "done" : current ? "upcoming" : "current";
      if (x.status === "current") current = x;
    });
    const basis = {
      titles: "Stages are the sections whose titles read like phases or steps.",
      sections: "Each top-level section is shown as a stage, in document order.",
      config: "Stages are the parts of the document chosen for this roadmap, in document order.",
    }[model.roadmap.basis];
    const open = current ? tasksIn(current.s.id).filter(t => !isDone(t)).slice(0, 4) : [];
    return `
      <header class="page-head"><h1>Roadmap</h1><p class="muted">${basis}</p></header>
      ${current ? `<section class="focus">
        <p class="eyebrow">Current focus</p>
        <h2 dir="auto">${link(current.s.id)}</h2>
        ${progressEl(current.s.id)}
        <ul class="tasklist">${open.map(t => `<li class="task">${checkbox(t.id, false)}<div><span class="t">${num(t.n)}${inline(t.text)}</span></div></li>`).join("")}</ul>
      </section>` : ""}
      <ol class="timeline">${phases.map(({ s, status }, i) => {
        const milestones = model.callouts.filter(c => c.kind === "milestone" && (c.at === s.id || c.section === s.id));
        const subs = s.subsections || [];
        return `<li class="phase ${status}">
          <span class="node">${status === "done" ? "✓" : i + 1}</span>
          <div class="phase-body">
            <div class="phase-head"><h3 dir="auto">${link(s.id)}</h3>${status ? `<span class="status">${status}</span>` : ""}</div>
            ${excerpt(s, 220)}
            ${progressEl(s.id)}
            ${subs.length ? `<div class="subs">${subs.map(sub => `<a class="sub-chip" href="#/document/${sub.id}">${inline(sub.title)}</a>`).join("")}</div>` : ""}
            ${milestones.map(m => `<p class="milestone" dir="auto">◆ ${inline(plainText(m))}</p>`).join("")}
          </div>
        </li>`;
      }).join("")}</ol>`;
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
        <p class="muted small">${tracked ? `Numbered steps in ${esc(tracked)} are shown as tasks. ` : ""}Checks are saved in this browser only. The Markdown file is not changed.</p>
      </header>
      ${groups.length ? groups.map(g => `<section class="task-group">
        <div class="group-head"><h2 dir="auto">${nodes[g.id].parent ? `<span class="muted">${inline(nodes[nodes[g.id].parent].title)} ›</span> ` : ""}${link(g.id)}</h2>${progressEl(g.id)}</div>
        <ul class="tasklist">${g.ts.map(t => `<li class="task">${checkbox(t.id, isDone(t))}<div><span class="t">${num(t.n)}${inline(t.text)}</span></div></li>`).join("")}</ul>
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
          <article class="hl" data-kind="${k}">
            <div class="hl-body">${blocks(c.blocks)}</div>
            <footer>${link(c.at)}${c.from_heading ? ` <span class="muted small">· listed under that heading</span>` : ""}</footer>
          </article>`).join("")}</div>
      </section>`).join("")}`;
  }

  function viewDiagrams() {
    const fromDoc = model.diagrams.map(d => `<section class="diagram-card">
      <header><h2 dir="auto">${link(d.at)}</h2><span class="badge source">From the document</span></header>
      ${diagram(d.text)}</section>`);
    const fromClaude = (config.diagrams || []).map(d => `<section class="diagram-card inferred">
      <header><h2 dir="auto">${inline(d.title)}</h2><span class="badge">Inferred · drawn by Claude</span></header>
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
      else node.refs = f.at;
    });
    const refs = at => (at || []).map(id => `<a class="ref" href="#/document/${id}">${inline(nodes[id]?.title ?? id)}</a>`).join("");
    const tree = node => `<ul class="tree">${
      Object.entries(node.dirs).sort().map(([name, d]) =>
        `<li><details open><summary><span class="dir">${esc(name)}/</span>${refs(d.refs)}</summary>${tree(d)}</details></li>`).join("") +
      node.files.sort((a, b) => a.name.localeCompare(b.name)).map(f =>
        `<li class="file${f.path === target ? " hit" : ""}" id="file:${esc(f.path)}"><code>${esc(f.name)}</code>${refs(f.at)}</li>`).join("")
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
        <button type="button" data-act="understood" data-id="${s.id}" class="${understood[s.id] ? "on" : ""}">${understood[s.id] ? "✓ Understood" : "Mark as understood"}</button>
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
      <div class="hits">${hits.slice(0, 80).map(h => `<a class="hit" href="#/document/${h.id}">
        <strong dir="auto">${inline(nodes[h.id].title)}</strong>${h.snippet ? `<span dir="auto">…${mark(h.snippet)}…</span>` : ""}</a>`).join("")}</div>`;
  }

  const VIEWS = {
    overview: viewOverview, document: viewDocument, roadmap: viewRoadmap, tasks: viewTasks,
    highlights: viewHighlights, diagrams: viewDiagrams, files: viewFiles, steps: viewSteps,
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
      `<a href="#/${v}" data-view="${v}">${VIEW_LABELS[v]}<span class="muted" data-badge="${v}">${badge(v)}</span></a>`).join("");
    document.getElementById("toc").innerHTML = `<p class="label">Contents</p>` + model.sections.map(s =>
      `<a href="#/document/${s.id}" data-id="${s.id}" dir="auto">${inline(s.title)}</a>` +
      s.subsections.map(sub => `<a href="#/document/${sub.id}" data-id="${sub.id}" class="sub" dir="auto">${inline(sub.title)}</a>`).join("")).join("");
  }

  function parseRoute() {
    const h = decodeURIComponent(location.hash);
    if (h.length > 1 && !h.startsWith("#/")) return { view: "document", arg: h.slice(1) };  // plain #anchor from the Markdown
    const [view, ...rest] = h.replace(/^#\/?/, "").split("/");
    return { view: has(view) ? view : config.views[0], arg: rest.join("/") };
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
      : view === "files" && arg ? document.getElementById("file:" + arg) : null;
    if (target) {
      for (let d = target.closest("details"); d; d = d.parentElement.closest("details")) d.open = true;
      target.scrollIntoView({ block: "start" });
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
      const s = Object.assign(document.createElement("script"), { src: MERMAID_SRC, onload: ok, onerror: fail });
      document.head.append(s);
    }).then(() => window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: isDark() ? "dark" : "neutral" }));
    mermaidReady
      .then(() => window.mermaid.run({ nodes: els, suppressErrors: true }))
      .catch(() => {})
      .finally(() => els.forEach(el => { if (!el.querySelector("svg")) el.closest(".diagram")?.classList.add("offline"); }));
  }

  const isDark = () => document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);

  document.addEventListener("change", e => {
    const id = e.target.dataset?.task;
    if (!id) return;
    checks[id] = e.target.checked;
    save("tasks", checks);
    const { view } = parseRoute();
    if (view === "roadmap" || view === "overview") return render(true);
    document.querySelectorAll(`[data-task="${id}"]`).forEach(b => { b.checked = e.target.checked; });
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
    } else if (act === "reset" && confirm("Clear the checks saved in this browser and go back to the Markdown's [ ] / [x]?")) {
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
})();
