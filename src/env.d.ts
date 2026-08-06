/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

declare module 'markdown-it-task-lists'
declare module 'markdown-it-table-of-contents'

// NOTE: 完整的 window.api 类型定义见 types.d.ts（declare global），
// 此处不再重复声明，避免与权威声明冲突导致类型缺失。