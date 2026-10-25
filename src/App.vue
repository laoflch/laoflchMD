<script setup lang="ts">
import { onMounted, onUnmounted, watch, ref } from 'vue'
import { useEditorStore } from './stores/editor'
import { useToastStore } from './stores/toast'
import { useSettingsStore } from './stores/settings'
import { useFindReplace } from './composables/useFindReplace'
import { useDragDivider } from './composables/useDragDivider'
import TitleBar from './components/TitleBar.vue'
import Toolbar from './components/Toolbar.vue'
import Editor from './components/Editor.vue'
import Sidebar, { type SidebarTab } from './components/Sidebar.vue'
import SearchPanel from './components/SearchPanel.vue'
import AboutDialog from './components/AboutDialog.vue'
import SettingsDialog from './components/SettingsDialog.vue'

const store = useEditorStore()
const findReplace = useFindReplace()
const settings = useSettingsStore()
const toastStore = useToastStore()
const showSidebar = ref(false)
const sidebarTab = ref<SidebarTab>('files')
const searchOpen = ref(false)
const showAbout = ref(false)
const showSettings = ref(false)

// 索引右侧边栏宽度（可拖拽调整，持久化）
const DRAWER_WIDTH_KEY = 'laoflchmd.search.width'
const DRAWER_MIN = 260
const DRAWER_MAX = 700
let drawerStartWidth = 420
const drawerWidth = ref(420)
if (typeof localStorage !== 'undefined') {
  const saved = Number(localStorage.getItem(DRAWER_WIDTH_KEY))
  if (saved >= DRAWER_MIN && saved <= DRAWER_MAX) {
    drawerWidth.value = saved
  }
}
const { isDragging: drawerDragging, startDrag: startDrawerDrag } = useDragDivider({
  onDragStart: () => {
    drawerStartWidth = drawerWidth.value
  },
  onDragMove: (deltaX) => {
    drawerWidth.value = Math.max(DRAWER_MIN, Math.min(DRAWER_MAX, drawerStartWidth - deltaX))
  },
  onDragEnd: () => {
    localStorage.setItem(DRAWER_WIDTH_KEY, String(drawerWidth.value))
  }
})

// 索引服务总开关关闭时，关闭右侧索引弹出栏
watch(
  () => settings.indexEnabled,
  (enabled) => {
    if (!enabled) searchOpen.value = false
  }
)

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
  // Esc — 关闭查找替换 / 索引弹出栏
  if (e.key === 'Escape') {
    if (searchOpen.value) {
      searchOpen.value = false
      return
    }
    if (findReplace.isOpen.value) {
      e.preventDefault()
      findReplace.close()
    }
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
    <Toolbar
      @toggle-sidebar="toggleSidebar"
      :show-sidebar="showSidebar"
      :show-search="searchOpen"
      @toggle-search="searchOpen = !searchOpen"
      @about="showAbout = true"
    />
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

    <!-- 索引右侧边栏：位于子工具栏之下、底部状态栏之上，不覆盖两者；左侧可拖拽调整宽度 -->
    <Transition name="search-drawer">
      <div v-if="searchOpen" class="search-drawer" :style="{ width: drawerWidth + 'px' }">
        <div
          class="search-drawer-resizer"
          :class="{ dragging: drawerDragging }"
          title="拖动调整宽度"
          @mousedown="startDrawerDrag"
        ></div>
        <div class="search-drawer-header">
          <span class="search-drawer-title">索引</span>
          <button class="search-drawer-close" title="关闭" @click="searchOpen = false">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M4 4l8 8M12 4l-8 8"/>
            </svg>
          </button>
        </div>
        <SearchPanel />
      </div>
    </Transition>

    <!-- 右上角全局提示 -->
    <div class="toast-host">
      <transition-group name="toast">
        <div
          v-for="t in toastStore.toasts"
          :key="t.id"
          class="toast-item"
          :class="t.type"
          @click="toastStore.removeToast(t.id)"
        >
          {{ t.text }}
        </div>
      </transition-group>
    </div>
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
  --footer-bar-height: 38px;
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

/* 右上角全局提示（toast） */
.toast-host {
  position: fixed;
  top: 92px;
  right: 20px;
  z-index: 2000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 320px;
  pointer-events: none;
}

.toast-item {
  pointer-events: auto;
  padding: 8px 14px;
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.5;
  cursor: pointer;
  box-shadow: var(--shadow-sm);
  word-break: break-all;
  white-space: normal;
}

.toast-item.ok {
  background: var(--bg-primary);
  color: #28a745;
  border: 1px solid rgba(40, 167, 69, 0.5);
}

.toast-item.err {
  background: var(--bg-primary);
  color: #dc3545;
  border: 1px solid rgba(220, 53, 69, 0.5);
}

.toast-item.progress {
  background: var(--bg-primary);
  color: var(--accent-color);
  border: 1px solid rgba(74, 144, 217, 0.5);
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

/* 索引右侧边栏：位于子工具栏（TitleBar 36px + Toolbar 42px）之下、底部状态栏（38px）之上 */
.search-drawer {
  position: fixed;
  top: 78px;
  bottom: 38px;
  right: 0;
  width: 420px;
  max-width: 90vw;
  display: flex;
  flex-direction: column;
  background: var(--bg-sidebar);
  border-left: 1px solid var(--border-color);
  box-shadow: -4px 0 20px rgba(0, 0, 0, 0.2);
  z-index: 1200;
}

.search-drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-secondary);
  flex-shrink: 0;
}

/* 左侧拖拽调整宽度手柄 */
.search-drawer-resizer {
  position: absolute;
  left: -3px;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  z-index: 5;
}

.search-drawer-resizer:hover,
.search-drawer-resizer.dragging {
  background: var(--accent-color);
}

.search-drawer-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.search-drawer-close {
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 4px;
}

.search-drawer-close:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.search-drawer-enter-active,
.search-drawer-leave-active {
  transition: transform 0.2s ease;
}

.search-drawer-enter-from,
.search-drawer-leave-to {
  transform: translateX(100%);
}
</style>