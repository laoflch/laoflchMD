import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

export type IndexProtocol = 'grpc' | 'rest'

const SETTINGS_KEY = 'laoflchmd.settings.v1'

// laoflchdb-rust 索引服务默认配置（见 laoflchdb.yaml access_protocols）
export const DEFAULT_GRPC_HOST = '127.0.0.1'
export const DEFAULT_GRPC_PORT = '29777'
export const DEFAULT_REST_HOST = '127.0.0.1'
export const DEFAULT_REST_PORT = '38080'
export const DEFAULT_INDEX_NAME = 'md_docs'
export const DEFAULT_VECTOR_INDEX_NAME = 'text_md'
export const DEFAULT_VECTOR_MODEL_NAME = 'bge-m3'

interface PersistedSettings {
  indexEnabled: boolean
  fulltextEnabled: boolean
  indexProtocol: IndexProtocol
  grpcHost: string
  grpcPort: string
  restHost: string
  restPort: string
  indexName: string
  vectorTextEnabled: boolean
  vectorIndexName: string
  vectorModelName: string
  vectorChunkSize: number
  vectorChunkOverlap: number
}

/**
 * 全局设置 store：索引配置（总开关 + 全文/向量子开关）与全文检索服务的
 * 协议、访问地址/端口、索引表名，以及向量文本索引的索引名/模型名/分块参数。
 * 持久化到 localStorage，修改即保存。
 */
export const useSettingsStore = defineStore('settings', () => {
  // 索引服务总开关：关闭后所有索引功能不可用
  const indexEnabled = ref(true)
  // 全文索引子开关：关闭后全文索引（检索/生成索引/全文标签）功能关闭
  const fulltextEnabled = ref(true)
  // 向量文本索引子开关：关闭后向量文本索引功能关闭
  const vectorTextEnabled = ref(true)
  const indexProtocol = ref<IndexProtocol>('rest')
  const grpcHost = ref(DEFAULT_GRPC_HOST)
  const grpcPort = ref(DEFAULT_GRPC_PORT)
  const restHost = ref(DEFAULT_REST_HOST)
  const restPort = ref(DEFAULT_REST_PORT)
  const indexName = ref(DEFAULT_INDEX_NAME)
  const vectorIndexName = ref(DEFAULT_VECTOR_INDEX_NAME)
  const vectorModelName = ref(DEFAULT_VECTOR_MODEL_NAME)
  const vectorChunkSize = ref(800)
  const vectorChunkOverlap = ref(100)

  // 初始化：从 localStorage 读取
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY)
      if (raw) {
        const saved = JSON.parse(raw) as Partial<PersistedSettings>
        if (typeof saved.indexEnabled === 'boolean') indexEnabled.value = saved.indexEnabled
        if (typeof saved.fulltextEnabled === 'boolean') fulltextEnabled.value = saved.fulltextEnabled
        if (typeof saved.vectorTextEnabled === 'boolean') vectorTextEnabled.value = saved.vectorTextEnabled
        if (saved.indexProtocol === 'grpc' || saved.indexProtocol === 'rest') {
          indexProtocol.value = saved.indexProtocol
        }
        if (saved.grpcHost) grpcHost.value = saved.grpcHost
        if (saved.grpcPort) grpcPort.value = saved.grpcPort
        if (saved.restHost) restHost.value = saved.restHost
        if (saved.restPort) restPort.value = saved.restPort
        if (saved.indexName) indexName.value = saved.indexName
        if (saved.vectorIndexName) vectorIndexName.value = saved.vectorIndexName
        if (saved.vectorModelName) vectorModelName.value = saved.vectorModelName
        if (typeof saved.vectorChunkSize === 'number') vectorChunkSize.value = saved.vectorChunkSize
        if (typeof saved.vectorChunkOverlap === 'number') vectorChunkOverlap.value = saved.vectorChunkOverlap
      }
    } catch {
      // 忽略损坏的设置数据，使用默认值
    }
  }

  // 持久化
  watch(
    [
      indexEnabled,
      fulltextEnabled,
      vectorTextEnabled,
      indexProtocol,
      grpcHost,
      grpcPort,
      restHost,
      restPort,
      indexName,
      vectorIndexName,
      vectorModelName,
      vectorChunkSize,
      vectorChunkOverlap
    ],
    () => {
      const data: PersistedSettings = {
        indexEnabled: indexEnabled.value,
        fulltextEnabled: fulltextEnabled.value,
        vectorTextEnabled: vectorTextEnabled.value,
        indexProtocol: indexProtocol.value,
        grpcHost: grpcHost.value,
        grpcPort: grpcPort.value,
        restHost: restHost.value,
        restPort: restPort.value,
        indexName: indexName.value,
        vectorIndexName: vectorIndexName.value,
        vectorModelName: vectorModelName.value,
        vectorChunkSize: vectorChunkSize.value,
        vectorChunkOverlap: vectorChunkOverlap.value
      }
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(data))
    }
  )

  return {
    indexEnabled,
    fulltextEnabled,
    vectorTextEnabled,
    indexProtocol,
    grpcHost,
    grpcPort,
    restHost,
    restPort,
    indexName,
    vectorIndexName,
    vectorModelName,
    vectorChunkSize,
    vectorChunkOverlap
  }
})
