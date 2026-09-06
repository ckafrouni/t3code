import { describe, expect, it } from "vite-plus/test";
import {
  afterInsertedText,
  completionChoices,
  completionEdit,
  editorPosition,
  languagePosition,
  wordAt,
} from "./codeIntelligenceEdits";

describe("Pierre language-service edits", () => {
  it("replaces the whole property at the cursor, preserving punctuation and Unicode", () => {
    const text = "// 🌍\r\nconst café = person.naem;";
    const position = { line: 2, column: 23 };
    const edit = completionEdit(
      { label: "name", insertText: "name", kind: "property", sortText: "0" },
      text,
      position,
    );
    const lines = text.split("\n");
    const line = lines[edit.range.start.line]!;
    expect(
      line.slice(0, edit.range.start.character) +
        edit.newText +
        line.slice(edit.range.end.character),
    ).toBe("const café = person.name;");
    expect(wordAt(text, position).prefix).toBe("na");
  });

  it("honors a language-service replacement range instead of guessing a word", () => {
    const item = {
      label: "city",
      insertText: '["city"]',
      kind: "property",
      sortText: "0",
      range: { start: { line: 1, column: 7 }, end: { line: 1, column: 9 } },
    };
    const text = "person.c;";
    const edit = completionEdit(item, text, { line: 1, column: 9 });
    expect(
      text.slice(0, edit.range.start.character) +
        edit.newText +
        text.slice(edit.range.end.character),
    ).toBe('person["city"];');
  });

  it("places the caret after multiline insertions in UTF-16 coordinates", () => {
    const start = editorPosition({ line: 3, column: 8 });
    expect(languagePosition(afterInsertedText(start, "🌍"))).toEqual({ line: 3, column: 10 });
    expect(languagePosition(afterInsertedText(start, "hello\r\n🌍"))).toEqual({
      line: 4,
      column: 3,
    });
  });

  it("filters completions by the typed prefix and preserves server priority", () => {
    const items = ["name", "city", "CityHall", "citizen"].map((label, index) => ({
      label,
      insertText: label,
      kind: "property",
      sortText: String(4 - index),
    }));
    expect(completionChoices(items, "ci").map((item) => item.label)).toEqual([
      "citizen",
      "CityHall",
      "city",
    ]);
    expect(completionChoices(items, "missing")).toEqual([]);
  });
});
