/* too-long video player. Draws one frame per call of window.seek(t).
   Every animation is a pure function of time (no CSS transitions), so frames are deterministic
   and the renderer (render_video.mjs) can capture them one by one.

   Scene types: title, points, cards, timeline, flow, code, files. Each builder gets the scene and
   its root element, and returns update(s, cue), where s = seconds since the scene started.
   cue(i, n) = when the i-th of n items should appear, spread across the narration. */
(() => {
  "use strict";
  const V = window.VIDEO;
  document.documentElement.style.setProperty("--accent", V.accent);
  const stage = document.getElementById("stage");
  const W = 1136, H = 400; // size of the .body area

  // ---------- helpers ----------
  const clamp = (x) => Math.min(1, Math.max(0, x));
  const ease = (x) => 1 - Math.pow(1 - clamp(x), 3);
  const at = (s, start, d = 0.5) => ease((s - start) / d);
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const rich = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
  const div = (cls, html = "", parent) => {
    const e = document.createElement("div");
    e.className = cls;
    e.innerHTML = html;
    parent?.append(e);
    return e;
  };
  const show = (e, p, dy = 18) => { e.style.opacity = p; e.style.transform = `translateY(${(1 - p) * dy}px)`; };

  // ---------- scene builders ----------
  const builders = {
    title(sc, root) {
      const box = div("title", `<div class="bar"></div><h1>${rich(sc.heading)}</h1>${sc.subtitle ? `<p>${rich(sc.subtitle)}</p>` : ""}`, root);
      const parts = [...box.children];
      return (s) => parts.forEach((p, i) => show(p, at(s, 0.2 + i * 0.25, 0.7), 24));
    },

    points(sc, root) {
      const body = div("body", "", root);
      const rows = sc.items.map((t, i) => div("row", `<span class="n">${i + 1}</span><span>${rich(t)}</span>`, body));
      return (s, cue) => rows.forEach((r, i) => {
        const p = at(s, cue(i, rows.length), 0.5);
        const next = i + 1 < rows.length ? at(s, cue(i + 1, rows.length), 0.4) : 0;
        r.style.opacity = p * (1 - 0.45 * next);          // the newest point is the brightest
        r.style.transform = `translateX(${(1 - p) * 40}px)`;
      });
    },

    cards(sc, root) {
      const body = div("body", "", root);
      const grid = div("cards", "", body);
      grid.style.gridTemplateColumns = `repeat(${Math.min(sc.items.length, 3)}, 1fr)`;
      const cards = sc.items.map((it) => {
        const c = div("card", `${it.kind ? `<span class="chip">${esc(it.kind)}</span><br>` : ""}<h3>${rich(it.label || "")}</h3>${it.text ? `<p>${rich(it.text)}</p>` : ""}`, grid);
        if (it.kind) c.dataset.kind = it.kind;
        return c;
      });
      return (s, cue) => cards.forEach((c, i) => show(c, at(s, cue(i, cards.length), 0.55), 30));
    },

    timeline(sc, root) {
      const body = div("body", "", root);
      const n = sc.phases.length;
      const pad = Math.max(60, Math.min(150, W / (2 * n))); // room for the first and last label
      const x = (i) => (n === 1 ? W / 2 : pad + (i * (W - 2 * pad)) / (n - 1));
      const step = n === 1 ? W : (W - 2 * pad) / (n - 1);
      div("tl-line", "", body).style.cssText = `left:${x(0)}px;width:${x(n - 1) - x(0)}px`;
      const fill = div("tl-fill", "", body);
      fill.style.left = `${x(0)}px`;
      const items = sc.phases.map((ph, i) => {
        const node = div("tl-node" + (ph.milestone ? " ms" : ""), ph.milestone ? "" : String(i + 1), body);
        node.style.left = `${x(i)}px`;
        const text = div("tl-text", `<b>${rich(ph.label)}</b>${ph.detail ? `<span>${rich(ph.detail)}</span>` : ""}`, body);
        const tw = Math.min(step - 14, 300);
        text.style.width = `${tw}px`;
        text.style.left = `${Math.min(Math.max(x(i), tw / 2), W - tw / 2) - tw / 2}px`;
        return { node, text };
      });
      return (s, cue) => {
        let reached = 0;
        items.forEach((it, i) => {
          const p = at(s, cue(i, n), 0.5);
          if (p > 0.05) reached = i;
          it.node.style.opacity = p;
          it.node.style.transform = `scale(${0.6 + 0.4 * p}) ${sc.phases[i].milestone ? "rotate(45deg)" : ""}`;
          show(it.text, p, 14);
        });
        const last = items.length > 1 ? at(s, cue(reached, n), 0.5) : 0;
        fill.style.width = `${Math.max(0, x(reached) - x(0) - (1 - last) * step)}px`;
      };
    },

    flow(sc, root) {
      const body = div("body", "", root);
      const box = div("flow", "", body);
      const nodes = sc.nodes, ids = nodes.map((n) => n.id);
      // layer = longest path from a node with no incoming edge (capped, so a cycle cannot loop forever)
      const layer = Object.fromEntries(ids.map((id) => [id, 0]));
      for (let k = 0; k < ids.length; k++) sc.edges.forEach(([a, b]) => { if (layer[b] <= layer[a] && layer[a] + 1 < ids.length) layer[b] = layer[a] + 1; });
      ids.forEach((id) => {
        const targets = sc.edges.filter(([a]) => a === id).map(([, b]) => layer[b]);
        if (targets.length && !sc.edges.some(([, b]) => b === id)) layer[id] = Math.max(0, Math.min(...targets) - 1);
      });
      const L = Math.max(...Object.values(layer)) + 1;
      const gap = L > 1 ? 74 : 0;
      const bw = Math.min(250, (W - gap * (L - 1)) / L), bh = 82;
      const cols = Array.from({ length: L }, () => []);
      nodes.forEach((n) => cols[layer[n.id]].push(n.id));
      const pos = {};
      cols.forEach((col, c) => col.forEach((id, r) => {
        const rowGap = Math.min(40, (H - col.length * bh) / Math.max(1, col.length - 1));
        const total = col.length * bh + (col.length - 1) * rowGap;
        pos[id] = { x: c * (bw + gap) + (L > 1 ? 0 : (W - bw) / 2), y: (H - total) / 2 + r * (bh + rowGap) };
      }));
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("width", W); svg.setAttribute("height", H);
      svg.innerHTML = `<defs><marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#a39f95"/></marker></defs>`;
      box.append(svg);
      const els = {};
      nodes.forEach((n) => {
        const e = div("node", rich(n.label), box);
        Object.assign(e.style, { left: `${pos[n.id].x}px`, top: `${pos[n.id].y}px`, width: `${bw}px`, height: `${bh}px` });
        if (n.label.length > 16 || n.label.split(" ").some((w) => w.length > 11)) e.style.fontSize = "19px";
        els[n.id] = e;
      });
      const edges = sc.edges.map(([a, b]) => {
        const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p.setAttribute("class", "edge");
        p.setAttribute("pathLength", 1);
        const A = pos[a], B = pos[b];
        if (layer[b] > layer[a]) {          // normal: right side of a to left side of b
          const x1 = A.x + bw, y1 = A.y + bh / 2, x2 = B.x, y2 = B.y + bh / 2, m = (x2 - x1) / 2;
          p.setAttribute("d", `M${x1} ${y1} C${x1 + m} ${y1} ${x2 - m} ${y2} ${x2 - 4} ${y2}`);
        } else {                            // same layer or backwards: arc over the top
          const x1 = A.x + bw / 2, y1 = A.y, x2 = B.x + bw / 2, y2 = B.y;
          p.setAttribute("d", `M${x1} ${y1} C${x1} ${y1 - 70} ${x2} ${y2 - 70} ${x2} ${y2 - 4}`);
        }
        svg.append(p);
        return { p, a: ids.indexOf(a), b: ids.indexOf(b) };
      });
      return (s, cue) => {
        const n = nodes.length;
        nodes.forEach((nd, i) => {
          const p = at(s, cue(i, n), 0.45);
          els[nd.id].style.opacity = p;
          els[nd.id].style.transform = `scale(${0.9 + 0.1 * p})`;
        });
        edges.forEach(({ p, a, b }) => {
          const t = ease((s - Math.max(cue(a, n), cue(b, n)) - 0.25) / 0.5);
          p.style.strokeDasharray = 1;
          p.style.strokeDashoffset = 1 - t;
          p.style.opacity = t > 0.01 ? 1 : 0;
          if (t > 0.97) p.setAttribute("marker-end", "url(#arr)"); else p.removeAttribute("marker-end");
        });
      };
    },

    code(sc, root) {
      const body = div("body", "", root);
      const lines = sc.code.replace(/\n+$/, "").split("\n");
      const longest = Math.max(...lines.map((l) => l.length), 1);
      const size = Math.max(16, Math.min(28, H / (lines.length * 1.5 + 3), 1060 / (longest * 0.62)));
      const panel = div("panel", `<div class="top"><i></i><i></i><i></i><span>${esc(sc.lang || sc.file || "")}</span></div>`, body);
      const box = div("lines", "", panel);
      box.style.fontSize = `${size}px`;
      box.style.lineHeight = "1.5";
      const els = lines.map((l) => div("line", esc(l) || " ", box));
      return (s, cue) => els.forEach((e, i) => {
        const p = at(s, cue(i, els.length), 0.3);
        e.style.opacity = p;
        const nextAt = i + 1 < els.length ? cue(i + 1, els.length) : Infinity;
        e.classList.toggle("cur", s >= cue(i, els.length) && s < nextAt);
      });
    },

    files(sc, root) {
      const body = div("body", "", root);
      const tree = {};
      sc.paths.forEach((p) => p.split("/").filter(Boolean).reduce((node, part) => (node[part] ??= {}), tree));
      const rows = [];
      const walk = (node, depth) => Object.entries(node).forEach(([name, kids]) => {
        const dir = Object.keys(kids).length > 0 || sc.paths.some((p) => p.replace(/\/$/, "").endsWith(name) && p.endsWith("/"));
        rows.push({ depth, name: dir ? name + "/" : name, dir });
        walk(kids, depth + 1);
      });
      walk(tree, 0);
      const size = Math.max(16, Math.min(28, (H - 60) / (rows.length * 1.5)));
      const panel = div("panel", `<div class="top"><i></i><i></i><i></i><span>files</span></div>`, body);
      const box = div("lines", "", panel);
      box.style.fontSize = `${size}px`;
      box.style.lineHeight = "1.5";
      const els = rows.map((r) => div("line", `${"    ".repeat(r.depth)}<span class="${r.dir ? "dir" : ""}">${esc(r.name)}</span>`, box));
      return (s, cue) => els.forEach((e, i) => {
        e.style.opacity = at(s, cue(i, els.length), 0.3);
        e.classList.toggle("cur", s >= cue(i, els.length) && s < (i + 1 < els.length ? cue(i + 1, els.length) : Infinity));
      });
    },
  };

  // ---------- build every scene once ----------
  const scenes = V.scenes.map((sc) => {
    const root = div("scene", "", stage);
    if (sc.type !== "title") root.append(div("head", `<div class="bar"></div><h2>${rich(sc.heading)}</h2>`));
    if (sc.inferred) div("badge", "Inferred · not in the original", root);
    const update = builders[sc.type](sc, root);
    // narration window: items appear between just after the voice starts and 85% through it
    const a = V.lead + 0.25, b = V.lead + sc.speech * 0.85;
    const cue = (i, n) => (n <= 1 ? a : a + ((b - a) * i) / n);
    // captions: one sentence at a time, timed by how much of the text has been spoken
    const sentences = sc.narration.split(/(?<=[.!?])\s+/).filter(Boolean);
    const chars = sentences.reduce((sum, x) => sum + x.length, 0);
    let acc = 0;
    const spans = sentences.map((text) => {
      const from = V.lead + (sc.speech * acc) / chars;
      acc += text.length;
      return { text, from, to: V.lead + (sc.speech * acc) / chars };
    });
    return { sc, root, update, cue, spans };
  });

  const cap = div("", "", stage);
  cap.id = "cap";
  const prog = div("", "", stage);
  prog.id = "prog";

  // ---------- the one entry point ----------
  window.seek = (t) => {
    let caption = "";
    scenes.forEach(({ sc, root, update, cue, spans }) => {
      const s = t - sc.start;
      const active = s >= 0 && s < sc.dur;
      root.style.display = active ? "block" : "none";
      if (!active) return;
      root.style.opacity = Math.min(at(s, 0, 0.45), 1 - at(s - (sc.dur - 0.35), 0, 0.35));
      update(s, cue);
      const hit = spans.find((x, i) => s >= x.from && (s < x.to || i === spans.length - 1));
      if (hit && s < V.lead + sc.speech + 0.4) caption = hit.text;
    });
    cap.textContent = caption;
    cap.style.visibility = caption ? "visible" : "hidden";
    prog.style.width = `${(t / V.total) * 100}%`;
  };
  window.seek(+(location.hash.match(/t=([\d.]+)/) || [])[1] || 0); // player.html#t=52 previews one frame
})();
