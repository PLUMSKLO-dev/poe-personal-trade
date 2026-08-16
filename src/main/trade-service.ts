import type {
  MercenaryCatalog,
  NumericRange,
  SearchRequest,
  SearchResponse,
  TradeStatMatch,
  TradeStatFilter,
  TradeResult,
  ParsedItem,
  ParsedModifierBlock,
  TradeLeague,
  ItemInfluence,
} from "../shared/types";
import { generatedStatMatchers, statDirections } from "./stat-directions.generated";

const userAgent = "PoePersonalTrade/0.23.0 (https://github.com/PLUMSKLO-dev/poe-personal-trade)";

const influenceStatIds: Record<ItemInfluence, string> = {
  shaper: "pseudo.pseudo_has_shaper_influence",
  elder: "pseudo.pseudo_has_elder_influence",
  crusader: "pseudo.pseudo_has_crusader_influence",
  redeemer: "pseudo.pseudo_has_redeemer_influence",
  hunter: "pseudo.pseudo_has_hunter_influence",
  warlord: "pseudo.pseudo_has_warlord_influence",
};
const apiBase = "https://www.pathofexile.com/api/trade";

interface RateState {
  nextAllowedAt: number;
}

const rateState: RateState = { nextAllowedAt: 0 };
let catalogCache: MercenaryCatalog | undefined;
let statEntriesCache: Array<{ id: string; text: string; type: string }> | undefined;
let leaguesCache: TradeLeague[] | undefined;

const warrantCacheTtlMs = 5 * 60 * 1_000;
const warrantCacheMaxEntries = 100;

interface MemoryCacheEntry<T> {
  expiresAt: number;
  value: T;
}

export class BoundedMemoryCache<T> {
  private readonly entries = new Map<string, MemoryCacheEntry<T>>();

  constructor(
    private readonly maxEntries = warrantCacheMaxEntries,
    private readonly ttlMs = warrantCacheTtlMs,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh insertion order so the Map also acts as a small LRU cache.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
    this.entries.set(key, { expiresAt: this.now() + this.ttlMs, value });
  }

  clear(): void {
    this.entries.clear();
  }
}

interface TradeSearchData {
  id: string;
  total: number;
  result: string[];
}

const warrantSearchCache = new BoundedMemoryCache<TradeSearchData>();
const warrantOfferCache = new BoundedMemoryCache<TradeResult[]>();
const pendingWarrantSearches = new Map<string, Promise<TradeSearchData>>();
const pendingWarrantOffers = new Map<string, Promise<TradeResult[]>>();

class TradeQueryComplexityError extends Error {}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function rateLimitedFetch(url: string, init?: RequestInit): Promise<Response> {
  const waitFor = rateState.nextAllowedAt - Date.now();
  if (waitFor > 0) await sleep(waitFor);

  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": userAgent,
      ...(init?.headers ?? {}),
    },
  });

  // Keep short bursts serialized. A server-supplied Retry-After below always wins.
  rateState.nextAllowedAt = Date.now() + 300;
  if (response.status === 429) {
    const retrySeconds = Number.parseInt(response.headers.get("retry-after") ?? "10", 10);
    rateState.nextAllowedAt = Date.now() + Math.max(retrySeconds, 1) * 1_000;
    throw new Error(`GGG-Rate-Limit aktiv. Bitte ${Math.max(retrySeconds, 1)} Sekunden warten.`);
  }
  if (!response.ok) {
    const detail = await response.text();
    if (response.status === 400 && /query is too complex/i.test(detail)) {
      throw new TradeQueryComplexityError(detail);
    }
    throw new Error(`Trade-Anfrage fehlgeschlagen (${response.status}): ${detail.slice(0, 180)}`);
  }
  return response;
}

function makeFilter(filter: string | TradeStatFilter): Record<string, unknown> {
  const normalized = typeof filter === "string" ? { id: filter } : filter;
  const value: { min?: number; max?: number } = {};
  const min = typeof normalized.min === "number" && Number.isFinite(normalized.min) ? normalized.min : undefined;
  const max = typeof normalized.max === "number" && Number.isFinite(normalized.max) ? normalized.max : undefined;
  if (statDirections[normalized.id]?.inverted) {
    if (max !== undefined) value.min = -max;
    if (min !== undefined) value.max = -min;
  } else {
    if (min !== undefined) value.min = min;
    if (max !== undefined) value.max = max;
  }
  return { id: normalized.id, value, disabled: false };
}

function rangeValue(range: NumericRange): { min?: number; max?: number } {
  const value: { min?: number; max?: number } = {};
  if (typeof range.min === "number" && Number.isFinite(range.min)) value.min = range.min;
  if (typeof range.max === "number" && Number.isFinite(range.max)) value.max = range.max;
  return value;
}

export function makeQuery(request: SearchRequest): Record<string, unknown> {
  const itemFilters = request.itemFilters;
  const stats: Array<Record<string, unknown>> = [];
  const mercenaryFilters = request.mercenaryFilters?.length
    ? request.mercenaryFilters
    : request.mercenaryFilter ? [request.mercenaryFilter] : [];
  if (mercenaryFilters.length) {
    for (const mercenaryFilter of mercenaryFilters) {
      stats.push({
        type: "mercenary",
        filters: [
          makeFilter(mercenaryFilter.skillId),
          ...mercenaryFilter.supportIds.map(makeFilter),
        ],
      });
    }
  } else {
    const selectedFilters: TradeStatFilter[] = [
      ...(request.statFilters ?? (request.statIds ?? []).map((id) => ({ id }))),
      ...(!request.item.isMercenaryWarrant ? (itemFilters?.influences ?? []).flatMap((influence) => {
        const id = influenceStatIds[influence];
        return id ? [{ id }] : [];
      }) : []),
    ];
    stats.push({
      type: "and",
      filters: selectedFilters.filter((filter) => !filter.alternativeIds?.length).map(makeFilter),
    });
    for (const filter of selectedFilters.filter((candidate) => candidate.alternativeIds?.length)) {
      const ids = Array.from(new Set([filter.id, ...(filter.alternativeIds ?? [])]));
      const { alternativeIds: _alternativeIds, ...singleFilter } = filter;
      stats.push({
        type: "count",
        value: { min: 1 },
        filters: ids.map((id) => makeFilter({ ...singleFilter, id })),
      });
    }
  }

  const query: Record<string, unknown> = {
    // Official combined status: Instant Buyout and In Person.
    status: { option: "available" },
    stats,
  };

  if (request.item.isMercenaryWarrant) {
    // Mercenary stat groups already identify Warrants. Applying a Warrant
    // build/type or ordinary item filters here hides valid skill combinations.
    // Return immediately so stale item state can never add rarity, name,
    // Foulborn/mutated, item-level, socket, or other non-mercenary filters.
    return { query, sort: { price: "asc" } };
  }

  if ((itemFilters?.useBaseType ?? true) && request.item.baseType) {
    query.type = request.item.baseType;
  } else if (!itemFilters && request.item.itemClass) {
    query.type = request.item.itemClass;
  }
  if ((itemFilters?.useName ?? true) && request.item.rarity?.toLocaleLowerCase() === "unique" && request.item.name) {
    const foulbornMatch = /^Foulborn\s+(.+)$/i.exec(request.item.name);
    query.name = foulbornMatch?.[1] ?? request.item.name;
    if (foulbornMatch && (itemFilters?.foulborn ?? true)) {
      // PoE Trade stores the original unique name and represents Foulborn as
      // the separate official misc filter `mutated=true`.
      query.filters = {
        misc_filters: {
          filters: {
            mutated: { option: "true" },
          },
        },
      };
    }
  }

  const typeFilterValues: Record<string, unknown> = {};
  if (itemFilters?.rarity) typeFilterValues.rarity = { option: itemFilters.rarity };
  if (itemFilters?.itemLevel) typeFilterValues.ilvl = rangeValue(itemFilters.itemLevel);
  if (itemFilters?.quality) typeFilterValues.quality = rangeValue(itemFilters.quality);
  if (itemFilters?.sockets) typeFilterValues.sockets = rangeValue(itemFilters.sockets);
  if (itemFilters?.links) typeFilterValues.links = rangeValue(itemFilters.links);

  const miscFilterValues: Record<string, unknown> = {};
  if (itemFilters?.corrupted !== undefined) {
    miscFilterValues.corrupted = { option: String(itemFilters.corrupted) };
  }
  if (itemFilters?.foulborn && !(/^Foulborn\s+/i.test(request.item.name ?? ""))) {
    miscFilterValues.mutated = { option: "true" };
  }
  if (itemFilters?.synthesised) {
    miscFilterValues.synthesised_item = { option: "true" };
  }

  const existingFilters = (query.filters ?? {}) as Record<string, unknown>;
  if (Object.keys(typeFilterValues).length) {
    existingFilters.type_filters = { filters: typeFilterValues };
  }
  if (Object.keys(miscFilterValues).length) {
    const existingMisc = (existingFilters.misc_filters ?? { filters: {} }) as { filters: Record<string, unknown> };
    Object.assign(existingMisc.filters, miscFilterValues);
    existingFilters.misc_filters = existingMisc;
  }
  if (Object.keys(existingFilters).length) query.filters = existingFilters;

  return { query, sort: { price: "asc" } };
}

export function intersectResultIds(resultLists: string[][]): string[] {
  if (!resultLists.length) return [];
  const remaining = resultLists.slice(1).map((list) => new Set(list));
  return Array.from(new Set(resultLists[0])).filter((id) => remaining.every((ids) => ids.has(id)));
}

export function makeTradeUrl(request: SearchRequest): string {
  const query = encodeURIComponent(JSON.stringify(makeQuery(request)));
  return `https://www.pathofexile.com/trade/search/${encodeURIComponent(request.league)}?q=${query}`;
}

async function requestTradeSearch(league: string, body: Record<string, unknown>): Promise<TradeSearchData> {
  const response = await rateLimitedFetch(
    `${apiBase}/search/${encodeURIComponent(league)}`,
    { method: "POST", body: JSON.stringify(body) },
  );
  return (await response.json()) as TradeSearchData;
}

function warrantRequestKey(league: string, body: Record<string, unknown>): string {
  return `${league}\n${JSON.stringify(body)}`;
}

async function requestCachedWarrantSearch(
  league: string,
  body: Record<string, unknown>,
): Promise<TradeSearchData> {
  const key = warrantRequestKey(league, body);
  const cached = warrantSearchCache.get(key);
  if (cached) return cached;

  const pending = pendingWarrantSearches.get(key);
  if (pending) return pending;

  const request = requestTradeSearch(league, body)
    .then((data) => {
      warrantSearchCache.set(key, data);
      return data;
    })
    .finally(() => pendingWarrantSearches.delete(key));
  pendingWarrantSearches.set(key, request);
  return request;
}

async function fetchTradeResults(searchData: TradeSearchData, useWarrantCache: boolean): Promise<TradeResult[]> {
  const ids = searchData.result.slice(0, 10);
  if (!ids.length) return [];

  const load = async (): Promise<TradeResult[]> => {
    const fetchResponse = await rateLimitedFetch(
      `${apiBase}/fetch/${ids.join(",")}?query=${encodeURIComponent(searchData.id)}`,
    );
    const fetchData = (await fetchResponse.json()) as { result: any[] };
    return fetchData.result.filter(Boolean).map(mapResult);
  };
  if (!useWarrantCache) return load();

  const key = `${searchData.id}\n${ids.join(",")}`;
  const cached = warrantOfferCache.get(key);
  if (cached) return cached;

  const pending = pendingWarrantOffers.get(key);
  if (pending) return pending;

  const request = load()
    .then((results) => {
      warrantOfferCache.set(key, results);
      return results;
    })
    .finally(() => pendingWarrantOffers.delete(key));
  pendingWarrantOffers.set(key, request);
  return request;
}

export function clearWarrantMemoryCache(): void {
  warrantSearchCache.clear();
  warrantOfferCache.clear();
  pendingWarrantSearches.clear();
  pendingWarrantOffers.clear();
  rateState.nextAllowedAt = 0;
}

interface MercenaryBlockSearch {
  data: TradeSearchData;
  queryCount: number;
  partitioned: boolean;
}

async function searchMercenaryBlock(
  request: SearchRequest,
  mercenaryFilter: NonNullable<SearchRequest["mercenaryFilter"]>,
): Promise<MercenaryBlockSearch> {
  const { mercenaryFilter: _legacyFilter, ...requestWithoutLegacyFilter } = request;
  const singleRequest: SearchRequest = {
    ...requestWithoutLegacyFilter,
    mercenaryFilters: [mercenaryFilter],
  };
  try {
    return {
      data: await requestCachedWarrantSearch(request.league, makeQuery(singleRequest)),
      queryCount: 1,
      partitioned: false,
    };
  } catch (error) {
    if (!(error instanceof TradeQueryComplexityError) || mercenaryFilter.supportIds.length < 2) throw error;

    const middle = Math.ceil(mercenaryFilter.supportIds.length / 2);
    const leftFilter = { ...mercenaryFilter, supportIds: mercenaryFilter.supportIds.slice(0, middle) };
    const rightFilter = { ...mercenaryFilter, supportIds: mercenaryFilter.supportIds.slice(middle) };
    const left = await searchMercenaryBlock(request, leftFilter);
    await sleep(700);
    const right = await searchMercenaryBlock(request, rightFilter);
    const result = intersectResultIds([left.data.result, right.data.result]);
    return {
      data: { id: left.data.id, total: result.length, result },
      queryCount: left.queryCount + right.queryCount,
      partitioned: true,
    };
  }
}

function propertyValue(item: any, propertyName: string): string | undefined {
  const property = item?.properties?.find((entry: any) => entry?.name === propertyName);
  return property?.values?.[0]?.[0];
}

function mapResult(entry: any): TradeResult {
  const skills = Array.isArray(entry?.item?.mercenarySkills)
    ? entry.item.mercenarySkills.map((skill: any) => {
        const supports = Array.isArray(skill.supports)
          ? skill.supports.map((support: any) => `${support.name} ${support.tier}`).join(", ")
          : "";
        return supports ? `${skill.name}: ${supports}` : String(skill.name);
      })
    : [];
  const result: TradeResult = {
    id: String(entry.id),
    skills,
  };
  if (entry?.listing?.price) {
    result.price = {
      amount: Number(entry.listing.price.amount),
      currency: String(entry.listing.price.currency),
    };
  }
  if (entry?.listing?.account?.name) result.account = String(entry.listing.account.name);
  if (entry?.listing?.indexed) result.indexed = String(entry.listing.indexed);
  const build = propertyValue(entry.item, "Build");
  if (build) result.build = build;
  const level = Number.parseInt(propertyValue(entry.item, "Mercenary Level") ?? "", 10);
  if (Number.isFinite(level)) result.mercenaryLevel = level;
  return result;
}

export async function searchTrade(request: SearchRequest): Promise<SearchResponse> {
  if (!/^[A-Za-z0-9 _-]{1,80}$/.test(request.league)) {
    throw new Error("Ungültiger Liga-Name.");
  }
  const resolvedRequest = request;
  const mercenaryFilters = resolvedRequest.mercenaryFilters?.length
    ? resolvedRequest.mercenaryFilters
    : resolvedRequest.mercenaryFilter ? [resolvedRequest.mercenaryFilter] : [];
  let searchData: TradeSearchData;
  let intersectionNotice: string | undefined;
  let partitionedSupports = false;

  if (mercenaryFilters.length > 1) {
    try {
      // This is the same shape as the trade-site UI: one mercenary stats group
      // per skill, with that skill's supports inside the same group.
      searchData = await requestCachedWarrantSearch(request.league, makeQuery(resolvedRequest));
      intersectionNotice = `${mercenaryFilters.length} Mercenary-Blöcke wurden gemeinsam über die offizielle Suche ausgewertet.`;
    } catch (error) {
      if (!(error instanceof TradeQueryComplexityError)) throw error;
      // The anonymous API sometimes applies a lower complexity limit than a
      // logged-in browser. Preserve the exact AND semantics by intersecting
      // independent block searches only when the combined query is rejected.
      const ordered = [...mercenaryFilters].sort((left, right) => right.supportIds.length - left.supportIds.length);
      const searches: TradeSearchData[] = [];
      let queryCount = 0;
      for (const [filterIndex, mercenaryFilter] of ordered.entries()) {
        const blockSearch = await searchMercenaryBlock(resolvedRequest, mercenaryFilter);
        searches.push(blockSearch.data);
        queryCount += blockSearch.queryCount;
        partitionedSupports ||= blockSearch.partitioned;
        if (intersectResultIds(searches.map((search) => search.result)).length === 0) break;
        if (filterIndex < ordered.length - 1) await sleep(700);
      }
      const result = intersectResultIds(searches.map((search) => search.result));
      searchData = { id: searches[0]!.id, total: result.length, result };
      intersectionNotice = `PoE lehnte die kombinierte Suche als zu komplex ab; ${queryCount} Teilabfragen wurden deshalb lokal exakt geschnitten.`;
    }
  } else if (mercenaryFilters.length === 1) {
    const blockSearch = await searchMercenaryBlock(resolvedRequest, mercenaryFilters[0]!);
    searchData = blockSearch.data;
    partitionedSupports = blockSearch.partitioned;
  } else {
    searchData = await requestTradeSearch(request.league, makeQuery(resolvedRequest));
  }

  if (searchData.total === 0
    && request.item.isMercenaryWarrant
    && mercenaryFilters.some((filter) => filter.supportIds.length > 0)) {
    const skillsOnly = mercenaryFilters.map((filter) => ({ ...filter, supportIds: [] }));
    const { mercenaryFilter: _legacyFilter, ...requestWithoutLegacyFilter } = request;
    const relaxed = await searchTrade({
      ...requestWithoutLegacyFilter,
      mercenaryFilters: skillsOnly,
    });
    return {
      ...relaxed,
      notice: `Für die exakte Support-Kombination gab es 0 Treffer. Die Suche wurde automatisch mit denselben Skills ohne Support-Zwang wiederholt. ${relaxed.notice ?? ""}`.trim(),
    };
  }

  const results = await fetchTradeResults(searchData, request.item.isMercenaryWarrant);
  const searchNotice = intersectionNotice
    ? `${intersectionNotice}${partitionedSupports ? " Komplexe Support-Blöcke wurden automatisch aufgeteilt." : ""} Maximal zehn sichtbare Vergleichsangebote werden geladen.`
    : partitionedSupports
      ? "Der komplexe Support-Block wurde automatisch aufgeteilt und lokal exakt ausgewertet. Maximal zehn sichtbare Vergleichsangebote werden geladen."
      : "Nur manuell ausgelöste Suche; maximal zehn sichtbare Vergleichsangebote werden geladen.";

  return {
    queryId: searchData.id,
    total: searchData.total,
    tradeUrl: makeTradeUrl(resolvedRequest),
    results,
    notice: request.item.isMercenaryWarrant
      ? `${searchNotice} Identische Warrant-Abfragen werden fünf Minuten lang nur im Arbeitsspeicher wiederverwendet.`
      : searchNotice,
  };
}

export async function getMercenaryCatalog(): Promise<MercenaryCatalog> {
  if (catalogCache) return catalogCache;
  const entries = await getStatEntries();
  const unique = (prefix: string) => {
    const byId = new Map<string, string>();
    for (const entry of entries) {
      if (entry.type !== "mercenary" || !entry.id.startsWith(prefix)) continue;
      byId.set(entry.id, entry.text);
    }
    return Array.from(byId, ([id, name]) => ({ id, name }))
      .sort((left, right) => left.name.localeCompare(right.name, "en"));
  };
  catalogCache = {
    skills: unique("mercenary.skill_"),
    supports: unique("mercenary.support_"),
  };
  return catalogCache;
}

export async function getTradeLeagues(): Promise<TradeLeague[]> {
  if (leaguesCache) return leaguesCache;
  const response = await rateLimitedFetch(`${apiBase}/data/leagues`);
  const data = (await response.json()) as { result?: Array<{ id?: string; text?: string }> };
  const entries = (data.result ?? [])
    .filter((entry): entry is { id: string; text: string } => Boolean(entry.id && entry.text))
    .map((entry) => ({ id: entry.id, text: entry.text }));
  leaguesCache = Array.from(new Map(entries.map((entry) => [entry.id, entry])).values());
  return leaguesCache;
}

async function getStatEntries(): Promise<Array<{ id: string; text: string; type: string }>> {
  if (statEntriesCache) return statEntriesCache;
  const response = await rateLimitedFetch(`${apiBase}/data/stats`);
  const data = (await response.json()) as {
    result?: Array<{ entries?: Array<{ id?: string; text?: string; type?: string }> }>;
  };
  statEntriesCache = (data.result ?? [])
    .flatMap((group) => group.entries ?? [])
    .filter((entry): entry is { id: string; text: string; type: string } => Boolean(entry.id && entry.text && entry.type));
  return statEntriesCache;
}

function statPattern(template: string): RegExp {
  const token = "__NUMBER__";
  const escaped = template
    .replace(/#/g, token)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll(token, "[-+]?\\d+(?:[.,]\\d+)?")
    .replace(/\\n/g, "\\s+");
  return new RegExp(`^${escaped}$`, "i");
}

export function normalizeModifierText(raw: string): string {
  return raw
    // Advanced item descriptions insert the affix roll after the current value:
    // +131(121-150) to Armour -> +131 to Armour.
    .replace(/([-+]?\d+(?:[.,]\d+)?)\([-+]?\d+(?:[.,]\d+)?-[-+]?\d+(?:[.,]\d+)?\)/g, "$1")
    .replace(/\s+\((implicit|crafted|fractured|enchant|delve|scourge|imbued|veiled)\)$/i, "")
    .trim();
}

function stripTradeIdPrefix(id: string): string {
  return id.startsWith("{") ? id.slice(id.indexOf("}") + 1) : id;
}

function matchBlock(
  block: ParsedModifierBlock,
  entries: Array<{ id: string; text: string; type: string }>,
): { entry: { id: string; text: string; type: string }; numericValue?: number; alternativeIds?: string[]; better?: -1 | 0 | 1 } | undefined {
  const normalizedLines = block.lines.map(normalizeModifierText);
  const text = normalizedLines.join("\n");
  const exactType = block.kind === "unknown" ? undefined : block.kind;
  const kindOrder = exactType ? [exactType] : ["explicit", "implicit", "crafted", "fractured", "enchant", "delve", "scourge", "imbued", "veiled"];
  const generated = generatedStatMatchers.find((matcher) => {
    if (matcher.template.trim().split("\n").length !== normalizedLines.length) return false;
    if (!kindOrder.some((kind) => matcher.tradeIds[kind]?.length)) return false;
    return statPattern(matcher.template.trim()).test(text);
  });
  const generatedKind = generated && kindOrder.find((kind) => generated.tradeIds[kind]?.length);
  const generatedIds = generated && generatedKind
    ? generated.tradeIds[generatedKind]!.map(stripTradeIdPrefix)
    : [];
  const candidates = entries.filter((entry) => entry.text.split("\n").length === normalizedLines.length);
  const entry = generatedIds.length
    ? entries.find((candidate) => candidate.id === generatedIds[0]) ?? { id: generatedIds[0]!, text: generated!.template.trim(), type: generatedKind! }
    : candidates.find((candidate) => candidate.type === exactType && statPattern(candidate.text).test(text))
      ?? candidates.find((candidate) => statPattern(candidate.text).test(text));
  if (!entry) return undefined;
  const numericValues = Array.from(normalizedLines.join(" ").matchAll(/[-+]?\d+(?:[.,]\d+)?/g), (match) =>
    Number.parseFloat(match[0].replace(",", ".")),
  );
  const placeholders = ((generated?.template ?? entry.text).match(/#/g) ?? []).length;
  let numericValue = placeholders === 2 && numericValues.length >= 2 && /damage/i.test(entry.text)
    ? (numericValues[0]! + numericValues[1]!) / 2
    : numericValues[0];
  if (generated?.fixedValue !== undefined) numericValue = generated.fixedValue;
  if (generated?.negate && numericValue !== undefined) numericValue *= -1;
  return {
    entry,
    ...(typeof numericValue === "number" && Number.isFinite(numericValue) ? { numericValue } : {}),
    ...(generatedIds.length > 1 ? { alternativeIds: generatedIds.slice(1) } : {}),
    ...(generated ? { better: generated.better } : {}),
  };
}

function pseudoValues(blocks: ParsedModifierBlock[]): Map<string, number> {
  const totals = new Map<string, number>();
  const add = (key: string, value: number) => totals.set(key, (totals.get(key) ?? 0) + value);
  for (const block of blocks) {
    for (const original of block.lines) {
      const line = normalizeModifierText(original);
      const value = Number.parseFloat(line.match(/[-+]?\d+(?:[.,]\d+)?/)?.[0]?.replace(",", ".") ?? "NaN");
      if (!Number.isFinite(value)) continue;

      const elemental = /to all Elemental Resistances/i.test(line) ? ["fire", "cold", "lightning"]
        : /to All Resistances/i.test(line) ? ["fire", "cold", "lightning"]
          : ["fire", "cold", "lightning"].filter((element) => new RegExp(`\\b${element}\\b`, "i").test(line));
      if (/Resistance/i.test(line)) {
        for (const element of elemental) add(`res:${element}`, value);
        if (/Chaos Resistance|and Chaos Resistances|All Resistances/i.test(line)) add("res:chaos", value);
      }

      const attributes = /to all Attributes/i.test(line) ? ["strength", "dexterity", "intelligence"]
        : ["strength", "dexterity", "intelligence"].filter((attribute) => new RegExp(attribute, "i").test(line));
      if (/Attributes|Strength|Dexterity|Intelligence/i.test(line)) {
        for (const attribute of attributes) add(`attr:${attribute}`, value);
      }
      if (/to maximum Life/i.test(line)) add("life:flat", value);
      if (/to maximum Mana/i.test(line)) add("mana:flat", value);
    }
  }
  const ele = ["fire", "cold", "lightning"].reduce((sum, element) => sum + (totals.get(`res:${element}`) ?? 0), 0);
  if (ele) totals.set("res:elemental", ele);
  const life = (totals.get("life:flat") ?? 0) + (totals.get("attr:strength") ?? 0) * 0.5;
  const mana = (totals.get("mana:flat") ?? 0) + (totals.get("attr:intelligence") ?? 0) * 0.5;
  if (life) totals.set("life:total", life);
  if (mana) totals.set("mana:total", mana);
  return totals;
}

function createPseudoMatches(
  blocks: ParsedModifierBlock[],
  entries: Array<{ id: string; text: string; type: string }>,
): TradeStatMatch[] {
  const totals = pseudoValues(blocks);
  const definitions = [
    ["res:elemental", "+#% total Elemental Resistance", ["res:fire", "res:cold", "res:lightning"]],
    ["res:fire", "+#% total to Fire Resistance", ["res:fire"]],
    ["res:cold", "+#% total to Cold Resistance", ["res:cold"]],
    ["res:lightning", "+#% total to Lightning Resistance", ["res:lightning"]],
    ["res:chaos", "+#% total to Chaos Resistance", ["res:chaos"]],
    ["attr:strength", "+# total to Strength", ["attr:strength"]],
    ["attr:dexterity", "+# total to Dexterity", ["attr:dexterity"]],
    ["attr:intelligence", "+# total to Intelligence", ["attr:intelligence"]],
    ["life:total", "+# total maximum Life", ["life", "attr:strength"]],
    ["mana:total", "+# total maximum Mana", ["mana", "attr:intelligence"]],
  ] as const;
  return definitions.flatMap(([key, label, conflictKeys]) => {
    const value = totals.get(key);
    if (!value) return [];
    const entry = entries.find((candidate) => candidate.type === "pseudo" && candidate.text.toLocaleLowerCase() === label.toLocaleLowerCase());
    if (!entry) return [];
    return [{
      id: entry.id,
      label: entry.text,
      raw: `Berechnet aus den Item-Mods: ${value}`,
      numericValue: value,
      kind: "pseudo" as const,
      sourceLines: blocks.flatMap((block) => block.lines),
      recommended: key === "res:elemental" || key === "life:total",
      better: statDirections[entry.id]?.better ?? 1,
      conflictKeys: [...conflictKeys],
    }];
  });
}

function directConflictKeys(text: string): string[] {
  const keys: string[] = [];
  if (/maximum Life/i.test(text)) keys.push("life");
  if (/maximum Mana/i.test(text)) keys.push("mana");
  for (const element of ["fire", "cold", "lightning", "chaos"]) {
    const allElemental = element !== "chaos" && /all Elemental Resistances/i.test(text);
    if (/Resistance/i.test(text) && (new RegExp(`\\b${element}\\b`, "i").test(text) || allElemental || /All Resistances/i.test(text))) {
      keys.push(`res:${element}`);
    }
  }
  for (const attribute of ["strength", "dexterity", "intelligence"]) {
    if (new RegExp(attribute, "i").test(text) || /all Attributes/i.test(text)) keys.push(`attr:${attribute}`);
  }
  return keys;
}

export async function matchItemModifiers(item: ParsedItem | string[]): Promise<TradeStatMatch[]> {
  const entries = (await getStatEntries()).filter((entry) =>
    ["explicit", "implicit", "crafted", "fractured", "enchant", "delve", "scourge", "imbued", "veiled", "pseudo"].includes(entry.type),
  );
  const blocks: ParsedModifierBlock[] = Array.isArray(item)
    ? item.map((line) => ({ lines: [line], kind: "unknown", tags: [], rolls: [] }))
    : item.modifierBlocks;
  const direct: TradeStatMatch[] = [];
  const searchableEntries = entries.filter((entry) => entry.type !== "pseudo");
  const consumed = new Set<number>();
  for (const [index, originalBlock] of blocks.slice(0, 80).entries()) {
    if (consumed.has(index)) continue;
    let block = originalBlock;
    let matched = matchBlock(block, searchableEntries);
    if (!matched && block.lines.length === 1) {
      for (let count = 2; count <= 3 && index + count <= blocks.length; count += 1) {
        const group = blocks.slice(index, index + count);
        if (group.some((candidate) => candidate.lines.length !== 1 || candidate.kind !== block.kind)) break;
        const combined: ParsedModifierBlock = {
          ...block,
          lines: group.flatMap((candidate) => candidate.lines),
          rolls: group.flatMap((candidate) => candidate.rolls),
        };
        const combinedMatch = matchBlock(combined, searchableEntries);
        if (combinedMatch) {
          block = combined;
          matched = combinedMatch;
          for (let offset = 1; offset < count; offset += 1) consumed.add(index + offset);
          break;
        }
      }
    }
    if (!matched) {
      direct.push({
        id: `unmatched.${index}`,
        label: "Kein offizieller Trade-Stat gefunden",
        raw: block.lines.join(" / "),
        sourceLines: block.lines,
        kind: block.kind,
        ...(block.generation ? { generation: block.generation } : {}),
        ...(block.affixName ? { affixName: block.affixName } : {}),
        ...(block.tier !== undefined ? { tier: block.tier } : {}),
        unmatched: true,
      });
      continue;
    }
    const roll = block.rolls[0];
    direct.push({
      id: matched.entry.id,
      label: matched.entry.text.replace(/\n/g, " / "),
      raw: block.lines.join(" / "),
      sourceLines: block.lines,
      kind: block.kind,
      ...(block.generation ? { generation: block.generation } : {}),
      ...(block.affixName ? { affixName: block.affixName } : {}),
      ...(block.tier !== undefined ? { tier: block.tier } : {}),
      ...(matched.numericValue !== undefined ? { numericValue: matched.numericValue } : {}),
      ...(roll?.min !== undefined ? { rollMin: roll.min } : {}),
      ...(roll?.max !== undefined ? { rollMax: roll.max } : {}),
      better: matched.better ?? statDirections[matched.entry.id]?.better ?? 1,
      ...(matched.alternativeIds?.length ? { alternativeIds: matched.alternativeIds } : {}),
      conflictKeys: directConflictKeys(matched.entry.text),
      recommended: !Array.isArray(item) && item.rarity?.toLocaleLowerCase() === "unique"
        ? true
        : /Movement Speed/i.test(matched.entry.text),
    });
  }
  const pseudos = createPseudoMatches(blocks, entries);
  if (!Array.isArray(item) && item.rarity?.toLocaleLowerCase() === "unique") {
    for (const pseudo of pseudos) pseudo.recommended = false;
    const comparable = direct.filter((match) => !match.unmatched);
    // Unique modifiers define the exact variant (especially Watcher's Eye and
    // Foulborn items), so keep every successfully mapped mod visible/selectable.
    for (const match of comparable) match.recommended = true;
  }
  return [...pseudos, ...direct];
}
