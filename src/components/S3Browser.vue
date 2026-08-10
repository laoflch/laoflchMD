<script setup lang="ts">
import { ref } from 'vue'
import { useS3Store } from '../stores/s3'
import { useEditorStore } from '../stores/editor'
import type { S3ObjectEntry } from '../types'

const s3 = useS3Store()
const editor = useEditorStore()

// 右键菜单
const contextMenu = ref({ show: false, x: 0, y: 0 })
const currentFile = ref<S3ObjectEntry | null>(null)
const showDetailsDialog = ref(false)

function showContextMenu(e: MouseEvent, file: S3ObjectEntry) {
  currentFile.value = file
  contextMenu.value = { show: true, x: e.clientX, y: e.clientY }
}

function hideContextMenu() {
  contextMenu.value.show = false
}

function showFileDetails() {
  hideContextMenu()
  showDetailsDialog.value = true
}

async function deleteFile() {
  if (!currentFile.value) return
  hideContextMenu()
  const confirmed = confirm(`确定要删除文件 "${currentFile.value.name}" 吗？`)
  if (confirmed) {
    await s3.deleteObject(currentFile.value.key)
  }
}

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return '-'
  const sizes = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let size = bytes
  while (size >= 1024 && i < sizes.length - 1) {
    size /= 1024
    i++
  }
  return size.toFixed(1) + ' ' + sizes[i]
}

// 点击其他地方关闭右键菜单
document.addEventListener('click', hideContextMenu)

// 打开对象到编辑器（Markdown 文本）
async function openObject(entry: S3ObjectEntry) {
  if (!entry.isMarkdown) return
  const content = await s3.getObject(entry)
  if (content !== null) {
    editor.setContent(content)
    editor.setFilePath(entry.key)
  }
}

// 打开文件夹时，确保传入的是解码后的前缀（store 内部已经是解码后的）
// 面包屑跳转
function goToBreadcrumb(index: number) {
  const parts = s3.breadcrumb.slice(0, index + 1)
  s3.openFolder(parts.join('/') + '/')
}

// 服务端 Key 为明文，展示时直接显示原始文件名，不做任何解码
function decodeName(name: string): string {
  return name
}

// 另存为到 S3
const showSaveDialog = ref(false)
const saveKey = ref('')
const saving = ref(false)
const saveMessage = ref<{ type: 'ok' | 'err'; text: string } | null>(null)

function openSaveDialog() {
  if (!s3.currentBucket) {
    s3.notice = '请先选择一个桶作为保存目标'
    return
  }
  const base =
    editor.fileName && editor.fileName !== '无标题文档' ? editor.fileName : 'untitled.md'
  saveKey.value = s3.currentFolderKey() + base
  saveMessage.value = null
  showSaveDialog.value = true
}

async function doSave() {
  if (!saveKey.value) return
  saving.value = true
  saveMessage.value = null
  const ok = await s3.putObject(saveKey.value, editor.content)
  saving.value = false
  if (ok) {
    saveMessage.value = { type: 'ok', text: `已保存到 s3://${s3.currentBucket}/${saveKey.value}` }
    s3.refreshListing()
    setTimeout(() => (showSaveDialog.value = false), 1500)
  } else {
    saveMessage.value = { type: 'err', text: s3.error || '保存失败' }
  }
}
</script>

<template>
  <div class="s3-panel" :class="{ 'dark-theme': editor.isDarkTheme }">
    <!-- 未连接：配置表单 -->
    <div v-if="!s3.connected" class="s3-config">
      <h3 class="s3-config-title">S3 对象存储</h3>
      <p class="s3-config-hint">通过 S3 标准接口访问对象存储（兼容 AWS S3、MinIO 等）</p>

      <label class="s3-field">
        <span>Endpoint（可选）</span>
        <input v-model="s3.config.endpoint" type="text" placeholder="https://s3.amazonaws.com 或 MinIO 地址" />
      </label>
      <label class="s3-field">
        <span>Region</span>
        <input v-model="s3.config.region" type="text" placeholder="us-east-1" />
      </label>
      <label class="s3-field">
        <span>Access Key ID</span>
        <input v-model="s3.config.accessKeyId" type="text" placeholder="AKIA..." />
      </label>
      <label class="s3-field">
        <span>Secret Access Key</span>
        <input v-model="s3.config.secretAccessKey" type="password" placeholder="••••••••" />
      </label>

      <button class="s3-btn primary" :disabled="s3.loading || !s3.config.accessKeyId || !s3.config.secretAccessKey" @click="s3.connect">
        {{ s3.loading ? '连接中...' : '连接并列出桶' }}
      </button>

      <div v-if="s3.error" class="s3-error">{{ s3.error }}</div>
    </div>

    <!-- 已连接 -->
    <template v-else>
      <!-- 选择桶 -->
      <div v-if="!s3.currentBucket" class="s3-list">
        <div class="s3-list-title">桶（Buckets）</div>
        <div v-if="s3.loading" class="s3-loading">加载中...</div>
        <div v-else-if="s3.buckets.length === 0" class="s3-empty">没有可用的桶</div>
        <div
          v-for="bucket in s3.buckets"
          :key="bucket.name"
          class="s3-item"
          @click="s3.openBucket(bucket.name)"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
            <path d="M4 6h6l2 2h8v10H4V6z"/>
          </svg>
          <span class="s3-item-name">{{ bucket.name }}</span>
        </div>
      </div>

      <!-- 对象浏览 -->
      <div v-else class="s3-browse">
        <!-- 面包屑 -->
        <div class="s3-breadcrumb-row">
          <div class="s3-breadcrumb">
            <button class="s3-crumb" @click="s3.goUp">…</button>
            <span class="s3-crumb-sep">/</span>
            <button class="s3-crumb" @click="s3.openBucket(s3.currentBucket)">
              {{ s3.currentBucket }}
            </button>
            <template v-for="(seg, i) in s3.breadcrumb" :key="i">
              <span class="s3-crumb-sep">/</span>
              <button class="s3-crumb" @click="goToBreadcrumb(i)">{{ decodeName(seg) }}</button>
            </template>
          </div>
          <div class="s3-toolbar">
            <button class="s3-btn" title="重新连接" @click="s3.connect">重连</button>
            <button class="s3-btn primary" title="将当前编辑内容另存到 S3" @click="openSaveDialog">另存S3</button>
          </div>
        </div>

        <div class="s3-list">
          <div v-if="s3.loading" class="s3-loading">加载中...</div>
          <template v-else>
            <div
              v-for="folder in s3.folders"
              :key="folder"
              class="s3-item"
              @click="s3.openFolder(folder)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
                <path d="M4 6h6l2 2h8v10H4V6z"/>
              </svg>
              <span class="s3-item-name">{{ decodeName(folder.split('/').filter(Boolean).pop() || '') }}</span>
            </div>

            <div
              v-for="file in s3.files"
              :key="file.key"
              class="s3-item"
              :class="{ 's3-item-file': !file.isMarkdown, 's3-item-openable': file.isMarkdown }"
              :title="file.key"
              @click="file.isMarkdown && openObject(file)"
              @contextmenu.prevent="showContextMenu($event, file)"
            >
              <svg v-if="file.isMarkdown" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"/>
                <path d="M14 2v6h6"/>
              </svg>
              <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"/>
              </svg>
              <span class="s3-item-name">{{ decodeName(file.name) }}</span>
              <span v-if="file.isMarkdown" class="s3-item-tag">打开</span>
            </div>

            <div v-if="s3.folders.length === 0 && s3.files.length === 0" class="s3-empty">
              此目录为空
            </div>
          </template>
        </div>
      </div>
    </template>

    <!-- 提示信息 -->
    <div v-if="s3.notice" class="s3-notice" @click="s3.notice = null">
      {{ s3.notice }}
    </div>
    <div v-if="s3.error" class="s3-error" @click="s3.clearError()">{{ s3.error }}</div>

    <!-- 右键菜单 -->
    <div
      v-if="contextMenu.show"
      class="s3-context-menu"
      :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
    >
      <div class="s3-context-menu-item" @click="showFileDetails">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
          <path d="M1 12h14M12 5l7 7-7 7"/>
        </svg>
        显示详情
      </div>
      <div class="s3-context-menu-divider"></div>
      <div class="s3-context-menu-item danger" @click="deleteFile">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
          <path d="M3 6h18M8 6v14a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V6M10 6V4a2 2 0 0 1 2-2h0a2 2 0 0 1 2 2v2"/>
        </svg>
        删除
      </div>
    </div>

    <!-- 文件详情对话框 -->
    <div v-if="showDetailsDialog" class="s3-modal-mask" @click.self="showDetailsDialog = false">
      <div class="s3-modal">
        <h4>文件详情</h4>
        <div class="s3-details">
          <div class="s3-detail-row">
            <span class="s3-detail-label">文件名</span>
            <span class="s3-detail-value">{{ currentFile?.name }}</span>
          </div>
          <div class="s3-detail-row">
            <span class="s3-detail-label">对象键（Key）</span>
            <span class="s3-detail-value">{{ currentFile?.key }}</span>
          </div>
          <div class="s3-detail-row">
            <span class="s3-detail-label">大小</span>
            <span class="s3-detail-value">{{ formatSize(currentFile?.size) }}</span>
          </div>
          <div class="s3-detail-row">
            <span class="s3-detail-label">最后修改</span>
            <span class="s3-detail-value">{{ currentFile?.lastModified }}</span>
          </div>
          <div v-if="currentFile?.eTag" class="s3-detail-row">
            <span class="s3-detail-label">ETag</span>
            <span class="s3-detail-value">{{ currentFile.eTag }}</span>
          </div>
        </div>
        <div class="s3-modal-actions">
          <button class="s3-btn" @click="showDetailsDialog = false">关闭</button>
        </div>
      </div>
    </div>

    <!-- 另存为对话框 -->
    <div v-if="showSaveDialog" class="s3-modal-mask" @click.self="showSaveDialog = false">
      <div class="s3-modal">
        <h4>另存为到 S3</h4>
        <label class="s3-field">
          <span>对象键（Key）</span>
          <input v-model="saveKey" type="text" placeholder="folder/name.md" @keyup.enter="doSave" />
        </label>
        <div v-if="saveMessage" class="s3-modal-msg" :class="saveMessage.type">
          {{ saveMessage.text }}
        </div>
        <div class="s3-modal-actions">
          <button class="s3-btn" :disabled="saving" @click="showSaveDialog = false">取消</button>
          <button class="s3-btn primary" :disabled="saving || !saveKey" @click="doSave">
            {{ saving ? '保存中...' : '保存' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.s3-panel {
  flex: 1;
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  font-size: 13px;
  color: var(--text-primary);
  overflow: hidden;
  padding: 10px 12px;
  box-sizing: border-box;
  user-select: none;
}

.s3-config {
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
}

.s3-config-title {
  margin: 0;
  font-size: 14px;
}

.s3-config-hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
}

.s3-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.s3-field span {
  font-size: 12px;
  color: var(--text-secondary);
}

.s3-field input {
  padding: 6px 8px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
}

.s3-field input:focus {
  border-color: var(--accent-color);
}

.s3-toolbar {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-bottom: 8px;
  flex-shrink: 0;
}

.s3-btn {
  padding: 5px 10px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-primary);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 12px;
}

.s3-btn:hover {
  background: var(--bg-tertiary);
}

.s3-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.s3-btn.primary {
  background: var(--accent-color);
  border-color: var(--accent-color);
  color: #fff;
}

.s3-btn.primary:hover {
  background: var(--accent-hover);
}

.s3-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.s3-list-title {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.s3-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
}

.s3-item:hover {
  background: var(--bg-tertiary);
}

.s3-item-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}

.s3-item-file {
  cursor: default;
}

.s3-item-openable {
  cursor: pointer;
}

.s3-item-tag {
  font-size: 11px;
  color: var(--accent-color);
  flex-shrink: 0;
}

.s3-browse {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.s3-breadcrumb-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0 8px;
  border-bottom: 1px solid var(--border-color);
  margin-bottom: 6px;
  flex-wrap: wrap;
  gap: 8px;
}
.s3-breadcrumb {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
  flex: 1;
  min-width: 0;
}
.s3-crumb {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 3px;
  font-size: 12px;
  white-space: nowrap;
}
.s3-crumb:hover {
  color: var(--accent-color);
  background: var(--bg-tertiary);
}
.s3-crumb-sep {
  color: var(--text-muted);
}
.s3-toolbar {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.s3-error {
  margin-top: 8px;
  padding: 8px 10px;
  background: rgba(220, 53, 69, 0.12);
  color: #dc3545;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}

.s3-notice {
  margin-top: 8px;
  padding: 8px 10px;
  background: rgba(74, 144, 217, 0.12);
  color: var(--accent-color);
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}

.s3-modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.s3-modal {
  width: 320px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: var(--shadow-sm);
}

.s3-modal h4 {
  margin: 0;
  font-size: 14px;
}

.s3-modal-msg {
  font-size: 12px;
  padding: 6px 8px;
  border-radius: 4px;
}

.s3-modal-msg.ok {
  color: #28a745;
  background: rgba(40, 167, 69, 0.12);
}

.s3-modal-msg.err {
  color: #dc3545;
  background: rgba(220, 53, 69, 0.12);
}

.s3-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.s3-context-menu {
  position: fixed;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  box-shadow: var(--shadow-md);
  z-index: 200;
  padding: 4px 0;
  min-width: 140px;
}

.s3-context-menu-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  cursor: pointer;
  color: var(--text-primary);
  font-size: 12px;
}

.s3-context-menu-item:hover {
  background: var(--bg-tertiary);
}

.s3-context-menu-item.danger {
  color: #dc3545;
}

.s3-context-menu-divider {
  height: 1px;
  background: var(--border-color);
  margin: 4px 0;
}

.s3-details {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.s3-detail-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.s3-detail-label {
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.s3-detail-value {
  font-size: 12px;
  color: var(--text-primary);
  word-break: break-all;
}
</style>
