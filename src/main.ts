import { App, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import type { EditorView } from "@codemirror/view";

import { panelsExtension, refreshPanels } from "./editor";
import { EditModal, EditResult } from "./modal";
import {
  Block, Kind, ViewMode, allUids, blockText, fenceEdits, findBlocks, newItem, newUid, parseItem, serializeItem, uidCounts, validate,
} from "./model";
import { renderPanel } from "./panel";
import { readingProcessor } from "./reading";

interface Settings {
  defaultView: ViewMode;
}

const DEFAULT_SETTINGS: Settings = { defaultView: "row" };

export default class NotesEventsPlugin extends Plugin {
  settings: Settings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
    this.registerEditorExtension(panelsExtension(this));
    this.registerMarkdownPostProcessor(readingProcessor(this));
    this.addSettingTab(new SettingsTab(this.app, this));
    this.addCommand({
      id: "insert-event",
      name: "Вставить событие",
      editorCallback: (editor) => this.insert(editor, "event"),
    });
    this.addCommand({
      id: "insert-task",
      name: "Вставить задачу",
      editorCallback: (editor) => this.insert(editor, "task"),
    });
    this.addCommand({
      id: "fence-all",
      name: "Обернуть все события и задачи заметки в блоки кода",
      editorCallback: (editor) => {
        const edits = fenceEdits(editor.getValue());
        editor.transaction({
          changes: edits.map((e) => ({ from: editor.offsetToPos(e.from), to: editor.offsetToPos(e.to), text: e.insert })),
        });
        new Notice(edits.length ? `Обёрнуто блоков: ${edits.length}` : "Все блоки уже в блоках кода");
      },
    });
    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor) => {
      menu.addSeparator();
      menu.addItem((item) => item.setTitle("Вставить событие").setIcon("calendar").onClick(() => this.insert(editor, "event")));
      menu.addItem((item) => item.setTitle("Вставить задачу").setIcon("check-square").onClick(() => this.insert(editor, "task")));
    }));
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!(leaf.view instanceof MarkdownView)) return;
      // @ts-expect-error `cm` is the CodeMirror view behind Obsidian's Editor; it is not in the typings.
      const cm: EditorView | undefined = leaf.view.editor.cm;
      cm?.dispatch({ effects: refreshPanels.of(null) });
      leaf.view.previewMode.rerender(true);
    });
  }

  /** The panel of a block. `duplicate`: another block of the file has the same uid. */
  panel(block: Block, duplicate: boolean, onClick: () => void): HTMLElement {
    const item = parseItem(block.raw, block.disabled);
    const errors = validate(item);
    if (duplicate) errors.push(`uid ${item.fields.uid} используется более одного раза`);
    return renderPanel(item, { defaultView: this.settings.defaultView, errors, onClick });
  }

  /** Open the form for a block of `text`; `apply` gets the new block, or null to delete it. */
  edit(block: Block, text: string, apply: (result: EditResult | null) => void): void {
    const others = findBlocks(text).filter((b) => !(b.from === block.from && b.raw === block.raw));
    new EditModal(this.app, parseItem(block.raw, block.disabled), {
      isNew: false,
      indent: block.indent,
      otherUids: new Set(uidCounts(text, others).keys()),
      takenUids: allUids(text),
      source: block.raw,
      onSubmit: apply,
    }).open();
  }

  private insert(editor: Editor, kind: Kind): void {
    const item = newItem(kind);
    const takenUids = allUids(editor.getValue());
    item.fields.uid = newUid(takenUids);
    if (kind === "event") {
      const start = new Date();
      start.setHours(start.getHours() + 1, 0, 0, 0);
      const pad = (n: number) => String(n).padStart(2, "0");
      item.fields.start = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())} ${pad(start.getHours())}:00`;
    }
    new EditModal(this.app, item, {
      isNew: true,
      indent: "",
      otherUids: new Set(uidCounts(editor.getValue()).keys()),
      takenUids,
      source: serializeItem(item),
      onSubmit: (result) => {
        if (!result) return;
        // The block gets lines of its own.
        const cursor = editor.getCursor();
        const line = editor.getLine(cursor.line);
        const before = line.slice(0, cursor.ch).trim() ? "\n" : "";
        const after = line.slice(cursor.ch).trim() ? "\n" : "";
        editor.replaceSelection(before + blockText(result.raw, result.disabled, true) + after);
      },
    }).open();
  }
}

class SettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: NotesEventsPlugin) {
    super(app, plugin);
  }

  display(): void {
    this.containerEl.empty();
    new Setting(this.containerEl)
      .setName("Вид по умолчанию")
      .setDesc("Для блоков, у которых вид не задан.")
      .addDropdown((d) => d
        .addOptions({ row: "Строка", card: "Карточка" })
        .setValue(this.plugin.settings.defaultView)
        .onChange(async (value) => {
          this.plugin.settings.defaultView = value as ViewMode;
          await this.plugin.saveSettings();
        }));
  }
}
