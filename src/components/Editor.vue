<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useDragDivider } from '../composables/useDragDivider'
import { useEditorDom } from '../composables/useEditorDom'
import { useFindReplace } from '../composables/useFindReplace'
import { useEditorStore } from '../stores/editor'
import { useS3Store } from '../stores/s3'
import { useSettingsStore } from '../stores/settings'
import CodeMirrorEditor from './CodeMirrorEditor.vue'

const store = useEditorStore()
const s3 = useS3Store()
const settings = useSettingsStore()
const editorDom = useEditorDom()
const findReplace = useFindReplace()
const { isOpen, showReplace, query, replaceText, matches, currentIndex, caseSensitive } = useFindReplace()

const splitRatio = ref(0.5)
const zoom = ref(1)
let containerWidth = 1
let startRatio = 0

// 编辑器 DOM 节点引用：登记到句柄层，供 store / Outline 使用（替代全局 querySelector）
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const previewScrollRef = ref<HTMLElement | null>(null)
const editableRef = ref<HTMLElement | null>(null)
// CodeMirror 编辑器实例（全局设置开启时使用）
const cmRef = ref<InstanceType<typeof CodeMirrorEditor> | null>(null)

// 查找替换 UI 引用
const findInputRef = ref<HTMLInputElement | null>(null)
const replaceInputRef = ref<HTMLInputElement | null>(null)
const hlLayerRef = ref<HTMLElement | null>(null)

// 视图模式切换 / 挂载卸载时，把当前可见的编辑器节点同步到句柄层
watch(
  [textareaRef, previewScrollRef, editableRef],
  () => {
    editorDom.register({
      textarea: textareaRef.value,
      previewScroll: previewScrollRef.value,
      editable: editableRef.value
    })
  },
  { immediate: true }
)

// 预览模式内容渲染：手动写入 innerHTML，避免 v-html 整体覆盖正在编辑的 contenteditable DOM。
// 用户编辑后（previewDirty=true）renderedHtml 更新不再覆盖，直到保存成功（isModified=false）再允许刷新，
// 确保 Ctrl+S 时 getEditableHtml() 读到的是用户编辑后的完整内容。
const previewDirty = ref(false)

watch(
  [() => store.viewMode, () => store.renderedHtml, editableRef],
  () => {
    const el = editableRef.value
    if (!el || store.viewMode !== 'preview') return
    if (previewDirty.value) return
    el.innerHTML = store.renderedHtml
  },
  { immediate: true }
)

// 保存成功（isModified 变 false）后，允许渲染结果刷新到预览 DOM
watch(
  () => store.isModified,
  (m) => {
    if (!m) previewDirty.value = false
  }
)

// 重新进入预览模式时：重置 dirty，并用最新 content 渲染后再写入，
// 避免异步渲染未完成时预览显示旧内容（如编辑产生的换行「消失」）
watch(
  () => store.viewMode,
  async (m, old) => {
    if (m === 'preview' && old !== 'preview') {
      previewDirty.value = false
      const html = await store.ensureRendered()
      const el = editableRef.value
      if (el) el.innerHTML = html
    }
  }
)

function handleCtrlWheel(e: WheelEvent) {
  if (!e.ctrlKey) return
  e.preventDefault()
  if (e.deltaY < 0) {
    zoom.value = Math.min(2, zoom.value + 0.1)
  } else {
    zoom.value = Math.max(0.5, zoom.value - 0.1)
  }
}

// 本机主机名（本地文件地址显示用）
const hostname = ref('')

// 当前打开文件地址：本地 = 主机名 + 绝对路径；S3 = 完整协议与地址
const statusPath = computed(() => {
  if (store.s3Source) {
    const cfg = s3.plainConfig()
    const endpoint = (cfg.endpoint || 's3.amazonaws.com').replace(/^https?:\/\//i, '')
    return `s3://${endpoint}/${store.s3Source.bucket}/${store.s3Source.key}`
  }
  if (store.filePath) {
    return `${hostname.value}${store.filePath}`
  }
  return ''
})

// 编辑区占位提示：按文件类型区分
const editorPlaceholder = computed(() =>
  store.fileType === 'yaml'
    ? '在此输入 YAML...'
    : store.fileType === 'html'
      ? '在此编辑 HTML...'
      : store.fileType === 'jinja'
        ? '在此编辑 Jinja2 模板...'
        : '在此输入 Markdown...'
)

onMounted(() => {
  document.addEventListener('wheel', handleCtrlWheel, { passive: false })
  if (window.api.getHostname) {
    window.api.getHostname().then((h) => (hostname.value = h)).catch(() => {})
  }
})

onUnmounted(() => {
  document.removeEventListener('wheel', handleCtrlWheel)
  editorDom.unregister()
})

const { isDragging, startDrag: onDividerMouseDown } = useDragDivider({
  preventDefault: false,
  onDragStart: (e: MouseEvent) => {
    const divider = e.currentTarget as HTMLElement
    const container = divider.closest('.live-pane') as HTMLElement
    if (!container) return
    containerWidth = container.offsetWidth
    startRatio = splitRatio.value
  },
  onDragMove: (deltaX) => {
    splitRatio.value = Math.max(0.15, Math.min(0.85, startRatio + deltaX / containerWidth))
  }
})

// ——— 查找替换 ———

// ——— 预览模式查找替换（基于渲染后 DOM 文本节点） ———
// 渲染后的 HTML 文本与源 Markdown 不一致（语法被转换），无法用源偏移映射；
// 因此预览模式直接在 contenteditable DOM 的文本节点上查找/高亮，
// 替换则改写 DOM 后经 setContentFromHtml 回写 Markdown（重新渲染后自动恢复高亮）。
const previewMarkEls = ref<HTMLElement[]>([])
const previewCurrent = ref(-1)

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 移除预览 DOM 中已包裹的查找标记（还原为纯文本节点）
function removePreviewMarks() {
  const root = editableRef.value
  if (!root) return
  const marks = root.querySelectorAll('mark.preview-find')
  marks.forEach((m) => {
    const parent = m.parentNode
    if (!parent) return
    parent.replaceChild(document.createTextNode(m.textContent || ''), m)
  })
  root.normalize()
  previewMarkEls.value = []
  previewCurrent.value = -1
}

// 在预览 DOM 文本节点上按 query 查找所有匹配并包裹 <mark>（单个文本节点内匹配）
function applyPreviewFind() {
  const root = editableRef.value
  if (!root || store.viewMode !== 'preview') return
  // HTML 预览用 iframe 渲染，没有可查找的 DOM；Markdown / YAML / Jinja2 共用该 DOM
  const prevIdx = previewCurrent.value
  removePreviewMarks()
  const q = query.value
  if (!isOpen.value || !q) return
  const flags = caseSensitive.value ? 'g' : 'gi'
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  let node: Node | null
  while ((node = walker.nextNode())) {
    if (node.textContent && node.textContent.length) textNodes.push(node as Text)
  }
  const marks: HTMLElement[] = []
  for (const tn of textNodes) {
    const text = tn.textContent || ''
    const re = new RegExp(escapeRegExp(q), flags)
    const ranges: [number, number][] = []
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++
        continue
      }
      ranges.push([m.index, m.index + m[0].length])
    }
    if (!ranges.length) continue
    // 一次性重建该文本节点：前后文本 + 匹配段包裹 <mark>
    const frag = document.createDocumentFragment()
    let last = 0
    for (const [s, e] of ranges) {
      if (s > last) frag.appendChild(document.createTextNode(text.slice(last, s)))
      const mark = document.createElement('mark')
      mark.className = 'preview-find'
      mark.textContent = text.slice(s, e)
      marks.push(mark)
      frag.appendChild(mark)
      last = e
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)))
    tn.parentNode?.replaceChild(frag, tn)
  }
  previewMarkEls.value = marks
  previewCurrent.value = marks.length ? Math.min(Math.max(prevIdx, 0), marks.length - 1) : -1
  // 标记当前匹配
  previewMarkEls.value.forEach((m, i) => m.classList.toggle('current', i === previewCurrent.value))
  scrollPreviewToCurrent()
}

// 把当前匹配滚动到预览可视区域（基于视口坐标差计算滚动量）
function scrollPreviewToCurrent() {
  const mark = previewMarkEls.value[previewCurrent.value]
  const scroll = previewScrollRef.value
  if (!mark || !scroll) return
  const markTop = mark.getBoundingClientRect().top
  const scrollTop = scroll.getBoundingClientRect().top
  scroll.scrollTop += markTop - scrollTop - scroll.clientHeight / 2
}

// 预览模式前后导航（循环）
function previewStep(dir: number) {
  const len = previewMarkEls.value.length
  if (!len) return
  previewCurrent.value = (((previewCurrent.value + dir) % len) + len) % len
  previewMarkEls.value.forEach((m, i) => m.classList.toggle('current', i === previewCurrent.value))
  scrollPreviewToCurrent()
}

// 预览模式替换当前匹配：改写 DOM → 回写 Markdown（重新渲染后高亮自动恢复）
function replacePreviewCurrent() {
  const mark = previewMarkEls.value[previewCurrent.value]
  if (!mark) return
  mark.textContent = replaceText.value
  syncPreviewContent()
  // 若替换结果与源相同（不会触发重渲染），仍显式刷新高亮
  nextTick(() => {
    if (isOpen.value && store.viewMode === 'preview') applyPreviewFind()
  })
}

// 预览模式全部替换
function replaceAllPreview() {
  if (!previewMarkEls.value.length) return
  previewMarkEls.value.forEach((m) => {
    m.textContent = replaceText.value
  })
  syncPreviewContent()
  nextTick(() => {
    if (isOpen.value && store.viewMode === 'preview') applyPreviewFind()
  })
}

// 把预览 DOM 当前内容回写为 Markdown（走 store.setContentFromHtml，进入撤销历史并标记未保存）
function syncPreviewContent() {
  const editable = editableRef.value
  if (!editable) return
  store.setContentFromHtml(editable.innerHTML)
}

// 计数显示：预览模式用 DOM 匹配数，编辑/实时模式用源内容偏移匹配数
const countText = computed(() => {
  if (store.viewMode === 'preview') {
    const total = previewMarkEls.value.length
    return total ? `${previewCurrent.value + 1}/${total}` : '0/0'
  }
  return matches.value.length ? `${currentIndex.value + 1}/${matches.value.length}` : '0/0'
})

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// 高亮层内容：与 textarea 相同排版，把所有匹配包裹成 <mark>，当前匹配额外加 .current
const highlightHtml = computed(() => {
  const ms = matches.value
  const content = store.content
  if (!ms.length || !content) return ''
  let html = ''
  let last = 0
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i]
    html += escapeHtml(content.slice(last, m.start))
    html += `<mark${i === currentIndex.value ? ' class="current"' : ''}>${escapeHtml(content.slice(m.start, m.end))}</mark>`
    last = m.end
  }
  html += escapeHtml(content.slice(last))
  return html
})

// 打开 / 内容或查询变化 / 视图模式切换时重算匹配（编辑/实时模式）
watch([isOpen, query, () => store.content, () => store.viewMode], () => {
  if (!isOpen.value) return
  findReplace.recompute(store.content)
})

// 查询 / 大小写 / 视图模式变化时刷新预览模式高亮
watch([query, caseSensitive, () => store.viewMode], () => {
  if (isOpen.value && store.viewMode === 'preview') {
    nextTick(() => applyPreviewFind())
  }
})

// 渲染完成（含 Shiki 异步替换）后重新应用预览模式高亮
watch(
  () => store.renderedHtml,
  () => {
    if (isOpen.value && store.viewMode === 'preview') {
      nextTick(() => applyPreviewFind())
    }
  }
)

// 打开时聚焦查找输入框并定位到第一个匹配；预览模式在渲染 DOM 上高亮
watch(isOpen, async (open) => {
  if (!open) {
    if (store.viewMode === 'preview') removePreviewMarks()
    return
  }
  await nextTick()
  findInputRef.value?.focus()
  findInputRef.value?.select()
  if (store.viewMode === 'preview') {
    applyPreviewFind()
  } else {
    findReplace.recompute(store.content)
    nextTick(syncFindScroll)
  }
})

// textarea 滚动时同步高亮层
function syncHlScroll() {
  const ta = textareaRef.value
  const layer = hlLayerRef.value
  if (ta && layer) layer.scrollTop = ta.scrollTop
}

// textarea 统一滚动处理：同步高亮层 + 实时模式双向滚动
function onEditorScroll() {
  syncHlScroll()
  syncEditorToPreview()
}

// 把当前匹配滚动到可视区域（textarea 借助高亮层，CodeMirror 用装饰标记）
function syncFindScroll() {
  if (settings.useCodeMirror) {
    cmRef.value?.scrollToMatch()
    return
  }
  const ta = textareaRef.value
  const layer = hlLayerRef.value
  if (!ta || !layer) return
  const mark = layer.querySelector('mark.current') as HTMLElement | null
  if (mark) {
    layer.scrollTop = mark.offsetTop - layer.clientHeight / 2
    ta.scrollTop = layer.scrollTop
  }
}

function goNext() {
  if (store.viewMode === 'preview') {
    previewStep(1)
    return
  }
  findReplace.next()
  // 等 v-html 高亮层重新渲染后，mark.current 才是新位置
  nextTick(syncFindScroll)
}

function goPrev() {
  if (store.viewMode === 'preview') {
    previewStep(-1)
    return
  }
  findReplace.prev()
  nextTick(syncFindScroll)
}

function onFindKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    if (e.shiftKey) {
      goPrev()
    } else {
      goNext()
    }
  } else if (e.key === 'Escape') {
    e.preventDefault()
    findReplace.close()
  }
}

function onReplaceCurrent() {
  // 预览模式：直接改写预览 DOM 后回写 Markdown
  if (store.viewMode === 'preview') {
    replacePreviewCurrent()
    return
  }
  const result = findReplace.replaceCurrent(store.content)
  if (result !== null) store.setContent(result)
  nextTick(syncFindScroll)
}

function onReplaceAll() {
  if (store.viewMode === 'preview') {
    replaceAllPreview()
    return
  }
  const result = findReplace.replaceAll(store.content)
  if (result !== null) store.setContent(result)
  nextTick(syncFindScroll)
}

function onReplaceKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    onReplaceCurrent()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    findReplace.close()
  }
}

function onTextareaInput(event: Event) {
  const target = event.target as HTMLTextAreaElement
  store.setContent(target.value)
}

function onTextareaKeydown(event: KeyboardEvent) {
  // Handle Tab key to insert spaces
  if (event.key === 'Tab') {
    event.preventDefault()
    const textarea = event.target as HTMLTextAreaElement
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const newValue = store.content.substring(0, start) + '  ' + store.content.substring(end)
    store.setContent(newValue)
    requestAnimationFrame(() => {
      textarea.selectionStart = textarea.selectionEnd = start + 2
    })
  }

  // Handle Ctrl+B for bold
  if (event.ctrlKey && event.key === 'b') {
    event.preventDefault()
    store.insertText('**', '**')
  }

  // Handle Ctrl+I for italic
  if (event.ctrlKey && event.key === 'i') {
    event.preventDefault()
    store.insertText('*', '*')
  }

  // Handle Ctrl+Z / Ctrl+Y for undo/redo
  if (event.ctrlKey && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    if (event.shiftKey) {
      store.redo()
    } else {
      store.undo()
    }
  }

  // Handle Ctrl+Shift+Z or Ctrl+Y for redo
  if (event.ctrlKey && event.key.toLowerCase() === 'y') {
    event.preventDefault()
    store.redo()
  }
}

// ——— CodeMirror 编辑区事件 ———
function onCodeMirrorChange(value: string) {
  store.setContent(value)
}

// 编辑区滚动信息：CodeMirror / textarea 统一读取
function editorScrollMetrics(): { top: number; height: number; clientHeight: number } | null {
  if (settings.useCodeMirror) {
    const cm = cmRef.value
    return cm ? cm.getScrollMetrics() : null
  }
  const ta = textareaRef.value
  return ta ? { top: ta.scrollTop, height: ta.scrollHeight, clientHeight: ta.clientHeight } : null
}

function setEditorScrollTop(top: number) {
  if (settings.useCodeMirror) {
    cmRef.value?.setScrollTop(top)
    return
  }
  if (textareaRef.value) textareaRef.value.scrollTop = top
}

// 编辑区光标：CodeMirror / textarea 统一读取
function getEditorCaret(): { offset: number; hasCaret: boolean } {
  if (settings.useCodeMirror) {
    const cm = cmRef.value
    return cm
      ? { offset: cm.getSelectionOffset(), hasCaret: cm.hasFocus() }
      : { offset: 0, hasCaret: false }
  }
  const ta = textareaRef.value
  return ta
    ? { offset: ta.selectionStart, hasCaret: document.activeElement === ta }
    : { offset: 0, hasCaret: false }
}

// Preview editable mode: 每次内容变动实时标记为未保存（并阻止渲染结果覆盖编辑中的 DOM）
function onPreviewInput() {
  previewDirty.value = true
  store.markModified()
}

// Preview editable mode: sync to Markdown on blur
function onPreviewBlur(e: FocusEvent) {
  const el = e.target as HTMLElement
  if (!el || !el.innerHTML) return
  store.setContentFromHtml(el.innerHTML)
}

// Preview editable mode: Ctrl+Enter to commit, Ctrl+Z/Y handled by store
function onPreviewKeydown(e: KeyboardEvent) {
  // 代码块内 Enter：Chrome 在 Shiki 的块级 span.line 结构里按 Enter 只拆分块元素、
  // 不插入 \n 文本节点，导致 pre.textContent 无换行、turndown 提取后保存丢失。
  // 这里手动在光标处插入换行文本节点，保证 DOM 里真实存在换行。
  if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
    const sel = window.getSelection()
    const anchor = sel?.anchorNode
    if (anchor && editableRef.value?.contains(anchor)) {
      const el = anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : (anchor as Element)
      const preEl = el?.closest?.('pre')
      if (preEl) {
        e.preventDefault()
        const range = sel!.getRangeAt(0)
        range.deleteContents()
        const nl = document.createTextNode('\n')
        range.insertNode(nl)
        range.setStartAfter(nl)
        range.collapse(true)
        sel!.removeAllRanges()
        sel!.addRange(range)
        // Range.insertNode 不触发 input 事件，手动派发以驱动 dirty/保存同步
        editableRef.value?.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertLineBreak' }))
        return
      }
    }
  }
  // Ctrl+Enter = 提交修改（同步到 Markdown 并重渲染）
  if (e.ctrlKey && e.key === 'Enter') {
    e.preventDefault()
    const el = e.target as HTMLElement
    if (el?.innerHTML !== undefined) {
      store.setContentFromHtml(el.innerHTML)
    }
  }
}

// Track last synced ratios to prevent circular sync
let lastEditorRatio = -1
let lastPreviewRatio = -1

function syncEditorToPreview() {
  const editor = editorScrollMetrics()
  const preview = previewScrollRef.value
  if (!editor || !preview || editor.height <= editor.clientHeight) return

  const ratio = editor.top / (editor.height - editor.clientHeight)
  // Only sync if the ratio actually changed (avoid circular loop)
  if (Math.abs(ratio - lastPreviewRatio) > 0.001) {
    lastPreviewRatio = ratio
    lastEditorRatio = ratio
    preview.scrollTop = ratio * (preview.scrollHeight - preview.clientHeight)
  }
}

function syncPreviewToEditor() {
  const editor = editorScrollMetrics()
  const preview = previewScrollRef.value
  if (!preview || !editor || preview.scrollHeight <= preview.clientHeight) return

  const ratio = preview.scrollTop / (preview.scrollHeight - preview.clientHeight)
  // Only sync if the ratio actually changed (avoid circular loop)
  if (Math.abs(ratio - lastEditorRatio) > 0.001) {
    lastEditorRatio = ratio
    lastPreviewRatio = ratio
    setEditorScrollTop(ratio * (editor.height - editor.clientHeight))
  }
}

// ——— 字符统计 ———
// 有效字符：按 Unicode 码点计数（emoji 记 1 个），排除空白字符（空格/制表/换行等）
function countValidChars(text: string): number {
  let n = 0
  for (const ch of text) {
    if (/\s/.test(ch)) continue
    n++
  }
  return n
}

// 源文本（编辑页/实时预览）有效字符数
const sourceCharCount = computed(() => countValidChars(store.content))

// 预览页：从渲染后的 HTML 提取纯文本，统计可见文本的有效字符数
const previewCharCount = computed(() => {
  // HTML 文件由 iframe 渲染，预览区无 renderedHtml，直接按源文本统计
  if (store.fileType === 'html') return countValidChars(store.content)
  const html = store.renderedHtml || ''
  if (!html) return 0
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return countValidChars(doc.body?.textContent || '')
})

// ——— 视图切换：光标/滚动位置大体保持一致 ———
interface ViewPos {
  mode: 'edit' | 'preview'
  sel: number
  scroll: number
  ratio: number
  hasCaret: boolean
}
let viewPos: ViewPos = { mode: 'edit', sel: 0, scroll: 0, ratio: 0, hasCaret: false }

// 源文本按行比例估算滚动比例
function lineRatioOfOffset(content: string, offset: number): number {
  if (!content) return 0
  const line = content.slice(0, Math.min(offset, content.length)).split('\n').length - 1
  const total = content.split('\n').length
  return total > 1 ? line / (total - 1) : 0
}

// 记录编辑区当前位置（离开编辑类视图 / 切换编辑器内核前调用）
function captureEditPos(useCm: boolean) {
  const metrics = useCm
    ? (cmRef.value?.getScrollMetrics() ?? null)
    : (() => {
        const ta = textareaRef.value
        return ta ? { top: ta.scrollTop, height: ta.scrollHeight, clientHeight: ta.clientHeight } : null
      })()
  if (!metrics) return
  const max = metrics.height - metrics.clientHeight
  const caret = useCm
    ? cmRef.value
      ? { offset: cmRef.value.getSelectionOffset(), hasCaret: cmRef.value.hasFocus() }
      : { offset: 0, hasCaret: false }
    : (() => {
        const ta = textareaRef.value
        return ta
          ? { offset: ta.selectionStart, hasCaret: document.activeElement === ta }
          : { offset: 0, hasCaret: false }
      })()
  viewPos = {
    mode: 'edit',
    sel: caret.offset,
    scroll: metrics.top,
    ratio: max > 0 ? metrics.top / max : 0,
    hasCaret: caret.hasCaret
  }
}

// 恢复编辑区位置（进入编辑类视图 / 切换编辑器内核后调用）
function restoreEditPos() {
  const content = store.content
  const pos =
    viewPos.mode === 'edit'
      ? viewPos.sel
      : Math.min(content.length, Math.max(0, Math.round((viewPos.ratio >= 0 ? viewPos.ratio : 0) * content.length)))

  if (settings.useCodeMirror) {
    const cm = cmRef.value
    if (!cm) return
    cm.focus()
    cm.setSelection(pos)
    const metrics = cm.getScrollMetrics()
    const target =
      viewPos.mode === 'edit'
        ? viewPos.scroll
        : lineRatioOfOffset(content, pos) * (metrics.height - metrics.clientHeight)
    cm.setScrollTop(Math.max(0, target))
    return
  }

  const ta = textareaRef.value
  if (!ta) return
  try {
    ta.setSelectionRange(pos, pos)
  } catch {}
  ta.focus()
  ta.scrollTop =
    viewPos.mode === 'edit' ? viewPos.scroll : lineRatioOfOffset(content, pos) * (ta.scrollHeight - ta.clientHeight)
}

watch(
  () => store.viewMode,
  async (mode, oldMode) => {
    // 离开编辑类视图：保存光标偏移/滚动位置/是否有光标焦点
    if (oldMode === 'edit' || oldMode === 'live') {
      captureEditPos(settings.useCodeMirror)
    }
    // 离开预览：优先按光标比例记忆；光标不在预览内容内时，按滚动位置比例
    if (oldMode === 'preview' && previewScrollRef.value) {
      const pv = previewScrollRef.value
      const editable = editableRef.value
      let ratio = -1
      const sel = window.getSelection()
      if (editable && sel && sel.rangeCount > 0 && sel.anchorNode && editable.contains(sel.anchorNode)) {
        const total = editable.textContent?.length || 0
        if (total) {
          const range = sel.getRangeAt(0).cloneRange()
          range.selectNodeContents(editable)
          range.setEnd(sel.anchorNode, sel.anchorOffset)
          ratio = range.toString().length / total
        }
      }
      if (ratio < 0) {
        const max = pv.scrollHeight - pv.clientHeight
        ratio = max > 0 ? pv.scrollTop / max : 0
      }
      viewPos = { mode: 'preview', sel: 0, scroll: 0, ratio, hasCaret: false }
    }
    await nextTick()
    if (mode === 'edit' || mode === 'live') {
      restoreEditPos()
    } else if (mode === 'preview') {
      const pv = previewScrollRef.value
      if (pv) {
        // 编辑侧：有光标焦点按光标行比例；无焦点按滚动位置比例
        const ratio =
          viewPos.mode === 'edit'
            ? viewPos.hasCaret
              ? lineRatioOfOffset(store.content, viewPos.sel)
              : viewPos.ratio
            : viewPos.ratio >= 0
              ? viewPos.ratio
              : 0
        pv.scrollTop = ratio * (pv.scrollHeight - pv.clientHeight)
      }
    }
  }
)

// 切换编辑器内核（CodeMirror ↔ textarea）：保留当前光标与滚动位置
watch(
  () => settings.useCodeMirror,
  (_value, oldValue) => {
    captureEditPos(!!oldValue)
    void nextTick(() => {
      if (store.viewMode === 'edit' || store.viewMode === 'live') restoreEditPos()
    })
  },
  { flush: 'pre' }
)
</script>

<template>
  <div class="editor-container" :style="{ zoom: zoom }">
    <!-- Find / Replace bar -->
    <div v-if="isOpen" class="find-bar">
      <div class="find-row">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" class="find-icon">
          <circle cx="7" cy="7" r="4.5"/>
          <path d="M10.5 10.5 14 14"/>
        </svg>
        <input
          ref="findInputRef"
          v-model="query"
          class="find-input"
          placeholder="查找"
          spellcheck="false"
          @keydown="onFindKeydown"
        />
        <span class="find-count">{{ countText }}</span>
        <button class="find-btn" title="上一个 (Shift+Enter)" @click="goPrev">↑</button>
        <button class="find-btn" title="下一个 (Enter)" @click="goNext">↓</button>
        <button class="find-btn" :class="{ active: caseSensitive }" title="区分大小写" @click="findReplace.toggleCase()">Aa</button>
        <button class="find-btn" :class="{ active: showReplace }" title="替换 (Ctrl+H)" @click="showReplace = !showReplace">⇄</button>
        <button class="find-btn close" title="关闭 (Esc)" @click="findReplace.close()">×</button>
      </div>
      <div v-if="showReplace" class="find-row">
        <input
          ref="replaceInputRef"
          v-model="replaceText"
          class="find-input"
          placeholder="替换为"
          spellcheck="false"
          @keydown="onReplaceKeydown"
        />
        <button class="find-btn" @click="onReplaceCurrent">替换</button>
        <button class="find-btn" @click="onReplaceAll">全部替换</button>
      </div>
    </div>

    <!-- Edit mode: CodeMirror（全局开关开启）或原生 textarea -->
    <div v-if="store.viewMode === 'edit'" class="edit-pane">
      <CodeMirrorEditor
        v-if="settings.useCodeMirror"
        ref="cmRef"
        :model-value="store.content"
        :file-type="store.fileType"
        :dark="store.isDarkTheme"
        :placeholder="editorPlaceholder"
        :matches="matches"
        :current-match="currentIndex"
        @update:model-value="onCodeMirrorChange"
        @scroll="syncEditorToPreview"
        @undo="store.undo()"
        @redo="store.redo()"
        @bold="store.insertText('**', '**')"
        @italic="store.insertText('*', '*')"
      />
      <div v-else class="editor-wrap">
        <div
          ref="hlLayerRef"
          class="hl-layer"
          v-show="isOpen && matches.length > 0"
          v-html="highlightHtml"
        ></div>
        <textarea
          ref="textareaRef"
          class="editor-textarea"
          :class="{ finding: isOpen && matches.length > 0 }"
          :value="store.content"
          @input="onTextareaInput"
          @keydown="onTextareaKeydown"
          @scroll="onEditorScroll"
          :placeholder="editorPlaceholder"
          spellcheck="true"
        ></textarea>
      </div>
      <div class="status-bar">
        <span class="status-left" :class="{ modified: store.isModified }">
          {{ store.isModified ? '● 未保存' : '✓ 已保存' }}
        </span>
        <span v-if="statusPath" class="status-path" :title="statusPath">{{ statusPath }}</span>
        <span class="status-right">{{ sourceCharCount }} 字符</span>
      </div>
    </div>

    <!-- Preview mode: rendered only (editable for Markdown; YAML / Jinja2 read-only; HTML browser-like) -->
    <div v-else-if="store.viewMode === 'preview'" class="preview-pane">
      <div ref="previewScrollRef" class="preview-scroll">
        <!-- HTML：浏览器渲染效果（沙箱 iframe） -->
        <iframe
          v-if="store.fileType === 'html'"
          class="html-preview"
          :srcdoc="store.content"
          sandbox="allow-same-origin allow-popups allow-forms allow-modals"
        ></iframe>
        <!-- Markdown：可编辑预览；YAML / Jinja2：只读高亮预览 -->
        <div
          v-else
          ref="editableRef"
          class="preview-content markdown-body"
          :contenteditable="store.fileType === 'markdown'"
          @input="onPreviewInput"
          @blur="onPreviewBlur"
          @keydown="onPreviewKeydown"
          spellcheck="true"
        ></div>
      </div>
      <div class="status-bar">
        <span class="status-left" :class="{ modified: store.isModified }">
          {{ store.isModified ? '● 未保存' : '✓ 已保存' }}
        </span>
        <span v-if="statusPath" class="status-path" :title="statusPath">{{ statusPath }}</span>
        <span class="status-right">{{ previewCharCount }} 字符</span>
      </div>
    </div>

    <!-- Live mode: split view (Typora-like) -->
    <div v-else class="live-pane">
      <div class="live-body">
        <div class="live-edit" :style="{ width: (splitRatio * 100) + '%' }">
          <CodeMirrorEditor
            v-if="settings.useCodeMirror"
            ref="cmRef"
            :model-value="store.content"
            :file-type="store.fileType"
            :dark="store.isDarkTheme"
            :placeholder="editorPlaceholder"
            :matches="matches"
            :current-match="currentIndex"
            @update:model-value="onCodeMirrorChange"
            @scroll="syncEditorToPreview"
            @undo="store.undo()"
            @redo="store.redo()"
            @bold="store.insertText('**', '**')"
            @italic="store.insertText('*', '*')"
          />
          <div v-else class="editor-wrap">
            <div
              ref="hlLayerRef"
              class="hl-layer"
              v-show="isOpen && matches.length > 0"
              v-html="highlightHtml"
            ></div>
            <textarea
              ref="textareaRef"
              class="editor-textarea"
              :class="{ finding: isOpen && matches.length > 0 }"
              :value="store.content"
              @input="onTextareaInput"
              @keydown="onTextareaKeydown"
              @scroll="onEditorScroll"
              :placeholder="editorPlaceholder"
              spellcheck="true"
            ></textarea>
          </div>
        </div>
        <div class="live-divider" :class="{ dragging: isDragging }" @mousedown="onDividerMouseDown"></div>
        <div ref="previewScrollRef" class="live-preview preview-pane" @scroll="syncPreviewToEditor">
          <!-- HTML：浏览器渲染效果（沙箱 iframe） -->
          <iframe
            v-if="store.fileType === 'html'"
            class="html-preview"
            :srcdoc="store.content"
            sandbox="allow-same-origin allow-popups allow-forms allow-modals"
          ></iframe>
          <div v-else class="preview-content markdown-body" v-html="store.renderedHtml"></div>
        </div>
      </div>
      <div class="status-bar">
        <span class="status-left" :class="{ modified: store.isModified }">
          {{ store.isModified ? '● 未保存' : '✓ 已保存' }}
        </span>
        <span v-if="statusPath" class="status-path" :title="statusPath">{{ statusPath }}</span>
        <span class="status-right">
          <span class="status-count">源 {{ sourceCharCount }} 字符</span>
          <span class="status-count">预览 {{ previewCharCount }} 字符</span>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.editor-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
  position: relative;
}

/* Find / Replace bar */
.find-bar {
  flex: none;
  background: var(--bg-toolbar);
  border-bottom: 1px solid var(--border-color);
  padding: 6px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  z-index: 10;
}

.find-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.find-icon {
  color: var(--text-muted);
  flex-shrink: 0;
}

.find-input {
  width: 220px;
  padding: 4px 8px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 12px;
  outline: none;
}

.find-input:focus {
  border-color: var(--accent-color);
}

.find-count {
  color: var(--text-muted);
  min-width: 44px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.find-btn {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
  line-height: 1;
}

.find-btn:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.find-btn.active {
  color: var(--accent-color);
}

.find-btn.close {
  color: var(--text-muted);
}

/* Highlight layer (find matches behind transparent textarea text) */
.editor-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
}

.hl-layer {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1;
  overflow: hidden;
  pointer-events: none;
  padding: 24px 32px;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace;
  font-size: 14px;
  line-height: 1.7;
  tab-size: 2;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  color: var(--text-primary);
}

/* 编辑/实时模式高亮层由 v-html 动态生成（无 data-v 属性），须用 :deep */
:deep(.hl-layer mark) {
  background: rgba(255, 213, 79, 0.4);
  color: var(--text-primary);
  border-radius: 2px;
}

/* 当前选中的匹配：主题色实底 + 白字，与普通匹配明显区分 */
:deep(.hl-layer mark.current) {
  background: var(--accent-color);
  color: #ffffff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.25);
}

/* 预览模式查找高亮（运行时包裹在 contenteditable DOM 中，须用 :deep） */
:deep(.preview-content mark.preview-find) {
  background: rgba(255, 213, 79, 0.4);
  color: var(--text-primary);
  border-radius: 2px;
}

:deep(.preview-content mark.preview-find.current) {
  background: var(--accent-color);
  color: #ffffff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.25);
}

.live-edit .hl-layer {
  padding: 24px 24px;
}

.editor-textarea {
  position: relative;
  z-index: 2;
}

.editor-textarea.finding {
  color: transparent;
  background: transparent;
  caret-color: var(--text-primary);
  transition: none;
}

/* Edit pane */
.edit-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
}

.editor-textarea {
  width: 100%;
  height: 100%;
  padding: 24px 32px;
  border: none;
  outline: none;
  resize: none;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace;
  font-size: 14px;
  line-height: 1.7;
  color: var(--text-primary);
  background: var(--bg-primary);
  tab-size: 2;
  transition: background 0.3s ease;
}

.editor-textarea::placeholder {
  color: var(--text-muted);
}

/* Preview pane */
.preview-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
  position: relative;
}

.preview-scroll {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.preview-content {
  max-width: var(--preview-max-width);
  margin: 0 auto;
  padding: 32px 40px;
}

.preview-content[contenteditable="true"]:focus {
  outline: none;
}

/* HTML 预览：沙箱 iframe 铺满预览区，呈现浏览器渲染效果 */
.html-preview {
  display: block;
  width: 100%;
  height: 100%;
  border: none;
  background: #fff;
}

.status-bar {
  flex: none;
  height: var(--footer-bar-height);
  box-sizing: border-box;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 16px;
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-color);
  pointer-events: none;
}

.status-bar .status-left {
  color: var(--text-muted);
}

.status-bar .status-left.modified {
  color: #f0ad4e;
}

.status-bar .status-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
  color: var(--text-muted);
}

.status-bar .status-right {
  color: var(--text-muted);
  display: flex;
  gap: 14px;
}

.status-bar .status-count {
  white-space: nowrap;
}

/* Live pane (split) */
.live-pane {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
}

.live-body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.live-edit {
  flex: none;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-right: none;
  width: 50%;
}

.live-edit .editor-textarea {
  padding: 24px 24px;
}

.live-divider {
  width: 4px;
  background: var(--bg-tertiary);
  cursor: col-resize;
  flex-shrink: 0;
  position: relative;
}

.live-divider::after {
  content: '';
  position: absolute;
  left: 1px;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--accent-color);
  opacity: 0.3;
  transition: opacity 0.2s;
}

.live-divider:hover::after {
  opacity: 0.8;
}

.live-divider.dragging::after {
  opacity: 1;
  width: 3px;
}

.live-preview {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  background: var(--bg-secondary);
}

.live-preview .preview-content {
  padding: 24px 24px;
}

/* Markdown body styles */
:deep(.markdown-body) {
  color: var(--text-primary);
  line-height: 1.7;
}

:deep(.markdown-body h1),
:deep(.markdown-body h2),
:deep(.markdown-body h3),
:deep(.markdown-body h4),
:deep(.markdown-body h5),
:deep(.markdown-body h6) {
  margin-top: 24px;
  margin-bottom: 16px;
  font-weight: 600;
  line-height: 1.25;
}

:deep(.markdown-body h1) {
  font-size: 2em;
  border-bottom: 1px solid var(--border-color);
  padding-bottom: 0.3em;
}

:deep(.markdown-body h2) {
  font-size: 1.5em;
  border-bottom: 1px solid var(--border-color);
  padding-bottom: 0.3em;
}

:deep(.markdown-body h3) {
  font-size: 1.25em;
}

:deep(.markdown-body h4) {
  font-size: 1em;
}

:deep(.markdown-body p) {
  margin-top: 0;
  margin-bottom: 16px;
}

:deep(.markdown-body a) {
  color: var(--accent-color);
  text-decoration: none;
}

:deep(.markdown-body a:hover) {
  text-decoration: underline;
}

:deep(.markdown-body strong) {
  font-weight: 600;
}

:deep(.markdown-body code) {
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace;
  font-variant-ligatures: none;
  background: var(--code-bg);
  border-radius: 3px;
  padding: 0.2em 0.4em;
  font-size: 85%;
}

/* Inline code (not inside pre/code blocks) */
:deep(.markdown-body :not(pre) > code) {
  color: var(--text-primary);
}

:deep(.markdown-body pre) {
  margin-bottom: 16px;
  border-radius: 6px;
  overflow: hidden;
}

:deep(.markdown-body pre code) {
  display: block;
  padding: 16px;
  overflow-x: auto;
  line-height: 1.45;
  border-radius: 6px;
  font-size: 13px;
  font-variant-ligatures: none;
}

:deep(.markdown-body blockquote) {
  padding: 0 1em;
  color: var(--blockquote-color);
  border-left: 0.25em solid var(--blockquote-border);
  margin: 0 0 16px 0;
}

:deep(.markdown-body ul),
:deep(.markdown-body ol) {
  padding-left: 2em;
  margin-bottom: 16px;
}

:deep(.markdown-body li) {
  word-wrap: break-all;
}

:deep(.markdown-body li + li) {
  margin-top: 0.25em;
}

:deep(.markdown-body table) {
  border-collapse: collapse;
  width: 100%;
  margin-bottom: 16px;
  display: block;
  overflow-x: auto;
}

:deep(.markdown-body table th),
:deep(.markdown-body table td) {
  border: 1px solid var(--table-border);
  padding: 6px 13px;
  text-align: left;
}

:deep(.markdown-body table th) {
  background: var(--table-header-bg);
  font-weight: 600;
}

:deep(.markdown-body table tr:nth-child(even)) {
  background: var(--bg-secondary);
}

:deep(.markdown-body img) {
  max-width: 100%;
  border-radius: 4px;
  margin: 8px 0;
}

:deep(.markdown-body hr) {
  height: 1px;
  padding: 0;
  margin: 24px 0;
  background: var(--border-color);
  border: none;
}

:deep(.markdown-body input[type="checkbox"]) {
  margin-right: 6px;
  transform: scale(1.1);
}

:deep(.markdown-body ul.contains-task-list) {
  padding-left: 1.5em;
  list-style: none;
}

:deep(.markdown-body .task-list-item) {
  list-style: none;
}


</style>