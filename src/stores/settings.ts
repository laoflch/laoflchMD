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
export const DEFAULT_RAFT_HOST = '127.0.0.1'
export const DEFAULT_RAFT_GRPC_PORT = '29999'
export const DEFAULT_RAFT_REST_PORT = '18080'
export const DEFAULT_RAFT_GROUP = 'group-laoflchMD-etc'

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
  vectorSearchTopK: number
  vectorSearchMaxDistance: number
  raftHost: string
  raftProtocol: IndexProtocol
  raftGrpcPort: string
  raftRestPort: string
  raftGroup: string
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
  // 向量检索：返回结果条数上限
  const vectorSearchTopK = ref(30)
  // 向量检索：距离上限（只保留 distance < 该值的结果），0 表示不筛选
  const vectorSearchMaxDistance = ref(0.4)
  // Raft KV：保存每个文件索引状态（key 为 "INDEX" + \0 + blake3）的目标服务
  const raftProtocol = ref<IndexProtocol>('grpc')
  const raftHost = ref(DEFAULT_RAFT_HOST)
  const raftGrpcPort = ref(DEFAULT_RAFT_GRPC_PORT)
  const raftRestPort = ref(DEFAULT_RAFT_REST_PORT)
  const raftGroup = ref(DEFAULT_RAFT_GROUP)

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
        if (typeof saved.vectorSearchTopK === 'number') vectorSearchTopK.value = saved.vectorSearchTopK
        if (typeof saved.vectorSearchMaxDistance === 'number') {
          vectorSearchMaxDistance.value = saved.vectorSearchMaxDistance
        }
        if (saved.raftHost) raftHost.value = saved.raftHost
        if (saved.raftProtocol === 'grpc' || saved.raftProtocol === 'rest') {
          raftProtocol.value = saved.raftProtocol
        }
        if (saved.raftGrpcPort) raftGrpcPort.value = saved.raftGrpcPort
        if (saved.raftRestPort) raftRestPort.value = saved.raftRestPort
        if (saved.raftGroup) raftGroup.value = saved.raftGroup
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
      vectorChunkOverlap,
      vectorSearchTopK,
      vectorSearchMaxDistance,
      raftHost,
      raftProtocol,
      raftGrpcPort,
      raftRestPort,
      raftGroup
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
        vectorChunkOverlap: vectorChunkOverlap.value,
        vectorSearchTopK: vectorSearchTopK.value,
        vectorSearchMaxDistance: vectorSearchMaxDistance.value,
        raftHost: raftHost.value,
        raftProtocol: raftProtocol.value,
        raftGrpcPort: raftGrpcPort.value,
        raftRestPort: raftRestPort.value,
        raftGroup: raftGroup.value
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
    vectorChunkOverlap,
    vectorSearchTopK,
    vectorSearchMaxDistance,
    raftHost,
    raftProtocol,
    raftGrpcPort,
    raftRestPort,
    raftGroup
  }
})
