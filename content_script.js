// content_script.js — text extraction, sentence chunking, DOM Range mapping, and
// on-page highlighting via the CSS Custom Highlight API (no DOM mutation, no layout shift).
//
// Re-injection safe: the service worker may executeScript this file into tabs that were
// open before the extension was installed; the guard below prevents duplicate listeners.

(() => {
  // `=== true`, not truthiness: a page element with id/name "__openvoxReadAloudInjected" becomes
  // a named property on window and would otherwise make us skip injection entirely.
  if (window.__openvoxReadAloudInjected === true) return;
  window.__openvoxReadAloudInjected = true;

  const HL_NAME = "openvox-current";
  const STYLE_ID = "openvox-hl-style";
  const BLOCK_SEL =
    "p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, dd, dt, figcaption, td, th, summary";
  const MAX_CHUNKS = 2000;
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION", "BUTTON"]);
  const PAGE_CHROME_TAGS = new Set(["NAV", "ASIDE", "HEADER", "FOOTER", "FORM"]);
  const PAGE_CHROME_ROLES = new Set(["navigation", "complementary", "banner", "contentinfo", "search", "dialog"]);

  const ranges = new Map(); // chunkId -> Range
  // chunkId -> the text actually spoken. Announced to screen readers instead of range.toString():
  // for an announced code block the range wraps the raw code, but the speech is the summary.
  const texts = new Map();
  let opts = null; // resolved highlight/chunk options from the last EXTRACT
  let hiddenCache = null; // WeakMap<Element, boolean>, reset each extract()
  const supportsHighlight =
    typeof CSS !== "undefined" && CSS.highlights && typeof Highlight !== "undefined";

  // Screen-reader live region for current sentence (polite so it doesn't interrupt)
  let liveRegion = null;
  function ensureLiveRegion() {
    if (liveRegion && liveRegion.isConnected) return liveRegion;
    liveRegion = document.createElement("div");
    liveRegion.setAttribute("aria-live", "polite");
    liveRegion.setAttribute("aria-atomic", "true");
    liveRegion.className = "sr-only";
    Object.assign(liveRegion.style, {
      position: "absolute",
      left: "-10000px",
      width: "1px",
      height: "1px",
      overflow: "hidden",
    });
    (document.body || document.documentElement).appendChild(liveRegion);
    return liveRegion;
  }

  // ----------------------------------------------------------------- messaging
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.target !== "content") return;
    switch (msg.type) {
      case "PING":
        sendResponse({ ok: true });
        return;
      case "EXTRACT":
        try {
          sendResponse(extract(msg.mode, msg.options || {}));
        } catch (err) {
          sendResponse({ error: err.message, chunks: [] });
        }
        return;
      case "HIGHLIGHT":
        highlight(msg.chunkId, { preview: !!msg.preview });
        return;
      case "CLEAR_HIGHLIGHT":
        clearHighlight();
        return;
      case "PICK":
        try {
          enterPickMode(msg.options || {});
        } catch (e) {
          /* noop */
        }
        return;
      case "DISPOSE":
        dispose();
        return;
    }
  });

  // ----------------------------------------------------------------- extraction
  // Resolve highlight/chunk options and prepare the highlight stylesheet. Options come from
  // storage via the service worker, so numbers are clamped here rather than trusted: chunk
  // sizes through the chunker's own clamp, opacity to [0.1, 1] (it lands in a CSS rule).
  function setOpts(options) {
    const sizes = OpenVoxChunker.clampChunkSizes(options.chunkTargetChars, options.chunkMaxChars);
    const opacity = Number.isFinite(options.highlightOpacity) ? options.highlightOpacity : 0.55;
    opts = {
      highlightEnabled: options.highlightEnabled !== false,
      highlightColor: options.highlightColor || "#ffd60a",
      highlightOpacity: Math.min(1, Math.max(0.1, opacity)),
      autoScroll: options.autoScroll !== false,
      target: sizes.target,
      max: sizes.max,
      lang: options.language || "en",
      // "announce" (default) | "skip" | "verbatim" — how <pre> blocks are read in page/region mode.
      codeBlocks: ["announce", "skip", "verbatim"].includes(options.codeBlocks) ? options.codeBlocks : "announce",
    };
    ensureStyle();
  }

  // Turn an ordered list of blocks into chunks (storing their Ranges) + a response.
  // A block is either an array of text pieces, or { code: Element } for an announced code block.
  function assemble(blocks, mode) {
    const chunks = [];
    let idx = 0;
    for (const block of blocks) {
      const built = block.code ? [codeBlockChunk(block.code)] : buildChunksFromPieces(block);
      for (const b of built) {
        if (!b || idx >= MAX_CHUNKS) break;
        const id = "c" + idx;
        ranges.set(id, b.range);
        texts.set(id, b.text);
        chunks.push({ id, index: idx, text: b.text });
        idx++;
      }
      if (idx >= MAX_CHUNKS) break;
    }
    return { sessionId: "s" + Date.now(), title: document.title || location.href, mode, chunks };
  }

  // One spoken stand-in chunk ("Python code block, 12 lines.") whose Range wraps the whole
  // <pre>, so the highlight still shows the reader which block is being skipped over.
  function codeBlockChunk(el) {
    const className = [el.className, el.firstElementChild?.className, el.parentElement?.className]
      .filter((c) => typeof c === "string")
      .join(" ");
    const text =
      typeof OpenVoxCodeBlock !== "undefined"
        ? OpenVoxCodeBlock.describeCodeBlock(el.textContent || "", className)
        : "Code block.";
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      return { text, range };
    } catch {
      return null;
    }
  }

  function isCodeBlock(el) {
    return el.tagName === "PRE" || !!el.closest("pre");
  }

  function extract(mode, options) {
    dispose();
    hiddenCache = new WeakMap();
    setOpts(options);
    const blocks = mode === "selection" ? selectionBlocks() : pageBlocks();
    return assemble(blocks, mode);
  }

  // Build [{node,start,end}] "pieces" for the current selection (one logical block).
  function selectionBlocks() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return [];
    const range = sel.getRangeAt(0);
    const pieces = textNodesInRange(range);
    return pieces.length ? [pieces] : [];
  }

  function textNodesInRange(range) {
    const rootNode =
      range.commonAncestorContainer.nodeType === Node.TEXT_NODE
        ? range.commonAncestorContainer.parentNode
        : range.commonAncestorContainer;
    const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.data || !node.data.trim()) return NodeFilter.FILTER_REJECT;
        if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
        if (isHidden(node.parentElement)) return NodeFilter.FILTER_REJECT;
        if (isSkippedTag(node.parentElement)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const pieces = [];
    let n;
    while ((n = walker.nextNode())) {
      let start = 0;
      let end = n.data.length;
      if (n === range.startContainer && range.startContainer.nodeType === Node.TEXT_NODE)
        start = range.startOffset;
      if (n === range.endContainer && range.endContainer.nodeType === Node.TEXT_NODE)
        end = range.endOffset;
      if (end > start) pieces.push({ node: n, start, end });
    }
    return pieces;
  }

  // Build an array of blocks (each a [{node,start,end}] list, or {code: el}) under `root`.
  function blocksForRoot(root, { skipPageChrome = false } = {}) {
    const result = [];
    let lastCode = null;
    // Picking a code block as the region is an explicit request to hear it.
    const codeMode = isCodeBlock(root) ? "verbatim" : opts.codeBlocks;
    for (const el of leafBlocks(root)) {
      if (isHidden(el)) continue;
      if (skipPageChrome && isPageChrome(el, root)) continue;
      if (codeMode !== "verbatim" && isCodeBlock(el)) {
        if (codeMode === "skip") continue;
        // Highlighters often split one <pre> into several leaf blocks; announce it once.
        const pre = el.closest("pre") || el;
        if (pre !== lastCode) result.push({ code: pre });
        lastCode = pre;
        continue;
      }
      const pieces = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.data || !node.data.trim()) return NodeFilter.FILTER_REJECT;
          if (isHidden(node.parentElement)) return NodeFilter.FILTER_REJECT;
          if (isSkippedTag(node.parentElement)) return NodeFilter.FILTER_REJECT;
          if (skipPageChrome && isPageChrome(node.parentElement, root)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      let n;
      while ((n = walker.nextNode())) pieces.push({ node: n, start: 0, end: n.data.length });
      if (pieces.length) result.push(pieces);
    }
    return result;
  }

  // Page mode: auto-detect the main content container, then read it.
  function pageBlocks() {
    return blocksForRoot(pickMainContainer(), { skipPageChrome: true });
  }

  function pickMainContainer() {
    const explicit = document.querySelector("article, main, [role='main']");
    if (explicit && textLength(explicit) > 200) return explicit;
    let best = document.body;
    let bestScore = textLength(document.body) * 0.2;
    for (const el of document.querySelectorAll("article, main, section, div")) {
      const score = scoreElement(el);
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best || document.body;
  }

  function scoreElement(el) {
    if (isHidden(el) || isPageChrome(el, document.body)) return 0;
    let pLen = 0;
    for (const p of el.querySelectorAll("p")) pLen += (p.textContent || "").length;
    const total = (el.textContent || "").length || 1;
    let linkText = 0;
    for (const a of el.querySelectorAll("a")) linkText += (a.textContent || "").length;
    const linkDensity = Math.min(linkText / total, 0.9);
    return pLen * (1 - linkDensity);
  }

  function leafBlocks(container) {
    const all = Array.from(container.querySelectorAll(BLOCK_SEL));
    const leaves = all.filter((el) => !el.querySelector(BLOCK_SEL));
    return leaves.length ? leaves : [container];
  }

  // --------------------------------------------------- chunking + range mapping
  function buildChunksFromPieces(pieces) {
    let text = "";
    const map = []; // {gStart,gEnd,node,nodeStart}
    for (const p of pieces) {
      const slice = p.node.data.slice(p.start, p.end);
      if (!slice) continue;
      // M2: insert space when a skipped whitespace node separated adjacent pieces
      if (text.length > 0 && !/\s$/.test(text) && !/^\s/.test(slice)) {
        text += " ";
      }
      map.push({ gStart: text.length, gEnd: text.length + slice.length, node: p.node, nodeStart: p.start });
      text += slice;
    }
    if (!text.trim()) return [];
    const sentences = OpenVoxChunker.splitSentences(text, opts.lang);
    const segments = OpenVoxChunker.mergeAndSplit(sentences, text, opts.target, opts.max);
    const out = [];
    for (const seg of segments) {
      const t = text.slice(seg.start, seg.end).trim();
      if (!t) continue;
      const range = rangeForSpan(map, seg.start, seg.end);
      if (!range) continue;
      out.push({ text: t, range });
    }
    return out;
  }

  // Sentence splitting + merge/split live in lib/chunker.js (OpenVoxChunker) and the
  // code-block announcer in lib/code-block.js (OpenVoxCodeBlock); both are injected as
  // content-script files before this one (see ensureContentScript in service_worker.js).

  function rangeForSpan(map, gStart, gEnd) {
    const s = locate(map, gStart, false);
    const e = locate(map, gEnd, true);
    if (!s || !e) return null;
    try {
      const r = document.createRange();
      r.setStart(s.node, s.offset);
      r.setEnd(e.node, e.offset);
      return r;
    } catch {
      return null;
    }
  }

  function locate(map, g, isEnd) {
    for (const m of map) {
      if (isEnd) {
        if (g > m.gStart && g <= m.gEnd) return { node: m.node, offset: m.nodeStart + (g - m.gStart) };
      } else if (g >= m.gStart && g < m.gEnd) {
        return { node: m.node, offset: m.nodeStart + (g - m.gStart) };
      }
    }
    if (!map.length) return null;
    if (isEnd) {
      const m = map[map.length - 1];
      return { node: m.node, offset: m.nodeStart + (m.gEnd - m.gStart) };
    }
    const m0 = map[0];
    return { node: m0.node, offset: m0.nodeStart };
  }

  // -------------------------------------------------------------- highlighting
  // preview=true paints the sentence that is *about* to be read (while audio loads) without
  // announcing it; the real CHUNK_STARTED highlight announces when speech actually begins.
  function highlight(chunkId, { preview = false } = {}) {
    const range = ranges.get(chunkId);
    if (!range) return;
    if (supportsHighlight && opts && opts.highlightEnabled) {
      try {
        CSS.highlights.set(HL_NAME, new Highlight(range));
      } catch {
        /* range invalidated by DOM mutation — audio continues regardless */
      }
    }
    maybeScroll(range);
    if (preview) return;

    // Announce what is being spoken (not the raw range text) to screen readers
    try {
      const live = ensureLiveRegion();
      const txt = (texts.get(chunkId) || "").trim().slice(0, 280);
      if (txt) live.textContent = txt;
    } catch {
      /* noop */
    }
  }

  function clearHighlight() {
    if (supportsHighlight) CSS.highlights.delete(HL_NAME);
  }

  function maybeScroll(range) {
    if (!opts || !opts.autoScroll) return;
    try {
      const rect = range.getBoundingClientRect();
      if (!rect) return;
      if (rect.top < 0 || rect.bottom > window.innerHeight) {
        const el =
          range.startContainer.nodeType === Node.ELEMENT_NODE
            ? range.startContainer
            : range.startContainer.parentElement;
        if (el && el.scrollIntoView) el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    } catch {
      /* noop */
    }
  }

  // Only ever reuse the <style> this script created. Looking it up by id would let a page
  // pre-plant an element with STYLE_ID and have us write into (or be suppressed by) its node.
  let ownStyle = null;
  function ensureStyle() {
    if (!ownStyle || !ownStyle.isConnected) {
      // L7: re-create if orphaned
      ownStyle = document.createElement("style");
      ownStyle.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(ownStyle);
    }
    const color = hexToRgba(opts.highlightColor, opts.highlightOpacity);
    ownStyle.textContent = `::highlight(${HL_NAME}){ background-color:${color}; color:inherit; }`;
  }

  function dispose() {
    teardownPick(); // M1: pick overlay must not survive extraction/dispose
    clearHighlight();
    ranges.clear();
    texts.clear();
  }

  // --------------------------------------------------------- region picker mode
  // Lets the user point at the pane they want read. Deterministic alternative to
  // the "Read page" heuristic for awkward layouts.
  let pick = null;

  function enterPickMode(options) {
    setOpts(options);
    if (pick) teardownPick();

    const box = document.createElement("div");
    Object.assign(box.style, {
      position: "fixed",
      zIndex: "2147483646",
      pointerEvents: "none",
      border: "2px solid #0a84ff",
      background: "rgba(10,132,255,0.12)",
      borderRadius: "3px",
      display: "none",
      boxSizing: "border-box",
    });
    const label = document.createElement("div");
    Object.assign(label.style, {
      position: "fixed",
      zIndex: "2147483647",
      pointerEvents: "none",
      background: "#0a84ff",
      color: "#fff",
      font: "12px/1.4 -apple-system, system-ui, sans-serif",
      padding: "3px 7px",
      borderRadius: "4px",
      maxWidth: "70vw",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
      boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
    });
    label.textContent = "Hover pane · scroll/↑↓ to resize · ↵ read · Esc cancel";
    box.setAttribute("data-openvox-ui", "1");
    label.setAttribute("data-openvox-ui", "1");
    (document.body || document.documentElement).append(box, label);

    const state = { box, label, candidate: null };

    // Every picker handler ignores synthetic events: page script can dispatch click/keydown/
    // wheel/mousemove on document, and must not be able to steer or confirm the user's pick.
    let hoverRaf = 0;
    state.onMove = (e) => {
      if (!e.isTrusted) return;
      if (hoverRaf) cancelAnimationFrame(hoverRaf);
      hoverRaf = requestAnimationFrame(() => {
        let el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el || el.getAttribute?.("data-openvox-ui")) return;
        el = findPaneCandidate(el);
        state.candidate = el;
        drawPick();
      });
    };
    state.onKey = (e) => {
      if (!e.isTrusted) return;
      if (e.key === "Escape") {
        e.preventDefault();
        cancelPick();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const p = state.candidate && state.candidate.parentElement;
        if (p && p !== document.documentElement) {
          state.candidate = p;
          drawPick();
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const c = firstTextChild(state.candidate);
        if (c) {
          state.candidate = c;
          drawPick();
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (state.candidate) confirmPick(state.candidate);
      }
    };
    state.onClick = (e) => {
      if (!e.isTrusted || e.button !== 0) return;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (el && el.getAttribute?.("data-openvox-ui")) return;
      e.preventDefault();
      e.stopPropagation();
      if (state.candidate) confirmPick(state.candidate);
    };

    let lastWheelStep = 0;
    state.onWheel = (e) => {
      if (!e.isTrusted) return;
      e.preventDefault(); // don't scroll the page while picking
      const now = Date.now();
      if (now - lastWheelStep < 90) return; // throttle trackpad bursts to ~1 step/level
      lastWheelStep = now;
      if (e.deltaY < 0) {
        const p = state.candidate && state.candidate.parentElement;
        if (p && p !== document.documentElement) {
          state.candidate = p;
          drawPick();
        }
      } else if (e.deltaY > 0) {
        const c = firstTextChild(state.candidate);
        if (c) {
          state.candidate = c;
          drawPick();
        }
      }
    };

    document.addEventListener("mousemove", state.onMove, true);
    document.addEventListener("click", state.onClick, true);
    document.addEventListener("keydown", state.onKey, true);
    document.addEventListener("wheel", state.onWheel, { capture: true, passive: false });
    document.documentElement.style.cursor = "crosshair";
    pick = state;
  }

  function drawPick() {
    if (!pick || !pick.candidate) return;
    const r = pick.candidate.getBoundingClientRect();
    Object.assign(pick.box.style, {
      display: "block",
      left: r.left + "px",
      top: r.top + "px",
      width: r.width + "px",
      height: r.height + "px",
    });
    const tag = pick.candidate.tagName.toLowerCase();
    let cls = "";
    if (typeof pick.candidate.className === "string" && pick.candidate.className.trim()) {
      cls = "." + pick.candidate.className.trim().split(/\s+/).slice(0, 2).join(".");
    }
    const chars = (pick.candidate.textContent || "").trim().length;
    pick.label.textContent = `${tag}${cls} · ${chars} chars · scroll to resize · click to read`;
    pick.label.style.left = Math.max(2, r.left) + "px";
    pick.label.style.top = Math.max(2, r.top - 24) + "px";
  }

  function firstTextChild(el) {
    if (!el) return null;
    for (const c of el.children) {
      if ((c.textContent || "").trim().length > 20) return c;
    }
    return null;
  }

  /**
   * Walk upward from a raw elementFromPoint result to find a more useful "pane".
   * Prefers semantic containers (main, article, section) or elements with substantial
   * text content / area. Keeps the original leaf for ArrowDown / wheel-down.
   */
  function findPaneCandidate(el) {
    if (!el || el === document.documentElement || el === document.body) return el;

    let current = el;
    let best = el;
    let bestScore = scoreElement(el) || textLength(el) || 1;

    // Walk up a bounded number of levels looking for a better pane
    for (let i = 0; i < 6 && current.parentElement; i++) {
      current = current.parentElement;
      if (current === document.documentElement || current === document.body) break;

      const score = scoreElement(current) || textLength(current) || 1;
      const rect = current.getBoundingClientRect();
      const area = Math.max(0, rect.width * rect.height);

      const isSemantic =
        current.matches?.("main, article, [role='main'], section, .content, #content, aside") ||
        (current.tagName === "DIV" && current.children.length >= 2);

      // Prefer semantic containers with real content, or elements that are much larger
      if ((isSemantic && score > 150) || score > bestScore * 1.6 || area > 90000) {
        best = current;
        bestScore = score;
      }
    }
    return best;
  }

  function teardownPick() {
    if (!pick) return;
    document.removeEventListener("mousemove", pick.onMove, true);
    document.removeEventListener("click", pick.onClick, true);
    document.removeEventListener("keydown", pick.onKey, true);
    document.removeEventListener("wheel", pick.onWheel, true);
    pick.box.remove();
    pick.label.remove();
    document.documentElement.style.cursor = "";
    pick = null;
  }

  function cancelPick() {
    teardownPick();
    chrome.runtime.sendMessage({ target: "sw", type: "PICK_CANCELLED" }).catch(() => {});
  }

  function confirmPick(el) {
    teardownPick();
    dispose();
    const res = assemble(blocksForRoot(el), "region");
    chrome.runtime.sendMessage({ target: "sw", type: "PICK_RESULT", ...res }).catch(() => {});
  }

  // -------------------------------------------------------------------- helpers
  function isSkippedTag(el) {
    if (!el) return false;
    for (let cur = el; cur && cur.nodeType === Node.ELEMENT_NODE; cur = cur.parentElement) {
      if (SKIP_TAGS.has(cur.tagName)) return true;
    }
    return false;
  }

  function isPageChrome(el, root) {
    if (!el) return false;
    for (let cur = el; cur && cur.nodeType === Node.ELEMENT_NODE; cur = cur.parentElement) {
      if (cur === root) return false;
      if (PAGE_CHROME_TAGS.has(cur.tagName)) return true;
      if (cur.hasAttribute("hidden") || cur.hasAttribute("inert")) return true;
      if (cur.getAttribute("aria-hidden") === "true") return true;
      const role = (cur.getAttribute("role") || "").toLowerCase();
      if (PAGE_CHROME_ROLES.has(role)) return true;
    }
    return false;
  }

  function isHidden(el) {
    if (!el) return true;
    if (el.nodeType !== Node.ELEMENT_NODE) el = el.parentElement;
    if (!el) return true;
    // M4: walk up, checking cache at each level
    const uncached = [];
    let cur = el;
    while (cur && cur.nodeType === Node.ELEMENT_NODE) {
      if (hiddenCache && hiddenCache.has(cur)) {
        const result = hiddenCache.get(cur);
        for (const u of uncached) hiddenCache.set(u, result);
        return result;
      }
      uncached.push(cur);
      cur = cur.parentElement;
    }
    // Nothing cached — walk the uncached list checking styles
    for (let i = uncached.length - 1; i >= 0; i--) {
      const node = uncached[i];
      if (node.hasAttribute("hidden")) {
        for (let j = i; j >= 0; j--) if (hiddenCache) hiddenCache.set(uncached[j], true);
        return true;
      }
      const cs = getComputedStyle(node);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") {
        for (let j = i; j >= 0; j--) if (hiddenCache) hiddenCache.set(uncached[j], true);
        return true;
      }
      if (hiddenCache) hiddenCache.set(node, false);
    }
    return false;
  }

  function textLength(el) {
    return el ? (el.textContent || "").trim().length : 0;
  }

  function hexToRgba(hex, alpha) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "");
    if (!m) return `rgba(255,214,10,${alpha})`;
    return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
  }
})();
