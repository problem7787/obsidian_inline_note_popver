import {
  App,
  Component,
  Editor,
  MarkdownRenderer,
  MarkdownView,
  Modal,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
} from "obsidian";

// ─────────────────────────────────────────────────────────────────────────────
// SYNTAX
//   Inline : `inl:Label|content`
//   Block  : ```inl-note\nLabel\n---\ncontent\n```
// ─────────────────────────────────────────────────────────────────────────────

const BLOCK_LANG = "inl-note";

function parseInlineCode(raw: string): { label: string; content: string } | null {
  if (!raw.startsWith("inl:")) return null;
  const pipe = raw.indexOf("|", 4);
  if (pipe === -1) return null;
  return { label: raw.slice(4, pipe).trim(), content: raw.slice(pipe + 1).trim() };
}

function parseBlockSource(src: string): { label: string; content: string } | null {
  const sep = src.indexOf("---");
  if (sep === -1) {
    const lines = src.trim().split("\n");
    if (lines.length < 2) return null;
    return { label: lines[0].trim(), content: lines.slice(1).join("\n").trim() };
  }
  const label = src.slice(0, sep).trim();
  const content = src.slice(sep + 3).trim();
  return label ? { label, content } : null;
}

function makeInlineSyntax(label: string, content: string) {
  return `\`inl:${label}|${content}\``;
}
function makeBlockSyntax(label: string, content: string) {
  return `\`\`\`${BLOCK_LANG}\n${label}\n---\n${content}\n\`\`\``;
}
function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceInSource(doc: string, label: string, newContent: string, isBlock: boolean): string {
  if (isBlock) {
    const re = new RegExp(
      "(`{3}" + BLOCK_LANG + "\\n)" + escapeRe(label) + "\\n---\\n[\\s\\S]*?\\n(`{3})", "m"
    );
    return doc.replace(re, `$1${label}\n---\n${newContent}\n$2`);
  }
  const re = new RegExp("`inl:" + escapeRe(label) + "\\|[^`]*`", "g");
  return doc.replace(re, makeInlineSyntax(label, newContent));
}

// ─────────────────────────────────────────────────────────────────────────────
// Save to file directly — never touches open editors (prevents focus stealing)
// ─────────────────────────────────────────────────────────────────────────────

async function saveToFile(app: App, sourcePath: string, label: string,
                          newContent: string, isBlock: boolean): Promise<void> {
  let file: TFile | null = null;
  if (sourcePath) {
    const f = app.vault.getAbstractFileByPath(sourcePath);
    if (f instanceof TFile) file = f;
  }
  if (!file) {
    app.workspace.iterateAllLeaves(leaf => {
      if (!file && leaf.view.getViewType() === "canvas")
        file = (leaf.view as any).file as TFile ?? null;
    });
  }
  if (!file) { console.warn("InlineNote: source file not found"); return; }
  const raw = await app.vault.read(file);
  const updated = replaceInSource(raw, label, newContent, isBlock);
  if (updated !== raw) await app.vault.modify(file, updated);
}

// ─────────────────────────────────────────────────────────────────────────────
// Detect mode from the SPAN'S position in the DOM — not from active leaf.
// This is the only reliable way: check which container the span lives in.
//
//   .markdown-preview-section  → reading view
//   .cm-content                → editing view (note or canvas card)
//   .canvas-node-content (but NOT inside .cm-content) → canvas preview
// ─────────────────────────────────────────────────────────────────────────────

function getModeFromSpan(span: HTMLElement, app: App): { mode: "editing" | "reading"; sourcePath: string } {
  // Strategy: find the WorkspaceLeaf whose view DOM contains this span,
  // then ask that view directly what mode it is in.
  // This is reliable because view.containerEl wraps the entire leaf content.
  let ownerView: MarkdownView | null = null;
  let isCanvas = false;
  let canvasReadMode = "reading";
  let canvasPath = "";

  app.workspace.iterateAllLeaves(leaf => {
    if (ownerView || isCanvas) return;
    if (!leaf.containerEl.contains(span)) return;

    const vt = leaf.view.getViewType();
    if (vt === "markdown") {
      ownerView = leaf.view as MarkdownView;
    } else if (vt === "canvas") {
      isCanvas = true;
      canvasReadMode = leaf.view.canvas.readonly ? "reading" : "editing";
      canvasPath = ((leaf.view as any).file as TFile)?.path ?? "";
    }
  });

  if (isCanvas) {
    return { mode: canvasReadMode as "editing" | "reading", sourcePath: canvasPath };
  }

  // Markdown note — ask the view its current mode
  if (ownerView) {
    const sourcePath = ownerView.file?.path ?? "";
    // Reading/preview mode
    if (ownerView.getMode() === "preview") {
      return { mode: "reading", sourcePath };
    }
    // Live-preview or source editing mode
    return { mode: "editing", sourcePath };
  }

  // Fallback — could not find owner (shouldn't happen in practice)
  return { mode: "reading", sourcePath: "" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────────────────────────────────

interface InlineNoteSettings {
  popoverDelay: number;
  popoverWidth: number;
  popoverMaxHeight: number;
  popoverTheme: "auto" | "dark" | "light";
}
const DEFAULT_SETTINGS: InlineNoteSettings = {
  popoverDelay: 180, popoverWidth: 420, popoverMaxHeight: 460, popoverTheme: "auto",
};

// ─────────────────────────────────────────────────────────────────────────────
// Popover
// ─────────────────────────────────────────────────────────────────────────────

class InlineNotePopover {
  private el: HTMLElement | null = null;
  private arrowEl: HTMLElement | null = null;
  private component: Component | null = null;
  private showTimer: number | null = null;
  private hideTimer: number | null = null;
  private clickOutsideHandler: ((e: MouseEvent) => void) | null = null;
  settings: InlineNoteSettings;
  app: App;
  onEditSave?: (sourcePath: string, label: string, newContent: string, isBlock: boolean) => Promise<void>;

  constructor(app: App, settings: InlineNoteSettings) {
    this.app = app;
    this.settings = settings;
  }

  show(anchor: HTMLElement, label: string, content: string, isBlock: boolean) {
    this.cancelHide();
    if (this.showTimer) clearTimeout(this.showTimer);
    this.showTimer = window.setTimeout(
      () => this.render(anchor, label, content, isBlock),
      this.settings.popoverDelay
    );
  }

  hide() {
    if (this.showTimer) { clearTimeout(this.showTimer); this.showTimer = null; }
    this.hideTimer = window.setTimeout(() => this.destroy(), 200);
  }

  cancelHide() {
    if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
  }

  private async render(anchor: HTMLElement, label: string, content: string, isBlock: boolean) {
    this.destroy();

    // Detect mode from where the span lives in the DOM
    const { mode, sourcePath } = getModeFromSpan(anchor, this.app);

    const W = this.settings.popoverWidth;

    const pop = document.createElement("div");
    pop.className = "inl-popover";
    // Set explicit width so getBoundingClientRect is reliable
    pop.style.width = `${W}px`;
    pop.style.maxWidth = `min(${W}px, calc(100vw - 24px))`;
    pop.style.maxHeight = `${this.settings.popoverMaxHeight}px`;
    if (this.settings.popoverTheme !== "auto") pop.classList.add(`inl-theme-${this.settings.popoverTheme}`);

    // Toolbar
    const toolbar = pop.createDiv({ cls: "inl-toolbar" });
    toolbar.createSpan({ cls: "inl-title", text: label });

    // Edit button only in actual editing context
    if (mode === "editing") {
      const btn = toolbar.createEl("button", { cls: "inl-btn", text: "✏️ Edit" });
      btn.addEventListener("mousedown", e => { e.stopPropagation(); this.cancelHide(); });
      btn.addEventListener("click", () => {
        this.cancelHide();
        new EditInlineModal(this.app, label, content, isBlock, sourcePath, async newContent => {
          if (this.onEditSave) await this.onEditSave(sourcePath, label, newContent, isBlock);
          setTimeout(() => this.render(anchor, label, newContent, isBlock), 80);
        }).open();
      });
    }

    const body = pop.createDiv({ cls: "inl-body" });
    this.component = new Component();
    this.component.load();
    await MarkdownRenderer.render(this.app, content, body, sourcePath, this.component);

    body.querySelectorAll<HTMLAnchorElement>("a.internal-link").forEach(a => {
      a.addEventListener("click", e => {
        e.preventDefault();
        this.app.workspace.openLinkText(a.getAttribute("href") || "", sourcePath, false);
        this.destroy();
      });
    });

    // Append to body BEFORE measuring
    document.body.appendChild(pop);
    this.el = pop;

    const arrow = document.createElement("div");
    arrow.className = "inl-arrow";
    document.body.appendChild(arrow);
    this.arrowEl = arrow;

    pop.addEventListener("mouseenter",   () => this.cancelHide());
    pop.addEventListener("mouseleave",   () => this.hide());
    arrow.addEventListener("mouseenter", () => this.cancelHide());
    arrow.addEventListener("mouseleave", () => this.hide());

    // Click-outside to dismiss — attach after a short delay so the
    // current click that triggered hover doesn't immediately close it
    setTimeout(() => {
      this.clickOutsideHandler = (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        if (this.el && !this.el.contains(target) && !this.arrowEl?.contains(target)) {
          this.destroy();
        }
      };
      document.addEventListener("mousedown", this.clickOutsideHandler, { capture: true });
    }, 300);

    // Position using known width (not measured) for horizontal calc,
    // measured height for vertical calc (content varies)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        this.position(pop, arrow, anchor, W);
        pop.classList.add("inl-visible");
        arrow.classList.add("inl-visible");
      }));
    }));
  }

  private position(pop: HTMLElement, arrow: HTMLElement, anchor: HTMLElement, knownWidth: number) {
    // anchor.getBoundingClientRect() is always viewport-relative, even inside
    // CSS-transformed canvas. position:fixed also uses viewport coords.
    const r  = anchor.getBoundingClientRect();
    const ph = pop.getBoundingClientRect().height; // height varies with content
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const AH = 9, AW = 16, GAP = 4;

    const cx = r.left + r.width / 2;

    // Use the known width directly — avoids race with paint cycle
    const pw = Math.min(knownWidth, vw - 24);
    const putBelow = r.top - AH - GAP - ph < 12 && vh - r.bottom > r.top;

    let popTop  = putBelow ? r.bottom + AH + GAP : r.top - ph - AH - GAP;
    let popLeft = cx - pw / 2;
    if (popLeft < 8) popLeft = 8;
    if (popLeft + pw > vw - 8) popLeft = vw - pw - 8;

    pop.style.position = "fixed";
    pop.style.top  = `${popTop}px`;
    pop.style.left = `${popLeft}px`;
    pop.classList.toggle("inl-below", putBelow);

    // Arrow: centered on anchor, clamped within popover
    let arrowLeft = cx - AW / 2;
    if (arrowLeft < popLeft + 8)              arrowLeft = popLeft + 8;
    if (arrowLeft + AW > popLeft + pw - 8)    arrowLeft = popLeft + pw - 8 - AW;
    const arrowTop = putBelow ? r.bottom + GAP : r.top - AH - GAP;

    arrow.style.position = "fixed";
    arrow.style.left   = `${arrowLeft}px`;
    arrow.style.top    = `${arrowTop}px`;
    arrow.style.width  = `${AW}px`;
    arrow.style.height = `${AH}px`;
    arrow.classList.toggle("inl-arrow-down", !putBelow);
    arrow.classList.toggle("inl-arrow-up",    putBelow);
  }

  private destroy() {
    // Remove click-outside handler
    if (this.clickOutsideHandler) {
      document.removeEventListener("mousedown", this.clickOutsideHandler, { capture: true });
      this.clickOutsideHandler = null;
    }
    this.component?.unload();
    this.component = null;
    this.el?.remove();      this.el = null;
    this.arrowEl?.remove(); this.arrowEl = null;
  }

  unload() {
    if (this.showTimer) clearTimeout(this.showTimer);
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.destroy();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Edit modal — real Obsidian editor in a temp file
// ─────────────────────────────────────────────────────────────────────────────

class EditInlineModal extends Modal {
  private leaf: WorkspaceLeaf | null = null;
  private tempFile: TFile | null = null;

  constructor(
    app: App,
    private label: string,
    private content: string,
    private isBlock: boolean,
    private sourcePath: string,
    private onSave: (newContent: string) => Promise<void>
  ) {
    super(app);
    this.modalEl.addClass("inl-edit-modal");
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createDiv({ cls: "inl-edit-header" }).createEl("h3", { text: `✏️ ${this.label}` });
    contentEl.createEl("p", { cls: "inl-hint", text: "Full Obsidian editor — [[links]], #tags, LaTeX, autocomplete all work." });

    const wrap = contentEl.createDiv({ cls: "inl-edit-editorwrap" });

    // Create temp file in same folder as source so relative paths resolve
    const dir = this.sourcePath.includes("/")
      ? this.sourcePath.slice(0, this.sourcePath.lastIndexOf("/") + 1) : "";
    const tmpPath = `${dir}_inl_tmp_${Date.now()}.md`;

    try {
      this.tempFile = await this.app.vault.create(tmpPath, this.content);
    } catch {
      this.tempFile = this.app.vault.getAbstractFileByPath(tmpPath) as TFile | null;
      if (this.tempFile) await this.app.vault.modify(this.tempFile, this.content);
    }

    if (!this.tempFile) {
      contentEl.createEl("p", { text: "Could not create temporary editor file." });
      return;
    }

    // Create leaf without connecting to any split so it doesn't affect navigation
    this.leaf = this.app.workspace.createLeafInParent(this.app.workspace.rootSplit, 0);
    await this.leaf.openFile(this.tempFile, { active: false });

    // Switch to source editing mode
    const mdView = this.leaf.view as MarkdownView;
    await mdView.setState({ mode: "source" }, { history: false });

    // Transplant leaf DOM into modal
    const leafEl = this.leaf.view.containerEl;
    leafEl.style.cssText = "height:380px;border-radius:8px;overflow:hidden;border:1px solid var(--background-modifier-border);";
    wrap.appendChild(leafEl);

    // Focus editor and move cursor to end
    setTimeout(() => {
      mdView.editor?.setCursor(mdView.editor.lastLine(), 0);
      mdView.editor?.focus();
    }, 80);

    // Buttons
    const btnRow = contentEl.createDiv({ cls: "inl-edit-buttons" });
    btnRow.createEl("button", { cls: "mod-cta", text: "💾 Save" }).addEventListener("click", async () => {
      const newContent = mdView.editor?.getValue() ?? await this.app.vault.read(this.tempFile!);
      await this.cleanup();
      await this.onSave(newContent.trim());
      this.close();
    });
    btnRow.createEl("button", { text: "Cancel" }).addEventListener("click", async () => {
      await this.cleanup();
      this.close();
    });
  }

  private async cleanup() {
    if (this.leaf) { this.leaf.detach(); this.leaf = null; }
    if (this.tempFile) {
      try { await this.app.vault.delete(this.tempFile); } catch {}
      this.tempFile = null;
    }
  }

  async onClose() { await this.cleanup(); this.contentEl.empty(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Insert modal
// ─────────────────────────────────────────────────────────────────────────────

class InsertInlineModal extends Modal {
  private label = ""; private content = ""; private mode: "inline" | "block" = "block";
  constructor(app: App, private cb: (s: string) => void) { super(app); }
  onOpen() {
    const el = this.contentEl;
    el.addClass("inl-insert-modal");
    el.createEl("h2", { text: "Insert Inline Note" });
    const modeRow = el.createDiv({ cls: "inl-mode-row" });
    modeRow.createSpan({ text: "Format: " });
    const ib = modeRow.createEl("button", { cls: "inl-mode-btn", text: "Inline" });
    const bb = modeRow.createEl("button", { cls: "inl-mode-btn inl-mode-active", text: "Block" });
    ib.addEventListener("click", () => { this.mode = "inline"; ib.classList.add("inl-mode-active"); bb.classList.remove("inl-mode-active"); });
    bb.addEventListener("click", () => { this.mode = "block"; bb.classList.add("inl-mode-active"); ib.classList.remove("inl-mode-active"); });
    new Setting(el).setName("Label").setDesc("Visible underlined text")
      .addText(t => { t.setPlaceholder("e.g. Project goals"); t.onChange(v => this.label = v); setTimeout(() => t.inputEl.focus(), 40); });
    new Setting(el).setName("Content").setDesc("Markdown: [[links]], LaTeX, callouts, checkboxes…")
      .addTextArea(ta => {
        ta.setPlaceholder("## Title\n\n- [ ] Task\n\n$E = mc^2$");
        ta.onChange(v => this.content = v);
        ta.inputEl.rows = 10;
        ta.inputEl.style.cssText = "width:100%;font-family:var(--font-monospace);font-size:12px;";
      });
    new Setting(el).addButton(btn => btn.setButtonText("Insert").setCta().onClick(() => {
      const l = this.label.trim(), c = this.content.trim();
      if (!l || !c) return;
      this.cb(this.mode === "block" ? makeBlockSyntax(l, c) : makeInlineSyntax(l, c));
      this.close();
    }));
  }
  onClose() { this.contentEl.empty(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Span factory — mode is NOT baked in; detected from DOM at hover time
// ─────────────────────────────────────────────────────────────────────────────

function makeSpan(label: string, content: string, popover: InlineNotePopover, isBlock: boolean): HTMLElement {
  const span = document.createElement("span");
  span.className = "inl-term";
  span.textContent = label;
  span.addEventListener("mouseenter", () => popover.show(span, label, content, isBlock));
  span.addEventListener("mouseleave", () => popover.hide());
  return span;
}

// ─────────────────────────────────────────────────────────────────────────────
// Canvas: replace <code>/pre blocks with hover spans
// ─────────────────────────────────────────────────────────────────────────────

function processCanvasEl(el: HTMLElement, popover: InlineNotePopover) {
  el.querySelectorAll<HTMLElement>("code").forEach(code => {
    if (code.dataset.inlDone) return;
    const parsed = parseInlineCode(code.textContent || "");
    if (!parsed) return;
    code.dataset.inlDone = "1";
    code.replaceWith(makeSpan(parsed.label, parsed.content, popover, false));
  });
  el.querySelectorAll<HTMLElement>(`pre code.language-${BLOCK_LANG}`).forEach(code => {
    if (code.dataset.inlDone) return;
    const parsed = parseBlockSource(code.textContent || "");
    if (!parsed) return;
    code.dataset.inlDone = "1";
    code.closest("pre")?.replaceWith(makeSpan(parsed.label, parsed.content, popover, true));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CM6 live-preview — shows raw syntax when cursor is inside the range
// ─────────────────────────────────────────────────────────────────────────────

function buildCM6Extension(popover: InlineNotePopover): any {
  try {
    const { ViewPlugin, Decoration, WidgetType } = require("@codemirror/view");
    const { RangeSetBuilder } = require("@codemirror/state");

    const INLINE_RE = /`inl:([^|`\n]+)\|([^`\n]+)`/g;
    const BLOCK_RE  = /```inl-note\n([\s\S]*?)```/g;

    class InlineWidget extends WidgetType {
      constructor(readonly label: string, readonly content: string, readonly isBlock: boolean) { super(); }
      toDOM(): HTMLElement { return makeSpan(this.label, this.content, popover, this.isBlock); }
      eq(o: InlineWidget) { return o.label === this.label && o.content === this.content; }
      ignoreEvent() { return false; }
    }

    function cursorOverlaps(ranges: readonly any[], from: number, to: number): boolean {
      for (const r of ranges) {
        if (r.from <= to && r.to >= from) return true;
      }
      return false;
    }

    function buildDecos(view: any) {
      const builder = new RangeSetBuilder<any>();
      const selRanges = view.state.selection.ranges;

      for (const { from, to } of view.visibleRanges) {
        const text = view.state.sliceDoc(from, to);

        INLINE_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = INLINE_RE.exec(text)) !== null) {
          const s = from + m.index, e = s + m[0].length;
          if (cursorOverlaps(selRanges, s, e)) continue;
          builder.add(s, e, Decoration.replace({
            widget: new InlineWidget(m[1].trim(), m[2].trim(), false),
          }));
        }

        BLOCK_RE.lastIndex = 0;
        while ((m = BLOCK_RE.exec(text)) !== null) {
          const s = from + m.index, e = s + m[0].length;
          if (cursorOverlaps(selRanges, s, e)) continue;
          const parsed = parseBlockSource(m[1]);
          if (!parsed) continue;
          builder.add(s, e, Decoration.replace({
            widget: new InlineWidget(parsed.label, parsed.content, true),
          }));
        }
      }
      return builder.finish();
    }

    return ViewPlugin.fromClass(class {
      decorations: any;
      constructor(view: any) { this.decorations = buildDecos(view); }
      update(u: any) {
        if (u.docChanged || u.viewportChanged || u.selectionSet)
          this.decorations = buildDecos(u.view);
      }
      destroy() {}
    }, { decorations: (v: any) => v.decorations });
  } catch (e) {
    console.warn("InlineNote: CM6 failed", e);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings tab
// ─────────────────────────────────────────────────────────────────────────────

class InlineNoteSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: InlineNotePlugin) { super(app, plugin); }
  display() {
    const el = this.containerEl;
    el.empty();
    el.createEl("h2", { text: "Inline Note Popover" });
    new Setting(el).setName("Hover delay (ms)")
      .addSlider(s => s.setLimits(0, 1000, 25).setValue(this.plugin.settings.popoverDelay).setDynamicTooltip()
        .onChange(async v => { this.plugin.settings.popoverDelay = v; await this.plugin.saveSettings(); }));
    new Setting(el).setName("Popover width (px)")
      .addSlider(s => s.setLimits(280, 800, 20).setValue(this.plugin.settings.popoverWidth).setDynamicTooltip()
        .onChange(async v => { this.plugin.settings.popoverWidth = v; await this.plugin.saveSettings(); }));
    new Setting(el).setName("Popover max height (px)")
      .addSlider(s => s.setLimits(200, 900, 20).setValue(this.plugin.settings.popoverMaxHeight).setDynamicTooltip()
        .onChange(async v => { this.plugin.settings.popoverMaxHeight = v; await this.plugin.saveSettings(); }));
    new Setting(el).setName("Theme")
      .addDropdown(d => d.addOption("auto", "Auto").addOption("dark", "Dark").addOption("light", "Light")
        .setValue(this.plugin.settings.popoverTheme)
        .onChange(async (v: string) => { this.plugin.settings.popoverTheme = v as any; await this.plugin.saveSettings(); }));
    el.createEl("h3", { text: "Syntax" });
    el.createEl("pre", { cls: "inl-syntax-ref" }).setText(
`Inline (mid-sentence):
\`inl:My Label|**bold**, $LaTeX$, any markdown\`

Block (multi-line, recommended):
\`\`\`inl-note
My Label
---
## Heading
- [ ] checkbox
> [!info] Callout
$$E = mc^2$$
\`\`\`

Use "Insert inline note" command (Ctrl/Cmd+P).`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Plugin
// ─────────────────────────────────────────────────────────────────────────────

export default class InlineNotePlugin extends Plugin {
  settings!: InlineNoteSettings;
  private popover!: InlineNotePopover;
  private observer!: MutationObserver;

  async onload() {
    await this.loadSettings();
    this.popover = new InlineNotePopover(this.app, this.settings);

    this.popover.onEditSave = async (sourcePath, label, newContent, isBlock) => {
      await saveToFile(this.app, sourcePath, label, newContent, isBlock);
    };

    const ext = buildCM6Extension(this.popover);
    if (ext) this.registerEditorExtension(ext);

    // Reading mode: block processor
    this.registerMarkdownCodeBlockProcessor(BLOCK_LANG, (src, el, ctx) => {
      const parsed = parseBlockSource(src);
      if (!parsed) { el.createEl("em", { text: "inl-note: needs Label\\n---\\ncontent" }); return; }
      el.empty();
      el.appendChild(makeSpan(parsed.label, parsed.content, this.popover, true));
    });

    // Reading mode: inline code
    this.registerMarkdownPostProcessor((el, ctx) => {
      el.querySelectorAll<HTMLElement>("code").forEach(code => {
        const parsed = parseInlineCode(code.textContent || "");
        if (!parsed) return;
        code.replaceWith(makeSpan(parsed.label, parsed.content, this.popover, false));
      });
    });

    // Re-process reading view on file open and layout changes
    // (CM6 extension handles editing mode automatically via selectionSet/docChanged)
    this.registerEvent(this.app.workspace.on("file-open", () => {
      setTimeout(() => this.processReadingViews(), 400);
    }));
    this.registerEvent(this.app.workspace.on("layout-change", () => {
      setTimeout(() => this.processReadingViews(), 400);
    }));

    // Canvas observer
    this.setupCanvasObserver();

    this.addCommand({
      id: "insert-inline-note",
      name: "Insert inline note",
      editorCallback: (editor: Editor) =>
        new InsertInlineModal(this.app, s => editor.replaceSelection(s)).open(),
    });
    this.addCommand({
      id: "insert-inline-note-block",
      name: "Insert inline note block at cursor",
      editorCallback: (editor: Editor) => {
        const cur = editor.getCursor();
        editor.replaceRange(makeBlockSyntax("My Label", "Content here"), cur);
        editor.setCursor({ line: cur.line + 1, ch: 0 });
      },
    });

    this.addSettingTab(new InlineNoteSettingTab(this.app, this));
    console.log("InlineNote loaded ✓");
  }

  // Force reading-view post-processors to re-run for all open markdown leaves
  // Obsidian's post-processors already ran at open time but we need to ensure
  // that any leaves that were restored (e.g. after relaunch) get processed.
  private processReadingViews() {
    this.app.workspace.iterateAllLeaves(leaf => {
      if (leaf.view.getViewType() !== "markdown") return;
      const mdView = leaf.view as MarkdownView;
      if (mdView.getMode() !== "preview") return;
      // Touch every .markdown-preview-section in this leaf
      const sections = mdView.containerEl.querySelectorAll<HTMLElement>(
        ".markdown-preview-section"
      );
      sections.forEach(section => {
        // Process inline code spans that haven't been converted yet
        section.querySelectorAll<HTMLElement>("code").forEach(code => {
          if (code.dataset.inlDone) return;
          const parsed = parseInlineCode(code.textContent || "");
          if (!parsed) return;
          code.dataset.inlDone = "1";
          code.replaceWith(makeSpan(parsed.label, parsed.content, this.popover, false));
        });
        // Process block code that hasn't been converted yet
        section.querySelectorAll<HTMLElement>(`pre code.language-${BLOCK_LANG}`).forEach(code => {
          if (code.dataset.inlDone) return;
          const parsed = parseBlockSource(code.textContent || "");
          if (!parsed) return;
          code.dataset.inlDone = "1";
          code.closest("pre")?.replaceWith(makeSpan(parsed.label, parsed.content, this.popover, true));
        });
      });
    });
  }

  private setupCanvasObserver() {
    const pop = this.popover;
    const scan = (root: HTMLElement) => {
      if (root.classList.contains("markdown-rendered")) { processCanvasEl(root, pop); return; }
      root.querySelectorAll<HTMLElement>(".markdown-rendered").forEach(r => processCanvasEl(r, pop));
    };

    this.observer = new MutationObserver(mutations => {
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const el = node as HTMLElement;
          if (el.closest(".inl-popover,.inl-arrow")) continue;
          if (el.classList.contains("markdown-rendered") ||
              el.classList.contains("canvas-node") ||
              el.querySelector?.(".markdown-rendered")) {
            setTimeout(() => scan(el), 150);
          }
        }
      }
    });
    this.observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
      document.querySelectorAll<HTMLElement>(".canvas-node .markdown-rendered")
        .forEach(r => processCanvasEl(r, pop));
    }, 800);
  }

  onunload() {
    this.observer?.disconnect();
    this.popover.unload();
  }

  async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
  async saveSettings() { await this.saveData(this.settings); this.popover.settings = this.settings; }
}
