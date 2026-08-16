import { contextBridge, ipcRenderer } from "electron";
import type { AppApi, AppSettings, ParsedItem, SearchRequest, UpdateState } from "../shared/types";

const api: AppApi = {
  getClipboardItem: () => ipcRenderer.invoke("clipboard:read"),
  parseText: (text: string) => ipcRenderer.invoke("clipboard:parse", text),
  searchTrade: (request: SearchRequest) => ipcRenderer.invoke("trade:search", request),
  getMercenaryCatalog: () => ipcRenderer.invoke("trade:mercenary-catalog"),
  getLeagues: () => ipcRenderer.invoke("trade:leagues"),
  matchItemModifiers: (item: ParsedItem) => ipcRenderer.invoke("trade:match-modifiers", item),
  openExternal: (url: string) => ipcRenderer.invoke("external:open", url),
  hideWindow: () => ipcRenderer.invoke("window:hide"),
  quitApp: () => ipcRenderer.invoke("app:quit"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings: AppSettings) => ipcRenderer.invoke("settings:save", settings),
  checkForUpdates: () => ipcRenderer.invoke("update:check"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  onUpdateState: (callback: (state: UpdateState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: UpdateState) => callback(state);
    ipcRenderer.on("update:state", listener);
    return () => ipcRenderer.removeListener("update:state", listener);
  },
  onHotkey: (callback: (item: ParsedItem) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, item: ParsedItem) => callback(item);
    ipcRenderer.on("hotkey:item", listener);
    return () => ipcRenderer.removeListener("hotkey:item", listener);
  },
};

contextBridge.exposeInMainWorld("poeTrade", api);
