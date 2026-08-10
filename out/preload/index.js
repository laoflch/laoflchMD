"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("api", {
  // File operations
  openFile: () => electron.ipcRenderer.invoke("dialog:openFile"),
  saveFile: (content, filePath) => electron.ipcRenderer.invoke("dialog:saveFile", content, filePath),
  saveFileAs: (content) => electron.ipcRenderer.invoke("dialog:saveFileAs", content),
  getFilePath: () => electron.ipcRenderer.invoke("getFilePath"),
  setTitle: (title) => electron.ipcRenderer.invoke("setTitle", title),
  exportHtml: (html) => electron.ipcRenderer.invoke("export:html", html),
  exportPdf: (html) => electron.ipcRenderer.invoke("export:pdf", html),
  // Window controls
  minimizeWindow: () => electron.ipcRenderer.invoke("window:minimize"),
  maximizeWindow: () => electron.ipcRenderer.invoke("window:maximize"),
  closeWindow: () => electron.ipcRenderer.invoke("window:close"),
  isMaximized: () => electron.ipcRenderer.invoke("window:isMaximized"),
  onMaximizedChanged: (callback) => {
    const handler = (_event, maximized) => callback(maximized);
    electron.ipcRenderer.on("window:maximized-changed", handler);
    return () => electron.ipcRenderer.removeListener("window:maximized-changed", handler);
  },
  // File tree operations
  readFile: (filePath) => electron.ipcRenderer.invoke("filetree:readFile", filePath),
  readDir: (dirPath) => electron.ipcRenderer.invoke("filetree:readDir", dirPath),
  openDirectory: () => electron.ipcRenderer.invoke("filetree:openDirectory"),
  getFileDir: (filePath) => electron.ipcRenderer.invoke("filetree:getFileDir", filePath),
  newFile: (dirPath) => electron.ipcRenderer.invoke("filetree:newFile", dirPath),
  newFolder: (dirPath) => electron.ipcRenderer.invoke("filetree:newFolder", dirPath),
  rename: (oldPath, newName) => electron.ipcRenderer.invoke("filetree:rename", oldPath, newName),
  delete: (targetPath) => electron.ipcRenderer.invoke("filetree:delete", targetPath),
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
  },
  onToggleSidebar: (callback) => {
    electron.ipcRenderer.on("menu-toggle-sidebar", callback);
    return () => electron.ipcRenderer.removeListener("menu-toggle-sidebar", callback);
  },
  onAbout: (callback) => {
    electron.ipcRenderer.on("menu-about", callback);
    return () => electron.ipcRenderer.removeListener("menu-about", callback);
  },
  getAppInfo: () => electron.ipcRenderer.invoke("app:getInfo"),
  // System theme detection
  getSystemTheme: () => electron.ipcRenderer.invoke("getSystemTheme"),
  onSystemThemeChanged: (callback) => {
    const handler = (_event, isDark) => callback(isDark);
    electron.ipcRenderer.on("system-theme-changed", handler);
    return () => electron.ipcRenderer.removeListener("system-theme-changed", handler);
  },
  // S3 operations
  s3ListBuckets: (config) => electron.ipcRenderer.invoke("s3:listBuckets", config),
  s3ListObjects: (config, bucket, prefix) => electron.ipcRenderer.invoke("s3:listObjects", config, bucket, prefix),
  s3GetObject: (config, bucket, key) => electron.ipcRenderer.invoke("s3:getObject", config, bucket, key),
  s3PutObject: (config, bucket, key, content) => electron.ipcRenderer.invoke("s3:putObject", config, bucket, key, content),
  s3DeleteObject: (config, bucket, key) => electron.ipcRenderer.invoke("s3:deleteObject", config, bucket, key)
});
