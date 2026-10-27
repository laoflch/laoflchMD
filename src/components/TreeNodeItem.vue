<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { FileEntry } from '../types'

const props = defineProps<{
  entry: FileEntry
  expanded: Set<string>
  selectedPath: string | null
  depth: number
  renamingPath: string | null
  indexedPaths: Set<string>
  vectorIndexedPaths: Set<string>
}>()

const emit = defineEmits<{
  select: [entry: FileEntry]
  toggleExpand: [entry: FileEntry]
  contextmenu: [event: MouseEvent, entry: FileEntry]
  renameComplete: [oldPath: string, newPath: string | null]
  childrenLoaded: [entries: FileEntry[]]
  indexClick: [entry: FileEntry]
}>()

const children = ref<FileEntry[]>([])
const childLoading = ref(false)

const isExpanded = computed(() => props.expanded.has(props.entry.path))
const isSelected = computed(() => props.selectedPath === props.entry.path)
// 每个节点按自身路径判断是否已索引（避免子节点错误继承父节点的索引状态）
const isIndexed = computed(
  () => props.entry.isMarkdown && !props.entry.isDirectory && props.indexedPaths.has(props.entry.path)
)
// 是否已生成向量索引
const isVectorIndexed = computed(
  () => props.entry.isMarkdown && !props.entry.isDirectory && props.vectorIndexedPaths.has(props.entry.path)
)

// Context menu state for this node
const showRenameInput = ref(false)
const renameValue = ref('')

async function loadChildren() {
  if (children.value.length > 0) return
  childLoading.value = true
  try {
    children.value = await window.api.readDir(props.entry.path)
  } catch {
    children.value = []
  }
  childLoading.value = false
  emit('childrenLoaded', children.value)
}

function handleClick() {
  // 单击：目录由父组件处理选中+展开；文件打开
  emit('select', props.entry)
}

// 点击三角号：仅目录可展开/收起
function handleToggleExpand() {
  if (!props.entry.isDirectory) return
  emit('toggleExpand', props.entry)
}

function handleContextMenu(event: MouseEvent) {
  emit('contextmenu', event, props.entry)
}

// Load children on expand
if (props.entry.isDirectory && isExpanded.value) {
  loadChildren()
}

// 目录被展开时加载子节点
watch(isExpanded, (val) => {
  if (val) loadChildren()
})

// Watch for rename trigger from parent
watch(() => props.renamingPath, (newVal) => {
  if (newVal === props.entry.path) {
    startRename()
  }
})

function handleChildSelect(entry: FileEntry) {
  emit('select', entry)
}

function handleChildToggleExpand(entry: FileEntry) {
  emit('toggleExpand', entry)
}

function handleChildContextMenu(event: MouseEvent, entry: FileEntry) {
  emit('contextmenu', event, entry)
}

function handleChildRenameComplete(oldPath: string, newPath: string | null) {
  emit('renameComplete', oldPath, newPath)
}

function handleChildChildrenLoaded(entries: FileEntry[]) {
  emit('childrenLoaded', entries)
}

function handleChildIndexClick(entry: FileEntry) {
  emit('indexClick', entry)
}

function handleRenameKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    confirmRename()
  } else if (e.key === 'Escape') {
    cancelRename()
  }
}

function startRename() {
  renameValue.value = props.entry.name
  showRenameInput.value = true
}

async function confirmRename() {
  if (!showRenameInput.value) return
  showRenameInput.value = false
  let newPath: string | null = null
  if (renameValue.value && renameValue.value !== props.entry.name) {
    newPath = await window.api.rename(props.entry.path, renameValue.value)
  }
  emit('renameComplete', props.entry.path, newPath)
}

function cancelRename() {
  showRenameInput.value = false
  emit('renameComplete', props.entry.path, null)
}

defineExpose({ startRename })
</script>

<template>
  <div class="tree-node">
    <!-- Node row -->
    <div
      class="tree-node-row"
      :class="{
        'is-directory': entry.isDirectory,
        'is-selected': isSelected,
        'is-md-file': entry.fileType !== null && !entry.isDirectory
      }"
      :style="{ paddingLeft: `${12 + depth * 16}px` }"
      @click="handleClick"
      @contextmenu="handleContextMenu"
    >
      <!-- Expand/collapse arrow for directories -->
      <span v-if="entry.isDirectory" class="tree-arrow" :class="{ expanded: isExpanded }" @click.stop="handleToggleExpand">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <path d="M6 4l4 4-4 4"/>
        </svg>
      </span>
      <span v-else class="tree-arrow-spacer"></span>

      <!-- Icon -->
      <span class="tree-icon">
        <!-- Directory icon -->
        <svg v-if="entry.isDirectory" width="16" height="16" viewBox="0 0 16 16" :fill="isExpanded ? '#4a9eff' : '#569cd6'">
          <path v-if="isExpanded" d="M1.5 3.5a1 1 0 0 1 1-1h3.172a1 1 0 0 1 .707.293L7.5 3.914H13.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V3.5Z"/>
          <path v-else d="M.5 3.5a.5.5 0 0 1 .5-.5h4.793a.5.5 0 0 1 .353.146l1.5 1.5A.5.5 0 0 0 8 4.793h6.5a.5.5 0 0 1 .5.5v7.207a.5.5 0 0 1-.5.5H1a.5.5 0 0 1-.5-.5V3.5Z"/>
        </svg>
        <!-- Markdown file icon -->
        <svg v-else-if="entry.isMarkdown" width="16" height="16" viewBox="0 0 16 16" fill="#569cd6">
          <path d="M2 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2zm2-1a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H4z"/>
          <path d="M6.5 11.5v-5l-1.5 1.5V6l3-3 3 3v2l-1.5-1.5v5h-3z"/>
        </svg>
        <!-- YAML / HTML / Jinja2 file icon -->
        <svg v-else-if="entry.fileType" width="16" height="16" viewBox="0 0 16 16" fill="#569cd6">
          <path d="M2 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2zm2-1a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H4z"/>
        </svg>
        <!-- Other file icon -->
        <svg v-else width="16" height="16" viewBox="0 0 16 16" fill="#999">
          <path d="M2 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2zm2-1a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H4z"/>
        </svg>
      </span>

      <!-- Name -->
      <input
        v-if="showRenameInput"
        class="rename-input"
        v-model="renameValue"
        @keydown="handleRenameKeydown"
        @blur="confirmRename"
        @click.stop
        autofocus
      />
      <span v-else class="tree-label">{{ entry.name }}</span>
      <span
        v-if="isIndexed"
        class="indexed-tag"
        title="查看索引详情"
        @click.stop="emit('indexClick', props.entry)"
      >全文</span>
      <span v-if="isVectorIndexed" class="indexed-tag vector" title="已生成向量索引">向量</span>
    </div>

    <!-- Children (for directories) -->
    <div v-if="entry.isDirectory && isExpanded" class="tree-children">
      <div v-if="childLoading" class="tree-loading-child" :style="{ paddingLeft: `${28 + (depth + 1) * 16}px` }">
        <span class="loading-spinner"></span>
        加载中...
      </div>
      <TreeNodeItem
        v-for="child in children"
        :key="child.path"
        v-else
        :entry="child"
        :expanded="expanded"
        :selected-path="selectedPath"
        :renaming-path="renamingPath"
        :indexed-paths="indexedPaths"
        :vector-indexed-paths="vectorIndexedPaths"
        :depth="depth + 1"
        @select="handleChildSelect"
        @toggle-expand="handleChildToggleExpand"
        @contextmenu="handleChildContextMenu"
        @rename-complete="handleChildRenameComplete"
        @children-loaded="handleChildChildrenLoaded"
        @index-click="handleChildIndexClick"
      />
    </div>
  </div>
</template>

<style scoped>
.tree-node-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  cursor: pointer;
  border-radius: 4px;
  margin: 1px 4px;
  transition: background 0.1s;
  white-space: nowrap;
}

.tree-node-row:hover {
  background: var(--bg-tertiary);
}

.tree-node-row.is-selected {
  background: var(--accent-color);
  color: #fff;
}

.tree-node-row.is-selected .tree-label {
  color: #fff;
}

.tree-arrow {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: var(--text-muted);
  transition: transform 0.15s;
}

.tree-arrow.expanded {
  transform: rotate(90deg);
}

.tree-arrow-spacer {
  width: 16px;
  flex-shrink: 0;
}

.tree-icon {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.tree-label {
  font-size: 13px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 已索引标签：白字 + 绿色背景 */
.indexed-tag {
  flex-shrink: 0;
  margin-left: 4px;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  line-height: 1.5;
  color: #fff;
  background: #67c23a;
  user-select: none;
}

.tree-node-row.is-selected .indexed-tag {
  background: rgba(255, 255, 255, 0.25);
}

/* 向量索引标签：紫色背景区分全文（绿色） */
.indexed-tag.vector {
  background: #8209c9;
}

.rename-input {
  flex: 1;
  min-width: 0;
  background: var(--bg-primary);
  border: 1px solid var(--accent-color);
  border-radius: 3px;
  padding: 1px 4px;
  font-size: 13px;
  color: var(--text-primary);
  outline: none;
}

.tree-children {
  /* Children are rendered with deeper padding */
}

.tree-loading-child {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  color: var(--text-muted);
  font-size: 12px;
}

.loading-spinner {
  width: 12px;
  height: 12px;
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