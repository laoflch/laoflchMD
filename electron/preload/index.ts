import { contextBridge, ipcRenderer } from 'electron'

// S3 连接配置
interface S3Config {
  endpoint?: string
  region?: string
  accessKeyId: string
  secretAccessKey: string
}

contextBridge.exposeInMainWorld('api', {
  // S3 object storage operations
  s3ListBuckets: (config: S3Config) => ipcRenderer.invoke('s3:listBuckets', config),
  s3ListObjects: (config: S3Config, bucket: string, prefix: string) =>
    ipcRenderer.invoke('s3:listObjects', config, bucket, prefix),
  s3GetObject: (config: S3Config, bucket: string, key: string) =>
    ipcRenderer.invoke('s3:getObject', config, bucket, key),
  s3PutObject: (config: S3Config, bucket: string, key: string, content: string) =>
    ipcRenderer.invoke('s3:putObject', config, bucket, key, content),

  // File operations
  openFile: () => ipcRenderer.invoke('dialog:openFile'),
  saveFile: (content: string, filePath?: string) =>
    ipcRenderer.invoke('dialog:saveFile', content, filePath),
  saveFileAs: (content: string) => ipcRenderer.invoke('dialog:saveFileAs', content),
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

  // System theme detection
  getSystemTheme: () => ipcRenderer.invoke('getSystemTheme'),
  onSystemThemeChanged: (callback: (isDark: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, isDark: boolean) => callback(isDark)
    ipcRenderer.on('system-theme-changed', handler)
    return () => ipcRenderer.removeListener('system-theme-changed', handler)
  }
})