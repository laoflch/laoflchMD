import { defineStore } from 'pinia'
import { ref } from 'vue'

const CONFIG_KEY = 'laoflchmd_s3_config'

export const useS3Store = defineStore('s3', () => {
  // 连接配置（持久化到 localStorage）
  const config = ref<S3Config>({
    endpoint: '',
    region: 'us-east-1',
    accessKeyId: '',
    secretAccessKey: ''
  })

  const connected = ref(false)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const notice = ref<string | null>(null)

  const buckets = ref<S3Bucket[]>([])
  const currentBucket = ref<string | null>(null)
  const currentPrefix = ref('')
  const folders = ref<string[]>([])
  const files = ref<S3ObjectEntry[]>([])
  const breadcrumb = ref<string[]>([])

  function loadConfig() {
    try {
      const raw = localStorage.getItem(CONFIG_KEY)
      if (raw) {
        config.value = { ...config.value, ...JSON.parse(raw) }
      }
    } catch {
      // 忽略解析错误，使用默认配置
    }
  }

  function saveConfig() {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config.value))
  }

  function setConfig(c: S3Config) {
    config.value = { ...config.value, ...c }
    saveConfig()
    // 配置变更后视为未连接
    connected.value = false
  }

  function clearError() {
    error.value = null
  }

  // 返回普通对象副本，避免将 Vue 响应式 Proxy 传给 IPC（structured clone 无法克隆 Proxy）
  function plainConfig(): S3Config {
    return {
      endpoint: config.value.endpoint,
      region: config.value.region,
      accessKeyId: config.value.accessKeyId,
      secretAccessKey: config.value.secretAccessKey
    }
  }

  // 连接并列出所有桶
  async function connect() {
    loading.value = true
    error.value = null
    try {
      buckets.value = await window.api.s3ListBuckets(plainConfig())
      connected.value = true
      currentBucket.value = null
      currentPrefix.value = ''
      folders.value = []
      files.value = []
      breadcrumb.value = []
      saveConfig()
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : '连接失败'
      connected.value = false
    } finally {
      loading.value = false
    }
  }

  function buildBreadcrumb(prefix: string): string[] {
    if (!prefix) return []
    return prefix.replace(/\/$/, '').split('/').filter(Boolean)
  }

  // 刷新当前桶、当前前缀下的对象列表
  async function refreshListing() {
    if (!currentBucket.value) return
    loading.value = true
    error.value = null
    try {
      // 服务端 Key 为明文，直接以原始形式传输与存储，不做任何编码转换
      const listing = await window.api.s3ListObjects(
        plainConfig(),
        currentBucket.value,
        currentPrefix.value
      )
      folders.value = listing.folders
      files.value = listing.files
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : '列出对象失败'
    } finally {
      loading.value = false
    }
  }

  // 进入某个桶
  async function openBucket(name: string) {
    currentBucket.value = name
    currentPrefix.value = ''
    folders.value = []
    files.value = []
    breadcrumb.value = []
    await refreshListing()
  }

  // 进入某个文件夹（前缀）
  async function openFolder(prefix: string) {
    currentPrefix.value = prefix
    breadcrumb.value = buildBreadcrumb(prefix)
    await refreshListing()
  }

  // 返回上一级
  async function goUp() {
    if (!currentPrefix.value) return
    const trimmed = currentPrefix.value.replace(/\/$/, '')
    const idx = trimmed.lastIndexOf('/')
    currentPrefix.value = idx >= 0 ? trimmed.slice(0, idx + 1) : ''
    breadcrumb.value = buildBreadcrumb(currentPrefix.value)
    await refreshListing()
  }

  // 下载对象内容（Markdown 文本）
  async function getObject(entry: S3ObjectEntry): Promise<string | null> {
    if (!currentBucket.value) return null
    error.value = null
    try {
      // 直接用原始 Key（明文），不做编码转换
      return await window.api.s3GetObject(plainConfig(), currentBucket.value, entry.key)
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : '读取对象失败'
      return null
    }
  }

  // 上传对象（另存为到 S3）
  async function putObject(key: string, content: string): Promise<boolean> {
    if (!currentBucket.value) return false
    error.value = null
    try {
      // 直接用原始 Key（明文），不做编码转换
      await window.api.s3PutObject(plainConfig(), currentBucket.value, key, content)
      return true
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : '上传失败'
      return false
    }
  }

  // 当前文件夹的完整前缀（用于默认保存键）
  function currentFolderKey(): string {
    return currentPrefix.value
  }

  loadConfig()

  return {
    config,
    connected,
    loading,
    error,
    notice,
    buckets,
    currentBucket,
    currentPrefix,
    folders,
    files,
    breadcrumb,
    setConfig,
    clearError,
    connect,
    refreshListing,
    openBucket,
    openFolder,
    goUp,
    getObject,
    putObject,
    currentFolderKey
  }
})
