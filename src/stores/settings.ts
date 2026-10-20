import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

export type IndexProtocol = 'grpc' | 'rest'

const SETTINGS_KEY = 'laoflchmd.settings.v1'

// laoflchdb-rust 索引服务默认配置（见 laoflchdb.yaml access_protocols）
export const DEFAULT_GRPC_HOST = '127.0.0.1'
export const DEFAULT_GRPC_PORT = '29777'
export const DEFAULT_REST_HOST = '127.0.0.1'
export const DEFAULT_REST_PORT = '38080'

interface PersistedSettings {
  indexProtocol: IndexProtocol
  grpcHost: string
  grpcPort: string
  restHost: string
  restPort: string
}

/**
 * 全局设置 store：全文检索（laoflchdb-rust）服务的协议与访问地址/端口。
 * 持久化到 localStorage，修改即保存。
 */
export const useSettingsStore = defineStore('settings', () => {
  const indexProtocol = ref<IndexProtocol>('rest')
  const grpcHost = ref(DEFAULT_GRPC_HOST)
  const grpcPort = ref(DEFAULT_GRPC_PORT)
  const restHost = ref(DEFAULT_REST_HOST)
  const restPort = ref(DEFAULT_REST_PORT)

  // 初始化：从 localStorage 读取
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY)
      if (raw) {
        const saved = JSON.parse(raw) as Partial<PersistedSettings>
        if (saved.indexProtocol === 'grpc' || saved.indexProtocol === 'rest') {
          indexProtocol.value = saved.indexProtocol
        }
        if (saved.grpcHost) grpcHost.value = saved.grpcHost
        if (saved.grpcPort) grpcPort.value = saved.grpcPort
        if (saved.restHost) restHost.value = saved.restHost
        if (saved.restPort) restPort.value = saved.restPort
      }
    } catch {
      // 忽略损坏的设置数据，使用默认值
    }
  }

  // 持久化
  watch([indexProtocol, grpcHost, grpcPort, restHost, restPort], () => {
    const data: PersistedSettings = {
      indexProtocol: indexProtocol.value,
      grpcHost: grpcHost.value,
      grpcPort: grpcPort.value,
      restHost: restHost.value,
      restPort: restPort.value
    }
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(data))
  })

  return {
    indexProtocol,
    grpcHost,
    grpcPort,
    restHost,
    restPort
  }
})
