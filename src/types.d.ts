export {}

declare global {
  interface Window {
    api: {
      // File operations
      openFile: () => Promise<{ content: string; filePath: string } | null>
      saveFile: (content: string, filePath?: string) => Promise<string | null>
      saveFileAs: (content: string) => Promise<string | null>
      getFilePath: () => Promise<string | null>
      setTitle: (title: string) => Promise<void>
      exportHtml: (html: string) => Promise<void>
      exportPdf: (html: string) => Promise<void>

      // Window controls
      minimizeWindow: () => Promise<void>
      maximizeWindow: () => Promise<void>
      closeWindow: () => Promise<void>
      isMaximized: () => Promise<boolean>
      onMaximizedChanged: (callback: (maximized: boolean) => void) => () => void

      // File tree operations
      readFile: (filePath: string) => Promise<string | null>
      readDir: (dirPath: string) => Promise<FileEntry[]>
      openDirectory: () => Promise<string | null>
      getFileDir: (filePath: string) => Promise<string | null>
      newFile: (dirPath: string) => Promise<{ name: string; path: string } | null>
      newFolder: (dirPath: string) => Promise<{ name: string; path: string } | null>
      rename: (oldPath: string, newName: string) => Promise<string | null>
      delete: (targetPath: string) => Promise<boolean>

      // Menu event listeners
      onNewFile: (callback: () => void) => () => void
      onOpenFile: (callback: () => void) => () => void
      onSaveFile: (callback: () => void) => () => void
      onSaveAsFile: (callback: () => void) => () => void
      onExportHtml: (callback: () => void) => () => void
      onExportPdf: (callback: () => void) => () => void
      onToggleTheme: (callback: () => void) => () => void
      onToggleSidebar: (callback: () => void) => () => void

      // System theme detection
      getSystemTheme: () => Promise<boolean>
      onSystemThemeChanged: (callback: (isDark: boolean) => void) => () => void
    }
  }
}

export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  isMarkdown: boolean
}