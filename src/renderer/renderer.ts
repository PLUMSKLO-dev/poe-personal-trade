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
let currentModifierMatches: TradeStatMatch[] = [];
let itemGeneration = 0;
const selectedSupportIds = new Set<string>();
const selectedStatIds = new Set<string>();
let currentUpdateState: UpdateState = { status: "idle" };
let searchCooldownUntil = 0;
let searchCooldownTimer: number | undefined;

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
  $("settings-button").title = t("settingsTitle");
  $("settings-button").setAttribute("aria-label", t("settingsTitle"));
  $("settings-heading").textContent = t("settings");
  $("intro-step-one").innerHTML = t("introOne");
  $("intro-step-two").innerHTML = t("introTwo");
  $("intro-safe").textContent = t("safe");
  $("league-label").textContent = t("league");
  $("language-label").textContent = t("language");
  $("read-button").title = t("readItemTitle");
  $("read-button").setAttribute("aria-label", t("readItemTitle"));
  $("empty-state").textContent = t("empty");
  $("raw-item-summary").title = t("rawItem");
  $("raw-item-summary").setAttribute("aria-label", t("rawItem"));
  $("raw-item-label").textContent = t("rawItem");
  $("item-options-label").title = t("itemOptions");
  $("item-options-label").setAttribute("aria-label", t("itemOptions"));
  $("item-options-label-text").textContent = t("itemOptions");
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
  if (searchCooldownUntil > Date.now()) updateSearchCooldown();
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

function positionItemPopover(menu: HTMLDetailsElement): void {
  const summary = menu.querySelector("summary");
  const popover = document.getElementById(`${menu.id}-popover`);
  if (!summary || !popover || !menu.open) return;

  // The item panel has clipped/scrolling ancestors. Render the popover at the
  // document root so it can use the full overlay window without being cropped.
  if (popover.parentElement !== document.body) document.body.append(popover);

  const anchor = summary.getBoundingClientRect();
  const margin = 8;
  const desiredWidth = menu.id === "item-filter-panel" ? 470 : 460;
  const width = Math.min(desiredWidth, window.innerWidth - margin * 2);
  const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin));
  popover.style.width = `${Math.max(240, width)}px`;
  popover.style.left = `${left}px`;
  popover.style.top = `${anchor.bottom + 6}px`;

  const bounds = popover.getBoundingClientRect();
  if (bounds.bottom > window.innerHeight - margin) {
    popover.style.top = `${Math.max(margin, window.innerHeight - bounds.height - margin)}px`;
  }
}

function restoreItemPopover(menu: HTMLDetailsElement): void {
  const popover = document.getElementById(`${menu.id}-popover`);
  if (popover && popover.parentElement === document.body) menu.append(popover);
}

function setSearchStatus(message: string, tone: "idle" | "searching" | "success" | "error" = "idle"): void {
  const status = $("search-status");
  status.textContent = message;
  status.title = message;
  status.dataset.tone = tone;
}

function updateSearchCooldown(): void {
  const remaining = Math.ceil((searchCooldownUntil - Date.now()) / 1_000);
  const button = $("search-button") as HTMLButtonElement;
  if (remaining <= 0) {
    searchCooldownUntil = 0;
    if (searchCooldownTimer !== undefined) window.clearInterval(searchCooldownTimer);
    searchCooldownTimer = undefined;
    button.disabled = false;
    button.textContent = currentItem?.isMercenaryWarrant ? t("warrantPriceCheck") : t("priceCheck");
    setSearchStatus(t("rateLimitReady"), "success");
    return;
  }
  button.disabled = true;
  button.textContent = t("rateLimitButton", { seconds: remaining });
  setSearchStatus(t("rateLimitCountdown", { seconds: remaining }), "error");
}

function startSearchCooldown(seconds: number): void {
  searchCooldownUntil = Date.now() + Math.max(seconds, 1) * 1_000;
  if (searchCooldownTimer !== undefined) window.clearInterval(searchCooldownTimer);
  updateSearchCooldown();
  searchCooldownTimer = window.setInterval(updateSearchCooldown, 1_000);
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

function formatBulkAmount(amount: number): string {
  return new Intl.NumberFormat(locale(), { maximumFractionDigits: 2 }).format(amount);
}

function formatBulkCurrency(currency: string): string {
  const names: Record<string, string> = { divine: "Divine", chaos: "Chaos" };
  return names[currency] ?? currency;
}

function formatRelativeTime(indexed?: string): string {
  if (!indexed) return "—";
  const timestamp = Date.parse(indexed);
  if (!Number.isFinite(timestamp)) return indexed;
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000], ["month", 2_592_000], ["day", 86_400], ["hour", 3_600], ["minute", 60],
  ];
  const formatter = new Intl.RelativeTimeFormat(locale(), { numeric: "auto", style: "short" });
  for (const [unit, unitSeconds] of units) {
    if (seconds >= unitSeconds) return formatter.format(-Math.floor(seconds / unitSeconds), unit);
  }
  return formatter.format(0, "second");
}

function renderBulkListings(response: SearchResponse): string {
  const listings = response.bulkListings ?? [];
  if (!listings.length) {
    return `<div class="empty-result">${escapeHtml(response.stackValue?.basisListings === 0 ? t("bulkFixedRatio") : t("bulkEmpty"))}</div>`;
  }

  const value = response.stackValue;
  const referenceListings = value ? listings.filter((entry) => entry.exchangeCurrency === value.currency) : [];
  const referenceAfter = Math.max(1, Math.ceil(referenceListings.length / 2));
  let referenceCount = 0;
  let referenceInserted = false;
  const rows: string[] = [];
  const referenceRow = () => `<tr class="bulk-reference-row">
    <td>${formatBulkAmount(value!.unitPrice)}</td>
    <td>${formatBulkAmount(value!.unitPrice)} ${escapeHtml(formatBulkCurrency(value!.currency))} / 1</td>
    <td colspan="3">${escapeHtml(t("bulkReference"))}</td>
  </tr>`;

  for (const listing of listings) {
    const unitPrice = listing.exchangeAmount / listing.itemAmount;
    rows.push(`<tr>
      <td>${formatBulkAmount(unitPrice)} ${escapeHtml(formatBulkCurrency(listing.exchangeCurrency))}</td>
      <td>${formatBulkAmount(listing.exchangeAmount)} / ${formatBulkAmount(listing.itemAmount)}</td>
      <td>${formatBulkAmount(listing.stock)}</td>
      <td>${formatBulkAmount(listing.fulfill)}</td>
      <td>${escapeHtml(formatRelativeTime(listing.indexed))}</td>
    </tr>`);
    if (value && listing.exchangeCurrency === value.currency) {
      referenceCount += 1;
      if (!referenceInserted && referenceCount >= referenceAfter) {
        rows.push(referenceRow());
        referenceInserted = true;
      }
    }
  }
  if (value && !referenceInserted) rows.push(referenceRow());

  return `<div class="bulk-listings-scroll"><table class="bulk-listings-table">
    <thead><tr>
      <th>${escapeHtml(t("bulkPrice"))}</th><th>${escapeHtml(t("bulkRate"))}</th>
      <th>${escapeHtml(t("bulkStock"))}</th><th>${escapeHtml(t("bulkFulfills"))}</th><th>${escapeHtml(t("bulkListed"))}</th>
    </tr></thead><tbody>${rows.join("")}</tbody>
  </table></div>`;
}

function renderStackValue(response: SearchResponse): string {
  const value = response.stackValue;
  if (!value) return "";
  const currency = formatBulkCurrency(value.currency);
  const estimateHint = value.basisListings
    ? t("bulkEstimateHint", { count: value.basisListings, currency })
    : t("bulkFixedRatio");
  return `<div class="stack-value-summary">
    <div><span>${escapeHtml(t("bulkOwnStack", { count: value.quantity }))}</span><strong>${formatBulkAmount(value.currentTotal)} ${escapeHtml(currency)}</strong></div>
    <div><span>${escapeHtml(t("bulkUnitPrice"))}</span><strong>${formatBulkAmount(value.unitPrice)} ${escapeHtml(currency)}</strong></div>
    <div><span>${escapeHtml(t("bulkFullStack", { count: value.maxStackSize }))}</span><strong>${formatBulkAmount(value.fullStackTotal)} ${escapeHtml(currency)}</strong></div>
    <small>${escapeHtml(estimateHint)}</small>
  </div>`;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return localizeBackendMessage(message.replace(/^Error invoking remote method '[^']+': Error:\s*/, ""));
}

function localizeBackendMessage(message: string): string {
  if (getLanguage() === "de") return message;
  return message
    .replace("PoE hat den kopierten Basistyp abgelehnt. Die Suche wurde ohne diesen einzelnen Filter wiederholt; bitte prüfe, ob die Treffer zum Item passen.", "PoE rejected the copied base type. The search was retried without this single filter; please verify that the listings match the item.")
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

function rangeFilterRow(key: string, label: string, value: number, checked: boolean, exact = false): string {
  return `<label class="item-filter-row" data-item-filter="${key}">
    <input type="checkbox" ${checked ? "checked" : ""} />
    <span>${escapeHtml(label)}</span>
    <span class="item-filter-controls range-controls">
      <span>Min</span><input type="number" step="any" data-bound="min" value="${value}" />
      <span>Max</span><input type="number" step="any" data-bound="max" placeholder="∞" ${exact ? `value="${value}"` : ""} />
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
      <input type="checkbox" checked /><span>${t(item.gem ? "gemName" : "baseType")}</span>
      <span class="item-filter-value">${escapeHtml(item.baseType)}</span>
    </label>`);
  }
  const rarity = rarityTradeValue(item.rarity);
  if (rarity && !item.gem) {
    const checked = !(rarity === "normal" && /^(Map Fragments|Kartenfragmente)$/i.test(item.itemClass ?? ""));
    rows.push(`<label class="item-filter-row" data-item-filter="rarity">
      <input type="checkbox" ${checked ? "checked" : ""} /><span>${t("rarity")}</span>
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
  if (item.itemLevel !== undefined && !item.gem) rows.push(rangeFilterRow("itemLevel", t("itemLevel"), item.itemLevel, false));
  if (item.gem?.level !== undefined) rows.push(rangeFilterRow("gemLevel", t("gemLevel"), item.gem.level, true, true));
  if (item.quality !== undefined || item.gem) rows.push(rangeFilterRow("quality", t("quality"), item.quality ?? 0, Boolean(item.gem) || (item.quality ?? 0) >= 20, Boolean(item.gem)));
  if (item.sockets !== undefined) rows.push(rangeFilterRow("sockets", t("sockets"), item.sockets, false));
  if (item.links !== undefined) rows.push(rangeFilterRow("links", t("links"), item.links, item.links >= 5));
  rows.push(`<label class="item-filter-row" data-item-filter="corrupted">
    <input type="checkbox" ${item.corrupted || item.gem ? "checked" : ""} /><span>Corrupted</span>
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
  const gemLevel = range("gemLevel"); if (gemLevel) filters.gemLevel = gemLevel;
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
  if (searchCooldownUntil > Date.now()) updateSearchCooldown();
  if (item.isMercenaryWarrant) void ensureMercenaryCatalog().then(renderDetectedMercenarySkills);
  if (!hasIdentity) {
    $("empty-state").textContent = item.warnings[0] ? localizeBackendMessage(item.warnings[0]) : t("empty");
    return;
  }

  $("item-name").textContent = item.build ?? item.name ?? item.baseType ?? item.itemClass ?? "PoE Item";
  $("item-meta").textContent = [
    item.mercenaryName ?? item.baseType ?? item.itemClass,
    item.mercenaryLevel ? `Mercenary Level ${item.mercenaryLevel}` : undefined,
    item.gem?.level !== undefined ? `${t("gemLevel")} ${item.gem.level}` : item.itemLevel ? `Item Level ${item.itemLevel}` : undefined,
    item.stackSize !== undefined ? `${t("stackSize")} ${item.stackSize}/${item.maxStackSize ?? item.stackSize}` : undefined,
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

function renderModifierMatch(match: TradeStatMatch, matchIndex = -1): string {
  const range = match.numericValue === undefined ? undefined : defaultStatRange(match);
  if (match.unmatched) {
    return `<div class="modifier-option unmatched-mod">
      <input type="checkbox" disabled />
      <span class="modifier-text"><span>${escapeHtml(match.raw)}</span><small>${t("unmatchedHint")}</small></span>
      <span class="modifier-unmatched">${t("unmatched")}</span>
      <div class="unmatched-mapping-controls" data-match-index="${matchIndex}">
        <button class="mini-button mapping-suggest" type="button" data-match-index="${matchIndex}">${t("learnMapping")}</button>
        <div class="mapping-editor hidden" data-mapping-editor="${matchIndex}"></div>
      </div>
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
    : `${escapeHtml(typeLabel)} ${affix} ${roll}${match.learned ? ` <span class="learned-mapping-badge">${t("learnedMappingBadge")}</span><button class="mini-button learned-forget" type="button" data-match-index="${matchIndex}">${t("forgetMapping")}</button>` : ""}`;
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
  currentModifierMatches = [];
  if (item.modifiers.length === 0 || item.isMercenaryWarrant) return generation === itemGeneration;
  const matches: TradeStatMatch[] = await window.poeTrade.matchItemModifiers(item);
  if (generation !== itemGeneration) return false;
  currentModifierMatches = matches;
  // Keep derived pseudo totals out of the simple price-check flow. Exact item
  // modifiers stay available, avoiding a second layer of redundant filters.
  const itemMatches = matches.filter((match) => match.kind !== "pseudo");
  for (const match of itemMatches) if (!match.unmatched && match.recommended !== false) selectedStatIds.add(match.id);
  setHidden("modifier-panel", itemMatches.length === 0);
  const recommended = itemMatches.filter((match) => !match.unmatched && match.recommended !== false);
  const additional = itemMatches.filter((match) => !match.unmatched && match.recommended === false);
  const unmatched = matches.map((match, index) => ({ match, index })).filter(({ match }) => match.unmatched);
  const renderCategory = (title: string, className: string, primary: TradeStatMatch[], extra: TradeStatMatch[]) => {
    const count = primary.length + extra.length;
    if (!count) return "";
    return `<section class="modifier-category ${className}">
      <div class="modifier-category-heading"><strong>${title}</strong><span>${count}</span></div>
      ${[...primary, ...extra].map((match) => renderModifierMatch(match, currentModifierMatches.indexOf(match))).join("")}
    </section>`;
  };
  $("modifier-list").innerHTML = `<section class="modifier-group compact-filter-group">
    <div class="modifier-group-heading"><strong>${t("searchFilters")}</strong><span>${t("recommendedCount", { count: recommended.length })}</span></div>
    ${renderCategory(t("itemMods"), "item-mod-category", recommended, additional)}
    ${unmatched.length ? `<details class="unmatched-details"><summary>${t("unmatchedCount", { count: unmatched.length })}</summary><p>${t("unmatchedDescription")}</p>${unmatched.map(({ match, index }) => renderModifierMatch(match, index)).join("")}</details>` : ""}
  </section>`;
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
      ${supports.length ? `<div class="detected-support-heading">${t("supportsOnWarrant")} <span>${t("supportChecksNarrow")}</span></div>` : ""}
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
      <button class="mini-button merc-block-all" type="button">${t("allSkills")}</button>
      <button class="mini-button merc-block-none" type="button">${t("noSkills")}</button>
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
  $("result-summary").textContent = response.bulkListings
    ? t("bulkResultsSummary", { total: response.total.toLocaleString(locale()), loaded: response.bulkListings.length })
    : t("resultsSummary", { total: response.total.toLocaleString(locale()), loaded: response.results.length });
  $("results").innerHTML = response.bulkListings
    ? `${renderBulkListings(response)}${renderStackValue(response)}`
    : response.results.length === 0
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
  if (searchCooldownUntil > Date.now()) {
    updateSearchCooldown();
    return;
  }
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
    const message = errorMessage(error);
    const retrySeconds = message.match(/(?:Please wait|Bitte)\s+(\d+)\s+(?:seconds?|Sekunden)/i)?.[1];
    if (retrySeconds) startSearchCooldown(Number(retrySeconds));
    else setSearchStatus(message, "error");
  } finally {
    if (generation === itemGeneration) {
      if (searchCooldownUntil > Date.now()) updateSearchCooldown();
      else {
        button.disabled = false;
        button.textContent = normalLabel;
      }
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

async function findUnmatchedModifierMapping(button: HTMLButtonElement): Promise<void> {
  const index = Number(button.dataset.matchIndex);
  const match = currentModifierMatches[index];
  if (!match?.unmatched) return;
  const controls = button.closest<HTMLElement>(".unmatched-mapping-controls");
  const editor = controls?.querySelector<HTMLElement>(".mapping-editor");
  if (!controls || !editor) return;

  button.disabled = true;
  button.textContent = t("searchingMappings");
  editor.classList.remove("hidden");
  editor.textContent = t("searchingMappings");
  try {
    const kind = match.kind && match.kind !== "pseudo" ? match.kind : "unknown";
    const suggestions = await window.poeTrade.getTradeStatSuggestions(match.sourceLines ?? [match.raw], kind);
    if (!suggestions.length) {
      editor.textContent = t("noMappingSuggestions");
      button.classList.add("hidden");
      return;
    }
    const select = document.createElement("select");
    select.className = "learned-mapping-select";
    select.innerHTML = `<option value="">${escapeHtml(t("selectMapping"))}</option>${suggestions.map((entry) =>
      `<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.text.replace(/\n/g, " / "))}</option>`,
    ).join("")}`;
    const save = document.createElement("button");
    save.className = "mini-button mapping-save";
    save.type = "button";
    save.dataset.matchIndex = String(index);
    save.textContent = t("saveMapping");
    save.disabled = true;
    const status = document.createElement("span");
    status.className = "mapping-status";
    editor.replaceChildren(select, save, status);
    button.classList.add("hidden");
  } catch (error) {
    editor.textContent = errorMessage(error);
    button.disabled = false;
    button.textContent = t("learnMapping");
  }
}

async function saveUnmatchedModifierMapping(button: HTMLButtonElement): Promise<void> {
  const index = Number(button.dataset.matchIndex);
  const match = currentModifierMatches[index];
  if (!match?.unmatched) return;
  const editor = button.closest<HTMLElement>(".mapping-editor");
  const select = editor?.querySelector<HTMLSelectElement>(".learned-mapping-select");
  const status = editor?.querySelector<HTMLElement>(".mapping-status");
  if (!editor || !select || !status || !select.value) return;

  const item = currentItem;
  const generation = itemGeneration;
  const previouslySelected = new Set(selectedStatIds);
  button.disabled = true;
  status.textContent = t("savingMapping");
  try {
    await window.poeTrade.learnModifierMapping({
      lines: match.sourceLines ?? [match.raw],
      kind: match.kind && match.kind !== "pseudo" ? match.kind : "unknown",
      tradeStatId: select.value,
    });
    if (!item || currentItem !== item || itemGeneration !== generation) return;
    const learnedId = select.value;
    if (!await loadModifierMatches(item, generation)) return;
    selectedStatIds.clear();
    document.querySelectorAll<HTMLInputElement>('.modifier-option input[type="checkbox"]:not(:disabled)').forEach((input) => {
      input.checked = previouslySelected.has(input.value) || input.value === learnedId;
      if (input.checked) selectedStatIds.add(input.value);
    });
    updateSelectionSummary();
    markSearchDirty();
  } catch (error) {
    status.textContent = errorMessage(error);
    button.disabled = false;
  }
}

async function forgetLearnedModifierMapping(button: HTMLButtonElement): Promise<void> {
  const match = currentModifierMatches[Number(button.dataset.matchIndex)];
  if (!match?.learned || !match.kind || match.kind === "pseudo") return;
  const item = currentItem;
  const generation = itemGeneration;
  const previouslySelected = new Set(selectedStatIds);
  previouslySelected.delete(match.id);
  button.disabled = true;
  try {
    await window.poeTrade.forgetModifierMapping({
      lines: match.sourceLines ?? [match.raw],
      kind: match.kind,
    });
    if (!item || currentItem !== item || itemGeneration !== generation) return;
    if (!await loadModifierMatches(item, generation)) return;
    selectedStatIds.clear();
    document.querySelectorAll<HTMLInputElement>('.modifier-option input[type="checkbox"]:not(:disabled)').forEach((input) => {
      input.checked = previouslySelected.has(input.value);
      if (input.checked) selectedStatIds.add(input.value);
    });
    updateSelectionSummary();
    markSearchDirty();
  } catch (error) {
    button.disabled = false;
    button.title = errorMessage(error);
  }
}

applyStaticTranslations();
renderSupports();
window.poeTrade.onHotkey((item) => void handleHotkey(item));
window.poeTrade.onUpdateState(renderUpdateState);
$("read-button").addEventListener("click", () => void readClipboard());
document.addEventListener("click", (event) => {
  const settingsMenu = $("settings-menu") as HTMLDetailsElement;
  if (!settingsMenu.contains(event.target as Node)) settingsMenu.open = false;
  for (const id of ["item-filter-panel", "raw-item-details"]) {
    const menu = $(id) as HTMLDetailsElement;
    const popover = document.getElementById(`${menu.id}-popover`);
    if (!menu.contains(event.target as Node) && !popover?.contains(event.target as Node)) {
      menu.open = false;
      restoreItemPopover(menu);
    }
    else if (menu.open) requestAnimationFrame(() => positionItemPopover(menu));
  }
});
for (const id of ["item-filter-panel", "raw-item-details"]) {
  const menu = $(id) as HTMLDetailsElement;
  menu.addEventListener("toggle", () => {
    if (menu.open) requestAnimationFrame(() => positionItemPopover(menu));
    else restoreItemPopover(menu);
  });
}
window.addEventListener("resize", () => {
  for (const id of ["item-filter-panel", "raw-item-details"]) positionItemPopover($(id) as HTMLDetailsElement);
});
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
    if (input.classList.contains("allow-one-missing-support")) {
      updateMercenaryBlockSummary();
      markSearchDirty();
      return;
    }
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
  const target = event.target as HTMLElement;
  if (target.matches(".learned-mapping-select")) {
    const editor = target.closest<HTMLElement>(".mapping-editor");
    const save = editor?.querySelector<HTMLButtonElement>(".mapping-save");
    if (save) save.disabled = !(target as HTMLSelectElement).value;
    return;
  }
  const input = target as HTMLInputElement;
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
$("modifier-list").addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const findButton = target.closest<HTMLButtonElement>(".mapping-suggest");
  if (findButton) {
    void findUnmatchedModifierMapping(findButton);
    return;
  }
  const saveButton = target.closest<HTMLButtonElement>(".mapping-save");
  if (saveButton) void saveUnmatchedModifierMapping(saveButton);
  const forgetButton = target.closest<HTMLButtonElement>(".learned-forget");
  if (forgetButton) void forgetLearnedModifierMapping(forgetButton);
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
const leagueSelect = $("league") as HTMLSelectElement;
let preferredLeague: string | undefined;
let leagueRefreshPending = false;
async function refreshLeagues(): Promise<void> {
  if (leagueRefreshPending) return;
  leagueRefreshPending = true;
  try {
    const leagues = await window.poeTrade.getLeagues();
    if (!leagues.length) return;
    const current = leagueSelect.value;
    const preferred = preferredLeague ?? current;
    const options = leagues.map((league) => `<option value="${escapeHtml(league.id)}">${escapeHtml(league.text)}</option>`).join("");
    if (options !== leagueSelect.innerHTML) leagueSelect.innerHTML = options;
    leagueSelect.value = leagues.some((league) => league.id === preferred) ? preferred : leagues[0]!.id;
    if (leagueSelect.value !== current) markSearchDirty();
  } catch { /* Keep the current list when Trade is temporarily unavailable. */ }
  finally { leagueRefreshPending = false; }
}
leagueSelect.addEventListener("focus", () => void refreshLeagues());
leagueSelect.addEventListener("pointerdown", () => void refreshLeagues());
$("league").addEventListener("change", () => {
  preferredLeague = leagueSelect.value;
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
  preferredLeague ??= settings.league;
  if (Array.from(leagueSelect.options).some((option) => option.value === preferredLeague)) leagueSelect.value = preferredLeague;
  void refreshLeagues();
});
