import { Extension, Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { editorLivePreviewField } from "obsidian";

import type NotesEventsPlugin from "./main";
import { Block, findBlocks, locateEdit, uidCounts } from "./model";

/** Makes the panels of an editor be drawn again, e.g. after a change of settings. */
export const refreshPanels = StateEffect.define<null>();

class PanelWidget extends WidgetType {
  constructor(
    private plugin: NotesEventsPlugin,
    private block: Block,
    private duplicate: boolean,
    private defaultView: string,
    private inline: boolean,
  ) {
    super();
  }

  eq(other: PanelWidget): boolean {
    return other.block.raw === this.block.raw && other.block.disabled === this.block.disabled
      && other.duplicate === this.duplicate && other.defaultView === this.defaultView
      && other.inline === this.inline;
  }

  toDOM(view: EditorView): HTMLElement {
    const { block } = this;
    const el = this.plugin.panel(block, this.duplicate, () => view.state.doc.toString(), (result) => {
      const edit = locateEdit(view.state.doc.toString(), block.raw, view.posAtDOM(el), result);
      if (edit) view.dispatch({ changes: edit });
    });
    el.toggleClass("ne-inline", this.inline);
    return el;
  }

  // Clicks belong to the panel: the editor must not move the cursor into the block.
  ignoreEvent(): boolean {
    return true;
  }
}

function build(plugin: NotesEventsPlugin, view: { doc: import("@codemirror/state").Text }): DecorationSet {
  const { doc } = view;
  const text = doc.toString();
  const blocks = findBlocks(text);
  const counts = uidCounts(text, blocks);
  const ranges: Range<Decoration>[] = [];
  for (const block of blocks) {
    const first = doc.lineAt(block.from), last = doc.lineAt(block.to);
    // A block that has its lines to itself becomes a block of the page; one with text around it stays in the line.
    const alone = block.alone;
    const uid = /<uid>\s*([A-Za-z0-9]+)\s*<\/uid>/.exec(block.raw)?.[1];
    const duplicate = !block.disabled && uid !== undefined && (counts.get(uid) ?? 0) > 1;
    const widget = new PanelWidget(plugin, block, duplicate, plugin.settings.defaultView, !alone);
    ranges.push(
      alone
        ? Decoration.replace({ widget, block: true }).range(first.from, last.to)
        : Decoration.replace({ widget }).range(block.from, block.to),
    );
  }
  return Decoration.set(ranges);
}

interface PanelsState {
  livePreview: boolean;
  decorations: DecorationSet;
}

export function panelsExtension(plugin: NotesEventsPlugin): Extension {
  const field = StateField.define<PanelsState>({
    create(state) {
      const livePreview = state.field(editorLivePreviewField, false) ?? false;
      return { livePreview, decorations: livePreview ? build(plugin, state) : Decoration.none };
    },
    update(value, tr) {
      const livePreview = tr.state.field(editorLivePreviewField, false) ?? false;
      const refresh = tr.effects.some((e) => e.is(refreshPanels));
      if (!tr.docChanged && !refresh && livePreview === value.livePreview) return value;
      // In source mode the text is shown as it is.
      return { livePreview, decorations: livePreview ? build(plugin, tr.state) : Decoration.none };
    },
    provide: (f) => [
      EditorView.decorations.from(f, (value) => value.decorations),
      // The cursor steps over a panel instead of going into the text behind it.
      EditorView.atomicRanges.of((view) => view.state.field(f).decorations),
    ],
  });
  return field;
}
