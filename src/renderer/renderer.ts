import "./styles.css";
import type {
  MercenaryCatalog,
  MercenaryFilter,
  ItemSearchFilters,
  ParsedItem,
  SearchResponse,
  TradeStatMatch,
  TradeStatFilter,
  ItemInfluence,
  AppLanguage,
  UpdateState,
} from "../shared/types";
import { getLanguage, locale, setLanguage, t } from "./i18n";

const fallbackSupports = [
  ["mercenary.support_5293", "Return III"],
  ["mercenary.support_28416", "Greater Elemental Damage with Attacks III"],
  ["mercenary.support_44886", "Elemental Damage with Attacks II"],
  ["mercenary.support_53145", "Greater Hypothermia III"],
  ["mercenary.support_26094", "Greater Cold Penetration III"],
  ["mercenary.support_49419", "Greater Multiple Projectiles III"],
  ["mercenary.support_56267", "Pierce II"],
  ["mercenary.support_53342", "Increased Area of Effect II"],
] as const;

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
};

let currentItem: ParsedItem | undefined;
let currentSearch: SearchResponse | undefined;
let mercenaryCatalog: MercenaryCatalog | undefined;
let itemGeneration = 0;
const selectedSupportIds = new Set<string>();
const selectedStatIds = new Set<string>();
let currentUpdateState: UpdateState = { status: "idle" };

function renderUpdateState(state: UpdateState): void {
  currentUpdateState = state;
  const panel = $("update-panel");
  const button = $("update-button") as HTMLButtonElement;
  panel.classList.remove("hidden");
  panel.dataset.status = state.status;
  button.disabled = state.status === "checking" || state.status === "available" || state.status === "downloading" || state.status === "disabled";
  button.textContent = state.status === "ready" ? t("updateRestart")
    : state.status === "current" || state.status === "error" || state.status === "idle" ? t("updateCheck") : "";
  const version = state.version ?? "";
  const percent = state.percent ?? 0;
  const key = state.status === "disabled" ? "updateDisabled"
    : state.status === "checking" ? "updateChecking"
      : state.status === "available" ? "updateAvailable"
        : state.status === "downloading" ? "updateDownloading"
          : state.status === "ready" ? "updateReady"
            : state.status === "current" ? "updateCurrent"
              : state.status === "error" ? "updateError" : "updateIdle";
  const message = t(key, { version, percent });
  $("update-status").textContent = message;
  $("update-status").title = state.message ? `${message} ${state.message}` : message;
}

function applyStaticTranslations(): void {
  document.documentElement.lang = getLanguage();
  $("hide-button").title = t("hide");
  $("quit-button").title = t("hideOverlay");
  $("intro-step-one").innerHTML = t("introOne");
  $("intro-step-two").innerHTML = t("introTwo");
  $("intro-safe").textContent = t("safe");
  $("league-label").textContent = t("league");
  $("language-label").textContent = t("language");
  $("read-button").textContent = t("readItem");
  $("read-button").title = t("readItemTitle");
  $("empty-state").textContent = t("empty");
  $("raw-item-summary").textContent = t("rawItem");
  $("item-options-label").textContent = t("itemOptions");
  $("item-options-hint").textContent = t("itemOptionsHint");
  $("mod-filter-heading").textContent = t("modFilters");
  $("mods-all").textContent = t("recommended");
  $("mods-none").textContent = t("none");
  $("mercenary-heading").textContent = t("mercenarySearch");
  $("mercenary-heading-hint").textContent = t("mercenaryHint");
  $("mercenary-instructions").textContent = t("mercenaryInstructions");
  $("skill-label").textContent = t("skill");
  if (!mercenaryCatalog) ($("merc-skill") as HTMLSelectElement).innerHTML = `<option value="">${t("catalogLoading")}</option>`;
  $("support-search-label").textContent = t("searchSupports");
  ($("support-search") as HTMLInputElement).placeholder = t("supportPlaceholder");
  $("search-button").title = t("priceCheckTitle");
  $("results-heading-label").textContent = t("listings");
  $("open-trade-button").textContent = t("openOfficial");
  $("footer-text").textContent = t("footer");
  renderUpdateState(currentUpdateState);
}

const influenceDisplayNames: Record<ItemInfluence, string> = {
  shaper: "Shaper",
  elder: "Elder",
  crusader: "Crusader",
  redeemer: "Redeemer",
  hunter: "Hunter",
  warlord: "Warlord",
};

function setHidden(id: string, hidden: boolean): void {
  $(id).classList.toggle("hidden", hidden);
}

function setSearchStatus(message: string, tone: "idle" | "searching" | "success" | "error" = "idle"): void {
  const status = $("search-status");
  status.textContent = message;
  status.title = message;
  status.dataset.tone = tone;
}

function updateSelectionSummary(): void {
  const summary = $("selection-summary");
  if (!currentItem) {
    summary.textContent = "";
    return;
  }
  if (currentItem.isMercenaryWarrant) {
    const skills = document.querySelectorAll(".detected-skill-checkbox:checked").length;
    const supports = Array.from(document.querySelectorAll<HTMLElement>(".detected-skill"))
      .filter((row) => row.querySelector<HTMLInputElement>(".detected-skill-checkbox")?.checked)
      .reduce((count, row) => count + row.querySelectorAll(".detected-support-checkbox:checked").length, 0);
    if (currentItem.mercenarySkills?.length) {
      summary.textContent = t("skillSupportCount", {
        skills, supports,
        skillSuffix: skills === 1 ? "" : "s",
        supportSuffix: supports === 1 ? "" : "s",
      });
    } else {
      summary.textContent = t("supportCount", { count: selectedSupportIds.size, suffix: selectedSupportIds.size === 1 ? "" : "s" });
    }
    return;
  }
  const mods = document.querySelectorAll('.modifier-option input[type="checkbox"]:checked').length;
  const itemFilters = document.querySelectorAll('.item-filter-row > input[type="checkbox"]:checked').length;
  summary.textContent = t("filtersCount", {
    mods, filters: itemFilters,
    modSuffix: mods === 1 ? "" : "s",
    filterSuffix: itemFilters === 1 ? "" : "s",
  });
}

function markSearchDirty(): void {
  updateSelectionSummary();
  if (!currentSearch) return;
  $("results-panel").classList.add("results-stale");
  setSearchStatus(t("dirty"), "idle");
}

function formatPrice(amount: number, currency: string): string {
  const names: Record<string, string> = { divine: "Divine", chaos: "Chaos", exalted: "Exalted" };
  return `${amount} ${names[currency] ?? currency}`;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return localizeBackendMessage(message.replace(/^Error invoking remote method '[^']+': Error:\s*/, ""));
}

function localizeBackendMessage(message: string): string {
  if (getLanguage() === "de") return message;
  return message
    .replace("Der kopierte Warrant enthält keine Build-Angabe.", "The copied Warrant does not contain a build.")
    .replace(/GGG-Rate-Limit aktiv\. Bitte (\d+) Sekunden warten\./, "GGG rate limit active. Please wait $1 seconds.")
    .replace("Trade-Anfrage fehlgeschlagen", "Trade request failed")
    .replace("Ungültiger Liga-Name.", "Invalid league name.")
    .replace("Für die exakte Support-Kombination gab es 0 Treffer. Die Suche wurde automatisch mit denselben Skills ohne Support-Zwang wiederholt.", "The exact support combination returned 0 results. The search was automatically repeated with the same skills without requiring supports.")
    .replace(/(\d+) Mercenary-Blöcke wurden gemeinsam über die offizielle Suche ausgewertet\./, "$1 Mercenary blocks were evaluated together using the official search.")
    .replace(/PoE lehnte die kombinierte Suche als zu komplex ab; (\d+) Teilabfragen wurden deshalb lokal exakt geschnitten\./, "PoE rejected the combined search as too complex; $1 partial queries were intersected locally with exact AND semantics.")
    .replace("Komplexe Support-Blöcke wurden automatisch aufgeteilt.", "Complex support blocks were split automatically.")
    .replace("Der komplexe Support-Block wurde automatisch aufgeteilt und lokal exakt ausgewertet.", "The complex support block was split automatically and evaluated locally with exact AND semantics.")
    .replace("Nur manuell ausgelöste Suche;", "Manually triggered search only;")
    .replace("Maximal zehn sichtbare Vergleichsangebote werden geladen.", "Up to ten visible comparison listings are loaded.")
    .replace("maximal zehn sichtbare Vergleichsangebote werden geladen.", "up to ten visible comparison listings are loaded.")
    .replace("Identische Warrant-Abfragen werden fünf Minuten lang nur im Arbeitsspeicher wiederverwendet.", "Identical Warrant queries are reused in memory for five minutes.")
    .replace("PoE hat kein neues Item kopiert. Bitte den Mauszeiger direkt über das Item halten.", "PoE did not copy a new item. Keep the cursor directly over the item.")
    .replace("Alt+D und Ctrl+Alt+D sind bereits durch andere Programme belegt.", "Alt+D and Ctrl+Alt+D are already used by other applications.")
    .replace("Die Zwischenablage enthält keinen Text.", "The clipboard does not contain text.")
    .replace("Ungültiger Itemtext.", "Invalid item text.")
    .replace("Ungültige Mod-Liste.", "Invalid modifier list.")
    .replace("Nur offizielle PoE-Trade-Links sind erlaubt.", "Only official PoE Trade links are allowed.")
    .replace("Ungültige Einstellungen.", "Invalid settings.")
    .replace(/Copy-Helper endete mit Code (\d+)\./, "Copy helper exited with code $1.");
}

function defaultStatRange(match: TradeStatMatch): { min?: number; max?: number } {
  const value = match.numericValue!;
  const lower = Math.min(value * 0.9, value * 1.1);
  const upper = Math.max(value * 0.9, value * 1.1);
  const min = Number.isInteger(value) ? Math.floor(lower) : Number(lower.toFixed(2));
  const max = Number.isInteger(value) ? Math.ceil(upper) : Number(upper.toFixed(2));
  if (match.better === -1) return { max };
  if (match.better === 0) return { min, max };
  return { min };
}

function selectedTradeStatFilters(): TradeStatFilter[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".modifier-option"))
    .flatMap((row) => {
      const checkbox = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
      if (!checkbox?.checked) return [];
      const minInput = row.querySelector<HTMLInputElement>('input[data-bound="min"]');
      const maxInput = row.querySelector<HTMLInputElement>('input[data-bound="max"]');
      const min = minInput?.value.trim() ? Number.parseFloat(minInput.value) : undefined;
      const max = maxInput?.value.trim() ? Number.parseFloat(maxInput.value) : undefined;
      const filter: TradeStatFilter = { id: checkbox.value };
      const alternativeIds = (checkbox.dataset.alternativeIds ?? "").split(",").filter(Boolean);
      if (alternativeIds.length) filter.alternativeIds = alternativeIds;
      if (typeof min === "number" && Number.isFinite(min)) filter.min = min;
      if (typeof max === "number" && Number.isFinite(max)) filter.max = max;
      return [filter];
    });
}

function rarityTradeValue(rarity: string | undefined): string | undefined {
  const values: Record<string, string> = {
    normal: "normal", magic: "magic", rare: "rare", unique: "unique",
    normaler: "normal", magisch: "magic", selten: "rare", einzigartig: "unique",
  };
  return rarity ? values[rarity.toLocaleLowerCase()] : undefined;
}

function rangeFilterRow(key: string, label: string, value: number, checked: boolean): string {
  return `<label class="item-filter-row" data-item-filter="${key}">
    <input type="checkbox" ${checked ? "checked" : ""} />
    <span>${escapeHtml(label)}</span>
    <span class="item-filter-controls range-controls">
      <span>Min</span><input type="number" step="any" data-bound="min" value="${value}" />
      <span>Max</span><input type="number" step="any" data-bound="max" placeholder="∞" />
    </span>
  </label>`;
}

function renderItemFilters(item: ParsedItem): void {
  setHidden("item-filter-panel", item.isMercenaryWarrant);
  if (item.isMercenaryWarrant) return;
  const rows: string[] = [];
  const unique = item.rarity?.toLocaleLowerCase() === "unique";
  if (unique && item.name) {
    rows.push(`<label class="item-filter-row" data-item-filter="name">
      <input type="checkbox" checked /><span>${t("uniqueName")}</span>
      <span class="item-filter-value">${escapeHtml(item.name)}</span>
    </label>`);
  }
  if (item.baseType) {
    rows.push(`<label class="item-filter-row" data-item-filter="baseType">
      <input type="checkbox" checked /><span>${t("baseType")}</span>
      <span class="item-filter-value">${escapeHtml(item.baseType)}</span>
    </label>`);
  }
  const rarity = rarityTradeValue(item.rarity);
  if (rarity) {
    rows.push(`<label class="item-filter-row" data-item-filter="rarity">
      <input type="checkbox" checked /><span>${t("rarity")}</span>
      <select><option value="${rarity}">${escapeHtml(item.rarity ?? rarity)}</option></select>
    </label>`);
  }
  if (item.synthesised) {
    rows.push(`<label class="item-filter-row" data-item-filter="synthesised">
      <input type="checkbox" checked /><span>Synthesised</span><span class="item-filter-value">${t("yes")}</span>
    </label>`);
  }
  for (const influence of item.influences ?? []) {
    rows.push(`<label class="item-filter-row" data-item-filter="influence-${influence}" data-influence="${influence}">
      <input type="checkbox" checked /><span>Influence</span>
      <span class="item-filter-value">${influenceDisplayNames[influence]}</span>
    </label>`);
  }
  if (item.itemLevel !== undefined) rows.push(rangeFilterRow("itemLevel", t("itemLevel"), item.itemLevel, false));
  if (item.quality !== undefined) rows.push(rangeFilterRow("quality", t("quality"), item.quality, item.quality >= 20));
  if (item.sockets !== undefined) rows.push(rangeFilterRow("sockets", t("sockets"), item.sockets, false));
  if (item.links !== undefined) rows.push(rangeFilterRow("links", t("links"), item.links, item.links >= 5));
  rows.push(`<label class="item-filter-row" data-item-filter="corrupted">
    <input type="checkbox" ${item.corrupted ? "checked" : ""} /><span>Corrupted</span>
    <select><option value="false" ${item.corrupted ? "" : "selected"}>${t("no")}</option><option value="true" ${item.corrupted ? "selected" : ""}>${t("yes")}</option></select>
  </label>`);
  if (/^Foulborn\s+/i.test(item.name ?? "")) {
    rows.push(`<label class="item-filter-row" data-item-filter="foulborn">
      <input type="checkbox" checked /><span>Foulborn</span><span class="item-filter-value">${t("yes")}</span>
    </label>`);
  }
  $("item-filter-list").innerHTML = rows.join("");
}

function selectedItemFilters(): ItemSearchFilters {
  const row = (key: string) => document.querySelector<HTMLElement>(`[data-item-filter="${key}"]`);
  const enabled = (key: string) => row(key)?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked ?? false;
  const range = (key: string) => {
    const target = row(key);
    if (!target || !enabled(key)) return undefined;
    const minText = target.querySelector<HTMLInputElement>('input[data-bound="min"]')?.value.trim();
    const maxText = target.querySelector<HTMLInputElement>('input[data-bound="max"]')?.value.trim();
    const result: { min?: number; max?: number } = {};
    if (minText && Number.isFinite(Number.parseFloat(minText))) result.min = Number.parseFloat(minText);
    if (maxText && Number.isFinite(Number.parseFloat(maxText))) result.max = Number.parseFloat(maxText);
    return result;
  };
  const filters: ItemSearchFilters = { useName: enabled("name"), useBaseType: enabled("baseType") };
  const rarity = row("rarity")?.querySelector<HTMLSelectElement>("select")?.value;
  if (enabled("rarity") && rarity) filters.rarity = rarity;
  const itemLevel = range("itemLevel"); if (itemLevel) filters.itemLevel = itemLevel;
  const quality = range("quality"); if (quality) filters.quality = quality;
  const sockets = range("sockets"); if (sockets) filters.sockets = sockets;
  const links = range("links"); if (links) filters.links = links;
  const corrupted = row("corrupted")?.querySelector<HTMLSelectElement>("select")?.value;
  if (enabled("corrupted") && corrupted) filters.corrupted = corrupted === "true";
  if (enabled("foulborn")) filters.foulborn = true;
  if (enabled("synthesised")) filters.synthesised = true;
  const influences = Array.from(document.querySelectorAll<HTMLElement>("[data-influence]"))
    .filter((target) => target.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked)
    .flatMap((target) => {
      const influence = target.dataset.influence as ItemInfluence | undefined;
      return influence && influence in influenceDisplayNames ? [influence] : [];
    });
  if (influences.length) filters.influences = influences;
  return filters;
}

function renderItem(item: ParsedItem): void {
  currentItem = item;
  currentSearch = undefined;
  selectedStatIds.clear();
  $("modifier-list").innerHTML = "";
  setHidden("results-panel", true);
  const hasIdentity = Boolean(item.baseType || item.itemClass || item.build);
  setHidden("intro-panel", hasIdentity);
  setHidden("empty-state", hasIdentity);
  setHidden("item-panel", !hasIdentity);
  setHidden("actions", !hasIdentity);
  setHidden("mercenary-panel", !item.isMercenaryWarrant);
  const searchButton = $("search-button") as HTMLButtonElement;
  searchButton.textContent = item.isMercenaryWarrant ? t("warrantPriceCheck") : t("priceCheck");
  setSearchStatus(item.isMercenaryWarrant ? t("selectSkills") : t("preparingItem"), "idle");
  if (item.isMercenaryWarrant) void ensureMercenaryCatalog().then(renderDetectedMercenarySkills);
  if (!hasIdentity) {
    $("empty-state").textContent = item.warnings[0] ? localizeBackendMessage(item.warnings[0]) : t("empty");
    return;
  }

  $("item-name").textContent = item.build ?? item.name ?? item.baseType ?? item.itemClass ?? "PoE Item";
  $("item-meta").textContent = [
    item.mercenaryName ?? item.baseType ?? item.itemClass,
    item.mercenaryLevel ? `Mercenary Level ${item.mercenaryLevel}` : undefined,
    item.itemLevel ? `Item Level ${item.itemLevel}` : undefined,
    item.influences?.map((influence) => influenceDisplayNames[influence]).join(" + "),
  ].filter(Boolean).join(" · ");
  $("item-badge").textContent = item.isMercenaryWarrant ? "WARRANT" : (item.rarity ?? "ITEM").toUpperCase();
  $("raw-item").textContent = item.raw;
  $("item-warnings").innerHTML = item.warnings.map((warning) => `<div>${escapeHtml(localizeBackendMessage(warning))}</div>`).join("");
  renderItemFilters(item);
  setHidden("modifier-panel", true);
  updateSelectionSummary();
}

const pseudoNames: Record<string, string> = {
  "pseudo.pseudo_total_elemental_resistance": "Total Elemental Resistance",
  "pseudo.pseudo_total_fire_resistance": "Total Fire Resistance",
  "pseudo.pseudo_total_cold_resistance": "Total Cold Resistance",
  "pseudo.pseudo_total_lightning_resistance": "Total Lightning Resistance",
  "pseudo.pseudo_total_chaos_resistance": "Total Chaos Resistance",
  "pseudo.pseudo_total_life": "Total Maximum Life",
  "pseudo.pseudo_total_mana": "Total Maximum Mana",
  "pseudo.pseudo_total_strength": "Total Strength",
  "pseudo.pseudo_total_dexterity": "Total Dexterity",
  "pseudo.pseudo_total_intelligence": "Total Intelligence",
};

function pseudoDisplayName(match: TradeStatMatch): string {
  const name = pseudoNames[match.id] ?? match.label.replace(/[+#%]/g, "").trim();
  return getLanguage() === "de" ? name.replace(/\btotal\b/i, "Gesamt") : name;
}

function currentStatValue(match: TradeStatMatch): string {
  if (match.numericValue === undefined) return "";
  const value = match.numericValue.toLocaleString(locale(), { maximumFractionDigits: 2 });
  return `${value}${match.label.includes("%") ? "%" : ""}`;
}

function renderModifierMatch(match: TradeStatMatch): string {
  const range = match.numericValue === undefined ? undefined : defaultStatRange(match);
  if (match.unmatched) {
    return `<div class="modifier-option unmatched-mod">
      <input type="checkbox" disabled />
      <span class="modifier-text"><span>${escapeHtml(match.raw)}</span><small>${t("unmatchedHint")}</small></span>
      <span class="modifier-unmatched">${t("unmatched")}</span>
    </div>`;
  }

  const isPseudo = match.kind === "pseudo";
  const generation = match.generation === "prefix" ? "PREFIX" : match.generation === "suffix" ? "SUFFIX" : undefined;
  const typeLabel = [generation, match.kind === "crafted" ? "CRAFTED" : undefined, match.tier ? `TIER ${match.tier}` : undefined]
    .filter(Boolean).join(" · ");
  const affix = match.affixName ? `<span class="modifier-affix">${escapeHtml(match.affixName)}</span>` : "";
  const roll = match.rollMin !== undefined || match.rollMax !== undefined
    ? `<span class="modifier-roll">${t("naturalRoll", { min: match.rollMin ?? "?", max: match.rollMax ?? "?" })}</span>` : "";
  const title = isPseudo ? pseudoDisplayName(match) : match.raw;
  const detail = isPseudo
    ? `<span class="calculated-value">${t("calculatedValue")} <strong>${escapeHtml(currentStatValue(match))}</strong></span>`
    : `${escapeHtml(typeLabel)} ${affix} ${roll}`;
  return `
    <label class="modifier-option ${isPseudo ? "pseudo-option" : "direct-option"}">
      <input type="checkbox" value="${escapeHtml(match.id)}" data-alternative-ids="${escapeHtml((match.alternativeIds ?? []).join(","))}" data-conflicts="${escapeHtml((match.conflictKeys ?? []).join(","))}" data-recommended="${match.recommended === false ? "false" : "true"}" ${match.recommended === false ? "" : "checked"} />
      <span class="modifier-text"><span>${escapeHtml(title)}</span><small>${detail}</small></span>
      ${range ? `<span class="modifier-range">
        <span>Min</span><input type="number" step="any" data-bound="min" value="${range.min ?? ""}" placeholder="—" />
        <span>Max</span><input type="number" step="any" data-bound="max" value="${range.max ?? ""}" placeholder="—" />
      </span>` : `<span class="modifier-range muted">${t("noNumericRange")}</span>`}
    </label>`;
}

async function loadModifierMatches(item: ParsedItem, generation: number): Promise<boolean> {
  selectedStatIds.clear();
  if (item.modifiers.length === 0 || item.isMercenaryWarrant) return generation === itemGeneration;
  const matches: TradeStatMatch[] = await window.poeTrade.matchItemModifiers(item);
  if (generation !== itemGeneration) return false;
  for (const match of matches) if (!match.unmatched && match.recommended !== false) selectedStatIds.add(match.id);
  setHidden("modifier-panel", matches.length === 0);
  const recommended = matches.filter((match) => !match.unmatched && match.recommended !== false);
  const additional = matches.filter((match) => match.unmatched || match.recommended === false);
  $("modifier-list").innerHTML = `<section class="modifier-group compact-filter-group">
    <div class="modifier-group-heading"><strong>${t("searchFilters")}</strong><span>${t("recommendedCount", { count: recommended.length })}</span></div>
    ${recommended.map(renderModifierMatch).join("")}
    ${additional.length ? `<button id="more-filters" class="more-filters" type="button">${t("moreFilters", { count: additional.length })}</button>
      <div id="additional-filters" class="additional-filters hidden">${additional.map(renderModifierMatch).join("")}</div>` : ""}
  </section>`;
  const moreButton = document.getElementById("more-filters") as HTMLButtonElement | null;
  moreButton?.addEventListener("click", () => {
    const additionalFilters = document.getElementById("additional-filters");
    if (!additionalFilters) return;
    const willShow = additionalFilters.classList.contains("hidden");
    additionalFilters.classList.toggle("hidden", !willShow);
    moreButton.textContent = willShow ? t("hideAdditional") : t("moreFilters", { count: additional.length });
  });
  updateSelectionSummary();
  return true;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char] ?? char);
}

function normalizedSupportCatalogName(name: string, tier: number): string {
  return `${name} (Tier ${tier})`.toLocaleLowerCase();
}

function renderDetectedMercenarySkills(): void {
  const target = $("detected-mercenary-skills");
  const manual = $("manual-mercenary-filter");
  const skills = currentItem?.mercenarySkills;
  if (!skills?.length || !mercenaryCatalog) {
    setHidden("detected-mercenary-skills", true);
    manual.classList.remove("hidden");
    return;
  }
  const skillByName = new Map(mercenaryCatalog.skills.map((entry) => [entry.name.toLocaleLowerCase(), entry]));
  const supportByName = new Map(mercenaryCatalog.supports.map((entry) => [entry.name.toLocaleLowerCase().replace("tier:", "tier"), entry]));
  const recommendedIndexes = new Set(skills
    .map((skill, index) => ({ index, supportCount: skill.supports.length }))
    .sort((left, right) => right.supportCount - left.supportCount)
    .slice(0, Math.min(2, skills.length))
    .map(({ index }) => index));
  const rows = skills.map((skill, skillIndex) => {
    const skillEntry = skillByName.get(skill.name.toLocaleLowerCase());
    const supports = skill.supports.map((support) => ({
      source: support,
      entry: supportByName.get(normalizedSupportCatalogName(support.name, support.tier)),
    }));
    return `<article class="detected-skill" data-skill-id="${escapeHtml(skillEntry?.id ?? "")}">
      <label class="detected-skill-title">
        <input class="detected-skill-checkbox" type="checkbox" ${skillEntry && recommendedIndexes.has(skillIndex) ? "checked" : ""} ${skillEntry ? "" : "disabled"} />
        <strong>${escapeHtml(skill.name)}</strong>
        ${skillEntry ? "" : `<span class="catalog-miss">${t("tradeIdMissing")}</span>`}
      </label>
      ${supports.length ? `<div class="detected-supports">${supports.map(({ source, entry }) => `
        <label title="${escapeHtml(t("supportFor", { skill: skill.name }))}">
          <input class="detected-support-checkbox" type="checkbox" value="${escapeHtml(entry?.id ?? "")}" ${entry ? "" : "disabled"} />
          <span>${escapeHtml(source.name)}</span><small>T${source.tier}</small>
        </label>`).join("")}</div>` : `<div class="detected-no-supports">${t("noSupports")}</div>`}
    </article>`;
  });
  target.innerHTML = `<div class="detected-summary">
    <strong>${t("skillsDetected", { count: skills.length })}</strong>
    <span class="detected-block-actions">
      <span class="active-mercenary-blocks">${t("blocksActive", { count: Math.min(2, skills.length), label: getLanguage() === "de" ? (Math.min(2, skills.length) === 1 ? "Suchblock" : "Suchblöcke") : (Math.min(2, skills.length) === 1 ? "search block" : "search blocks") })}</span>
      <button class="mini-button merc-block-all" type="button">${t("all")}</button>
      <button class="mini-button merc-block-none" type="button">${t("none")}</button>
    </span>
  </div>
  <div class="merc-search-hint">${t("mercenarySelectionHint")}</div>
  ${rows.join("")}`;
  target.dataset.skillCount = String(skills.length);
  target.classList.remove("hidden");
  manual.classList.add("hidden");
  updateSelectionSummary();
}

function selectedMercenaryFilters(): MercenaryFilter[] {
  if (!currentItem?.isMercenaryWarrant) return [];
  if (currentItem.mercenarySkills?.length && mercenaryCatalog) {
    return Array.from(document.querySelectorAll<HTMLElement>(".detected-skill"))
      .flatMap((row) => {
        const enabled = row.querySelector<HTMLInputElement>(".detected-skill-checkbox")?.checked;
        const skillId = row.dataset.skillId;
        if (!enabled || !skillId) return [];
        const supportIds = Array.from(row.querySelectorAll<HTMLInputElement>(".detected-support-checkbox:checked"))
          .map((input) => input.value).filter(Boolean);
        const skillName = row.querySelector("strong")?.textContent ?? skillId;
        return [{ skillId, skillName, supportIds }];
      });
  }
  const select = $("merc-skill") as HTMLSelectElement;
  const option = select.selectedOptions[0];
  if (!option) return [];
  const supportIds = Array.from(selectedSupportIds);
  return [{ skillId: select.value, skillName: option.textContent ?? select.value, supportIds }];
}

function updateMercenaryBlockSummary(): void {
  const summary = document.querySelector<HTMLElement>(".active-mercenary-blocks");
  if (!summary) return;
  const count = document.querySelectorAll(".detected-skill-checkbox:checked").length;
  summary.textContent = t("blocksActive", { count, label: getLanguage() === "de" ? (count === 1 ? "Suchblock" : "Suchblöcke") : (count === 1 ? "search block" : "search blocks") });
  updateSelectionSummary();
}

function renderSupports(): void {
  const query = ($("support-search") as HTMLInputElement).value.trim().toLocaleLowerCase();
  const available = mercenaryCatalog?.supports ?? fallbackSupports.map(([id, name]) => ({ id, name }));
  const filtered = available.filter((entry) => !query || entry.name.toLocaleLowerCase().includes(query));
  $("support-list").innerHTML = filtered.map(({ id, name }) => `
    <label class="support-option">
      <input type="checkbox" value="${id}" ${selectedSupportIds.has(id) ? "checked" : ""} />
      <span>${escapeHtml(name)}</span>
    </label>
  `).join("");
}

async function ensureMercenaryCatalog(): Promise<void> {
  if (mercenaryCatalog) return;
  const skillSelect = $("merc-skill") as HTMLSelectElement;
  try {
    mercenaryCatalog = await window.poeTrade.getMercenaryCatalog();
    skillSelect.innerHTML = mercenaryCatalog.skills
      .map((entry) => `<option value="${entry.id}">${escapeHtml(entry.name)}</option>`)
      .join("");
    const preferredSkill = mercenaryCatalog.skills.find((entry) => entry.name === "Ice Shot");
    if (preferredSkill) skillSelect.value = preferredSkill.id;
    renderSupports();
    renderDetectedMercenarySkills();
  } catch (error) {
    skillSelect.innerHTML = `
      <option value="mercenary.skill_11495">Ice Shot</option>
      <option value="mercenary.skill_16381">Vaal Ice Shot</option>
    `;
    setSearchStatus(t("catalogUnavailable", { error: errorMessage(error) }), "error");
    renderSupports();
    renderDetectedMercenarySkills();
  }
}

function renderResults(response: SearchResponse): void {
  currentSearch = response;
  setHidden("results-panel", false);
  $("results-panel").classList.remove("results-stale");
  const tradeButton = $("open-trade-button") as HTMLButtonElement;
  tradeButton.textContent = t("fullOfficial");
  tradeButton.title = t("fullOfficialTitle");
  $("result-summary").textContent = t("resultsSummary", { total: response.total.toLocaleString(locale()), loaded: response.results.length });
  $("results").innerHTML = response.results.length === 0
    ? `<div class="empty-result">${t("noListings")}</div>`
    : response.results.map((result) => `
      <article class="result-card">
        <div class="result-top">
          <strong>${result.price ? escapeHtml(formatPrice(result.price.amount, result.price.currency)) : t("noPrice")}</strong>
          <span>${escapeHtml(result.build ?? "")}${result.mercenaryLevel ? ` · Lvl ${result.mercenaryLevel}` : ""}</span>
        </div>
        ${result.skills.length ? `<div class="skills">${result.skills.map((skill) => `<div>${escapeHtml(skill)}</div>`).join("")}</div>` : ""}
      </article>
    `).join("");
}

async function readClipboard(): Promise<void> {
  try {
    await handleHotkey(await window.poeTrade.getClipboardItem());
  } catch (error) {
    setSearchStatus(errorMessage(error), "error");
  }
}

async function runSearch(generation = itemGeneration): Promise<void> {
  if (!currentItem) return;
  const item = currentItem;
  const statFilters = selectedTradeStatFilters();
  const itemFilters = selectedItemFilters();
  const button = $("search-button") as HTMLButtonElement;
  const normalLabel = item.isMercenaryWarrant ? t("warrantPriceCheck") : t("priceCheck");
  const mercenaryFilters = selectedMercenaryFilters();
  if (item.isMercenaryWarrant && mercenaryFilters.length === 0) {
    setSearchStatus(t("requireSkill"), "error");
    return;
  }
  button.disabled = true;
  button.textContent = t("searching");
  setSearchStatus(t("loadingListings"), "searching");
  try {
    const league = ($("league") as HTMLSelectElement).value;
    const response = await window.poeTrade.searchTrade({
      league,
      item,
      itemFilters,
      ...(mercenaryFilters.length ? { mercenaryFilters } : {}),
      ...(!mercenaryFilters.length && statFilters.length ? { statFilters } : {}),
    });
    if (generation !== itemGeneration) return;
    renderResults(response);
    setSearchStatus(response.notice ? localizeBackendMessage(response.notice) : (response.total === 0 && statFilters.length > 1
      ? t("zeroFilters", { count: statFilters.length })
      : t("completed")), "success");
  } catch (error) {
    if (generation !== itemGeneration) return;
    setSearchStatus(errorMessage(error), "error");
  } finally {
    if (generation === itemGeneration) {
      button.disabled = false;
      button.textContent = normalLabel;
    }
  }
}

async function handleHotkey(item: ParsedItem): Promise<void> {
  const generation = ++itemGeneration;
  renderItem(item);
  if (!item.baseType && !item.itemClass) return;
  try {
    if (item.isMercenaryWarrant) {
      await ensureMercenaryCatalog();
      if (generation !== itemGeneration) return;
      renderDetectedMercenarySkills();
    }
    if (!await loadModifierMatches(item, generation)) return;
    if (!item.isMercenaryWarrant) await runSearch(generation);
  } catch (error) {
    if (generation !== itemGeneration) return;
    setSearchStatus(errorMessage(error), "error");
  }
}

async function refreshLocalizedView(): Promise<void> {
  applyStaticTranslations();
  renderSupports();
  if (!currentItem) return;
  const item = currentItem;
  const previousSearch = currentSearch;
  const generation = ++itemGeneration;
  renderItem(item);
  if (item.isMercenaryWarrant) {
    await ensureMercenaryCatalog();
    if (generation !== itemGeneration) return;
    renderDetectedMercenarySkills();
  }
  if (!await loadModifierMatches(item, generation)) return;
  if (previousSearch) renderResults(previousSearch);
}

function saveCurrentSettings(): void {
  const league = ($("league") as HTMLSelectElement).value;
  void window.poeTrade.saveSettings({ league, hotkey: "Alt+D", language: getLanguage() });
}

applyStaticTranslations();
renderSupports();
window.poeTrade.onHotkey((item) => void handleHotkey(item));
window.poeTrade.onUpdateState(renderUpdateState);
$("read-button").addEventListener("click", () => void readClipboard());
$("search-button").addEventListener("click", () => void runSearch());
$("hide-button").addEventListener("click", () => void window.poeTrade.hideWindow());
$("quit-button").addEventListener("click", () => void window.poeTrade.hideWindow());
$("update-button").addEventListener("click", () => {
  if (currentUpdateState.status === "ready") void window.poeTrade.installUpdate();
  else void window.poeTrade.checkForUpdates().then(renderUpdateState);
});
$("open-trade-button").addEventListener("click", () => {
  if (currentSearch) void window.poeTrade.openExternal(currentSearch.tradeUrl);
});
$("support-search").addEventListener("input", renderSupports);
$("support-list").addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.type !== "checkbox") return;
  if (input.checked) selectedSupportIds.add(input.value);
  else selectedSupportIds.delete(input.value);
  markSearchDirty();
});
$("detected-mercenary-skills").addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.type === "checkbox") {
    updateMercenaryBlockSummary();
    markSearchDirty();
  }
});
$("detected-mercenary-skills").addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  if (!target.classList.contains("merc-block-all") && !target.classList.contains("merc-block-none")) return;
  const checked = target.classList.contains("merc-block-all");
  document.querySelectorAll<HTMLInputElement>(".detected-skill-checkbox:not(:disabled)")
    .forEach((input) => { input.checked = checked; });
  updateMercenaryBlockSummary();
  markSearchDirty();
});
$("modifier-list").addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.type !== "checkbox") return;
  if (input.checked) {
    const conflicts = new Set((input.dataset.conflicts ?? "").split(",").filter(Boolean));
    if (conflicts.size) {
      document.querySelectorAll<HTMLInputElement>('.modifier-option input[type="checkbox"]:checked').forEach((other) => {
        if (other === input) return;
        const otherKeys = (other.dataset.conflicts ?? "").split(",").filter(Boolean);
        if (otherKeys.some((key) => conflicts.has(key))) {
          other.checked = false;
          selectedStatIds.delete(other.value);
        }
      });
    }
    selectedStatIds.add(input.value);
  } else selectedStatIds.delete(input.value);
  markSearchDirty();
});
$("mods-all").addEventListener("click", () => {
  document.querySelectorAll<HTMLInputElement>('.modifier-option input[type="checkbox"]:not(:disabled)').forEach((input) => {
    input.checked = input.dataset.recommended === "true";
    if (input.checked) selectedStatIds.add(input.value);
    else selectedStatIds.delete(input.value);
  });
  markSearchDirty();
});
$("mods-none").addEventListener("click", () => {
  document.querySelectorAll<HTMLInputElement>('.modifier-option input[type="checkbox"]:not(:disabled)').forEach((input) => {
    input.checked = false;
    selectedStatIds.delete(input.value);
  });
  markSearchDirty();
});
$("item-filter-list").addEventListener("input", markSearchDirty);
$("league").addEventListener("change", () => {
  saveCurrentSettings();
  markSearchDirty();
});
$("language").addEventListener("change", () => {
  const language = ($("language") as HTMLSelectElement).value as AppLanguage;
  setLanguage(language === "de" ? "de" : "en");
  saveCurrentSettings();
  void refreshLocalizedView();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") void window.poeTrade.hideWindow();
});

void window.poeTrade.getSettings().then((settings) => {
  setLanguage(settings.language === "de" ? "de" : "en");
  ($("language") as HTMLSelectElement).value = getLanguage();
  void refreshLocalizedView();
  const select = $("league") as HTMLSelectElement;
  void window.poeTrade.getLeagues().then((leagues) => {
    select.innerHTML = leagues.map((league) => `<option value="${escapeHtml(league.id)}">${escapeHtml(league.text)}</option>`).join("");
    select.value = leagues.some((league) => league.id === settings.league) ? settings.league : (leagues[0]?.id ?? "Standard");
  }).catch(() => {
    select.value = settings.league;
  });
});
