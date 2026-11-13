import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePoeItem } from "../src/main/parser";
import { BoundedMemoryCache, clearWarrantMemoryCache, getTradeStatSuggestions, intersectResultIds, learnedModifierKey, makeBulkExchangeQuery, makeQuery, makeTradeUrl, matchItemModifiers, searchTrade } from "../src/main/trade-service";
import { normalizeModifierText } from "../src/main/trade-service";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generatedStatMatchers } from "../src/main/stat-directions.generated";

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

  it("does not treat the stack interaction hint as an item modifier", () => {
    const item = parsePoeItem(`Item Class: Stackable Currency
Rarity: Currency
Dead Man's Sulphur
--------
Stack Size: 20/20
--------
Shift click to unstack.`);

    expect(item.stackSize).toBe(20);
    expect(item.modifiers).toEqual([]);
    expect(item.modifierBlocks).toEqual([]);
  });

  it("parses Chaos Orb stacks without inventing trade modifiers", () => {
    const item = parsePoeItem(`Item Class: Stackable Currency
Rarity: Currency
Chaos Orb
--------
Stack Size: 20/20
--------
Shift click to unstack.`);

    expect(item).toMatchObject({ baseType: "Chaos Orb", stackSize: 20, maxStackSize: 20 });
    expect(item.modifiers).toEqual([]);
  });

  it.each([
    ["1/50,000", 1, 50_000],
    ["50,000/50,000", 50_000, 50_000],
    ["1/50.000", 1, 50_000],
  ])("parses grouped stack counts in %s", (stackText, quantity, maxStack) => {
    const item = parsePoeItem(`Item Class: Stackable Currency
Rarity: Currency
Dead Man's Sulphur
--------
Stack Size: ${stackText}`);

    expect(item.stackSize).toBe(quantity);
    expect(item.maxStackSize).toBe(maxStack);
  });

  it("does not apply the incompatible normal rarity filter to map fragments", () => {
    const item = parsePoeItem(`Item Class: Map Fragments
Rarity: Normal
Divination Scarab of Pilfering
--------
Stack Size: 1/20`);
    expect(item).toMatchObject({ stackSize: 1, maxStackSize: 20 });
    expect(item.modifiers).not.toContain("Stack Size: 1/20");
    const payload = makeQuery({
      league: "Standard",
      item,
      itemFilters: { useName: false, useBaseType: true, rarity: "normal" },
    }) as any;

    expect(payload.query.type).toBe("Divination Scarab of Pilfering");
    expect(payload.query.filters?.type_filters).toBeUndefined();
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
      ], value: { min: 2 } },
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

  it("builds the official bulk exchange query with the correct want/have direction", () => {
    expect(makeBulkExchangeQuery("divine", ["chaos"])).toEqual({
      engine: "new",
      query: { status: { option: "online" }, have: ["chaos"], want: ["divine"] },
      sort: { have: "asc" },
    });
  });

  it("prices a copied currency stack from live bulk offers and calculates current and full-stack value", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/data/static")) {
        return new Response(JSON.stringify({ result: [{
          id: "Currency",
          entries: [
            { id: "divine", text: "Divine Orb" },
            { id: "dead-mans-sulphur", text: "Dead Man's Sulphur" },
          ],
        }] }), { status: 200 });
      }
      if (target.includes("/exchange/Standard")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        expect(body).toMatchObject({ query: { have: ["chaos"], want: ["divine"] } });
        return new Response(JSON.stringify({
          id: "bulk-query",
          total: 2,
          result: {
            listing1: { id: "listing1", listing: { indexed: "2026-11-11T12:00:00Z", offers: [{ exchange: { currency: "chaos", amount: 760 }, item: { amount: 1, stock: 45 } }] } },
            listing2: { id: "listing2", listing: { indexed: "2026-11-11T12:10:00Z", offers: [{ exchange: { currency: "chaos", amount: 900 }, item: { amount: 1, stock: 20 } }] } },
          },
        }), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${target}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const item = parsePoeItem(`Item Class: Stackable Currency
Rarity: Currency
Divine Orb
--------
Stack Size: 20/20`);
      expect(item).toMatchObject({ itemClass: "Stackable Currency", rarity: "Currency", stackSize: 20, maxStackSize: 20 });
      expect(item.modifiers).toEqual([]);
      const response = await searchTrade({ league: "Standard", item });
      expect(response.bulkListings).toHaveLength(2);
      expect(response.stackValue).toMatchObject({
        quantity: 20,
        maxStackSize: 20,
        unitPrice: 830,
        currency: "chaos",
        currentTotal: 16_600,
        fullStackTotal: 16_600,
        basisListings: 2,
      });
      expect(response.tradeUrl).toContain("/trade/exchange/Standard?");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses stack-aware bulk pricing for Dead Man's Sulphur, including grouped counts", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/data/static")) {
        return new Response(JSON.stringify({ result: [{
          id: "Currency",
          entries: [{ id: "dead-mans-sulphur", text: "Dead Man's Sulphur" }],
        }] }), { status: 200 });
      }
      if (target.includes("/exchange/Standard")) {
        expect(JSON.parse(String(init?.body ?? "{}")).query.want).toEqual(["dead-mans-sulphur"]);
        return new Response(JSON.stringify({
          id: "sulphur-bulk",
          total: 1,
          result: {
            listing1: { id: "listing1", listing: { offers: [{ exchange: { currency: "divine", amount: 5 }, item: { amount: 1, stock: 100_000 } }] } },
          },
        }), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${target}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      for (const [stackText, quantity] of [["1/50,000", 1], ["50,000/50,000", 50_000]] as const) {
        const item = parsePoeItem(`Item Class: Stackable Currency
Rarity: Currency
Dead Man's Sulphur
--------
Stack Size: ${stackText}`);
        const response = await searchTrade({ league: "Standard", item });

        expect(response.bulkListings).toHaveLength(1);
        expect(response.stackValue).toMatchObject({
          quantity,
          maxStackSize: 50_000,
          unitPrice: 5,
          currency: "divine",
          currentTotal: quantity * 5,
          fullStackTotal: 250_000,
        });
      }
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/exchange/Standard"))).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
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

  it("keeps an implicit percent-life mod and an explicit flat-life mod independently selectable", async () => {
    const item = parsePoeItem(`Item Class: Rings
Rarity: Rare
Phoenix Eye
Vermillion Ring
--------
Item Level: 83
--------
{ Implicit Modifier — Life }
7(5-7)% increased maximum Life
{ Prefix Modifier "Vile" (Tier: 1) — Life }
+102(100-114) to maximum Life`);
    const matches = await matchItemModifiers(item);
    const lifeModifiers = matches.filter((match) => !match.unmatched && match.kind !== "pseudo"
      && /maximum Life/i.test(match.label));

    expect(lifeModifiers).toHaveLength(2);
    expect(lifeModifiers.map((match) => match.raw)).toEqual([
      "7(5-7)% increased maximum Life",
      "+102(100-114) to maximum Life",
    ]);
    expect(lifeModifiers.every((match) => !match.conflictKeys?.length)).toBe(true);
  });

  it("keeps percent maximum Mana and flat maximum Mana independently selectable", async () => {
    const item = parsePoeItem(`Item Class: Rings
Rarity: Rare
Mana Eye
Vermillion Ring
--------
Item Level: 83
--------
{ Implicit Modifier — Mana }
7(5-7)% increased maximum Mana
{ Prefix Modifier "Zaffre" (Tier: 2) — Mana }
+71(69-73) to maximum Mana`);
    const matches = await matchItemModifiers(item);
    const manaModifiers = matches.filter((match) => !match.unmatched && match.kind !== "pseudo"
      && /maximum Mana/i.test(match.label));

    expect(manaModifiers).toHaveLength(2);
    expect(manaModifiers.map((match) => match.raw)).toEqual([
      "7(5-7)% increased maximum Mana",
      "+71(69-73) to maximum Mana",
    ]);
    expect(manaModifiers.every((match) => !match.conflictKeys?.length)).toBe(true);
  });

  it("keeps separate flat attribute modifiers independently selectable", async () => {
    const item = parsePoeItem(`Item Class: Amulets
Rarity: Rare
Mind Eye
Onyx Amulet
--------
Item Level: 83
--------
{ Prefix Modifier "Athlete's" (Tier: 1) — Strength }
+55(51-55) to Strength
{ Suffix Modifier "of the Essence" — Attributes }
+15(13-16) to all Attributes`);
    const matches = await matchItemModifiers(item);
    const attributeModifiers = matches.filter((match) => !match.unmatched && match.kind !== "pseudo"
      && /Strength|Attributes/i.test(match.label));

    expect(attributeModifiers).toHaveLength(2);
    expect(attributeModifiers.map((match) => match.raw)).toEqual([
      "+55(51-55) to Strength",
      "+15(13-16) to all Attributes",
    ]);
    expect(attributeModifiers.every((match) => !match.conflictKeys?.length)).toBe(true);
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

  it("maps slash-combined Accuracy and Light Radius mods to two official trade stats", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      result: [
        { label: "Explicit", entries: [
          { id: "explicit.stat_accuracy", text: "#% increased Global Accuracy Rating", type: "explicit" },
          { id: "explicit.stat_light_radius", text: "#% increased Light Radius", type: "explicit" },
        ] },
      ],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const item = parsePoeItem(`Item Class: Jewels
Rarity: Rare
Test Jewel
Crimson Jewel
--------
Item Level: 84
--------
{ Prefix Modifier "Sharpshooter's" (Tier: 1) — Attack }
17(16-20)% increased Global Accuracy Rating / 15% increased Light Radius`);
      expect(item.modifierBlocks).toHaveLength(1);

      const matches = await matchItemModifiers(item);

      expect(matches.filter((match) => !match.unmatched).map((match) => match.id)).toEqual([
        "explicit.stat_624954515",
        "explicit.stat_1263695895",
      ]);
      expect(matches.every((match) => !match.unmatched)).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("splits multiple stats listed on separate lines under one advanced affix", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const item = parsePoeItem(`Item Class: Rings
Rarity: Rare
Phoenix Eye
Vermillion Ring
--------
Item Level: 83
--------
{ Prefix Modifier "Sharpshooter's" (Tier: 1) — Attack }
17(16-20)% increased Global Accuracy Rating
15% increased Light Radius`);

      expect(item.modifierBlocks[0]?.lines).toEqual([
        "17(16-20)% increased Global Accuracy Rating",
        "15% increased Light Radius",
      ]);
      const matches = await matchItemModifiers(item);

      expect(matches.filter((match) => !match.unmatched).map((match) => match.id)).toEqual([
        "explicit.stat_624954515",
        "explicit.stat_1263695895",
      ]);
      expect(matches.every((match) => !match.unmatched)).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("maps the fixed Linked Target unique modifier including its unscalable label", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const item = parsePoeItem(`Item Class: Body Armours
Rarity: Unique
Test Link Armour
Astral Plate
--------
Item Level: 83
--------
{ Explicit Modifier (Tier: 1) — Aura }
Linked Targets always count as in range of Non-Curse Auras from your Skills / Non-Curse Auras from your Skills only apply to you and Linked Targets — Unscalable Value`);
      const matches = await matchItemModifiers(item);

      expect(matches.filter((match) => !match.unmatched).map((match) => match.id)).toContain("explicit.stat_3678739763");
      expect(matches.some((match) => match.unmatched)).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to GGG live stats when the bundled catalog has no mapping", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      result: [{ label: "Explicit", entries: [
        { id: "explicit.stat_live_only", text: "#% increased Widget Power", type: "explicit" },
      ] }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const matches = await matchItemModifiers(["12% increased Widget Power"]);

      expect(matches[0]).toMatchObject({ id: "explicit.stat_live_only" });
      expect(matches[0]?.unmatched).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("suggests official live Trade stats for an unmatched modifier", async () => {
    const suggestions = await getTradeStatSuggestions(["12% increased Widget Power"], "explicit");
    expect(suggestions).toEqual([{
      id: "explicit.stat_live_only",
      text: "#% increased Widget Power",
      type: "explicit",
    }]);
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

  it("maps every searchable modifier in the bundled unique-item regression fixtures", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      for (const fixture of ["hovered-mageblood.txt", "hovered-watchers-eye.txt"]) {
        const item = parsePoeItem(readFileSync(join(__dirname, "fixtures", fixture), "utf8"));
        const matches = await matchItemModifiers(item);
        expect(matches.filter((match) => match.unmatched).map((match) => match.raw), fixture).toEqual([]);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("applies a user-confirmed mapping to matching modifier wording without another request", async () => {
    const item = parsePoeItem(`Item Class: Amulets
Rarity: Rare
Echo Pendant
Amber Amulet
--------
Item Level: 80
--------
Gain 5% of maximum Life as Energy Shield`);
    const mapping = {
      lines: ["Gain 5% of maximum Life as Energy Shield"],
      kind: "explicit" as const,
      tradeStatId: "explicit.stat_987654321",
      tradeStatText: "Gain #% of maximum Life as Extra Energy Shield",
      tradeStatType: "explicit",
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect(learnedModifierKey(mapping.lines, mapping.kind))
        .toBe(learnedModifierKey(["Gain 12% of maximum Life as Energy Shield"], "explicit"));
      const matches = await matchItemModifiers(item, [mapping]);
      expect(matches).toContainEqual(expect.objectContaining({
        id: mapping.tradeStatId,
        label: mapping.tradeStatText,
        numericValue: 5,
        learned: true,
      }));
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("recognizes the bundled multiline and fixed-value official stat patterns", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const templates = generatedStatMatchers.filter((matcher) =>
        matcher.tradeIds.explicit?.length
        && (matcher.template.includes("\n") || matcher.fixedValue !== undefined),
      );
      const item = parsePoeItem(`Item Class: Rings
Rarity: Unique
Test Relic
Gold Ring
--------
Item Level: 83`);

      for (let offset = 0; offset < templates.length; offset += 60) {
        const blocks = templates.slice(offset, offset + 60).map((matcher) => {
          const line = matcher.template.replace(/#/g, "10");
          return { lines: [line], kind: "explicit" as const, tags: [], rolls: [] };
        });
        const matches = await matchItemModifiers({
          ...item,
          modifierBlocks: blocks,
          modifiers: blocks.flatMap((block) => block.lines),
        });
        expect(matches.filter((match) => match.unmatched).map((match) => match.raw)).toEqual([]);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  }, 30_000);
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
