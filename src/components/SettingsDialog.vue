<script setup lang="ts">
import { ref, watch } from 'vue'
import { useSettingsStore, type IndexProtocol } from '../stores/settings'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

const settings = useSettingsStore()

// 本地草稿，取消时丢弃，保存时才写入 store
const draftProtocol = ref<IndexProtocol>('rest')
const draftGrpcHost = ref('')
const draftGrpcPort = ref('')
const draftRestHost = ref('')
const draftRestPort = ref('')
const errorMsg = ref('')

// 打开时载入当前设置
watch(
  () => props.open,
  (open) => {
    if (open) {
      draftProtocol.value = settings.indexProtocol
      draftGrpcHost.value = settings.grpcHost
      draftGrpcPort.value = settings.grpcPort
      draftRestHost.value = settings.restHost
      draftRestPort.value = settings.restPort
      errorMsg.value = ''
    }
  }
)

function isPortValid(port: string): boolean {
  const n = Number(port)
  return Number.isInteger(n) && n >= 1 && n <= 65535
}

function save() {
  if (!draftGrpcHost.value.trim()) {
    errorMsg.value = 'gRPC 服务地址不能为空'
    return
  }
  if (!draftRestHost.value.trim()) {
    errorMsg.value = 'REST 服务地址不能为空'
    return
  }
  if (!isPortValid(draftGrpcPort.value.trim())) {
    errorMsg.value = 'gRPC 端口无效（1-65535）'
    return
  }
  if (!isPortValid(draftRestPort.value.trim())) {
    errorMsg.value = 'REST 端口无效（1-65535）'
    return
  }

  settings.indexProtocol = draftProtocol.value
  settings.grpcHost = draftGrpcHost.value.trim()
  settings.grpcPort = draftGrpcPort.value.trim()
  settings.restHost = draftRestHost.value.trim()
  settings.restPort = draftRestPort.value.trim()
  emit('close')
}

function cancel() {
  emit('close')
}
</script>

<template>
  <div v-if="open" class="settings-mask" @click.self="cancel">
    <div class="settings-dialog">
      <div class="settings-header">
        <div class="settings-title">全局设置</div>
        <button class="settings-close" title="关闭" @click="cancel">✕</button>
      </div>

      <div class="settings-body">
        <div class="settings-section-title">全文检索服务（laoflchdb-rust）</div>

        <div class="settings-field">
          <div class="field-label">连接协议</div>
          <div class="radio-group">
            <label class="radio-option" :class="{ active: draftProtocol === 'grpc' }">
              <input v-model="draftProtocol" type="radio" value="grpc" />
              <span>gRPC</span>
            </label>
            <label class="radio-option" :class="{ active: draftProtocol === 'rest' }">
              <input v-model="draftProtocol" type="radio" value="rest" />
              <span>REST</span>
            </label>
          </div>
          <p class="field-hint">选择索引服务使用的访问协议，当前选择：
            <span class="hint-current">{{ draftProtocol === 'grpc' ? 'gRPC' : 'REST' }}</span>
          </p>
        </div>

        <div class="settings-field" :class="{ dimmed: draftProtocol !== 'grpc' }">
          <div class="field-label">gRPC 服务地址</div>
          <div class="input-row">
            <input
              v-model="draftGrpcHost"
              class="settings-input host"
              placeholder="127.0.0.1"
            />
            <span class="port-colon">:</span>
            <input
              v-model="draftGrpcPort"
              class="settings-input port"
              placeholder="19777"
              inputmode="numeric"
            />
          </div>
        </div>

        <div class="settings-field" :class="{ dimmed: draftProtocol !== 'rest' }">
          <div class="field-label">REST 服务地址</div>
          <div class="input-row">
            <input
              v-model="draftRestHost"
              class="settings-input host"
              placeholder="127.0.0.1"
            />
            <span class="port-colon">:</span>
            <input
              v-model="draftRestPort"
              class="settings-input port"
              placeholder="8080"
              inputmode="numeric"
            />
          </div>
        </div>

        <p v-if="errorMsg" class="settings-error">{{ errorMsg }}</p>
      </div>

      <div class="settings-actions">
        <button class="settings-btn" @click="cancel">取消</button>
        <button class="settings-btn primary" @click="save">保存</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 300;
}

.settings-dialog {
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

.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
}

.settings-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.settings-close {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 14px;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 4px;
}

.settings-close:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.settings-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
}

.settings-section-title {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-muted);
  margin-bottom: 14px;
}

.settings-field {
  margin-bottom: 16px;
}

.settings-field.dimmed {
  opacity: 0.5;
}

.field-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 6px;
}

.field-hint {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 6px;
}

.hint-current {
  color: var(--accent-color);
  font-weight: 600;
}

.radio-group {
  display: flex;
  gap: 16px;
}

.radio-option {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
}

.radio-option input {
  accent-color: var(--accent-color);
}

.radio-option.active {
  color: var(--text-primary);
  font-weight: 500;
}

.input-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.settings-input {
  padding: 6px 10px;
  border: 1px solid var(--border-color);
  border-radius: 5px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
}

.settings-input:focus {
  border-color: var(--accent-color);
}

.settings-input.host {
  flex: 1;
}

.settings-input.port {
  width: 90px;
}

.port-colon {
  color: var(--text-muted);
}

.settings-error {
  font-size: 12px;
  color: #e74c3c;
  margin-top: 4px;
}

.settings-actions {
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

.settings-btn:hover {
  background: var(--bg-tertiary);
}

.settings-btn.primary {
  background: var(--accent-color);
  border-color: var(--accent-color);
  color: #fff;
}

.settings-btn.primary:hover {
  background: var(--accent-hover);
}
</style>
