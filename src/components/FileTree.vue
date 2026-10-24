<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { useEditorStore } from '../stores/editor'
import { useSettingsStore } from '../stores/settings'
import { useToastStore } from '../stores/toast'
import type { FileEntry, IndexSearchConfig, IndexSearchResult } from '../types'
import TreeNodeItem from './TreeNodeItem.vue'
import IndexInfoDialog from './IndexInfoDialog.vue'

const store = useEditorStore()
const settings = useSettingsStore()
const toastStore = useToastStore()

const emit = defineEmits<{
  close: []
}>()

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
  checkIndexed(treeData.value)
}

async function openDirectory() {
  const dir = await window.api.openDirectory()
  if (dir) {
    await openDir(dir)
  }
}

async function selectNode(entry: FileEntry) {
  if (entry.isDirectory) {
    // 点击目录：选中并展开/收起
    selectedPath.value = entry.path
    toggleExpand(entry)
    return
  }

  if (!entry.isMarkdown) return

  // Open file directly
  try {
    const content = await window.api.readFile(entry.path)
    if (content !== null) {
      store.loadFile(content, entry.path, null)
      selectedPath.value = entry.path
    }
  } catch (err) {
    console.error('Failed to open file:', err)
  }
}

// 展开/收起目录（双击行或点击三角号触发）
function toggleExpand(entry: FileEntry) {
  if (!entry.isDirectory) return
  const newExpanded = new Set(expanded.value)
  if (newExpanded.has(entry.path)) {
    newExpanded.delete(entry.path)
  } else {
    newExpanded.add(entry.path)
  }
  expanded.value = newExpanded
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

// 全文索引功能是否关闭（索引服务总开关 / 全文索引子开关）
const fulltextOff = computed(() => !settings.indexEnabled || !settings.fulltextEnabled)
// 向量索引功能是否关闭（索引服务总开关 / 向量文本索引子开关）
const vectorOff = computed(() => !settings.indexEnabled || !settings.vectorTextEnabled)

// 开关变化时同步刷新「全文」标签：关闭清空，重新打开时重新检测
watch([() => settings.indexEnabled, () => settings.fulltextEnabled], () => {
  if (fulltextOff.value) {
    indexedPaths.value = new Set()
  }
  if (rootDir.value) {
    checkIndexed(treeData.value)
  }
})

// 开关变化时同步刷新「向量」标签
watch([() => settings.indexEnabled, () => settings.vectorTextEnabled], () => {
  if (vectorOff.value) {
    vectorIndexedPaths.value = new Set()
  }
  if (rootDir.value) {
    checkIndexed(treeData.value)
  }
})

// 索引详情弹窗状态
const indexInfoOpen = ref(false)
const indexInfoDoc = ref<IndexSearchResult | null>(null)
const indexInfoEntry = ref<FileEntry | null>(null)

// 点击「全文」标签：查询并展示索引详细信息
async function showIndexInfo(entry: FileEntry) {
  indexInfoEntry.value = entry
  try {
    const protocol = settings.indexProtocol
    const host = protocol === 'grpc' ? settings.grpcHost : settings.restHost
    const port = protocol === 'grpc' ? settings.grpcPort : settings.restPort
    const res = await window.api.indexGetDoc(protocol, host, port, settings.indexName, 'local', entry.path)
    if (!res.ok || !res.doc) {
      toastStore.pushToast('err', res.message || '获取索引详情失败')
      return
    }
    indexInfoDoc.value = res.doc
    indexInfoOpen.value = true
  } catch (e) {
    toastStore.pushToast('err', e instanceof Error ? e.message : '获取索引详情失败')
  }
}

// 索引项被删除后：移除对应文件的「全文」标签
function onIndexInfoDeleted() {
  const entry = indexInfoEntry.value
  if (entry) {
    const next = new Set(indexedPaths.value)
    next.delete(entry.path)
    indexedPaths.value = next
  }
  indexInfoEntry.value = null
}

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
  if (newPath) {
    // If the renamed file was open, update the store file path
    if (store.filePath === oldPath) {
      store.setFilePath(newPath)
    }
    await refreshTree()
  }
}

// 全文检索：生成索引
const indexing = ref(false)

async function handleIndex() {
  closeContextMenu()
  const targetPath = contextMenu.value.targetPath
  const isDir = contextMenu.value.isDirectory
  if (!targetPath) return
  // 索引服务关闭时禁用全文索引功能
  if (!settings.indexEnabled || !settings.fulltextEnabled) {
    toastStore.pushToast(
      'err',
      settings.indexEnabled ? '全文索引服务已关闭，请在全局设置中启用' : '索引服务已关闭，请在全局设置中启用'
    )
    return
  }
  indexing.value = true
  const protocol = settings.indexProtocol
  const host = protocol === 'grpc' ? settings.grpcHost : settings.restHost
  const port = protocol === 'grpc' ? settings.grpcPort : settings.restPort
  try {
    if (isDir) {
      // 目录：逐文件建索引，每个文件独立一条进度提示（堆叠显示，8 秒后自动消失）
      const unsubscribe = window.api.onIndexProgress((p) => {
        toastStore.pushToast('progress', `正在索引 ${p.done}/${p.total}: ${p.fileName}`, true, 8000)
      })
      try {
        const res = await window.api.indexDir(protocol, host, port, settings.indexName, targetPath)
        toastStore.pushToast(res.ok ? 'ok' : 'err', res.message)
        if (res.ok) checkIndexed(treeData.value)
      } finally {
        unsubscribe()
      }
    } else {
      const res = await window.api.indexLocalFile(protocol, host, port, settings.indexName, targetPath)
      toastStore.pushToast(res.ok ? 'ok' : 'err', res.message)
      // 仅真正索引成功（跳过空文件时 docId 为空）才标记「全文」
      if (res.ok && res.docId !== undefined) {
        const next = new Set(indexedPaths.value)
        next.add(targetPath)
        indexedPaths.value = next
      }
    }
  } catch (e: unknown) {
    toastStore.pushToast('err', e instanceof Error ? e.message : '生成索引失败')
  } finally {
    indexing.value = false
  }
}

// 索引状态检查：统一查询「全文」+「向量」两个状态（按 BLAKE3 摘要精确匹配）
const indexedPaths = ref<Set<string>>(new Set())
const vectorIndexedPaths = ref<Set<string>>(new Set())
let checkSeq = 0

// 全文索引服务（md_docs）连接参数：向量索引的生成/删除也走该服务保存状态
function searchCfg(): IndexSearchConfig {
  const protocol = settings.indexProtocol
  return {
    protocol,
    host: protocol === 'grpc' ? settings.grpcHost : settings.restHost,
    port: protocol === 'grpc' ? settings.grpcPort : settings.restPort,
    indexName: settings.indexName
  }
}

// 索引状态查询配置：开启 Raft 同步后，状态改为从 Raft 按 blake3 读取
function raftQueryCfg() {
  return {
    enabled: settings.raftSyncEnabled,
    protocol: settings.raftProtocol,
    host: settings.raftHost,
    port: settings.raftProtocol === 'grpc' ? settings.raftGrpcPort : settings.raftRestPort,
    group: settings.raftGroup
  }
}

async function checkIndexed(files: FileEntry[]) {
  // 索引服务关闭时不检测，清空「全文」「向量」标签
  if (!settings.indexEnabled) {
    indexedPaths.value = new Set()
    vectorIndexedPaths.value = new Set()
    return
  }
  const mdFiles = files.filter((f) => f.isMarkdown && !f.isDirectory)
  if (mdFiles.length === 0) return
  const seq = ++checkSeq
  try {
    const res = await window.api.indexCheckFiles(
      searchCfg().protocol,
      searchCfg().host,
      searchCfg().port,
      searchCfg().indexName,
      mdFiles.map((f) => f.path),
      raftQueryCfg()
    )
    if (seq !== checkSeq) return // 丢弃过期结果
    if (!res.ok) return
    const nextFt = new Set(indexedPaths.value)
    const nextVec = new Set(vectorIndexedPaths.value)
    for (const [p, st] of Object.entries(res.results)) {
      if (st.hasFulltext) nextFt.add(p)
      else nextFt.delete(p)
      if (st.hasVector) nextVec.add(p)
      else nextVec.delete(p)
    }
    // 子开关关闭时不显示对应标签
    if (!settings.fulltextEnabled) nextFt.clear()
    if (!settings.vectorTextEnabled) nextVec.clear()
    indexedPaths.value = nextFt
    vectorIndexedPaths.value = nextVec
  } catch {
    // 服务不可达等静默忽略，标签不显示
  }
}

function handleChildrenLoaded(entries: FileEntry[]) {
  checkIndexed(entries)
}

// 向量索引：生成向量索引（仅 gRPC，复用 grpc 地址/端口）
const vectorIndexing = ref(false)

async function handleVectorIndex() {
  closeContextMenu()
  const targetPath = contextMenu.value.targetPath
  const isDir = contextMenu.value.isDirectory
  if (!targetPath) return
  // 索引服务关闭时禁用向量索引功能
  if (!settings.indexEnabled || !settings.vectorTextEnabled) {
    toastStore.pushToast(
      'err',
      settings.indexEnabled ? '向量文本索引服务已关闭，请在全局设置中启用' : '索引服务已关闭，请在全局设置中启用'
    )
    return
  }
  vectorIndexing.value = true
  try {
    const chunkSize = settings.vectorChunkSize
    const overlap = settings.vectorChunkOverlap
    if (isDir) {
      // 目录：逐文件建向量索引，每个文件独立一条进度提示
      const unsubscribe = window.api.onVectorProgress((p) => {
        toastStore.pushToast('progress', `正在向量索引 ${p.done}/${p.total}: ${p.fileName}`, true, 8000)
      })
      try {
        const res = await window.api.vectorIndexDir(
          searchCfg(),
          settings.grpcHost,
          settings.grpcPort,
          settings.vectorIndexName,
          settings.vectorModelName,
          targetPath,
          chunkSize,
          overlap
        )
        toastStore.pushToast(res.ok ? 'ok' : 'err', res.message)
        if (res.ok) checkIndexed(treeData.value)
      } finally {
        unsubscribe()
      }
    } else {
      const res = await window.api.vectorIndexLocal(
        searchCfg(),
        settings.grpcHost,
        settings.grpcPort,
        settings.vectorIndexName,
        settings.vectorModelName,
        targetPath,
        chunkSize,
        overlap
      )
      toastStore.pushToast(res.ok ? 'ok' : 'err', res.message)
      // 仅真正索引成功（跳过空文件时 count 为 0）才标记「向量」
      if (res.ok && res.count > 0) {
        const next = new Set(vectorIndexedPaths.value)
        next.add(targetPath)
        vectorIndexedPaths.value = next
      }
    }
  } catch (e: unknown) {
    toastStore.pushToast('err', e instanceof Error ? e.message : '生成向量索引失败')
  } finally {
    vectorIndexing.value = false
  }
}

// 向量索引：删除目标文件/目录的向量索引
async function handleVectorDelete() {
  closeContextMenu()
  const targetPath = contextMenu.value.targetPath
  if (!targetPath) return
  try {
    const res = await window.api.vectorDeleteFile(
      searchCfg(),
      settings.grpcHost,
      settings.grpcPort,
      settings.vectorIndexName,
      'local',
      targetPath
    )
    toastStore.pushToast(res.ok ? 'ok' : 'err', res.message)
    if (res.ok) {
      const next = new Set(vectorIndexedPaths.value)
      next.delete(targetPath)
      vectorIndexedPaths.value = next
    }
  } catch (e: unknown) {
    toastStore.pushToast('err', e instanceof Error ? e.message : '删除向量索引失败')
  }
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
  <div class="file-tree-sidebar" :class="{ 'dark-theme': store.isDarkTheme }" @contextmenu.prevent>
    <!-- Header: 目录名 + 打开文件夹按钮 -->
    <div class="sidebar-header">
      <div class="root-path" :title="rootDir || ''">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M1.5 3.5a1 1 0 0 1 1-1h3.172a1 1 0 0 1 .707.293L7.5 3.914H13.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V3.5Z"/>
        </svg>
        <span class="root-path-text">{{ rootDir ? rootDir.split('/').pop() || rootDir : '未打开文件夹' }}</span>
      </div>
      <div class="sidebar-actions">
        <button
          class="icon-btn"
          title="刷新"
          @click="refreshTree"
          :disabled="!rootDir || loading"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" :class="{ spinning: loading }">
            <path d="M13.5 8a5.5 5.5 0 1 1-1.8-4"/>
            <path d="M13 2v3.5h-3.5"/>
          </svg>
        </button>
        <button class="icon-btn" title="打开文件夹" @click="openDirectory">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1.5 3.5a1 1 0 0 1 1-1h3.172a1 1 0 0 1 .707.293L7.5 3.914H13.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V3.5Z"/>
          </svg>
        </button>
      </div>
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
        :indexed-paths="indexedPaths"
        :vector-indexed-paths="vectorIndexedPaths"
        :depth="0"
        @select="selectNode"
        @toggle-expand="toggleExpand"
        @contextmenu="showContextMenu"
        @rename-complete="handleRenameComplete"
        @children-loaded="handleChildrenLoaded"
        @index-click="showIndexInfo"
      />
    </div>

    <!-- 索引详情弹窗 -->
    <IndexInfoDialog :open="indexInfoOpen" :doc="indexInfoDoc" @close="indexInfoOpen = false" @deleted="onIndexInfoDeleted" />

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
      <div class="context-menu-item" :class="{ disabled: indexing || fulltextOff }" @click="handleIndex">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M8 2.5v11M3.5 8h9"/>
        </svg>
        生成全文索引
      </div>
      <div class="context-menu-item" :class="{ disabled: vectorIndexing || vectorOff }" @click="handleVectorIndex">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="4.5" cy="5" r="1.6"/>
          <circle cx="11.5" cy="4" r="1.6"/>
          <circle cx="11" cy="11.5" r="1.6"/>
          <path d="M4.5 5l5 5M11.5 4l-3 1.8M6.6 6.4l4.4 3"/>
        </svg>
        生成向量索引
      </div>
      <div class="context-menu-item" :class="{ disabled: vectorOff }" @click="handleVectorDelete">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 1.5h4M2.5 4h11M5.5 4l.5 10h4l.5-10M6.5 6.5v5M9.5 6.5v5"/>
        </svg>
        删除向量索引
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
.file-tree-sidebar {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: transparent;
  font-size: 13px;
  user-select: none;
  position: relative;
  overflow: hidden;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
  gap: 8px;
}

.sidebar-actions {
  display: flex;
  gap: 4px;
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

.icon-btn:hover:not(:disabled) {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.icon-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.icon-btn .spinning {
  animation: spin 0.8s linear infinite;
  transform-origin: center;
}

.root-path {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
  font-size: 12px;
  flex: 1;
  min-width: 0;
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

.context-menu-item.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.context-menu-item.disabled:hover {
  background: transparent;
  color: var(--text-primary);
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