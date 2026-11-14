import { expect, it, vi } from "vitest";
import { parsePoeItem } from "../src/main/parser";
import { makeQuery, searchTrade } from "../src/main/trade-service";

it.each([
  ["Skill Gems", "Fireball"],
  ["Support Gems", "Empower Support"],
  ["Support Gems", "Awakened Added Fire Damage Support"],
  ["Skill Gems", "Vaal Ice Shot"],
])("parses %s: %s without treating skill text as gear mods", (itemClass, name) => {
  const item = parsePoeItem(`Item Class: ${itemClass}
Rarity: Gem
${name}
--------
Spell, Fire
Level: 20 (Max)
Quality: +23% (augmented)
--------
Requirements:
Level: 70
--------
Deals 10 to 20 Fire Damage
--------
Corrupted`);
  expect(item).toMatchObject({ baseType: name, gem: { level: 20 }, quality: 23, corrupted: true, modifiers: [] });
  expect(makeQuery({ league: "Standard", item, itemFilters: {
    useName: false, useBaseType: true, rarity: "normal", gemLevel: { min: 20, max: 20 },
    quality: { min: 23, max: 23 }, corrupted: true,
  } })).toMatchObject({ query: { type: name, filters: {
    type_filters: { filters: { category: { option: "gem" } } },
    misc_filters: { filters: { gem_level: { min: 20, max: 20 }, quality: { min: 23, max: 23 }, corrupted: { option: "true" } } },
  } } });
});

it("uses the official catalog discriminator for a transfigured gem in both the search and link", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ result: [{ id: "gem", entries: [
      { type: "Ice Shot" },
      { type: "Ice Shot", text: "Ice Shot of Penetration", disc: "alt_x" },
    ] }] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: "query", result: [], total: 0 })));
  vi.stubGlobal("fetch", fetchMock);
  try {
    const item = parsePoeItem("Item Class: Skill Gems\nRarity: Gem\nIce Shot of Penetration\n--------\nLevel: 1");
    const pending = searchTrade({ league: "Standard", item });
    await vi.runAllTimersAsync();
    const result = await pending;
    const queryType = { option: "Ice Shot", discriminator: "alt_x" };
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).query.type).toEqual(queryType);
    expect(JSON.parse(new URL(result.tradeUrl).searchParams.get("q")!).query.type).toEqual(queryType);
  } finally {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
