"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("api", {
  openFile: () => electron.ipcRenderer.invoke("dialog:openFile"),
  saveFile: (content, filePath) => electron.ipcRenderer.invoke("dialog:saveFile", content, filePath),
  saveFileAs: (content) => electron.ipcRenderer.invoke("dialog:saveFileAs", content),
  getFilePath: () => electron.ipcRenderer.invoke("getFilePath"),
  setTitle: (title) => electron.ipcRenderer.invoke("setTitle", title),
  exportHtml: (html) => electron.ipcRenderer.invoke("export:html", html),
  exportPdf: (html) => electron.ipcRenderer.invoke("export:pdf", html),
  // Menu event listeners
  onNewFile: (callback) => {
    electron.ipcRenderer.on("menu-new-file", callback);
    return () => electron.ipcRenderer.removeListener("menu-new-file", callback);
  },
  onOpenFile: (callback) => {
    electron.ipcRenderer.on("menu-open-file", callback);
    return () => electron.ipcRenderer.removeListener("menu-open-file", callback);
  },
  onSaveFile: (callback) => {
    electron.ipcRenderer.on("menu-save-file", callback);
    return () => electron.ipcRenderer.removeListener("menu-save-file", callback);
  },
  onSaveAsFile: (callback) => {
    electron.ipcRenderer.on("menu-save-as-file", callback);
    return () => electron.ipcRenderer.removeListener("menu-save-as-file", callback);
  },
  onExportHtml: (callback) => {
    electron.ipcRenderer.on("menu-export-html", callback);
    return () => electron.ipcRenderer.removeListener("menu-export-html", callback);
  },
  onExportPdf: (callback) => {
    electron.ipcRenderer.on("menu-export-pdf", callback);
    return () => electron.ipcRenderer.removeListener("menu-export-pdf", callback);
  },
  onToggleTheme: (callback) => {
    electron.ipcRenderer.on("menu-toggle-theme", callback);
    return () => electron.ipcRenderer.removeListener("menu-toggle-theme", callback);
  }
});
