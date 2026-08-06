<script setup lang="ts">
import { ref, onMounted, watch, nextTick } from 'vue'
import { useEditorStore } from '../stores/editor'
import type { FileEntry } from '../types'
import TreeNodeItem from './TreeNodeItem.vue'

const store = useEditorStore()

const rootDir = ref<string | null>(null)
const treeData = ref<FileEntry[]>([])
const expanded = ref<Set<string>>(new Set())
const selectedPath = ref<string | null>(null)
const loading = ref(false)

// Template refs for TreeNodeItem instances
const renamingPath = ref<string | null>(null)

// Context menu state
const contextMenu = ref<{
  visible: boolean
  x: number
  y: number
  targetPath: string
  isDirectory: boolean
}>({
  visible: false,
  x: 0,
  y: 0,
  targetPath: '',
  isDirectory: false
})

async function loadDir(dirPath: string): Promise<FileEntry[]> {
  try {
    return await window.api.readDir(dirPath)
  } catch {
    return []
  }
}

async function openDir(dirPath: string) {
  rootDir.value = dirPath
  loading.value = true
  treeData.value = await loadDir(dirPath)
  loading.value = false
  // Save to localStorage for persistence across restarts
  localStorage.setItem('lastOpenedDir', dirPath)
}

async function openDirectory() {
  const dir = await window.api.openDirectory()
  if (dir) {
    await openDir(dir)
  }
}

async function selectNode(entry: FileEntry) {
  if (entry.isDirectory) {
    // Toggle directory expansion — create new Set to trigger reactivity
    const newExpanded = new Set(expanded.value)
    if (newExpanded.has(entry.path)) {
      newExpanded.delete(entry.path)
    } else {
      newExpanded.add(entry.path)
    }
    expanded.value = newExpanded
    return
  }

  if (!entry.isMarkdown) return

  // Open file directly
  try {
    const content = await window.api.readFile(entry.path)
    if (content !== null) {
      store.setContent(content)
      store.setFilePath(entry.path)
      selectedPath.value = entry.path
    }
  } catch (err) {
    console.error('Failed to open file:', err)
  }
}

async function refreshTree() {
  if (rootDir.value) {
    const currentDir = rootDir.value
    const wasExpanded = new Set(expanded.value)
    expanded.value = new Set()
    await openDir(currentDir)
    // Restore expanded state
    expanded.value = new Set(wasExpanded)
  }
}

// Watch for store file path changes to update selection
watch(() => store.filePath, (newPath) => {
  if (newPath) {
    selectedPath.value = newPath
  }
})

// Context menu handlers
function showContextMenu(event: MouseEvent, entry: FileEntry) {
  event.preventDefault()
  contextMenu.value = {
    visible: true,
    x: event.clientX,
    y: event.clientY,
    targetPath: entry.path,
    isDirectory: entry.isDirectory
  }
}

function closeContextMenu() {
  contextMenu.value.visible = false
}

async function handleNewFile() {
  closeContextMenu()
  const parentDir = contextMenu.value.isDirectory
    ? contextMenu.value.targetPath
    : rootDir.value
  if (!parentDir) return

  await window.api.newFile(parentDir)
  await refreshTree()
}

async function handleNewFolder() {
  closeContextMenu()
  const parentDir = contextMenu.value.isDirectory
    ? contextMenu.value.targetPath
    : rootDir.value
  if (!parentDir) return

  await window.api.newFolder(parentDir)
  await refreshTree()
}

async function handleDelete() {
  closeContextMenu()
  const targetPath = contextMenu.value.targetPath
  const success = await window.api.delete(targetPath)
  if (success) {
    if (store.filePath === targetPath) {
      store.newFile()
    }
    await refreshTree()
  }
}

async function handleRename() {
  const targetPath = contextMenu.value.targetPath
  closeContextMenu()
  await nextTick()
  renamingPath.value = targetPath
}

async function handleRenameComplete(oldPath: string, newPath: string | null) {
  renamingPath.value = null
  if (!newPath) return
  const currentFilePath = store.filePath
  // If the renamed file itself was open, update the store file path
  if (currentFilePath === oldPath) {
    store.setFilePath(newPath)
  } else if (currentFilePath && currentFilePath.startsWith(oldPath + '/')) {
    // If a renamed ancestor directory of the open file was renamed, update the path accordingly
    store.setFilePath(newPath + currentFilePath.slice(oldPath.length))
  }
  await refreshTree()
}

// Click outside context menu to close it
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    if (contextMenu.value.visible) {
      const target = e.target as HTMLElement
      if (!target.closest('.context-menu')) {
        closeContextMenu()
      }
    }
  })
}

onMounted(async () => {
  // Try to restore last opened directory from localStorage
  const lastDir = localStorage.getItem('lastOpenedDir')
  if (lastDir) {
    await openDir(lastDir)
  }

  // If a file was previously open, select it in the tree
  if (store.filePath) {
    selectedPath.value = store.filePath
    // If no lastDir was saved, try to open the directory of the current file
    if (!lastDir) {
      const dir = await window.api.getFileDir(store.filePath)
      if (dir) {
        await openDir(dir)
      }
    }
  }
})

defineExpose({ refreshTree, openDir })
</script>

<template>
  <div class="file-tree-panel" :class="{ 'dark-theme': store.isDarkTheme }" @contextmenu.prevent>
    <!-- Toolbar -->
    <div class="panel-toolbar">
      <button class="icon-btn" title="打开文件夹" @click="openDirectory">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M1.5 3.5a1 1 0 0 1 1-1h3.172a1 1 0 0 1 .707.293L7.5 3.914H13.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V3.5Z"/>
        </svg>
      </button>
    </div>

    <!-- Root path display -->
    <div class="root-path" :title="rootDir || ''">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
        <path d="M1.5 3.5a1 1 0 0 1 1-1h3.172a1 1 0 0 1 .707.293L7.5 3.914H13.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V3.5Z"/>
      </svg>
      <span class="root-path-text">{{ rootDir ? rootDir.split('/').pop() || rootDir : '未打开文件夹' }}</span>
    </div>

    <!-- Loading indicator -->
    <div v-if="loading" class="tree-loading">
      <span class="loading-spinner"></span>
      加载中...
    </div>

    <!-- No folder open state -->
    <div v-else-if="!rootDir" class="empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>
      </svg>
      <p>打开一个文件夹以浏览文件</p>
      <button class="open-dir-btn" @click="openDirectory">打开文件夹</button>
    </div>

    <!-- Empty folder state -->
    <div v-else-if="treeData.length === 0" class="empty-state">
      <p>文件夹为空</p>
      <button class="open-dir-btn" @click="openDirectory">重新选择文件夹</button>
    </div>

    <!-- File tree -->
    <div v-else class="tree-container">
      <TreeNodeItem
        v-for="entry in treeData"
        :key="entry.path"
        :entry="entry"
        :expanded="expanded"
        :selected-path="selectedPath"
        :renaming-path="renamingPath"
        :depth="0"
        @select="selectNode"
        @contextmenu="showContextMenu"
        @rename-complete="handleRenameComplete"
      />
    </div>

    <!-- Context menu -->
    <div
      v-if="contextMenu.visible"
      class="context-menu"
      :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
    >
      <div class="context-menu-item" @click="handleNewFile">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M9.5 1.5a.5.5 0 0 0-1 0V4H6a.5.5 0 0 0 0 1h2.5v2.5a.5.5 0 0 0 1 0V5H12a.5.5 0 0 0 0-1H9.5V1.5Z"/>
        </svg>
        新建文件
      </div>
      <div class="context-menu-item" @click="handleNewFolder">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M1.5 3.5a1 1 0 0 1 1-1h3.172a1 1 0 0 1 .707.293L7.5 3.914H13.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V3.5Z"/>
        </svg>
        新建文件夹
      </div>
      <div class="context-menu-item" @click="handleRename">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5zm-9.761 5.175-.106.106-1.113 2.78 2.78-1.113.106-.106A.5.5 0 0 1 5 10.5V10h-.5a.5.5 0 0 1-.5-.5V9h-.293a.5.5 0 0 1-.176-.034z"/>
        </svg>
        重命名
      </div>
      <div class="context-menu-divider"></div>
      <div class="context-menu-item danger" @click="handleDelete">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5Zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5Zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6Z"/>
          <path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1ZM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118ZM2.5 3V2h11v1h-11Z"/>
        </svg>
        删除
      </div>
    </div>
  </div>
</template>

<style scoped>
.file-tree-panel {
  flex: 1;
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  font-size: 13px;
  user-select: none;
  overflow: hidden;
}

.panel-toolbar {
  display: flex;
  align-items: center;
  padding: 6px 12px;
  flex-shrink: 0;
}

.icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  border-radius: 4px;
  cursor: pointer;
  padding: 0;
}

.icon-btn:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.root-path {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  color: var(--text-muted);
  font-size: 12px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.root-path-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tree-container {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 4px 0;
}

/* Context menu */
.context-menu {
  position: fixed;
  z-index: 1000;
  min-width: 160px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  padding: 4px 0;
}

.context-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  cursor: pointer;
  color: var(--text-primary);
  font-size: 13px;
}

.context-menu-item:hover {
  background: var(--accent-color);
  color: #fff;
}

.context-menu-item.danger:hover {
  background: #e74c3c;
  color: #fff;
}

.context-menu-divider {
  height: 1px;
  background: var(--border-color);
  margin: 4px 8px;
}

/* Empty state */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 32px 16px;
  color: var(--text-muted);
  text-align: center;
  flex: 1;
}

.empty-state p {
  font-size: 13px;
  line-height: 1.5;
}

.open-dir-btn {
  padding: 6px 16px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 13px;
}

.open-dir-btn:hover {
  background: var(--accent-color);
  color: #fff;
  border-color: var(--accent-color);
}

/* Loading */
.tree-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  color: var(--text-muted);
  font-size: 13px;
}

.loading-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--border-color);
  border-top-color: var(--accent-color);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  display: inline-block;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>