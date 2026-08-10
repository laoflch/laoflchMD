import { app, BrowserWindow, ipcMain, dialog, Menu, nativeTheme } from 'electron'
import { join, dirname, basename } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, renameSync, unlinkSync, rmdirSync } from 'fs'
import { registerS3Handlers } from './s3'
import { VERSION_NOTES, type VersionNote } from './versionInfo'

let mainWindow: BrowserWindow | null = null

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
    mainWindow?.show()
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
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow?.webContents.send('menu-save-file')
        },
        {
          label: '另存为',
          accelerator: 'CmdOrCtrl+Shift+S',
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
      writeFileSync(filePath, content, 'utf-8')
      return filePath
    }

    const result = await dialog.showSaveDialog(mainWindow, {
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })

    if (result.canceled || !result.filePath) return null

    writeFileSync(result.filePath, content, 'utf-8')
    return result.filePath
  } catch (err) {
    console.error('Save file error:', err)
    return null
  }
})

ipcMain.handle('dialog:saveFileAs', async (_event, content: string) => {
  if (!mainWindow) return null

  const result = await dialog.showSaveDialog(mainWindow, {
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  })

  if (result.canceled || !result.filePath) return null

  writeFileSync(result.filePath, content, 'utf-8')
  return result.filePath
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
    const result: Array<{ name: string; path: string; isDirectory: boolean; isMarkdown: boolean }> = []

    for (const entry of entries) {
      // Skip hidden files/directories
      if (entry.startsWith('.')) continue

      const fullPath = join(dirPath, entry)
      const stats = statSync(fullPath)
      const isDir = stats.isDirectory()
      const ext = entry.toLowerCase()
      const isMarkdownFile = !isDir && ['.md', '.markdown', '.mdown'].some(e => ext.endsWith(e))

      // Only show directories and markdown files
      if (isDir || isMarkdownFile) {
        result.push({
          name: entry,
          path: fullPath,
          isDirectory: isDir,
          isMarkdown: isMarkdownFile
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
  createWindow()
  registerS3Handlers()

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