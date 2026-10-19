<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useDragDivider } from '../composables/useDragDivider'
import { useEditorDom } from '../composables/useEditorDom'
import { useFindReplace } from '../composables/useFindReplace'
import { useEditorStore } from '../stores/editor'

const store = useEditorStore()
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

function handleCtrlWheel(e: WheelEvent) {
  if (!e.ctrlKey) return
  e.preventDefault()
  if (e.deltaY < 0) {
    zoom.value = Math.min(2, zoom.value + 0.1)
  } else {
    zoom.value = Math.max(0.5, zoom.value - 0.1)
  }
}

onMounted(() => {
  document.addEventListener('wheel', handleCtrlWheel, { passive: false })
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

// 打开 / 内容或查询变化 / 视图模式切换时重算匹配
watch([isOpen, query, () => store.content, () => store.viewMode], () => {
  if (!isOpen.value) return
  findReplace.recompute(store.content)
})

// 打开时聚焦查找输入框并定位到第一个匹配
watch(isOpen, async (open) => {
  if (!open) return
  await nextTick()
  findInputRef.value?.focus()
  findInputRef.value?.select()
  findReplace.recompute(store.content)
  syncFindScroll()
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

// 把当前匹配滚动到可视区域（借助高亮层相同排版定位）
function syncFindScroll() {
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
  findReplace.next()
  syncFindScroll()
}

function goPrev() {
  findReplace.prev()
  syncFindScroll()
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
  const result = findReplace.replaceCurrent(store.content)
  if (result !== null) store.setContent(result)
  nextTick(syncFindScroll)
}

function onReplaceAll() {
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

// Preview editable mode: 每次内容变动实时标记为未保存
function onPreviewInput() {
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
  const textarea = textareaRef.value
  const preview = previewScrollRef.value
  if (!textarea || !preview || textarea.scrollHeight <= textarea.clientHeight) return

  const ratio = textarea.scrollTop / (textarea.scrollHeight - textarea.clientHeight)
  // Only sync if the ratio actually changed (avoid circular loop)
  if (Math.abs(ratio - lastPreviewRatio) > 0.001) {
    lastPreviewRatio = ratio
    lastEditorRatio = ratio
    preview.scrollTop = ratio * (preview.scrollHeight - preview.clientHeight)
  }
}

function syncPreviewToEditor() {
  const textarea = textareaRef.value
  const preview = previewScrollRef.value
  if (!preview || !textarea || preview.scrollHeight <= preview.clientHeight) return

  const ratio = preview.scrollTop / (preview.scrollHeight - preview.clientHeight)
  // Only sync if the ratio actually changed (avoid circular loop)
  if (Math.abs(ratio - lastEditorRatio) > 0.001) {
    lastEditorRatio = ratio
    lastPreviewRatio = ratio
    textarea.scrollTop = ratio * (textarea.scrollHeight - textarea.clientHeight)
  }
}
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
        <span class="find-count">{{ matches.length ? (currentIndex + 1) + '/' + matches.length : '0/0' }}</span>
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

    <!-- Edit mode: textarea only -->
    <div v-if="store.viewMode === 'edit'" class="edit-pane">
      <div class="editor-wrap">
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
          placeholder="在此输入 Markdown..."
          spellcheck="true"
        ></textarea>
      </div>
    </div>

    <!-- Preview mode: rendered only (editable) -->
    <div v-else-if="store.viewMode === 'preview'" class="preview-pane">
      <div ref="previewScrollRef" class="preview-scroll">
        <div
          ref="editableRef"
          class="preview-content markdown-body"
          :contenteditable="true"
          v-html="store.renderedHtml"
          @input="onPreviewInput"
          @blur="onPreviewBlur"
          @keydown="onPreviewKeydown"
          spellcheck="true"
        ></div>
      </div>
      <div class="preview-status-bar">
        <span class="status-left" :class="{ modified: store.isModified }">
          {{ store.isModified ? '● 未保存' : '✓ 已保存' }}
        </span>
        <span class="status-right">{{ store.content.length }} 字符</span>
      </div>
    </div>

    <!-- Live mode: split view (Typora-like) -->
    <div v-else class="live-pane">
      <div class="live-edit" :style="{ width: (splitRatio * 100) + '%' }">
        <div class="editor-wrap">
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
            placeholder="在此输入 Markdown..."
            spellcheck="true"
          ></textarea>
        </div>
      </div>
      <div class="live-divider" :class="{ dragging: isDragging }" @mousedown="onDividerMouseDown"></div>
      <div ref="previewScrollRef" class="live-preview preview-pane" @scroll="syncPreviewToEditor">
        <div class="preview-content markdown-body" v-html="store.renderedHtml"></div>
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
  height: 100%;
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

.hl-layer mark {
  background: rgba(255, 213, 79, 0.4);
  color: var(--text-primary);
  border-radius: 2px;
}

.hl-layer mark.current {
  background: rgba(255, 152, 0, 0.6);
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

.preview-status-bar {
  flex: none;
  padding: 6px 20px;
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-color);
  display: flex;
  justify-content: space-between;
  align-items: center;
  pointer-events: none;
}

.preview-status-bar .status-left {
  color: var(--text-muted);
}

.preview-status-bar .status-left.modified {
  color: #f0ad4e;
}

.preview-status-bar .status-right {
  color: var(--text-muted);
}

/* Live pane (split) */
.live-pane {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.live-edit {
  flex: none;
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