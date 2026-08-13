import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  // File operations
  openFile: () => ipcRenderer.invoke('dialog:openFile'),
  saveFile: (content: string, filePath?: string) =>
    ipcRenderer.invoke('dialog:saveFile', content, filePath),
  saveFileAs: (content: string, defaultName?: string) =>
    ipcRenderer.invoke('dialog:saveFileAs', content, defaultName),
  getFilePath: () => ipcRenderer.invoke('getFilePath'),
  setTitle: (title: string) => ipcRenderer.invoke('setTitle', title),
  exportHtml: (html: string) => ipcRenderer.invoke('export:html', html),
  exportPdf: (html: string) => ipcRenderer.invoke('export:pdf', html),

  // Window controls
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  onMaximizedChanged: (callback: (maximized: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, maximized: boolean) => callback(maximized)
    ipcRenderer.on('window:maximized-changed', handler)
    return () => ipcRenderer.removeListener('window:maximized-changed', handler)
  },

  // File tree operations
  readFile: (filePath: string) => ipcRenderer.invoke('filetree:readFile', filePath),
  readDir: (dirPath: string) => ipcRenderer.invoke('filetree:readDir', dirPath),
  openDirectory: () => ipcRenderer.invoke('filetree:openDirectory'),
  getFileDir: (filePath: string) => ipcRenderer.invoke('filetree:getFileDir', filePath),
  newFile: (dirPath: string) => ipcRenderer.invoke('filetree:newFile', dirPath),
  newFolder: (dirPath: string) => ipcRenderer.invoke('filetree:newFolder', dirPath),
  rename: (oldPath: string, newName: string) => ipcRenderer.invoke('filetree:rename', oldPath, newName),
  delete: (targetPath: string) => ipcRenderer.invoke('filetree:delete', targetPath),

  // Menu event listeners
  onNewFile: (callback: () => void) => {
    ipcRenderer.on('menu-new-file', callback)
    return () => ipcRenderer.removeListener('menu-new-file', callback)
  },
  onOpenFile: (callback: () => void) => {
    ipcRenderer.on('menu-open-file', callback)
    return () => ipcRenderer.removeListener('menu-open-file', callback)
  },
  onSaveFile: (callback: () => void) => {
    ipcRenderer.on('menu-save-file', callback)
    return () => ipcRenderer.removeListener('menu-save-file', callback)
  },
  onSaveAsFile: (callback: () => void) => {
    ipcRenderer.on('menu-save-as-file', callback)
    return () => ipcRenderer.removeListener('menu-save-as-file', callback)
  },
  onExportHtml: (callback: () => void) => {
    ipcRenderer.on('menu-export-html', callback)
    return () => ipcRenderer.removeListener('menu-export-html', callback)
  },
  onExportPdf: (callback: () => void) => {
    ipcRenderer.on('menu-export-pdf', callback)
    return () => ipcRenderer.removeListener('menu-export-pdf', callback)
  },
  onToggleTheme: (callback: () => void) => {
    ipcRenderer.on('menu-toggle-theme', callback)
    return () => ipcRenderer.removeListener('menu-toggle-theme', callback)
  },
  onToggleSidebar: (callback: () => void) => {
    ipcRenderer.on('menu-toggle-sidebar', callback)
    return () => ipcRenderer.removeListener('menu-toggle-sidebar', callback)
  },
  onAbout: (callback: () => void) => {
    ipcRenderer.on('menu-about', callback)
    return () => ipcRenderer.removeListener('menu-about', callback)
  },
  getAppInfo: () => ipcRenderer.invoke('app:getInfo'),

  // System theme detection
  getSystemTheme: () => ipcRenderer.invoke('getSystemTheme'),
  onSystemThemeChanged: (callback: (isDark: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, isDark: boolean) => callback(isDark)
    ipcRenderer.on('system-theme-changed', handler)
    return () => ipcRenderer.removeListener('system-theme-changed', handler)
  },

  // S3 operations
  s3ListBuckets: (config: any) => ipcRenderer.invoke('s3:listBuckets', config),
  s3ListObjects: (config: any, bucket: string, prefix: string) =>
    ipcRenderer.invoke('s3:listObjects', config, bucket, prefix),
  s3GetObject: (config: any, bucket: string, key: string) =>
    ipcRenderer.invoke('s3:getObject', config, bucket, key),
  s3PutObject: (config: any, bucket: string, key: string, content: string) =>
    ipcRenderer.invoke('s3:putObject', config, bucket, key, content),
  s3DeleteObject: (config: any, bucket: string, key: string) =>
    ipcRenderer.invoke('s3:deleteObject', config, bucket, key)
})