<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useDragDivider } from '../composables/useDragDivider'
import FileTree from './FileTree.vue'
import S3Browser from './S3Browser.vue'
import Outline from './Outline.vue'

const props = defineProps<{ modelValue: 'files' | 's3' | 'outline' }>()
const emit = defineEmits<{
  'update:modelValue': [value: 'files' | 's3' | 'outline']
  close: []
}>()

const SIDEBAR_WIDTH_KEY = 'laoflchmd.sidebar.width'
const MIN_WIDTH = 200
const MAX_WIDTH = 600
const sidebarWidth = ref(260)

onMounted(() => {
  const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY)
  if (saved) {
    const w = parseInt(saved, 10)
    if (!isNaN(w) && w >= MIN_WIDTH && w <= MAX_WIDTH) {
      sidebarWidth.value = w
    }
  }
})

function switchTab(tab: 'files' | 's3' | 'outline') {
  emit('update:modelValue', tab)
}

let startWidth = 0

const { isDragging, startDrag } = useDragDivider({
  onDragStart: () => {
    startWidth = sidebarWidth.value
  },
  onDragMove: (deltaX) => {
    let w = startWidth + deltaX
    if (w < MIN_WIDTH) w = MIN_WIDTH
    if (w > MAX_WIDTH) w = MAX_WIDTH
    sidebarWidth.value = w
  },
  onDragEnd: () => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth.value))
  }
})
</script>

<template>
  <div class="sidebar" :style="{ width: sidebarWidth + 'px' }">
    <div class="sidebar-tabs">
      <button
        class="sidebar-tab"
        :class="{ active: modelValue === 'files' }"
        @click="switchTab('files')"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M1.5 3.5a1 1 0 0 1 1-1h3.172a1 1 0 0 1 .707.293L7.5 3.914H13.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V3.5Z"/>
        </svg>
        <span>文件</span>
      </button>
      <button
        class="sidebar-tab"
        :class="{ active: modelValue === 's3' }"
        @click="switchTab('s3')"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M12 2 4 5.5v6c0 4.5 3.4 8.4 8 10 4.6-1.6 8-5.5 8-10v-6L12 2z"/>
          <path d="M4 5.5 12 9l8-3.5M12 9v10.5"/>
        </svg>
        <span>S3</span>
      </button>
      <button
        class="sidebar-tab"
        :class="{ active: modelValue === 'outline' }"
        @click="switchTab('outline')"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
          <path d="M2 3h4M2 8h6M2 13h5"/>
          <path d="M10 3h4M9 8h5M8 13h6"/>
        </svg>
        <span>大纲</span>
      </button>
      <button class="sidebar-close" title="关闭侧边栏" @click="emit('close')">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
        </svg>
      </button>
    </div>
    <div class="sidebar-body">
      <FileTree v-show="modelValue === 'files'" />
      <S3Browser v-show="modelValue === 's3'" />
      <Outline v-show="modelValue === 'outline'" />
    </div>
    <div
      class="sidebar-resizer"
      :class="{ dragging: isDragging }"
      @mousedown="startDrag"
    ></div>
  </div>
</template>

<style scoped>
.sidebar {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-sidebar);
  font-size: 13px;
  user-select: none;
  overflow: hidden;
  position: relative;
  flex: none;
}

.sidebar-tabs {
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
  background: var(--bg-sidebar);
}

.sidebar-tab {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: 1;
  padding: 9px 8px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
}

.sidebar-tab:hover {
  color: var(--text-primary);
  background: var(--bg-tertiary);
}

.sidebar-tab.active {
  color: var(--accent-color);
  border-bottom-color: var(--accent-color);
}

.sidebar-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  border-radius: 4px;
  cursor: pointer;
  flex-shrink: 0;
}

.sidebar-close:hover {
  color: var(--text-primary);
  background: var(--bg-tertiary);
}

.sidebar-body {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.sidebar-resizer {
  position: absolute;
  top: 0;
  right: -2px;
  width: 5px;
  height: 100%;
  cursor: col-resize;
  background: transparent;
  z-index: 10;
  border-right: 1px solid var(--border-color);
  transition: background 0.15s;
}

.sidebar-resizer:hover,
.sidebar-resizer.dragging {
  background: var(--accent-color);
  opacity: 0.5;
}
</style>
