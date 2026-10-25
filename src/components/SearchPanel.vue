<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useSettingsStore } from '../stores/settings'
import { useEditorStore } from '../stores/editor'
import { useS3Store } from '../stores/s3'
import { useToastStore } from '../stores/toast'
import type { IndexSearchResult, VectorSearchResult, VectorIndexStats, RaftConfig } from '../types'

const settings = useSettingsStore()
const editor = useEditorStore()
const s3 = useS3Store()
const toastStore = useToastStore()

const query = ref('')
// 当前激活的索引类型 tab
const activeIndexTab = ref<'fulltext' | 'vector'>('fulltext')
// 搜索范围：两个都检索 / 只检索全文 / 只检索向量
const searchMode = ref<'all' | 'fulltext' | 'vector'>('all')

// 全文索引状态
const fulltextResults = ref<IndexSearchResult[]>([])
const fulltextSearching = ref(false)
const fulltextSearched = ref(false)
const fulltextError = ref<string | null>(null)
const checking = ref(false)
const indexMessage = ref<string | null>(null)

// 向量索引状态
const vectorResults = ref<VectorSearchResult[]>([])
const vectorSearching = ref(false)
const vectorSearched = ref(false)
const vectorError = ref<string | null>(null)
const vectorChecking = ref(false)
const vectorInfo = ref<VectorIndexStats | null>(null)
const vectorInfoMessage = ref<string | null>(null)

const searching = computed(() => fulltextSearching.value || vectorSearching.value)

const host = computed(() =>
  settings.indexProtocol === 'grpc' ? settings.grpcHost : settings.restHost
)
const port = computed(() =>
  settings.indexProtocol === 'grpc' ? settings.grpcPort : settings.restPort
)
const protocolLabel = computed(() => (settings.indexProtocol === 'grpc' ? 'gRPC' : 'REST'))

// Raft KV 连接参数：索引状态的唯一真源（向量搜索按 chunk 向量 ID 反查文件）
const raftCfg = computed<RaftConfig>(() => ({
  protocol: settings.raftProtocol,
  host: settings.raftHost,
  port: settings.raftProtocol === 'grpc' ? settings.raftGrpcPort : settings.raftRestPort,
  group: settings.raftGroup
}))

// 全文索引功能是否关闭（索引服务总开关 / 全文索引子开关）
const fulltextOff = computed(() => !settings.indexEnabled || !settings.fulltextEnabled)
// 向量索引功能是否关闭（索引服务总开关 / 向量文本索引子开关）
const vectorOff = computed(() => !settings.indexEnabled || !settings.vectorTextEnabled)
const bothOff = computed(() => fulltextOff.value && vectorOff.value)
const disabledHint = computed(() =>
  settings.indexEnabled
    ? '全文索引与向量索引服务均已关闭，请在全局设置中启用'
    : '索引服务已关闭，请在全局设置中启用'
)

// 实际生效的搜索范围（被关闭的索引自动排除）
const effectiveMode = computed<'all' | 'fulltext' | 'vector'>(() => {
  if (searchMode.value === 'all') {
    if (fulltextOff.value && !vectorOff.value) return 'vector'
    if (vectorOff.value && !fulltextOff.value) return 'fulltext'
    return 'all'
  }
  if (searchMode.value === 'fulltext' && fulltextOff.value) return 'vector'
  if (searchMode.value === 'vector' && vectorOff.value) return 'fulltext'
  return searchMode.value
})

async function ensureIndex() {
  checking.value = true
  fulltextError.value = null
  indexMessage.value = null
  try {
    const res = await window.api.indexEnsure(
      settings.indexProtocol,
      host.value,
      port.value,
      settings.indexName,
      settings.indexRebuildOnSchemaChange
    )
    if (res.ok) {
      // 索引 md_docs 已存在等消息移到右上角，绿色提示，8 秒后移除
      indexMessage.value = res.message
      toastStore.pushToast('ok', res.message, true, 8000)
    } else {
      fulltextError.value = res.message
    }
  } catch (e: unknown) {
    fulltextError.value = e instanceof Error ? e.message : '连接索引服务失败'
  } finally {
    checking.value = false
  }
}

async function checkVectorIndex() {
  vectorChecking.value = true
  vectorError.value = null
  vectorInfoMessage.value = null
  try {
    const res = await window.api.vectorGetInfo(settings.grpcHost, settings.grpcPort, settings.vectorIndexName)
    if (res.ok) {
      vectorInfo.value = res.stats
      if (res.stats) {
        vectorInfoMessage.value = `索引 ${res.stats.name} 已就绪：${res.stats.numElements} 条向量，维度 ${res.stats.dim}`
      } else {
        vectorInfoMessage.value = '索引检查通过'
      }
      toastStore.pushToast('ok', vectorInfoMessage.value, true, 8000)
    } else {
      vectorInfo.value = null
      vectorError.value = res.message
    }
  } catch (e: unknown) {
    vectorInfo.value = null
    vectorError.value = e instanceof Error ? e.message : '连接向量服务失败'
  } finally {
    vectorChecking.value = false
  }
}

async function searchFulltext(q: string) {
  fulltextSearching.value = true
  fulltextSearched.value = true
  fulltextError.value = null
  try {
    const res = await window.api.indexSearch(settings.indexProtocol, host.value, port.value, settings.indexName, q, 30)
    if (res.ok) {
      fulltextResults.value = res.results
    } else {
      fulltextError.value = res.message
      fulltextResults.value = []
    }
  } catch (e: unknown) {
    fulltextError.value = e instanceof Error ? e.message : '全文搜索失败'
    fulltextResults.value = []
  } finally {
    fulltextSearching.value = false
  }
}

async function searchVector(q: string) {
  vectorSearching.value = true
  vectorSearched.value = true
  vectorError.value = null
  try {
    const res = await window.api.vectorSearch(
      raftCfg.value,
      settings.grpcHost,
      settings.grpcPort,
      settings.vectorIndexName,
      settings.vectorModelName,
      q,
      settings.vectorSearchTopK
    )
    if (res.ok) {
      // 距离上限筛选（0 表示不筛选），再按距离从小到大排序（距离越小越相关）
      const maxDistance = settings.vectorSearchMaxDistance
      const kept = maxDistance > 0 ? res.results.filter((r) => r.distance < maxDistance) : res.results
      vectorResults.value = [...kept].sort((a, b) => a.distance - b.distance)
    } else {
      vectorError.value = res.message
      vectorResults.value = []
    }
  } catch (e: unknown) {
    vectorError.value = e instanceof Error ? e.message : '向量搜索失败'
    vectorResults.value = []
  } finally {
    vectorSearching.value = false
  }
}

async function doSearch() {
  const q = query.value.trim()
  if (!q) return
  const mode = effectiveMode.value
  const tasks: Promise<void>[] = []
  if (mode === 'fulltext' || mode === 'all') tasks.push(searchFulltext(q))
  if (mode === 'vector' || mode === 'all') tasks.push(searchVector(q))
  await Promise.all(tasks)
}

function kindOf(r: IndexSearchResult | VectorSearchResult): 'local' | 's3' {
  return r.fields?.kind === 's3' ? 's3' : 'local'
}

function titleOf(r: IndexSearchResult | VectorSearchResult): string {
  return r.fields?.title || r.fields?.path || r.fields?.doc_id || r.docId
}

function pathOf(r: IndexSearchResult | VectorSearchResult): string {
  return r.fields?.path || r.fields?.doc_id || r.docId
}

function snippetOf(r: IndexSearchResult | VectorSearchResult): string {
  const content = r.fields?.content || r.fields?.snippet || ''
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

async function openResult(r: IndexSearchResult | VectorSearchResult) {
  const fields = r.fields || {}
  const kind = kindOf(r)
  try {
    if (kind === 's3' && fields.bucket && fields.key) {
      const content = await window.api.s3GetObject(s3.plainConfig(), fields.bucket, fields.key)
      if (content !== null) {
        editor.loadFile(content, fields.key, { bucket: fields.bucket, key: fields.key })
      } else {
        (activeIndexTab.value === 'vector' ? vectorError : fulltextError).value = '无法读取 S3 对象（连接配置可能已变更）'
      }
    } else if (kind === 'local' && fields.path) {
      const content = await window.api.readFile(fields.path)
      if (content !== null) {
        editor.loadFile(content, fields.path, null)
      } else {
        (activeIndexTab.value === 'vector' ? vectorError : fulltextError).value = '文件不存在或无法读取'
      }
    } else {
      (activeIndexTab.value === 'vector' ? vectorError : fulltextError).value = '该结果缺少文件定位信息，无法打开'
    }
  } catch (e: unknown) {
    (activeIndexTab.value === 'vector' ? vectorError : fulltextError).value =
      e instanceof Error ? e.message : '打开文件失败'
  }
}

// 删除索引条目（右上角关闭按钮）
const deletingId = ref<string | null>(null)
const confirmTarget = ref<{ tab: 'fulltext' | 'vector'; item: IndexSearchResult | VectorSearchResult } | null>(null)
const notice = ref<string | null>(null)
let noticeTimer: ReturnType<typeof setTimeout> | null = null

function confirmDelete(tab: 'fulltext' | 'vector', item: IndexSearchResult | VectorSearchResult) {
  if (deletingId.value) return
  confirmTarget.value = { tab, item }
}

async function doDelete() {
  const target = confirmTarget.value
  if (!target || deletingId.value) return
  confirmTarget.value = null
  deletingId.value = target.item.docId
  if (target.tab === 'vector') vectorError.value = null
  else fulltextError.value = null
  try {
    const res =
      target.tab === 'vector'
        ? await window.api.vectorDeleteId(raftCfg.value, settings.grpcHost, settings.grpcPort, settings.vectorIndexName, target.item.docId)
        : await window.api.indexDeleteDoc(
            settings.indexProtocol,
            host.value,
            port.value,
            settings.indexName,
            target.item.docId,
            { ...target.item.fields }, // 展开为普通对象，避免 Vue reactive Proxy 无法通过 IPC 克隆
            raftCfg.value
          )
    if (res.ok) {
      if (target.tab === 'vector') {
        vectorResults.value = vectorResults.value.filter((item) => item.docId !== target.item.docId)
      } else {
        fulltextResults.value = fulltextResults.value.filter((item) => item.docId !== target.item.docId)
      }
      showNotice(`删除成功：已从索引中移除「${titleOf(target.item)}」`)
    } else {
      if (target.tab === 'vector') vectorError.value = res.message
      else fulltextError.value = res.message
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '删除索引条目失败'
    if (target.tab === 'vector') vectorError.value = msg
    else fulltextError.value = msg
  } finally {
    deletingId.value = null
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
  if (!fulltextOff.value) ensureIndex()
  if (!vectorOff.value) checkVectorIndex()
})

// 全文索引开关变化时同步刷新：关闭清空面板，重新打开时重新检查索引
watch(fulltextOff, (off) => {
  if (off) {
    fulltextResults.value = []
    fulltextError.value = null
    fulltextSearched.value = false
    if (activeIndexTab.value === 'fulltext') activeIndexTab.value = 'vector'
  } else {
    ensureIndex()
  }
})

// 向量索引开关变化时同步刷新
watch(vectorOff, (off) => {
  if (off) {
    vectorResults.value = []
    vectorError.value = null
    vectorSearched.value = false
    vectorInfo.value = null
    if (activeIndexTab.value === 'vector') activeIndexTab.value = 'fulltext'
  } else {
    checkVectorIndex()
  }
})
</script>

<template>
  <div class="search-panel">
    <div class="search-bar">
      <select v-model="searchMode" class="mode-select" :disabled="bothOff" :title="'选择检索范围'">
        <option value="all" :disabled="fulltextOff || vectorOff">全文+向量</option>
        <option value="fulltext" :disabled="fulltextOff">全文</option>
        <option value="vector" :disabled="vectorOff">向量</option>
      </select>
      <input
        v-model="query"
        type="text"
        placeholder="搜索 Markdown 文档内容..."
        spellcheck="false"
        :disabled="bothOff"
        @keydown.enter="doSearch"
      />
      <button class="search-btn" :disabled="searching || !query.trim() || bothOff" @click="doSearch">
        {{ searching ? '搜索中' : '搜索' }}
      </button>
    </div>

    <!-- 索引类型 tab 条：全文索引与向量索引并列 -->
    <div v-if="!bothOff" class="index-tabs">
      <div
        v-if="!fulltextOff"
        class="index-tab"
        :class="{ active: activeIndexTab === 'fulltext' }"
        @click="activeIndexTab = 'fulltext'"
      >全文索引</div>
      <div
        v-if="!vectorOff"
        class="index-tab"
        :class="{ active: activeIndexTab === 'vector' }"
        @click="activeIndexTab = 'vector'"
      >向量索引</div>
    </div>

    <div class="index-tab-pane">
      <div v-if="bothOff" class="search-disabled">{{ disabledHint }}</div>

      <!-- 全文索引 tab -->
      <template v-else-if="activeIndexTab === 'fulltext' && !fulltextOff">
        <div class="search-status">
          <span class="status-dot" :class="checking ? 'checking' : indexMessage ? 'ok' : 'err'"></span>
          <span class="status-text">{{ protocolLabel }} {{ host }}:{{ port }}</span>
          <button class="check-btn" :disabled="checking" @click="ensureIndex">
            {{ checking ? '检查中' : '检查索引' }}
          </button>
        </div>

        <div v-if="notice" class="search-notice">{{ notice }}</div>
        <div v-if="fulltextError" class="search-error">{{ fulltextError }}</div>
        <div v-if="fulltextSearching" class="search-loading">
          <span class="loading-spinner"></span>
          搜索中...
        </div>

        <div class="search-results">
          <template v-if="fulltextResults.length > 0">
            <div v-for="(r, i) in fulltextResults" :key="i" class="result-item" @click="openResult(r)">
              <button
                class="result-close"
                :class="{ deleting: deletingId === r.docId }"
                :disabled="deletingId !== null"
                :title="'删除该条索引文档'"
                @click.stop="confirmDelete('fulltext', r)"
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
          <div v-else-if="fulltextSearched && !fulltextSearching && !fulltextError" class="search-empty">没有匹配的文档</div>
          <div v-else class="search-empty">输入关键词开始检索</div>
        </div>
      </template>

      <!-- 向量索引 tab -->
      <template v-else-if="activeIndexTab === 'vector' && !vectorOff">
        <div class="search-status">
          <span class="status-dot" :class="vectorChecking ? 'checking' : vectorInfo ? 'ok' : 'err'"></span>
          <span class="status-text">gRPC {{ settings.grpcHost }}:{{ settings.grpcPort }}</span>
          <span v-if="vectorInfo" class="vector-stats">{{ vectorInfo.numElements }} 条</span>
          <button class="check-btn" :disabled="vectorChecking" @click="checkVectorIndex">
            {{ vectorChecking ? '检查中' : '检查索引' }}
          </button>
        </div>

        <div v-if="notice" class="search-notice">{{ notice }}</div>
        <div v-if="vectorError" class="search-error">{{ vectorError }}</div>
        <div v-if="vectorSearching" class="search-loading">
          <span class="loading-spinner"></span>
          搜索中...
        </div>

        <div class="search-results">
          <template v-if="vectorResults.length > 0">
            <div v-for="(r, i) in vectorResults" :key="i" class="result-item" @click="openResult(r)">
              <span v-if="r.distance != null" class="result-distance" :title="'距离：' + r.distance.toFixed(4)">
                {{ r.distance.toFixed(3) }}
              </span>
              <button
                class="result-close"
                :class="{ deleting: deletingId === r.docId }"
                :disabled="deletingId !== null"
                :title="'删除该条索引文档'"
                @click.stop="confirmDelete('vector', r)"
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
                <span v-if="r.fields?.chunk_index" class="result-chunk">{{ Number(r.fields.chunk_index) + 1 }}/{{ r.fields.total_chunks || '?' }} 块</span>
              </div>
            </div>
          </template>
          <div v-else-if="vectorSearched && !vectorSearching && !vectorError" class="search-empty">没有匹配的文档</div>
          <div v-else class="search-empty">输入关键词开始检索</div>
        </div>
      </template>
    </div>

    <!-- 删除确认弹窗 -->
    <div v-if="confirmTarget" class="del-modal-mask" @click.self="confirmTarget = null">
      <div class="del-modal">
        <div class="del-modal-title">删除索引条目</div>
        <div class="del-modal-body">
          确定要从{{ confirmTarget.tab === 'vector' ? '向量' : '全文' }}索引中删除
          <strong class="del-modal-name">{{ titleOf(confirmTarget.item) }}</strong>
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

.search-bar {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
}

/* 搜索范围下拉 */
.mode-select {
  flex-shrink: 0;
  padding: 5px 4px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 12px;
  outline: none;
  max-width: 92px;
  cursor: pointer;
}

.mode-select:focus {
  border-color: var(--accent-color);
}

.mode-select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 索引类型 tab 条 */
.index-tabs {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--border-color);
  margin-bottom: 10px;
}

.index-tab {
  padding: 6px 14px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  user-select: none;
  transition: color 0.15s;
}

.index-tab:hover {
  color: var(--text-primary);
}

.index-tab.active {
  color: var(--accent-color);
  border-bottom-color: var(--accent-color);
  font-weight: 600;
}

.index-tab-pane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
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

.vector-stats {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 3px;
  background: rgba(64, 158, 255, 0.12);
  color: #409eff;
  font-size: 11px;
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

.search-error {
  margin-top: 8px;
  padding: 6px 10px;
  background: rgba(220, 53, 69, 0.12);
  color: #dc3545;
  border-radius: 4px;
  font-size: 12px;
  word-break: break-all;
}

.search-disabled {
  margin-top: 12px;
  padding: 10px 12px;
  background: rgba(220, 53, 69, 0.1);
  color: var(--text-secondary);
  border: 1px dashed var(--border-color);
  border-radius: 6px;
  font-size: 12px;
  text-align: center;
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

/* 右上角关闭按钮左侧的向量距离标签（距离越小越相关） */
.result-distance {
  position: absolute;
  top: 6px;
  right: 26px;
  font-size: 11px;
  line-height: 1;
  color: var(--accent-color);
  background: rgba(86, 156, 214, 0.12);
  border-radius: 3px;
  padding: 2px 5px;
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

.result-chunk {
  flex-shrink: 0;
  color: var(--text-muted);
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
