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
const draftIndexName = ref('')
const draftIndexEnabled = ref(true)
const draftFulltextEnabled = ref(true)
const draftVectorTextEnabled = ref(true)
const draftVectorIndexName = ref('')
const draftVectorModelName = ref('')
const draftVectorChunkSize = ref(800)
const draftVectorChunkOverlap = ref(100)
const draftSearchTopK = ref(30)
const draftSearchMaxDistance = ref(0.4)
const draftRaftHost = ref('')
const draftRaftProtocol = ref<IndexProtocol>('grpc')
const draftRaftGrpcPort = ref('')
const draftRaftRestPort = ref('')
const draftRaftGroup = ref('')
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
      draftIndexName.value = settings.indexName
      draftIndexEnabled.value = settings.indexEnabled
      draftFulltextEnabled.value = settings.fulltextEnabled
      draftVectorTextEnabled.value = settings.vectorTextEnabled
      draftVectorIndexName.value = settings.vectorIndexName
      draftVectorModelName.value = settings.vectorModelName
      draftVectorChunkSize.value = settings.vectorChunkSize
      draftVectorChunkOverlap.value = settings.vectorChunkOverlap
      draftSearchTopK.value = settings.vectorSearchTopK
      draftSearchMaxDistance.value = settings.vectorSearchMaxDistance
      draftRaftHost.value = settings.raftHost
      draftRaftProtocol.value = settings.raftProtocol
      draftRaftGrpcPort.value = settings.raftGrpcPort
      draftRaftRestPort.value = settings.raftRestPort
      draftRaftGroup.value = settings.raftGroup
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
  if (!draftIndexName.value.trim()) {
    errorMsg.value = '索引名不能为空'
    return
  }
  if (draftVectorTextEnabled.value && !draftVectorIndexName.value.trim()) {
    errorMsg.value = '向量索引名不能为空'
    return
  }
  if (draftVectorTextEnabled.value && !draftVectorModelName.value.trim()) {
    errorMsg.value = '向量模型名不能为空'
    return
  }
  if (!Number.isInteger(draftVectorChunkSize.value) || draftVectorChunkSize.value < 100 || draftVectorChunkSize.value > 10000) {
    errorMsg.value = '分块长度需为 100-10000 的整数'
    return
  }
  if (
    !Number.isInteger(draftVectorChunkOverlap.value) ||
    draftVectorChunkOverlap.value < 0 ||
    draftVectorChunkOverlap.value >= draftVectorChunkSize.value
  ) {
    errorMsg.value = '重叠长度需为 0 到分块长度之间的整数'
    return
  }
  if (!Number.isInteger(draftSearchTopK.value) || draftSearchTopK.value < 1 || draftSearchTopK.value > 1000) {
    errorMsg.value = '向量检索 TopK 需为 1-1000 的整数'
    return
  }
  if (!Number.isFinite(draftSearchMaxDistance.value) || draftSearchMaxDistance.value < 0) {
    errorMsg.value = '向量检索距离上限需为不小于 0 的数值（0 表示不筛选）'
    return
  }
  if (draftIndexEnabled.value) {
    if (!draftRaftHost.value.trim()) {
      errorMsg.value = 'Raft 服务地址不能为空'
      return
    }
    const raftPort = draftRaftProtocol.value === 'grpc' ? draftRaftGrpcPort : draftRaftRestPort
    if (!isPortValid(raftPort.value.trim())) {
      errorMsg.value = `Raft ${draftRaftProtocol.value === 'grpc' ? 'gRPC' : 'REST'} 端口无效（1-65535）`
      return
    }
    if (!draftRaftGroup.value.trim()) {
      errorMsg.value = 'Raft 组名不能为空'
      return
    }
  }

  settings.indexProtocol = draftProtocol.value
  settings.grpcHost = draftGrpcHost.value.trim()
  settings.grpcPort = draftGrpcPort.value.trim()
  settings.restHost = draftRestHost.value.trim()
  settings.restPort = draftRestPort.value.trim()
  settings.indexName = draftIndexName.value.trim()
  settings.indexEnabled = draftIndexEnabled.value
  settings.fulltextEnabled = draftFulltextEnabled.value
  settings.vectorTextEnabled = draftVectorTextEnabled.value
  settings.vectorIndexName = draftVectorIndexName.value.trim()
  settings.vectorModelName = draftVectorModelName.value.trim()
  settings.vectorChunkSize = draftVectorChunkSize.value
  settings.vectorChunkOverlap = draftVectorChunkOverlap.value
  settings.vectorSearchTopK = draftSearchTopK.value
  settings.vectorSearchMaxDistance = draftSearchMaxDistance.value
  settings.raftHost = draftRaftHost.value.trim()
  settings.raftProtocol = draftRaftProtocol.value
  settings.raftGrpcPort = draftRaftGrpcPort.value.trim()
  settings.raftRestPort = draftRaftRestPort.value.trim()
  settings.raftGroup = draftRaftGroup.value.trim()
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
        <div class="settings-section-title">索引配置</div>

        <div class="settings-field">
          <div class="field-row">
            <div class="field-label">启动索引服务</div>
            <label class="switch" :class="{ on: draftIndexEnabled }">
              <input v-model="draftIndexEnabled" type="checkbox" />
              <span class="switch-slider"></span>
            </label>
          </div>
          <p class="field-hint">索引服务总开关，关闭后所有索引功能不可用</p>
        </div>

        <div class="settings-field" :class="{ dimmed: !draftIndexEnabled }">
          <div class="field-row">
            <div class="field-label">启动全文索引服务</div>
            <label class="switch" :class="{ on: draftFulltextEnabled }">
              <input v-model="draftFulltextEnabled" type="checkbox" :disabled="!draftIndexEnabled" />
              <span class="switch-slider"></span>
            </label>
          </div>
          <p class="field-hint">关闭后全文索引（检索 / 生成索引 / 全文标签）功能关闭，为后续其它类型索引扩展预留</p>
        </div>

        <div class="settings-field" :class="{ dimmed: !draftIndexEnabled }">
          <div class="field-row">
            <div class="field-label">启动向量文本索引服务</div>
            <label class="switch" :class="{ on: draftVectorTextEnabled }">
              <input v-model="draftVectorTextEnabled" type="checkbox" :disabled="!draftIndexEnabled" />
              <span class="switch-slider"></span>
            </label>
          </div>
          <p class="field-hint">关闭后向量文本索引（语义检索 / 生成向量索引 / 向量标签）功能关闭</p>
        </div>

        <div class="settings-section-title">全文检索服务（laoflchdb-rust）</div>

        <div class="settings-field" :class="{ dimmed: draftProtocol !== 'grpc' || !draftIndexEnabled || !draftFulltextEnabled }">
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

        <div class="settings-field" :class="{ dimmed: draftProtocol !== 'grpc' || !draftIndexEnabled || !draftFulltextEnabled }">
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
              placeholder="29777"
              inputmode="numeric"
            />
          </div>
        </div>

        <div class="settings-field" :class="{ dimmed: draftProtocol !== 'rest' || !draftIndexEnabled || !draftFulltextEnabled }">
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
              placeholder="38080"
              inputmode="numeric"
            />
          </div>
        </div>

        <div class="settings-field inline-field" :class="{ dimmed: !draftIndexEnabled || !draftFulltextEnabled }">
          <div class="field-label">索引名</div>
          <input
            v-model="draftIndexName"
            class="settings-input index-name"
            placeholder="md_docs"
          />
        </div>
        <p class="field-hint">全文检索使用的索引表名，默认 md_docs；字段结构升级时会自动清空重建，并重置全文索引状态</p>

        <div class="settings-section-title">向量文本索引服务（laoflchdb-rust, gRPC）</div>

        <div class="settings-field inline-field" :class="{ dimmed: !draftIndexEnabled || !draftVectorTextEnabled }">
          <div class="field-label">向量索引名</div>
          <input
            v-model="draftVectorIndexName"
            class="settings-input index-name"
            placeholder="text_md"
          />
        </div>
        <p class="field-hint">向量索引名，需在服务端 laoflchdb.yaml 的 embedding_index.indices 中预定义</p>

        <div class="settings-field inline-field" :class="{ dimmed: !draftIndexEnabled || !draftVectorTextEnabled }">
          <div class="field-label">向量模型名</div>
          <input
            v-model="draftVectorModelName"
            class="settings-input index-name"
            placeholder="bge-m3"
          />
        </div>
        <p class="field-hint">生成文本向量的模型名，默认 bge-m3</p>

        <div class="settings-field inline-field" :class="{ dimmed: !draftIndexEnabled || !draftVectorTextEnabled }">
          <div class="field-label">分块长度</div>
          <input
            v-model.number="draftVectorChunkSize"
            class="settings-input num-input"
            type="number"
            min="100"
            max="10000"
          />
        </div>
        <p class="field-hint">文档按此字符数分块，每块一条向量，默认 800</p>

        <div class="settings-field inline-field" :class="{ dimmed: !draftIndexEnabled || !draftVectorTextEnabled }">
          <div class="field-label">重叠长度</div>
          <input
            v-model.number="draftVectorChunkOverlap"
            class="settings-input num-input"
            type="number"
            min="0"
          />
        </div>
        <p class="field-hint">相邻分块之间的重叠字符数，保留跨块语义，默认 100</p>

        <div class="settings-section-title">向量检索</div>

        <div class="settings-field inline-field" :class="{ dimmed: !draftIndexEnabled || !draftVectorTextEnabled }">
          <div class="field-label">TopK</div>
          <input
            v-model.number="draftSearchTopK"
            class="settings-input num-input"
            type="number"
            min="1"
            max="1000"
          />
        </div>
        <p class="field-hint">每次向量检索返回的结果条数上限，默认 30</p>

        <div class="settings-field inline-field" :class="{ dimmed: !draftIndexEnabled || !draftVectorTextEnabled }">
          <div class="field-label">距离上限</div>
          <input
            v-model.number="draftSearchMaxDistance"
            class="settings-input num-input"
            type="number"
            min="0"
            step="0.01"
          />
        </div>
        <p class="field-hint">只保留距离小于该值的结果（距离越小越相关），0 表示不筛选</p>

        <div class="settings-section-title">Raft 索引状态（laoflchdb-rust）</div>

        <div class="settings-field" :class="{ dimmed: !draftIndexEnabled }">
          <div class="field-label">连接协议</div>
          <div class="radio-group">
            <label class="radio-option" :class="{ active: draftRaftProtocol === 'grpc' }">
              <input v-model="draftRaftProtocol" type="radio" value="grpc" />
              <span>gRPC</span>
            </label>
            <label class="radio-option" :class="{ active: draftRaftProtocol === 'rest' }">
              <input v-model="draftRaftProtocol" type="radio" value="rest" />
              <span>REST</span>
            </label>
          </div>
        </div>

        <div class="settings-field inline-field" :class="{ dimmed: !draftIndexEnabled }">
          <div class="field-label">服务地址</div>
          <input v-model="draftRaftHost" class="settings-input" type="text" placeholder="127.0.0.1" />
        </div>
        <div class="settings-field inline-field" :class="{ dimmed: !draftIndexEnabled }">
          <div class="field-label">gRPC 端口</div>
          <input
            v-model="draftRaftGrpcPort"
            class="settings-input num-input"
            type="text"
            placeholder="29999"
            :disabled="draftRaftProtocol !== 'grpc'"
          />
        </div>
        <div
          class="settings-field inline-field"
          :class="{ dimmed: !draftIndexEnabled || draftRaftProtocol !== 'rest' }"
        >
          <div class="field-label">REST 端口</div>
          <input
            v-model="draftRaftRestPort"
            class="settings-input num-input"
            type="text"
            placeholder="18080"
            :disabled="draftRaftProtocol !== 'rest'"
          />
        </div>
        <div class="settings-field inline-field" :class="{ dimmed: !draftIndexEnabled }">
          <div class="field-label">组名</div>
          <input v-model="draftRaftGroup" class="settings-input" type="text" placeholder="group-laoflchMD-etc" />
        </div>
        <p class="field-hint">
          文件是否已生成全文索引 / 向量索引统一保存在 Raft：key 为 INDEX + 空字符 + 文件 blake3，value 含 has_fulltext、has_vector、doc_id、row_id 与 chunk_ids
        </p>

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

.field-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.field-row .field-label {
  margin-bottom: 0;
}

/* 开关（el-switch 风格，激活绿色） */
.switch {
  position: relative;
  display: inline-block;
  width: 40px;
  height: 20px;
  flex-shrink: 0;
}

.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.switch-slider {
  position: absolute;
  inset: 0;
  background: #dcdfe6;
  border-radius: 10px;
  transition: background 0.2s;
  cursor: pointer;
}

.switch-slider::before {
  content: '';
  position: absolute;
  width: 16px;
  height: 16px;
  left: 2px;
  top: 2px;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.2s;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
}

.switch.on .switch-slider {
  background: #67c23a;
}

.switch.on .switch-slider::before {
  transform: translateX(20px);
}

.switch input:disabled + .switch-slider {
  opacity: 0.5;
  cursor: not-allowed;
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

/* 标签与输入框同行、向两边对齐 */
.inline-field {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.inline-field .field-label {
  margin-bottom: 0;
  flex: none;
}

.inline-field .settings-input.index-name {
  width: 180px;
}

.inline-field .settings-input.num-input {
  width: 120px;
  text-align: right;
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
