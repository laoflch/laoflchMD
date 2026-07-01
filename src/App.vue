<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue'
import { useEditorStore } from './stores/editor'
import TitleBar from './components/TitleBar.vue'
import Toolbar from './components/Toolbar.vue'
import Editor from './components/Editor.vue'

const store = useEditorStore()

// Listen for menu events from Electron main process
const cleanupFns: (() => void)[] = []

onMounted(() => {
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
})

onUnmounted(() => {
  cleanupFns.forEach(fn => fn())
})

// Update window title when filename changes
watch(() => store.fileName, (name) => {
  window.api.setTitle(name)
}, { immediate: true })
</script>

<template>
  <div class="app" :class="{ 'dark-theme': store.isDarkTheme }">
    <TitleBar />
    <Toolbar />
    <Editor />
  </div>
</template>

<style>
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