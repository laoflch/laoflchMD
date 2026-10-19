import { ref } from 'vue'

// ——— 查找替换（模块级单例） ———
// 查找基于编辑器底层 Markdown 内容（store.content），对所有视图模式统一生效；
// 编辑/实时模式下由 Editor.vue 通过高亮层展示所有匹配，并在这里维护「当前匹配」索引。
// 替换通过 store.setContent 写入，自动进入撤销历史并标记未保存。

const isOpen = ref(false)
const showReplace = ref(false)
const query = ref('')
const replaceText = ref('')
const caseSensitive = ref(false)

const matches = ref<{ start: number; end: number }[]>([])
const currentIndex = ref(-1)

// 替换当前匹配后，用于把下一个匹配定位到替换区域之后
let pendingAnchor = -1

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function findMatches(text: string, q: string): { start: number; end: number }[] {
  if (!q) return []
  const results: { start: number; end: number }[] = []
  const flags = caseSensitive.value ? 'g' : 'gi'
  const regex = new RegExp(escapeRegExp(q), flags)
  let m: RegExpExecArray | null
  while ((m = regex.exec(text)) !== null) {
    results.push({ start: m.index, end: m.index + m[0].length })
    // 防死循环（空匹配时手动前进）
    if (m[0].length === 0) regex.lastIndex++
  }
  return results
}

/** 根据 query 在 content 上重算匹配集合与当前索引；pendingAnchor 由 replaceCurrent 设置 */
function recompute(content: string): void {
  matches.value = findMatches(content, query.value)
  if (!matches.value.length) {
    currentIndex.value = -1
    pendingAnchor = -1
    return
  }
  let index: number
  if (pendingAnchor >= 0) {
    const idx = matches.value.findIndex((m) => m.start >= pendingAnchor)
    index = idx === -1 ? matches.value.length - 1 : idx
    pendingAnchor = -1
  } else if (currentIndex.value >= matches.value.length) {
    index = matches.value.length - 1
  } else if (currentIndex.value < 0) {
    index = 0
  } else {
    index = currentIndex.value
  }
  currentIndex.value = index
}

function openFind(): void {
  isOpen.value = true
  showReplace.value = false
}

function openReplace(): void {
  isOpen.value = true
  showReplace.value = true
}

function close(): void {
  isOpen.value = false
  showReplace.value = false
  matches.value = []
  currentIndex.value = -1
  pendingAnchor = -1
}

function goTo(index: number): void {
  if (!matches.value.length) return
  const len = matches.value.length
  currentIndex.value = ((index % len) + len) % len
}

function next(): void {
  goTo(currentIndex.value + 1)
}

function prev(): void {
  goTo(currentIndex.value - 1)
}

/** 替换当前匹配，返回替换后的完整内容；无当前匹配时返回 null */
function replaceCurrent(content: string): string | null {
  const m = matches.value[currentIndex.value]
  if (!m) return null
  const result = content.slice(0, m.start) + replaceText.value + content.slice(m.end)
  pendingAnchor = m.start + replaceText.value.length
  return result
}

/** 全部替换，返回替换后的完整内容；无匹配或结果不变时返回 null */
function replaceAll(content: string): string | null {
  if (!query.value) return null
  const flags = caseSensitive.value ? 'g' : 'gi'
  const result = content.replace(new RegExp(escapeRegExp(query.value), flags), replaceText.value)
  return result === content ? null : result
}

function toggleCase(): void {
  caseSensitive.value = !caseSensitive.value
}

export function useFindReplace() {
  return {
    isOpen,
    showReplace,
    query,
    replaceText,
    caseSensitive,
    matches,
    currentIndex,
    openFind,
    openReplace,
    close,
    recompute,
    next,
    prev,
    replaceCurrent,
    replaceAll,
    toggleCase
  }
}
