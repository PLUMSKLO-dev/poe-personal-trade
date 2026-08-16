import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePoeItem } from "../src/main/parser";
import { BoundedMemoryCache, clearWarrantMemoryCache, intersectResultIds, makeQuery, makeTradeUrl, searchTrade } from "../src/main/trade-service";
import { normalizeModifierText } from "../src/main/trade-service";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("parsePoeItem", () => {
  it("parses a mercenary warrant", () => {
    const item = parsePoeItem(`Item Class: Map Fragments
Rarity: Normal
Mercenary Warrant
--------
Alara, the Cyaxan Sister
--------
Build: Infamous Manyshot
Mercenary Level: 83
--------
Right click this item to view Mercenary details.`);

    expect(item.isMercenaryWarrant).toBe(true);
    expect(item.baseType).toBe("Mercenary Warrant");
    expect(item.build).toBe("Infamous Manyshot");
    expect(item.mercenaryLevel).toBe(83);
  });

  it("parses all skills and tiered supports from the opened warrant details", () => {
    const raw = readFileSync(join(__dirname, "fixtures", "hovered-rich-warrant.txt"), "utf8");
    const item = parsePoeItem(raw);

    expect(item).toMatchObject({
      mercenaryName: "Vorrik, the Azadin Executioner",
      build: "Infamous Bladecaster",
      mercenaryLevel: 83,
    });
    expect(item.mercenarySkills).toHaveLength(6);
    expect(item.mercenarySkills?.[1]).toEqual({
      name: "Bloody Warp",
      supports: [
        { name: "Faster Casting", tier: 2 },
        { name: "Greater Critical Chance", tier: 3 },
      ],
    });
    expect(item.mercenarySkills?.[2]?.supports).toHaveLength(5);
    expect(item.mercenarySkills?.[5]).toEqual({ name: "Grace", supports: [] });
  });

  it("sends every detected mercenary skill as its own support-bound group", () => {
    const item = parsePoeItem(readFileSync(join(__dirname, "fixtures", "hovered-rich-warrant.txt"), "utf8"));
    item.mercenaryTypeOption = "PhysSpellswordNoble";
    const payload = makeQuery({
      league: "Allflame",
      item,
      mercenaryFilters: [
        { skillId: "mercenary.skill_22724", skillName: "Bloody Warp", supportIds: ["mercenary.support_38851", "mercenary.support_62220"] },
        { skillId: "mercenary.skill_37202", skillName: "Bladefall", supportIds: ["mercenary.support_64271"] },
      ],
    }) as any;

    expect(payload.query.stats).toEqual([
      { type: "mercenary", filters: [
        { id: "mercenary.skill_22724", value: {}, disabled: false },
        { id: "mercenary.support_38851", value: {}, disabled: false },
        { id: "mercenary.support_62220", value: {}, disabled: false },
      ] },
      { type: "mercenary", filters: [
        { id: "mercenary.skill_37202", value: {}, disabled: false },
        { id: "mercenary.support_64271", value: {}, disabled: false },
      ] },
    ]);
    expect(payload.query.type).toBeUndefined();
  });

  it("can search mercenary skills across all warrant builds", () => {
    const item = parsePoeItem(readFileSync(join(__dirname, "fixtures", "hovered-rich-warrant.txt"), "utf8"));
    item.mercenaryTypeOption = "Crit1HShadowPhysSpellNoble";
    const payload = makeQuery({
      league: "Allflame",
      item,
      itemFilters: { useName: false, useBaseType: false, useMercenaryBuild: false },
      mercenaryFilters: [{ skillId: "mercenary.skill_37202", skillName: "Bladefall", supportIds: [] }],
    }) as any;

    expect(payload.query.type).toBeUndefined();
    expect(payload.query.stats).toHaveLength(1);
  });

  it("never leaks ordinary item filters into a mercenary warrant query", () => {
    const item = parsePoeItem(readFileSync(join(__dirname, "fixtures", "hovered-rich-warrant.txt"), "utf8"));
    item.name = "Foulborn Mageblood";
    item.rarity = "Unique";
    const payload = makeQuery({
      league: "Allflame",
      item,
      itemFilters: {
        useName: true,
        useBaseType: true,
        rarity: "unique",
        foulborn: true,
        corrupted: true,
        itemLevel: { min: 86 },
      },
      mercenaryFilters: [{ skillId: "mercenary.skill_37202", skillName: "Bladefall", supportIds: [] }],
    }) as any;

    expect(payload.query.name).toBeUndefined();
    expect(payload.query.type).toBeUndefined();
    expect(payload.query.filters).toBeUndefined();
    expect(payload.query.stats).toHaveLength(1);
  });

  it("creates a complete official trade URL containing every mercenary block", () => {
    const item = parsePoeItem(readFileSync(join(__dirname, "fixtures", "hovered-rich-warrant.txt"), "utf8"));
    const request = {
      league: "Allflame",
      item,
      mercenaryFilters: [
        { skillId: "mercenary.skill_8708", skillName: "Elemental Hit of Ice", supportIds: [] },
        { skillId: "mercenary.skill_40957", skillName: "Wild Strike", supportIds: ["mercenary.support_1"] },
      ],
    };
    const url = new URL(makeTradeUrl(request));
    const payload = JSON.parse(url.searchParams.get("q")!);

    expect(url.pathname).toBe("/trade/search/Allflame");
    expect(payload.query.stats).toHaveLength(2);
    expect(payload.query.type).toBeUndefined();
  });

  it("intersects independently searched mercenary blocks", () => {
    expect(intersectResultIds([
      ["warrant-a", "warrant-b", "warrant-c", "warrant-b"],
      ["warrant-b", "warrant-c", "warrant-d"],
      ["warrant-c", "warrant-b"],
    ])).toEqual(["warrant-b", "warrant-c"]);
    expect(intersectResultIds([["warrant-a"], ["warrant-b"]])).toEqual([]);
    expect(intersectResultIds([])).toEqual([]);
  });

  it("handles an empty clipboard", () => {
    const item = parsePoeItem("  ");
    expect(item.isMercenaryWarrant).toBe(false);
    expect(item.warnings).toHaveLength(1);
  });

  it("maps Foulborn uniques to the official trade name and filter", () => {
    const item = parsePoeItem(`Item Class: Belts
Rarity: Unique
Foulborn Mageblood
Heavy Belt
--------
Item Level: 80`);

    expect(item.name).toBe("Foulborn Mageblood");
    const payload = makeQuery({ league: "Allflame", item }) as any;
    expect(payload.query.name).toBe("Mageblood");
    expect(payload.query.type).toBe("Heavy Belt");
    expect(payload.query.filters.misc_filters.filters.mutated.option).toBe("true");
  });

  it("separates a Synthesised prefix from the real item base type", () => {
    const item = parsePoeItem(`Item Class: Gloves
Rarity: Unique
Offering to the Serpent
Synthesised Legion Gloves
--------
Item Level: 85`);

    expect(item).toMatchObject({
      name: "Offering to the Serpent",
      baseType: "Legion Gloves",
      synthesised: true,
    });

    const payload = makeQuery({
      league: "Allflame",
      item,
      itemFilters: { useName: true, useBaseType: true, synthesised: true },
    }) as any;

    expect(payload.query.name).toBe("Offering to the Serpent");
    expect(payload.query.type).toBe("Legion Gloves");
    expect(payload.query.filters.misc_filters.filters.synthesised_item.option).toBe("true");
  });

  it("adds editable numeric ranges to selected trade stats", () => {
    const item = parsePoeItem(`Item Class: Gloves
Rarity: Rare
Test Grip
Slink Gloves
--------
Item Level: 84`);
    const payload = makeQuery({
      league: "Allflame",
      item,
      statFilters: [{ id: "explicit.stat_2302013951", min: 44, max: 53 }],
    }) as any;

    expect(payload.query.stats[0].filters[0]).toMatchObject({
      id: "explicit.stat_2302013951",
      value: { min: 44, max: 53 },
    });
    expect(payload.query.status.option).toBe("available");
  });

  it("uses Awakened-style inverted ranges and alternative-stat groups", () => {
    const item = parsePoeItem(`Item Class: Boots
Rarity: Rare
Test Pace
Vaal Greaves
--------
Item Level: 86`);
    const payload = makeQuery({
      league: "Allflame",
      item,
      statFilters: [
        { id: "explicit.stat_2878959938", min: 8, max: 12 },
        { id: "explicit.one", alternativeIds: ["explicit.two"], min: 20 },
      ],
    }) as any;

    expect(payload.query.stats[0].filters[0].value).toEqual({ min: -12, max: -8 });
    expect(payload.query.stats[1]).toMatchObject({
      type: "count",
      value: { min: 1 },
      filters: [{ id: "explicit.one", value: { min: 20 } }, { id: "explicit.two", value: { min: 20 } }],
    });
  });

  it("parses selectable item properties and boolean modifiers", () => {
    const item = parsePoeItem(`Item Class: Body Armours
Rarity: Rare
Test Shell
Astral Plate
--------
Quality: +20% (augmented)
Sockets: R-R-R-R-R-R
--------
Item Level: 86
--------
Cannot be Frozen
Corrupted`);

    expect(item).toMatchObject({ quality: 20, sockets: 6, links: 6, itemLevel: 86, corrupted: true });
    expect(item.modifiers).toContain("Cannot be Frozen");

    const payload = makeQuery({
      league: "Allflame",
      item,
      itemFilters: {
        useName: false,
        useBaseType: true,
        rarity: "rare",
        itemLevel: { min: 84 },
        quality: { min: 20 },
        sockets: { min: 6 },
        links: { min: 6 },
        corrupted: true,
      },
    }) as any;
    expect(payload.query.filters.type_filters.filters).toMatchObject({
      rarity: { option: "rare" }, ilvl: { min: 84 }, quality: { min: 20 },
      sockets: { min: 6 }, links: { min: 6 },
    });
    expect(payload.query.filters.misc_filters.filters.corrupted.option).toBe("true");
  });

  it("detects dual influence and sends the official PoE Trade pseudo stats", () => {
    const item = parsePoeItem(`Item Class: Body Armours
Rarity: Rare
Twilight Shell
Vaal Regalia
--------
Item Level: 86
--------
Shaper Item
Elder Item`);

    expect(item.influences).toEqual(["shaper", "elder"]);
    expect(item.modifiers).not.toContain("Shaper Item");
    expect(item.modifiers).not.toContain("Elder Item");

    const payload = makeQuery({
      league: "Allflame",
      item,
      itemFilters: {
        useName: false,
        useBaseType: true,
        influences: ["shaper", "elder"],
      },
    }) as any;

    expect(payload.query.stats[0].filters).toEqual(expect.arrayContaining([
      { id: "pseudo.pseudo_has_shaper_influence", value: {}, disabled: false },
      { id: "pseudo.pseudo_has_elder_influence", value: {}, disabled: false },
    ]));
  });

  it("does not leak stale influence filters into warrant searches", () => {
    const item = parsePoeItem(readFileSync(join(__dirname, "fixtures", "hovered-rich-warrant.txt"), "utf8"));
    const payload = makeQuery({
      league: "Allflame",
      item,
      itemFilters: { useName: false, useBaseType: false, influences: ["elder"] },
      mercenaryFilters: [{ skillId: "mercenary.skill_37202", skillName: "Bladefall", supportIds: [] }],
    }) as any;

    expect(JSON.stringify(payload)).not.toContain("pseudo_has_elder_influence");
  });

  it("parses advanced-description roll ranges from a real item", () => {
    const raw = readFileSync(join(__dirname, "fixtures", "hovered-advanced-boots.txt"), "utf8");
    const item = parsePoeItem(raw);

    expect(item).toMatchObject({ baseType: "Vaal Greaves", itemLevel: 86, sockets: 4, links: 3 });
    expect(item.modifiers).not.toContain("Intangibility: 8%");
    expect(item.modifiers).toContain("+131(121-150) to Armour");
    expect(item.modifierBlocks).toHaveLength(6);
    expect(item.modifierBlocks[0]).toMatchObject({
      generation: "prefix", affixName: "Encased", tier: 1, kind: "explicit",
      lines: ["+131(121-150) to Armour"],
      rolls: [{ value: 131, min: 121, max: 150 }],
    });
    expect(item.modifierBlocks[4]).toMatchObject({
      generation: "suffix", affixName: "of Youth", tier: 2,
      lines: ["19(18-19)% increased Life Regeneration rate"],
    });
    expect(normalizeModifierText("+131(121-150) to Armour")).toBe("+131 to Armour");
    expect(normalizeModifierText("19(18-19)% increased Life Regeneration rate"))
      .toBe("19% increased Life Regeneration rate");
  });

  it("separates a Watcher's Eye stat from reminder, flavour and help text", () => {
    const raw = readFileSync(join(__dirname, "fixtures", "hovered-watchers-eye.txt"), "utf8");
    const item = parsePoeItem(raw);

    expect(item.modifierBlocks).toHaveLength(1);
    expect(item.modifierBlocks[0]).toMatchObject({
      kind: "explicit",
      lines: ["Unaffected by Vulnerability while affected by Determination"],
    });
    expect(item.modifiers.join(" ")).not.toMatch(/Debuffs|One by one|Jewel Socket/);
  });

  it("keeps every advanced Mageblood modifier in its own searchable block", () => {
    const raw = readFileSync(join(__dirname, "fixtures", "hovered-mageblood.txt"), "utf8");
    const item = parsePoeItem(raw);

    expect(item.modifierBlocks).toHaveLength(6);
    expect(item.modifierBlocks.map((block) => block.lines.join(" "))).toContain(
      "Leftmost 4 Magic Utility Flasks constantly apply their Flask Effects to you",
    );
    expect(item.modifiers).not.toContain("They know you will come.");
  });
});

describe("warrant memory cache", () => {
  afterEach(() => {
    clearWarrantMemoryCache();
    vi.unstubAllGlobals();
  });

  it("expires entries and evicts the least recently used entry at its size limit", () => {
    let now = 1_000;
    const cache = new BoundedMemoryCache<string>(2, 500, () => now);
    cache.set("first", "A");
    cache.set("second", "B");
    expect(cache.get("first")).toBe("A");

    cache.set("third", "C");
    expect(cache.get("second")).toBeUndefined();
    expect(cache.get("first")).toBe("A");
    expect(cache.get("third")).toBe("C");

    now += 501;
    expect(cache.get("first")).toBeUndefined();
    expect(cache.get("third")).toBeUndefined();
  });

  it("deduplicates simultaneous and repeated warrant search and offer requests", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("/search/")) {
        return new Response(JSON.stringify({ id: "query-1", total: 1, result: ["warrant-1"] }), { status: 200 });
      }
      if (target.includes("/fetch/")) {
        return new Response(JSON.stringify({
          result: [{
            id: "warrant-1",
            listing: { price: { amount: 2, currency: "divine" }, account: { name: "tester" } },
            item: { properties: [{ name: "Build", values: [["Manyshot"]] }] },
          }],
        }), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${target}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const item = parsePoeItem(`Item Class: Map Fragments
Rarity: Normal
Mercenary Warrant
--------
Test Mercenary
--------
Build: Manyshot
Mercenary Level: 83
--------
Right click this item to view Mercenary details.`);
    const request = {
      league: "Allflame",
      item,
      mercenaryFilters: [{ skillId: "mercenary.skill_1", skillName: "Ice Shot", supportIds: [] }],
    };

    const [first, simultaneous] = await Promise.all([searchTrade(request), searchTrade(request)]);
    const repeated = await searchTrade(request);

    expect(first.results[0]?.price).toEqual({ amount: 2, currency: "divine" });
    expect(simultaneous.queryId).toBe("query-1");
    expect(repeated.queryId).toBe("query-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
