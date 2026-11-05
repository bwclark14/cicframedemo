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
        <p class="page-links"><a href="${progressionHref(area, "k", [strand.slug])}">See ${esc(strand.name)} in the progression matrix</a></p></div>
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

    const items = (sts, k) => sts.filter((x) => x.kind === k);
    const listHtml = (sts) => sts.length
      ? `<ul>${sts.map((x) => `<li title="${esc(x.code)}">${inlineMd(x.body)}</li>`).join("")}</ul>` : "";
    const extraKinds = ["includes", "excludes", "note"];
    const tableHtml = (cols, l) => {
      // label groups by origin whenever the table mixes them (several sub-strands, or whole-strand statements)
      const labels = new Set(cols.flatMap((c) => c.groups.filter((g) => g.sts.length).map((g) => g.label)));
      const showTags = labels.size > 1;
      const cell = (c, k) => c.groups.map((g) => {
        const list = listHtml(items(g.sts, k));
        return list ? (showTags ? `<p class="ss-tag ${g.origin}">${esc(g.label)}</p>` : "") + list : "";
      }).join("") || `<p class="none">None at this level.</p>`;
      const allExtras = (c) => c.groups.flatMap((g) => g.sts.filter((x) => extraKinds.includes(x.kind)).map((x) => ({ x, g })));
      const hasExtras = cols.some((c) => allExtras(c).length);
      const extrasCell = (c) => {
        const all = allExtras(c);
        return all.length
          ? `<details><summary>${all.length} note${all.length === 1 ? "" : "s"}</summary>${all.map(({ x, g }) =>
              `<div class="extra ${x.kind}" title="${esc(x.code)}"><h5>${EXTRA_LABEL[x.kind]}${showTags ? ` <span class="ss-tag-inline">· ${esc(g.label)}</span>` : ""}</h5>${md(x.body)}</div>`).join("")}</details>`
          : `<p class="none">None.</p>`;
      };
      const row = (cls, name, fn) => `<tr class="${cls}"><th scope="row">${name}</th>${cols.map((c) => `<td>${fn(c)}</td>`).join("")}</tr>`;
      return `<div class="ss-wrap" tabindex="0" role="region" aria-label="${l.name} Level">
        <table class="ss-table ${lvlClass(l.code)}${condensed ? " condensed" : ""}" style="--cols:${cols.length}">
          <thead><tr><td class="corner"></td>${cols.map((c) =>
            `<th scope="col"><a href="${href(area, "strand", c.strand.slug, l.code)}">${esc(c.strand.name)}</a></th>`).join("")}</tr></thead>
          <tbody>
            ${row("r-u", "Understand", (c) => c.und.map((u) => `<p class="ss-u${c.inherited ? " inherited" : ""}">${esc(u)}</p>`).join("")
              + (c.inherited ? `<p class="ss-note">Shared across the strand</p>` : ""))}
            ${showKD !== "d" ? row("r-k", "Know", (c) => cell(c, "know")) : ""}
            ${showKD !== "k" ? row("r-d", "Do", (c) => cell(c, "do")) : ""}
            ${hasExtras ? row("r-n", "Notes", extrasCell) : ""}
          </tbody>
        </table></div>`;
    };

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
      <div class="page-head"><h1>${esc(title)}</h1><p>${intro}</p>${inPlay.length === 1
        ? `<p class="page-links"><a href="${progressionHref(area, "k", [inPlay[0].slug])}">See ${esc(inPlay[0].name)} in the progression matrix</a></p>` : ""}</div>
      <div class="picker-bar">
        <p class="picker-label" id="sub-pick">Sub-strands <span class="hint">Select one or more</span></p>
        <button type="button" class="link-btn" data-go="${routeFor(ix.subs.map((s) => s.slug))}">Select all</button>
      </div>
      <ul class="picker" aria-labelledby="sub-pick">${ix.subs.map((s) => {
        const on = selSlugs.includes(s.slug);
        const next = on ? selSlugs.filter((x) => x !== s.slug) : ix.subs.map((x) => x.slug).filter((x) => x === s.slug || selSlugs.includes(x));
        // The last selected sub-strand stays selected: the page always shows at least one
        const locked = on && selSlugs.length === 1;
        return `<li><button type="button" class="chip" aria-pressed="${on}" ${locked ? 'aria-disabled="true" title="At least one sub-strand stays selected"' : `data-go="${routeFor(next)}"`}>${esc(s.name)}</button></li>`;
      }).join("")}</ul>
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
      <div class="filter display-bar" role="group" aria-label="Display options">
        <span>Statements</span>
        ${[["kd", "Know and Do"], ["k", "Know only"], ["d", "Do only"]].map(([v, label]) =>
          `<button type="button" aria-pressed="${showKD === v}" data-go="${routeFor(selSlugs, strandSel, includeWhole, { show: v })}">${label}</button>`).join("")}
        <span class="sep" aria-hidden="true"></span>
        <button type="button" class="chip" aria-pressed="${condensed}" data-go="${routeFor(selSlugs, strandSel, includeWhole, { condensed: !condensed })}">Condensed view</button>
      </div>
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

    document.body.classList.toggle("wide", r.view === "progression" || r.view === "matrix" || r.view === "substrand");
    if (!r.b) window.scrollTo(0, 0);   // a 4th segment (strand or level) scrolls to that section instead
    if (r.view === "level") viewLevel(ix, r.a || "early", r.b);
    else if (r.view === "strand") viewStrand(ix, r.a, r.b);
    else if (r.view === "substrand") viewSubstrand(ix, r.a, r.b, r.params.get("strand"), r.params.get("whole") === "1", r.params);
    else if (r.view === "matrix") viewMatrix(ix);
    else if (r.view === "progression") viewProgression(ix, r.params);
    else viewOverview(ix);
  }

  // Buttons that navigate (stair, filters)
  main.addEventListener("click", (e) => {
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
