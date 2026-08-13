<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type { VersionNote } from '../types'

defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

const version = ref('1.0.2')
const notes = ref<VersionNote[]>([])

onMounted(async () => {
  try {
    const info = await window.api.getAppInfo()
    version.value = info.version
    notes.value = info.notes
  } catch {
    // fallback to defaults
  }
})

function close() {
  emit('close')
}
</script>

<template>
  <div v-if="open" class="about-mask" @click.self="close">
    <div class="about-dialog">
      <div class="about-header">
        <div class="about-icon">✦</div>
        <div class="about-title-block">
          <div class="about-name">LaoflchMD</div>
          <div class="about-version">版本 {{ version }}</div>
        </div>
        <button class="about-close" title="关闭" @click="close">✕</button>
      </div>

      <div class="about-desc">
        跨平台 Markdown 编辑器，基于 Electron + Vue 3 构建，支持 Windows、Linux 和 macOS。
      </div>

      <div class="about-notes">
        <div class="notes-title">版本说明</div>
        <div v-for="note in notes" :key="note.version" class="note-block">
          <div class="note-head">
            <span class="note-version">v{{ note.version }}</span>
            <span class="note-date">{{ note.date }}</span>
          </div>
          <div class="note-title">{{ note.title }}</div>
          <ul class="note-changes">
            <li v-for="(change, i) in note.changes" :key="i">{{ change }}</li>
          </ul>
        </div>
      </div>

      <div class="about-actions">
        <button class="about-btn" @click="close">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.about-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 300;
}

.about-dialog {
  width: 460px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  box-shadow: var(--shadow-sm);
  overflow: hidden;
}

.about-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 18px 20px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
}

.about-icon {
  width: 40px;
  height: 40px;
  border-radius: 8px;
  background: var(--accent-color);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  flex-shrink: 0;
}

.about-title-block {
  flex: 1;
  min-width: 0;
}

.about-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.about-version {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 2px;
}

.about-close {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 14px;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 4px;
}

.about-close:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.about-desc {
  padding: 14px 20px;
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.6;
  border-bottom: 1px solid var(--border-color);
}

.about-notes {
  flex: 1;
  overflow-y: auto;
  padding: 12px 20px 20px;
}

.notes-title {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-muted);
  margin-bottom: 12px;
}

.note-block {
  margin-bottom: 18px;
}

.note-block:last-child {
  margin-bottom: 0;
}

.note-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.note-version {
  font-size: 14px;
  font-weight: 600;
  color: var(--accent-color);
}

.note-date {
  font-size: 11px;
  color: var(--text-muted);
}

.note-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  margin: 4px 0 6px;
}

.note-changes {
  margin: 0;
  padding-left: 18px;
}

.note-changes li {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.7;
}

.about-actions {
  padding: 12px 20px;
  display: flex;
  justify-content: flex-end;
  border-top: 1px solid var(--border-color);
}

.about-btn {
  padding: 6px 16px;
  border: 1px solid var(--border-color);
  border-radius: 5px;
  background: var(--bg-primary);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 13px;
}

.about-btn:hover {
  background: var(--bg-tertiary);
}
</style>
