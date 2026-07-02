<script setup lang="ts">
import { ref } from 'vue'
import { useEditorStore } from '../stores/editor'

const store = useEditorStore()

const splitRatio = ref(0.5)
const isDragging = ref(false)

function onDividerMouseDown(e: MouseEvent) {
  const divider = e.currentTarget as HTMLElement
  const container = divider.closest('.live-pane') as HTMLElement
  if (!container) return

  isDragging.value = true
  const startX = e.clientX
  const startRatio = splitRatio.value
  const containerWidth = container.offsetWidth

  function onMouseMove(e: MouseEvent) {
    const dx = e.clientX - startX
    splitRatio.value = Math.max(0.15, Math.min(0.85, startRatio + dx / containerWidth))
  }

  function onMouseUp() {
    isDragging.value = false
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }

  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
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
}

let isSyncing = false

function syncEditorToPreview() {
  if (isSyncing) return
  isSyncing = true

  const textarea = document.querySelector('.editor-textarea') as HTMLTextAreaElement
  const preview = document.querySelector('.preview-pane') as HTMLElement
  if (textarea && preview && textarea.scrollHeight > textarea.clientHeight) {
    const ratio = textarea.scrollTop / (textarea.scrollHeight - textarea.clientHeight)
    preview.scrollTop = ratio * (preview.scrollHeight - preview.clientHeight)
  }

  isSyncing = false
}

function syncPreviewToEditor() {
  if (isSyncing) return
  isSyncing = true

  const textarea = document.querySelector('.editor-textarea') as HTMLTextAreaElement
  const preview = document.querySelector('.preview-pane') as HTMLElement
  if (preview && textarea && preview.scrollHeight > preview.clientHeight) {
    const ratio = preview.scrollTop / (preview.scrollHeight - preview.clientHeight)
    textarea.scrollTop = ratio * (textarea.scrollHeight - textarea.clientHeight)
  }

  isSyncing = false
}
</script>

<template>
  <div class="editor-container">
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

    <!-- Preview mode: rendered only -->
    <div v-else-if="store.viewMode === 'preview'" class="preview-pane">
      <div class="preview-content markdown-body" v-html="store.renderedHtml"></div>
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
  overflow-y: auto;
  min-height: 0;
}

.preview-content {
  max-width: var(--preview-max-width);
  margin: 0 auto;
  padding: 32px 40px;
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
  background: var(--code-bg);
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