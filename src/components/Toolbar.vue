<script setup lang="ts">
import { useEditorStore, type ViewMode } from '../stores/editor'

const store = useEditorStore()

defineProps<{
  showSidebar: boolean
}>()

defineEmits<{
  'toggle-sidebar': []
  'about': []
}>()

const viewModes: { value: ViewMode; label: string; icon: string }[] = [
  { value: 'edit', label: '编辑', icon: '✏️' },
  { value: 'live', label: '实时预览', icon: '👁' },
  { value: 'preview', label: '预览', icon: '📖' }
]

const formattingTools = [
  { label: '粗体', icon: 'B', action: () => store.insertText('**', '**'), style: 'font-weight: 700' },
  { label: '斜体', icon: 'I', action: () => store.insertText('*', '*'), style: 'font-style: italic' },
  { label: '删除线', icon: 'S', action: () => store.insertText('~~', '~~'), style: 'text-decoration: line-through' },
  { label: '分隔符', icon: '—', action: () => store.insertText('\n\n---\n\n') },
  { label: '标题', icon: 'H', action: () => store.insertText('## ') },
  { label: '引用', icon: '❝', action: () => store.insertText('> ') },
  { label: '无序列表', icon: '•', action: () => store.insertText('- ') },
  { label: '有序列表', icon: '1.', action: () => store.insertText('1. ') },
  { label: '代码块', icon: '</>', action: () => store.insertText('\n```\n', '\n```\n') },
  { label: '表格', icon: '⊞', action: () => store.insertText('\n| 标题 | 内容 |\n|------|------|\n| 单元格 | 单元格 |\n') },
  { label: '链接', icon: '🔗', action: () => store.insertText('[链接文本](', ')') },
  { label: '图片', icon: '🖼', action: () => store.insertText('![图片描述](', ')') },
  { label: '任务列表', icon: '☑', action: () => store.insertText('- [ ] ') }
]

async function handleNew() {
  store.newFile()
}

async function handleOpen() {
  await store.openFile()
}

async function handleSave() {
  await store.saveFile()
}

async function handleSaveAs() {
  await store.saveFileAs()
}
</script>

<template>
  <div class="toolbar">
    <div class="toolbar-group">
      <button class="tool-btn sidebar-toggle" :class="{ active: showSidebar }" title="文件导航 (Ctrl+Shift+L)" @click="$emit('toggle-sidebar')">
        <span class="tool-icon">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M2 2a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1H2zm0 1h12v10H2V3zm2 2v6h2V5H4zm3 0v6h6V5H7z"/>
          </svg>
        </span>
      </button>
    </div>

    <div class="toolbar-divider"></div>

    <div class="toolbar-group">
      <button class="tool-btn" title="新建 (Ctrl+N)" @click="handleNew">
        <span class="tool-icon">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#569cd6" stroke-width="1.5">
            <rect x="2" y="3" width="12" height="10" rx="1"/>
            <path d="M8 6v4M6 8h4"/>
          </svg>
        </span>
        <span class="tool-label">新建</span>
      </button>
      <button class="tool-btn" title="打开 (Ctrl+O)" @click="handleOpen">
        <span class="tool-icon">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#569cd6" stroke-width="1.5">
            <path d="M1 4.5A1.5 1.5 0 0 1 2.5 3H6a1 1 0 0 1 .7.3l2 1.4a1 1 0 0 0 .7.3h5.1a.5.5 0 0 1 .5.5V12a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V4.5Z"/>
          </svg>
        </span>
        <span class="tool-label">打开</span>
      </button>
      <button class="tool-btn" title="保存 (Ctrl+S)" @click="handleSave">
        <span class="tool-icon">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#569cd6" stroke-width="1.5">
            <path d="M14.5 4.25V12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4.5a1.5 1.5 0 0 1 1.5-1.5H8l1.5 1.5h3a2 2 0 0 1 2 2.25Z"/>
            <path d="M4 5h5v4H4z"/>
          </svg>
        </span>
        <span class="tool-label">保存</span>
      </button>
      <button class="tool-btn" title="另存为 (Ctrl+Shift+S)" @click="handleSaveAs">
        <span class="tool-icon">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#569cd6" stroke-width="1.5">
            <path d="M14.5 4.25V12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4.5a1.5 1.5 0 0 1 1.5-1.5H8l1.5 1.5h3a2 2 0 0 1 2 2.25Z"/>
            <path d="M7 10V8h2v2h-2z"/>
            <path d="M3.5 8h.01"/>
          </svg>
        </span>
        <span class="tool-label">另存为</span>
      </button>
    </div>

    <div class="toolbar-divider"></div>

    <div class="toolbar-group formatting-group">
      <button
        v-for="tool in formattingTools"
        :key="tool.label"
        class="tool-btn formatting-btn"
        :title="tool.label"
        @click="tool.action()"
      >
        <span class="tool-icon" :style="tool.style">{{ tool.icon }}</span>
      </button>
    </div>

    <div class="toolbar-divider"></div>

    <div class="toolbar-group view-mode-group">
      <button
        v-for="mode in viewModes"
        :key="mode.value"
        class="tool-btn view-mode-btn"
        :class="{ active: store.viewMode === mode.value }"
        :title="mode.label"
        @click="store.setViewMode(mode.value)"
      >
        <span class="tool-icon">{{ mode.icon }}</span>
        <span class="tool-label">{{ mode.label }}</span>
      </button>
    </div>

    <div class="toolbar-spacer"></div>

    <div class="toolbar-group">
      <button class="tool-btn" title="切换主题 (Ctrl+Shift+T)" @click="store.toggleTheme()">
        <span class="tool-icon">{{ store.isDarkTheme ? '☀️' : '🌙' }}</span>
        <span class="tool-label">{{ store.isDarkTheme ? '亮色' : '暗色' }}</span>
      </button>
      <button class="tool-btn" title="关于 (Ctrl+Shift+A)" @click="$emit('about')">
        <span class="tool-icon">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#569cd6" stroke-width="1.5">
            <circle cx="8" cy="8" r="6.5"/>
            <path d="M8 7.5V11M8 5.2v.01"/>
          </svg>
        </span>
        <span class="tool-label">关于</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  height: 42px;
  padding: 0 8px;
  background: var(--bg-toolbar);
  border-bottom: 1px solid var(--border-color);
  gap: 2px;
  flex-shrink: 0;
  overflow-x: auto;
  -webkit-app-region: no-drag;
}

.toolbar::-webkit-scrollbar {
  height: 2px;
}

.toolbar-group {
  display: flex;
  align-items: center;
  gap: 1px;
  flex-shrink: 0;
}

.toolbar-divider {
  width: 1px;
  height: 24px;
  background: var(--border-color);
  margin: 0 4px;
  flex-shrink: 0;
}

.toolbar-spacer {
  flex: 1;
}

.tool-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 4px;
  font-size: 12px;
  white-space: nowrap;
  transition: all 0.15s ease;
  height: 30px;
}

.tool-btn:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.tool-btn:active {
  transform: scale(0.95);
}

.tool-btn.active {
  background: var(--accent-color);
  color: #ffffff;
}

.formatting-btn {
  padding: 4px 6px;
  min-width: 28px;
  justify-content: center;
}

.tool-icon {
  font-size: 14px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.tool-label {
  font-size: 12px;
  line-height: 1;
}

.formatting-btn .tool-icon {
  font-size: 13px;
}
</style>