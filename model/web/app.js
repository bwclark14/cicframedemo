/* Curriculum Explorer
 * Static browser for CIC Know-Do-Understand frameworks.
 * Reads ../data/areas.json and each <area>.area.json (see curriculum.schema.json).
 *
 * Routes (hash):
 *   #/<area>/overview
 *   #/<area>/level/<level>[/<strand>]
 *   #/<area>/strand/<strand>[/<level>]
 *   #/<area>/matrix
 *   #/<area>/progression?show=u|k|d|x&open=<strand>,<strand>
 *   #/<area>/substrand/<sub>[,<sub>…][/<level>][?strand=<strand>,…&whole=1&show=k|d&view=condensed]
 *   #/<area>/planner            plans dashboard (plans are stored in this browser)
 *   #/<area>/planner/<plan-id>  edit one plan
 */
(function () {
  "use strict";

  const DATA_DIR = "../data/";
  const LEVELS = [
    { code: "early", name: "Early" },
    { code: "first", name: "First" },
    { code: "second", name: "Second" },
    { code: "third", name: "Third" },
    { code: "fourth", name: "Fourth" },
  ];
  const LEVEL_NAME = Object.fromEntries(LEVELS.map((l) => [l.code, l.name]));
  // Views kept in the code but hidden from users; their URLs redirect to the overview
  const HIDDEN_VIEWS = new Set(["progression"]);
  const EXTRA_LABEL = { includes: "Includes, but not limited to", excludes: "Excludes", note: "Notes" };

  const main = document.getElementById("main");
  const state = { manifest: [], areas: {}, area: null };

  // ---------------------------------------------------------------- helpers
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /** Minimal Markdown: paragraphs separated by blank lines, '- ' bullet lists. */
  function md(text) {
    return String(text)
      .split(/\n{2,}/)
      .map((para) => {
        const out = [];
        let list = null, prose = [];
        const flush = () => {
          if (prose.length) { out.push(`<p>${esc(prose.join(" "))}</p>`); prose = []; }
          if (list) { out.push(`<ul>${list.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`); list = null; }
        };
        for (const line of para.split("\n")) {
          if (/^- /.test(line)) { if (prose.length) { out.push(`<p>${esc(prose.join(" "))}</p>`); prose = []; } (list = list || []).push(line.slice(2)); }
          else { if (list) flush(); prose.push(line); }
        }
        flush();
        return out.join("");
      })
      .join("");
  }

  /** Statement body inside a list item: first paragraph inline, bullets as a nested list. */
  function inlineMd(text) {
    const html = md(text);
    return html.replace(/^<p>/, "").replace(/<\/p>/, "");
  }

  const href = (...parts) => "#/" + parts.filter(Boolean).map(encodeURIComponent).join("/");
  const lvlClass = (code) => `lvl-${code}`;
  const levelMark = (code) => {
    const idx = LEVELS.findIndex((l) => l.code === code);
    return `<span class="lvl-mark ${lvlClass(code)}" aria-hidden="true">${LEVELS.map((_, i) =>
      `<i class="${i === idx ? "on" : i < idx ? "past" : ""}"></i>`).join("")}</span>`;
  };
  const levelRange = (levels) => {
    const order = LEVELS.map((l) => l.code).filter((c) => levels.includes(c));
    if (!order.length) return "";
    return order.length === 1 ? `${LEVEL_NAME[order[0]]} Level` : `${LEVEL_NAME[order[0]]} to ${LEVEL_NAME[order[order.length - 1]]} Level`;
  };

  // ---------------------------------------------------------------- index
  function indexArea(doc) {
    const blocks = new Map();       // code -> {block, node, strand}
    const statements = new Map();   // statement code -> {s, block, node, strand, depth} (framework order)
    const nodes = [];               // flattened {node, strand, parent, depth}
    const visit = (node, strand, parent, depth) => {
      nodes.push({ node, strand, parent, depth });
      for (const b of node.blocks || []) {
        blocks.set(b.code, { block: b, node, strand });
        for (const s of b.statements || []) statements.set(s.code, { s, block: b, node, strand, depth });
      }
      for (const c of node.children || []) visit(c, strand, node, depth + 1);
    };
    for (const s of doc.strands) visit(s, s, null, 0);

    // Sub-strands grouped by slug across strands (Technologies' subjects recur in several strands)
    const subs = new Map();
    for (const n of nodes) {
      if (n.depth === 0) continue;
      if (!subs.has(n.node.slug)) subs.set(n.node.slug, { slug: n.node.slug, name: n.node.name, entries: [] });
      subs.get(n.node.slug).entries.push(n);
    }
    return { doc, blocks, statements, nodes, subs: [...subs.values()] };
  }

  const strandBySlug = (ix, slug) => ix.doc.strands.find((s) => s.slug === slug);
  const subtree = (ix, strand) => ix.nodes.filter((n) => n.strand === strand);
  const understandingOf = (ix, block) => block.understanding ?? ix.blocks.get(block.anchor)?.block.understanding;

  // ---------------------------------------------------------------- render pieces
  function statementsHtml(block) {
    const st = block.statements || [];
    const kind = (k) => st.filter((s) => s.kind === k);
    const list = (k, title) => {
      const items = kind(k);
      return `<div class="kd ${k}"><h4>${title}</h4>${
        items.length
          ? `<ul>${items.map((s) => `<li title="${esc(s.code)}">${inlineMd(s.body)}</li>`).join("")}</ul>`
          : `<p class="none">None at this level.</p>`
      }</div>`;
    };
    const extras = ["includes", "excludes", "note"].flatMap((k) =>
      kind(k).map((s) => `<div class="extra ${k}" title="${esc(s.code)}"><h5>${EXTRA_LABEL[k]}</h5>${md(s.body)}</div>`));
    const hasKD = kind("know").length || kind("do").length;
    if (!hasKD && !extras.length) return "";
    return `<div class="payload">${hasKD ? list("know", "Know") + list("do", "Do") : ""}${
      extras.length ? `<div class="extras">${extras.join("")}</div>` : ""}</div>`;
  }

  function understandingHtml(text, opts = {}) {
    const cls = ["understand", opts.small && "small", opts.inherited && "inherited"].filter(Boolean).join(" ");
    const label = opts.label || "Understand";
    return `<div class="${cls}"><span class="u-label">${esc(label)}</span><p>${esc(text)}</p></div>`;
  }

  /** Everything for one strand at one level: Understanding(s), payload, and sub-strand payloads. */
  function strandAtLevel(ix, strand, level) {
    const here = subtree(ix, strand).flatMap((n) =>
      (n.node.blocks || []).filter((b) => b.level === level).map((b) => ({ ...n, block: b })));
    const anchors = here.filter((x) => x.block.understanding);
    if (!anchors.length) return `<p class="empty">${esc(strand.name)} is not part of ${LEVEL_NAME[level]} Level.</p>`;
    const area = state.area;
    return anchors.map((a) => {
      const inheritors = here.filter((x) => x.block.anchor === a.block.code);
      const subBlocks = inheritors.map((x) => `
        <section class="sub-block" aria-label="${esc(x.node.name)}">
          <h3><a href="${href(area, "substrand", x.node.slug, level) + "?strand=" + encodeURIComponent(strand.slug)}">${esc(x.node.name)}</a></h3>
          ${statementsHtml(x.block) || `<p class="empty">No statements at this level.</p>`}
        </section>`).join("");
      const own = statementsHtml(a.block);
      if (a.node === strand) {
        return understandingHtml(a.block.understanding) + own + (subBlocks ? `<div class="subs">${subBlocks}</div>` : "");
      }
      // Understanding set on a sub-strand (as in Sciences / Maths)
      return `<section class="sub-block"><h3>${esc(a.node.name)}</h3>${understandingHtml(a.block.understanding, { small: true })}${own}${
        subBlocks ? `<div class="subs">${subBlocks}</div>` : ""}</section>`;
    }).join("");
  }

  function stairHtml(selected, ix, routeFor) {
    return `<div class="stair" role="group" aria-label="Choose a level">${LEVELS.map((l) => {
      const count = ix.doc.strands.filter((s) => s.levels.includes(l.code)).length;
      return `<button type="button" class="${lvlClass(l.code)}" aria-pressed="${l.code === selected}"
        data-go="${routeFor(l.code)}">${l.name}<small>${count} strand${count === 1 ? "" : "s"}</small></button>`;
    }).join("")}</div>`;
  }

  // ---------------------------------------------------------------- views
  function viewOverview(ix) {
    const d = ix.doc, area = state.area;
    const ideas = (d.bigIdeas || []).map((b) => `<div class="idea"><h3>${esc(b.name)}</h3><p>${esc(b.description)}</p></div>`).join("");

    const cells = d.strands.map((s) => LEVELS.map((l) => {
      const present = s.levels.includes(l.code);
      const subs = (s.children || []).filter((c) => c.levels.includes(l.code));
      const cls = `cell ${lvlClass(l.code)} is-${l.code}${present ? "" : " absent"}`;
      if (!present) return `<div class="${cls}"><span class="strand-name">${esc(s.name)}</span><span class="whole">Not at this level</span></div>`;
      return `<div class="${cls}">
        <a class="strand-name" href="${href(area, "level", l.code, s.slug)}">${esc(s.name)}</a>
        ${subs.length
          ? `<ul class="tree">${subs.map((c) => `<li><a href="${href(area, "substrand", c.slug, l.code) + "?strand=" + encodeURIComponent(s.slug)}">${esc(c.name)}</a></li>`).join("")}</ul>`
          : `<span class="whole">Taught as one strand</span>`}
      </div>`;
    }).join("")).join("");

    main.innerHTML = `
      <section class="purpose">
        <h1>${esc(d.name)}</h1>
        <p class="statement">${esc(d.purposeStatement || "")}</p>
      </section>
      <h2 class="block-title">Big ideas</h2>
      <p class="block-intro">The big ideas capture why ${esc(d.name)} matters. Every strand and level builds towards them.</p>
      <div class="ideas">${ideas}</div>
      <h2 class="block-title">How the curriculum is organised at each level</h2>
      <p class="block-intro">Each column shows the strands at one level and the sub-strands within them. Select a strand or sub-strand to read its Know, Do and Understand statements.</p>
      <div class="structure-tabs">${stairHtml("early", ix, (c) => "tab:" + c)}</div>
      <div class="structure" data-show="early">
        ${LEVELS.map((l) => `<div class="col-head ${lvlClass(l.code)} is-${l.code}">${l.name} Level</div>`).join("")}
        ${cells}
      </div>`;
    main.querySelectorAll(".structure-tabs [data-go]").forEach((b) => b.addEventListener("click", () => {
      const code = b.dataset.go.slice(4);
      main.querySelector(".structure").dataset.show = code;
      main.querySelectorAll(".structure-tabs [data-go]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    }));
    document.title = `${d.name}: purpose and big ideas · Curriculum Explorer`;
  }

  // ---------------------------------------------------------------- shared Know/Do table
  // Used by By level (strands as columns), By strand (levels as columns) and By sub-strand.
  // A column: { head (html), headClass, groups: [{label, origin, sts}], und: [{text, label}], undNote }
  const EXTRA_KINDS = ["includes", "excludes", "note"];
  function displayOptions(params) {
    return {
      showKD: ["k", "d"].includes(params.get("show")) ? params.get("show") : "kd",
      condensed: params.get("view") === "condensed",
    };
  }
  /** Build a route with a query from {key: value | array}; empty values are left out. */
  function withQuery(path, q) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) {
      const val = Array.isArray(v) ? v.join(",") : v;
      if (val !== undefined && val !== null && val !== "" && val !== false) p.set(k, val === true ? "1" : val);
    }
    const qs = p.toString();
    return path + (qs ? "?" + qs : "");
  }
  /** Query values for the display options, ready to spread into withQuery. */
  const displayQuery = (o) => ({ show: o.showKD === "kd" ? "" : o.showKD, view: o.condensed ? "condensed" : "" });
  function displayBarHtml(o, routeWith) {
    return `<div class="filter display-bar" role="group" aria-label="Display options">
      <span>Statements</span>
      ${[["kd", "Know and Do"], ["k", "Know only"], ["d", "Do only"]].map(([v, label]) =>
        `<button type="button" aria-pressed="${o.showKD === v}" data-go="${routeWith({ ...o, showKD: v })}">${label}</button>`).join("")}
      <span class="sep" aria-hidden="true"></span>
      <button type="button" class="chip" aria-pressed="${o.condensed}" data-go="${routeWith({ ...o, condensed: !o.condensed })}">Condensed view</button>
    </div>`;
  }
  /** Multi-select chips with an "All" button; selection [] means all. */
  function multiChipsHtml(label, allLabel, options, sel, routeFor) {
    return `<div class="filter multi-filter" role="group" aria-label="${esc(label)}"><span>${esc(label)}</span>
      <button type="button" aria-pressed="${!sel.length}" data-go="${routeFor([])}">${esc(allLabel)}</button>
      ${options.map((o) => {
        const on = sel.includes(o.value);
        const next = on ? sel.filter((x) => x !== o.value) : options.map((x) => x.value).filter((x) => x === o.value || sel.includes(x));
        return `<button type="button" class="chip" aria-pressed="${on}" data-go="${routeFor(next)}">${esc(o.label)}</button>`;
      }).join("")}
    </div>`;
  }
  // Layout of Know and Do inside a table: stacked rows, side by side within each cell, or flip cards.
  // Each table has its own switch; the last choice is remembered (in this browser) as the default.
  const KD_LAYOUTS = [["stacked", "Stacked"], ["side", "Side by side"], ["cards", "Cards"]];
  const KD_TABLES = new Map();          // table id -> {cols, o, opts}, so one table can be redrawn alone
  let kdSeq = 0;
  function defaultLayout() {
    try { const v = localStorage.getItem("kd-layout"); return KD_LAYOUTS.some(([k]) => k === v) ? v : "stacked"; }
    catch { return "stacked"; }
  }
  function rememberLayout(v) { try { localStorage.setItem("kd-layout", v); } catch { /* storage unavailable */ } }

  function kdTable(cols, o, opts = {}) {
    const id = opts.id || `kd-${++kdSeq}`;
    const both = o.showKD === "kd";
    const layout = both ? (opts.layout || defaultLayout()) : "stacked";
    KD_TABLES.set(id, { cols, o, opts: { ...opts, id } });

    const listHtml = (sts) => sts.length
      ? `<ul>${sts.map((x) => `<li title="${esc(x.code)}">${inlineMd(x.body)}</li>`).join("")}</ul>` : "";
    const of = (g, k) => g.sts.filter((x) => x.kind === k);
    const labels = new Set(cols.flatMap((c) => c.groups.filter((g) => g.sts.length).map((g) => g.label)));
    const showTags = labels.size > 1;
    const tagHtml = (g) => showTags ? `<p class="ss-tag ${g.origin}">${esc(g.label)}</p>` : "";
    const none = `<p class="none">None at this level.</p>`;
    // Notes, Includes and Excludes belong to a group: each group gets its own Notes link beside its statements
    const extrasOf = (g) => g.sts.filter((x) => EXTRA_KINDS.includes(x.kind));
    const notesHtml = (g) => {
      const ex = extrasOf(g);
      return ex.length ? `<details class="g-notes"><summary>Notes${showTags ? ` for ${esc(g.label)}` : ""} (${ex.length})</summary>${ex.map((x) =>
        `<div class="extra ${x.kind}" title="${esc(x.code)}"><h5>${EXTRA_LABEL[x.kind]}</h5>${md(x.body)}</div>`).join("")}</details>` : "";
    };
    const hasKD = (g) => of(g, "know").length || of(g, "do").length;
    const shown = (c) => c.groups.filter((g) => hasKD(g) || extrasOf(g).length);
    // the notes link sits with the last statements shown for the group
    const lastKind = o.showKD === "k" ? "know" : "do";

    // stacked: one row per kind
    const cell = (c, k) => shown(c).map((g) => {
      const list = listHtml(of(g, k));
      const notes = k === lastKind ? notesHtml(g) : "";
      return list || notes ? tagHtml(g) + list + notes : "";
    }).join("") || none;
    // side by side: per group, Know and Do next to each other, then that group's notes
    const sideCell = (c) => shown(c).map((g) => `${tagHtml(g)}${hasKD(g) ? `
      <div class="kd-pair"><div class="kd-col know"><p class="kd-h">Know</p>${listHtml(of(g, "know")) || none}</div>
      <div class="kd-col do"><p class="kd-h">Do</p>${listHtml(of(g, "do")) || none}</div></div>` : ""}${notesHtml(g)}`).join("") || none;
    // cards: per group, Know on the front; select anywhere on the card to turn it over to Do
    const cardCell = (c) => shown(c).map((g) => {
      const k = of(g, "know"), d = of(g, "do");
      if (!k.length && !d.length) return tagHtml(g) + notesHtml(g);
      return `<div class="kd-card" data-face="know" tabindex="0" role="group" aria-label="${esc(g.label)}: showing Know. Select to show Do.">
        ${tagHtml(g)}
        <div class="face know"><p class="kd-h">Know <span class="kd-turn">Click for Do (${d.length}) ↻</span></p>${listHtml(k) || none}</div>
        <div class="face do"><p class="kd-h">Do <span class="kd-turn">Click for Know (${k.length}) ↻</span></p>${listHtml(d) || none}</div>
        ${notesHtml(g)}
      </div>`;
    }).join("") || none;

    const undCell = (c) => {
      const tag = c.und.length > 1 || c.und.some((u) => u.label && u.label !== c.und[0].label);
      return c.und.map((u) => `${tag && u.label ? `<p class="ss-tag">${esc(u.label)}</p>` : ""}<p class="ss-u${c.undNote ? " inherited" : ""}">${esc(u.text)}</p>`).join("")
        + (c.undNote ? `<p class="ss-note">${esc(c.undNote)}</p>` : "")
        || `<p class="none">No Understanding stated.</p>`;
    };
    const row = (cls, name, fn) => `<tr class="${cls}"><th scope="row">${name}</th>${cols.map((c) => `<td>${fn(c)}</td>`).join("")}</tr>`;
    const kdRows = layout === "side" ? row("r-kd", "Know and Do", sideCell)
      : layout === "cards" ? row("r-kd", "Know, then Do", cardCell)
      : `${o.showKD !== "d" ? row("r-k", "Know", (c) => cell(c, "know")) : ""}${o.showKD !== "k" ? row("r-d", "Do", (c) => cell(c, "do")) : ""}`;

    return `<div class="kd-block" id="${id}">
      <div class="kd-bar">${both ? `<div class="kd-layout" role="group" aria-label="Layout of Know and Do"><span>Layout</span>${KD_LAYOUTS.map(([v, label]) =>
        `<button type="button" aria-pressed="${layout === v}" data-kd-layout="${v}">${label}</button>`).join("")}</div>` : ""}${exportBtn("kd")}</div>
      <div class="ss-wrap" tabindex="0" role="region" aria-label="${esc(opts.label || "Know and Do table")}">
      <table class="ss-table layout-${layout} ${opts.tableClass || ""}${o.condensed ? " condensed" : ""}" style="--cols:${cols.length}">
        <thead><tr><td class="corner"></td>${cols.map((c) => `<th scope="col" class="${c.headClass || ""}"${c.id ? ` id="${c.id}"` : ""}>${c.head}</th>`).join("")}</tr></thead>
        <tbody>
          ${row("r-u", "Understand", undCell)}
          ${kdRows}
        </tbody>
      </table></div></div>`;
  }
  /**
   * Everything one strand holds at one level, as labelled groups: the statements written for the whole strand,
   * then each sub-strand (and sub-sub-strand) in framework order. `subFilter` limits which groups are kept:
   * "_whole" for the whole strand, or sub-strand slugs; empty keeps all.
   */
  function strandColumn(ix, strand, levelCode, subFilter = []) {
    const keep = (key) => !subFilter.length || subFilter.includes(key);
    const groups = [], und = [];
    const take = (node, label) => {
      const blocks = (node.blocks || []).filter((b) => b.level === levelCode);
      for (const b of blocks) {
        const text = b.understanding;
        if (text && !und.some((u) => u.text === text)) und.push({ text, label });
      }
      return blocks.flatMap((b) => b.statements || []);
    };
    const whole = take(strand, "Whole strand");
    if (whole.length && keep("_whole")) groups.push({ label: "Whole strand", origin: "whole", sts: whole });
    for (const n of ix.nodes) {
      if (n.strand !== strand || n.depth === 0 || !n.node.levels.includes(levelCode)) continue;
      const label = n.depth > 1 && n.parent ? `${n.parent.name} › ${n.node.name}` : n.node.name;
      const sts = take(n.node, label);
      if (keep(n.node.slug)) groups.push({ label, origin: "sub", sts });
    }
    return { groups, und };
  }

  function viewLevel(ix, level, focusStrand, params = new URLSearchParams()) {
    level = LEVEL_NAME[level] ? level : LEVELS[0].code;
    const area = state.area;
    const o = displayOptions(params);
    const strands = ix.doc.strands.filter((s) => s.levels.includes(level));
    const asked = params.has("strand") ? String(params.get("strand")).split(",") : focusStrand ? [focusStrand] : [];
    const sel = asked.filter((x) => strands.some((s) => s.slug === x));
    const inPlay = sel.length ? strands.filter((s) => sel.includes(s.slug)) : strands;
    const routeWith = ({ lvl = level, strandSel = sel, ...d } = {}) =>
      withQuery(href(area, "level", lvl), { strand: strandSel, ...displayQuery({ ...o, ...d }) });

    const cols = inPlay.map((s) => {
      const { groups, und } = strandColumn(ix, s, level);
      const hasSubs = groups.some((g) => g.origin === "sub");
      return { head: `<a href="${href(area, "strand", s.slug)}">${esc(s.name)}</a>${hasSubs ? `<small class="th-sub">${groups.filter((g) => g.origin === "sub").length} sub-strands</small>` : ""}`,
        groups, und };
    });
    main.innerHTML = `
      <div class="page-head"><h1>${LEVEL_NAME[level]} Level</h1>
        <p>Everything learners know, do and understand in ${esc(ix.doc.name)} at ${LEVEL_NAME[level]} Level: one column per strand, with any sub-strands labelled inside it.</p></div>
      ${stairHtml(level, ix, (c) => routeWith({ lvl: c, strandSel: [] }))}
      ${strands.length > 1 ? multiChipsHtml("Strands", "All strands", strands.map((s) => ({ value: s.slug, label: s.name })), sel,
        (next) => routeWith({ strandSel: next })) : ""}
      ${displayBarHtml(o, (d) => routeWith(d))}
      <section class="level-section ${lvlClass(level)}">
        ${cols.length ? kdTable(cols, o, { tableClass: lvlClass(level), label: `${LEVEL_NAME[level]} Level` }) : `<p class="empty">No strands at this level.</p>`}
      </section>`;
    document.title = `${LEVEL_NAME[level]} Level · ${ix.doc.name} · Curriculum Explorer`;
  }

  function viewStrand(ix, slug, focusLevel, params = new URLSearchParams()) {
    const area = state.area;
    const o = displayOptions(params);
    const strand = strandBySlug(ix, slug) || ix.doc.strands[0];
    // Sub-strand filter: the strand's own statements ("Whole strand") and each sub-strand; empty means all
    const subOptions = [{ value: "_whole", label: "Whole strand" },
      ...ix.nodes.filter((n) => n.strand === strand && n.depth > 0)
        .filter((n, i, arr) => arr.findIndex((m) => m.node.slug === n.node.slug) === i)
        .map((n) => ({ value: n.node.slug, label: n.node.name }))];
    const sel = String(params.get("sub") || "").split(",").filter((x) => subOptions.some((s) => s.value === x));
    const routeWith = ({ s = strand.slug, subSel = sel, ...d } = {}) =>
      withQuery(href(area, "strand", s), { sub: subSel, ...displayQuery({ ...o, ...d }) });

    const levels = LEVELS.filter((l) => strand.levels.includes(l.code));
    const cols = levels.map((l) => {
      const { groups, und } = strandColumn(ix, strand, l.code, sel);
      return { head: `<a href="${href(area, "level", l.code, strand.slug)}">${l.name} Level</a>`, headClass: lvlClass(l.code), id: `col-${l.code}`, groups, und };
    }).filter((c) => !sel.length || c.groups.length);      // a filter hides levels where none of it appears
    main.innerHTML = `
      <div class="page-head"><h1>${esc(strand.name)}</h1>
        <p>${levelRange(strand.levels)}. Read across to see how the strand develops from level to level; sub-strands are labelled inside each column.</p></div>
      <p class="picker-label" id="strand-pick">Strands</p>
      <ul class="picker" aria-labelledby="strand-pick">${ix.doc.strands.map((s) =>
        `<li><a href="${routeWith({ s: s.slug, subSel: [] })}" aria-current="${s === strand}">${esc(s.name)}</a></li>`).join("")}</ul>
      ${subOptions.length > 1 ? multiChipsHtml("Show", "Everything", subOptions, sel, (next) => routeWith({ subSel: next })) : ""}
      ${displayBarHtml(o, (d) => routeWith(d))}
      <section class="level-section">
        ${cols.length ? kdTable(cols, o, { tableClass: "by-levels", label: `${strand.name} by level` }) : `<p class="empty">Nothing in this strand matches the selection.</p>`}
      </section>`;
    document.title = `${strand.name} · ${ix.doc.name} · Curriculum Explorer`;
    if (focusLevel) {
      const th = document.getElementById("col-" + focusLevel);
      if (th) requestAnimationFrame(() => th.scrollIntoView({ inline: "start", block: "nearest" }));
    }
  }

  /** Join names as "A", "A and B", "A, B and C". */
  const listNames = (names) => names.length < 2 ? names.join("")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

  function viewSubstrand(ix, slugList, focusLevel, strandParam, includeWhole, params = new URLSearchParams()) {
    const area = state.area;
    if (!ix.subs.length) {
      main.innerHTML = `<div class="page-head"><h1>Sub-strands</h1><p>${esc(ix.doc.name)} has no sub-strands. Browse by strand instead.</p></div>`;
      return;
    }
    // Sub-strand selection is a comma-separated list in the URL, kept in picker order
    const wanted = new Set(String(slugList || "").split(",").filter(Boolean));
    let selected = ix.subs.filter((s) => wanted.has(s.slug));
    if (!selected.length) selected = [ix.subs[0]];
    const selSlugs = selected.map((s) => s.slug);

    // Strands that contain any selected sub-strand, in framework order. The strand selection is a
    // comma-separated list too; empty means all of them. Strands that no longer apply are dropped.
    const strands = ix.doc.strands.filter((st) => selected.some((sub) => sub.entries.some((e) => e.strand === st)));
    const strandSel = String(strandParam || "").split(",").filter((slug) => strands.some((s) => s.slug === slug));
    const inPlay = strandSel.length ? strands.filter((s) => strandSel.includes(s.slug)) : strands;

    // Display options: which statements to show and a condensed layout
    const showKD = ["k", "d"].includes(params.get("show")) ? params.get("show") : "kd";
    const condensed = params.get("view") === "condensed";
    const routeFor = (slugs, strandSlugs = strandSel, whole = includeWhole, opts = {}) => {
      const q = new URLSearchParams();
      const show = opts.show ?? showKD;
      const dense = opts.condensed ?? condensed;
      if (strandSlugs.length) q.set("strand", strandSlugs.join(","));
      if (whole) q.set("whole", "1");
      if (show !== "kd") q.set("show", show);
      if (dense) q.set("view", "condensed");
      const qs = q.toString();
      return href(area, "substrand", slugs.join(",")) + (qs ? "?" + qs : "");
    };

    // One column per selected strand at a level. A cell holds the selected sub-strands' statements and,
    // when the option is on, the statements written for the whole strand (no sub-strand label).
    const blocksAt = (node, l) => (node.blocks || []).filter((b) => b.level === l.code);
    const stmts = (blocks) => blocks.flatMap((b) => b.statements || []);
    const colsAt = (l) => inPlay.map((st) => {
      const groups = [], und = [];
      const addUnd = (b) => { const u = understandingOf(ix, b); if (u && !und.includes(u)) und.push(u); };
      let ownUnderstanding = false;
      for (const sub of selected) {
        for (const e of sub.entries) {
          if (e.strand !== st || !e.node.levels.includes(l.code)) continue;
          const blocks = blocksAt(e.node, l);
          blocks.forEach(addUnd);
          if (blocks.some((b) => b.understanding)) ownUnderstanding = true;
          groups.push({ label: sub.name, origin: "sub", sts: stmts(blocks) });
        }
      }
      const hasSub = groups.length > 0;
      if (includeWhole) {
        const own = blocksAt(st, l);
        const sts = stmts(own);
        if (sts.length) { own.forEach(addUnd); groups.push({ label: "Whole strand", origin: "whole", sts }); }
      }
      if (!hasSub && !groups.length) return null;
      return { strand: st, groups, und, inherited: hasSub && !ownUnderstanding };
    }).filter(Boolean);
    const levels = LEVELS.map((l) => ({ l, cols: colsAt(l) })).filter((x) => x.cols.length);

    const o = { showKD, condensed };
    const tableHtml = (cols, l) => kdTable(cols.map((c) => ({
      head: `<a href="${href(area, "strand", c.strand.slug, l.code)}">${esc(c.strand.name)}</a>`,
      groups: c.groups, und: c.und.map((text) => ({ text })), undNote: c.inherited ? "Shared across the strand" : "",
    })), o, { tableClass: lvlClass(l.code), label: `${l.name} Level` });

    const names = selected.map((s) => s.name);
    const sections = levels.map(({ l, cols }) => {
      const present = selected.filter((sub) => cols.some((c) => c.groups.some((g) => g.origin === "sub" && g.label === sub.name)));
      const hasWhole = cols.some((c) => c.groups.some((g) => g.origin === "whole"));
      const note = !present.length
        ? `${listNames(names)} ${names.length === 1 ? "is" : "are"} not a sub-strand at this level: showing statements written for the whole strand.`
        : present.length < selected.length || hasWhole
          ? `${listNames(present.map((s) => s.name))}${hasWhole ? ", with statements written for the whole strand" : ""}.`
          : "";
      return `<section class="level-section ${lvlClass(l.code)}" id="l-${l.code}">
        <h2 class="section-title">${levelMark(l.code)}${l.name} Level</h2>
        ${note ? `<p class="section-sub">${esc(note)}</p>` : ""}${tableHtml(cols, l)}</section>`;
    }).join("");

    const title = names.length > 3 ? `${names.length} sub-strands` : listNames(names);
    const range = levelRange(levels.map((x) => x.l.code));
    const intro = `${range}. ${multiStrandText(strands.length)} Each level shows one table: the selected strands as columns and the selected sub-strands' statements beneath.`;
    function multiStrandText(n) {
      return names.length === 1 ? `${esc(selected[0].name)} appears in ${n} strand${n === 1 ? "" : "s"}.`
        : `${names.length > 3 ? esc(listNames(names)) + ", g" : "G"}athered from ${n} strand${n === 1 ? "" : "s"}.`;
    }

    main.innerHTML = `
      <div class="page-head"><h1>${esc(title)}</h1><p>${intro}</p>${inPlay.length === 1 && !HIDDEN_VIEWS.has("progression")
        ? `<p class="page-links"><a href="${progressionHref(area, "k", [inPlay[0].slug])}">See ${esc(inPlay[0].name)} in the progression matrix</a></p>` : ""}</div>
      <div class="picker-bar">
        <p class="picker-label" id="sub-pick">Sub-strands by level <span class="hint">Select one or more; a sub-strand is selected at every level it appears</span></p>
        <button type="button" class="link-btn" data-go="${routeFor(ix.subs.map((s) => s.slug))}">Select all</button>
      </div>
      <div class="sub-grid-wrap"><div class="sub-grid" role="group" aria-labelledby="sub-pick" style="--n:${LEVELS.length}">
        ${LEVELS.map((l) => `<div class="sub-col"><p class="sub-col-head ${lvlClass(l.code)}">${l.name}</p>${
          ix.subs.filter((s) => s.entries.some((e) => e.node.levels.includes(l.code))).map((s) => {
            const on = selSlugs.includes(s.slug);
            const next = on ? selSlugs.filter((x) => x !== s.slug) : ix.subs.map((x) => x.slug).filter((x) => x === s.slug || selSlugs.includes(x));
            // The last selected sub-strand stays selected: the page always shows at least one
            const locked = on && selSlugs.length === 1;
            const lv = LEVELS.filter((x) => s.entries.some((e) => e.node.levels.includes(x.code))).map((x) => x.name);
            const span = lv.length > 1 ? `${lv[0]} to ${lv[lv.length - 1]} Level` : `${lv[0]} Level`;
            return `<button type="button" class="chip sub-chip" data-sub="${esc(s.slug)}" aria-pressed="${on}" title="${esc(s.name)}: ${span}"
              ${locked ? 'aria-disabled="true"' : `data-go="${routeFor(next)}"`}>${esc(s.name)}</button>`;
          }).join("") || `<p class="none">No sub-strands: strands are taught whole</p>`}</div>`).join("")}
      </div></div>
      ${strands.length > 1 ? `<div class="filter strand-filter" role="group" aria-label="Strands"><span>Strands</span>
        <button type="button" aria-pressed="${!strandSel.length}" data-go="${routeFor(selSlugs, [])}">All strands</button>
        ${strands.map((s) => {
          const on = strandSel.includes(s.slug);
          const next = on ? strandSel.filter((x) => x !== s.slug) : strands.map((x) => x.slug).filter((x) => x === s.slug || strandSel.includes(x));
          return `<button type="button" class="chip" aria-pressed="${on}" data-go="${routeFor(selSlugs, next)}">${esc(s.name)}</button>`;
        }).join("")}
      </div>` : ""}
      <div class="filter whole-toggle" role="group" aria-label="Statements without a sub-strand">
        <button type="button" class="chip" aria-pressed="${!!includeWhole}" data-go="${routeFor(selSlugs, strandSel, !includeWhole)}">Include statements without a sub-strand</button>
        <span class="hint">Adds statements written for the whole strand, including levels before the sub-strand starts</span>
      </div>
      ${displayBarHtml(o, (d) => routeFor(selSlugs, strandSel, includeWhole, { show: d.showKD, condensed: d.condensed }))}
      ${sections || `<p class="empty">Nothing to show for this selection.${includeWhole ? "" : " Try including statements without a sub-strand."}</p>`}`;
    document.title = `${title} · ${ix.doc.name} · Curriculum Explorer`;
    if (focusLevel) scrollToId("l-" + focusLevel);
  }
  function viewMatrix(ix) {
    const area = state.area;
    const rows = ix.doc.strands.map((s) => {
      const cells = LEVELS.map((l) => {
        if (!s.levels.includes(l.code)) {
          return `<td class="m-cell absent ${lvlClass(l.code)}" data-label="${l.name} Level"><span class="m-none">Not at this level</span></td>`;
        }
        const nodes = subtree(ix, s);
        const anchors = nodes.flatMap((n) => (n.node.blocks || [])
          .filter((b) => b.level === l.code && b.understanding).map((b) => ({ n, b })));
        const statements = anchors.map(({ n, b }) => `<p class="m-u">${n.node !== s ? `<span class="m-on">${esc(n.node.name)}:</span> ` : ""}${esc(b.understanding)}</p>`).join("");
        const subs = (s.children || []).filter((c) => c.levels.includes(l.code));
        const tags = subs.length
          ? `<ul class="tags" aria-label="Sub-strands">${subs.map((c) =>
              `<li><a class="tag" href="${href(area, "substrand", c.slug, l.code)}?strand=${encodeURIComponent(s.slug)}">${esc(c.name)}</a></li>`).join("")}</ul>`
          : "";
        return `<td class="m-cell ${lvlClass(l.code)}" data-label="${l.name} Level">
          ${statements}${tags}
          <a class="m-more" href="${href(area, "level", l.code, s.slug)}">Know and Do<span class="visually-hidden"> for ${esc(s.name)} at ${l.name} Level</span></a>
        </td>`;
      }).join("");
      return `<tr><th scope="row" class="m-strand"><a href="${href(area, "strand", s.slug)}">${esc(s.name)}</a></th>${cells}</tr>`;
    }).join("");

    main.innerHTML = `
      <div class="page-head"><h1>Understanding at each level</h1>
        <p>The Understand statement for every strand at every level. Select a sub-strand to see its Know and Do statements at that level.</p></div>
      <div class="table-tools">${exportBtn("matrix")}</div>
      <div class="matrix-wrap">
        <table class="matrix">
          <caption class="visually-hidden">${esc(ix.doc.name)}: Understand statements by strand and level</caption>
          <thead><tr><th scope="col" class="m-corner">Strand</th>${LEVELS.map((l) =>
            `<th scope="col" class="m-head ${lvlClass(l.code)}"><a href="${href(area, "level", l.code)}">${l.name} Level</a></th>`).join("")}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    document.title = `Understanding at each level · ${ix.doc.name} · Curriculum Explorer`;
  }

  // ---------------------------------------------------------------- progression matrix
  // Strands as rows (sub-strands nested underneath, expandable), levels as columns.
  // Reading across a row shows how that strand or sub-strand progresses.
  // Params: show=u|k|d|x (what the cells hold, default k)  open=<strand>,<strand> (expanded strands)
  const PM_KINDS = [
    { key: "u", label: "Understand", kinds: [] },
    { key: "k", label: "Know", kinds: ["know"] },
    { key: "d", label: "Do", kinds: ["do"] },
    { key: "x", label: "Notes", kinds: ["includes", "excludes", "note"] },
  ];

  function progressionHref(area, show, open) {
    const p = new URLSearchParams();
    if (show && show !== "k") p.set("show", show);
    if (open && open.length) p.set("open", open.join(","));
    const q = p.toString().replace(/%2C/g, ",");
    return href(area, "progression") + (q ? "?" + q : "");
  }

  function viewProgression(ix, params) {
    const area = state.area;
    const kind = PM_KINDS.find((k) => k.key === params.get("show")) || PM_KINDS[1];
    const open = new Set((params.get("open") || "").split(",").filter(Boolean));

    const blocksAt = (node, lv) => (node.blocks || []).filter((b) => b.level === lv);
    const stmts = (blocks) => blocks.flatMap((b) => (b.statements || []).filter((x) => kind.kinds.includes(x.kind)));
    const none = (t) => `<span class="p-none">${esc(t)}</span>`;
    const understand = (blocks) => blocks.filter((b) => b.understanding).map((b) => `<p class="p-u">${esc(b.understanding)}</p>`).join("");
    const list = (items) => kind.key === "x"
      ? items.map((x) => `<div class="p-extra ${x.kind}" title="${esc(x.code)}"><span>${EXTRA_LABEL[x.kind]}</span>${md(x.body)}</div>`).join("")
      : `<ul class="p-list">${items.map((x) => `<li title="${esc(x.code)}">${inlineMd(x.body)}</li>`).join("")}</ul>`;
    const subsAt = (st, lv) => (st.children || []).filter((c) => c.levels.includes(lv));

    const strandCell = (st, l) => {
      if (!st.levels.includes(l.code)) return { cls: "absent", html: none("Not at this level") };
      const anchors = blocksAt(st, l.code).filter((b) => b.understanding);
      if (kind.key === "u") return { cls: "u", html: understand(anchors) || none("None") };
      const items = stmts(anchors);
      const here = subsAt(st, l.code);
      const toSubs = here.length
        ? `<button type="button" class="pm-insubs" data-expand="${esc(st.slug)}">${items.length ? "More in" : "In"} ${here.length} sub-strand${here.length === 1 ? "" : "s"}</button>` : "";
      if (!items.length) return { cls: here.length ? "muted" : "", html: toSubs || none("None") };
      return { cls: "", html: list(items) + toSubs };
    };
    const subCell = (st, c, l) => {
      if (!c.levels.includes(l.code)) return { cls: "absent", html: "" };
      const blocks = blocksAt(c, l.code);
      if (kind.key === "u") {
        const own = understand(blocks);
        return own ? { cls: "u", html: own } : { cls: "muted", html: none(`Same as ${st.name}`) };
      }
      const items = stmts(blocks);
      return { cls: "", html: items.length ? list(items) : none("None") };
    };
    const td = (l, c) => `<td class="pm-cell ${lvlClass(l.code)} ${c.cls}" data-label="${l.name} Level">${c.html}</td>`;

    const groups = ix.doc.strands.map((st) => {
      const kids = st.children || [];
      const isOpen = open.has(st.slug);
      const head = kids.length
        ? `<button type="button" class="pm-toggle" aria-expanded="${isOpen}" data-strand="${esc(st.slug)}">
             <span class="pm-name">${esc(st.name)}</span><span class="pm-count">${kids.length} sub-strands</span></button>`
        : `<span class="pm-plain"><span class="pm-name">${esc(st.name)}</span><span class="pm-count">Taught as one strand</span></span>`;
      const strandRow = `<tr class="pm-strand"><th scope="row" class="pm-rowhead">${head}</th>${LEVELS.map((l) => td(l, strandCell(st, l))).join("")}</tr>`;
      const subRows = kids.map((c) => `<tr class="pm-subrow" data-parent="${esc(st.slug)}"${isOpen ? "" : " hidden"}>
        <th scope="row" class="pm-rowhead pm-sub"><a href="${href(area, "substrand", c.slug)}?strand=${encodeURIComponent(st.slug)}">${esc(c.name)}</a></th>
        ${LEVELS.map((l) => td(l, subCell(st, c, l))).join("")}</tr>`).join("");
      return `<tbody class="pm-group" data-strand="${esc(st.slug)}">${strandRow}${subRows}</tbody>`;
    }).join("");

    main.innerHTML = `
      <div class="page-head"><h1>Progression</h1>
        <p>Read across a row to see how each strand develops from Early to Fourth Level. Expand a strand to see its sub-strands.</p></div>
      <div class="pm-tools">
        <span class="pm-label" id="pm-show">Cells show</span>
        <div class="chips" role="group" aria-labelledby="pm-show">${PM_KINDS.map((k) =>
          `<button type="button" class="chip radio" aria-pressed="${k === kind}"${k === kind ? ' aria-disabled="true"'
            : ` data-show="${k.key}"`}>${k.label}</button>`).join("")}</div>
        <span class="pm-spacer"></span>
        <button type="button" class="link-btn" data-pm-all="open">Expand all strands</button>
        <button type="button" class="link-btn" data-pm-all="close">Collapse all</button>
      </div>
      <div class="pm-wrap">
        <table class="pm">
          <caption class="visually-hidden">${esc(ix.doc.name)}: ${kind.label} statements by strand and level</caption>
          <thead><tr><th scope="col" class="pm-corner">Strand</th>${LEVELS.map((l) =>
            `<th scope="col" class="pm-head ${lvlClass(l.code)}"><a href="${href(area, "level", l.code)}">${l.name} Level</a></th>`).join("")}</tr></thead>
          ${groups}
        </table>
      </div>`;
    document.title = `Progression · ${ix.doc.name} · Curriculum Explorer`;
  }

  /** Expand or collapse strands in the progression matrix without re-rendering, and keep the URL in step. */
  function setStrandsOpen(slugs, isOpen) {
    for (const slug of slugs) {
      main.querySelectorAll(`.pm-subrow[data-parent="${CSS.escape(slug)}"]`).forEach((tr) => { tr.hidden = !isOpen; });
      const btn = main.querySelector(`.pm-toggle[data-strand="${CSS.escape(slug)}"]`);
      if (btn) btn.setAttribute("aria-expanded", String(isOpen));
    }
    const r = parseHash();
    history.replaceState(null, "", progressionHref(r.area, r.params.get("show"), openStrands()));
  }
  const openStrands = () => [...main.querySelectorAll('.pm-toggle[aria-expanded="true"]')].map((b) => b.dataset.strand);

  // ---------------------------------------------------------------- planner
  // Plans are kept in this browser (localStorage). Export / Import move them between devices or people.
  const PLANS_KEY = "cic-plans-v1";
  const YEAR_GROUPS = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "S1", "S2", "S3"];
  // the CfE level a year group usually works at (a suggestion only; learners progress at their own pace)
  const YEAR_LEVEL = { P1: "early", P2: "first", P3: "first", P4: "first", P5: "second", P6: "second", P7: "second",
    S1: "third", S2: "third", S3: "third" };
  const planUI = { id: null, level: null, strands: [], subs: [] };   // picker filters for the open plan
  let planSaveTimer = null;

  function loadPlans() {
    try { const v = JSON.parse(localStorage.getItem(PLANS_KEY) || "[]"); return Array.isArray(v) ? v : []; }
    catch { return []; }
  }
  function storePlans(plans) {
    try { localStorage.setItem(PLANS_KEY, JSON.stringify(plans)); return true; } catch { return false; }
  }
  const getPlan = (id) => loadPlans().find((p) => p.id === id);
  function putPlan(plan) {
    const plans = loadPlans();
    plan.updated = new Date().toISOString();
    const i = plans.findIndex((p) => p.id === plan.id);
    if (i >= 0) plans[i] = plan; else plans.push(plan);
    return storePlans(plans);
  }
  const newPlanId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const fmtDate = (iso) => { try { return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }); } catch { return ""; } };

  /** What a plan covers, worked out from its statement codes. */
  function planCoverage(ix, plan) {
    const strands = new Map(), levels = new Set();
    let know = 0, doo = 0, missing = 0;
    for (const code of plan.statements || []) {
      const hit = ix.statements.get(code);
      if (!hit) { missing++; continue; }
      levels.add(hit.block.level);
      if (hit.s.kind === "know") know++; else if (hit.s.kind === "do") doo++;
      if (!strands.has(hit.strand)) strands.set(hit.strand, new Set());
      strands.get(hit.strand).add(hit.depth > 0 ? hit.node.name : "Whole strand");
    }
    const ordered = ix.doc.strands.filter((s) => strands.has(s)).map((s) => ({ strand: s, subs: [...strands.get(s)] }));
    return { strands: ordered, levels: LEVELS.filter((l) => levels.has(l.code)).map((l) => l.code), know, do: doo, missing };
  }

  // ---------------------------------------------------------------- planner: master dashboard and coverage audit
  const auditUI = { kinds: "kd", years: [], levels: [], cell: null, open: new Set() };   // open: strands showing their sub-strands
  const metricsOpen = () => { try { return localStorage.getItem("planner-metrics") !== "closed"; } catch { return true; } };      // what the audit counts, which plans, the open cell

  /** Coverage of every Know/Do statement by the given plans, grouped strand -> row (whole strand / sub-strand) -> level. */
  function coverageModel(ix, plans) {
    const kinds = auditUI.kinds === "k" ? ["know"] : auditUI.kinds === "d" ? ["do"] : ["know", "do"];
    const coveredBy = new Map();                         // code -> [plan]
    for (const p of plans) for (const c of p.statements || []) {
      if (!coveredBy.has(c)) coveredBy.set(c, []);
      coveredBy.get(c).push(p);
    }
    const rows = new Map();                              // strand -> Map(rowKey -> {key, name, cells: {level: {codes, covered, plans}}})
    for (const [code, h] of ix.statements) {
      if (!kinds.includes(h.s.kind)) continue;
      if (auditUI.levels.length && !auditUI.levels.includes(h.block.level)) continue;
      const key = h.depth > 0 ? h.node.slug : "_whole";
      const name = h.depth > 0 ? h.node.name : "Whole strand";
      if (!rows.has(h.strand)) rows.set(h.strand, new Map());
      const m = rows.get(h.strand);
      if (!m.has(key)) m.set(key, { key, name, cells: {} });
      const cell = (m.get(key).cells[h.block.level] ||= { codes: [], covered: 0, plans: new Set() });
      cell.codes.push(code);
      const by = coveredBy.get(code);
      if (by) { cell.covered++; by.forEach((p) => cell.plans.add(p.id)); }
    }
    let total = 0, covered = 0, gaps = 0;
    const strands = ix.doc.strands.filter((s) => rows.has(s)).map((s) => {
      const subRows = [...rows.get(s).values()].sort((a, b) => (a.key === "_whole" ? -1 : b.key === "_whole" ? 1 : 0));
      const agg = {};
      for (const r of subRows) for (const [lv, c] of Object.entries(r.cells)) {
        const a = (agg[lv] ||= { codes: [], covered: 0, plans: new Set() });
        a.codes.push(...c.codes); a.covered += c.covered; c.plans.forEach((x) => a.plans.add(x));
        total += c.codes.length; covered += c.covered; if (!c.covered) gaps++;
      }
      return { strand: s, cells: agg, rows: subRows };
    });
    return { strands, total, covered, gaps, coveredBy };
  }

  function masterDashboardHtml(ix, everyPlan) {
    // Level filter: only plans at the chosen levels, and only statements at those levels
    const allPlans = auditUI.levels.length ? everyPlan.filter((p) => auditUI.levels.includes(p.level)) : everyPlan;
    const yearOpts = YEAR_GROUPS.filter((y) => allPlans.some((p) => p.yearGroup === y));
    auditUI.years = auditUI.years.filter((y) => yearOpts.includes(y));
    const plans = auditUI.years.length ? allPlans.filter((p) => auditUI.years.includes(p.yearGroup)) : allPlans;
    const model = coverageModel(ix, plans);
    const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
    // a percentage for display: never "0%" when something is covered, never "100%" when something is not
    const pctText = (a, b) => { const v = b ? (100 * a) / b : 0; return a && v < 1 ? "<1%" : a < b && v > 99 ? ">99%" : `${Math.round(v)}%`; };
    const levels = LEVELS.filter((l) => model.strands.some((s) => s.cells[l.code]));

    // summary: stat tiles and two count lists
    // with a level filter, only the year groups that usually work at those levels (plus any that have plans there)
    let years = auditUI.levels.length
      ? YEAR_GROUPS.filter((y) => auditUI.levels.includes(YEAR_LEVEL[y]) || allPlans.some((p) => p.yearGroup === y)) : YEAR_GROUPS;
    if (!years.length) years = YEAR_GROUPS;
    const byYear = years.map((y) => [y, allPlans.filter((p) => p.yearGroup === y).length]);
    const byLevel = LEVELS.filter((l) => !auditUI.levels.length || auditUI.levels.includes(l.code)).map((l) => [l, allPlans.filter((p) => p.level === l.code).length]);
    const maxY = Math.max(1, ...byYear.map(([, n]) => n)), maxL = Math.max(1, ...byLevel.map(([, n]) => n));
    const bars = (items, max, label) => `<ul class="count-bars">${items.map(([name, n, cls]) =>
      `<li title="${esc(name)}: ${n} plan${n === 1 ? "" : "s"}"><span class="cb-label">${esc(name)}</span>
        <span class="cb-track"><span class="cb-fill ${cls || ""}" style="width:${(100 * n) / max}%"></span></span>
        <span class="cb-n">${n}</span></li>`).join("")}</ul>`;
    const yearsPlanned = byYear.filter(([, n]) => n).length;

    // audit matrix
    const meter = (c, scope) => {
      if (!c) return `<td class="au-na" aria-label="Not at this level"></td>`;
      const p = pct(c.covered, c.codes.length);
      const sel = auditUI.cell === scope;
      return `<td class="au-cell${c.covered ? "" : " gap"}${sel ? " selected" : ""}">
        <button type="button" data-audit-cell="${esc(scope)}" aria-pressed="${sel}"
          title="${c.covered} of ${c.codes.length} statements covered by ${c.plans.size} plan${c.plans.size === 1 ? "" : "s"}">
          <span class="au-top"><span class="au-num">${c.covered}<span class="au-of"> / ${c.codes.length}</span></span>
            ${c.covered ? `<span class="au-pct">${pctText(c.covered, c.codes.length)} · ${c.plans.size} plan${c.plans.size === 1 ? "" : "s"}</span>` : `<span class="au-gap">Gap</span>`}</span>
          <span class="au-meter"><span style="width:${p}%"></span></span>
        </button></td>`;
    };
    const hasSubRows = (s) => s.rows.length > 1 || s.rows[0]?.key !== "_whole";
    const expandable = model.strands.filter(hasSubRows).map((s) => s.strand.slug);
    const matrix = `<table class="audit">
      <thead><tr><th scope="col" class="au-corner">Strand / sub-strand</th>${levels.map((l) => `<th scope="col" class="${lvlClass(l.code)}">${l.name}</th>`).join("")}</tr></thead>
      <tbody>${model.strands.map((s) => `
        <tr class="au-strand"><th scope="row">${hasSubRows(s)
          ? `<button type="button" class="au-toggle" data-audit-open="${esc(s.strand.slug)}" aria-expanded="${auditUI.open.has(s.strand.slug)}">${esc(s.strand.name)}
              <small>${s.rows.filter((r) => r.key !== "_whole").length} sub-strands</small></button>` : esc(s.strand.name)}</th>${levels.map((l) => meter(s.cells[l.code], `${s.strand.slug}||${l.code}`)).join("")}</tr>
        ${hasSubRows(s) && auditUI.open.has(s.strand.slug) ? s.rows.map((r) => `<tr class="au-sub"><th scope="row">${esc(r.name)}</th>${levels.map((l) =>
          meter(r.cells[l.code], `${s.strand.slug}|${r.key}|${l.code}`)).join("")}</tr>`).join("") : ""}`).join("")}
      </tbody></table>`;

    // drill-down for the selected cell
    let detail = "";
    if (auditUI.cell) {
      // scope is "strand|row|level"; an empty row means the whole strand (all its sub-strands together)
      const [sSlug, rKey, lv] = auditUI.cell.split("|");
      const s = model.strands.find((x) => x.strand.slug === sSlug);
      const c = s && (rKey ? s.rows.find((r) => r.key === rKey)?.cells[lv] : s.cells[lv]);
      if (c) {
        const name = rKey ? s.rows.find((r) => r.key === rKey).name : "all sub-strands";
        const items = c.codes.map((code) => ({ h: ix.statements.get(code), by: model.coveredBy.get(code) || [] }))
          .sort((a, b) => (a.by.length ? 1 : 0) - (b.by.length ? 1 : 0));
        detail = `<div class="au-detail" aria-live="polite">
          <div class="au-detail-head"><h3>${esc(s.strand.name)} · ${esc(name)} · ${LEVEL_NAME[lv]} Level</h3>
            <span>${c.covered} of ${c.codes.length} covered</span>
            <button type="button" class="link-btn" data-audit-close>Close</button></div>
          <ul class="au-list">${items.map(({ h, by }) => `<li class="${by.length ? "done" : "todo"}">
            <span class="au-mark" aria-hidden="true">${by.length ? "✓" : "○"}</span>
            <span class="au-kind ${h.s.kind}">${h.s.kind === "know" ? "Know" : "Do"}</span>
            <span class="au-text">${inlineMd(h.s.body)}${!rKey && h.depth > 0 ? ` <small class="plan-also">${esc(h.node.name)}</small>` : ""}</span>
            <span class="au-by">${by.length ? by.map((p) => `<a href="${href(state.area, "planner", p.id)}">${esc(p.name || "Untitled plan")}</a>`).join(", ") : `<em>Not yet planned</em>`}</span>
          </li>`).join("")}</ul></div>`;
      }
    }

    const isOpen = metricsOpen();
    const levelScope = auditUI.levels.length ? listNames(LEVELS.filter((l) => auditUI.levels.includes(l.code)).map((l) => l.name)) + " Level" : "all levels";
    return `<section class="master" aria-labelledby="master-h">
      <h2 class="master-h" id="master-h"><button type="button" data-master-toggle aria-expanded="${isOpen}" aria-controls="master-body">
        Plan metrics and coverage audit <small>${allPlans.length} plan${allPlans.length === 1 ? "" : "s"} · ${esc(levelScope)}</small></button></h2>
      <div class="master-body" id="master-body"${isOpen ? "" : " hidden"}>
      <div class="filter" role="group" aria-label="Levels"><span>Levels</span>
        <button type="button" aria-pressed="${!auditUI.levels.length}" data-audit-level="">All levels</button>
        ${LEVELS.map((l) => `<button type="button" class="chip" aria-pressed="${auditUI.levels.includes(l.code)}" data-audit-level="${l.code}">${l.name}</button>`).join("")}</div>
      ${allPlans.length ? "" : `<p class="none">No plans at ${esc(levelScope)} yet.</p>`}
      <div class="tiles">
        <div class="tile"><span class="tile-n">${allPlans.length}</span><span class="tile-l">plan${allPlans.length === 1 ? "" : "s"}</span></div>
        <div class="tile"><span class="tile-n">${yearsPlanned}<span class="tile-of"> / ${years.length}</span></span><span class="tile-l">year groups with a plan${auditUI.levels.length ? ` at ${esc(levelScope)}` : ""}</span></div>
        <div class="tile"><span class="tile-n">${pctText(model.covered, model.total)}</span><span class="tile-l">of ${auditUI.kinds === "k" ? "Know" : auditUI.kinds === "d" ? "Do" : "Know and Do"} statements covered<br><small>${model.covered} of ${model.total}${auditUI.years.length ? `, ${auditUI.years.join(", ")} plans` : ""}</small></span></div>
        <div class="tile"><span class="tile-n">${model.gaps}</span><span class="tile-l">sub-strand × level gaps<br><small>no statements planned</small></span></div>
      </div>
      <div class="dist">
        <div><h3>Plans by year group</h3>${bars(byYear.map(([y, n]) => [y, n]), maxY)}</div>
        <div><h3>Plans by level</h3>${bars(byLevel.map(([l, n]) => [`${l.name} Level`, n, lvlClass(l.code)]), maxL)}</div>
      </div>
      <h2 class="block-title">Coverage audit</h2>
      <p class="block-intro">How many of the framework's statements at each level are in at least one plan. Select a cell to see which statements are covered, by which plans, and what is still to plan.</p>
      <div class="filter" role="group" aria-label="Statements counted"><span>Count</span>
        ${[["kd", "Know and Do"], ["k", "Know only"], ["d", "Do only"]].map(([v, l]) => `<button type="button" aria-pressed="${auditUI.kinds === v}" data-audit-kinds="${v}">${l}</button>`).join("")}</div>
      ${yearOpts.length > 1 ? `<div class="filter" role="group" aria-label="Plans counted"><span>Plans</span>
        <button type="button" aria-pressed="${!auditUI.years.length}" data-audit-year="">All year groups</button>
        ${yearOpts.map((y) => `<button type="button" class="chip" aria-pressed="${auditUI.years.includes(y)}" data-audit-year="${y}">${y}</button>`).join("")}</div>` : ""}
      ${expandable.length ? `<div class="au-tools"><button type="button" class="link-btn" data-audit-all="open">Show all sub-strands</button>
        <button type="button" class="link-btn" data-audit-all="close">Hide all</button></div>` : ""}
      <div data-export-scope><div class="table-tools">${exportBtn("audit", "Export audit to Word", "Coverage audit")}</div>
      <div class="audit-wrap" tabindex="0" role="region" aria-label="Coverage audit">${matrix}</div></div>
      ${detail}
      </div>
    </section>`;
  }

  function auditClick(e) {
    const t = e.target;
    const cell = t.closest("[data-audit-cell]"), kinds = t.closest("[data-audit-kinds]"), year = t.closest("[data-audit-year]");
    const open = t.closest("[data-audit-open]"), all = t.closest("[data-audit-all]");
    const lvl = t.closest("[data-audit-level]"), toggle = t.closest("[data-master-toggle]");
    if (toggle) {
      const now = toggle.getAttribute("aria-expanded") !== "true";
      toggle.setAttribute("aria-expanded", String(now));
      main.querySelector("#master-body").hidden = !now;
      try { localStorage.setItem("planner-metrics", now ? "open" : "closed"); } catch { /* storage unavailable */ }
      return true;
    }
    if (lvl) {
      const v = lvl.dataset.auditLevel;
      auditUI.levels = !v ? [] : auditUI.levels.includes(v) ? auditUI.levels.filter((x) => x !== v) : [...auditUI.levels, v];
      if (auditUI.cell && auditUI.levels.length && !auditUI.levels.includes(auditUI.cell.split("|")[2])) auditUI.cell = null;
    }
    if (!lvl && !cell && !kinds && !year && !open && !all && !t.closest("[data-audit-close]")) return false;
    if (lvl) { /* handled above */ }
    else if (open) { const k = open.dataset.auditOpen; if (auditUI.open.has(k)) auditUI.open.delete(k); else auditUI.open.add(k); }
    else if (all) auditUI.open = all.dataset.auditAll === "open"
      ? new Set([...main.querySelectorAll("[data-audit-open]")].map((b) => b.dataset.auditOpen)) : new Set();
    else if (cell) auditUI.cell = auditUI.cell === cell.dataset.auditCell ? null : cell.dataset.auditCell;
    else if (kinds) auditUI.kinds = kinds.dataset.auditKinds;
    else if (year) { const v = year.dataset.auditYear; auditUI.years = !v ? [] : auditUI.years.includes(v) ? auditUI.years.filter((x) => x !== v) : [...auditUI.years, v]; }
    else auditUI.cell = null;
    const ix = state.areas[state.area];
    const box = main.querySelector("[data-master]");
    if (ix && box) {
      box.innerHTML = masterDashboardHtml(ix, loadPlans().filter((p) => p.area === state.area));
      if (cell && auditUI.cell) box.querySelector(".au-detail")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      if (open) box.querySelector(`[data-audit-open="${CSS.escape(open.dataset.auditOpen)}"]`)?.focus();
    }
    return true;
  }

  function viewPlanner(ix) {
    const area = state.area;
    const plans = loadPlans().filter((p) => p.area === area).sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
    const rows = plans.map((p) => {
      const cov = planCoverage(ix, p);
      const other = cov.levels.filter((l) => l !== p.level);
      return `<tr>
        <td><a class="plan-name" href="${href(area, "planner", p.id)}">${esc(p.name || "Untitled plan")}</a>
          ${p.description ? `<p class="plan-desc">${esc(p.description.length > 140 ? p.description.slice(0, 140) + "…" : p.description)}</p>` : ""}</td>
        <td>${esc(p.yearGroup || "")}</td>
        <td><span class="lvl-pill ${lvlClass(p.level)}">${LEVEL_NAME[p.level] || ""}</span>${other.length
          ? `<small class="plan-also">also ${other.map((l) => LEVEL_NAME[l]).join(", ")}</small>` : ""}</td>
        <td>${cov.strands.length ? cov.strands.map((c) => `<div class="cov"><span class="cov-strand">${esc(c.strand.name)}</span>
          <span class="cov-subs">${c.subs.map((x) => `<span class="cov-sub">${esc(x)}</span>`).join("")}</span></div>`).join("")
          : `<span class="none">Nothing selected yet</span>`}</td>
        <td class="num">${cov.know}</td><td class="num">${cov.do}</td>
        <td>${fmtDate(p.updated)}</td>
        <td class="plan-actions" data-export-skip><a href="${href(area, "planner", p.id)}">Edit</a>
          <button type="button" class="link-btn" data-plan-dup="${esc(p.id)}">Duplicate</button>
          <button type="button" class="link-btn danger" data-plan-del="${esc(p.id)}">Delete</button></td>
      </tr>`;
    }).join("");
    main.innerHTML = `
      <div class="page-head"><h1>Planner</h1>
        <p>Plan a topic, unit or project and choose the Know and Do statements it covers. Plans are saved in this browser; use Export to keep a copy or move them to another device.</p></div>
      <div class="plan-toolbar">
        <button type="button" class="btn primary" data-plan-new>New plan</button>
        <button type="button" class="btn" data-plan-export ${plans.length ? "" : "disabled"}>Export plans</button>
        <label class="btn">Import plans<input type="file" accept="application/json,.json" data-plan-import hidden></label>
        <span class="plan-status" role="status"></span>
      </div>
      ${plans.length ? `<div class="table-head" data-export-scope><h2 class="block-title plans-h">All plans</h2>${exportBtn("plans", "Export to Word", "Plans")}
      <div class="plan-table-wrap"><table class="plan-table">
        <thead><tr><th scope="col">Plan</th><th scope="col">Year group</th><th scope="col">Level</th>
          <th scope="col">Strands and sub-strands covered</th><th scope="col" class="num">Know</th><th scope="col" class="num">Do</th>
          <th scope="col">Updated</th><th scope="col" data-export-skip><span class="visually-hidden">Actions</span></th></tr></thead>
        <tbody>${rows}</tbody></table></div></div>
      <div data-master>${masterDashboardHtml(ix, plans)}</div>`
        : `<div class="plan-empty"><p>No plans yet for ${esc(ix.doc.name)}.</p><p>Select <strong>New plan</strong> to start one.</p></div>`}`;
    document.title = `Planner · ${ix.doc.name} · Curriculum Explorer`;
  }

  function planPickerHtml(ix, plan) {
    const level = plan.level;
    const strands = ix.doc.strands.filter((s) => s.levels.includes(level));
    const subOptions = [{ value: "_whole", label: "Whole strand" }, ...ix.subs
      .filter((s) => s.entries.some((e) => e.node.levels.includes(level)))
      .map((s) => ({ value: s.slug, label: s.name }))];
    const inPlay = planUI.strands.length ? strands.filter((s) => planUI.strands.includes(s.slug)) : strands;
    const chosen = new Set(plan.statements || []);
    const cols = inPlay.map((s) => ({ strand: s, ...strandColumn(ix, s, level, planUI.subs) }))
      .filter((c) => c.groups.some((g) => g.sts.some((x) => x.kind === "know" || x.kind === "do")));
    const labels = new Set(cols.flatMap((c) => c.groups.filter((g) => g.sts.length).map((g) => g.label)));
    const showTags = labels.size > 1;
    const list = (g, k) => {
      const sts = g.sts.filter((x) => x.kind === k);
      return sts.length ? `<ul class="pick-list">${sts.map((x) => `<li><label class="pick">
        <input type="checkbox" data-pick="${esc(x.code)}" ${chosen.has(x.code) ? "checked" : ""}><span>${inlineMd(x.body)}</span></label></li>`).join("")}</ul>` : "";
    };
    const cell = (c, k) => c.groups.map((g) => { const l = list(g, k); return l ? (showTags ? `<p class="ss-tag ${g.origin}">${esc(g.label)}</p>` : "") + l : ""; }).join("")
      || `<p class="none">None at this level.</p>`;
    const chips = (label, all, options, sel, key) => `<div class="filter multi-filter" role="group" aria-label="${esc(label)}"><span>${esc(label)}</span>
      <button type="button" aria-pressed="${!sel.length}" data-pf="${key}" data-pf-value="">${esc(all)}</button>
      ${options.map((o) => `<button type="button" class="chip" aria-pressed="${sel.includes(o.value)}" data-pf="${key}" data-pf-value="${esc(o.value)}">${esc(o.label)}</button>`).join("")}</div>`;
    return `
      ${strands.length > 1 ? chips("Strands", "All strands", strands.map((s) => ({ value: s.slug, label: s.name })), planUI.strands, "strands") : ""}
      ${subOptions.length > 1 ? chips("Sub-strands", "All", subOptions, planUI.subs, "subs") : ""}
      ${cols.length ? `<div class="ss-wrap" tabindex="0" role="region" aria-label="Statements at ${LEVEL_NAME[level]} Level">
        <table class="ss-table plan-pick ${lvlClass(level)}" style="--cols:${cols.length}">
          <thead><tr><td class="corner"></td>${cols.map((c) => `<th scope="col">${esc(c.strand.name)}</th>`).join("")}</tr></thead>
          <tbody>
            <tr class="r-u"><th scope="row">Understand</th>${cols.map((c) => `<td>${c.und.map((u) => `<p class="ss-u">${esc(u.text)}</p>`).join("") || `<p class="none">—</p>`}</td>`).join("")}</tr>
            <tr class="r-k"><th scope="row">Know</th>${cols.map((c) => `<td>${cell(c, "know")}</td>`).join("")}</tr>
            <tr class="r-d"><th scope="row">Do</th>${cols.map((c) => `<td>${cell(c, "do")}</td>`).join("")}</tr>
          </tbody></table></div>` : `<p class="empty">Nothing matches these filters at ${LEVEL_NAME[level]} Level.</p>`}`;
  }

  function planSummaryHtml(ix, plan) {
    const picked = (plan.statements || []).map((c) => ix.statements.get(c)).filter(Boolean);
    if (!picked.length) return `<p class="none">No statements yet. Tick Know and Do statements in the table below to add them.</p>`;
    const byStrand = new Map();
    for (const h of picked) {
      const sub = h.depth > 0 ? h.node.name : "Whole strand";
      if (!byStrand.has(h.strand)) byStrand.set(h.strand, new Map());
      const m = byStrand.get(h.strand);
      if (!m.has(sub)) m.set(sub, []);
      m.get(sub).push(h);
    }
    return ix.doc.strands.filter((s) => byStrand.has(s)).map((s) => `<div class="sum-strand"><h3>${esc(s.name)}</h3>${
      [...byStrand.get(s)].map(([sub, hs]) => `<div class="sum-sub"><p class="ss-tag ${sub === "Whole strand" ? "whole" : "sub"}">${esc(sub)}</p>${
        ["know", "do"].map((k) => { const xs = hs.filter((h) => h.s.kind === k); return xs.length ? `<p class="kd-h ${k}">${k === "know" ? "Know" : "Do"}</p><ul class="sum-list">${xs.map((h) =>
          `<li data-code="${esc(h.s.code)}"><span>${inlineMd(h.s.body)}${h.block.level !== plan.level ? ` <small class="plan-also">(${LEVEL_NAME[h.block.level]} Level)</small>` : ""}</span>
            <button type="button" class="link-btn" data-unpick="${esc(h.s.code)}" aria-label="Remove from plan">Remove</button></li>`).join("")}</ul>` : ""; }).join("")}</div>`).join("")}</div>`).join("");
  }

  function viewPlan(ix, id) {
    const area = state.area;
    const plan = getPlan(id);
    if (!plan) {
      main.innerHTML = `<div class="page-head"><h1>Plan not found</h1><p>It may have been deleted, or it was saved in a different browser.</p>
        <p class="page-links"><a href="${href(area, "planner")}">Back to all plans</a></p></div>`;
      return;
    }
    if (planUI.id !== plan.id || planUI.level !== plan.level) Object.assign(planUI, { id: plan.id, level: plan.level, strands: [], subs: [] });
    const cov = planCoverage(ix, plan);
    const suggested = YEAR_LEVEL[plan.yearGroup];
    main.innerHTML = `
      <p class="crumb plan-crumb"><a href="${href(area, "planner")}">← All plans</a></p>
      <div class="plan-head">
        <div class="plan-fields">
          <label class="fld fld-name"><span>Topic, unit or project</span>
            <input type="text" data-plan-field="name" value="${esc(plan.name || "")}" placeholder="e.g. Designing a smart garden" autocomplete="off"></label>
          <label class="fld"><span>Year group</span>
            <select data-plan-field="yearGroup">${YEAR_GROUPS.map((y) => `<option${y === plan.yearGroup ? " selected" : ""}>${y}</option>`).join("")}</select></label>
          <label class="fld"><span>Level</span>
            <select data-plan-field="level">${LEVELS.map((l) => `<option value="${l.code}"${l.code === plan.level ? " selected" : ""}>${l.name} Level</option>`).join("")}</select>
            ${suggested && suggested !== plan.level ? `<small class="fld-hint">${esc(plan.yearGroup)} usually works at ${LEVEL_NAME[suggested]} Level</small>` : ""}</label>
          <label class="fld fld-desc"><span>What is planned</span>
            <textarea data-plan-field="description" rows="4" placeholder="Describe the learning, activities and outcomes">${esc(plan.description || "")}</textarea></label>
        </div>
        <div class="plan-side">
          <p class="plan-status" role="status">Saved</p>
          <p class="plan-count"><strong data-count="know">${cov.know}</strong> Know · <strong data-count="do">${cov.do}</strong> Do</p>
          <div class="plan-side-actions">
            <button type="button" class="btn" data-plan-print>Print</button>
            ${exportBtn("plan", "Export plan to Word")}
            <button type="button" class="btn danger" data-plan-del="${esc(plan.id)}">Delete plan</button>
          </div>
        </div>
      </div>
      <div class="plan-work">
        <aside class="plan-summary" id="plan-summary" aria-labelledby="plan-summary-h">
          <h2 class="block-title" id="plan-summary-h">In this plan <span class="sum-count">(<span data-count="total">${cov.know + cov.do}</span>)</span></h2>
          <p class="sum-last" role="status" aria-live="polite"></p>
          <div data-plan-summary>${planSummaryHtml(ix, plan)}</div>
        </aside>
        <section class="plan-picker level-section ${lvlClass(plan.level)}">
          <h2 class="section-title">${levelMark(plan.level)}Choose statements: ${LEVEL_NAME[plan.level]} Level</h2>
          <p class="section-sub">Tick the Know and Do statements this plan covers. Each change is added to the plan and saved straight away.</p>
          <div data-plan-picker>${planPickerHtml(ix, plan)}</div>
        </section>
      </div>
      <div class="plan-tray"><span><strong data-tray="count">${cov.know + cov.do}</strong> in this plan</span>
        <span class="tray-last" data-tray="last"></span><a href="#plan-summary" data-tray-link>See plan</a></div>`;
    document.title = `${plan.name || "Untitled plan"} · Planner · Curriculum Explorer`;
  }

  // Planner events (delegated; the planner views are re-rendered into main)
  function planStatus(text) { const el = main.querySelector(".plan-status"); if (el) el.textContent = text; }
  function savePlanAndReport(plan) { planStatus(putPlan(plan) ? `Saved ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Not saved: this browser is blocking storage"); }
  function refreshPlanParts(ix, plan, change) {
    const cov = planCoverage(ix, plan);
    const set = (sel, v) => main.querySelectorAll(sel).forEach((el) => { el.textContent = v; });
    set('[data-count="know"]', cov.know);
    set('[data-count="do"]', cov.do);
    set('[data-count="total"]', cov.know + cov.do);
    set('[data-tray="count"]', cov.know + cov.do);
    const aside = main.querySelector(".plan-summary");
    const keep = aside ? aside.scrollTop : 0;
    main.querySelector("[data-plan-summary]").innerHTML = planSummaryHtml(ix, plan);
    if (aside) aside.scrollTop = keep;
    if (!change) return;
    // say what changed, and point to it in the plan
    const h = ix.statements.get(change.code);
    const text = h ? h.s.body.replace(/\s+/g, " ") : "statement";
    const short = text.length > 70 ? text.slice(0, 70) + "…" : text;
    const msg = `${change.added ? "Added" : "Removed"} ${h ? (h.s.kind === "know" ? "Know" : "Do") : ""}: ${short}`;
    set(".sum-last", msg);
    set('[data-tray="last"]', msg);
    main.querySelector(".sum-last")?.classList.toggle("removed", !change.added);
    const tray = main.querySelector(".plan-tray");
    if (tray) { tray.classList.add("show"); clearTimeout(tray._t); tray._t = setTimeout(() => tray.classList.remove("show"), 4000); }
    if (change.added) {
      const li = main.querySelector(`.sum-list li[data-code="${CSS.escape(change.code)}"]`);
      if (li) {
        li.classList.add("flash");
        // bring it into view inside the sticky panel without moving the page
        if (aside && getComputedStyle(aside).position === "sticky") {
          const a = aside.getBoundingClientRect(), b = li.getBoundingClientRect();
          if (b.top < a.top || b.bottom > a.bottom) aside.scrollTop += b.top - a.top - a.height / 3;
        }
      }
    }
  }
  async function plannerClick(e) {
    const r = parseHash(); const area = state.area; const ix = state.areas[area];
    if (!ix || r.view !== "planner") return false;
    const t = e.target;
    if (t.closest("[data-plan-new]")) {
      const yearGroup = "P5";
      const plan = { id: newPlanId(), area, name: "", yearGroup, level: YEAR_LEVEL[yearGroup], description: "", statements: [],
        created: new Date().toISOString() };
      putPlan(plan);
      location.hash = href(area, "planner", plan.id);
      return true;
    }
    const del = t.closest("[data-plan-del]");
    if (del) {
      const p = getPlan(del.dataset.planDel);
      if (p && confirm(`Delete “${p.name || "Untitled plan"}”? This cannot be undone.`)) {
        storePlans(loadPlans().filter((x) => x.id !== p.id));
        if (r.a) location.hash = href(area, "planner"); else viewPlanner(ix);
      }
      return true;
    }
    const dup = t.closest("[data-plan-dup]");
    if (dup) {
      const p = getPlan(dup.dataset.planDup);
      if (p) { putPlan({ ...p, id: newPlanId(), name: `${p.name || "Untitled plan"} (copy)`, created: new Date().toISOString() }); viewPlanner(ix); }
      return true;
    }
    if (t.closest("[data-plan-export]")) {
      const blob = new Blob([JSON.stringify({ format: "cic-plans", version: 1, plans: loadPlans() }, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = `curriculum-plans-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return true;
    }
    if (t.closest("[data-plan-print]")) { window.print(); return true; }
    if (t.closest("[data-tray-link]")) {
      const aside = main.querySelector("#plan-summary");
      aside?.scrollIntoView({ behavior: "smooth", block: "start" });
      aside?.querySelector("h2")?.setAttribute("tabindex", "-1");
      aside?.querySelector("h2")?.focus({ preventScroll: true });
      return true;
    }
    const pf = t.closest("[data-pf]");
    if (pf && r.a) {
      const key = pf.dataset.pf, v = pf.dataset.pfValue;
      planUI[key] = !v ? [] : planUI[key].includes(v) ? planUI[key].filter((x) => x !== v) : [...planUI[key], v];
      const plan = getPlan(r.a);
      if (plan) main.querySelector("[data-plan-picker]").innerHTML = planPickerHtml(ix, plan);
      return true;
    }
    const un = t.closest("[data-unpick]");
    if (un && r.a) {
      const plan = getPlan(r.a);
      if (!plan) return true;
      plan.statements = plan.statements.filter((c) => c !== un.dataset.unpick);
      savePlanAndReport(plan);
      const box = main.querySelector(`input[data-pick="${CSS.escape(un.dataset.unpick)}"]`);
      if (box) box.checked = false;
      refreshPlanParts(ix, plan, { code: un.dataset.unpick, added: false });
      return true;
    }
    return false;
  }
  function plannerChange(e) {
    const r = parseHash(); const ix = state.areas[state.area];
    if (!ix || r.view !== "planner") return;
    const t = e.target;
    if (t.matches("[data-plan-import]")) {
      const file = t.files && t.files[0];
      if (!file) return;
      file.text().then((txt) => {
        let incoming;
        try { const d = JSON.parse(txt); incoming = Array.isArray(d) ? d : d.plans; } catch { incoming = null; }
        if (!Array.isArray(incoming)) { planStatus("That file is not a plans export."); return; }
        const ok = incoming.filter((p) => p && typeof p.id === "string" && Array.isArray(p.statements)).map((p) => ({
          id: p.id, area: String(p.area || state.area), name: String(p.name || ""), yearGroup: YEAR_GROUPS.includes(p.yearGroup) ? p.yearGroup : "P1",
          level: LEVEL_NAME[p.level] ? p.level : "early", description: String(p.description || ""),
          statements: p.statements.filter((c) => typeof c === "string"), created: p.created || new Date().toISOString(), updated: p.updated || new Date().toISOString() }));
        const plans = loadPlans();
        for (const p of ok) { const i = plans.findIndex((x) => x.id === p.id); if (i >= 0) plans[i] = p; else plans.push(p); }
        storePlans(plans);
        viewPlanner(ix);
        planStatus(`Imported ${ok.length} plan${ok.length === 1 ? "" : "s"}.`);
      });
      return;
    }
    if (!r.a) return;
    const plan = getPlan(r.a);
    if (!plan) return;
    if (t.matches("[data-pick]")) {
      const set = new Set(plan.statements);
      if (t.checked) set.add(t.dataset.pick); else set.delete(t.dataset.pick);
      // keep the order the statements appear in the framework
      plan.statements = [...ix.statements.keys()].filter((c) => set.has(c)).concat([...set].filter((c) => !ix.statements.has(c)));
      savePlanAndReport(plan);
      refreshPlanParts(ix, plan, { code: t.dataset.pick, added: t.checked });
      return;
    }
    const field = t.dataset.planField;
    if (field === "yearGroup" || field === "level") {
      if (planPending) flushPlanText();          // keep typed text before the page is redrawn
      Object.assign(plan, getPlan(plan.id));
      plan[field] = t.value;
      // a new year group moves the level to its usual one while nothing has been chosen yet
      if (field === "yearGroup" && !plan.statements.length && YEAR_LEVEL[t.value]) plan.level = YEAR_LEVEL[t.value];
      savePlanAndReport(plan);
      const y = window.scrollY;
      viewPlan(ix, plan.id);
      planStatus(`Saved ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
      window.scrollTo(0, y);
    }
  }
  // Save every text field of the open plan together, so a quick switch between fields never drops an edit
  let planPending = null;
  function flushPlanText() {
    clearTimeout(planSaveTimer); planSaveTimer = null;
    const id = planPending; planPending = null;
    const plan = id && getPlan(id);
    if (!plan) return;
    for (const el of main.querySelectorAll('[data-plan-field="name"], [data-plan-field="description"]')) plan[el.dataset.planField] = el.value;
    savePlanAndReport(plan);
  }
  function plannerInput(e) {
    const r = parseHash();
    const t = e.target;
    if (r.view !== "planner" || !r.a || !["name", "description"].includes(t.dataset.planField)) return;
    planStatus("Saving…");
    clearTimeout(planSaveTimer);
    planPending = r.a;
    planSaveTimer = setTimeout(flushPlanText, 400);
  }
  // leaving the plan (any navigation) saves pending text first, while its fields are still on the page
  window.addEventListener("hashchange", () => { if (planPending) flushPlanText(); });
  window.addEventListener("pagehide", () => { if (planPending) flushPlanText(); });
  main.addEventListener("change", plannerChange);
  main.addEventListener("input", plannerInput);

  // ---------------------------------------------------------------- export to Word (.docx)
  // Any table on the site can be saved as a formatted Word document. The docx library is loaded on first use.
  const DOCX_SRC = "https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.js";
  const DOCX_SRI = "sha384-4xaIisuLEy2lo2HkB2C4rEf7v8jbTb2kuogX6TkuEt9feTWKBSFSOzsqNNbV+sKh";
  let docxLoading = null;
  function loadDocx() {
    if (window.docx) return Promise.resolve(window.docx);
    docxLoading ||= new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = DOCX_SRC; s.integrity = DOCX_SRI; s.crossOrigin = "anonymous";
      s.onload = () => (window.docx ? resolve(window.docx) : reject(new Error("Word export library did not load")));
      s.onerror = () => { docxLoading = null; reject(new Error("Could not load the Word export library. Check your internet connection and try again.")); };
      document.head.appendChild(s);
    });
    return docxLoading;
  }
  const exportBtn = (kind, label = "Export to Word", title = "") =>
    `<button type="button" class="export-btn" data-export="${kind}"${title ? ` data-export-title="${esc(title)}"` : ""}><span aria-hidden="true">⇩</span> ${label}</button>`;

  function rgbToHex(c) {
    const m = String(c).match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/);
    if (!m || (m[4] !== undefined && Number(m[4]) === 0)) return null;
    return [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("").toUpperCase();
  }
  // Exported documents are always light: use the light theme's colours for headers, whatever the screen shows
  function lightColours(el) {
    const root = document.documentElement, was = root.getAttribute("data-theme");
    root.setAttribute("data-theme", "light");
    const cs = getComputedStyle(el);
    const out = { fill: rgbToHex(cs.backgroundColor), text: rgbToHex(cs.color) };
    if (was === null) root.removeAttribute("data-theme"); else root.setAttribute("data-theme", was);
    return out;
  }

  /** Turn the content of one table cell into docx paragraphs. */
  function cellToParagraphs(D, cell, base = {}) {
    const paras = [];
    let runs = [];
    const SKIP = ".m-more, .au-meter, .kd-flip, .link-btn, .visually-hidden, [aria-hidden='true'], input, .kd-turn, .ss-note";
    const flush = (opts = {}) => {
      if (runs.length) paras.push(new D.Paragraph({ children: runs, spacing: { after: 40 }, ...opts }));
      runs = [];
    };
    const text = (t, fmt) => {
      t = t.replace(/\s+/g, " ");
      if (!t.trim() && !runs.length) return;
      runs.push(new D.TextRun({ text: t, size: fmt.size || 17, bold: fmt.bold, italics: fmt.italics, color: fmt.color, font: "Calibri" }));
    };
    const walk = (node, fmt, bulletLevel) => {
      if (node.nodeType === 3) { text(node.nodeValue, fmt); return; }
      if (node.nodeType !== 1 || node.matches(SKIP) || node.hidden) return;
      const tag = node.tagName, cls = node.classList;
      if (tag === "UL" || tag === "OL") {
        flush();
        if (cls.contains("tags")) {           // sub-strand tags in the Understandings matrix
          paras.push(new D.Paragraph({ children: [new D.TextRun({ text: "Sub-strands: ", bold: true, size: 15, color: "555555", font: "Calibri" }),
            new D.TextRun({ text: [...node.querySelectorAll("li")].map((li) => li.textContent.trim()).join(", "), size: 15, color: "555555", font: "Calibri" })],
            spacing: { before: 60, after: 40 } }));
          return;
        }
        for (const li of node.children) {
          if (li.tagName !== "LI") continue;
          const sub = [...li.childNodes];
          for (const c of sub) {
            if (c.nodeType === 1 && (c.tagName === "UL" || c.tagName === "OL")) { flush({ numbering: { reference: "kd-bullets", level: bulletLevel } }); walk(c, fmt, bulletLevel + 1); }
            else walk(c, fmt, bulletLevel);
          }
          flush({ numbering: { reference: "kd-bullets", level: bulletLevel } });
        }
        return;
      }
      if (tag === "BR") { runs.push(new D.TextRun({ break: 1 })); return; }
      let f = fmt;
      if (tag === "STRONG" || tag === "B" || tag === "H5" || cls.contains("m-on") || cls.contains("au-num")) f = { ...f, bold: true };
      if (tag === "EM" || tag === "I" || cls.contains("none") || cls.contains("plan-also")) f = { ...f, italics: true, color: f.color || "666666" };
      if (tag === "SMALL" || cls.contains("au-plans") || cls.contains("au-pct")) f = { ...f, size: 15, color: f.color || "555555" };
      if (cls.contains("au-gap")) f = { ...f, bold: true, color: "A13A32" };
      if (cls.contains("ss-tag")) {              // a sub-strand / origin label heading a group
        flush();
        paras.push(new D.Paragraph({ children: [new D.TextRun({ text: node.textContent.trim(), bold: true, size: 16, color: "1D2433", font: "Calibri" })],
          spacing: { before: paras.length ? 120 : 0, after: 40 }, border: { bottom: { style: D.BorderStyle.SINGLE, size: 4, color: "B9C3C8", space: 1 } } }));
        return;
      }
      if (cls.contains("kd-h")) f = { ...f, bold: true, color: cls.contains("do") || node.closest(".do") ? "2D7A4E" : "2B4F8F" };
      if (tag === "DETAILS") {                     // notes: include them in full
        flush();
        const label = node.querySelector("summary")?.textContent.trim().replace(/\s*\(\d+\)$/, "") || "Notes";
        paras.push(new D.Paragraph({ children: [new D.TextRun({ text: label, bold: true, italics: true, size: 16, color: "5B5480", font: "Calibri" })], spacing: { before: 80, after: 20 } }));
        for (const c of node.children) if (c.tagName !== "SUMMARY") walk(c, { ...fmt, size: 16, color: "333333" }, bulletLevel);
        flush();
        return;
      }
      const block = /^(P|DIV|H[1-6]|SECTION|ARTICLE|LI)$/.test(tag);
      if (block) flush();
      for (const c of node.childNodes) walk(c, f, bulletLevel);
      if (block) flush(tag === "H5" ? { spacing: { before: 60, after: 20 } } : {});
    };
    for (const c of cell.childNodes) walk(c, base, 0);
    flush();
    return paras.length ? paras : [new D.Paragraph({ children: [] })];
  }

  /** Build and download a .docx holding one HTML table. */
  async function exportTableDocx(table, { title, subtitle, filename, ratios }) {
    const D = await loadDocx();
    const rows = [...table.querySelectorAll(":scope > thead > tr, :scope > tbody > tr, :scope > tr")];
    const nCols = Math.max(...rows.map((r) => [...r.children].filter((c) => !c.hasAttribute("data-export-skip")).reduce((n, c) => n + (Number(c.getAttribute("colspan")) || 1), 0)));
    const firstIsHead = rows.some((r) => r.parentElement.tagName === "TBODY" && r.children[0]?.tagName === "TH");
    // landscape A4 content width ~ 15,400 dxa; narrower first column when rows have headings
    const total = 15400, first = firstIsHead ? Math.min(2600, Math.round(total / (nCols + 1))) : Math.round(total / nCols);
    const widths = ratios && ratios.length === nCols ? ratios.map((r) => Math.round(total * r)) : Array.from({ length: nCols }, (_, i) => (firstIsHead && i === 0 ? first : Math.round((total - (firstIsHead ? first : 0)) / (nCols - (firstIsHead ? 1 : 0)))));
    const border = { style: D.BorderStyle.SINGLE, size: 4, color: "C9CED6" };
    const docRows = rows.map((tr) => {
      const isHead = tr.parentElement.tagName === "THEAD";
      let col = 0;
      const cells = [...tr.children].filter((c) => !c.hasAttribute("data-export-skip")).map((c) => {
        const span = Number(c.getAttribute("colspan")) || 1;
        const w = widths.slice(col, col + span).reduce((a, b) => a + b, 0); col += span;
        const colours = lightColours(c);
        const rowHead = !isHead && c.tagName === "TH";
        let fill = isHead ? colours.fill || "1D2433" : rowHead ? "EEF1F6" : null;
        if (!isHead && tr.classList.contains("r-u")) fill = rowHead ? "EEF1F6" : "F3EDF7";
        const txt = isHead ? (colours.text && colours.fill ? colours.text : "FFFFFF") : undefined;
        const kdColour = rowHead ? (tr.classList.contains("r-k") ? "2B4F8F" : tr.classList.contains("r-d") ? "2D7A4E" : tr.classList.contains("r-u") ? "6B3F8A" : undefined) : undefined;
        return new D.TableCell({
          width: { size: w, type: D.WidthType.DXA }, columnSpan: span > 1 ? span : undefined,
          shading: fill ? { fill, type: D.ShadingType.CLEAR, color: "auto" } : undefined,
          margins: { top: 60, bottom: 60, left: 90, right: 90 },
          verticalAlign: isHead ? D.VerticalAlign.BOTTOM : D.VerticalAlign.TOP,
          children: cellToParagraphs(D, c, isHead || rowHead ? { bold: true, size: isHead ? 18 : 17, color: txt || kdColour } : {}),
        });
      });
      return new D.TableRow({ children: cells, tableHeader: isHead, cantSplit: false });
    });
    const docTable = new D.Table({
      rows: docRows, width: { size: total, type: D.WidthType.DXA }, columnWidths: widths, layout: D.TableLayoutType.FIXED,
      borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    });
    const src = state.areas[state.area]?.doc.source || {};
    const doc = new D.Document({
      creator: "Curriculum Explorer", title,
      numbering: { config: [{ reference: "kd-bullets", levels: [0, 1, 2].map((level) => ({
        level, format: D.LevelFormat.BULLET, text: ["•", "◦", "▪"][level], alignment: D.AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 200 + level * 200, hanging: 160 } }, run: { size: 17 } },
      })) }] },
      styles: { default: { document: { run: { font: "Calibri", size: 18 } } } },
      sections: [{
        properties: { page: { size: { orientation: D.PageOrientation.LANDSCAPE }, margin: { top: 720, bottom: 720, left: 720, right: 720 } } },
        footers: { default: new D.Footer({ children: [new D.Paragraph({ alignment: D.AlignmentType.RIGHT, children: [
          new D.TextRun({ text: `${src.title || ""}${src.title ? " · " : ""}Exported ${new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })} · Page `, size: 14, color: "777777" }),
          new D.TextRun({ children: [D.PageNumber.CURRENT], size: 14, color: "777777" })] })] }) },
        children: [
          new D.Paragraph({ heading: D.HeadingLevel.HEADING_1, children: [new D.TextRun({ text: title, bold: true, size: 32, color: "18222D", font: "Calibri" })], spacing: { after: 60 } }),
          ...subtitle.filter(Boolean).map((t) => new D.Paragraph({ children: [new D.TextRun({ text: t, size: 18, color: "56626E", font: "Calibri" })], spacing: { after: 40 } })),
          new D.Paragraph({ children: [], spacing: { after: 80 } }),
          docTable,
        ],
      }],
    });
    const blob = await D.Packer.toBlob(doc);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 90) + ".docx";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /** Describe what the current page is showing, for the document's subtitle lines. */
  function pageContext() {
    const r = parseHash();
    const parts = [];
    const pressed = (sel) => [...main.querySelectorAll(sel)].filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent.trim());
    if (main.querySelector(".whole-toggle .chip[aria-pressed='true']")) parts.push("Includes statements without a sub-strand");
    const filt = [...main.querySelectorAll(".filter:not(.whole-toggle), .multi-filter")].map((f) => {
      const label = f.querySelector(":scope > span")?.textContent.trim();
      const on = [...f.querySelectorAll("button[aria-pressed='true']")].map((b) => b.textContent.trim());
      return label && on.length ? `${label}: ${on.join(", ")}` : "";
    }).filter((x) => x && !/Know and Do$|All strands$|All$|Everything$|All year groups$|All levels$/.test(x));
    if (r.view === "substrand") {
      const subs = pressed(".sub-grid .sub-chip").filter((v, i, a) => a.indexOf(v) === i);
      if (subs.length) parts.push(`Sub-strands: ${subs.join(", ")}`);
    }
    if (filt.length) parts.push(filt.join(" · "));
    return parts;
  }

  async function handleExport(btn) {
    const kind = btn.dataset.export;
    const ix = state.areas[state.area];
    const areaName = ix?.doc.name || "";
    const h1 = main.querySelector(".page-head h1, .fld-name input")?.textContent?.trim() || main.querySelector(".fld-name input")?.value || "";
    const old = btn.innerHTML;
    btn.disabled = true; btn.textContent = "Preparing…";
    let holder = null;
    try {
      let table, title, sub = [], filename, ratios;
      if (kind === "kd") {
        // re-draw this table in the stacked layout (cards and side-by-side are screen layouts) off screen
        const block = btn.closest(".kd-block");
        const t = KD_TABLES.get(block.id);
        holder = document.createElement("div");
        holder.className = "export-holder"; holder.setAttribute("aria-hidden", "true");
        holder.innerHTML = kdTable(t.cols, { ...t.o, condensed: false }, { ...t.opts, id: `${t.opts.id}-x`, layout: "stacked" });
        KD_TABLES.delete(`${t.opts.id}-x`);
        main.appendChild(holder);
        table = holder.querySelector("table");
        const section = block.closest(".level-section")?.querySelector(".section-title")?.textContent.trim();
        title = section ? `${h1} – ${section}` : t.opts.label && t.opts.label.startsWith(h1) ? t.opts.label : h1;
        const show = t.o.showKD === "k" ? "Know statements" : t.o.showKD === "d" ? "Do statements" : "Know and Do statements";
        sub = [`${areaName} · ${show}`, ...pageContext()];
      } else if (kind === "plan") {
        const plan = getPlan(parseHash().a);
        const groups = new Map();
        for (const code of plan.statements || []) {
          const h = ix.statements.get(code);
          if (!h) continue;
          const key = `${h.strand.slug}|${h.depth > 0 ? h.node.slug : "_whole"}|${h.block.level}`;
          if (!groups.has(key)) groups.set(key, { strand: h.strand, sub: h.depth > 0 ? h.node.name : "Whole strand", level: h.block.level, know: [], do: [] });
          if (h.s.kind === "know" || h.s.kind === "do") groups.get(key)[h.s.kind].push(h.s.body);
        }
        const list = (xs) => xs.length ? `<ul>${xs.map((x) => `<li>${inlineMd(x)}</li>`).join("")}</ul>` : `<p class="none">None</p>`;
        const multiLevel = new Set([...groups.values()].map((g) => g.level)).size > 1;
        holder = document.createElement("div");
        holder.className = "export-holder"; holder.setAttribute("aria-hidden", "true");
        holder.innerHTML = `<table class="ss-table ${lvlClass(plan.level)}"><thead><tr><th>Strand</th><th>Sub-strand</th><th>Know</th><th>Do</th></tr></thead><tbody>${
          [...groups.values()].map((g) => `<tr><th>${esc(g.strand.name)}</th><td><p>${esc(g.sub)}</p>${multiLevel ? `<p class="none">${LEVEL_NAME[g.level]} Level</p>` : ""}</td><td>${list(g.know)}</td><td>${list(g.do)}</td></tr>`).join("")
          || `<tr><td colspan="4"><p class="none">No statements chosen yet.</p></td></tr>`}</tbody></table>`;
        main.appendChild(holder);
        table = holder.querySelector("table");
        title = plan.name || "Untitled plan";
        ratios = [0.18, 0.14, 0.34, 0.34];
        sub = [`${areaName} · ${plan.yearGroup} · ${LEVEL_NAME[plan.level]} Level`, plan.description ? `What is planned: ${plan.description}` : ""];
      } else {
        const scope = btn.closest("[data-export-scope]") || main;
        table = scope.querySelector("table");
        title = btn.dataset.exportTitle || h1;
        sub = [areaName, ...(kind === "audit" ? [main.querySelector(".master-h small")?.textContent.trim()] : []), ...pageContext()];
      }
      filename = `${areaName} ${title}`;
      await exportTableDocx(table, { title, subtitle: sub, filename, ratios });
      btn.textContent = "Saved ✓";
      setTimeout(() => { btn.innerHTML = old; btn.disabled = false; }, 1500);
    } catch (err) {
      btn.innerHTML = old; btn.disabled = false;
      alert(err.message || "The Word document could not be created.");
    } finally {
      holder?.remove();
    }
  }

  function scrollToId(id) {
    const el = document.getElementById(id);
    if (el) requestAnimationFrame(() => el.scrollIntoView({ block: "start" }));
  }

  // ---------------------------------------------------------------- routing
  function parseHash() {
    const [path, query] = location.hash.replace(/^#\/?/, "").split("?");
    const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
    const params = new URLSearchParams(query || "");
    return { area: parts[0], view: parts[1] || "overview", a: parts[2], b: parts[3], params };
  }

  async function loadArea(slug) {
    if (!state.areas[slug]) {
      const entry = state.manifest.find((m) => m.slug === slug);
      const res = await fetch(DATA_DIR + entry.file);
      if (!res.ok) throw new Error(`Could not load ${entry.file} (HTTP ${res.status}).`);
      state.areas[slug] = indexArea(await res.json());
    }
    return state.areas[slug];
  }

  async function route() {
    const r = parseHash();
    const areaSlug = state.manifest.some((m) => m.slug === r.area) ? r.area : state.manifest[0].slug;
    if (areaSlug !== r.area) { location.replace(href(areaSlug, "overview")); return; }
    KD_TABLES.clear();
    if (HIDDEN_VIEWS.has(r.view)) { location.replace(href(areaSlug, "overview")); return; }
    state.area = areaSlug;
    const ix = await loadArea(areaSlug);

    document.getElementById("area-name").textContent = ix.doc.name;
    document.getElementById("area-select").value = areaSlug;
    const src = ix.doc.source || {};
    document.getElementById("source-note").textContent =
      `Source: ${src.title || ix.doc.name}${src.version ? `, version ${src.version}` : ""}${src.status === "draft" ? ". These are draft materials and may change." : "."}`;

    document.querySelectorAll("nav.primary a").forEach((a) => {
      const v = a.dataset.view;
      a.href = href(areaSlug, v);
      if (v === r.view) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });

    document.body.classList.toggle("wide", ["progression", "matrix", "substrand", "level", "strand", "planner"].includes(r.view));
    if (!r.b) window.scrollTo(0, 0);   // a 4th segment (strand or level) scrolls to that section instead
    if (r.view === "level") viewLevel(ix, r.a || LEVELS[0].code, r.b, r.params);
    else if (r.view === "strand") viewStrand(ix, r.a, r.b, r.params);
    else if (r.view === "substrand") viewSubstrand(ix, r.a, r.b, r.params.get("strand"), r.params.get("whole") === "1", r.params);
    else if (r.view === "matrix") viewMatrix(ix);
    else if (r.view === "planner") { if (r.a) viewPlan(ix, r.a); else viewPlanner(ix); }
    else if (r.view === "progression") viewProgression(ix, r.params);
    else viewOverview(ix);
  }

  // Buttons that navigate (stair, filters)
  // Sub-strand grid: hovering or focusing a sub-strand highlights it at every level it appears
  const linkSubs = (e) => {
    const chip = e.target.closest?.(".sub-chip");
    const grid = e.target.closest?.(".sub-grid");
    main.querySelectorAll(".sub-chip.linked").forEach((c) => c.classList.remove("linked"));
    main.querySelectorAll(".sub-grid.hovering").forEach((g) => g.classList.remove("hovering"));
    if (chip && grid) {
      grid.classList.add("hovering");
      grid.querySelectorAll(`.sub-chip[data-sub="${CSS.escape(chip.dataset.sub)}"]`).forEach((c) => c.classList.add("linked"));
    }
  };
  main.addEventListener("mouseover", linkSubs);
  function flipCard(card) {
    const to = card.dataset.face === "know" ? "do" : "know";
    card.dataset.face = to;
    const label = card.getAttribute("aria-label").split(":")[0];
    card.setAttribute("aria-label", `${label}: showing ${to === "do" ? "Do" : "Know"}. Select to show ${to === "do" ? "Know" : "Do"}.`);
  }
  main.addEventListener("keydown", (e) => {
    const card = e.target.classList?.contains("kd-card") ? e.target : null;
    if (card && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); flipCard(card); }
  });
  main.addEventListener("focusin", linkSubs);

  main.addEventListener("click", (e) => {
    const exp = e.target.closest("button[data-export]");
    if (exp) { handleExport(exp); return; }
    if (parseHash().view === "planner" && auditClick(e)) return;
    if (parseHash().view === "planner" && e.target.closest("[data-plan-new], [data-plan-del], [data-plan-dup], [data-plan-export], [data-plan-print], [data-pf], [data-unpick], [data-tray-link]")) {
      e.preventDefault();
      plannerClick(e);
      return;
    }
    // Know/Do layout for one table: redraw just that table and remember the choice
    const lay = e.target.closest("button[data-kd-layout]");
    if (lay) {
      const block = lay.closest(".kd-block");
      const t = block && KD_TABLES.get(block.id);
      if (t) {
        rememberLayout(lay.dataset.kdLayout);
        block.outerHTML = kdTable(t.cols, t.o, { ...t.opts, layout: lay.dataset.kdLayout });
        document.querySelector(`#${t.opts.id} button[data-kd-layout="${lay.dataset.kdLayout}"]`)?.focus();
      }
      return;
    }
    // Turn a Know/Do card over: anywhere on the card, except its notes, links or selected text
    const card = e.target.closest(".kd-card");
    if (card && !e.target.closest("details, a, button") && !String(window.getSelection?.() || "")) {
      flipCard(card);
      return;
    }
    const toggle = e.target.closest("button.pm-toggle");
    if (toggle) setStrandsOpen([toggle.dataset.strand], toggle.getAttribute("aria-expanded") !== "true");
    const expand = e.target.closest("button[data-expand]");
    if (expand) setStrandsOpen([expand.dataset.expand], true);
    const all = e.target.closest("button[data-pm-all]");
    if (all) setStrandsOpen([...main.querySelectorAll(".pm-toggle")].map((b) => b.dataset.strand), all.dataset.pmAll === "open");
    // What the progression cells show: keep whichever strands are expanded right now
    const show = e.target.closest("button[data-show]");
    if (show) location.hash = progressionHref(parseHash().area, show.dataset.show, openStrands());
    // Buttons that navigate (stair, filters)
    const b = e.target.closest("button[data-go]");
    if (b && b.dataset.go.startsWith("#")) location.hash = b.dataset.go;
  });

  async function init() {
    try {
      const res = await fetch(DATA_DIR + "areas.json");
      if (!res.ok) throw new Error(`Could not load areas.json (HTTP ${res.status}).`);
      state.manifest = (await res.json()).areas;
      if (!state.manifest.length) throw new Error("No curriculum areas have been extracted yet. Run tools/extract/run.sh first.");
      const sel = document.getElementById("area-select");
      sel.innerHTML = state.manifest.map((m) => `<option value="${esc(m.slug)}">${esc(m.name)}</option>`).join("");
      document.getElementById("area-pick").hidden = state.manifest.length < 2;
      sel.addEventListener("change", () => { location.hash = href(sel.value, parseHash().view); });
      window.addEventListener("hashchange", () => route().catch(showError));
      await route();
    } catch (err) {
      showError(err);
    }
  }

  function showError(err) {
    const fileHint = location.protocol === "file:"
      ? " Browsers block loading data from files opened directly. Start a local server from the model folder (python3 -m http.server 8080) and open http://localhost:8080/web/."
      : "";
    main.innerHTML = `<div class="page-head"><h1>The curriculum could not be loaded</h1><p>${esc(err.message)}${esc(fileHint)}</p></div>`;
  }

  init();
})();
