"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("api", {
  // File operations
  openFile: () => electron.ipcRenderer.invoke("dialog:openFile"),
  saveFile: (content, filePath) => electron.ipcRenderer.invoke("dialog:saveFile", content, filePath),
  saveFileAs: (content, defaultName) => electron.ipcRenderer.invoke("dialog:saveFileAs", content, defaultName),
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
  s3DeleteObject: (config, bucket, key) => electron.ipcRenderer.invoke("s3:deleteObject", config, bucket, key),
  // 本机主机名
  getHostname: () => electron.ipcRenderer.invoke("app:hostname"),
  // Full-text search (laoflchdb-rust)
  indexEnsure: (protocol, host, port, indexName, raft) => electron.ipcRenderer.invoke("index:ensure", protocol, host, port, indexName, raft),
  indexSearch: (protocol, host, port, indexName, query, limit) => electron.ipcRenderer.invoke("index:search", protocol, host, port, indexName, query, limit),
  indexLocalFile: (protocol, host, port, indexName, filePath, raft) => electron.ipcRenderer.invoke("index:indexLocal", protocol, host, port, indexName, filePath, raft),
  indexDir: (protocol, host, port, indexName, dirPath, raft) => electron.ipcRenderer.invoke("index:indexDir", protocol, host, port, indexName, dirPath, raft),
  indexS3File: (protocol, host, port, indexName, config, bucket, key, raft) => electron.ipcRenderer.invoke("index:indexS3", protocol, host, port, indexName, config, bucket, key, raft),
  indexCheckFiles: (paths, raft) => electron.ipcRenderer.invoke("index:checkFiles", paths, raft),
  indexCheckS3Files: (config, bucket, keys, raft) => electron.ipcRenderer.invoke("index:checkS3Files", config, bucket, keys, raft),
  indexGetDoc: (kind, path, config, bucket, key, raft) => electron.ipcRenderer.invoke("index:getDoc", kind, path, config, bucket, key, raft),
  indexDeleteDoc: (protocol, host, port, indexName, docId, fields, raft) => electron.ipcRenderer.invoke("index:deleteDoc", protocol, host, port, indexName, docId, fields, raft),
  indexRefreshAfterSave: (raft, kind, filePath, config, bucket, key, fulltext, vector) => electron.ipcRenderer.invoke(
    "index:refreshAfterSave",
    raft,
    kind,
    filePath,
    config,
    bucket,
    key,
    fulltext,
    vector
  ),
  // 目录建索引进度事件（主进程逐文件推送）
  onIndexProgress: (callback) => {
    const handler = (_event, progress) => callback(progress);
    electron.ipcRenderer.on("index:progress", handler);
    return () => electron.ipcRenderer.removeListener("index:progress", handler);
  },
  // Vector text index (laoflchdb-rust, gRPC)。索引状态保存在 Raft（key 为文件 blake3）
  vectorGetInfo: (host, port, indexName) => electron.ipcRenderer.invoke("vector:getInfo", host, port, indexName),
  vectorIndexLocal: (raft, host, port, indexName, modelName, filePath, chunkSize, overlap) => electron.ipcRenderer.invoke("vector:indexLocal", raft, host, port, indexName, modelName, filePath, chunkSize, overlap),
  vectorIndexDir: (raft, host, port, indexName, modelName, dirPath, chunkSize, overlap) => electron.ipcRenderer.invoke("vector:indexDir", raft, host, port, indexName, modelName, dirPath, chunkSize, overlap),
  vectorIndexS3: (raft, host, port, indexName, modelName, config, bucket, key, chunkSize, overlap) => electron.ipcRenderer.invoke("vector:indexS3", raft, host, port, indexName, modelName, config, bucket, key, chunkSize, overlap),
  vectorSearch: (raft, host, port, indexName, modelName, query, topK) => electron.ipcRenderer.invoke("vector:search", raft, host, port, indexName, modelName, query, topK),
  vectorDeleteFile: (raft, host, port, indexName, kind, path, config, bucket, key) => electron.ipcRenderer.invoke("vector:deleteFile", raft, host, port, indexName, kind, path, config, bucket, key),
  vectorDeleteId: (raft, host, port, indexName, id) => electron.ipcRenderer.invoke("vector:deleteId", raft, host, port, indexName, id),
  onVectorProgress: (callback) => {
    const handler = (_event, progress) => callback(progress);
    electron.ipcRenderer.on("vector:progress", handler);
    return () => electron.ipcRenderer.removeListener("vector:progress", handler);
  }
});
