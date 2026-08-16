import {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  Tray,
} from "electron";
import { autoUpdater } from "electron-updater";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parsePoeItem } from "./parser";
import { getMercenaryCatalog, getTradeLeagues, matchItemModifiers, searchTrade } from "./trade-service";
import type { AppLanguage, AppSettings, ParsedItem, SearchRequest, UpdateState } from "../shared/types";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let settings: AppSettings = { league: "Allflame", hotkey: "Alt+D", language: "en" };
let rendererReady = false;
let pendingItem: ParsedItem | undefined;
let dismissWatcher: ChildProcess | null = null;
let startupToastWindow: BrowserWindow | null = null;
let updateState: UpdateState = { status: "idle" };

function isAutoUpdateSupported(): boolean {
  return app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE;
}

function publishUpdateState(next: UpdateState): UpdateState {
  updateState = next;
  if (rendererReady && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("update:state", next);
  return next;
}

function configureAutoUpdater(): void {
  if (!isAutoUpdateSupported()) {
    publishUpdateState({ status: "disabled" });
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("checking-for-update", () => publishUpdateState({ status: "checking" }));
  autoUpdater.on("update-available", (info) => publishUpdateState({ status: "available", version: info.version }));
  autoUpdater.on("update-not-available", () => publishUpdateState({ status: "current", version: app.getVersion() }));
  autoUpdater.on("download-progress", (progress) => publishUpdateState({
    status: "downloading",
    ...(updateState.version ? { version: updateState.version } : {}),
    percent: Math.round(progress.percent),
  }));
  autoUpdater.on("update-downloaded", (info) => publishUpdateState({ status: "ready", version: info.version, percent: 100 }));
  autoUpdater.on("error", (error) => publishUpdateState({ status: "error", message: error.message }));
  setTimeout(() => void autoUpdater.checkForUpdates().catch((error: Error) => {
    publishUpdateState({ status: "error", message: error.message });
  }), 4_000);
}

const mainText = {
  en: {
    priceCheckFailed: "Price check failed",
    ready: "PoE Personal Trade is ready",
    started: "PoE Personal Trade started",
    pressHotkey: (hotkey: string) => `Press ${hotkey} while the cursor is over an item.`,
    hotkeyUnavailable: "Hotkey unavailable – Alt+D is probably already in use.",
    unavailable: "Unavailable",
    copyFailed: "PoE did not copy a new item. Keep the cursor directly over the item.",
    hotkeysUsed: "Alt+D and Ctrl+Alt+D are already used by other applications.",
    trayCheck: "Price-check hovered item",
    quit: "Quit",
  },
  de: {
    priceCheckFailed: "Preisprüfung fehlgeschlagen",
    ready: "PoE Personal Trade ist bereit",
    started: "PoE Personal Trade gestartet",
    pressHotkey: (hotkey: string) => `${hotkey} drücken, während der Mauszeiger über einem Item liegt.`,
    hotkeyUnavailable: "Hotkey nicht verfügbar – Alt+D ist vermutlich bereits belegt.",
    unavailable: "Nicht verfügbar",
    copyFailed: "PoE hat kein neues Item kopiert. Bitte den Mauszeiger direkt über das Item halten.",
    hotkeysUsed: "Alt+D und Ctrl+Alt+D sind bereits durch andere Programme belegt.",
    trayCheck: "Preischeck für gehovertes Item",
    quit: "Beenden",
  },
} as const;

function mt() { return mainText[settings.language]; }

function settingsPath(): string {
  return join(app.getPath("userData"), "settings.json");
}

function loadSettings(): void {
  try {
    const saved = JSON.parse(readFileSync(settingsPath(), "utf8")) as Partial<AppSettings>;
    if (typeof saved.league === "string" && /^[A-Za-z0-9 _-]{1,80}$/.test(saved.league)) settings.league = saved.league;
    if (saved.language === "de" || saved.language === "en") settings.language = saved.language;
  } catch { /* First launch or an unreadable settings file uses safe defaults. */ }
}

function persistSettings(): void {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), "utf8");
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

function createTrayIcon(): Electron.NativeImage {
  return nativeImage.createFromPath(appIconPath()).resize({ width: 16, height: 16 });
}

function appIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "app-icon.png")
    : join(app.getAppPath(), "assets", "app-icon.png");
}

function dismissWatcherPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "helpers", "poe-dismiss-watcher.exe")
    : join(app.getAppPath(), "assets", "poe-dismiss-watcher.exe");
}

function stopDismissWatcher(): void {
  const watcher = dismissWatcher;
  dismissWatcher = null;
  if (watcher && !watcher.killed) watcher.kill();
}

function hideOverlay(): void {
  stopDismissWatcher();
  mainWindow?.hide();
}

function startDismissWatcher(): void {
  if (!mainWindow) return;
  stopDismissWatcher();
  const nativeHandle = mainWindow.getNativeWindowHandle();
  const windowHandle = nativeHandle.length >= 8
    ? nativeHandle.readBigUInt64LE(0)
    : BigInt(nativeHandle.readUInt32LE(0));
  const watcher = spawn(dismissWatcherPath(), [windowHandle.toString()], {
    windowsHide: true,
    stdio: "ignore",
  });
  dismissWatcher = watcher;
  watcher.once("error", () => {
    if (dismissWatcher === watcher) dismissWatcher = null;
  });
  watcher.once("exit", (code) => {
    if (dismissWatcher !== watcher) return;
    dismissWatcher = null;
    if (code === 0) mainWindow?.hide();
  });
}

function showItem(item: ParsedItem): void {
  if (!mainWindow) return;
  if (rendererReady) mainWindow.webContents.send("hotkey:item", item);
  else pendingItem = item;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const bounds = mainWindow.getBounds();
  const x = Math.round(display.workArea.x + (display.workArea.width - bounds.width) / 2);
  const y = Math.round(display.workArea.y + Math.max(24, (display.workArea.height - bounds.height) / 2));
  mainWindow.setPosition(x, y, false);
  mainWindow.setFocusable(true);
  // Keep PoE active. The overlay becomes focusable as soon as the user clicks it.
  mainWindow.showInactive();
  startDismissWatcher();
}

function showWithClipboard(): void {
  showItem(parsePoeItem(clipboard.readText()));
}

function showAppError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  showItem({
    raw: "",
    modifiers: [],
    modifierBlocks: [],
    isMercenaryWarrant: false,
    warnings: [`${mt().priceCheckFailed}: ${message}`],
  });
}

function showStartupToast(): void {
  startupToastWindow?.close();
  const hotkeyReady = !["Nicht verfügbar", "Unavailable"].includes(settings.hotkey);
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const width = 360;
  const height = 78;
  const toast = new BrowserWindow({
    width,
    height,
    x: display.workArea.x + display.workArea.width - width - 18,
    y: display.workArea.y + 18,
    show: false,
    frame: false,
    transparent: true,
    focusable: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    hasShadow: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  startupToastWindow = toast;
  toast.setAlwaysOnTop(true, "screen-saver");
  toast.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  toast.setIgnoreMouseEvents(true);
  const icon = createTrayIcon().resize({ width: 38, height: 38 }).toDataURL();
  const title = hotkeyReady ? mt().ready : mt().started;
  const detail = hotkeyReady
    ? mt().pressHotkey(settings.hotkey)
    : mt().hotkeyUnavailable;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>
    *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;font-family:Inter,'Segoe UI',sans-serif}
    .toast{height:70px;margin:4px;display:flex;align-items:center;gap:11px;padding:10px 13px;border:1px solid ${hotkeyReady ? "rgba(180,135,70,.8)" : "rgba(173,74,57,.82)"};border-radius:2px;color:#e8dcc9;background:linear-gradient(135deg,rgba(38,29,19,.98),rgba(17,13,10,.98));box-shadow:0 10px 28px rgba(0,0,0,.72),inset 0 1px rgba(226,180,103,.08);animation:enter .22s ease-out}
    img{width:38px;height:38px}.copy{min-width:0}.title{font-family:Georgia,serif;font-weight:700;font-size:14px;color:#e1bd75}.detail{margin-top:4px;color:${hotkeyReady ? "#b9a98e" : "#d58b6d"};font-size:10px;line-height:1.25}.dot{margin-left:auto;width:8px;height:8px;flex:0 0 auto;background:${hotkeyReady ? "#809b72" : "#ad4a39"};box-shadow:0 0 7px currentColor}@keyframes enter{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}
  </style></head><body><div class="toast"><img src="${icon}" alt=""><div class="copy"><div class="title">${title}</div><div class="detail">${detail}</div></div><span class="dot"></span></div></body></html>`;
  void toast.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  toast.once("ready-to-show", () => {
    if (toast.isDestroyed()) return;
    toast.showInactive();
    setTimeout(() => {
      if (!toast.isDestroyed()) toast.close();
    }, hotkeyReady ? 3_800 : 6_000);
  });
  toast.once("closed", () => {
    if (startupToastWindow === toast) startupToastWindow = null;
  });
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function helperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "helpers", "poe-copy-helper.exe")
    : join(app.getAppPath(), "assets", "poe-copy-helper.exe");
}

async function copyHoveredItemAndShow(): Promise<void> {
  // Making the overlay non-focusable returns input to PoE without an Alt-Tab
  // style window switch or fullscreen flicker.
  mainWindow?.setFocusable(false);
  hideOverlay();
  await wait(250);
  // Never reuse a previous item when PoE fails to handle Ctrl+C.
  clipboard.clear();
  await new Promise<void>((resolve, reject) => {
    const helper = spawn(helperPath(), [], { windowsHide: true, stdio: "ignore" });
    helper.once("error", reject);
    helper.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Copy-Helper endete mit Code ${code}.`)));
  });
  await wait(75);
  const copiedText = clipboard.readText();
  if (!/(?:Item Class|Gegenstandsklasse):/i.test(copiedText) || !/(?:Rarity|Seltenheit):/i.test(copiedText)) {
    throw new Error(mt().copyFailed);
  }
  showItem(parsePoeItem(copiedText));
}

function triggerPriceCheck(): void {
  void copyHoveredItemAndShow().catch(showAppError);
}

function registerHotkey(): void {
  globalShortcut.unregisterAll();
  if (globalShortcut.register("Alt+D", triggerPriceCheck)) {
    settings.hotkey = "Alt+D";
    return;
  }
  const fallback = "CommandOrControl+Alt+D";
  if (globalShortcut.register(fallback, triggerPriceCheck)) {
    settings.hotkey = fallback;
    return;
  }
  settings.hotkey = mt().unavailable;
  showAppError(new Error(mt().hotkeysUsed));
}

function updateTray(): void {
  if (!tray) return;
  tray.setToolTip(`PoE Personal Trade – ${settings.hotkey}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: mt().trayCheck, click: triggerPriceCheck },
    { type: "separator" },
    { label: mt().quit, click: () => app.quit() },
  ]));
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 570,
    height: 680,
    minWidth: 500,
    minHeight: 520,
    show: false,
    frame: false,
    skipTaskbar: false,
    fullscreenable: false,
    resizable: true,
    alwaysOnTop: true,
    backgroundColor: "#090806",
    icon: appIconPath(),
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.setAlwaysOnTop(true, "screen-saver");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      hideOverlay();
    }
  });

  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) void window.loadURL(devServer);
  else void window.loadFile(join(__dirname, "../renderer/index.html"));
  window.webContents.once("did-finish-load", () => {
    rendererReady = true;
    if (pendingItem) {
      window.webContents.send("hotkey:item", pendingItem);
      pendingItem = undefined;
    }
    showStartupToast();
    window.webContents.send("update:state", updateState);
  });
  return window;
}

function registerIpc(): void {
  ipcMain.handle("clipboard:read", () => parsePoeItem(clipboard.readText()));
  ipcMain.handle("clipboard:parse", (_event, text: unknown) => {
    if (typeof text !== "string" || text.length > 100_000) throw new Error("Ungültiger Itemtext.");
    return parsePoeItem(text);
  });
  ipcMain.handle("trade:search", (_event, request: SearchRequest) => searchTrade(request));
  ipcMain.handle("trade:mercenary-catalog", () => getMercenaryCatalog());
  ipcMain.handle("trade:leagues", () => getTradeLeagues());
  ipcMain.handle("trade:match-modifiers", (_event, item: unknown) => {
    const parsed = item as ParsedItem | undefined;
    if (!parsed || !Array.isArray(parsed.modifierBlocks) || !Array.isArray(parsed.modifiers)) {
      throw new Error("Ungültige Mod-Liste.");
    }
    return matchItemModifiers(parsed);
  });
  ipcMain.handle("external:open", async (_event, url: unknown) => {
    if (typeof url !== "string" || !url.startsWith("https://www.pathofexile.com/trade/search/")) {
      throw new Error("Nur offizielle PoE-Trade-Links sind erlaubt.");
    }
    await shell.openExternal(url);
  });
  ipcMain.handle("window:hide", hideOverlay);
  ipcMain.handle("app:quit", () => app.quit());
  ipcMain.handle("settings:get", () => settings);
  ipcMain.handle("settings:save", (_event, next: AppSettings) => {
    if (!next || !/^[A-Za-z0-9 _-]{1,80}$/.test(next.league)) throw new Error("Ungültige Einstellungen.");
    const language: AppLanguage = next.language === "de" ? "de" : "en";
    settings = { league: next.league, hotkey: "Alt+D", language };
    registerHotkey();
    persistSettings();
    updateTray();
    return settings;
  });
  ipcMain.handle("update:check", async () => {
    if (!isAutoUpdateSupported()) return publishUpdateState({ status: "disabled" });
    await autoUpdater.checkForUpdates();
    return updateState;
  });
  ipcMain.handle("update:install", () => {
    if (updateState.status === "ready") autoUpdater.quitAndInstall(false, true);
  });
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.whenReady().then(() => {
  loadSettings();
  app.setAppUserModelId("dev.plumsklo.poe-personal-trade");
  mainWindow = createWindow();
  registerIpc();
  registerHotkey();
  tray = new Tray(createTrayIcon());
  updateTray();
  tray.on("double-click", showWithClipboard);
  configureAutoUpdater();
  if (process.argv.includes("--show")) showWithClipboard();
  }).catch(showAppError);
}

app.on("before-quit", () => {
  quitting = true;
  stopDismissWatcher();
  startupToastWindow?.close();
});

app.on("will-quit", () => globalShortcut.unregisterAll());
