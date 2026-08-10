<script setup lang="ts">
import { onMounted, onUnmounted, watch, ref } from 'vue'
import { useEditorStore } from './stores/editor'
import TitleBar from './components/TitleBar.vue'
import Toolbar from './components/Toolbar.vue'
import Editor from './components/Editor.vue'
import Sidebar from './components/Sidebar.vue'
// Import highlight.js CSS theme for code syntax highlighting
import 'highlight.js/styles/github.css'

const store = useEditorStore()
const showSidebar = ref(false)
const sidebarTab = ref<'files' | 's3'>('files')

// Listen for menu events from Electron main process
const cleanupFns: (() => void)[] = []

function toggleSidebar() {
  showSidebar.value = !showSidebar.value
}

onMounted(async () => {
  // Detect system theme and apply it
  if (window.api.getSystemTheme) {
    const isDark = await window.api.getSystemTheme()
    store.setTheme(isDark)
  }
  if (window.api.onSystemThemeChanged) {
    const cleanup = window.api.onSystemThemeChanged((isDark) => {
      store.setTheme(isDark)
    })
    cleanupFns.push(cleanup)
  }

  if (window.api.onNewFile) {
    const cleanup = window.api.onNewFile(() => store.newFile())
    cleanupFns.push(cleanup)
  }
  if (window.api.onOpenFile) {
    const cleanup = window.api.onOpenFile(() => store.openFile())
    cleanupFns.push(cleanup)
  }
  if (window.api.onSaveFile) {
    const cleanup = window.api.onSaveFile(() => store.saveFile())
    cleanupFns.push(cleanup)
  }
  if (window.api.onSaveAsFile) {
    const cleanup = window.api.onSaveAsFile(() => store.saveFileAs())
    cleanupFns.push(cleanup)
  }
  if (window.api.onExportHtml) {
    const cleanup = window.api.onExportHtml(() => {
      window.api.exportHtml(store.renderedHtml)
    })
    cleanupFns.push(cleanup)
  }
  if (window.api.onExportPdf) {
    const cleanup = window.api.onExportPdf(() => {
      window.api.exportPdf(store.renderedHtml)
    })
    cleanupFns.push(cleanup)
  }
  if (window.api.onToggleTheme) {
    const cleanup = window.api.onToggleTheme(() => store.toggleTheme())
    cleanupFns.push(cleanup)
  }
  if (window.api.onToggleSidebar) {
    const cleanup = window.api.onToggleSidebar(() => toggleSidebar())
    cleanupFns.push(cleanup)
  }
})

// Global keyboard shortcut for sidebar toggle
function onGlobalKeydown(e: KeyboardEvent) {
  if (e.ctrlKey && e.shiftKey && e.key === 'L') {
    e.preventDefault()
    toggleSidebar()
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('keydown', onGlobalKeydown)
}

onUnmounted(() => {
  cleanupFns.forEach(fn => fn())
  document.removeEventListener('keydown', onGlobalKeydown)
})

// Update window title when filename changes
watch(() => store.fileName, (name) => {
  window.api.setTitle(name)
}, { immediate: true })
</script>

<template>
  <div class="app" :class="{ 'dark-theme': store.isDarkTheme }">
    <TitleBar />
    <Toolbar @toggle-sidebar="toggleSidebar" :show-sidebar="showSidebar" />
    <div class="main-content">
      <transition name="sidebar">
        <Sidebar
          v-if="showSidebar"
          v-model="sidebarTab"
          @close="showSidebar = false"
        />
      </transition>
      <Editor />
    </div>
  </div>
</template>

<style>
/* Dark theme highlight.js overrides */
.dark-theme .hljs {
  color: #c9d1d9 !important;
  background: #0d1117 !important;
}
.dark-theme .hljs-doctag,
.dark-theme .hljs-keyword,
.dark-theme .hljs-meta .hljs-keyword,
.dark-theme .hljs-template-tag,
.dark-theme .hljs-template-variable,
.dark-theme .hljs-type,
.dark-theme .hljs-variable.language_ { color: #ff7b72 !important; }
.dark-theme .hljs-title,
.dark-theme .hljs-title.class_,
.dark-theme .hljs-title.class_.inherited__,
.dark-theme .hljs-title.function_ { color: #d2a8ff !important; }
.dark-theme .hljs-attr,
.dark-theme .hljs-attribute,
.dark-theme .hljs-literal,
.dark-theme .hljs-meta,
.dark-theme .hljs-number,
.dark-theme .hljs-operator,
.dark-theme .hljs-variable,
.dark-theme .hljs-selector-attr,
.dark-theme .hljs-selector-class,
.dark-theme .hljs-selector-id { color: #79c0ff !important; }
.dark-theme .hljs-regexp,
.dark-theme .hljs-string,
.dark-theme .hljs-meta .hljs-string { color: #a5d6ff !important; }
.dark-theme .hljs-built_in,
.dark-theme .hljs-symbol { color: #ffa657 !important; }
.dark-theme .hljs-comment,
.dark-theme .hljs-code,
.dark-theme .hljs-formula { color: #8b949e !important; }
.dark-theme .hljs-name,
.dark-theme .hljs-quote,
.dark-theme .hljs-selector-tag,
.dark-theme .hljs-selector-pseudo { color: #7ee787 !important; }
.dark-theme .hljs-subst { color: #c9d1d9 !important; }
.dark-theme .hljs-section { color: #1f6feb !important; font-weight: 700 !important; }
.dark-theme .hljs-bullet { color: #f2cc60 !important; }
.dark-theme .hljs-emphasis { color: #c9d1d9 !important; font-style: italic !important; }
.dark-theme .hljs-strong { color: #c9d1d9 !important; font-weight: 700 !important; }
.dark-theme .hljs-addition { color: #aff5b4 !important; background: #033a16 !important; }
.dark-theme .hljs-deletion { color: #ffdcd7 !important; background: #67060c !important; }

/* Reset & Base */
*,
*::before,
*::after {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

:root {
  /* Light theme */
  --bg-primary: #ffffff;
  --bg-secondary: #f5f5f5;
  --bg-tertiary: #e8e8e8;
  --bg-toolbar: #fafafa;
  --bg-titlebar: #ececec;
  --text-primary: #333333;
  --text-secondary: #666666;
  --text-muted: #999999;
  --border-color: #e0e0e0;
  --accent-color: #4a90d9;
  --accent-hover: #357abd;
  --code-bg: #f6f8fa;
  --blockquote-border: #dfe2e5;
  --blockquote-color: #6a737d;
  --table-border: #dfe2e5;
  --table-header-bg: #f6f8fa;
  --scrollbar-thumb: #c1c1c1;
  --scrollbar-track: transparent;
  --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.08);
  --preview-max-width: 860px;
}

.dark-theme {
  --bg-primary: #1e1e1e;
  --bg-secondary: #252526;
  --bg-tertiary: #2d2d2d;
  --bg-toolbar: #2d2d2d;
  --bg-titlebar: #1a1a1a;
  --text-primary: #d4d4d4;
  --text-secondary: #aaaaaa;
  --text-muted: #777777;
  --border-color: #3c3c3c;
  --accent-color: #569cd6;
  --accent-hover: #4fc1ff;
  --code-bg: #1e1e1e;
  --blockquote-border: #4ec9b0;
  --blockquote-color: #9cdcfe;
  --table-border: #3c3c3c;
  --table-header-bg: #2d2d2d;
  --scrollbar-thumb: #555555;
  --scrollbar-track: transparent;
  --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.2);
  --preview-max-width: 860px;
}

html, body {
  height: 100%;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 14px;
  line-height: 1.6;
  color: var(--text-primary);
  background: var(--bg-primary);
  -webkit-font-smoothing: antialiased;
}

#app {
  height: 100%;
}

.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg-primary);
  transition: background 0.3s ease, color 0.3s ease;
}

.main-content {
  flex: 1;
  display: flex;
  overflow: hidden;
}

/* Sidebar transition */
.sidebar-enter-active,
.sidebar-leave-active {
  transition: width 0.2s ease, opacity 0.2s ease;
  overflow: hidden;
}

.sidebar-enter-from,
.sidebar-leave-to {
  width: 0 !important;
  opacity: 0;
}

.sidebar-enter-to,
.sidebar-leave-from {
  width: 260px;
  opacity: 1;
}

/* Scrollbar styling */
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

::-webkit-scrollbar-track {
  background: var(--scrollbar-track);
}

::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb);
  border-radius: 4px;
}

::-webkit-scrollbar-thumb:hover {
  background: var(--text-muted);
}
</style>