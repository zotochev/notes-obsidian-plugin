// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  allUids, applyEdit, fenceEdits, isBoundUid, findBlocks, formatWhen, locateEdit, newUid, parseItem, recurrenceLabel, serializeItem, uidCounts, validate,
} from "../src/model";

const EVENT = `<event>
  <!-- view: card; color: purple -->
  <uid>a1</uid>
  <summary>A &amp; B</summary>
  <start>2026-11-11 08:00</start>
  <end>2026-11-11 09:00</end>
  <attendees>a@b.com; c@d.com</attendees>
</event>`;

describe("findBlocks", () => {
  it("finds blocks anywhere in the text", () => {
    const text = `intro\n${EVENT}\ntext <task><uid>t1</uid><summary>x</summary></task> tail`;
    const blocks = findBlocks(text);
    expect(blocks.map((b) => b.kind)).toEqual(["event", "task"]);
    expect(blocks[0].raw).toBe(EVENT);
    expect(text.slice(blocks[1].from, blocks[1].to)).toBe(blocks[1].raw);
  });

  it("sees a block with # before it as switched off and takes the # into its range", () => {
    const text = `  #<task>\n  <uid>t1</uid>\n  </task>`;
    const [block] = findBlocks(text);
    expect(block.disabled).toBe(true);
    expect(text[block.from]).toBe("#");
    expect(block.indent).toBe("  ");
  });

  it("does not let one block swallow the next", () => {
    const text = "<event><uid>a</uid>\n<event><uid>b</uid></event>";
    expect(findBlocks(text).map((b) => b.raw)).toEqual(["<event><uid>b</uid></event>"]);
  });
});

describe("parseItem and serializeItem", () => {
  it("reads fields, attendees and the display comment", () => {
    const item = parseItem(EVENT);
    expect(item.fields).toMatchObject({ uid: "a1", summary: "A & B", start: "2026-11-11 08:00" });
    expect(item.attendees).toEqual(["a@b.com", "c@d.com"]);
    expect(item.meta).toEqual({ view: "card", color: "purple" });
    expect(item.error).toBeUndefined();
  });

  it("writes back what it read", () => {
    expect(serializeItem(parseItem(EVENT))).toBe(EVENT);
  });

  it("keeps tags, comments and attributes it does not know", () => {
    const raw = `<task id="x">\n  <uid>t1</uid>\n  <summary>s</summary>\n  <!-- note -->\n  <custom>1</custom>\n</task>`;
    expect(serializeItem(parseItem(raw))).toBe(raw);
  });

  it("reads attendees written as nested tags", () => {
    const item = parseItem("<event><attendees><email>a@b.com</email><email>c@d.com</email></attendees></event>");
    expect(item.attendees).toEqual(["a@b.com", "c@d.com"]);
  });

  it("indents the lines of a block that is itself indented", () => {
    const item = parseItem("<task><uid>t1</uid><summary>s</summary></task>");
    expect(serializeItem(item, "    ")).toBe("<task>\n      <uid>t1</uid>\n      <summary>s</summary>\n    </task>");
  });

  it("reports broken XML, repeated tags and nested tags", () => {
    expect(parseItem("<event><summary>A & B</summary></event>").error).toBe("некорректный XML");
    expect(parseItem("<event><uid>a</uid><uid>b</uid></event>").error).toContain("более одного раза");
    expect(parseItem("<event><summary><b>x</b></summary></event>").error).toContain("вложенных");
  });

  it("drops lines that start with #, as the service does", () => {
    const item = parseItem("<event>\n<uid>a</uid>\n# <summary>off</summary>\n</event>");
    expect(item.fields).toEqual({ uid: "a" });
  });
});

describe("validate", () => {
  it("accepts a correct event and task", () => {
    expect(validate(parseItem(EVENT))).toEqual([]);
    expect(validate(parseItem("<task><uid>t1</uid><summary>s</summary></task>"))).toEqual([]);
  });

  it("rejects what the service rejects", () => {
    const errors = (raw: string, uids: string[] = []) => validate(parseItem(raw), new Set(uids)).join("; ");
    expect(errors("<event><summary>s</summary><start>2026-01-01</start></event>")).toContain("uid");
    expect(errors("<event><uid>a-1</uid><summary>s</summary><start>2026-01-01</start></event>")).toContain("латинских");
    expect(errors("<event><uid>a</uid><summary>s</summary></event>")).toContain("начало");
    expect(errors("<event><uid>a</uid><summary>s</summary><start>2026-01-01 10:00</start><end>2026-01-01 09:00</end></event>"))
      .toContain("позже");
    expect(errors("<event><uid>a</uid><summary>s</summary><start>2026-01-01</start><due>2026-01-02</due></event>")).toContain("due");
    expect(errors("<task><uid>a</uid><summary>s</summary><start>2026-01-01</start></task>")).toContain("start");
    expect(errors("<event><uid>a</uid><summary>s</summary><start>2026-01-01</start><attendees>nope</attendees></event>"))
      .toContain("email");
    expect(errors("<task><uid>a</uid><summary>s</summary><time_zone>Mars/Olympus</time_zone></task>")).toContain("пояс");
    expect(errors("<task><uid>a</uid><summary>s</summary></task>", ["a"])).toContain("уже используется");
  });

  it("leaves free-form dates to the service", () => {
    expect(validate(parseItem("<event><uid>a</uid><summary>s</summary><start>завтра в 10</start></event>"))).toEqual([]);
  });
});

describe("formatWhen", () => {
  const now = new Date(2026, 9, 10);
  const when = (raw: string) => formatWhen(parseItem(raw), now);

  it("shows the day and the hours", () => {
    expect(when(EVENT)).toBe("ср, 11 ноя · 08:00–09:00");
    expect(when("<event><start>2026-11-11 08:00</start></event>")).toBe("ср, 11 ноя · 08:00");
    expect(when("<event><start>2026-11-11 08:00</start><end>2026-11-12 09:00</end></event>"))
      .toBe("11 ноя 08:00 – 12 ноя 09:00");
  });

  it("adds the year when it is not the current one", () => {
    expect(when("<task><due>2027-01-05</due></task>")).toBe("до 5 янв 2027");
  });

  it("shows free-form dates as they are written", () => {
    expect(when("<event><start>завтра в 10</start></event>")).toBe("завтра в 10");
    expect(when("<task><due>через 3 дня</due></task>")).toBe("до через 3 дня");
  });
});

describe("recurrenceLabel", () => {
  it("names the simple rules", () => {
    expect(recurrenceLabel("RRULE:FREQ=WEEKLY")).toBe("каждую неделю");
    expect(recurrenceLabel("FREQ=WEEKLY;BYDAY=MO")).toBe("повторяется");
    expect(recurrenceLabel(undefined)).toBe("");
  });
});

describe("locateEdit", () => {
  const task = (uid: string) => `<task><uid>${uid}</uid><summary>s</summary></task>`;

  const on = (uid: string) => ({ raw: task(uid), disabled: false });
  const fence = (body: string) => "```xml\n" + body + "\n```";

  it("replaces the block and puts it into a code fence", () => {
    const text = `a\n${task("t1")}\nb`;
    const edit = locateEdit(text, task("t1"), 0, on("t2"));
    expect(applyEdit(text, edit!)).toBe(`a\n${fence(task("t2"))}\nb`);
  });

  it("replaces a block with its fence, keeping one fence", () => {
    const text = `a\n${fence(task("t1"))}\nb`;
    expect(applyEdit(text, locateEdit(text, task("t1"), 0, on("t2"))!)).toBe(`a\n${fence(task("t2"))}\nb`);
  });

  it("leaves a block with text on its line without a fence", () => {
    const text = `a ${task("t1")} b`;
    expect(applyEdit(text, locateEdit(text, task("t1"), 0, on("t2"))!)).toBe(`a ${task("t2")} b`);
  });

  it("removes the block with its line and its fence", () => {
    expect(applyEdit(`a\n${task("t1")}\nb`, locateEdit(`a\n${task("t1")}\nb`, task("t1"), 0, null)!)).toBe("a\nb");
    const text = `a\n${fence(task("t1"))}\nb`;
    expect(applyEdit(text, locateEdit(text, task("t1"), 0, null)!)).toBe("a\nb");
  });

  it("switches a block on and off inside the fence", () => {
    const text = fence(`#${task("t1")}`);
    expect(findBlocks(text)[0]).toMatchObject({ disabled: true, fenced: true, from: 0, to: text.length });
    expect(applyEdit(text, locateEdit(text, task("t1"), 0, on("t1"))!)).toBe(fence(task("t1")));
    const off = locateEdit(fence(task("t1")), task("t1"), 0, { raw: task("t1"), disabled: true });
    expect(applyEdit(fence(task("t1")), off!)).toBe(text);
  });

  it("switches a block off with one # before the opening tag, for a task and an event alike", () => {
    for (const kind of ["task", "event"]) {
      const raw = `<${kind}>\n  <uid>t123</uid>\n  <summary>Позвонить в банк</summary>\n</${kind}>`;
      const offText = "```xml\n#" + raw + "\n```";
      const turnedOff = locateEdit(fence(raw), raw, 0, { raw, disabled: true });
      expect(applyEdit(fence(raw), turnedOff!)).toBe(offText);
      // The same text without a language on the fence is read the same way.
      for (const text of [offText, "```\n#" + raw + "\n```"]) {
        expect(findBlocks(text)[0]).toMatchObject({ disabled: true, fenced: true, raw, from: 0, to: text.length });
      }
      expect(applyEdit(offText, locateEdit(offText, raw, 0, { raw, disabled: false })!)).toBe(fence(raw));
    }
  });

  it("keeps the indent of a fenced block", () => {
    const text = "- item\n  ```xml\n  " + task("t1") + "\n  ```";
    expect(applyEdit(text, locateEdit(text, task("t1"), 0, on("t2"))!))
      .toBe("- item\n  ```xml\n  " + task("t2") + "\n  ```");
  });

  it("takes the nearest of identical blocks and gives null when there is none", () => {
    const text = `${task("t1")}\n${task("t1")}`;
    expect(locateEdit(text, task("t1"), text.length, on("t2"))!.from).toBeGreaterThan(0);
    expect(locateEdit(text, task("zz"), 0, on("t2"))).toBeNull();
  });
});

describe("fences", () => {
  const task = (uid: string) => `<task><uid>${uid}</uid><summary>s</summary></task>`;

  it("does not take a fence that holds more than the block", () => {
    const text = "```xml\nsome text\n" + task("t1") + "\n```";
    expect(findBlocks(text)[0].fenced).toBe(false);
  });

  it("wraps every block that has no fence yet", () => {
    const text = `${task("t1")}\n\n\`\`\`xml\n${task("t2")}\n\`\`\`\n\ntext ${task("t3")}`;
    let result = text;
    for (const edit of fenceEdits(text)) result = applyEdit(result, edit);
    expect(result).toBe(`\`\`\`xml\n${task("t1")}\n\`\`\`\n\n\`\`\`xml\n${task("t2")}\n\`\`\`\n\ntext ${task("t3")}`);
    expect(fenceEdits(result)).toEqual([]);
  });
});

describe("uids", () => {
  it("counts only blocks that are switched on", () => {
    const text = "<task><uid>a</uid></task>\n<task><uid>a</uid></task>\n#<task><uid>a</uid></task>";
    expect(uidCounts(text).get("a")).toBe(2);
  });

  it("makes a uid of the date and time", () => {
    expect(newUid(new Set(), new Date(2026, 3, 7, 11, 14, 0))).toBe("20260407111400");
    expect(newUid()).toMatch(/^\d{14}$/);
  });

  it("adds a letter when the uid of this second is taken", () => {
    const now = new Date(2026, 3, 7, 11, 14, 0);
    expect(newUid(new Set(["20260407111400"]), now)).toBe("20260407111400a");
    expect(newUid(new Set(["20260407111400", "20260407111400a"]), now)).toBe("20260407111400b");
    const taken = new Set(["20260407111400"]);
    for (let i = 0; i < 26; i++) taken.add("20260407111400" + String.fromCharCode(97 + i));
    expect(newUid(taken, now)).toBe("20260407111400aa");
  });

  it("collects every uid of the file, of blocks switched off too", () => {
    expect(allUids("<task><uid>a</uid></task>\n#<task><uid> b </uid></task>")).toEqual(new Set(["a", "b"]));
  });

  it("holds a uid the service can use and lets a missing, wrong or repeated one go", () => {
    expect(isBoundUid("a1", new Set(["b"]))).toBe(true);
    expect(isBoundUid(undefined, new Set())).toBe(false);
    expect(isBoundUid("a-1", new Set())).toBe(false);
    expect(isBoundUid("a1", new Set(["a1"]))).toBe(false);
  });
});
