import type { ItemInfluence, ModifierKind, ModifierRoll, ParsedItem, ParsedMercenarySkill, ParsedModifierBlock } from "../shared/types";

const separator = /^-{4,}$/;

const advancedHeader = /^\{\s*(.+?Modifier)(?:\s+"([^"]+)")?(?:\s+\((?:Tier|Rank|Rang):\s*(\d+)\))?(?:\s+—\s+(.+?))?\s*\}$/i;

const influenceLine = /^(Shaper|Elder|Crusader|Redeemer|Hunter|Warlord) Item$/i;
const synthesisedLine = /^(Synthesised|Synthesized) Item$/i;
const influenceNames: Record<string, ItemInfluence> = {
  shaper: "shaper",
  elder: "elder",
  crusader: "crusader",
  redeemer: "redeemer",
  hunter: "hunter",
  warlord: "warlord",
};

function modifierKind(text: string): ModifierKind {
  if (/crafted|hergestellt/i.test(text)) return "crafted";
  if (/fractured|gebrochen/i.test(text)) return "fractured";
  if (/enchant|verzauber/i.test(text)) return "enchant";
  if (/implicit|implizit/i.test(text)) return "implicit";
  if (/scourge/i.test(text)) return "scourge";
  if (/veiled|verschleiert/i.test(text)) return "veiled";
  if (/imbued/i.test(text)) return "imbued";
  return "explicit";
}

function parseRolls(line: string): ModifierRoll[] {
  const normalized = line.replace(/([-+]?\d+(?:[.,]\d+)?)\(([-+]?\d+(?:[.,]\d+)?)-([-+]?\d+(?:[.,]\d+)?)\)/g, (_all, value, min, max) =>
    `${value}{${min}:${max}}`,
  );
  const rolls: ModifierRoll[] = [];
  const pattern = /([-+]?\d+(?:[.,]\d+)?)(?:\{([-+]?\d+(?:[.,]\d+)?):([-+]?\d+(?:[.,]\d+)?)\})?/g;
  for (const match of normalized.matchAll(pattern)) {
    const valueText = match[1];
    if (valueText === undefined) continue;
    const roll: ModifierRoll = { value: Number(valueText.replace(",", ".")) };
    if (match[2] !== undefined) roll.min = Number(match[2].replace(",", "."));
    if (match[3] !== undefined) roll.max = Number(match[3].replace(",", "."));
    rolls.push(roll);
  }
  return rolls;
}

function isModifierLine(line: string, name?: string, baseType?: string): boolean {
  if (!line || separator.test(line) || line === name || line === baseType) return false;
  // Reminder text explains a modifier but is not part of the searchable stat.
  if (/^\(.+\)$/.test(line)) return false;
  if (/^(Right click|Rechtsklick|Can be used|Kann zusammen)/i.test(line)) return false;
  if (/^(Item Class|Gegenstandsklasse|Rarity|Seltenheit|Item Level|Gegenstandsstufe|Note|Notiz|Quality|Qualität|Sockets|Fassungen|Requirements?|Anforderungen|Level|Str|Dex|Int|Armour|Evasion Rating|Energy Shield|Ward|Intangibility):/i.test(line)) return false;
  if (/^(Corrupted|Verderbt|Unidentified|Nicht identifiziert)$/i.test(line)) return false;
  if (influenceLine.test(line)) return false;
  if (synthesisedLine.test(line)) return false;
  return true;
}

function parseModifierBlocks(lines: string[], name?: string, baseType?: string): ParsedModifierBlock[] {
  const blocks: ParsedModifierBlock[] = [];
  const hasAdvancedHeaders = lines.some((line) => advancedHeader.test(line));
  let current: ParsedModifierBlock | undefined;
  const flush = () => {
    if (current?.lines.length) {
      current.rolls = current.lines.flatMap(parseRolls);
      blocks.push(current);
    }
    current = undefined;
  };

  for (const line of lines) {
    if (separator.test(line)) {
      flush();
      continue;
    }
    const header = advancedHeader.exec(line);
    if (header) {
      flush();
      const descriptor = header[1] ?? "Modifier";
      const generation = /prefix|präfix/i.test(descriptor)
        ? "prefix"
        : /suffix/i.test(descriptor) ? "suffix" : undefined;
      const tags = (header[4] ?? "").split("—")[0]!.split(",").map((tag) => tag.trim()).filter(Boolean);
      current = {
        lines: [],
        kind: modifierKind(`${descriptor} ${header[2] ?? ""}`),
        ...(generation ? { generation } : {}),
        ...(header[2] ? { affixName: header[2] } : {}),
        ...(header[3] ? { tier: Number(header[3]) } : {}),
        tags,
        rolls: [],
      };
      continue;
    }
    if (!isModifierLine(line, name, baseType)) continue;
    // With advanced item descriptions, every searchable modifier belongs to
    // a { ... Modifier } header. Unheaded sections are flavour/help text.
    if (hasAdvancedHeaders && !current) continue;
    if (current) {
      current.lines.push(line);
    } else {
      blocks.push({ lines: [line], kind: modifierKind(line), tags: [], rolls: parseRolls(line) });
    }
  }
  flush();
  return blocks;
}

function valueAfterLabel(lines: string[], labels: string[]): string | undefined {
  for (const line of lines) {
    for (const label of labels) {
      if (line.toLocaleLowerCase().startsWith(label.toLocaleLowerCase())) {
        return line.slice(label.length).trim();
      }
    }
  }
  return undefined;
}

export function parsePoeItem(rawInput: string): ParsedItem {
  const raw = rawInput.replace(/\r\n/g, "\n").trim();
  const lines = raw.split("\n").map((line) => line.trim());
  const warnings: string[] = [];

  if (!raw) {
    return {
      raw,
      modifiers: [],
      modifierBlocks: [],
      isMercenaryWarrant: false,
      warnings: ["Die Zwischenablage enthält keinen Text."],
    };
  }

  const itemClass = valueAfterLabel(lines, ["Item Class:", "Gegenstandsklasse:"]);
  const rarity = valueAfterLabel(lines, ["Rarity:", "Seltenheit:"]);
  const build = valueAfterLabel(lines, ["Build:"]);
  const mercenaryLevelText = valueAfterLabel(lines, ["Mercenary Level:", "Söldnerstufe:"]);
  const itemLevelText = valueAfterLabel(lines, ["Item Level:", "Gegenstandsstufe:"]);
  const qualityText = valueAfterLabel(lines, ["Quality:", "Qualität:"]);
  const socketsText = valueAfterLabel(lines, ["Sockets:", "Fassungen:"]);
  const itemLevel = itemLevelText ? Number.parseInt(itemLevelText, 10) : undefined;
  const quality = qualityText ? Number.parseInt(qualityText.replace(/[^\d-]/g, ""), 10) : undefined;
  const socketGroups = socketsText?.split(/\s+/).filter(Boolean) ?? [];
  const sockets = socketGroups.length
    ? socketGroups.reduce((total, group) => total + (group.match(/[RGBWAD]/gi)?.length ?? 0), 0)
    : undefined;
  const links = socketGroups.length
    ? Math.max(...socketGroups.map((group) => group.match(/[RGBWAD]/gi)?.length ?? 0))
    : undefined;
  const corrupted = lines.some((line) => /^(Corrupted|Verderbt)$/i.test(line));
  const influences = Array.from(new Set(lines.flatMap((line) => {
    const match = influenceLine.exec(line);
    const influence = match?.[1] ? influenceNames[match[1].toLocaleLowerCase()] : undefined;
    return influence ? [influence] : [];
  })));
  const mercenaryLevel = mercenaryLevelText
    ? Number.parseInt(mercenaryLevelText, 10)
    : undefined;

  const rarityIndex = lines.findIndex((line) => /^(Rarity|Seltenheit):/i.test(line));
  let name: string | undefined;
  let baseType: string | undefined;
  if (rarityIndex >= 0) {
    const headerLines: string[] = [];
    for (let index = rarityIndex + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line || separator.test(line)) break;
      headerLines.push(line);
    }
    if (headerLines.length === 1) {
      baseType = headerLines[0];
    } else if (headerLines.length >= 2) {
      name = headerLines[0];
      baseType = headerLines[1];
    }
  }
  const synthesisedBaseMatch = /^(?:Synthesised|Synthesized)\s+(.+)$/i.exec(baseType ?? "");
  const synthesised = Boolean(synthesisedBaseMatch || lines.some((line) => synthesisedLine.test(line)));
  if (synthesisedBaseMatch?.[1]) baseType = synthesisedBaseMatch[1].trim();

  const warrantByClass = /Mercenary Warrant|Söldner.*Mandat/i.test(itemClass ?? "");
  const warrantByType = /Mercenary Warrant|Söldner.*Mandat/i.test(baseType ?? "");
  const isMercenaryWarrant = warrantByClass || warrantByType || Boolean(build);
  if (isMercenaryWarrant && !build) {
    warnings.push("Der kopierte Warrant enthält keine Build-Angabe.");
  }

  let mercenaryName: string | undefined;
  const mercenarySkills: ParsedMercenarySkill[] = [];
  if (isMercenaryWarrant) {
    const sections = raw.split(/\n-{4,}\n/).map((section) => section.split("\n").map((line) => line.trim()).filter(Boolean));
    const buildSectionIndex = sections.findIndex((section) => section.some((line) => /^(Build):/i.test(line)));
    if (buildSectionIndex > 0 && sections[buildSectionIndex - 1]?.length === 1) {
      mercenaryName = sections[buildSectionIndex - 1]![0];
    }
    for (const section of sections.slice(buildSectionIndex + 1)) {
      if (!section.length || /^(Right click|Rechtsklick|Can be used|Kann)/i.test(section[0]!)) continue;
      if (section.slice(1).some((line) => !/^.+ \((?:Tier|Rang):? \d+\)$/i.test(line))) continue;
      const supports = section.slice(1).map((line) => {
        const match = /^(.+) \((?:Tier|Rang):? (\d+)\)$/i.exec(line)!;
        return { name: match[1]!.trim(), tier: Number(match[2]) };
      });
      mercenarySkills.push({ name: section[0]!, supports });
    }
  }

  const labelPrefixes = [
    "Item Class:", "Gegenstandsklasse:", "Rarity:", "Seltenheit:", "Item Level:",
    "Gegenstandsstufe:", "Build:", "Mercenary Level:", "Söldnerstufe:", "Note:", "Notiz:",
    "Quality:", "Qualität:", "Sockets:", "Fassungen:",
  ];
  const itemLevelIndex = lines.findIndex((line) => /^(Item Level|Gegenstandsstufe):/i.test(line));
  const separatorAfterItemLevel = lines.findIndex((line, index) => index > itemLevelIndex && separator.test(line));
  const modifierLines = itemLevelIndex >= 0 && separatorAfterItemLevel >= 0
    ? lines.slice(separatorAfterItemLevel + 1)
    : lines;
  const modifierBlocks = parseModifierBlocks(modifierLines, name, baseType);
  const modifiers = modifierBlocks.flatMap((block) => block.lines);

  const parsed: ParsedItem = {
    raw,
    modifiers,
    modifierBlocks,
    isMercenaryWarrant,
    warnings,
  };
  if (itemClass) parsed.itemClass = itemClass;
  if (rarity) parsed.rarity = rarity;
  if (name) parsed.name = name;
  if (baseType) parsed.baseType = baseType;
  if (itemLevel !== undefined && Number.isFinite(itemLevel)) parsed.itemLevel = itemLevel;
  if (quality !== undefined && Number.isFinite(quality)) parsed.quality = quality;
  if (sockets !== undefined && sockets > 0) parsed.sockets = sockets;
  if (links !== undefined && links > 0) parsed.links = links;
  parsed.corrupted = corrupted;
  if (synthesised) parsed.synthesised = true;
  if (influences.length) parsed.influences = influences;
  if (build) parsed.build = build;
  if (mercenaryLevel !== undefined && Number.isFinite(mercenaryLevel)) parsed.mercenaryLevel = mercenaryLevel;
  if (mercenaryName) parsed.mercenaryName = mercenaryName;
  if (mercenarySkills.length) parsed.mercenarySkills = mercenarySkills;
  return parsed;
}
