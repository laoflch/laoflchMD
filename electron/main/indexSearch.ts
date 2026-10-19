import { ipcMain } from 'electron'
import { hostname as getHostname } from 'os'
import { join, basename, extname } from 'path'
import { readFileSync, readdirSync, statSync } from 'fs'

/**
 * 全文检索服务（laoflchdb-rust）客户端。
 * - 支持 gRPC（@grpc/grpc-js + 手写 protobuf 编解码）与 REST（fetch）两种协议
 * - 统一认证：admin/laoflchdb 登录 → Bearer token，token 失效时自动重新登录并重试
 * - 索引名 md_docs；字段全部 STRING，自定义 doc_id 存在 fields.doc_id 字段中
 *   （tantivy 引擎把 add_document 的 doc_id 参数强制解析为 u64，故无法直接使用字符串 doc_id）
 */

const INDEX_NAME = 'md_docs'
const DEFAULT_USER = 'admin'
const DEFAULT_PASS = 'laoflchdb'
const DEFAULT_SEARCH_LIMIT = 20

export type IndexProtocol = 'grpc' | 'rest'

export interface IndexSearchResult {
  /** 服务端返回的数字 row_id（不可用于定位文件，文件信息在 fields 中） */
  docId: string
  score: number
  fields: Record<string, string>
}

export interface IndexFields {
  docId: string
  title: string
  content: string
  path: string
  kind: 'local' | 's3'
  host: string
  server: string
  bucket: string
  key: string
  updatedAt: string
}

function buildFields(f: IndexFields): Record<string, string> {
  return {
    doc_id: f.docId,
    title: f.title,
    content: f.content,
    path: f.path,
    kind: f.kind,
    host: f.host,
    server: f.server,
    bucket: f.bucket,
    key: f.key,
    updated_at: f.updatedAt
  }
}

// ———————— 手写 protobuf wire format 编解码（无 protoc codegen 依赖） ————————

function pbVarint(value: number): Buffer {
  const bytes: number[] = []
  let v = value
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80)
    v = Math.floor(v / 128)
  }
  bytes.push(v)
  return Buffer.from(bytes)
}

function pbTag(fieldNum: number, wireType: number): Buffer {
  return pbVarint((fieldNum << 3) | wireType)
}

function pbLenField(fieldNum: number, payload: Buffer): Buffer {
  return Buffer.concat([pbTag(fieldNum, 2), pbVarint(payload.length), payload])
}

function pbStrField(fieldNum: number, s: string): Buffer {
  return pbLenField(fieldNum, Buffer.from(s, 'utf8'))
}

function pbVarintField(fieldNum: number, value: number): Buffer {
  return Buffer.concat([pbTag(fieldNum, 0), pbVarint(value)])
}

// map<string,string> 的每个 entry 编码为一个子消息（key=1, value=2）
function pbMapEntries(fieldNum: number, obj: Record<string, string>): Buffer[] {
  return Object.entries(obj).map(([k, v]) => {
    const inner = Buffer.concat([pbStrField(1, k), pbStrField(2, v)])
    return pbLenField(fieldNum, inner)
  })
}

function pbReadVarint(buf: Buffer, offset: number): { value: bigint; offset: number } {
  let result = 0n
  let shift = 0n
  let i = offset
  while (i < buf.length) {
    const byte = buf[i]
    result |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value: result, offset: i + 1 }
    shift += 7n
    i++
  }
  throw new Error('protobuf: invalid varint')
}

interface ProtoField {
  fieldNum: number
  wireType: number
  value: bigint | Buffer | number
}

function pbParse(buf: Buffer): ProtoField[] {
  const fields: ProtoField[] = []
  let offset = 0
  while (offset < buf.length) {
    const r = pbReadVarint(buf, offset)
    const tagVal = r.value
    offset = r.offset
    const fieldNum = Number(tagVal >> 3n)
    const wireType = Number(tagVal & 7n)
    if (wireType === 0) {
      const vr = pbReadVarint(buf, offset)
      fields.push({ fieldNum, wireType, value: vr.value })
      offset = vr.offset
    } else if (wireType === 1) {
      fields.push({ fieldNum, wireType, value: buf.readBigUInt64LE(offset) })
      offset += 8
    } else if (wireType === 2) {
      const lr = pbReadVarint(buf, offset)
      const len = Number(lr.value)
      offset = lr.offset
      fields.push({ fieldNum, wireType, value: buf.subarray(offset, offset + len) })
      offset += len
    } else if (wireType === 5) {
      fields.push({ fieldNum, wireType, value: buf.readFloatLE(offset) })
      offset += 4
    } else {
      throw new Error('protobuf: unsupported wire type ' + wireType)
    }
  }
  return fields
}

function pbAsStr(v: bigint | Buffer | number): string {
  return (v as Buffer).toString('utf8')
}

function pbAsBool(v: bigint | Buffer | number): boolean {
  return (v as bigint) !== 0n
}

// map<string,string> 子消息解码
function pbDecodeMap(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  let key: string | null = null
  for (const f of pbParse(buf)) {
    if (f.fieldNum === 1) key = pbAsStr(f.value)
    else if (f.fieldNum === 2 && key) {
      out[key] = pbAsStr(f.value)
      key = null
    }
  }
  return out
}

// —— 具体消息编解码 ——

interface LoginResponse {
  success: boolean
  message: string
  token: string
}

function encodeLoginRequest(username: string, password: string): Buffer {
  return Buffer.concat([pbStrField(1, username), pbStrField(2, password)])
}

function decodeLoginResponse(buf: Buffer): LoginResponse {
  const out: LoginResponse = { success: false, message: '', token: '' }
  for (const f of pbParse(buf)) {
    if (f.fieldNum === 1) out.success = pbAsBool(f.value)
    else if (f.fieldNum === 2) out.message = pbAsStr(f.value)
    else if (f.fieldNum === 3) out.token = pbAsStr(f.value)
  }
  return out
}

interface ListIndicesResponse {
  success: boolean
  indexNames: string[]
  message: string
}

function decodeListIndicesResponse(buf: Buffer): ListIndicesResponse {
  const out: ListIndicesResponse = { success: false, indexNames: [], message: '' }
  for (const f of pbParse(buf)) {
    if (f.fieldNum === 1) out.success = pbAsBool(f.value)
    else if (f.fieldNum === 2) out.indexNames.push(pbAsStr(f.value))
    else if (f.fieldNum === 3) out.message = pbAsStr(f.value)
  }
  return out
}

function encodeCreateIndexRequest(
  indexName: string,
  fields: Array<{ name: string; fieldType: number; comment?: string }>
): Buffer {
  const fieldParts = fields.map((f) => {
    const inner = Buffer.concat([
      pbStrField(1, f.name),
      pbVarintField(2, f.fieldType),
      f.comment ? pbStrField(3, f.comment) : Buffer.alloc(0)
    ])
    return pbLenField(2, inner)
  })
  return Buffer.concat([pbStrField(1, indexName), ...fieldParts])
}

interface CreateIndexResponse {
  success: boolean
  indexId: bigint
  message: string
}

function decodeCreateIndexResponse(buf: Buffer): CreateIndexResponse {
  const out: CreateIndexResponse = { success: false, indexId: 0n, message: '' }
  for (const f of pbParse(buf)) {
    if (f.fieldNum === 1) out.success = pbAsBool(f.value)
    else if (f.fieldNum === 2) out.indexId = f.value as bigint
    else if (f.fieldNum === 3) out.message = pbAsStr(f.value)
  }
  return out
}

function encodeAddDocumentRequest(
  indexName: string,
  docId: string,
  fields: Record<string, string>
): Buffer {
  return Buffer.concat([
    pbStrField(1, indexName),
    docId ? pbStrField(2, docId) : Buffer.alloc(0),
    ...pbMapEntries(3, fields)
  ])
}

interface AddDocumentResponse {
  success: boolean
  docId: string
  message: string
}

function decodeAddDocumentResponse(buf: Buffer): AddDocumentResponse {
  const out: AddDocumentResponse = { success: false, docId: '', message: '' }
  for (const f of pbParse(buf)) {
    if (f.fieldNum === 1) out.success = pbAsBool(f.value)
    else if (f.fieldNum === 2) out.docId = pbAsStr(f.value)
    else if (f.fieldNum === 3) out.message = pbAsStr(f.value)
  }
  return out
}

function encodeSearchIndexRequest(indexName: string, query: string, limit: number): Buffer {
  return Buffer.concat([
    pbStrField(1, indexName),
    pbStrField(2, query),
    pbVarintField(3, limit)
  ])
}

interface SearchIndexResponse {
  success: boolean
  results: IndexSearchResult[]
  message: string
}

function decodeSearchIndexResponse(buf: Buffer): SearchIndexResponse {
  const out: SearchIndexResponse = { success: false, results: [], message: '' }
  for (const f of pbParse(buf)) {
    if (f.fieldNum === 1) out.success = pbAsBool(f.value)
    else if (f.fieldNum === 2) {
      const item: IndexSearchResult = { docId: '', score: 0, fields: {} }
      for (const it of pbParse(f.value as Buffer)) {
        if (it.fieldNum === 1) item.docId = pbAsStr(it.value)
        else if (it.fieldNum === 2) item.score = it.value as number
        else if (it.fieldNum === 3) item.fields = pbDecodeMap(it.value as Buffer)
      }
      out.results.push(item)
    } else if (f.fieldNum === 3) out.message = pbAsStr(f.value)
  }
  return out
}

// ———————— gRPC 客户端 ————————

let grpcModule: any = null

function getGrpc(): any {
  if (!grpcModule) {
    grpcModule = require('@grpc/grpc-js')
  }
  return grpcModule
}

function makeGrpcServiceDefinition() {
  const def = (methodName: string, serialize: (m: any) => Buffer, deserialize: (b: Buffer) => any) => ({
    path: `/laoflchdb.rpc.LaoflchDb/${methodName}`,
    requestStream: false,
    responseStream: false,
    requestSerialize: (msg: any) => Buffer.from(serialize(msg)),
    requestDeserialize: (buf: Buffer) => buf,
    responseSerialize: (msg: any) => Buffer.from(msg),
    responseDeserialize: (buf: Buffer) => deserialize(Buffer.from(buf))
  })
  return {
    login: def('Login', (m: any) => encodeLoginRequest(m.username, m.password), decodeLoginResponse),
    createIndex: def('CreateIndex', encodeCreateIndexRequest, decodeCreateIndexResponse),
    listIndices: def('ListIndices', () => Buffer.alloc(0), decodeListIndicesResponse),
    addDocument: def('AddDocument', encodeAddDocumentRequest, decodeAddDocumentResponse),
    searchIndex: def('SearchIndex', encodeSearchIndexRequest, decodeSearchIndexResponse)
  }
}

class GrpcClient {
  private address: string
  private token: string | null = null
  private client: any = null

  constructor(host: string, port: string) {
    this.address = host.replace(/^https?:\/\//i, '') + ':' + port
  }

  private ensureClient(): any {
    if (!this.client) {
      const grpc = getGrpc()
      const Client = grpc.makeClientConstructor(makeGrpcServiceDefinition(), 'LaoflchDb')
      this.client = new Client(this.address, grpc.credentials.createInsecure())
    }
    return this.client
  }

  private unary(method: string, req: any): Promise<any> {
    const grpc = getGrpc()
    const client = this.ensureClient()
    return new Promise((resolve, reject) => {
      const md = new grpc.Metadata()
      if (this.token) md.set('authorization', 'Bearer ' + this.token)
      client[method](req, md, (err: any, res: any) => {
        if (err) reject(err)
        else resolve(res)
      })
    })
  }

  async login(): Promise<void> {
    const resp = await this.unary('login', { username: DEFAULT_USER, password: DEFAULT_PASS })
    if (!resp.success || !resp.token) throw new Error(resp.message || '登录失败')
    this.token = resp.token
  }

  async withAuth<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (e: any) {
      // gRPC code 16 = UNAUTHENTICATED：重新登录后重试一次
      if (e && e.code === 16) {
        await this.login()
        return await fn()
      }
      throw e
    }
  }

  async listIndices(): Promise<string[]> {
    return this.withAuth(async () => {
      const resp = await this.unary('listIndices', {})
      if (!resp.success) throw new Error(resp.message || '列出索引失败')
      return resp.indexNames
    })
  }

  async createIndex(indexName: string, fields: Array<{ name: string; fieldType: number; comment?: string }>): Promise<void> {
    await this.withAuth(async () => {
      const resp = await this.unary('createIndex', { indexName, fields })
      if (!resp.success) throw new Error(resp.message || '创建索引失败')
    })
  }

  async addDocument(indexName: string, docId: string, fields: Record<string, string>): Promise<string> {
    return this.withAuth(async () => {
      const resp = await this.unary('addDocument', { indexName, docId, fields })
      if (!resp.success) throw new Error(resp.message || '添加文档失败')
      return resp.docId
    })
  }

  async search(indexName: string, query: string, limit: number): Promise<IndexSearchResult[]> {
    return this.withAuth(async () => {
      const resp = await this.unary('searchIndex', { indexName, query, limit })
      if (!resp.success) throw new Error(resp.message || '搜索失败')
      return resp.results
    })
  }
}

// ———————— REST 客户端 ————————

class RestClient {
  private base: string
  private token: string | null = null

  constructor(host: string, port: string) {
    let h = host.trim()
    if (h && !/^https?:\/\//i.test(h)) h = 'http://' + h
    this.base = `${h}:${port}`
  }

  private async request<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.token) headers['Authorization'] = 'Bearer ' + this.token
    let res: Response
    try {
      res = await fetch(this.base + path, {
        method: opts.method || 'GET',
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined
      })
    } catch (e: any) {
      throw new Error(`连接服务失败: ${e.message || e}`)
    }
    let json: any
    try {
      json = await res.json()
    } catch {
      throw new Error(`服务响应异常 (HTTP ${res.status})`)
    }
    if (json.success !== true) {
      throw new Error(json.message || `请求失败 (HTTP ${res.status})`)
    }
    return json.data as T
  }

  async login(): Promise<void> {
    const data = await this.request<{ token?: string }>('/api/v1/login', {
      method: 'POST',
      body: { username: DEFAULT_USER, password: DEFAULT_PASS }
    })
    if (!data || !data.token) throw new Error('登录失败：未获取到 token')
    this.token = data.token
  }

  async withAuth<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (e: any) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/unauthor|token|登录/i.test(msg)) {
        await this.login()
        return await fn()
      }
      throw e
    }
  }

  async listIndices(): Promise<string[]> {
    return this.withAuth(async () => {
      const data = await this.request<{ indices: string[] }>('/api/v1/index/indices')
      return data?.indices || []
    })
  }

  async createIndex(indexName: string, fields: Array<{ name: string; fieldType: number; comment?: string }>): Promise<void> {
    await this.withAuth(async () => {
      await this.request('/api/v1/index/indices', {
        method: 'POST',
        body: {
          index_name: indexName,
          fields: fields.map((f) => ({
            name: f.name,
            field_type: 'STRING',
            comment: f.comment || undefined
          }))
        }
      })
    })
  }

  async addDocument(indexName: string, docId: string, fields: Record<string, string>): Promise<string> {
    return this.withAuth(async () => {
      const data = await this.request<{ doc_id?: string }>(`/api/v1/index/indices/${indexName}/docs`, {
        method: 'POST',
        body: {
          doc_id: docId || null,
          fields
        }
      })
      return data?.doc_id || docId || ''
    })
  }

  async search(indexName: string, query: string, limit: number): Promise<IndexSearchResult[]> {
    return this.withAuth(async () => {
      const data = await this.request<{ results: IndexSearchResult[] }>(
        `/api/v1/index/indices/${indexName}/search?q=${encodeURIComponent(query)}&limit=${limit}`
      )
      return data?.results || []
    })
  }
}

// ———————— 客户端缓存（按 协议|主机|端口 维度缓存，含登录 token） ————————

const clientCache = new Map<string, GrpcClient | RestClient>()

function getClient(protocol: IndexProtocol, host: string, port: string): GrpcClient | RestClient {
  const key = `${protocol}|${host}|${port}`
  let client = clientCache.get(key)
  if (!client) {
    client = protocol === 'grpc' ? new GrpcClient(host, port) : new RestClient(host, port)
    clientCache.set(key, client)
  }
  return client
}

// ———————— 索引字段构造与本地/S3 建索引 ————————

function localDocId(filePath: string): string {
  return getHostname() + filePath
}

function s3DocId(config: S3IndexConfig, bucket: string, key: string): string {
  let endpoint = (config.endpoint || 's3.amazonaws.com').replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(endpoint)) endpoint = 'http://' + endpoint
  return `${endpoint}/${bucket}/${key}`
}

async function ensureIndex(protocol: IndexProtocol, host: string, port: string): Promise<{ ok: boolean; message: string; created: boolean }> {
  try {
    const client = getClient(protocol, host, port)
    const indices = await client.listIndices()
    if (indices.includes(INDEX_NAME)) {
      return { ok: true, message: `索引 ${INDEX_NAME} 已存在`, created: false }
    }
    await client.createIndex(INDEX_NAME, INDEX_FIELDS)
    return { ok: true, message: `已创建索引 ${INDEX_NAME}`, created: true }
  } catch (e: any) {
    return { ok: false, message: e.message || '检查索引失败', created: false }
  }
}

const INDEX_FIELDS: Array<{ name: string; fieldType: number; comment?: string }> = [
  { name: 'doc_id', fieldType: 0, comment: '自定义文档 ID（主机名+绝对路径 / 服务器地址+保存绝对地址）' },
  { name: 'title', fieldType: 0, comment: '标题（文件名）' },
  { name: 'content', fieldType: 0, comment: '正文全文' },
  { name: 'path', fieldType: 0, comment: '本地绝对路径 / S3 key' },
  { name: 'kind', fieldType: 0, comment: '来源类型：local / s3' },
  { name: 'host', fieldType: 0, comment: '主机名 / S3 服务器地址' },
  { name: 'server', fieldType: 0, comment: 'S3 服务器地址（本地为空）' },
  { name: 'bucket', fieldType: 0, comment: 'S3 桶（本地为空）' },
  { name: 'key', fieldType: 0, comment: 'S3 key（本地为空）' },
  { name: 'updated_at', fieldType: 0, comment: '修改时间（ISO）' }
]

function collectMarkdownFiles(dirPath: string): string[] {
  const results: string[] = []
  const walk = (d: string) => {
    let entries: string[]
    try {
      entries = readdirSync(d)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue
      const full = join(d, entry)
      try {
        const st = statSync(full)
        if (st.isDirectory()) {
          walk(full)
        } else if (/\.(md|markdown|mdown)$/i.test(entry)) {
          results.push(full)
        }
      } catch {
        // 无权限等，忽略
      }
    }
  }
  walk(dirPath)
  return results
}

async function indexLocalFile(
  protocol: IndexProtocol,
  host: string,
  port: string,
  filePath: string
): Promise<{ ok: boolean; message: string; docId?: string }> {
  try {
    const content = readFileSync(filePath, 'utf8')
    let mtime = new Date().toISOString()
    try {
      mtime = statSync(filePath).mtime.toISOString()
    } catch {
      // 保留当前时间
    }
    const fields = buildFields({
      docId: localDocId(filePath),
      title: basename(filePath, extname(filePath)) || basename(filePath),
      content,
      path: filePath,
      kind: 'local',
      host: getHostname(),
      server: '',
      bucket: '',
      key: '',
      updatedAt: mtime
    })
    const client = getClient(protocol, host, port)
    const docId = await client.addDocument(INDEX_NAME, '', fields)
    return { ok: true, message: `已生成索引：${basename(filePath)}`, docId }
  } catch (e: any) {
    return { ok: false, message: `索引 ${basename(filePath)} 失败：${e.message || e}`, docId: undefined }
  }
}

async function indexDir(
  protocol: IndexProtocol,
  host: string,
  port: string,
  dirPath: string
): Promise<{ ok: boolean; message: string; count: number }> {
  const files = collectMarkdownFiles(dirPath)
  let okCount = 0
  let firstErr: string | null = null
  for (const filePath of files) {
    const res = await indexLocalFile(protocol, host, port, filePath)
    if (res.ok) okCount++
    else if (!firstErr) firstErr = res.message
  }
  if (firstErr) {
    return { ok: false, message: `完成 ${okCount}/${files.length}，出错：${firstErr}`, count: okCount }
  }
  return { ok: true, message: `已为 ${okCount} 个 Markdown 文件生成索引`, count: okCount }
}

// ———————— S3 建索引 ————————

export interface S3IndexConfig {
  endpoint?: string
  region?: string
  accessKeyId: string
  secretAccessKey: string
}

async function fetchS3Content(config: S3IndexConfig, bucket: string, key: string): Promise<string> {
  let s3Mod: any = null
  if (!s3Mod) s3Mod = require('@aws-sdk/client-s3')
  const { S3Client, GetObjectCommand } = s3Mod
  let endpoint = config.endpoint || undefined
  if (endpoint && !endpoint.startsWith('http')) endpoint = 'http://' + endpoint
  const client = new S3Client({
    endpoint,
    region: config.region || 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  })
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  const chunks: Buffer[] = []
  for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function indexS3File(
  protocol: IndexProtocol,
  host: string,
  port: string,
  config: S3IndexConfig,
  bucket: string,
  key: string
): Promise<{ ok: boolean; message: string; docId?: string }> {
  try {
    const content = await fetchS3Content(config, bucket, key)
    const fields = buildFields({
      docId: s3DocId(config, bucket, key),
      title: basename(key, extname(key)) || basename(key),
      content,
      path: key,
      kind: 's3',
      host: (config.endpoint || 's3.amazonaws.com').replace(/\/+$/, ''),
      server: (config.endpoint || 's3.amazonaws.com').replace(/\/+$/, ''),
      bucket,
      key,
      updatedAt: new Date().toISOString()
    })
    const client = getClient(protocol, host, port)
    const docId = await client.addDocument(INDEX_NAME, '', fields)
    return { ok: true, message: `已生成索引：${basename(key)}`, docId }
  } catch (e: any) {
    return { ok: false, message: `索引 ${basename(key)} 失败：${e.message || e}`, docId: undefined }
  }
}

// ———————— IPC Handlers ————————

export function registerIndexSearchHandlers(): void {
  ipcMain.handle('index:ensure', async (_e, protocol: IndexProtocol, host: string, port: string) => {
    return ensureIndex(protocol, host, port)
  })

  ipcMain.handle(
    'index:search',
    async (_e, protocol: IndexProtocol, host: string, port: string, query: string, limit?: number) => {
      try {
        const client = getClient(protocol, host, port)
        const results = await client.search(INDEX_NAME, query, limit || DEFAULT_SEARCH_LIMIT)
        return { ok: true, message: '', results }
      } catch (e: any) {
        return { ok: false, message: e.message || '搜索失败', results: [] }
      }
    }
  )

  ipcMain.handle(
    'index:indexLocal',
    async (_e, protocol: IndexProtocol, host: string, port: string, filePath: string) => {
      return indexLocalFile(protocol, host, port, filePath)
    }
  )

  ipcMain.handle(
    'index:indexDir',
    async (_e, protocol: IndexProtocol, host: string, port: string, dirPath: string) => {
      return indexDir(protocol, host, port, dirPath)
    }
  )

  ipcMain.handle(
    'index:indexS3',
    async (
      _e,
      protocol: IndexProtocol,
      host: string,
      port: string,
      config: S3IndexConfig,
      bucket: string,
      key: string
    ) => {
      return indexS3File(protocol, host, port, config, bucket, key)
    }
  )
}
