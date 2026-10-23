import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface Toast {
  id: number
  type: 'ok' | 'err' | 'progress'
  text: string
  /** false 表示不会自动消失（如进度提示），需手动 remove */
  autoClose: boolean
}

let toastSeq = 0

/**
 * 全局右上角提示 store：供各组件（如生成索引）推送轻量提示，由 App.vue 渲染。
 * 进度提示（type='progress'，autoClose=false）用于索引目录时逐文件显示进度。
 */
export const useToastStore = defineStore('toast', () => {
  const toasts = ref<Toast[]>([])

  function pushToast(type: 'ok' | 'err' | 'progress', text: string, autoClose = true, delayMs = 5000): number {
    const id = ++toastSeq
    toasts.value.push({ id, type, text, autoClose })
    if (autoClose) setTimeout(() => removeToast(id), delayMs)
    return id
  }

  function updateToast(id: number, text: string) {
    const t = toasts.value.find(t => t.id === id)
    if (t) t.text = text
  }

  function removeToast(id: number) {
    const i = toasts.value.findIndex(t => t.id === id)
    if (i >= 0) toasts.value.splice(i, 1)
  }

  return { toasts, pushToast, updateToast, removeToast }
})
