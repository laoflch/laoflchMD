<script setup lang="ts">
import { computed, ref } from 'vue'
import type { IndexSearchResult } from '../types'
import { useSettingsStore } from '../stores/settings'
import { useToastStore } from '../stores/toast'

const props = defineProps<{
  open: boolean
  doc: IndexSearchResult | null
}>()

const emit = defineEmits<{ close: []; deleted: [] }>()

const settings = useSettingsStore()
const toastStore = useToastStore()

// 删除确认弹窗状态
const confirmOpen = ref(false)
const deleting = ref(false)

// 用于删除确认提示的标题
const docTitle = computed(() => {
  const doc = props.doc
  if (!doc) return ''
  return doc.fields?.title || doc.fields?.path || doc.fields?.doc_id || String(doc.docId ?? '')
})

// 索引详情字段（排除文本内容 content）
const rows = computed(() => {
  if (!props.doc) return []
  const f = props.doc.fields || {}
  const items: { label: string; value: string }[] = []
  if (props.doc.docId !== undefined && props.doc.docId !== null && props.doc.docId !== '') {
    items.push({ label: '文档 ID', value: String(props.doc.docId) })
  }
  if (f.doc_id) items.push({ label: '索引 ID', value: f.doc_id })
  if (f.title) items.push({ label: '标题', value: f.title })
  if (f.path) items.push({ label: '路径', value: f.path })
  if (f.kind) items.push({ label: '类型', value: f.kind === 's3' ? 'S3 对象' : '本地文件' })
  if (f.host) items.push({ label: '主机', value: f.host })
  if (f.server) items.push({ label: '服务器', value: f.server })
  if (f.bucket) items.push({ label: '桶', value: f.bucket })
  if (f.key) items.push({ label: '对象键', value: f.key })
  if (f.updated_at) items.push({ label: '更新时间', value: f.updated_at })
  if (f.blake3) items.push({ label: 'BLAKE3 摘要', value: f.blake3 })
  return items
})

function onMaskClick(e: MouseEvent) {
  if (e.target === e.currentTarget) emit('close')
}

// 请求删除：先弹出二次确认
function requestDelete() {
  if (deleting.value) return
  confirmOpen.value = true
}

// 确认删除：调用 IPC 删除对应索引项，成功后通知父组件刷新「全文」标签
async function doDelete() {
  const doc = props.doc
  if (!doc || deleting.value) return
  const id = String(doc.docId ?? '')
  if (!id) {
    toastStore.pushToast('err', '无效的文档 ID，无法删除')
    confirmOpen.value = false
    return
  }
  confirmOpen.value = false
  deleting.value = true
  try {
    const protocol = settings.indexProtocol
    const host = protocol === 'grpc' ? settings.grpcHost : settings.restHost
    const port = protocol === 'grpc' ? settings.grpcPort : settings.restPort
    const res = await window.api.indexDeleteDoc(
      protocol,
      host,
      port,
      settings.indexName,
      id,
      { ...doc.fields },
      {
        protocol: settings.raftProtocol,
        host: settings.raftHost,
        port: settings.raftProtocol === 'grpc' ? settings.raftGrpcPort : settings.raftRestPort,
        group: settings.raftGroup
      }
    )
    if (res.ok) {
      toastStore.pushToast('ok', '删除成功：已从索引中移除该索引项')
      emit('deleted')
      emit('close')
    } else {
      toastStore.pushToast('err', res.message || '删除索引项失败')
    }
  } catch (e: unknown) {
    toastStore.pushToast('err', e instanceof Error ? e.message : '删除索引项失败')
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <!-- 与全局弹窗一致：直接渲染在组件树内（Teleport 到 body 会脱离 .dark-theme 容器，导致暗色变量继承失效） -->
  <div v-if="open" class="dialog-mask" @click="onMaskClick">
    <div class="dialog" @click.stop>
      <div class="dialog-header">
        <div class="dialog-title">索引详细信息</div>
        <button class="dialog-close" title="关闭" @click="emit('close')">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M4 4l8 8M12 4l-8 8"/>
          </svg>
        </button>
      </div>
      <div class="dialog-body">
        <div v-if="rows.length === 0" class="info-empty">没有可显示的索引字段</div>
        <div v-else class="info-row" v-for="row in rows" :key="row.label">
          <div class="info-label">{{ row.label }}</div>
          <div class="info-value" :title="row.value">{{ row.value }}</div>
        </div>
      </div>
      <div class="dialog-actions">
        <button class="settings-btn danger" :disabled="deleting" @click="requestDelete">删除索引项</button>
        <button class="settings-btn primary" @click="emit('close')">关闭</button>
      </div>
    </div>

    <!-- 删除确认弹窗 -->
    <div v-if="confirmOpen" class="del-modal-mask" @click.self="confirmOpen = false">
      <div class="del-modal">
        <div class="del-modal-title">删除索引条目</div>
        <div class="del-modal-body">
          确定要从索引中删除
          <strong class="del-modal-name">{{ docTitle }}</strong>
          吗？仅删除索引条目，不会删除原文件。该操作不可恢复。
        </div>
        <div class="del-modal-actions">
          <button class="del-btn cancel" @click="confirmOpen = false">取消</button>
          <button class="del-btn confirm" @click="doDelete">删除</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dialog-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 300;
}

.dialog {
  width: 520px;
  max-width: 90vw;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  box-shadow: var(--shadow-sm);
  overflow: hidden;
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
}

.dialog-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.dialog-close {
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 14px;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 4px;
}

.dialog-close:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.dialog-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 20px;
}

.info-row {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border-color);
}

.info-row:last-child {
  border-bottom: none;
}

.info-label {
  width: 96px;
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-muted);
  text-align: right;
}

.info-value {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text-primary);
  word-break: break-all;
}

.info-empty {
  padding: 20px 0;
  text-align: center;
  font-size: 12px;
  color: var(--text-muted);
}

.dialog-actions {
  padding: 12px 20px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  border-top: 1px solid var(--border-color);
}

.settings-btn {
  padding: 6px 16px;
  border: 1px solid var(--border-color);
  border-radius: 5px;
  background: var(--bg-primary);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 13px;
}

.settings-btn.primary {
  background: var(--accent-color);
  border-color: var(--accent-color);
  color: #fff;
}

.settings-btn.primary:hover {
  background: var(--accent-hover);
}

.settings-btn.danger {
  background: #dc3545;
  border-color: #dc3545;
  color: #fff;
}

.settings-btn.danger:hover {
  background: #c82333;
  border-color: #c82333;
}

.settings-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* 删除确认弹窗 */
.del-modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 400;
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
</style>
