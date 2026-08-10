"use strict";
const electron = require("electron");
const path = require("path");
const fs = require("fs");
const clientS3 = require("@aws-sdk/client-s3");
function createClient(config) {
  let endpoint = config.endpoint || void 0;
  if (endpoint && !endpoint.startsWith("http")) {
    endpoint = "http://" + endpoint;
  }
  console.log("S3 client config:", { endpoint, region: config.region, accessKeyId: config.accessKeyId });
  return new clientS3.S3Client({
    endpoint,
    region: config.region || "us-east-1",
    // 使用路径式寻址，兼容 MinIO 等自建 S3 兼容存储
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  });
}
function isMarkdownKey(key) {
  return /\.(md|markdown|mdown)$/i.test(key);
}
function safeDecodeKey(key) {
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}
function registerS3Handlers() {
  electron.ipcMain.handle("s3:listBuckets", async (_event, config) => {
    try {
      const client = createClient(config);
      const res = await client.send(new clientS3.ListBucketsCommand({}));
      return (res.Buckets || []).filter((b) => b.Name).map((b) => ({
        name: b.Name,
        creationDate: b.CreationDate ? b.CreationDate.toISOString() : null
      }));
    } catch (e) {
      console.error("s3:listBuckets error:", e);
      const errMsg = e.message || e.toString && e.toString() || "未知错误";
      throw new Error(errMsg);
    }
  });
  electron.ipcMain.handle(
    "s3:listObjects",
    async (_event, config, bucket, prefix) => {
      try {
        const client = createClient(config);
        const res = await client.send(
          new clientS3.ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            Delimiter: "/"
          })
        );
        const folders = (res.CommonPrefixes || []).map((cp) => safeDecodeKey(cp.Prefix || "")).filter(Boolean);
        const files = (res.Contents || []).filter((o) => o.Key && o.Key !== prefix).filter((o) => isMarkdownKey(o.Key)).map((o) => {
          const key = safeDecodeKey(o.Key);
          return {
            key,
            name: key.split("/").pop() || "",
            size: o.Size || 0,
            lastModified: o.LastModified ? o.LastModified.toISOString() : null,
            eTag: o.ETag,
            isMarkdown: true
          };
        });
        return { folders, files };
      } catch (e) {
        console.error("s3:listObjects error:", e);
        const errMsg = e.message || e.toString && e.toString() || "未知错误";
        throw new Error(errMsg);
      }
    }
  );
  electron.ipcMain.handle(
    "s3:getObject",
    async (_event, config, bucket, key) => {
      try {
        const client = createClient(config);
        const res = await client.send(new clientS3.GetObjectCommand({ Bucket: bucket, Key: key }));
        const content = await res.Body?.transformToString("utf-8");
        return content ?? null;
      } catch (e) {
        console.error("s3:getObject error:", e);
        const errMsg = e.message || e.toString && e.toString() || "未知错误";
        throw new Error(errMsg);
      }
    }
  );
  electron.ipcMain.handle(
    "s3:putObject",
    async (_event, config, bucket, key, content) => {
      try {
        const client = createClient(config);
        await client.send(new clientS3.PutObjectCommand({ Bucket: bucket, Key: key, Body: content }));
        return { key };
      } catch (e) {
        console.error("s3:putObject error:", e);
        const errMsg = e.message || e.toString && e.toString() || "未知错误";
        throw new Error(errMsg);
      }
    }
  );
  electron.ipcMain.handle(
    "s3:deleteObject",
    async (_event, config, bucket, key) => {
      try {
        const client = createClient(config);
        await client.send(new clientS3.DeleteObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch (e) {
        console.error("s3:deleteObject error:", e);
        const errMsg = e.message || e.toString && e.toString() || "未知错误";
        throw new Error(errMsg);
      }
    }
  );
}
let mainWindow = null;
function createWindow() {
  mainWindow = new electron.BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    show: false
  });
  mainWindow.on("ready-to-show", () => {
    mainWindow?.show();
  });
  mainWindow.on("maximize", () => {
    mainWindow?.webContents.send("window:maximized-changed", true);
  });
  mainWindow.on("unmaximize", () => {
    mainWindow?.webContents.send("window:maximized-changed", false);
  });
  const menuTemplate = [
    {
      label: "文件",
      submenu: [
        {
          label: "新建",
          accelerator: "CmdOrCtrl+N",
          click: () => mainWindow?.webContents.send("menu-new-file")
        },
        {
          label: "打开",
          accelerator: "CmdOrCtrl+O",
          click: () => mainWindow?.webContents.send("menu-open-file")
        },
        {
          label: "保存",
          accelerator: "CmdOrCtrl+S",
          click: () => mainWindow?.webContents.send("menu-save-file")
        },
        {
          label: "另存为",
          accelerator: "CmdOrCtrl+Shift+S",
          click: () => mainWindow?.webContents.send("menu-save-as-file")
        },
        { type: "separator" },
        {
          label: "导出 HTML",
          click: () => mainWindow?.webContents.send("menu-export-html")
        },
        {
          label: "导出 PDF",
          click: () => mainWindow?.webContents.send("menu-export-pdf")
        },
        { type: "separator" },
        { role: "quit", label: "退出" }
      ]
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" }
      ]
    },
    {
      label: "视图",
      submenu: [
        { role: "reload", label: "刷新" },
        { role: "forceReload", label: "强制刷新" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "resetZoom", label: "重置缩放" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "全屏" },
        { type: "separator" },
        {
          label: "切换侧边栏",
          accelerator: "CmdOrCtrl+Shift+L",
          click: () => mainWindow?.webContents.send("menu-toggle-sidebar")
        }
      ]
    },
    {
      label: "主题",
      submenu: [
        {
          label: "切换亮色/暗色主题",
          accelerator: "CmdOrCtrl+Shift+T",
          click: () => mainWindow?.webContents.send("menu-toggle-theme")
        }
      ]
    }
  ];
  if (process.platform === "darwin") {
    menuTemplate.unshift({
      label: electron.app.name,
      submenu: [
        { role: "about", label: "关于" },
        { type: "separator" },
        { role: "hide", label: "隐藏" },
        { role: "hideOthers", label: "隐藏其他" },
        { role: "unhide", label: "显示全部" },
        { type: "separator" },
        { role: "quit", label: "退出" }
      ]
    });
  }
  const menu = electron.Menu.buildFromTemplate(menuTemplate);
  electron.Menu.setApplicationMenu(menu);
  if (process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}
electron.ipcMain.handle("getSystemTheme", () => {
  return electron.nativeTheme.shouldUseDarkColors;
});
electron.nativeTheme.on("updated", () => {
  mainWindow?.webContents.send("system-theme-changed", electron.nativeTheme.shouldUseDarkColors);
});
electron.ipcMain.handle("dialog:openFile", async () => {
  if (!mainWindow) return null;
  const result = await electron.dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [
      { name: "Markdown", extensions: ["md", "markdown", "mdown", "mdx"] },
      { name: "所有文件", extensions: ["*"] }
    ]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const content = fs.readFileSync(filePath, "utf-8");
  return { content, filePath };
});
electron.ipcMain.handle("dialog:saveFile", async (_event, content, filePath) => {
  if (!mainWindow) return null;
  try {
    if (filePath) {
      fs.writeFileSync(filePath, content, "utf-8");
      return filePath;
    }
    const result = await electron.dialog.showSaveDialog(mainWindow, {
      filters: [
        { name: "Markdown", extensions: ["md"] },
        { name: "所有文件", extensions: ["*"] }
      ]
    });
    if (result.canceled || !result.filePath) return null;
    fs.writeFileSync(result.filePath, content, "utf-8");
    return result.filePath;
  } catch (err) {
    console.error("Save file error:", err);
    return null;
  }
});
electron.ipcMain.handle("dialog:saveFileAs", async (_event, content) => {
  if (!mainWindow) return null;
  const result = await electron.dialog.showSaveDialog(mainWindow, {
    filters: [
      { name: "Markdown", extensions: ["md"] },
      { name: "所有文件", extensions: ["*"] }
    ]
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, content, "utf-8");
  return result.filePath;
});
electron.ipcMain.handle("setTitle", (_event, title) => {
  if (mainWindow) {
    mainWindow.setTitle(title ? `${title} - LaoflchMD` : "LaoflchMD");
  }
});
electron.ipcMain.handle("getFilePath", () => {
  return null;
});
electron.ipcMain.handle("window:minimize", () => {
  mainWindow?.minimize();
});
electron.ipcMain.handle("window:maximize", () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
electron.ipcMain.handle("window:close", () => {
  mainWindow?.close();
});
electron.ipcMain.handle("window:isMaximized", () => {
  return mainWindow?.isMaximized() ?? false;
});
electron.ipcMain.handle("export:html", async (_event, html) => {
  if (!mainWindow) return;
  const result = await electron.dialog.showSaveDialog(mainWindow, {
    filters: [
      { name: "HTML", extensions: ["html", "htm"] }
    ]
  });
  if (result.canceled || !result.filePath) return;
  const fullHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${mainWindow?.getTitle() || "Markdown Export"}</title>
  <style>
    body { max-width: 860px; margin: 0 auto; padding: 40px 20px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif; line-height: 1.6; }
    ${getExportStyles()}
  </style>
</head>
<body>${html}</body>
</html>`;
  fs.writeFileSync(result.filePath, fullHtml, "utf-8");
});
electron.ipcMain.handle("export:pdf", async (_event, html) => {
  if (!mainWindow) return;
  const result = await electron.dialog.showSaveDialog(mainWindow, {
    filters: [
      { name: "PDF", extensions: ["pdf"] }
    ]
  });
  if (result.canceled || !result.filePath) return;
  const printWindow = new electron.BrowserWindow({
    width: 860,
    height: 1100,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  const fullHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Markdown Export</title>
  <style>
    body { max-width: 860px; margin: 0 auto; padding: 40px 20px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif; line-height: 1.6; }
    ${getExportStyles()}
  </style>
</head>
<body>${html}</body>
</html>`;
  await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fullHtml)}`);
  const pdfData = await printWindow.webContents.printToPDF({
    printBackground: true,
    margins: { top: 20, bottom: 20, left: 20, right: 20 }
  });
  fs.writeFileSync(result.filePath, pdfData);
  printWindow.close();
});
electron.ipcMain.handle("filetree:readFile", async (_event, filePath) => {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return content;
  } catch {
    return null;
  }
});
electron.ipcMain.handle("filetree:readDir", async (_event, dirPath) => {
  try {
    const entries = fs.readdirSync(dirPath);
    const result = [];
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const fullPath = path.join(dirPath, entry);
      const stats = fs.statSync(fullPath);
      const isDir = stats.isDirectory();
      const ext = entry.toLowerCase();
      result.push({
        name: entry,
        path: fullPath,
        isDirectory: isDir,
        isMarkdown: !isDir && [".md", ".markdown", ".mdown"].some((e) => ext.endsWith(e))
      });
    }
    result.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
    return result;
  } catch {
    return [];
  }
});
electron.ipcMain.handle("filetree:openDirectory", async () => {
  if (!mainWindow) return null;
  const result = await electron.dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});
electron.ipcMain.handle("filetree:getFileDir", async (_event, filePath) => {
  if (!filePath) return null;
  return path.dirname(filePath);
});
electron.ipcMain.handle("filetree:newFile", async (_event, dirPath) => {
  if (!mainWindow) return null;
  let index = 1;
  let fileName = `untitled-${index}.md`;
  while (fs.existsSync(path.join(dirPath, fileName))) {
    index++;
    fileName = `untitled-${index}.md`;
  }
  const filePath = path.join(dirPath, fileName);
  fs.writeFileSync(filePath, "", "utf-8");
  return { name: fileName, path: filePath };
});
electron.ipcMain.handle("filetree:newFolder", async (_event, dirPath) => {
  let index = 1;
  let folderName = `new-folder-${index}`;
  while (fs.existsSync(path.join(dirPath, folderName))) {
    index++;
    folderName = `new-folder-${index}`;
  }
  const folderPath = path.join(dirPath, folderName);
  fs.mkdirSync(folderPath, { recursive: true });
  return { name: folderName, path: folderPath };
});
electron.ipcMain.handle("filetree:rename", async (_event, oldPath, newName) => {
  try {
    const dir = path.dirname(oldPath);
    const newPath = path.join(dir, newName);
    fs.renameSync(oldPath, newPath);
    return newPath;
  } catch {
    return null;
  }
});
electron.ipcMain.handle("filetree:delete", async (_event, targetPath) => {
  if (!mainWindow) return false;
  const stats = fs.statSync(targetPath);
  const name = path.basename(targetPath);
  const isDir = stats.isDirectory();
  const result = await electron.dialog.showMessageBox(mainWindow, {
    type: "warning",
    buttons: ["取消", "删除"],
    defaultId: 0,
    title: "确认删除",
    message: isDir ? `确定删除文件夹 "${name}" 及其所有内容？` : `确定删除文件 "${name}"？`
  });
  if (result.response !== 1) return false;
  try {
    if (isDir) {
      const deleteRecursive = (dirPath) => {
        const entries = fs.readdirSync(dirPath);
        for (const entry of entries) {
          const fullPath = path.join(dirPath, entry);
          const entryStat = fs.statSync(fullPath);
          if (entryStat.isDirectory()) {
            deleteRecursive(fullPath);
          } else {
            fs.unlinkSync(fullPath);
          }
        }
        fs.rmdirSync(dirPath);
      };
      deleteRecursive(targetPath);
    } else {
      fs.unlinkSync(targetPath);
    }
    return true;
  } catch {
    return false;
  }
});
function getExportStyles() {
  return `
    h1, h2, h3, h4, h5, h6 { margin-top: 24px; margin-bottom: 16px; font-weight: 600; line-height: 1.25; }
    h1 { font-size: 2em; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
    h2 { font-size: 1.5em; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
    h3 { font-size: 1.25em; }
    p { margin-top: 0; margin-bottom: 16px; }
    code { background-color: rgba(27,31,35,0.05); border-radius: 3px; padding: 0.2em 0.4em; font-size: 85%; }
    pre code { padding: 16px; overflow: auto; line-height: 1.45; background-color: #f6f8fa; border-radius: 3px; display: block; }
    blockquote { padding: 0 1em; color: #6a737d; border-left: 0.25em solid #dfe2e5; margin: 0 0 16px 0; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 16px; }
    table th, table td { border: 1px solid #dfe2e5; padding: 6px 13px; }
    table th { background-color: #f6f8fa; }
    img { max-width: 100%; }
    hr { height: 0.25em; padding: 0; margin: 24px 0; background-color: #e1e4e8; border: 0; }
    ul, ol { padding-left: 2em; margin-bottom: 16px; }
    li { word-wrap: break-all; }
  `;
}
electron.app.whenReady().then(() => {
  createWindow();
  registerS3Handlers();
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    electron.app.quit();
  }
});
