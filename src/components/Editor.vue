<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useDragDivider } from '../composables/useDragDivider'
import { useEditorStore } from '../stores/editor'

const store = useEditorStore()

const splitRatio = ref(0.5)
const zoom = ref(1)
let containerWidth = 1
let startRatio = 0

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
  const textarea = document.querySelector('.editor-textarea') as HTMLTextAreaElement
  const preview = document.querySelector('.preview-pane') as HTMLElement
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
  const textarea = document.querySelector('.editor-textarea') as HTMLTextAreaElement
  const preview = document.querySelector('.preview-pane') as HTMLElement
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
    <!-- Edit mode: textarea only -->
    <div v-if="store.viewMode === 'edit'" class="edit-pane">
      <textarea
        class="editor-textarea"
        :value="store.content"
        @input="onTextareaInput"
        @keydown="onTextareaKeydown"
        placeholder="在此输入 Markdown..."
        spellcheck="true"
      ></textarea>
    </div>

    <!-- Preview mode: rendered only (editable) -->
    <div v-else-if="store.viewMode === 'preview'" class="preview-pane">
      <div class="preview-scroll">
        <div
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
        <textarea
          class="editor-textarea"
          :value="store.content"
          @input="onTextareaInput"
          @keydown="onTextareaKeydown"
          @scroll="syncEditorToPreview"
          placeholder="在此输入 Markdown..."
          spellcheck="true"
        ></textarea>
      </div>
      <div class="live-divider" :class="{ dragging: isDragging }" @mousedown="onDividerMouseDown"></div>
      <div class="live-preview preview-pane" @scroll="syncPreviewToEditor">
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

:deep(.markdown-body pre code.hljs) {
  background: var(--code-bg);
}

/* Ensure highlight.js syntax colors are applied with proper specificity */
:deep(.markdown-body .hljs) {
  color: inherit;
}
:deep(.markdown-body .hljs-keyword) {
  color: #d73a49 !important;
}
:deep(.markdown-body .hljs-string) {
  color: #032f62 !important;
}
:deep(.markdown-body .hljs-comment) {
  color: #6a737d !important;
}
:deep(.markdown-body .hljs-title.function_) {
  color: #6f42c1 !important;
}
:deep(.markdown-body .hljs-number) {
  color: #005cc5 !important;
}
:deep(.markdown-body .hljs-built_in) {
  color: #e36209 !important;
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