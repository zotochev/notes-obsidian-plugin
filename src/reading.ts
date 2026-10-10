import { MarkdownPostProcessorContext, MarkdownRenderChild, MarkdownRenderer, TFile } from "obsidian";

import type NotesEventsPlugin from "./main";
import { applyEdit, findBlocks, locateEdit, uidCounts } from "./model";

/**
 * Reading view: a section of the note that has a block in it is drawn again from its source,
 * with panels in place of the blocks. Obsidian's own rendering of the XML is of no use: it
 * drops the unknown tags and cuts a block in two at an empty line.
 */
export function readingProcessor(plugin: NotesEventsPlugin) {
  return (el: HTMLElement, ctx: MarkdownPostProcessorContext): void => {
    const info = ctx.getSectionInfo(el);
    if (!info) return;
    const text = info.text;
    const all = findBlocks(text);
    if (!all.length) return;

    const lines = text.split("\n");
    let from = 0;
    for (let i = 0; i < info.lineStart; i++) from += lines[i].length + 1;
    let to = from;
    for (let i = info.lineStart; i <= info.lineEnd && i < lines.length; i++) to += lines[i].length + 1;
    to = Math.min(to - 1, text.length);

    const blocks = all.filter((b) => b.from < to && b.to > from);
    if (!blocks.length) return;

    const counts = uidCounts(text, all);
    const child = new MarkdownRenderChild(el);
    ctx.addChild(child);
    el.empty();
    el.addClass("ne-section");

    const markdown = (source: string) => {
      if (!source.trim()) return;
      void MarkdownRenderer.render(plugin.app, source, el.createDiv(), ctx.sourcePath, child);
    };

    let pos = from;
    for (const block of blocks) {
      if (block.from > pos) markdown(text.slice(pos, block.from));
      // A block that began in an earlier section has its panel there.
      if (block.from >= from) {
        const uid = /<uid>\s*([A-Za-z0-9]+)\s*<\/uid>/.exec(block.raw)?.[1];
        const duplicate = !block.disabled && uid !== undefined && (counts.get(uid) ?? 0) > 1;
        el.appendChild(plugin.panel(block, duplicate, () => text, (result) => {
          const file = plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
          if (!(file instanceof TFile)) return;
          void plugin.app.vault.process(file, (current) => {
            const edit = locateEdit(current, block.raw, block.from, result);
            return edit ? applyEdit(current, edit) : current;
          });
        }));
      }
      pos = Math.max(pos, block.to);
    }
    if (pos < to) markdown(text.slice(pos, to));
    if (!el.childElementCount) el.addClass("ne-empty");
  };
}
