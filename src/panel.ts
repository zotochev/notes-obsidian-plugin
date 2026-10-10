import { setIcon } from "obsidian";

import { COLORS, Item, ViewMode, formatWhen, recurrenceLabel } from "./model";

export interface PanelOptions {
  defaultView: ViewMode;
  errors: string[];
  onClick: () => void;
}

/** The panel shown in place of a block. */
export function renderPanel(item: Item, opts: PanelOptions): HTMLElement {
  const view: ViewMode = item.meta.view === "card" || item.meta.view === "row" ? item.meta.view : opts.defaultView;
  const fallback = item.kind === "task" ? "green" : "blue";
  const color = (COLORS as readonly string[]).includes(item.meta.color) ? item.meta.color : fallback;
  const failed = opts.errors.length > 0;

  const el = createDiv({ cls: `ne-panel ne-${view} ne-color-${failed ? "red" : color}` });
  el.toggleClass("ne-disabled", item.disabled);
  el.toggleClass("ne-failed", failed);
  el.setAttribute("role", "button");
  el.setAttribute("aria-label", item.disabled ? "Выключено. Нажмите, чтобы изменить" : "Нажмите, чтобы изменить");
  el.addEventListener("click", (e) => {
    // A link in the description opens the link, not the form.
    if ((e.target as HTMLElement).closest("a")) return;
    e.preventDefault();
    opts.onClick();
  });

  const title = item.fields.summary || (item.kind === "task" ? "Задача без названия" : "Событие без названия");
  const when = formatWhen(item);
  const repeat = recurrenceLabel(item.fields.recurrence);
  const kindIcon = failed ? "alert-triangle" : item.kind === "task" ? "check-square" : "calendar";

  if (view === "row") {
    icon(el, kindIcon, "ne-kind");
    el.createSpan({ cls: "ne-title", text: title });
    if (failed) el.createSpan({ cls: "ne-error", text: opts.errors[0] });
    else if (when) el.createSpan({ cls: "ne-when", text: when });
    if (repeat) icon(el, "repeat", "ne-dim").setAttribute("aria-label", repeat);
    return el;
  }

  const body = el.createDiv({ cls: "ne-body" });
  const head = body.createDiv({ cls: "ne-head" });
  icon(head, kindIcon, "ne-kind");
  head.createSpan({ cls: "ne-title", text: title });

  const facts = body.createDiv({ cls: "ne-facts" });
  if (when) fact(facts, "clock", when);
  if (repeat) fact(facts, "repeat", repeat);
  if (item.kind === "event") {
    if (item.fields.location) fact(facts, "map-pin", item.fields.location);
    if (item.attendees.length) fact(facts, "users", String(item.attendees.length)).setAttribute("aria-label", item.attendees.join(", "));
  }
  if (!facts.childElementCount) facts.remove();

  if (item.fields.description) body.createDiv({ cls: "ne-description", text: item.fields.description });
  for (const error of opts.errors) body.createDiv({ cls: "ne-error", text: error });
  return el;
}

function icon(parent: HTMLElement, name: string, cls: string): HTMLElement {
  const el = parent.createSpan({ cls: `ne-icon ${cls}` });
  setIcon(el, name);
  return el;
}

function fact(parent: HTMLElement, iconName: string, text: string): HTMLElement {
  const el = parent.createSpan({ cls: "ne-fact" });
  icon(el, iconName, "ne-dim");
  el.createSpan({ text });
  return el;
}
