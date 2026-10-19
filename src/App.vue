<script setup lang="ts">
import { onMounted, onUnmounted, watch, ref } from 'vue'
import { useEditorStore } from './stores/editor'
import { useFindReplace } from './composables/useFindReplace'
import TitleBar from './components/TitleBar.vue'
import Toolbar from './components/Toolbar.vue'
import Editor from './components/Editor.vue'
import Sidebar, { type SidebarTab } from './components/Sidebar.vue'
import AboutDialog from './components/AboutDialog.vue'
import SettingsDialog from './components/SettingsDialog.vue'

const store = useEditorStore()
const findReplace = useFindReplace()
const showSidebar = ref(false)
const sidebarTab = ref<SidebarTab>('files')
const showAbout = ref(false)
const showSettings = ref(false)

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
    const cleanup = window.api.onExportHtml(async () => {
      const html = await store.ensureRendered()
      window.api.exportHtml(html)
    })
    cleanupFns.push(cleanup)
  }
  if (window.api.onExportPdf) {
    const cleanup = window.api.onExportPdf(async () => {
      const html = await store.ensureRendered()
      window.api.exportPdf(html)
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
  if (window.api.onAbout) {
    const cleanup = window.api.onAbout(() => (showAbout.value = true))
    cleanupFns.push(cleanup)
  }
})

// Global keyboard shortcuts
function onGlobalKeydown(e: KeyboardEvent) {
  // Ctrl+S — 保存（与工具栏「保存」按钮走同一 store.saveFile 路径，确保一致）
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 's') {
    e.preventDefault()
    console.log('[keydown] Ctrl+S captured')
    store.saveFile()
    return
  }
  // Ctrl+Shift+S — 另存为
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 's') {
    e.preventDefault()
    store.saveFileAs()
    return
  }
  // Ctrl+Shift+L — 切换侧边栏
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'l') {
    e.preventDefault()
    toggleSidebar()
  }
  // Ctrl+F — 查找
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
    e.preventDefault()
    findReplace.openFind()
    return
  }
  // Ctrl+H — 替换
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'h') {
    e.preventDefault()
    findReplace.openReplace()
    return
  }
  // Esc — 关闭查找替换
  if (e.key === 'Escape' && findReplace.isOpen.value) {
    e.preventDefault()
    findReplace.close()
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
    <Toolbar @toggle-sidebar="toggleSidebar" :show-sidebar="showSidebar" @about="showAbout = true" />
    <div class="main-content">
      <transition name="sidebar">
        <Sidebar
          v-if="showSidebar"
          v-model="sidebarTab"
          @close="showSidebar = false"
          @open-settings="showSettings = true"
        />
      </transition>
      <Editor />
    </div>
    <AboutDialog :open="showAbout" @close="showAbout = false" />
    <SettingsDialog :open="showSettings" @close="showSettings = false" />
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
  --bg-sidebar: #f8f8f8;
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
  --bg-primary: #202125;
  --bg-secondary: #282828;
  --bg-sidebar: #2d2d2d;
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
  transition: transform 0.2s ease, opacity 0.2s ease;
  transform-origin: left center;
}

.sidebar-enter-from,
.sidebar-leave-to {
  transform: scaleX(0);
  opacity: 0;
}

.sidebar-enter-to,
.sidebar-leave-from {
  transform: scaleX(1);
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