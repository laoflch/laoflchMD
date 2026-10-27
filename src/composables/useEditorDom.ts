import { shallowRef } from 'vue'

// ——— 编辑器 DOM 句柄（模块级单例） ———
// 应用内只有一个编辑器实例：Editor.vue 负责登记/注销自己的 DOM 节点，
// Pinia store 与 Outline 等外部代码一律通过本句柄访问，避免全局 querySelector 直查。
// 使用 shallowRef：仅替换节点引用，不深追踪 DOM 内部结构。

const textareaEl = shallowRef<HTMLTextAreaElement | null>(null)
const previewScrollEl = shallowRef<HTMLElement | null>(null)
const editableEl = shallowRef<HTMLElement | null>(null)
const codeEditorEl = shallowRef<CodeEditorHandle | null>(null)

export interface EditorDomRefs {
  /** 编辑/实时预览模式下的 textarea */
  textarea?: HTMLTextAreaElement | null
  /** 可滚动的预览容器（预览模式 .preview-scroll / 实时模式 .preview-pane） */
  previewScroll?: HTMLElement | null
  /** 预览模式下可编辑的 .preview-content[contenteditable="true"] */
  editable?: HTMLElement | null
}

/** CodeMirror 编辑器句柄：与 textarea 能力对齐，供 store / Outline 统一调用 */
export interface CodeEditorHandle {
  /** 在选区插入 before/after，返回插入后的完整文本；无选区能力时返回 null */
  insertAtSelection(before: string, after: string, current: string): string | null
  /** 当前光标字符偏移 */
  getSelectionOffset(): number
  /** 设置光标位置 */
  setSelection(pos: number): void
  focus(): void
  hasFocus(): boolean
  /** 滚动信息：滚动位置 / 内容总高 / 可视高度 */
  getScrollMetrics(): { top: number; height: number; clientHeight: number }
  setScrollTop(top: number): void
  /** 把指定行滚动到可视区域并定位光标 */
  scrollToLine(line: number, content: string): void
  /** 把当前查找匹配滚动到可视区域 */
  scrollToMatch(): void
}

function register(refs: EditorDomRefs): void {
  textareaEl.value = refs.textarea ?? null
  previewScrollEl.value = refs.previewScroll ?? null
  editableEl.value = refs.editable ?? null
}

function unregister(): void {
  textareaEl.value = null
  previewScrollEl.value = null
  editableEl.value = null
}

/** CodeMirror 组件挂载/卸载时登记句柄（与 textarea 句柄相互独立） */
function registerCodeEditor(handle: CodeEditorHandle | null): void {
  codeEditorEl.value = handle
}

/**
 * 在编辑器当前选区插入 before/after（CodeMirror 优先，其次 textarea）。
 * 返回插入后的完整文本；无可用编辑器节点时返回 null。
 */
function insertAtSelection(before: string, after: string, current: string): string | null {
  const code = codeEditorEl.value
  if (code) return code.insertAtSelection(before, after, current)

  const ta = textareaEl.value
  if (!ta) return null

  const start = ta.selectionStart
  const end = ta.selectionEnd
  const selectedText = current.substring(start, end)
  const result =
    current.substring(0, start) + before + selectedText + after + current.substring(end)

  // 光标定位到插入内容的末尾
  requestAnimationFrame(() => {
    ta.focus()
    ta.selectionStart = ta.selectionEnd = start + before.length + selectedText.length
  })
  return result
}

/** 读取预览模式可编辑内容的 HTML；无可用节点时返回 null */
function getEditableHtml(): string | null {
  return editableEl.value ? editableEl.value.innerHTML : null
}

/**
 * 大纲跳转：滚动预览区到对应标题（若存在），并将编辑区光标/滚动定位到指定行。
 */
function scrollToHeading(headingId: string, line: number, content: string): void {
  const container = previewScrollEl.value
  if (container) {
    const heading = container.querySelector(`#${headingId}`) as HTMLElement | null
    if (heading) {
      heading.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }
  scrollEditorToLine(line, content)
}

function scrollEditorToLine(line: number, content: string): void {
  const code = codeEditorEl.value
  if (code) {
    code.scrollToLine(line, content)
    return
  }

  const ta = textareaEl.value
  if (!ta) return

  const lines = content.split('\n')
  let charIndex = 0
  for (let i = 0; i < line; i++) {
    charIndex += lines[i].length + 1
  }

  // 将光标定位到标题行
  ta.selectionStart = ta.selectionEnd = charIndex
  ta.focus()

  // 用临时元素精确测量行高（考虑 padding）
  const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 22
  const paddingTop = parseFloat(getComputedStyle(ta).paddingTop) || 0
  const targetTop = line * lineHeight + paddingTop
  ta.scrollTop = targetTop - ta.clientHeight / 3
}

export function useEditorDom() {
  return {
    register,
    unregister,
    registerCodeEditor,
    insertAtSelection,
    getEditableHtml,
    scrollToHeading
  }
}
