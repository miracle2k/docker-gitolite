import { describe, expect, it } from "vitest";
import { toSpeakable } from "../src/cards/speech.js";

const say = (s: string) => toSpeakable(s).text;

describe("markdown flattening", () => {
  it("keeps the text of emphasis and links", () => {
    expect(say("The **key** term")).toBe("The key term");
    expect(say("_italic_")).toBe("italic");
    expect(say("~~struck~~")).toBe("struck");
    expect(say("see [the docs](https://example.com)")).toBe("see the docs");
  });

  it("strips headings, quotes and bullets", () => {
    expect(say("## Heading")).toBe("Heading");
    expect(say("> quoted")).toBe("quoted");
    expect(say("- item")).toBe("item");
  });

  it("keeps image alt text, which is often the answer", () => {
    expect(say("![the Eiffel Tower](@media/x.png)")).toBe("the Eiffel Tower");
  });

  it("reports an image-only card as unspeakable", () => {
    const r = toSpeakable("![](@media/x.png)");
    expect(r.speakable).toBe(false);
  });
});

describe("answers that must survive intact", () => {
  it("does not eat intra-word underscores", () => {
    // Markdown itself does not treat these as emphasis, and a programming
    // deck would otherwise be asked to recall "snakecasename".
    expect(say("snake_case_name")).toBe("snake_case_name");
    expect(say("foo_bar_baz")).toBe("foo_bar_baz");
    expect(say("a_b_c_d")).toBe("a_b_c_d");
  });

  it("preserves subscripts", () => {
    expect(say("x_1 and x_2")).toBe("x_1 and x_2");
  });

  it("does not mistake generics for an HTML tag", () => {
    expect(say("C++ template<T>")).toBe("C++ template<T>");
    expect(say("List<String>")).toBe("List<String>");
  });

  it("still strips real HTML", () => {
    expect(say("<br>line")).toBe("line");
    expect(say("<strong>bold</strong>")).toBe("bold");
    expect(say('<a href="x">link</a>')).toBe("link");
  });

  it("leaves arithmetic alone", () => {
    expect(say("5 * 3 = 15")).toBe("5 * 3 = 15");
    expect(say("2 ** 8")).toBe("2 ** 8");
  });

  it("leaves a leading underscore alone when unpaired", () => {
    expect(say("_private")).toBe("_private");
  });

  it("keeps math content while dropping the delimiters", () => {
    expect(say("$E = mc^2$")).toBe("E = mc^2");
  });
});
