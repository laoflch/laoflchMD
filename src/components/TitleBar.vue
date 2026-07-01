<script setup lang="ts">
import { useEditorStore } from '../stores/editor'

const store = useEditorStore()
</script>

<template>
  <div class="title-bar">
    <div class="title-bar-drag">
      <div class="app-icon">✦</div>
      <span class="file-name">{{ store.fileName }}</span>
      <span v-if="store.filePath" class="file-path" :title="store.filePath">
        — {{ store.filePath }}
      </span>
    </div>
    <div class="window-controls" v-if="false">
      <!-- Native window controls are used instead -->
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
  -webkit-app-region: drag;
  padding: 0 12px;
  flex-shrink: 0;
}

.title-bar-drag {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
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
</style>