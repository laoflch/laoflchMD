export {}

declare global {
  interface Window {
    api: {
      // File operations
      openFile: () => Promise<{ content: string; filePath: string } | null>
      saveFile: (content: string, filePath?: string) => Promise<string | null>
      saveFileAs: (content: string, defaultName?: string) => Promise<string | null>
      getFilePath: () => Promise<string | null>
      setTitle: (title: string) => Promise<void>
      exportHtml: (html: string) => Promise<void>
      exportPdf: (html: string) => Promise<void>

      // Window controls
      minimizeWindow: () => Promise<void>
      maximizeWindow: () => Promise<void>
      closeWindow: () => Promise<void>
      isMaximized: () => Promise<boolean>
      onMaximizedChanged: (callback: (maximized: boolean) => void) => () => void

      // File tree operations
      readFile: (filePath: string) => Promise<string | null>
      readDir: (dirPath: string) => Promise<FileEntry[]>
      searchFiles: (
        rootPath: string,
        keyword: string
      ) => Promise<Array<{ name: string; path: string; relativePath: string }>>
      getAppState: (key: string) => Promise<string | null>
      setAppState: (key: string, value: string) => Promise<boolean>
      openDirectory: () => Promise<string | null>
      getFileDir: (filePath: string) => Promise<string | null>
      newFile: (dirPath: string) => Promise<{ name: string; path: string } | null>
      newFolder: (dirPath: string) => Promise<{ name: string; path: string } | null>
      rename: (oldPath: string, newName: string) => Promise<string | null>
      delete: (targetPath: string) => Promise<boolean>

      // Menu event listeners
      onNewFile: (callback: () => void) => () => void
      onOpenFile: (callback: () => void) => () => void
      onSaveFile: (callback: () => void) => () => void
      onSaveAsFile: (callback: () => void) => () => void
      onExportHtml: (callback: () => void) => () => void
      onExportPdf: (callback: () => void) => () => void
      onToggleTheme: (callback: () => void) => () => void
      onToggleSidebar: (callback: () => void) => () => void
      onAbout: (callback: () => void) => () => void
      getAppInfo: () => Promise<{ version: string; notes: VersionNote[] }>

      // System theme detection
      getSystemTheme: () => Promise<boolean>
      onSystemThemeChanged: (callback: (isDark: boolean) => void) => () => void

      // S3 operations
      s3ListBuckets: (config: S3Config) => Promise<S3Bucket[]>
      s3ListObjects: (config: S3Config, bucket: string, prefix: string) => Promise<{ folders: string[]; files: S3ObjectEntry[] }>
      s3GetObject: (config: S3Config, bucket: string, key: string) => Promise<string | null>
      s3PutObject: (config: S3Config, bucket: string, key: string, content: string) => Promise<void>
      s3DeleteObject: (config: S3Config, bucket: string, key: string) => Promise<boolean>

      // 本机主机名
      getHostname: () => Promise<string>

      // Full-text search (laoflchdb-rust)
      indexEnsure: (
        protocol: IndexProtocol,
        host: string,
        port: string,
        indexName: string,
        raft: RaftConfig
      ) => Promise<{ ok: boolean; message: string; created: boolean }>
      indexSearch: (
        protocol: IndexProtocol,
        host: string,
        port: string,
        indexName: string,
        query: string,
        limit?: number
      ) => Promise<{ ok: boolean; message: string; results: IndexSearchResult[] }>
      indexLocalFile: (
        protocol: IndexProtocol,
        host: string,
        port: string,
        indexName: string,
        filePath: string,
        raft: RaftConfig
      ) => Promise<{ ok: boolean; message: string; docId?: string }>
      indexDir: (
        protocol: IndexProtocol,
        host: string,
        port: string,
        indexName: string,
        dirPath: string,
        raft: RaftConfig
      ) => Promise<{ ok: boolean; message: string; count: number }>
      indexS3File: (
        protocol: IndexProtocol,
        host: string,
        port: string,
        indexName: string,
        config: S3Config,
        bucket: string,
        key: string,
        raft: RaftConfig
      ) => Promise<{ ok: boolean; message: string; docId?: string }>
      indexCheckFiles: (
        paths: string[],
        raft: RaftConfig
      ) => Promise<{ ok: boolean; message: string; results: Record<string, IndexCheckResult> }>
      indexCheckS3Files: (
        config: S3Config,
        bucket: string,
        keys: string[],
        raft: RaftConfig
      ) => Promise<{ ok: boolean; message: string; results: Record<string, IndexCheckResult> }>
      indexGetDoc: (
        kind: 'local' | 's3',
        path: string,
        config: S3Config | undefined,
        bucket: string | undefined,
        key: string | undefined,
        raft: RaftConfig
      ) => Promise<{ ok: boolean; message: string; doc: IndexSearchResult | null }>
      indexDeleteDoc: (
        protocol: IndexProtocol,
        host: string,
        port: string,
        indexName: string,
        docId: string,
        fields: Record<string, string> | undefined,
        raft: RaftConfig
      ) => Promise<{ ok: boolean; message: string }>
      indexRefreshAfterSave: (
        raft: RaftConfig,
        kind: 'local' | 's3',
        filePath: string,
        config: S3Config | undefined,
        bucket: string | undefined,
        key: string | undefined,
        fulltext: {
          protocol: IndexProtocol
          host: string
          port: string
          indexName: string
          regenerate: boolean
        } | null,
        vector: {
          host: string
          port: string
          indexName: string
          modelName: string
          chunkSize?: number
          overlap?: number
          regenerate: boolean
        } | null,
        force?: boolean
      ) => Promise<{ ok: boolean; message: string }>
      onIndexProgress: (
        callback: (progress: IndexProgress) => void
      ) => () => void

      // Vector text index (laoflchdb-rust, gRPC)
      vectorGetInfo: (
        host: string,
        port: string,
        indexName: string
      ) => Promise<{ ok: boolean; message: string; stats: VectorIndexStats | null }>
      vectorIndexLocal: (
        raft: RaftConfig,
        host: string,
        port: string,
        indexName: string,
        modelName: string,
        filePath: string,
        chunkSize?: number,
        overlap?: number
      ) => Promise<{ ok: boolean; message: string; count: number }>
      vectorIndexDir: (
        raft: RaftConfig,
        host: string,
        port: string,
        indexName: string,
        modelName: string,
        dirPath: string,
        chunkSize?: number,
        overlap?: number
      ) => Promise<{ ok: boolean; message: string; count: number }>
      vectorIndexS3: (
        raft: RaftConfig,
        host: string,
        port: string,
        indexName: string,
        modelName: string,
        config: S3Config,
        bucket: string,
        key: string,
        chunkSize?: number,
        overlap?: number
      ) => Promise<{ ok: boolean; message: string; count: number }>
      vectorSearch: (
        raft: RaftConfig,
        host: string,
        port: string,
        indexName: string,
        modelName: string,
        query: string,
        topK?: number
      ) => Promise<{ ok: boolean; message: string; results: VectorSearchResult[] }>
      vectorDeleteFile: (
        raft: RaftConfig,
        host: string,
        port: string,
        indexName: string,
        kind: 'local' | 's3',
        path: string,
        config?: S3Config,
        bucket?: string,
        key?: string
      ) => Promise<{ ok: boolean; message: string }>
      vectorDeleteId: (
        raft: RaftConfig,
        host: string,
        port: string,
        indexName: string,
        id: string | number
      ) => Promise<{ ok: boolean; message: string }>
      onVectorProgress: (
        callback: (progress: IndexProgress) => void
      ) => () => void
    }
  }
}

export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  isMarkdown: boolean
  /** 可预览/编辑的类型；目录为 null */
  fileType: 'markdown' | 'yaml' | 'html' | 'jinja' | null
}

export interface S3Config {
  endpoint?: string
  region?: string
  accessKeyId: string
  secretAccessKey: string
}

export interface S3Bucket {
  name: string
  creationDate: string | null
}

export interface S3ObjectEntry {
  key: string
  name: string
  size: number
  lastModified: string | null
  eTag?: string
  isMarkdown: boolean
  /** 可预览/编辑的类型 */
  fileType: 'markdown' | 'yaml' | 'html' | 'jinja' | null
}

export interface VersionNote {
  version: string
  date: string
  title: string
  changes: string[]
}

export type IndexProtocol = 'grpc' | 'rest'

/** Raft KV 连接参数：索引状态唯一真源（key 为 "INDEX" + \0 + 文件 blake3） */
export interface RaftConfig {
  protocol: IndexProtocol
  host: string
  port: string
  group: string
}

/** 单个文件的索引状态检查结果（全文 + 向量） */
export interface IndexCheckResult {
  hasFulltext: boolean
  hasVector: boolean
}

export interface IndexSearchResult {
  docId: string
  score: number
  fields: Record<string, string>
}

export interface IndexProgress {
  done: number
  total: number
  fileName: string
}

export interface VectorIndexStats {
  numElements: number
  dim: number
  name: string
}

export interface VectorSearchResult {
  docId: string
  score: number
  distance: number
  fields: Record<string, string>
}