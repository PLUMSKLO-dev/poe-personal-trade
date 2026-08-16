export type ItemInfluence = "shaper" | "elder" | "crusader" | "redeemer" | "hunter" | "warlord";

export interface ParsedItem {
  raw: string;
  itemClass?: string;
  rarity?: string;
  name?: string;
  baseType?: string;
  itemLevel?: number;
  quality?: number;
  sockets?: number;
  links?: number;
  corrupted?: boolean;
  synthesised?: boolean;
  influences?: ItemInfluence[];
  build?: string;
  mercenaryLevel?: number;
  mercenaryName?: string;
  mercenarySkills?: ParsedMercenarySkill[];
  mercenaryTypeOption?: string;
  modifiers: string[];
  modifierBlocks: ParsedModifierBlock[];
  isMercenaryWarrant: boolean;
  warnings: string[];
}

export interface ParsedMercenarySupport {
  name: string;
  tier: number;
}

export interface ParsedMercenarySkill {
  name: string;
  supports: ParsedMercenarySupport[];
}

export type ModifierKind =
  | "explicit"
  | "implicit"
  | "crafted"
  | "fractured"
  | "enchant"
  | "scourge"
  | "veiled"
  | "imbued"
  | "unknown";

export interface ModifierRoll {
  value: number;
  min?: number;
  max?: number;
}

export interface ParsedModifierBlock {
  lines: string[];
  kind: ModifierKind;
  generation?: "prefix" | "suffix";
  affixName?: string;
  tier?: number;
  tags: string[];
  rolls: ModifierRoll[];
}

export interface MercenaryFilter {
  skillId: string;
  skillName: string;
  supportIds: string[];
}

export interface MercenaryCatalogEntry {
  id: string;
  name: string;
}

export interface MercenaryCatalog {
  skills: MercenaryCatalogEntry[];
  supports: MercenaryCatalogEntry[];
}

export interface TradeLeague {
  id: string;
  text: string;
}

export interface SearchRequest {
  league: string;
  item: ParsedItem;
  mercenaryFilter?: MercenaryFilter;
  mercenaryFilters?: MercenaryFilter[];
  statIds?: string[];
  statFilters?: TradeStatFilter[];
  itemFilters?: ItemSearchFilters;
}

export interface NumericRange {
  min?: number;
  max?: number;
}

export interface ItemSearchFilters {
  useName: boolean;
  useBaseType: boolean;
  useMercenaryBuild?: boolean;
  rarity?: string;
  itemLevel?: NumericRange;
  quality?: NumericRange;
  sockets?: NumericRange;
  links?: NumericRange;
  corrupted?: boolean;
  foulborn?: boolean;
  synthesised?: boolean;
  influences?: ItemInfluence[];
}

export interface TradeStatFilter {
  id: string;
  alternativeIds?: string[];
  min?: number;
  max?: number;
}

export interface TradeStatMatch {
  id: string;
  label: string;
  raw: string;
  numericValue?: number;
  unmatched?: boolean;
  kind?: ModifierKind | "pseudo";
  generation?: "prefix" | "suffix";
  affixName?: string;
  tier?: number;
  rollMin?: number;
  rollMax?: number;
  sourceLines?: string[];
  recommended?: boolean;
  better?: -1 | 0 | 1;
  conflictKeys?: string[];
  alternativeIds?: string[];
}

export interface TradePrice {
  amount: number;
  currency: string;
}

export interface TradeResult {
  id: string;
  price?: TradePrice;
  account?: string;
  indexed?: string;
  build?: string;
  mercenaryLevel?: number;
  skills: string[];
}

export interface SearchResponse {
  queryId: string;
  total: number;
  tradeUrl: string;
  results: TradeResult[];
  notice?: string;
}

export type AppLanguage = "en" | "de";

export interface AppSettings {
  league: string;
  hotkey: string;
  language: AppLanguage;
}

export type UpdateStatus = "disabled" | "idle" | "checking" | "available" | "downloading" | "ready" | "current" | "error";

export interface UpdateState {
  status: UpdateStatus;
  version?: string;
  percent?: number;
  message?: string;
}

export interface AppApi {
  getClipboardItem(): Promise<ParsedItem>;
  parseText(text: string): Promise<ParsedItem>;
  searchTrade(request: SearchRequest): Promise<SearchResponse>;
  getMercenaryCatalog(): Promise<MercenaryCatalog>;
  getLeagues(): Promise<TradeLeague[]>;
  matchItemModifiers(item: ParsedItem): Promise<TradeStatMatch[]>;
  openExternal(url: string): Promise<void>;
  hideWindow(): Promise<void>;
  quitApp(): Promise<void>;
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<AppSettings>;
  checkForUpdates(): Promise<UpdateState>;
  installUpdate(): Promise<void>;
  onUpdateState(callback: (state: UpdateState) => void): () => void;
  onHotkey(callback: (item: ParsedItem) => void): () => void;
}
