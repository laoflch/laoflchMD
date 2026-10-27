import { app, BrowserWindow, ipcMain, dialog, Menu, nativeTheme } from 'electron'
import { join, dirname, basename, extname } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, renameSync, unlinkSync, rmdirSync } from 'fs'
import { registerS3Handlers } from './s3'
import { registerIndexSearchHandlers } from './indexSearch'
import { registerVectorIndexHandlers } from './indexVector'
import { VERSION_NOTES, type VersionNote } from './versionInfo'

let mainWindow: BrowserWindow | null = null
let splashWindow: BrowserWindow | null = null

function getAppVersion(): string {
  try {
    const pkgPath = join(app.getAppPath(), 'package.json')
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      if (pkg.version) return pkg.version
    }
  } catch {
    // ignore
  }
  return app.getVersion()
}

function getSplashHtml(version: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>LaoflchMD</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:100%;height:100%;overflow:hidden;user-select:none;-webkit-user-select:none}
    body{
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
      background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      color:#fff;position:relative;-webkit-app-region:drag;
    }
    /* 背景装饰光斑 */
    .blob{position:absolute;border-radius:50%;filter:blur(60px);opacity:.35;z-index:0}
    .blob.b1{width:280px;height:280px;background:#7c3aed;top:-80px;right:-60px}
    .blob.b2{width:220px;height:220px;background:#06b6d4;bottom:-60px;left:-40px}
    .blob.b3{width:160px;height:160px;background:#ec4899;top:40%;left:-30px;opacity:.2}
    /* Logo 容器 */
    .logo-wrap{
      width:110px;height:110px;border-radius:28px;
      background:rgba(255,255,255,.18);
      backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);
      border:1.5px solid rgba(255,255,255,.3);
      display:flex;align-items:center;justify-content:center;
      margin-bottom:24px;z-index:1;
      box-shadow:
        0 20px 50px rgba(0,0,0,.25),
        0 8px 20px rgba(0,0,0,.15),
        inset 0 1px 0 rgba(255,255,255,.3);
      animation:float 3.5s ease-in-out infinite;
    }
    .logo-wrap .icon{font-size:54px;filter:drop-shadow(0 4px 8px rgba(0,0,0,.2))}
    @keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
    .name{font-size:34px;font-weight:700;margin-bottom:8px;z-index:1;letter-spacing:1px;
      text-shadow:0 2px 10px rgba(0,0,0,.15)}
    .desc{font-size:15px;opacity:.8;margin-bottom:48px;z-index:1;letter-spacing:.5px}
    .wrap{width:300px;z-index:1}
    .bar{
      width:100%;height:6px;
      background:rgba(255,255,255,.18);
      border-radius:3px;overflow:hidden;margin-bottom:16px;
      box-shadow:inset 0 1px 3px rgba(0,0,0,.1);
    }
    .fill{
      height:100%;
      background:linear-gradient(90deg,#fff 0%,#e0e7ff 100%);
      border-radius:3px;width:0%;
      transition:width .35s cubic-bezier(.4,0,.2,1);
      box-shadow:0 0 16px rgba(255,255,255,.6),0 0 4px rgba(255,255,255,.8);
      position:relative;
    }
    .fill::after{
      content:'';position:absolute;top:0;right:0;bottom:0;
      width:20px;
      background:linear-gradient(90deg,transparent,rgba(255,255,255,.6),transparent);
      animation:shine 1.5s infinite;
    }
    @keyframes shine{0%{transform:translateX(-100%)}100%{transform:translateX(280px)}}
    .text{font-size:13px;opacity:.78;text-align:center;min-height:20px;letter-spacing:.3px}
    .ver{position:absolute;bottom:28px;left:0;right:0;text-align:center;font-size:12px;opacity:.55;z-index:1;letter-spacing:.5px}
  </style>
</head>
<body>
  <div class="blob b1"></div>
  <div class="blob b2"></div>
  <div class="blob b3"></div>
  <div class="logo-wrap"><div class="icon">📝</div></div>
  <div class="name">LaoflchMD</div>
  <div class="desc">跨平台 Markdown 编辑器</div>
  <div class="wrap">
    <div class="bar"><div class="fill" id="f"></div></div>
    <div class="text" id="t">正在初始化...</div>
  </div>
  <div class="ver">v${version}</div>
  <script>
    const{ipcRenderer}=require('electron')
    const f=document.getElementById('f'),t=document.getElementById('t')
    ipcRenderer.on('splash:progress',(_e,p,msg)=>{
      f.style.width=Math.max(0,Math.min(100,p))+'%'
      if(msg)t.textContent=msg
    })
  </script>
</body>
</html>`
}

function createSplashWindow(): void {
  const version = getAppVersion()

  splashWindow = new BrowserWindow({
    width: 560,
    height: 400,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    center: true,
    show: true,
    backgroundColor: '#667eea',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(getSplashHtml(version))
  splashWindow.loadURL(dataUrl)
}

function updateSplashProgress(progress: number, message?: string): void {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('splash:progress', progress, message)
  }
}

function closeSplash(): void {
  if (splashWindow && !splashWindow.isDestroyed()) {
    // 先推进到 100% 再关闭，视觉更自然
    updateSplashProgress(100, '加载完成')
    setTimeout(() => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close()
        splashWindow = null
      }
    }, 120)
  }
}

// 支持预览/编辑的文件类型：Markdown、YAML、HTML、Jinja2 模板
type PreviewFileType = 'markdown' | 'yaml' | 'html' | 'jinja'

function detectFileType(fileName: string): PreviewFileType | null {
  const lower = fileName.toLowerCase()
  if (/\.(md|markdown|mdown|mdx)$/.test(lower)) return 'markdown'
  if (/\.ya?ml$/.test(lower)) return 'yaml'
  if (/\.html?$/.test(lower)) return 'html'
  if (/\.j2$/.test(lower)) return 'jinja'
  return null
}

// 若文件名无 .md 后缀则自动补上（仅在没有扩展名或扩展名不是常见 markdown 后缀时）
function ensureMdExtension(filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  const mdExts = ['.md', '.markdown', '.mdown', '.mdx']
  if (mdExts.includes(ext)) return filePath
  // 如果已有其他扩展名（用户明确指定），保留
  if (ext && ext !== '.') return filePath
  return filePath + '.md'
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    show: false
  })

  mainWindow.on('ready-to-show', () => {
    // 主窗口准备好后，关闭闪屏再显示主窗口
    closeSplash()
    setTimeout(() => {
      mainWindow?.show()
      updateSplashProgress(100)
    }, 80)
  })

  // 加载阶段反馈：让闪屏进度在最后一段持续推进，而不是停在 65%
  mainWindow.webContents.on('did-start-loading', () => {
    updateSplashProgress(55, '加载界面资源...')
  })
  mainWindow.webContents.on('dom-ready', () => {
    updateSplashProgress(80, '渲染界面...')
  })
  mainWindow.webContents.on('did-finish-load', () => {
    updateSplashProgress(92, '即将完成...')
  })

  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window:maximized-changed', true)
  })

  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window:maximized-changed', false)
  })

  // Build application menu
  const menuTemplate: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        {
          label: '新建',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow?.webContents.send('menu-new-file')
        },
        {
          label: '打开',
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow?.webContents.send('menu-open-file')
        },
        {
          label: '保存',
          click: () => mainWindow?.webContents.send('menu-save-file')
        },
        {
          label: '另存为',
          click: () => mainWindow?.webContents.send('menu-save-as-file')
        },
        { type: 'separator' },
        {
          label: '导出 HTML',
          click: () => mainWindow?.webContents.send('menu-export-html')
        },
        {
          label: '导出 PDF',
          click: () => mainWindow?.webContents.send('menu-export-pdf')
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新' },
        { role: 'forceReload', label: '强制刷新' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { type: 'separator' },
        {
          label: '切换侧边栏',
          accelerator: 'CmdOrCtrl+Shift+L',
          click: () => mainWindow?.webContents.send('menu-toggle-sidebar')
        }
      ]
    },
    {
      label: '主题',
      submenu: [
        {
          label: '切换亮色/暗色主题',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => mainWindow?.webContents.send('menu-toggle-theme')
        }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 LaoflchMD',
          accelerator: 'CmdOrCtrl+Shift+A',
          click: () => mainWindow?.webContents.send('menu-about')
        }
      ]
    }
  ]

  // macOS specific menu
  if (process.platform === 'darwin') {
    menuTemplate.unshift({
      label: app.name,
      submenu: [
        { role: 'about', label: '关于' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '显示全部' },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    })
  }

  const menu = Menu.buildFromTemplate(menuTemplate)
  Menu.setApplicationMenu(menu)

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// System theme detection
ipcMain.handle('getSystemTheme', () => {
  return nativeTheme.shouldUseDarkColors
})

// App version & version notes
ipcMain.handle('app:getInfo', () => {
  let version = app.getVersion()
  try {
    const pkgPath = join(app.getAppPath(), 'package.json')
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      if (pkg.version) version = pkg.version
    }
  } catch {
    // fallback to app.getVersion()
  }
  return {
    version,
    notes: VERSION_NOTES
  }
})

// Watch for OS theme changes
nativeTheme.on('updated', () => {
  mainWindow?.webContents.send('system-theme-changed', nativeTheme.shouldUseDarkColors)
})

// IPC Handlers for file operations
ipcMain.handle('dialog:openFile', async () => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mdx'] },
      { name: 'YAML', extensions: ['yml', 'yaml'] },
      { name: 'HTML', extensions: ['html', 'htm'] },
      { name: 'Jinja2', extensions: ['j2'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  })

  if (result.canceled || result.filePaths.length === 0) return null

  const filePath = result.filePaths[0]
  const content = readFileSync(filePath, 'utf-8')
  return { content, filePath }
})

ipcMain.handle('dialog:saveFile', async (_event, content: string, filePath?: string) => {
  if (!mainWindow) return null

  try {
    if (filePath) {
      const finalPath = ensureMdExtension(filePath)
      writeFileSync(finalPath, content, 'utf-8')
      return finalPath
    }

    const result = await dialog.showSaveDialog(mainWindow, {
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })

    if (result.canceled || !result.filePath) return null

    const finalPath = ensureMdExtension(result.filePath)
    writeFileSync(finalPath, content, 'utf-8')
    return finalPath
  } catch (err) {
    console.error('Save file error:', err)
    return null
  }
})

ipcMain.handle('dialog:saveFileAs', async (_event, content: string, defaultName?: string) => {
  if (!mainWindow) return null

  const options: Electron.SaveDialogOptions = {
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  }
  if (defaultName) {
    options.defaultPath = defaultName
  }

  const result = await dialog.showSaveDialog(mainWindow, options)

  if (result.canceled || !result.filePath) return null

  const finalPath = ensureMdExtension(result.filePath)
  writeFileSync(finalPath, content, 'utf-8')
  return finalPath
})

ipcMain.handle('setTitle', (_event, title: string) => {
  if (mainWindow) {
    mainWindow.setTitle(title ? `${title} - LaoflchMD` : 'LaoflchMD')
  }
})

ipcMain.handle('getFilePath', () => {
  return null // State is managed in renderer
})

// Window control IPC handlers
ipcMain.handle('window:minimize', () => {
  mainWindow?.minimize()
})

ipcMain.handle('window:maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize()
  } else {
    mainWindow?.maximize()
  }
})

ipcMain.handle('window:close', () => {
  mainWindow?.close()
})

ipcMain.handle('window:isMaximized', () => {
  return mainWindow?.isMaximized() ?? false
})

ipcMain.handle('export:html', async (_event, html: string) => {
  if (!mainWindow) return

  const result = await dialog.showSaveDialog(mainWindow, {
    filters: [
      { name: 'HTML', extensions: ['html', 'htm'] }
    ]
  })

  if (result.canceled || !result.filePath) return

  const fullHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${mainWindow?.getTitle() || 'Markdown Export'}</title>
  <style>
    body { max-width: 860px; margin: 0 auto; padding: 40px 20px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif; line-height: 1.6; }
    ${getExportStyles()}
  </style>
</head>
<body>${html}</body>
</html>`

  writeFileSync(result.filePath, fullHtml, 'utf-8')
})

ipcMain.handle('export:pdf', async (_event, html: string) => {
  if (!mainWindow) return

  const result = await dialog.showSaveDialog(mainWindow, {
    filters: [
      { name: 'PDF', extensions: ['pdf'] }
    ]
  })

  if (result.canceled || !result.filePath) return

  // Create a hidden BrowserWindow for PDF generation
  const printWindow = new BrowserWindow({
    width: 860,
    height: 1100,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  })

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
</html>`

  await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fullHtml)}`)

  const pdfData = await printWindow.webContents.printToPDF({
    printBackground: true,
    margins: { top: 20, bottom: 20, left: 20, right: 20 }
  })

  writeFileSync(result.filePath, pdfData)
  printWindow.close()
})

// File tree IPC handlers
ipcMain.handle('filetree:readFile', async (_event, filePath: string) => {
  try {
    const content = readFileSync(filePath, 'utf-8')
    return content
  } catch {
    return null
  }
})

ipcMain.handle('filetree:readDir', async (_event, dirPath: string) => {
  try {
    const entries = readdirSync(dirPath)
    const result: Array<{
      name: string
      path: string
      isDirectory: boolean
      isMarkdown: boolean
      fileType: PreviewFileType | null
    }> = []

    for (const entry of entries) {
      // Skip hidden files/directories
      if (entry.startsWith('.')) continue

      const fullPath = join(dirPath, entry)
      const stats = statSync(fullPath)
      const isDir = stats.isDirectory()
      const fileType = isDir ? null : detectFileType(entry)

      // Only show directories and supported (Markdown / YAML / HTML) files
      if (isDir || fileType) {
        result.push({
          name: entry,
          path: fullPath,
          isDirectory: isDir,
          isMarkdown: fileType === 'markdown',
          fileType
        })
      }
    }

    // Sort: directories first, then by name
    result.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })

    return result
  } catch {
    return []
  }
})

// 文件树搜索：在指定目录及子目录中按文件名包含匹配支持的文件（Markdown / YAML / HTML）
ipcMain.handle('filetree:searchFiles', async (_event, rootPath: string, keyword: string) => {
  const q = (keyword || '').trim().toLowerCase()
  if (!rootPath || !q) return []

  const MAX_RESULTS = 200
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'release'])
  const results: Array<{ name: string; path: string; relativePath: string }> = []

  const walk = (dir: string, rel: string) => {
    if (results.length >= MAX_RESULTS) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (results.length >= MAX_RESULTS) return
      if (entry.startsWith('.')) continue
      const fullPath = join(dir, entry)
      const relPath = rel ? `${rel}/${entry}` : entry
      let stats
      try {
        stats = statSync(fullPath)
      } catch {
        continue
      }
      if (stats.isDirectory()) {
        if (!SKIP_DIRS.has(entry)) walk(fullPath, relPath)
        continue
      }
      const lower = entry.toLowerCase()
      if (detectFileType(entry) && lower.includes(q)) {
        results.push({ name: entry, path: fullPath, relativePath: relPath })
      }
    }
  }

  walk(rootPath, '')
  results.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  return results
})

// 应用级简单状态持久化（如上次打开的目录）：写入 userData/app-state.json，避免 localStorage 延迟落盘导致丢失
function appStatePath(): string {
  return join(app.getPath('userData'), 'app-state.json')
}

function readAppState(): Record<string, string> {
  try {
    const raw = readFileSync(appStatePath(), 'utf-8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

ipcMain.handle('appState:get', (_event, key: string) => {
  const value = readAppState()[key]
  return typeof value === 'string' ? value : null
})

ipcMain.handle('appState:set', (_event, key: string, value: string) => {
  try {
    const state = readAppState()
    state[key] = value
    writeFileSync(appStatePath(), JSON.stringify(state), 'utf-8')
    return true
  } catch {
    return false
  }
})

ipcMain.handle('filetree:openDirectory', async () => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.handle('filetree:getFileDir', async (_event, filePath: string) => {
  if (!filePath) return null
  return dirname(filePath)
})

ipcMain.handle('filetree:newFile', async (_event, dirPath: string) => {
  if (!mainWindow) return null

  // Find a unique name for the new file
  let index = 1
  let fileName = `untitled-${index}.md`
  while (existsSync(join(dirPath, fileName))) {
    index++
    fileName = `untitled-${index}.md`
  }

  const filePath = join(dirPath, fileName)
  writeFileSync(filePath, '', 'utf-8')
  return { name: fileName, path: filePath }
})

ipcMain.handle('filetree:newFolder', async (_event, dirPath: string) => {
  let index = 1
  let folderName = `new-folder-${index}`
  while (existsSync(join(dirPath, folderName))) {
    index++
    folderName = `new-folder-${index}`
  }

  const folderPath = join(dirPath, folderName)
  mkdirSync(folderPath, { recursive: true })
  return { name: folderName, path: folderPath }
})

ipcMain.handle('filetree:rename', async (_event, oldPath: string, newName: string) => {
  try {
    const dir = dirname(oldPath)
    const newPath = join(dir, newName)
    renameSync(oldPath, newPath)
    return newPath
  } catch {
    return null
  }
})

ipcMain.handle('filetree:delete', async (_event, targetPath: string) => {
  if (!mainWindow) return false

  const stats = statSync(targetPath)
  const name = basename(targetPath)
  const isDir = stats.isDirectory()

  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['取消', '删除'],
    defaultId: 0,
    title: '确认删除',
    message: isDir ? `确定删除文件夹 "${name}" 及其所有内容？` : `确定删除文件 "${name}"？`
  })

  if (result.response !== 1) return false

  try {
    if (isDir) {
      // Simple recursive delete for directories
      const deleteRecursive = (dirPath: string) => {
        const entries = readdirSync(dirPath)
        for (const entry of entries) {
          const fullPath = join(dirPath, entry)
          const entryStat = statSync(fullPath)
          if (entryStat.isDirectory()) {
            deleteRecursive(fullPath)
          } else {
            unlinkSync(fullPath)
          }
        }
        rmdirSync(dirPath)
      }
      deleteRecursive(targetPath)
    } else {
      unlinkSync(targetPath)
    }
    return true
  } catch {
    return false
  }
})

function getExportStyles(): string {
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
  `
}

app.whenReady().then(() => {
  // 先显示闪屏窗口（闪屏窗口轻量，立即展示）
  createSplashWindow()
  updateSplashProgress(15, '正在启动应用...')

  // 让闪屏先绘制，再创建主窗口（主窗口较重，避免抢占资源导致闪屏卡）
  setTimeout(() => {
    updateSplashProgress(30, '加载编辑器组件...')
    createWindow()
    registerS3Handlers()
    registerIndexSearchHandlers()
    registerVectorIndexHandlers()
    updateSplashProgress(50, '初始化服务...')
  }, 50)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})