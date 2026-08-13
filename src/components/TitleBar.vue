<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useEditorStore } from '../stores/editor'

const store = useEditorStore()
const isMaximized = ref(false)

onMounted(async () => {
  // Check initial maximize state
  try {
    isMaximized.value = await window.api.isMaximized()
  } catch {
    // ignore
  }

  // Listen for maximize state changes
  if (window.api.onMaximizedChanged) {
    const cleanup = window.api.onMaximizedChanged((maximized: boolean) => {
      isMaximized.value = maximized
    })
    onUnmounted(cleanup)
  }
})

function minimize() {
  window.api.minimizeWindow()
}

function maximize() {
  window.api.maximizeWindow()
}

function close() {
  window.api.closeWindow()
}
</script>

<template>
  <div class="title-bar" @contextmenu.prevent>
    <!-- Drag region (left side) -->
    <div class="title-bar-drag" @contextmenu.prevent>
      <div class="app-icon">✦</div>
      <span class="file-name">{{ store.fileName }}</span>
      <span v-if="store.filePath" class="file-path" :title="store.filePath">
        — {{ store.filePath }}
      </span>
    </div>

    <!-- Window control buttons -->
    <div class="window-controls">
      <button class="win-btn win-minimize" title="最小化" @click="minimize">
        <svg width="12" height="12" viewBox="0 0 12 12">
          <rect x="1" y="5.5" width="10" height="1" fill="currentColor"/>
        </svg>
      </button>
      <button class="win-btn win-maximize" :title="isMaximized ? '还原' : '最大化'" @click="maximize">
        <!-- Maximize icon -->
        <svg v-if="!isMaximized" width="12" height="12" viewBox="0 0 12 12">
          <rect x="1.5" y="1.5" width="9" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/>
        </svg>
        <!-- Restore icon -->
        <svg v-else width="12" height="12" viewBox="0 0 12 12">
          <rect x="1.5" y="3" width="7.5" height="7.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.1"/>
          <path d="M3 3V2.5A1.5 1.5 0 0 1 4.5 1H9A1.5 1.5 0 0 1 10.5 2.5V7A1.5 1.5 0 0 1 9 8.5H8.5" fill="none" stroke="currentColor" stroke-width="1.1"/>
        </svg>
      </button>
      <button class="win-btn win-close" title="关闭" @click="close">
        <svg width="12" height="12" viewBox="0 0 12 12">
          <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.5"/>
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.title-bar {
  display: flex;
  align-items: center;
  height: 36px;
  background: var(--bg-titlebar);
  border-bottom: 1px solid var(--border-color);
  user-select: none;
  flex-shrink: 0;
}

.title-bar-drag {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0 12px;
  -webkit-app-region: drag;
}

.app-icon {
  font-size: 14px;
  color: var(--accent-color);
  flex-shrink: 0;
}

.file-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-path {
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Window control buttons */
.window-controls {
  display: flex;
  align-items: center;
  height: 100%;
  flex-shrink: 0;
  -webkit-app-region: no-drag;
}

.win-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 100%;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 0.1s, color 0.1s;
}

.win-btn:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.win-close:hover {
  background: #e81123;
  color: #ffffff;
}
</style>