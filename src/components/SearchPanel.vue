<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useSettingsStore } from '../stores/settings'
import { useEditorStore } from '../stores/editor'
import { useS3Store } from '../stores/s3'
import type { IndexSearchResult } from '../types'

const settings = useSettingsStore()
const editor = useEditorStore()
const s3 = useS3Store()

const query = ref('')
const results = ref<IndexSearchResult[]>([])
const searching = ref(false)
const searched = ref(false)
const error = ref<string | null>(null)
const checking = ref(false)
const indexMessage = ref<string | null>(null)

const host = computed(() =>
  settings.indexProtocol === 'grpc' ? settings.grpcHost : settings.restHost
)
const port = computed(() =>
  settings.indexProtocol === 'grpc' ? settings.grpcPort : settings.restPort
)
const protocolLabel = computed(() => (settings.indexProtocol === 'grpc' ? 'gRPC' : 'REST'))

async function ensureIndex() {
  checking.value = true
  error.value = null
  indexMessage.value = null
  try {
    const res = await window.api.indexEnsure(settings.indexProtocol, host.value, port.value)
    indexMessage.value = res.message
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : '连接索引服务失败'
  } finally {
    checking.value = false
  }
}

async function doSearch() {
  const q = query.value.trim()
  if (!q) return
  searching.value = true
  searched.value = true
  error.value = null
  try {
    const res = await window.api.indexSearch(settings.indexProtocol, host.value, port.value, q, 30)
    if (res.ok) {
      results.value = res.results
    } else {
      error.value = res.message
      results.value = []
    }
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : '搜索失败'
    results.value = []
  } finally {
    searching.value = false
  }
}

function kindOf(r: IndexSearchResult): 'local' | 's3' {
  return r.fields?.kind === 's3' ? 's3' : 'local'
}

function titleOf(r: IndexSearchResult): string {
  return r.fields?.title || r.fields?.path || r.fields?.doc_id || r.docId
}

function pathOf(r: IndexSearchResult): string {
  return r.fields?.path || r.fields?.doc_id || r.docId
}

function snippetOf(r: IndexSearchResult): string {
  const content = r.fields?.content || ''
  const q = query.value.trim()
  if (q && content) {
    const idx = content.toLowerCase().indexOf(q.toLowerCase())
    if (idx >= 0) {
      const start = Math.max(0, idx - 30)
      const end = Math.min(content.length, idx + q.length + 60)
      return (
        (start > 0 ? '…' : '') +
        content.slice(start, end).replace(/\s+/g, ' ') +
        (end < content.length ? '…' : '')
      )
    }
  }
  return content ? content.slice(0, 100).replace(/\s+/g, ' ') : '（无内容）'
}

async function openResult(r: IndexSearchResult) {
  const fields = r.fields || {}
  const kind = kindOf(r)
  try {
    if (kind === 's3' && fields.bucket && fields.key) {
      const content = await window.api.s3GetObject(s3.plainConfig(), fields.bucket, fields.key)
      if (content !== null) {
        editor.loadFile(content, fields.key, { bucket: fields.bucket, key: fields.key })
      } else {
        error.value = '无法读取 S3 对象（连接配置可能已变更）'
      }
    } else if (kind === 'local' && fields.path) {
      const content = await window.api.readFile(fields.path)
      if (content !== null) {
        editor.loadFile(content, fields.path, null)
      } else {
        error.value = '文件不存在或无法读取'
      }
    } else {
      error.value = '该结果缺少文件定位信息，无法打开'
    }
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : '打开文件失败'
  }
}

// 删除索引文档（右上角关闭按钮）
const deletingDocId = ref<string | null>(null)
const confirmTarget = ref<IndexSearchResult | null>(null)
const notice = ref<string | null>(null)
let noticeTimer: ReturnType<typeof setTimeout> | null = null

function confirmDelete(r: IndexSearchResult) {
  if (deletingDocId.value) return
  confirmTarget.value = r
}

async function doDelete() {
  const r = confirmTarget.value
  if (!r || deletingDocId.value) return
  confirmTarget.value = null
  deletingDocId.value = r.docId
  error.value = null
  try {
    const res = await window.api.indexDeleteDoc(
      settings.indexProtocol,
      host.value,
      port.value,
      r.docId,
      { ...r.fields } // 展开为普通对象，避免 Vue reactive Proxy 无法通过 IPC 克隆
    )
    if (res.ok) {
      results.value = results.value.filter((item) => item.docId !== r.docId)
      showNotice(`删除成功：已从索引中移除「${titleOf(r)}」`)
    } else {
      error.value = res.message
    }
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : '删除索引文档失败'
  } finally {
    deletingDocId.value = null
  }
}

function showNotice(msg: string) {
  notice.value = msg
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    notice.value = null
  }, 3000)
}

onMounted(() => {
  ensureIndex()
})
</script>

<template>
  <div class="search-panel">
    <div class="search-header">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="11" cy="11" r="7"/>
        <path d="m21 21-4.35-4.35"/>
      </svg>
      <span>全文检索</span>
    </div>

    <div class="search-bar">
      <input
        v-model="query"
        type="text"
        placeholder="搜索 Markdown 文档内容..."
        spellcheck="false"
        @keydown.enter="doSearch"
      />
      <button class="search-btn" :disabled="searching || !query.trim()" @click="doSearch">
        {{ searching ? '搜索中' : '搜索' }}
      </button>
    </div>

    <div class="search-status">
      <span class="status-dot" :class="checking ? 'checking' : indexMessage ? 'ok' : 'err'"></span>
      <span class="status-text">{{ protocolLabel }} {{ host }}:{{ port }}</span>
      <button class="check-btn" :disabled="checking" @click="ensureIndex">
        {{ checking ? '检查中' : '检查索引' }}
      </button>
    </div>

    <div v-if="indexMessage" class="index-msg">{{ indexMessage }}</div>
    <div v-if="notice" class="search-notice">{{ notice }}</div>
    <div v-if="error" class="search-error">{{ error }}</div>
    <div v-if="searching" class="search-loading">
      <span class="loading-spinner"></span>
      搜索中...
    </div>

    <div class="search-results">
      <template v-if="results.length > 0">
        <div v-for="(r, i) in results" :key="i" class="result-item" @click="openResult(r)">
          <button
            class="result-close"
            :class="{ deleting: deletingDocId === r.docId }"
            :disabled="deletingDocId !== null"
            :title="'删除该条索引文档'"
            @click.stop="confirmDelete(r)"
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M4 4l8 8M12 4l-8 8"/>
            </svg>
          </button>
          <div class="result-title">{{ titleOf(r) }}</div>
          <div class="result-snippet">{{ snippetOf(r) }}</div>
          <div class="result-meta">
            <span class="kind-tag" :class="kindOf(r)">{{ kindOf(r) === 's3' ? 'S3' : '本地' }}</span>
            <span class="result-path">{{ pathOf(r) }}</span>
            <span v-if="r.score" class="result-score">{{ r.score.toFixed(2) }}</span>
          </div>
        </div>
      </template>
      <div v-else-if="searched && !searching && !error" class="search-empty">没有匹配的文档</div>
      <div v-else-if="!searched" class="search-empty">输入关键词开始检索</div>
    </div>

    <!-- 删除确认弹窗 -->
    <div v-if="confirmTarget" class="del-modal-mask" @click.self="confirmTarget = null">
      <div class="del-modal">
        <div class="del-modal-title">删除索引条目</div>
        <div class="del-modal-body">
          确定要从索引中删除
          <strong class="del-modal-name">{{ titleOf(confirmTarget) }}</strong>
          吗？仅删除索引条目，不会删除原文件。该操作不可恢复。
        </div>
        <div class="del-modal-actions">
          <button class="del-btn cancel" @click="confirmTarget = null">取消</button>
          <button class="del-btn confirm" @click="doDelete">删除</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.search-panel {
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

.search-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-color);
  margin-bottom: 10px;
}

.search-bar {
  display: flex;
  gap: 6px;
}

.search-bar input {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
}

.search-bar input:focus {
  border-color: var(--accent-color);
}

.search-btn {
  flex-shrink: 0;
  padding: 6px 12px;
  border: 1px solid var(--accent-color);
  border-radius: 4px;
  background: var(--accent-color);
  color: #fff;
  cursor: pointer;
  font-size: 12px;
}

.search-btn:hover:not(:disabled) {
  background: var(--accent-hover);
}

.search-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.search-status {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-muted);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-dot.ok {
  background: #67c23a;
}

.status-dot.err {
  background: #e74c3c;
}

.status-dot.checking {
  background: #f0ad4e;
  animation: blink 0.8s ease-in-out infinite;
}

.status-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.check-btn {
  flex-shrink: 0;
  border: none;
  background: transparent;
  color: var(--accent-color);
  cursor: pointer;
  font-size: 12px;
  padding: 2px 4px;
  border-radius: 3px;
}

.check-btn:hover:not(:disabled) {
  background: var(--bg-tertiary);
}

.check-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.index-msg {
  margin-top: 8px;
  padding: 6px 10px;
  background: rgba(74, 144, 217, 0.12);
  color: var(--accent-color);
  border-radius: 4px;
  font-size: 12px;
}

.search-error {
  margin-top: 8px;
  padding: 6px 10px;
  background: rgba(220, 53, 69, 0.12);
  color: #dc3545;
  border-radius: 4px;
  font-size: 12px;
  word-break: break-all;
}

.search-notice {
  margin-top: 8px;
  padding: 6px 10px;
  background: rgba(103, 194, 58, 0.14);
  color: #67c23a;
  border-radius: 4px;
  font-size: 12px;
  word-break: break-all;
}

/* 删除确认弹窗 */
.del-modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
}

.del-modal {
  width: 320px;
  background: var(--bg-card, var(--bg-secondary));
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 16px 18px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
}

.del-modal-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 10px;
}

.del-modal-body {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.6;
  word-break: break-all;
}

.del-modal-name {
  color: var(--text-primary);
  font-weight: 600;
}

.del-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

.del-btn {
  padding: 5px 14px;
  font-size: 12px;
  border-radius: 4px;
  border: 1px solid var(--border-color);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;
}

.del-btn:hover {
  border-color: var(--accent-color);
  color: var(--accent-color);
}

.del-btn.confirm {
  background: #dc3545;
  border-color: #dc3545;
  color: #fff;
}

.del-btn.confirm:hover {
  background: #c82333;
  border-color: #c82333;
  color: #fff;
}

.search-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 20px 0;
  color: var(--text-muted);
  font-size: 12px;
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

.search-results {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.result-item {
  position: relative;
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s;
}

.result-item:hover {
  background: var(--bg-tertiary);
  border-color: var(--accent-color);
}

/* 右上角关闭按钮（删除索引文档） */
.result-close {
  position: absolute;
  top: 4px;
  right: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0;
}

.result-close:hover:not(:disabled) {
  background: rgba(220, 53, 69, 0.15);
  color: #dc3545;
}

.result-close.deleting {
  color: #dc3545;
}

.result-close:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.result-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-right: 18px;
}

.result-snippet {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
  margin-top: 2px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-all;
}

.result-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-muted);
}

.kind-tag {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 3px;
  color: #fff;
  font-size: 10px;
  line-height: 1.4;
}

.kind-tag.local {
  background: #409eff;
}

.kind-tag.s3 {
  background: #e6a23c;
}

.result-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.result-score {
  flex-shrink: 0;
  color: var(--text-muted);
}

.search-empty {
  padding: 24px 12px;
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
}
</style>
