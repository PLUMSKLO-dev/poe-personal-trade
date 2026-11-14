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
  ItemSearchFilters,
  BulkTradeListing,
  StackValue,
  LearnedModifierMapping,
  ModifierKind,
  TradeStatSuggestion,
} from "../shared/types";
import { generatedStatMatchers, statDirections } from "./stat-directions.generated";

const userAgent = "PoePersonalTrade/0.23.27 (https://github.com/PLUMSKLO-dev/poe-personal-trade)";

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
  blockedUntil: number;
}

const rateState: RateState = { nextAllowedAt: 0, blockedUntil: 0 };
let rateQueue: Promise<void> = Promise.resolve();
let catalogCache: MercenaryCatalog | undefined;
let catalogPending: Promise<MercenaryCatalog> | undefined;
let statEntriesCache: Array<{ id: string; text: string; type: string }> | undefined;
let statEntriesPending: Promise<Array<{ id: string; text: string; type: string }>> | undefined;
let leaguesCache: TradeLeague[] | undefined;
let leaguesCacheExpiresAt = 0;
let leaguesPending: Promise<TradeLeague[]> | undefined;
let exchangeStaticCache: Array<{ group: string; id: string; text: string }> | undefined;
let exchangeStaticCacheExpiresAt = 0;
let exchangeStaticPending: Promise<Array<{ group: string; id: string; text: string }>> | undefined;

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
  // Queue every endpoint request globally. A Promise queue avoids bursts when
  // independent Mercenary blocks or first-run catalog requests resolve together.
  const request = rateQueue.then(async () => {
    const cooldownRemaining = rateState.blockedUntil - Date.now();
    if (cooldownRemaining > 0) {
      throw new Error(`GGG-Rate-Limit aktiv. Bitte ${Math.ceil(cooldownRemaining / 1_000)} Sekunden warten.`);
    }
    rateState.blockedUntil = 0;
    const waitFor = rateState.nextAllowedAt - Date.now();
    if (waitFor > 0) await sleep(waitFor);
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": userAgent,
          ...(init?.headers ?? {}),
        },
      });
    } catch (error) {
      rateState.nextAllowedAt = Date.now() + 1_000;
      throw error;
    }
    rateState.nextAllowedAt = Date.now() + 1_000;
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      const numericSeconds = retryAfter ? Number(retryAfter) : Number.NaN;
      const retryAt = retryAfter && !Number.isFinite(numericSeconds) ? Date.parse(retryAfter) : Number.NaN;
      const retrySeconds = Math.max(1, Number.isFinite(numericSeconds)
        ? numericSeconds
        : Number.isFinite(retryAt) ? Math.ceil((retryAt - Date.now()) / 1_000) : 10);
      rateState.blockedUntil = Date.now() + retrySeconds * 1_000;
      rateState.nextAllowedAt = rateState.blockedUntil;
      throw new Error(`GGG-Rate-Limit aktiv. Bitte ${retrySeconds} Sekunden warten.`);
    }
    return response;
  });
  rateQueue = request.then(() => undefined, () => undefined);
  const response = await request;
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

type GemTradeType = { option: string; discriminator: string };
const germanTradeOrigin = "https://de.pathofexile.com";
const gemCatalog = new Map<string, { expiresAt: number; entries: Map<string, string | GemTradeType> }>();
const pendingGemCatalog = new Map<string, Promise<Map<string, string | GemTradeType>>>();

async function getGemCatalog(api: string): Promise<Map<string, string | GemTradeType>> {
  const cached = gemCatalog.get(api);
  if (cached && cached.expiresAt > Date.now()) return cached.entries;
  const pending = pendingGemCatalog.get(api);
  if (pending) return pending;
  const load = rateLimitedFetch(`${api}/data/items`).then(async (response) => {
    const data = await response.json() as { result?: Array<{
      id: string; entries?: Array<{ type?: string; text?: string; disc?: string }>;
    }> };
    const entries = new Map<string, string | GemTradeType>();
    for (const entry of data.result?.find((group) => group.id === "gem")?.entries ?? []) {
      if (!entry.type) continue;
      if (entry.disc && entry.text) {
        entries.set(normalizeExchangeName(entry.text), { option: entry.type, discriminator: entry.disc });
      } else if (!entry.disc) {
        entries.set(normalizeExchangeName(entry.type), entry.type);
      }
    }
    if (entries.size) gemCatalog.set(api, { expiresAt: Date.now() + 10 * 60_000, entries });
    return entries;
  }).finally(() => { pendingGemCatalog.delete(api); });
  pendingGemCatalog.set(api, load);
  return load;
}

export function makeQuery(request: SearchRequest, gemType?: string | GemTradeType): Record<string, unknown> {
  const itemFilters = request.itemFilters;
  const stats: Array<Record<string, unknown>> = [];
  const mercenaryFilters = request.mercenaryFilters?.length
    ? request.mercenaryFilters
    : request.mercenaryFilter ? [request.mercenaryFilter] : [];
  if (mercenaryFilters.length) {
    for (const mercenaryFilter of mercenaryFilters) {
      const supportCount = mercenaryFilter.supportIds.length;
      const minimumMatches = supportCount > 1
        ? supportCount
        : undefined;
      stats.push({
        type: "mercenary",
        ...(minimumMatches !== undefined ? { value: { min: minimumMatches } } : {}),
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
    query.type = gemType ?? request.item.baseType;
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
  // The Trade index does not expose ordinary Map Fragments (including
  // Scarabs) as rarity "normal". Sending that visually correct clipboard
  // rarity turns otherwise valid exact-type searches into zero results.
  const incompatibleFragmentRarity = itemFilters?.rarity === "normal"
    && /^(Map Fragments|Kartenfragmente)$/i.test(request.item.itemClass ?? "");
  if (request.item.gem) typeFilterValues.category = { option: "gem" };
  if (itemFilters?.rarity && !request.item.gem && !incompatibleFragmentRarity) {
    typeFilterValues.rarity = { option: itemFilters.rarity };
  }
  if (itemFilters?.itemLevel) typeFilterValues.ilvl = rangeValue(itemFilters.itemLevel);
  if (itemFilters?.quality && !request.item.gem) typeFilterValues.quality = rangeValue(itemFilters.quality);
  if (itemFilters?.sockets) typeFilterValues.sockets = rangeValue(itemFilters.sockets);
  if (itemFilters?.links) typeFilterValues.links = rangeValue(itemFilters.links);

  const miscFilterValues: Record<string, unknown> = {};
  if (request.item.gem) {
    if (itemFilters?.gemLevel) miscFilterValues.gem_level = rangeValue(itemFilters.gemLevel);
    if (itemFilters?.quality) miscFilterValues.quality = rangeValue(itemFilters.quality);
  }
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

export function makeTradeUrl(request: SearchRequest, gemType?: string | GemTradeType): string {
  const query = encodeURIComponent(JSON.stringify(makeQuery(request, gemType)));
  const origin = request.item.gem?.locale === "de" ? germanTradeOrigin : "https://www.pathofexile.com";
  return `${origin}/trade/search/${encodeURIComponent(request.league)}?q=${query}`;
}

export function makeBulkExchangeQuery(wantTag: string, haveTags = ["chaos", "divine"]): Record<string, unknown> {
  return {
    engine: "new",
    query: {
      status: { option: "online" },
      have: haveTags.filter((tag) => tag !== wantTag),
      want: [wantTag],
    },
    sort: { have: "asc" },
  };
}

async function getExchangeStaticItems(): Promise<Array<{ group: string; id: string; text: string }>> {
  if (exchangeStaticCache && exchangeStaticCacheExpiresAt > Date.now()) return exchangeStaticCache;
  if (exchangeStaticPending) return exchangeStaticPending;
  exchangeStaticPending = rateLimitedFetch(`${apiBase}/data/static`).then(async (response) => {
    const data = (await response.json()) as {
      result?: Array<{ id?: string; entries?: Array<{ id?: string; text?: string }> }>;
    };
    exchangeStaticCache = (data.result ?? []).flatMap((group) =>
      (group.entries ?? [])
        .filter((entry): entry is { id: string; text: string } => Boolean(entry.id && entry.text))
        .map((entry) => ({ group: group.id ?? "", id: entry.id, text: entry.text })),
    );
    exchangeStaticCacheExpiresAt = Date.now() + 10 * 60 * 1_000;
    return exchangeStaticCache;
  }).finally(() => { exchangeStaticPending = undefined; });
  return exchangeStaticPending;
}

function normalizeExchangeName(value: string): string {
  return value.normalize("NFKC").replace(/[’‘]/g, "'").trim().toLocaleLowerCase("en");
}

async function getItemExchangeTag(item: ParsedItem): Promise<string | undefined> {
  const names = [item.baseType, item.name].filter((name): name is string => Boolean(name));
  if (!names.length) return undefined;
  const groups = await getExchangeStaticItems();
  const groupHint = /^(currency)$/i.test(item.itemClass ?? "") ? "Currency"
    : /^(map fragments)$/i.test(item.itemClass ?? "") ? "Fragments"
      : /^(divination cards)$/i.test(item.itemClass ?? "") ? "Cards" : undefined;
  for (const name of names) {
    const normalized = normalizeExchangeName(name);
    const matches = groups.filter((entry) => normalizeExchangeName(entry.text) === normalized);
    const preferred = groupHint ? matches.find((entry) => entry.group === groupHint) : undefined;
    if (preferred) return preferred.id;
    if (matches[0]) return matches[0].id;
  }
  return undefined;
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function makeBulkExchangeUrl(league: string, body: Record<string, unknown>): string {
  const query = encodeURIComponent(JSON.stringify({ exchange: body.query }));
  return `https://www.pathofexile.com/trade/exchange/${encodeURIComponent(league)}?q=${query}`;
}

interface ExchangeOfferResponse {
  id?: string;
  listing?: {
    indexed?: string;
    offers?: Array<{
      exchange?: { currency?: string; amount?: number };
      item?: { amount?: number; stock?: number };
    }>;
  };
}

async function searchBulkTrade(request: SearchRequest, exchangeTag: string): Promise<SearchResponse> {
  const haveTags = exchangeTag === "chaos" ? ["divine"] : ["chaos", "divine"];
  const body = makeBulkExchangeQuery(exchangeTag, haveTags);
  const tradeUrl = makeBulkExchangeUrl(request.league, body);

  // Chaos Orb is the reference currency itself: there is no useful exchange
  // orderbook for exchanging chaos into chaos, but its stack value is exact.
  if (exchangeTag === "chaos") {
    const quantity = request.item.stackSize ?? 1;
    const maxStackSize = request.item.maxStackSize ?? quantity;
    const stackValue: StackValue = {
      quantity, maxStackSize, unitPrice: 1, currency: "chaos",
      currentTotal: quantity, fullStackTotal: maxStackSize, basisListings: 0,
    };
    return {
      queryId: "fixed-chaos-ratio",
      total: 0,
      tradeUrl,
      results: [],
      bulkListings: [],
      stackValue,
      notice: "Chaos Orb is valued at its exact 1:1 reference rate.",
    };
  }

  const response = await rateLimitedFetch(
    `${apiBase}/exchange/${encodeURIComponent(request.league)}`,
    { method: "POST", body: JSON.stringify(body) },
  );
  const data = (await response.json()) as {
    id?: string;
    total?: number;
    result?: Record<string, ExchangeOfferResponse>;
    error?: { message?: string };
  };
  if (data.error?.message) throw new Error(`Trade-Anfrage fehlgeschlagen: ${data.error.message}`);

  const listings: BulkTradeListing[] = Object.values(data.result ?? {}).flatMap((entry) =>
    (entry.listing?.offers ?? []).flatMap((offer) => {
      const exchangeAmount = Number(offer.exchange?.amount);
      const itemAmount = Number(offer.item?.amount);
      const exchangeCurrency = String(offer.exchange?.currency ?? "");
      const stock = Number(offer.item?.stock);
      if (!exchangeCurrency || !Number.isFinite(exchangeAmount) || exchangeAmount <= 0
        || !Number.isFinite(itemAmount) || itemAmount <= 0
        || !Number.isFinite(stock) || stock <= 0) return [];
      return [{
        id: String(entry.id ?? ""),
        exchangeAmount,
        exchangeCurrency,
        itemAmount,
        stock,
        fulfill: Math.floor(stock / itemAmount),
        ...(entry.listing?.indexed ? { indexed: entry.listing.indexed } : {}),
      }];
    }),
  ).filter((entry) => Boolean(entry.id))
    .sort((left, right) => left.exchangeCurrency.localeCompare(right.exchangeCurrency)
      || (left.exchangeAmount / left.itemAmount) - (right.exchangeAmount / right.itemAmount));

  const chaosRates = listings
    .filter((listing) => listing.exchangeCurrency === "chaos")
    .map((listing) => listing.exchangeAmount / listing.itemAmount);
  const chosenCurrency = chaosRates.length ? "chaos" : listings[0]?.exchangeCurrency;
  const chosenRates = chosenCurrency
    ? listings.filter((listing) => listing.exchangeCurrency === chosenCurrency)
      .slice(0, 10).map((listing) => listing.exchangeAmount / listing.itemAmount)
    : [];
  const unitPrice = median(chosenRates);
  const quantity = request.item.stackSize ?? 1;
  const maxStackSize = request.item.maxStackSize ?? quantity;
  const stackValue = unitPrice !== undefined ? {
    quantity,
    maxStackSize,
    unitPrice,
    currency: chosenCurrency!,
    currentTotal: unitPrice * quantity,
    fullStackTotal: unitPrice * maxStackSize,
    basisListings: chosenRates.length,
  } satisfies StackValue : undefined;

  return {
    queryId: String(data.id ?? "bulk-exchange"),
    total: Number(data.total ?? listings.length),
    tradeUrl,
    results: [],
    bulkListings: listings.slice(0, 20),
    ...(stackValue ? { stackValue } : {}),
    notice: stackValue
      ? `Stack value is estimated from the median rate of ${chosenRates.length} current ${chosenCurrency} exchange offers.`
      : "No current exchange offers were available to estimate this stack value.",
  };
}

async function requestTradeSearch(league: string, body: Record<string, unknown>, api = apiBase): Promise<TradeSearchData> {
  const response = await rateLimitedFetch(
    `${api}/search/${encodeURIComponent(league)}`,
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

async function fetchTradeResults(searchData: TradeSearchData, useWarrantCache: boolean, api = apiBase): Promise<TradeResult[]> {
  const ids = searchData.result.slice(0, 10);
  if (!ids.length) return [];

  const load = async (): Promise<TradeResult[]> => {
    const fetchResponse = await rateLimitedFetch(
      `${api}/fetch/${ids.join(",")}?query=${encodeURIComponent(searchData.id)}`,
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
  rateState.blockedUntil = 0;
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
  let resolvedRequest = request;
  const searchApi = request.item.gem?.locale === "de" ? `${germanTradeOrigin}/api/trade` : apiBase;
  const gemType = request.item.gem && request.item.baseType && (request.itemFilters?.useBaseType ?? true)
    ? (await getGemCatalog(searchApi)).get(normalizeExchangeName(request.item.baseType))
    : undefined;
  const mercenaryFilters = resolvedRequest.mercenaryFilters?.length
    ? resolvedRequest.mercenaryFilters
    : resolvedRequest.mercenaryFilter ? [resolvedRequest.mercenaryFilter] : [];
  const hasSelectedItemStats = Boolean(request.statFilters?.length || request.statIds?.length);
  if (!request.item.isMercenaryWarrant && !mercenaryFilters.length && !hasSelectedItemStats
    && request.item.stackSize !== undefined) {
    const exchangeTag = await getItemExchangeTag(request.item);
    if (exchangeTag) return searchBulkTrade(request, exchangeTag);
  }
  let searchData: TradeSearchData;
  let intersectionNotice: string | undefined;
  let baseTypeFallbackNotice: string | undefined;
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
    try {
      searchData = await requestTradeSearch(request.league, makeQuery(resolvedRequest, gemType), searchApi);
    } catch (error) {
      const selectedStatCount = (request.statFilters?.length ?? request.statIds?.length ?? 0);
      const useBaseType = request.itemFilters?.useBaseType ?? true;
      if (!(error instanceof Error)
        || !/Unknown item base type/i.test(error.message)
        || request.item.gem
        || !request.item.baseType
        || !useBaseType
        || selectedStatCount === 0) throw error;

      // Some magic-item clipboard headers include both affixes and the base
      // type. If the exact type is rejected, retry once without that one filter
      // while preserving rarity, selected stats, and the remaining options.
      const itemFilters: ItemSearchFilters = {
        ...(request.itemFilters ?? { useName: true, useBaseType: true }),
        useBaseType: false,
      };
      resolvedRequest = { ...request, itemFilters };
      searchData = await requestTradeSearch(request.league, makeQuery(resolvedRequest));
      baseTypeFallbackNotice = "PoE hat den kopierten Basistyp abgelehnt. Die Suche wurde ohne diesen einzelnen Filter wiederholt; bitte prüfe, ob die Treffer zum Item passen.";
    }
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

  const results = await fetchTradeResults(searchData, request.item.isMercenaryWarrant, searchApi);
  const searchNotice = intersectionNotice
    ? `${intersectionNotice}${partitionedSupports ? " Komplexe Support-Blöcke wurden automatisch aufgeteilt." : ""} Maximal zehn sichtbare Vergleichsangebote werden geladen.`
    : partitionedSupports
      ? "Der komplexe Support-Block wurde automatisch aufgeteilt und lokal exakt ausgewertet. Maximal zehn sichtbare Vergleichsangebote werden geladen."
      : "Nur manuell ausgelöste Suche; maximal zehn sichtbare Vergleichsangebote werden geladen.";

  const localizedSearchNotice = baseTypeFallbackNotice
    ? `${baseTypeFallbackNotice} ${searchNotice}`
    : searchNotice;
  return {
    queryId: searchData.id,
    total: searchData.total,
    tradeUrl: makeTradeUrl(resolvedRequest, gemType),
    results,
    notice: request.item.isMercenaryWarrant
      ? `${searchNotice} Identische Warrant-Abfragen werden fünf Minuten lang nur im Arbeitsspeicher wiederverwendet.`
      : localizedSearchNotice,
  };
}

export async function getMercenaryCatalog(): Promise<MercenaryCatalog> {
  if (catalogCache) return catalogCache;
  if (catalogPending) return catalogPending;
  catalogPending = getStatEntries().then((entries) => {
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
  }).finally(() => { catalogPending = undefined; });
  return catalogPending;
}

export async function getTradeLeagues(): Promise<TradeLeague[]> {
  if (leaguesCache && leaguesCacheExpiresAt > Date.now()) return leaguesCache;
  if (leaguesPending) return leaguesPending;
  leaguesPending = rateLimitedFetch(`${apiBase}/data/leagues`).then(async (response) => {
    const data = (await response.json()) as { result?: Array<{ id?: string; text?: string; realm?: string }> };
    const entries = (data.result ?? [])
      .filter((entry) => !entry.realm || entry.realm === "pc")
      .filter((entry): entry is { id: string; text: string } => Boolean(entry.id && entry.text))
      .map((entry) => ({ id: entry.id, text: entry.text }));
    if (!entries.length) return leaguesCache ?? [];
    leaguesCache = Array.from(new Map(entries.map((entry) => [entry.id, entry])).values());
    leaguesCacheExpiresAt = Date.now() + 60_000;
    return leaguesCache;
  }).finally(() => { leaguesPending = undefined; });
  return leaguesPending;
}

async function getStatEntries(): Promise<Array<{ id: string; text: string; type: string }>> {
  if (statEntriesCache) return statEntriesCache;
  if (statEntriesPending) return statEntriesPending;
  statEntriesPending = rateLimitedFetch(`${apiBase}/data/stats`).then(async (response) => {
    const data = (await response.json()) as {
      result?: Array<{ entries?: Array<{ id?: string; text?: string; type?: string }> }>;
    };
    statEntriesCache = (data.result ?? [])
      .flatMap((group) => group.entries ?? [])
      .filter((entry): entry is { id: string; text: string; type: string } => Boolean(entry.id && entry.text && entry.type));
    return statEntriesCache;
  }).finally(() => { statEntriesPending = undefined; });
  return statEntriesPending;
}

const searchableStatTypes = new Set([
  "explicit", "implicit", "crafted", "fractured", "enchant", "delve", "scourge", "imbued", "veiled",
]);
const suggestionStopWords = new Set([
  "the", "and", "with", "from", "your", "you", "when", "while", "for", "per", "to", "of", "on", "in",
  "is", "are", "have", "has", "this", "that", "during", "against", "affected", "increased", "reduced",
]);

function wordsForSuggestion(value: string): Set<string> {
  return new Set(value.toLocaleLowerCase("en")
    .replace(/[-+]?\d+(?:[.,]\d+)?/g, " ")
    .replace(/[^a-z]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !suggestionStopWords.has(word)));
}

export async function getTradeStatSuggestions(lines: string[], kind: ModifierKind): Promise<TradeStatSuggestion[]> {
  const source = wordsForSuggestion(lines.join(" "));
  if (!source.size) return [];
  const entries = (await getStatEntries()).filter((entry) => searchableStatTypes.has(entry.type)
    && (kind === "unknown" || entry.type === kind));
  return entries.map((entry) => {
    const words = wordsForSuggestion(entry.text);
    let overlap = 0;
    for (const word of source) if (words.has(word)) overlap += 1;
    const score = overlap / Math.sqrt(source.size * Math.max(words.size, 1));
    return { entry, score };
  }).filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.entry.text.localeCompare(right.entry.text, "en"))
    .slice(0, 12)
    .map(({ entry }) => ({ id: entry.id, text: entry.text, type: entry.type }));
}

export function learnedModifierKey(lines: string[], kind: ModifierKind): string {
  const template = lines.map((line) => normalizeModifierText(line)
    .replace(/[-+]?\d+(?:[.,]\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en"))
    .join("\n");
  return `${kind}\n${template}`;
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
    // PoE appends this explanatory label to some fixed-value unique modifiers.
    .replace(/\s+[—–-]\s+Unscalable Value$/i, "")
    .replace(/\s+\((implicit|crafted|fractured|enchant|delve|scourge|imbued|veiled)\)$/i, "")
    .trim();
}

function stripTradeIdPrefix(id: string): string {
  return id.startsWith("{") ? id.slice(id.indexOf("}") + 1) : id;
}

interface IndexedGeneratedMatcher {
  matcher: typeof generatedStatMatchers[number];
  index: number;
}

let generatedMatcherIndex: Map<string, IndexedGeneratedMatcher[]> | undefined;
const generatedMatcherPatterns = new WeakMap<typeof generatedStatMatchers[number], RegExp>();

function firstWord(value: string): string {
  return value.match(/[a-z][a-z'’]*/i)?.[0]?.toLocaleLowerCase("en") ?? "";
}

function generatedMatcherKey(lineCount: number, kind: string, word: string): string {
  return `${lineCount}\n${kind}\n${word}`;
}

function getGeneratedMatcherIndex(): Map<string, IndexedGeneratedMatcher[]> {
  if (generatedMatcherIndex) return generatedMatcherIndex;
  const index = new Map<string, IndexedGeneratedMatcher[]>();
  generatedStatMatchers.forEach((matcher, sourceIndex) => {
    const lineCount = matcher.template.trim().split("\n").length;
    const word = firstWord(matcher.template);
    for (const [kind, ids] of Object.entries(matcher.tradeIds)) {
      if (!ids.length) continue;
      const key = generatedMatcherKey(lineCount, kind, word);
      const candidates = index.get(key) ?? [];
      candidates.push({ matcher, index: sourceIndex });
      index.set(key, candidates);
    }
  });
  generatedMatcherIndex = index;
  return index;
}

function generatedMatcherPattern(matcher: typeof generatedStatMatchers[number]): RegExp {
  let pattern = generatedMatcherPatterns.get(matcher);
  if (!pattern) {
    pattern = statPattern(matcher.template.trim());
    generatedMatcherPatterns.set(matcher, pattern);
  }
  return pattern;
}

function matchBlock(
  block: ParsedModifierBlock,
  entries: Array<{ id: string; text: string; type: string }>,
  learnedMappings: Map<string, LearnedModifierMapping> = new Map(),
): { entry: { id: string; text: string; type: string }; numericValue?: number; alternativeIds?: string[]; better?: -1 | 0 | 1; learned?: true } | undefined {
  const normalizedLines = block.lines.map(normalizeModifierText);
  const textVariants = [
    normalizedLines.join("\n"),
    normalizedLines.flatMap((line) => line.split(/\s+\/\s+/)).join("\n"),
  ];
  const lineCounts = new Set(textVariants.map((text) => text.split("\n").length));
  const exactType = block.kind === "unknown" ? undefined : block.kind;
  const kindOrder = exactType ? [exactType] : ["explicit", "implicit", "crafted", "fractured", "enchant", "delve", "scourge", "imbued", "veiled"];
  const learnedMapping = learnedMappings.get(learnedModifierKey(block.lines, block.kind));
  // A learned entry is explicitly confirmed by the user and keyed to the
  // normalized source wording, so it can bridge spelling/format differences
  // that prevented an exact official-template match in the first place.
  const appliesLearnedMapping = Boolean(learnedMapping);
  let generated: typeof generatedStatMatchers[number] | undefined;
  if (!appliesLearnedMapping) {
    // Generated matcher data is several megabytes. Index it once by the shape
    // that can be known without regex work, then test only candidates with the
    // same line count, modifier type and first word. Keep source order so an
    // ambiguous legacy match resolves exactly as it did before this index.
    const matcherIndex = getGeneratedMatcherIndex();
    const candidateByIndex = new Map<number, typeof generatedStatMatchers[number]>();
    for (const text of textVariants) {
      const lineCount = text.split("\n").length;
      const word = firstWord(text);
      for (const kind of kindOrder) {
        for (const candidate of matcherIndex.get(generatedMatcherKey(lineCount, kind, word)) ?? []) {
          candidateByIndex.set(candidate.index, candidate.matcher);
        }
      }
    }
    generated = Array.from(candidateByIndex.entries())
      .sort(([left], [right]) => left - right)
      .map(([, matcher]) => matcher)
      .find((matcher) => textVariants.some((text) => generatedMatcherPattern(matcher).test(text)));
  }
  const generatedKind = generated && kindOrder.find((kind) => generated.tradeIds[kind]?.length);
  const generatedIds = generated && generatedKind
    ? generated.tradeIds[generatedKind]!.map(stripTradeIdPrefix)
    : [];
  const candidates = entries.filter((entry) => lineCounts.has(entry.text.split("\n").length));
  const entry = appliesLearnedMapping && learnedMapping
    ? entries.find((candidate) => candidate.id === learnedMapping.tradeStatId)
      ?? { id: learnedMapping.tradeStatId, text: learnedMapping.tradeStatText, type: learnedMapping.tradeStatType }
    : generatedIds.length
      ? entries.find((candidate) => candidate.id === generatedIds[0]) ?? { id: generatedIds[0]!, text: generated!.template.trim(), type: generatedKind! }
      : candidates.find((candidate) => candidate.type === exactType && textVariants.some((text) => statPattern(candidate.text).test(text)))
        ?? candidates.find((candidate) => textVariants.some((text) => statPattern(candidate.text).test(text)));
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
    ...(appliesLearnedMapping ? { learned: true as const } : {}),
  };
}

function rollsForModifierLine(line: string): ParsedModifierBlock["rolls"] {
  const normalized = line.replace(/([-+]?\d+(?:[.,]\d+)?)\(([-+]?\d+(?:[.,]\d+)?)-([-+]?\d+(?:[.,]\d+)?)\)/g, "$1{$2:$3}");
  return Array.from(normalized.matchAll(/([-+]?\d+(?:[.,]\d+)?)(?:\{([-+]?\d+(?:[.,]\d+)?):([-+]?\d+(?:[.,]\d+)?)\})?/g), (match) => ({
    value: Number.parseFloat(match[1]!.replace(",", ".")),
    ...(match[2] !== undefined ? { min: Number.parseFloat(match[2].replace(",", ".")) } : {}),
    ...(match[3] !== undefined ? { max: Number.parseFloat(match[3].replace(",", ".")) } : {}),
  }));
}

function splitBundledModifier(block: ParsedModifierBlock, entries: Array<{ id: string; text: string; type: string }>): ParsedModifierBlock[] {
  if (!block.lines.length || matchBlock(block, entries)) return [block];
  // Advanced item text can put multiple official stats under one affix header
  // as separate lines, while compact item text joins them with " / ". Handle
  // both shapes, but split only if every part independently maps to a stat.
  const segments = block.lines.flatMap((line) => line.split(/\s+\/\s+/)).map((line) => line.trim()).filter(Boolean);
  if (segments.length < 2) return [block];
  const splitBlocks = segments.map((line) => ({ ...block, lines: [line], rolls: rollsForModifierLine(line) }));
  // Split only when each side independently maps to an official stat. This
  // keeps literal slashes in legitimate single modifiers from being changed.
  return splitBlocks.every((candidate) => matchBlock(candidate, entries)) ? splitBlocks : [block];
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
    const bundled = generatedStatMatchers.find((matcher) =>
      matcher.template.trim().toLocaleLowerCase() === label.toLocaleLowerCase()
      && matcher.tradeIds.pseudo?.length,
    );
    const bundledId = bundled?.tradeIds.pseudo?.[0];
    const entry = entries.find((candidate) => candidate.type === "pseudo" && candidate.text.toLocaleLowerCase() === label.toLocaleLowerCase())
      ?? (bundledId ? { id: stripTradeIdPrefix(bundledId), text: label, type: "pseudo" } : undefined);
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

function matchModifierBlocks(
  blocks: ParsedModifierBlock[],
  searchableEntries: Array<{ id: string; text: string; type: string }>,
  recommendAll: boolean,
  learnedMappings: Map<string, LearnedModifierMapping>,
): TradeStatMatch[] {
  const direct: TradeStatMatch[] = [];
  const consumed = new Set<number>();
  for (const [index, originalBlock] of blocks.slice(0, 80).entries()) {
    if (consumed.has(index)) continue;
    let block = originalBlock;
    let matched = matchBlock(block, searchableEntries, learnedMappings);
    if (!matched && block.lines.length === 1) {
      for (let count = 2; count <= 3 && index + count <= blocks.length; count += 1) {
        const group = blocks.slice(index, index + count);
        if (group.some((candidate) => candidate.lines.length !== 1 || candidate.kind !== block.kind)) break;
        const combined: ParsedModifierBlock = {
          ...block,
          lines: group.flatMap((candidate) => candidate.lines),
          rolls: group.flatMap((candidate) => candidate.rolls),
        };
        const combinedMatch = matchBlock(combined, searchableEntries, learnedMappings);
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
      ...(matched.learned ? { learned: true } : {}),
      recommended: recommendAll || /Movement Speed/i.test(matched.entry.text),
    });
  }
  return direct;
}

export async function matchItemModifiers(item: ParsedItem | string[], learnedMappings: LearnedModifierMapping[] = []): Promise<TradeStatMatch[]> {
  const learnedByKey = new Map(learnedMappings.map((mapping) => [
    learnedModifierKey(mapping.lines, mapping.kind), mapping,
  ]));
  const sourceBlocks: ParsedModifierBlock[] = Array.isArray(item)
    ? item.map((line) => ({ lines: [line], kind: "unknown", tags: [], rolls: [] }))
    : item.modifierBlocks;
  let searchableEntries: Array<{ id: string; text: string; type: string }> = [];
  let blocks = sourceBlocks.flatMap((block) => splitBundledModifier(block, searchableEntries));
  const recommendAll = !Array.isArray(item) && item.rarity?.toLocaleLowerCase() === "unique";
  let direct = matchModifierBlocks(blocks, searchableEntries, recommendAll, learnedByKey);

  // Most current stats resolve from the bundled Awakened stat catalog. Fetch
  // GGG's live stat list only when that local catalog cannot map a modifier.
  if (direct.some((match) => match.unmatched)) {
    const entries = (await getStatEntries()).filter((entry) =>
      ["explicit", "implicit", "crafted", "fractured", "enchant", "delve", "scourge", "imbued", "veiled", "pseudo"].includes(entry.type),
    );
    searchableEntries = entries.filter((entry) => entry.type !== "pseudo");
    blocks = sourceBlocks.flatMap((block) => splitBundledModifier(block, searchableEntries));
    direct = matchModifierBlocks(blocks, searchableEntries, recommendAll, learnedByKey);
  }
  const entries = searchableEntries;
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
