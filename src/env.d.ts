/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

declare module 'markdown-it-task-lists'
declare module 'markdown-it-table-of-contents'

interface Window {
  api: {
    openFile: () => Promise<{ content: string; filePath: string } | null>
    saveFile: (content: string, filePath?: string) => Promise<string | null>
    saveFileAs: (content: string) => Promise<string | null>
    onFileOpened: (callback: (data: { content: string; filePath: string }) => void) => void
    getFilePath: () => Promise<string | null>
    setTitle: (title: string) => void
    exportHtml: (html: string) => Promise<void>
    exportPdf: (html: string) => Promise<void>
  }
}