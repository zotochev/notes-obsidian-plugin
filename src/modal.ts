import { App, Modal, Notice, Setting } from "obsidian";

import { COLORS, Item, findBlocks, isBoundUid, newUid, normalizeRecurrence, parseIso, parseItem, serializeItem, validate } from "./model";

export interface EditResult {
  raw: string;
  disabled: boolean;
}

export interface EditOptions {
  isNew: boolean;
  indent: string;
  // uids of the file's other blocks.
  otherUids: ReadonlySet<string>;
  // Every uid written in the file: a generated uid must differ from all of them.
  takenUids: ReadonlySet<string>;
  // The block as it is in the file, shown when it cannot be read into the form.
  source: string;
  // Null means "delete the block".
  onSubmit: (result: EditResult | null) => void;
}

const COLOR_NAMES: Record<string, string> = {
  blue: "Синий", green: "Зелёный", purple: "Фиолетовый", red: "Красный",
  orange: "Оранжевый", yellow: "Жёлтый", pink: "Розовый", cyan: "Бирюзовый",
};
const RECURRENCE_PRESETS: Record<string, string> = {
  "": "Не повторяется",
  "FREQ=DAILY": "Каждый день",
  "FREQ=WEEKLY": "Каждую неделю",
  "FREQ=MONTHLY": "Каждый месяц",
  "FREQ=YEARLY": "Каждый год",
  custom: "Своё правило",
};

/** The form for one event or task. */
export class EditModal extends Modal {
  private xmlMode: boolean;
  private xmlText: string;
  private errorsEl: HTMLElement | null = null;
  // The uid the block came with, when the service may have bound a Google event or task to it.
  // Such a uid never changes here: with another uid the service would delete that event and make a new one.
  private boundUid: string | null;

  constructor(app: App, private item: Item, private opts: EditOptions) {
    super(app);
    // A block that cannot be read has no fields to show: it is fixed as text.
    this.xmlMode = Boolean(item.error);
    this.xmlText = opts.source;
    this.boundUid = isBoundUid(item.fields.uid, opts.otherUids) ? item.fields.uid : null;
    if (!item.error && !item.fields.uid) item.fields.uid = newUid(opts.takenUids);
  }

  onOpen(): void {
    this.modalEl.addClass("ne-modal");
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl, item } = this;
    contentEl.empty();
    const isTask = item.kind === "task";
    if (this.opts.isNew) this.setTitle(isTask ? "Новая задача" : "Новое событие");
    else this.setTitle(isTask ? "Задача" : "Событие");

    if (this.xmlMode) this.renderXml();
    else this.renderForm();

    this.errorsEl = contentEl.createDiv({ cls: "ne-form-errors" });
    const buttons = new Setting(contentEl);
    buttons.addButton((b) => b.setButtonText(this.xmlMode ? "Форма" : "XML").onClick(() => this.switchMode()));
    if (!this.opts.isNew) {
      buttons.addButton((b) => b.setButtonText("Удалить").setWarning().onClick(() => {
        this.opts.onSubmit(null);
        this.close();
      }));
    }
    buttons.addButton((b) => b.setButtonText("Сохранить").setCta().onClick(() => this.save()));
  }

  private renderForm(): void {
    const { contentEl, item } = this;
    const isTask = item.kind === "task";

    const summary = this.text(contentEl, "Название", "summary");
    window.setTimeout(() => summary.focus());
    if (isTask) {
      this.date(contentEl, "Срок", "due", false);
    } else {
      this.date(contentEl, "Начало", "start", true);
      this.date(contentEl, "Конец", "end", true).setDesc("Без конца событие длится 30 минут.");
    }
    new Setting(contentEl).setName("Описание").addTextArea((t) => {
      t.setValue(item.fields.description ?? "").onChange((v) => this.set("description", v));
      t.inputEl.rows = 3;
    });
    if (!isTask) {
      this.text(contentEl, "Место", "location");
      this.recurrence(contentEl);
    }

    new Setting(contentEl).setName("Вид")
      .addDropdown((d) => d
        .addOptions({ "": "Как в настройках", row: "Строка", card: "Карточка" })
        .setValue(item.meta.view ?? "")
        .onChange((v) => this.setMeta("view", v)))
      .addDropdown((d) => d
        .addOptions({ "": "Цвет по умолчанию", ...Object.fromEntries(COLORS.map((c) => [c, COLOR_NAMES[c]])) })
        .setValue(item.meta.color ?? "")
        .onChange((v) => this.setMeta("color", v)));

    const more = contentEl.createEl("details", { cls: "ne-more" });
    more.createEl("summary", { text: "Ещё поля" });
    if (isTask) {
      this.text(more, "Список задач", "tasklist").placeholder = "идентификатор из админки";
    } else {
      new Setting(more).setName("Участники").setDesc("Email, по одному в строке.").addTextArea((t) => {
        t.setValue(item.attendees.join("\n")).onChange((v) => {
          item.attendees = v.split(/[\n;,]/).map((s) => s.trim()).filter(Boolean);
        });
        t.inputEl.rows = 2;
      });
      this.text(more, "Календарь", "calendar_id").placeholder = "идентификатор календаря";
    }
    this.text(more, "Часовой пояс", "time_zone").placeholder = "Europe/Moscow";
    this.uid(more);
    new Setting(more).setName("Выключить").setDesc("Блок остаётся в заметке, но сервис его не видит.")
      .addToggle((t) => t.setValue(item.disabled).onChange((v) => (item.disabled = v)));
  }

  private renderXml(): void {
    const area = this.contentEl.createEl("textarea", { cls: "ne-xml" });
    area.value = this.xmlText;
    area.rows = Math.min(20, Math.max(8, this.xmlText.split("\n").length + 1));
    area.spellcheck = false;
    area.addEventListener("input", () => (this.xmlText = area.value));
  }

  private switchMode(): void {
    if (this.xmlMode) {
      const item = this.readXml();
      if (!item) return;
      if (item.error) {
        new Notice(`Блок не читается: ${item.error}`);
        return;
      }
      this.item = item;
    } else {
      this.xmlText = serializeItem(this.item);
    }
    this.xmlMode = !this.xmlMode;
    this.render();
  }

  /** The block typed into the XML box, or null when it is not exactly one block. */
  private readXml(): Item | null {
    const text = this.xmlText.trim();
    const blocks = findBlocks(text);
    if (blocks.length !== 1 || blocks[0].tagFrom !== 0 || blocks[0].to !== text.length) {
      new Notice("Здесь должен быть один блок <event> или <task>");
      return null;
    }
    return parseItem(text, this.item.disabled);
  }

  private save(): void {
    let raw: string;
    let item = this.item;
    if (this.xmlMode) {
      const parsed = this.readXml();
      if (!parsed) return;
      item = parsed;
      raw = this.xmlText.trim();
    } else {
      raw = serializeItem(item, this.opts.indent);
    }
    const errors = validate(item, this.opts.otherUids);
    if (this.boundUid && item.fields.uid !== this.boundUid) {
      errors.push(`uid менять нельзя: по нему сервис находит запись в Google. Верните uid ${this.boundUid}`);
    }
    if (errors.length) {
      this.errorsEl?.empty();
      for (const error of errors) this.errorsEl?.createDiv({ text: error });
      return;
    }
    this.opts.onSubmit({ raw, disabled: this.item.disabled });
    this.close();
  }

  private set(field: string, value: string): void {
    if (value.trim()) this.item.fields[field] = value;
    else delete this.item.fields[field];
  }

  private setMeta(key: string, value: string): void {
    if (value) this.item.meta[key] = value;
    else delete this.item.meta[key];
  }

  /** The uid is shown, not edited. A block whose uid the service cannot use may get a new one. */
  private uid(parent: HTMLElement): void {
    const { item, opts } = this;
    const setting = new Setting(parent).setName("uid");
    const value = setting.controlEl.createEl("code", { text: item.fields.uid ?? "" });
    if (this.boundUid) {
      setting.setDesc("Создаётся сам и не меняется: по нему сервис находит запись в Google.");
      return;
    }
    if (item.fields.uid && opts.otherUids.has(item.fields.uid)) {
      setting.setDesc("Такой uid уже есть в файле. Выдайте новый тому блоку, который появился позже: у первого по нему уже найдена запись в Google.");
    } else {
      setting.setDesc("Создаётся сам. После сохранения не меняется.");
    }
    setting.addButton((b) => b.setButtonText("Новый uid").onClick(() => {
      item.fields.uid = newUid(opts.takenUids);
      value.setText(item.fields.uid);
    }));
  }

  private text(parent: HTMLElement, name: string, field: string): HTMLInputElement {
    let input!: HTMLInputElement;
    new Setting(parent).setName(name).addText((t) => {
      t.setValue(this.item.fields[field] ?? "").onChange((v) => this.set(field, v));
      input = t.inputEl;
    });
    return input;
  }

  /**
   * A date: a picker, or a text box for what the service reads itself ("завтра в 10").
   * The value in the file changes only when the user changes it here.
   */
  private date(parent: HTMLElement, name: string, field: string, withTime: boolean): Setting {
    const setting = new Setting(parent).setName(name);
    const value = this.item.fields[field] ?? "";
    const iso = parseIso(value);
    let asText = value !== "" && !iso;

    const picker = setting.controlEl.createEl("input", { type: withTime ? "datetime-local" : "date" });
    if (iso) picker.value = withTime ? `${iso.date}T${iso.time ?? "00:00"}` : iso.date;
    const text = setting.controlEl.createEl("input", { type: "text", placeholder: "завтра в 10:00" });
    text.value = value;

    picker.addEventListener("input", () => {
      text.value = picker.value.replace("T", " ");
      this.set(field, text.value);
    });
    text.addEventListener("input", () => this.set(field, text.value));

    const show = () => {
      picker.toggle(!asText);
      text.toggle(asText);
    };
    show();
    setting.addExtraButton((b) => b.setIcon("text-cursor-input").setTooltip("Календарь или текст").onClick(() => {
      asText = !asText;
      show();
    }));
    return setting;
  }

  private recurrence(parent: HTMLElement): void {
    const rule = normalizeRecurrence(this.item.fields.recurrence);
    const preset = rule in RECURRENCE_PRESETS ? rule : "custom";
    const setting = new Setting(parent).setName("Повтор");
    const custom = setting.controlEl.createEl("input", { type: "text", placeholder: "FREQ=WEEKLY;BYDAY=MO,WE" });
    custom.value = rule;
    custom.toggle(preset === "custom");
    custom.addEventListener("input", () => this.set("recurrence", custom.value));
    setting.addDropdown((d) => d.addOptions(RECURRENCE_PRESETS).setValue(preset).onChange((v) => {
      custom.toggle(v === "custom");
      this.set("recurrence", v === "custom" ? custom.value : v);
    }));
  }
}
