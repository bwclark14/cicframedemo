/* Curriculum Explorer
 * Static browser for CIC Know-Do-Understand frameworks.
 * Reads ../data/areas.json and each <area>.area.json (see curriculum.schema.json).
 *
 * Routes (hash):
 *   #/<area>/overview
 *   #/<area>/level/<level>[/<strand>]
 *   #/<area>/strand/<strand>[/<level>]
 *   #/<area>/matrix
 *   #/<area>/progression?strands=a,b&subs=business,cyber&scope=selected&levels=third,fourth&show=u,k,d,x,w&layout=down
 *   #/<area>/substrand/<sub>[,<sub>…][/<level>][?strand=<strand>]
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
    const nodes = [];               // flattened {node, strand, parent, depth}
    const visit = (node, strand, parent, depth) => {
      nodes.push({ node, strand, parent, depth });
      for (const b of node.blocks || []) blocks.set(b.code, { block: b, node, strand });
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
    return { doc, blocks, nodes, subs: [...subs.values()] };
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

  function viewLevel(ix, level, focusStrand) {
    level = LEVEL_NAME[level] ? level : "early";
    const area = state.area;
    const strands = ix.doc.strands.filter((s) => s.levels.includes(level));
    main.innerHTML = `
      <div class="page-head"><h1>${LEVEL_NAME[level]} Level</h1>
        <p>Everything learners know, do and understand in ${esc(ix.doc.name)} at ${LEVEL_NAME[level]} Level, strand by strand.</p></div>
      ${stairHtml(level, ix, (c) => href(area, "level", c))}
      <ul class="jump" aria-label="Strands at this level">${strands.map((s) => `<li><a href="${href(area, "level", level, s.slug)}">${esc(s.name)}</a></li>`).join("")}</ul>
      ${strands.map((s) => `
        <section class="strand-section ${lvlClass(level)}" id="s-${esc(s.slug)}">
          <h2 class="section-title">${levelMark(level)}<a href="${href(area, "strand", s.slug, level)}" style="text-decoration:none">${esc(s.name)}</a></h2>
          <p class="section-sub">${(s.children || []).some((c) => c.levels.includes(level))
            ? "Organised into sub-strands at this level." : "Taught as one strand at this level."}</p>
          ${strandAtLevel(ix, s, level)}
        </section>`).join("")}`;
    document.title = `${LEVEL_NAME[level]} Level · ${ix.doc.name} · Curriculum Explorer`;
    if (focusStrand) scrollToId("s-" + focusStrand);
  }

  function viewStrand(ix, slug, focusLevel) {
    const area = state.area;
    const strand = strandBySlug(ix, slug) || ix.doc.strands[0];
    const ladder = LEVELS.map((l) => {
      const anchors = (strand.blocks || []).filter((b) => b.level === l.code && b.understanding);
      const present = strand.levels.includes(l.code);
      return `<li class="${lvlClass(l.code)}${present ? "" : " absent"}">
        ${present ? `<a class="rung" href="${href(area, "strand", strand.slug, l.code)}">${l.name}</a>` : `<span class="rung">${l.name}</span>`}
        <div class="rung-text">${present ? anchors.map((a) => esc(a.understanding)).join("<br>") || "See sub-strands below." : "Not part of this level."}</div>
      </li>`;
    }).join("");
    main.innerHTML = `
      <div class="page-head"><h1>${esc(strand.name)}</h1>
        <p>${levelRange(strand.levels)}. How understanding in this strand builds from level to level.</p>
        <p class="page-links"><a href="${href(area, "progression")}?strands=${encodeURIComponent(strand.slug)}">Compare the levels side by side</a></p></div>
      <p class="picker-label" id="strand-pick">Strands</p>
      <ul class="picker" aria-labelledby="strand-pick">${ix.doc.strands.map((s) =>
        `<li><a href="${href(area, "strand", s.slug)}" aria-current="${s === strand}">${esc(s.name)}</a></li>`).join("")}</ul>
      <h2 class="block-title">Understanding at each level</h2>
      <ol class="ladder">${ladder}</ol>
      ${LEVELS.filter((l) => strand.levels.includes(l.code)).map((l) => `
        <section class="level-section ${lvlClass(l.code)}" id="l-${l.code}">
          <h2 class="section-title">${levelMark(l.code)}${l.name} Level</h2>
          ${strandAtLevel(ix, strand, l.code)}
        </section>`).join("")}`;
    document.title = `${strand.name} · ${ix.doc.name} · Curriculum Explorer`;
    if (focusLevel) scrollToId("l-" + focusLevel);
  }

  /** Join names as "A", "A and B", "A, B and C". */
  const listNames = (names) => names.length < 2 ? names.join("")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

  function viewSubstrand(ix, slugList, focusLevel, strandFilter) {
    const area = state.area;
    if (!ix.subs.length) {
      main.innerHTML = `<div class="page-head"><h1>Sub-strands</h1><p>${esc(ix.doc.name)} has no sub-strands. Browse by strand instead.</p></div>`;
      return;
    }
    // Selection is a comma-separated list in the URL, kept in picker order
    const wanted = new Set(String(slugList || "").split(",").filter(Boolean));
    let selected = ix.subs.filter((s) => wanted.has(s.slug));
    if (!selected.length) selected = [ix.subs[0]];
    const selSlugs = selected.map((s) => s.slug);
    const routeFor = (slugs, strand) =>
      href(area, "substrand", slugs.join(",")) + (strand ? "?strand=" + encodeURIComponent(strand) : "");

    // Strands that contain any selected sub-strand (for the filter); drop a filter that no longer applies
    const strands = [];
    for (const sub of selected) for (const e of sub.entries) if (!strands.includes(e.strand)) strands.push(e.strand);
    if (strandFilter && !strands.some((s) => s.slug === strandFilter)) strandFilter = null;

    const entriesOf = (sub) => sub.entries.filter((e) => !strandFilter || e.strand.slug === strandFilter);
    const levels = LEVELS.filter((l) => selected.some((sub) => entriesOf(sub).some((e) => e.node.levels.includes(l.code))));
    const multi = selected.length > 1;

    const blockHtml = (e, l) => {
      const blocks = (e.node.blocks || []).filter((b) => b.level === l.code);
      return `<section class="sub-block" aria-label="${esc(e.node.name)} in ${esc(e.strand.name)}">
        <h3><a href="${href(area, "strand", e.strand.slug, l.code)}">${esc(e.strand.name)}</a></h3>
        ${blocks.map((b) => {
          // Statements on the strand's own row apply to every sub-strand that shares its Understanding
          const anchor = b.anchor ? ix.blocks.get(b.anchor)?.block : null;
          const shared = anchor && anchor.statements?.length
            ? `<div class="shared"><h4>Across the whole ${esc(e.strand.name)} strand</h4>${statementsHtml(anchor)}</div>` : "";
          return understandingHtml(understandingOf(ix, b), {
            inherited: !b.understanding, small: true,
            label: b.understanding ? "Understand" : `Understand (shared across the ${e.strand.name} strand)`,
          }) + (statementsHtml(b) || `<p class="empty">No statements at this level.</p>`) + shared;
        }).join("")}
      </section>`;
    };

    const sections = levels.map((l) => {
      const groups = selected.map((sub) => {
        const here = entriesOf(sub).filter((e) => e.node.levels.includes(l.code));
        if (!here.length) return "";
        const blocks = here.map((e) => blockHtml(e, l)).join("");
        return multi
          ? `<div class="sub-group"><h3 class="group-title">${esc(sub.name)}</h3><div class="subs">${blocks}</div></div>`
          : `<div class="subs">${blocks}</div>`;
      }).join("");
      return `<section class="level-section ${lvlClass(l.code)}" id="l-${l.code}">
        <h2 class="section-title">${levelMark(l.code)}${l.name} Level</h2>${groups}</section>`;
    }).join("");

    const allLevels = [...new Set(selected.flatMap((sub) => sub.entries.flatMap((e) => e.node.levels)))];
    const names = selected.map((s) => s.name);
    const title = names.length > 3 ? `${names.length} sub-strands` : listNames(names);
    const intro = multi
      ? `${levelRange(allLevels)}. ${names.length > 3 ? esc(listNames(names)) + ", g" : "G"}athered from ${strands.length} strand${strands.length === 1 ? "" : "s"} and grouped by level.`
      : `${levelRange(allLevels)}. ${esc(selected[0].name)} appears in ${strands.length} strand${strands.length === 1 ? "" : "s"}; this page gathers it from each.`;

    main.innerHTML = `
      <div class="page-head"><h1>${esc(title)}</h1><p>${intro}</p>${strandFilter || strands.length === 1 ? (() => {
        const st = strandFilter ? strands.find((x) => x.slug === strandFilter) : strands[0];
        const subs = selected.filter((sub) => sub.entries.some((e) => e.strand === st)).map((sub) => sub.slug);
        return `<p class="page-links"><a href="${href(area, "progression")}?strands=${encodeURIComponent(st.slug)}&subs=${subs.join(",")}&scope=selected">See ${esc(st.name)} progression through the levels</a></p>`;
      })() : ""}</div>
      <div class="picker-bar">
        <p class="picker-label" id="sub-pick">Sub-strands <span class="hint">Select one or more</span></p>
        <button type="button" class="link-btn" data-go="${routeFor(ix.subs.map((s) => s.slug), strandFilter)}">Select all</button>
      </div>
      <ul class="picker" aria-labelledby="sub-pick">${ix.subs.map((s) => {
        const on = selSlugs.includes(s.slug);
        const next = on ? selSlugs.filter((x) => x !== s.slug) : ix.subs.map((x) => x.slug).filter((x) => x === s.slug || selSlugs.includes(x));
        // The last selected sub-strand stays selected: the page always shows at least one
        const locked = on && selSlugs.length === 1;
        return `<li><button type="button" class="chip" aria-pressed="${on}" ${locked ? 'aria-disabled="true" title="At least one sub-strand stays selected"' : `data-go="${routeFor(next, strandFilter)}"`}>${esc(s.name)}</button></li>`;
      }).join("")}</ul>
      ${strands.length > 1 ? `<div class="filter" role="group" aria-label="Show strand"><span>Show</span>
        <button type="button" aria-pressed="${!strandFilter}" data-go="${routeFor(selSlugs)}">All strands</button>
        ${strands.map((s) => `<button type="button" aria-pressed="${strandFilter === s.slug}" data-go="${routeFor(selSlugs, s.slug)}">${esc(s.name)}</button>`).join("")}
      </div>` : ""}
      ${sections || `<p class="empty">Nothing to show for this selection.</p>`}`;
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

  // ---------------------------------------------------------------- progression
  const KINDS = { k: ["know"], d: ["do"], x: ["includes", "excludes", "note"] };
  const ROW_LABEL = { u: "Understand", k: "Know", d: "Do", x: "Includes and notes", s: "Sub-strands" };
  const SHOW_KEYS = ["u", "k", "d", "x", "w"];
  const SHOW_LABEL = { u: "Understand", k: "Know", d: "Do", x: "Includes and notes", w: "Whole strand" };

  /**
   * Progression grid. Units (selected strands and sub-strands) × levels, each intersection broken
   * into rows for Understand / Know / Do / Includes and notes.
   *   layout=across (default): levels are columns; each unit is a block of rows.
   *   layout=down:             units are columns; each level is a block of rows.
   * Params: strands=a,b  subs=business,cyber  scope=selected  levels=third,fourth  show=u,k,d,x,w  layout=down
   * Strands and sub-strands are independent: a sub-strand is shown from every strand it appears in,
   * or only from the selected strands when scope=selected.
   */
  function viewProgression(ix, params) {
    const area = state.area;
    const csv = (k) => (params.get(k) || "").split(",").filter(Boolean);
    const down = params.get("layout") === "down";

    // ---- selection: strands and sub-strands are independent filters
    const subSlugsReq = [...new Set(csv("subs").map((id) => id.split(".").pop()))]; // old links: subs=<strand>.<sub>
    const subSel = ix.subs.filter((s) => subSlugsReq.includes(s.slug));
    let strands = ix.doc.strands.filter((s) => csv("strands").includes(s.slug) || params.get("strand") === s.slug);
    if (!strands.length && !subSel.length) strands = [ix.doc.strands[0]];
    const strandKeys = strands.map((s) => s.slug);
    const subKeys = subSel.map((s) => s.slug);
    const onlySelected = params.get("scope") === "selected" && strands.length > 0;
    // Each selected sub-strand from every strand it appears in (or only the selected strands)
    const subUnits = [];
    for (const sub of subSel) for (const e of sub.entries) {
      if (onlySelected && !strands.includes(e.strand)) continue;
      subUnits.push({ st: e.strand, c: e.node, sub });
    }

    const levelPool = LEVELS.filter((l) => strands.some((s) => s.levels.includes(l.code)) || subUnits.some((u) => u.c.levels.includes(l.code)));
    let levels = levelPool.filter((l) => csv("levels").includes(l.code));
    if (!levels.length) levels = levelPool;
    const levelKeys = levels.map((l) => l.code);

    const show = new Set(params.has("show") ? csv("show").filter((k) => SHOW_LABEL[k]) : SHOW_KEYS);
    if (!subUnits.length) show.add("w");                       // nothing to show without the strand itself
    if (!strands.length) show.delete("w");                     // no strand selected, so no whole-strand rows
    if (![...show].some((k) => k !== "w")) ["u", "k", "d", "x"].forEach((k) => show.add(k));
    const kinds = ["u", "k", "d", "x"].filter((k) => show.has(k));

    /** URL for the current selection with some settings changed (null or "" removes a setting). */
    const go = (changes) => {
      const current = { strands: strandKeys.join(","), subs: subKeys.join(","), scope: params.get("scope"),
        levels: params.get("levels"), show: params.get("show"), layout: params.get("layout") };
      const p = new URLSearchParams();
      const next = { ...current, ...changes };
      if (!next.strands) delete next.scope;                    // "only selected strands" needs a strand
      for (const [k, v] of Object.entries(next)) if (v != null && v !== "") p.set(k, v);
      return href(area, "progression") + "?" + p.toString().replace(/%2C/g, ",");
    };
    const toggled = (list, item) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
    const chip = (label, on, target, opts = {}) =>
      `<li><button type="button" class="chip${opts.radio ? " radio" : ""}" aria-pressed="${on}"${
        target ? ` data-go="${target}"` : ` aria-disabled="true"`}${opts.why || opts.title ? ` title="${esc(target ? opts.title || "" : opts.why || opts.title)}"` : ""}>${esc(label)}</button></li>`;

    // ---- units: with strands selected, sub-strands sit beside their strand; otherwise grouped by sub-strand
    const strandUnit = (st) => ({ type: "strand", st, node: st, key: st.slug, label: st.name, note: "Whole strand" });
    const subUnit = (u) => ({ type: "sub", st: u.st, node: u.c, key: `${u.st.slug}.${u.c.slug}`, label: u.c.name, note: u.st.name });
    const units = [];
    if (strands.length) {
      for (const st of ix.doc.strands) {
        if (strands.includes(st) && show.has("w")) units.push(strandUnit(st));
        for (const u of subUnits.filter((u) => u.st === st)) units.push(subUnit(u));
      }
    } else {
      for (const sub of subSel) for (const u of subUnits.filter((u) => u.sub === sub)) units.push(subUnit(u));
    }

    // ---- cell content
    const blocksAt = (node, lv) => (node.blocks || []).filter((b) => b.level === lv);
    const anchorsAt = (st, lv) => blocksAt(st, lv).filter((b) => b.understanding);
    const stmts = (blocks, ks) => blocks.flatMap((b) => (b.statements || []).filter((x) => ks.includes(x.kind)));
    const none = (text = "None") => `<span class="p-none">${esc(text)}</span>`;
    const listCell = (items) => items.length
      ? `<ul class="p-list">${items.map((x) => `<li title="${esc(x.code)}">${inlineMd(x.body)}</li>`).join("")}</ul>` : none();
    const extrasCell = (items) => items.length
      ? items.map((x) => `<div class="p-extra ${x.kind}" title="${esc(x.code)}"><span>${EXTRA_LABEL[x.kind]}</span>${md(x.body)}</div>`).join("") : none();
    const understandCell = (blocks) => blocks.filter((b) => b.understanding).map((b) => `<p class="p-u">${esc(b.understanding)}</p>`).join("");
    const subTags = (st, nodes) => `<ul class="tags">${nodes.map((c) => {
      const on = subKeys.includes(c.slug);
      return `<li><button type="button" class="tag" aria-pressed="${on}" data-go="${go({ subs: toggled(subKeys, c.slug).join(",") || null })}"
        title="${on ? "Remove" : "Add"} ${esc(c.name)} ${on ? "from" : "to"} the comparison">${esc(c.name)}</button></li>`;
    }).join("")}</ul>`;
    const present = (unit, lv) => unit.node.levels.includes(lv);
    const strandHasSubsAt = (st, lv) => (st.children || []).some((c) => c.levels.includes(lv));

    /** Rows for a block: the visible kinds, plus a Sub-strands row where a whole strand splits into sub-strands. */
    const rowsFor = (unitList, lvList) => {
      // A Know/Do/notes row is worth showing if some cell in it holds statements, or is a place where
      // statements belong (a sub-strand, or a strand taught as one) and so "None" is real information.
      const useful = (k) => k === "u" || unitList.some((u) => lvList.some((l) => present(u, l.code) && (
        u.type === "sub" || !strandHasSubsAt(u.st, l.code) || stmts(anchorsAt(u.st, l.code), KINDS[k]).length)));
      const rows = kinds.filter(useful);
      if (unitList.some((u) => u.type === "strand" && lvList.some((l) => strandHasSubsAt(u.st, l.code)))) rows.push("s");
      return rows.length ? rows : ["s"];
    };

    /** HTML for one unit at one level in one row. `firstRow` gets the "not at this level" message. */
    const cell = (u, lv, k, firstRow) => {
      const L = LEVELS.find((l) => l.code === lv);
      if (!present(u, lv)) {
        const msg = u.type === "strand" ? "Not at this level" : `Not a separate sub-strand at ${L.name} Level`;
        return { html: firstRow ? none(msg) : "", cls: "p-absent" };
      }
      if (u.type === "strand") {
        const anchors = anchorsAt(u.st, lv);
        if (k === "u") return { html: understandCell(anchors) || none(), cls: "p-ucell" };
        if (k === "s") {
          const here = (u.st.children || []).filter((c) => c.levels.includes(lv));
          return { html: here.length ? subTags(u.st, here) : none("Taught as one strand"), cls: "" };
        }
        const items = stmts(anchors, KINDS[k]);
        if (!items.length && strandHasSubsAt(u.st, lv) && k !== "x") return { html: none("In the sub-strands"), cls: "p-muted" };
        return { html: k === "x" ? extrasCell(items) : listCell(items), cls: "" };
      }
      const blocks = blocksAt(u.node, lv);
      if (k === "u") {
        const own = understandCell(blocks);
        if (own) return { html: own, cls: "p-ucell" };
        return { html: `<p class="p-u shared">${esc(understandingOf(ix, blocks[0]) || "")}</p><span class="p-src">Shared with ${esc(u.st.name)}</span>`, cls: "p-ucell p-inherit" };
      }
      if (k === "s") return { html: "", cls: "p-absent" };
      const items = stmts(blocks, KINDS[k]);
      return { html: k === "x" ? extrasCell(items) : listCell(items), cls: "" };
    };

    const td = (lvlCode, label, c) => `<td class="p-cell ${lvlClass(lvlCode)} ${c.cls}" data-label="${esc(label)}">${c.html}</td>`;
    const rowHead = (k) => `<th scope="row" class="p-rowhead ${k}">${ROW_LABEL[k]}</th>`;
    let table;
    if (!down) {
      // Levels across: columns are levels; each unit is a block of rows
      const cols = levels;
      const body = units.map((u) => {
        const rows = rowsFor([u], cols).filter((k) => k !== "s" || u.type === "strand");
        const head = `<tr class="p-group"><th colspan="${cols.length + 1}" scope="rowgroup">${esc(u.label)}<small>${esc(u.note)}</small></th></tr>`;
        return `<tbody>${head}${rows.map((k, i) =>
          `<tr>${rowHead(k)}${cols.map((l) => td(l.code, `${l.name} Level`, cell(u, l.code, k, i === 0))).join("")}</tr>`).join("")}</tbody>`;
      }).join("");
      table = `<table class="prog" style="--cols:${cols.length}">
        <caption class="visually-hidden">Progression with levels across</caption>
        <thead><tr><td class="p-corner"></td>${cols.map((l) => `<th scope="col" class="p-head ${lvlClass(l.code)}">${l.name} Level</th>`).join("")}</tr></thead>
        ${body}</table>`;
    } else {
      // Levels down: columns are units; each level is a block of rows
      const cols = units;
      const body = levels.map((l) => {
        const rows = rowsFor(cols, [l]);
        const head = `<tr class="p-group"><th colspan="${cols.length + 1}" scope="rowgroup"><span class="lvl-pill ${lvlClass(l.code)}">${l.name} Level</span></th></tr>`;
        // One Understanding shared by every column at this level is shown once, across the row
        const uText = (u) => present(u, l.code)
          ? (u.type === "strand" ? anchorsAt(u.st, l.code) : blocksAt(u.node, l.code)).map((b) => understandingOf(ix, b)).join("\n") : null;
        const texts = cols.map(uText);
        const sharedU = cols.length > 1 && texts[0] && texts.every((t) => t === texts[0]);
        return `<tbody>${head}${rows.map((k, i) => (k === "u" && sharedU)
          ? `<tr>${rowHead(k)}<td class="p-cell p-ucell p-span ${lvlClass(l.code)}" colspan="${cols.length}" data-label="All columns">${
              texts[0].split("\n").map((t) => `<p class="p-u">${esc(t)}</p>`).join("")}</td></tr>`
          : `<tr>${rowHead(k)}${cols.map((u) => td(l.code, u.type === "sub" ? `${u.label} (${u.note})` : u.label, cell(u, l.code, k, i === 0))).join("")}</tr>`).join("")}</tbody>`;
      }).join("");
      table = `<table class="prog" style="--cols:${cols.length}">
        <caption class="visually-hidden">Progression with levels down</caption>
        <thead><tr><td class="p-corner"></td>${cols.map((u) => `<th scope="col" class="p-head unit ${u.type}">${esc(u.label)}<small>${esc(u.note)}</small></th>`).join("")}</tr></thead>
        ${body}</table>`;
    }

    // ---- controls
    const layoutCtl = `<div class="seg" role="group" aria-label="Layout">
      <button type="button" aria-pressed="${!down}" data-go="${go({ layout: null })}">Levels across</button>
      <button type="button" aria-pressed="${down}" data-go="${go({ layout: "down" })}">Levels down</button></div>`;
    const strandCtl = `<ul class="chips">${ix.doc.strands.map((st) => {
      const on = strandKeys.includes(st.slug);
      const next = ix.doc.strands.map((x) => x.slug).filter((x) => (x === st.slug ? !on : strandKeys.includes(x)));
      return chip(st.name, on, on && strandKeys.length === 1 && !subKeys.length ? null : go({ strands: next.join(",") || null, levels: null }),
        { why: "Select a sub-strand before removing the last strand" });
    }).join("")}</ul>`;
    const subCtl = `<ul class="chips">${ix.subs.map((s) => {
      const on = subKeys.includes(s.slug);
      const strandCount = new Set(s.entries.map((e) => e.strand)).size;
      return chip(s.name, on, on && subKeys.length === 1 && !strandKeys.length ? null : go({ subs: toggled(subKeys, s.slug).join(",") || null, levels: null }),
        { title: `In ${strandCount} strand${strandCount === 1 ? "" : "s"}`, why: "Select a strand before removing the last sub-strand" });
    }).join("")}</ul>
      <div class="p-scope"><span class="p-hint">Show sub-strands</span><ul class="chips">
        ${chip("In every strand", !onlySelected, onlySelected ? go({ scope: null }) : null, { radio: true })}
        ${chip("Only in selected strands", onlySelected, !onlySelected && strands.length ? go({ scope: "selected" }) : null,
          { radio: true, why: strands.length ? "" : "Select a strand to limit sub-strands to it" })}
      </ul></div>`;
    const levelCtl = `<ul class="chips">${levelPool.map((l) => {
      const on = levelKeys.includes(l.code);
      const next = levelPool.map((x) => x.code).filter((c) => (c === l.code ? !on : levelKeys.includes(c)));
      return chip(l.name, on, on && levelKeys.length === 1 ? null : go({ levels: next.length === levelPool.length ? null : next.join(",") }),
        { why: "At least one level stays selected" });
    }).join("")}</ul>`;
    const showCtl = `<ul class="chips">${SHOW_KEYS.map((k) => {
      const on = show.has(k);
      const next = SHOW_KEYS.filter((x) => (x === k ? !on : show.has(x)));
      const lockedW = k === "w" && (!subUnits.length || !strands.length);
      const lockedLast = on && k !== "w" && kinds.length === 1;
      return chip(SHOW_LABEL[k], on, lockedW || lockedLast ? null : go({ show: next.length === SHOW_KEYS.length ? null : next.join(",") }),
        { why: k === "w" ? (!strands.length ? "Select a strand to show its whole-strand rows" : "Select a sub-strand to hide the whole-strand rows") : "At least one row stays visible" });
    }).join("")}</ul>`;

    const unitNames = units.map((u) => (u.type === "sub" ? `${u.label} (${u.note})` : u.label));
    main.innerHTML = `
      <div class="page-head"><h1>Progression</h1>
        <p>See how strands and sub-strands develop. Pick any strands, any sub-strands, or both, then show levels across the page or down it.</p></div>
      <div class="p-controls">
        ${layoutCtl}
        <div class="p-field"><span class="p-label">Strands</span>${strandCtl}</div>
        <div class="p-field"><span class="p-label">Sub-strands</span><div class="p-subs">${subCtl}</div></div>
        <div class="p-field"><span class="p-label">Levels</span>${levelCtl}</div>
        <div class="p-field"><span class="p-label">Show</span>${showCtl}</div>
      </div>
      <p class="p-summary">${unitNames.length > 4 ? `${unitNames.length} strands and sub-strands` : esc(listNames(unitNames))}, ${levelRange(levelKeys)}.</p>
      <div class="prog-wrap">${table}</div>`;
    document.title = `Progression · ${ix.doc.name} · Curriculum Explorer`;
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

    document.body.classList.toggle("wide", r.view === "progression" || r.view === "matrix");
    if (!r.b) window.scrollTo(0, 0);   // a 4th segment (strand or level) scrolls to that section instead
    if (r.view === "level") viewLevel(ix, r.a || "early", r.b);
    else if (r.view === "strand") viewStrand(ix, r.a, r.b);
    else if (r.view === "substrand") viewSubstrand(ix, r.a, r.b, r.params.get("strand"));
    else if (r.view === "matrix") viewMatrix(ix);
    else if (r.view === "progression") viewProgression(ix, r.params);
    else viewOverview(ix);
  }

  // Buttons that navigate (stair, filters)
  main.addEventListener("click", (e) => {
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
