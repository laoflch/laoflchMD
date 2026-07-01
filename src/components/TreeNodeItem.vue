<script setup lang="ts">
import { ref, computed } from 'vue'
import type { FileEntry } from '../types'

const props = defineProps<{
  entry: FileEntry
  expanded: Set<string>
  selectedPath: string | null
  depth: number
}>()

const emit = defineEmits<{
  select: [entry: FileEntry]
  contextmenu: [event: MouseEvent, entry: FileEntry]
}>()

const children = ref<FileEntry[]>([])
const childLoading = ref(false)

const isExpanded = computed(() => props.expanded.has(props.entry.path))
const isSelected = computed(() => props.selectedPath === props.entry.path)

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
}

function handleClick() {
  if (props.entry.isDirectory) {
    // Emit select so parent can handle expand/collapse
    emit('select', props.entry)
    // Also load children if expanded
    if (!isExpanded.value) {
      loadChildren()
    }
  } else {
    emit('select', props.entry)
  }
}

function handleContextMenu(event: MouseEvent) {
  emit('contextmenu', event, props.entry)
}

// Load children on expand
if (props.entry.isDirectory && isExpanded.value) {
  loadChildren()
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
  if (renameValue.value && renameValue.value !== props.entry.name) {
    await window.api.rename(props.entry.path, renameValue.value)
  }
}

function cancelRename() {
  showRenameInput.value = false
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
        'is-md-file': entry.isMarkdown && !entry.isDirectory
      }"
      :style="{ paddingLeft: `${12 + depth * 16}px` }"
      @click="handleClick"
      @contextmenu="handleContextMenu"
    >
      <!-- Expand/collapse arrow for directories -->
      <span v-if="entry.isDirectory" class="tree-arrow" :class="{ expanded: isExpanded }">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <path d="M6 4l4 4-4 4"/>
        </svg>
      </span>
      <span v-else class="tree-arrow-spacer"></span>

      <!-- Icon -->
      <span class="tree-icon">
        <!-- Directory icon -->
        <svg v-if="entry.isDirectory" width="16" height="16" viewBox="0 0 16 16" :fill="isExpanded ? '#e0a800' : '#d4a017'">
          <path v-if="isExpanded" d="M1.5 3.5a1 1 0 0 1 1-1h3.172a1 1 0 0 1 .707.293L7.5 3.914H13.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V3.5Z"/>
          <path v-else d="M.5 3.5a.5.5 0 0 1 .5-.5h4.793a.5.5 0 0 1 .353.146l1.5 1.5A.5.5 0 0 0 8 4.793h6.5a.5.5 0 0 1 .5.5v7.207a.5.5 0 0 1-.5.5H1a.5.5 0 0 1-.5-.5V3.5Z"/>
        </svg>
        <!-- Markdown file icon -->
        <svg v-else-if="entry.isMarkdown" width="16" height="16" viewBox="0 0 16 16" fill="#569cd6">
          <path d="M2 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2zm2-1a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H4z"/>
          <path d="M6.5 11.5v-5l-1.5 1.5V6l3-3 3 3v2l-1.5-1.5v5h-3z"/>
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
        :depth="depth + 1"
        @select="(e: FileEntry) => emit('select', e)"
        @contextmenu="(event: MouseEvent, e: FileEntry) => emit('contextmenu', event, e)"
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