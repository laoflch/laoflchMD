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
 * - blake3 字段存文件内容 BLAKE3 摘要（64 位 hex），作为去重标识；
 *   文件导航打开目录时通过摘要查询「是否已索引」
 */

const DEFAULT_USER = 'admin'
const DEFAULT_PASS = 'laoflchdb'
const DEFAULT_SEARCH_LIMIT = 20

/** 索引 schema 版本：变更字段结构时递增，ensureIndex 会检测并重建旧表 */
const INDEX_SCHEMA_VERSION = 2

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
  blake3: string
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
    updated_at: f.updatedAt,
    blake3: f.blake3
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

function encodeCreateIndexRequest(msg: {
  indexName: string
  fields: Array<{ name: string; fieldType: number; comment?: string }>
}): Buffer {
  const { indexName, fields } = msg
  const fieldParts = (fields || []).map((f) => {
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
  indexId: number
  message: string
}

function decodeCreateIndexResponse(buf: Buffer): CreateIndexResponse {
  const out: CreateIndexResponse = { success: false, indexId: 0, message: '' }
  for (const f of pbParse(buf)) {
    if (f.fieldNum === 1) out.success = pbAsBool(f.value)
    else if (f.fieldNum === 2) out.indexId = Number(f.value)
    else if (f.fieldNum === 3) out.message = pbAsStr(f.value)
  }
  return out
}

function encodeDropIndexRequest(indexName: string): Buffer {
  return pbStrField(1, indexName)
}

interface DropIndexResponse {
  success: boolean
  message: string
}

function decodeDropIndexResponse(buf: Buffer): DropIndexResponse {
  const out: DropIndexResponse = { success: false, message: '' }
  for (const f of pbParse(buf)) {
    if (f.fieldNum === 1) out.success = pbAsBool(f.value)
    else if (f.fieldNum === 2) out.message = pbAsStr(f.value)
  }
  return out
}

function encodeGetIndexFieldsRequest(indexName: string): Buffer {
  return pbStrField(1, indexName)
}

interface GetIndexFieldsResponse {
  success: boolean
  /** 列名列表（ColumnMeta.column_name） */
  fieldNames: string[]
  message: string
}

function decodeGetIndexFieldsResponse(buf: Buffer): GetIndexFieldsResponse {
  const out: GetIndexFieldsResponse = { success: false, fieldNames: [], message: '' }
  for (const f of pbParse(buf)) {
    if (f.fieldNum === 1) out.success = pbAsBool(f.value)
    else if (f.fieldNum === 2) {
      for (const it of pbParse(f.value as Buffer)) {
        // ColumnMeta.column_name = 3
        if (it.fieldNum === 3) out.fieldNames.push(pbAsStr(it.value))
      }
    } else if (f.fieldNum === 3) out.message = pbAsStr(f.value)
  }
  return out
}

function encodeDeleteDocumentRequest(indexName: string, docId: string): Buffer {
  return Buffer.concat([pbStrField(1, indexName), pbStrField(2, docId)])
}

interface DeleteDocumentResponse {
  success: boolean
  message: string
}

function decodeDeleteDocumentResponse(buf: Buffer): DeleteDocumentResponse {
  const out: DeleteDocumentResponse = { success: false, message: '' }
  for (const f of pbParse(buf)) {
    if (f.fieldNum === 1) out.success = pbAsBool(f.value)
    else if (f.fieldNum === 2) out.message = pbAsStr(f.value)
  }
  return out
}

function encodeAddDocumentRequest(msg: {
  indexName: string
  docId: string
  fields: Record<string, string>
}): Buffer {
  const { indexName, docId, fields } = msg
  return Buffer.concat([
    pbStrField(1, indexName),
    docId ? pbStrField(2, docId) : Buffer.alloc(0),
    ...pbMapEntries(3, fields || {})
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

function encodeSearchIndexRequest(msg: {
  indexName: string
  query?: string
  limit?: number
  fieldQueries?: Record<string, string>
}): Buffer {
  const { indexName, query = '', limit = DEFAULT_SEARCH_LIMIT, fieldQueries = {} } = msg
  return Buffer.concat([
    pbStrField(1, indexName),
    pbStrField(2, query || ''),
    pbVarintField(3, limit),
    ...pbMapEntries(4, fieldQueries)
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
        else if (it.fieldNum === 3) Object.assign(item.fields, pbDecodeMap(it.value as Buffer))
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
    dropIndex: def('DropIndex', (m: any) => encodeDropIndexRequest(m.indexName), decodeDropIndexResponse),
    listIndices: def('ListIndices', () => Buffer.alloc(0), decodeListIndicesResponse),
    getIndexFields: def('GetIndexFields', (m: any) => encodeGetIndexFieldsRequest(m.indexName), decodeGetIndexFieldsResponse),
    addDocument: def('AddDocument', encodeAddDocumentRequest, decodeAddDocumentResponse),
    deleteDocument: def('DeleteDocument', (m: any) => encodeDeleteDocumentRequest(m.indexName, m.docId), decodeDeleteDocumentResponse),
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
      // 认证失败时重新登录后重试一次：
      // - gRPC 状态码 16（UNAUTHENTICATED）
      // - 部分服务端把认证失败放进响应体（success=false + 认证相关 message）
      const msg = e?.details || (e instanceof Error ? e.message : '')
      const authFailed =
        e?.code === 16 ||
        /unauthor|未提供有效的认证|authentication required|invalid or missing token/i.test(msg)
      if (authFailed) {
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

  async dropIndex(indexName: string): Promise<void> {
    await this.withAuth(async () => {
      const resp = await this.unary('dropIndex', { indexName })
      if (!resp.success) throw new Error(resp.message || '删除索引失败')
    })
  }

  async getIndexFields(indexName: string): Promise<string[]> {
    return this.withAuth(async () => {
      const resp = await this.unary('getIndexFields', { indexName })
      if (!resp.success) throw new Error(resp.message || '获取索引字段失败')
      return resp.fieldNames
    })
  }

  async addDocument(indexName: string, docId: string, fields: Record<string, string>): Promise<string> {
    return this.withAuth(async () => {
      const resp = await this.unary('addDocument', { indexName, docId, fields })
      if (!resp.success) throw new Error(resp.message || '添加文档失败')
      return resp.docId
    })
  }

  async deleteDocument(indexName: string, docId: string): Promise<void> {
    await this.withAuth(async () => {
      const resp = await this.unary('deleteDocument', { indexName, docId })
      if (!resp.success) throw new Error(resp.message || '删除文档失败')
    })
  }

  async search(indexName: string, query: string, limit: number): Promise<IndexSearchResult[]> {
    return this.withAuth(async () => {
      const resp = await this.unary('searchIndex', { indexName, query, limit })
      if (!resp.success) throw new Error(resp.message || '搜索失败')
      return resp.results
    })
  }

  async searchMultiField(
    indexName: string,
    fieldQueries: Record<string, string>,
    limit: number
  ): Promise<IndexSearchResult[]> {
    return this.withAuth(async () => {
      const resp = await this.unary('searchIndex', { indexName, fieldQueries, limit })
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

  async dropIndex(indexName: string): Promise<void> {
    await this.withAuth(async () => {
      await this.request(`/api/v1/index/indices/${indexName}`, { method: 'DELETE' })
    })
  }

  async getIndexFields(indexName: string): Promise<string[]> {
    return this.withAuth(async () => {
      const data = await this.request<Array<{ column_name?: string; name?: string }>>(
        `/api/v1/index/indices/${indexName}/fields`
      )
      return (data || []).map((f) => f.column_name || f.name || '')
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

  async deleteDocument(indexName: string, docId: string): Promise<void> {
    await this.withAuth(async () => {
      await this.request(`/api/v1/index/indices/${indexName}/docs/${docId}/delete`, { method: 'DELETE' })
    })
  }

  async search(indexName: string, query: string, limit: number): Promise<IndexSearchResult[]> {
    return this.withAuth(async () => {
      const data = await this.request<{ results: any[] }>(
        `/api/v1/index/indices/${indexName}/search?q=${encodeURIComponent(query)}&limit=${limit}`
      )
      return (data?.results || []).map(mapRestSearchResult)
    })
  }

  async searchMultiField(
    indexName: string,
    fieldQueries: Record<string, string>,
    limit: number
  ): Promise<IndexSearchResult[]> {
    return this.withAuth(async () => {
      const data = await this.request<{ results: any[] }>(
        `/api/v1/index/indices/${indexName}/search/multi`,
        {
          method: 'POST',
          body: { field_queries: fieldQueries, limit }
        }
      )
      return (data?.results || []).map(mapRestSearchResult)
    })
  }
}

// REST 搜索返回 snake_case 的 doc_id，映射为应用的 camelCase docId
function mapRestSearchResult(r: any): IndexSearchResult {
  return {
    docId: typeof r?.doc_id === 'string' ? r.doc_id : '',
    score: typeof r?.score === 'number' ? r.score : 0,
    fields: r?.fields && typeof r.fields === 'object' ? { ...r.fields } : {}
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

async function ensureIndex(
  protocol: IndexProtocol,
  host: string,
  port: string,
  indexName: string
): Promise<{ ok: boolean; message: string; created: boolean }> {
  try {
    const client = getClient(protocol, host, port)
    const indices = await client.listIndices()
    if (indices.includes(indexName)) {
      // 已有表：校验 schema 版本，缺少 blake3 等新字段时重建
      try {
        const names = await client.getIndexFields(indexName)
        const hasAll = INDEX_FIELDS.every((f) => names.includes(f.name))
        if (hasAll) {
          return { ok: true, message: `索引 ${indexName} 已存在`, created: false }
        }
        await client.dropIndex(indexName)
        await client.createIndex(indexName, INDEX_FIELDS)
        return { ok: true, message: `索引 ${indexName} schema 已升级（v${INDEX_SCHEMA_VERSION}）并重建`, created: true }
      } catch (e: any) {
        // 无法读取字段时视为旧版本，重建一次
        await client.dropIndex(indexName)
        await client.createIndex(indexName, INDEX_FIELDS)
        return { ok: true, message: `索引 ${indexName} 已重建（v${INDEX_SCHEMA_VERSION}）`, created: true }
      }
    }
    await client.createIndex(indexName, INDEX_FIELDS)
    return { ok: true, message: `已创建索引 ${indexName}（v${INDEX_SCHEMA_VERSION}）`, created: true }
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
  { name: 'updated_at', fieldType: 0, comment: '修改时间（ISO）' },
  { name: 'blake3', fieldType: 0, comment: '文件内容 BLAKE3 摘要（64位hex，去重标识）' }
]

// ———————— BLAKE3 摘要（hash-wasm，纯 WASM 无需原生编译） ————————

let hashWasmModule: any = null

function getHashWasm(): any {
  if (!hashWasmModule) {
    hashWasmModule = require('hash-wasm')
  }
  return hashWasmModule
}

export async function computeBlake3(content: string | Buffer): Promise<string> {
  const { blake3 } = getHashWasm()
  return await blake3(Buffer.isBuffer(content) ? content.toString('utf8') : content)
}

/** 按摘要精确查询是否已索引（多字段搜索 + 返回字段二次校验） */
async function queryByDigest(
  protocol: IndexProtocol,
  host: string,
  port: string,
  indexName: string,
  digest: string
): Promise<IndexSearchResult | null> {
  if (!digest) return null
  const client = getClient(protocol, host, port)
  const results = await client.searchMultiField(indexName, { blake3: digest }, 20)
  return results.find((r) => r.fields.blake3 === digest) || null
}

/**
 * 去重写入：先按 blake3 摘要删除该文件的全部旧索引条目，再添加新文档。
 * 保证同一文件在索引中只有一条记录（BLAKE3 作为去重标识）。
 */
async function upsertDocument(
  client: GrpcClient | RestClient,
  indexName: string,
  fields: Record<string, string>
): Promise<string> {
  const digest = fields.blake3
  if (digest) {
    try {
      const old = await client.searchMultiField(indexName, { blake3: digest }, 50)
      for (const hit of old) {
        if (hit.fields.blake3 === digest) {
          await client.deleteDocument(indexName, hit.docId)
        }
      }
    } catch {
      // 旧条目查询/删除失败不阻塞新文档写入
    }
  }
  return client.addDocument(indexName, '', fields)
}

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
  indexName: string,
  filePath: string
): Promise<{ ok: boolean; message: string; docId?: string }> {
  try {
    const content = readFileSync(filePath, 'utf8')
    if (!content.trim()) {
      // 内容为空：无法索引，直接跳过（不报失败）
      return { ok: true, message: `跳过空文件：${basename(filePath)}`, docId: undefined }
    }
    const digest = await computeBlake3(content)
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
      updatedAt: mtime,
      blake3: digest
    })
    const client = getClient(protocol, host, port)
    const docId = await upsertDocument(client, indexName, fields)
    return { ok: true, message: `已生成索引：${basename(filePath)}`, docId }
  } catch (e: any) {
    return { ok: false, message: `索引 ${basename(filePath)} 失败：${e.message || e}`, docId: undefined }
  }
}

async function indexDir(
  protocol: IndexProtocol,
  host: string,
  port: string,
  indexName: string,
  dirPath: string,
  onProgress?: (done: number, total: number, fileName: string) => void
): Promise<{ ok: boolean; message: string; count: number }> {
  const files = collectMarkdownFiles(dirPath)
  let okCount = 0
  let firstErr: string | null = null
  for (let i = 0; i < files.length; i++) {
    const filePath = files[i]
    onProgress?.(i + 1, files.length, basename(filePath))
    const res = await indexLocalFile(protocol, host, port, indexName, filePath)
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

export async function fetchS3Content(config: S3IndexConfig, bucket: string, key: string): Promise<string> {
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
  indexName: string,
  config: S3IndexConfig,
  bucket: string,
  key: string
): Promise<{ ok: boolean; message: string; docId?: string }> {
  try {
    const content = await fetchS3Content(config, bucket, key)
    if (!content.trim()) {
      // 内容为空：无法索引，直接跳过（不报失败）
      return { ok: true, message: `跳过空文件：${basename(key)}`, docId: undefined }
    }
    const digest = await computeBlake3(content)
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
      updatedAt: new Date().toISOString(),
      blake3: digest
    })
    const client = getClient(protocol, host, port)
    const docId = await upsertDocument(client, indexName, fields)
    return { ok: true, message: `已生成索引：${basename(key)}`, docId }
  } catch (e: any) {
    return { ok: false, message: `索引 ${basename(key)} 失败：${e.message || e}`, docId: undefined }
  }
}

// ———————— IPC Handlers ————————

export function registerIndexSearchHandlers(): void {
  // 本机主机名（状态栏显示本地文件地址用）
  ipcMain.handle('app:hostname', () => getHostname())

  ipcMain.handle(
    'index:ensure',
    async (_e, protocol: IndexProtocol, host: string, port: string, indexName: string) => {
      return ensureIndex(protocol, host, port, indexName)
    }
  )

  ipcMain.handle(
    'index:search',
    async (
      _e,
      protocol: IndexProtocol,
      host: string,
      port: string,
      indexName: string,
      query: string,
      limit?: number
    ) => {
      try {
        const client = getClient(protocol, host, port)
        const results = await client.search(indexName, query, limit || DEFAULT_SEARCH_LIMIT)
        return { ok: true, message: '', results }
      } catch (e: any) {
        return { ok: false, message: e.message || '搜索失败', results: [] }
      }
    }
  )

  ipcMain.handle(
    'index:indexLocal',
    async (_e, protocol: IndexProtocol, host: string, port: string, indexName: string, filePath: string) => {
      return indexLocalFile(protocol, host, port, indexName, filePath)
    }
  )

  ipcMain.handle(
    'index:indexDir',
    async (e, protocol: IndexProtocol, host: string, port: string, indexName: string, dirPath: string) => {
      return indexDir(protocol, host, port, indexName, dirPath, (done, total, fileName) => {
        e.sender.send('index:progress', { done, total, fileName })
      })
    }
  )

  ipcMain.handle(
    'index:indexS3',
    async (
      _e,
      protocol: IndexProtocol,
      host: string,
      port: string,
      indexName: string,
      config: S3IndexConfig,
      bucket: string,
      key: string
    ) => {
      return indexS3File(protocol, host, port, indexName, config, bucket, key)
    }
  )

  // 批量查询文件是否已索引（按 BLAKE3 摘要精确匹配）
  ipcMain.handle(
    'index:checkFiles',
    async (_e, protocol: IndexProtocol, host: string, port: string, indexName: string, paths: string[]) => {
      const results: Record<string, boolean> = {}
      const CONCURRENCY = 4
      const work = paths.filter(Boolean)
      let cursor = 0
      const worker = async () => {
        while (cursor < work.length) {
          const p = work[cursor++]
          try {
            const content = readFileSync(p, 'utf8')
            if (!content.trim()) {
              // 空内容文件不参与检测，视为未索引
              results[p] = false
              continue
            }
            const digest = await computeBlake3(content)
            const hit = await queryByDigest(protocol, host, port, indexName, digest)
            results[p] = !!hit
          } catch {
            results[p] = false
          }
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, Math.max(work.length, 1)) }, () => worker())
      )
      return { ok: true, message: '', results }
    }
  )

  // 批量查询 S3 文件是否已索引（按 BLAKE3 摘要精确匹配，逐对象下载内容计算）
  ipcMain.handle(
    'index:checkS3Files',
    async (
      _e,
      protocol: IndexProtocol,
      host: string,
      port: string,
      indexName: string,
      config: S3IndexConfig,
      bucket: string,
      keys: string[]
    ) => {
      const results: Record<string, boolean> = {}
      const CONCURRENCY = 4
      const work = keys.filter(Boolean)
      let cursor = 0
      const worker = async () => {
        while (cursor < work.length) {
          const key = work[cursor++]
          try {
            const content = await fetchS3Content(config, bucket, key)
            if (!content.trim()) {
              // 空内容文件不参与检测，视为未索引
              results[key] = false
              continue
            }
            const digest = await computeBlake3(content)
            const hit = await queryByDigest(protocol, host, port, indexName, digest)
            results[key] = !!hit
          } catch {
            results[key] = false
          }
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, Math.max(work.length, 1)) }, () => worker())
      )
      return { ok: true, message: '', results }
    }
  )

  // 查询单条索引文档详情：按文件内容 BLAKE3 摘要精确匹配（path 含特殊字符，
  // 分词后模糊查询不可靠，摘要为单 token 可精确命中）
  ipcMain.handle(
    'index:getDoc',
    async (
      _e,
      protocol: IndexProtocol,
      host: string,
      port: string,
      indexName: string,
      kind: 'local' | 's3',
      path: string,
      config?: S3IndexConfig,
      bucket?: string,
      key?: string
    ) => {
      try {
        let content: string
        if (kind === 's3') {
          if (!config || !bucket || !key) return { ok: false, message: '无效的对象参数', doc: null }
          content = await fetchS3Content(config, bucket, key)
        } else {
          content = readFileSync(path, 'utf8')
        }
        if (!content.trim()) return { ok: false, message: '空文件没有索引条目', doc: null }
        const digest = await computeBlake3(content)
        const hit = await queryByDigest(protocol, host, port, indexName, digest)
        if (!hit) return { ok: false, message: '未找到对应的索引条目', doc: null }
        return { ok: true, message: '', doc: hit }
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : '获取索引详情失败', doc: null }
      }
    }
  )

  // 删除索引中的一条文档（按数字 row_id）
  ipcMain.handle(
    'index:deleteDoc',
    async (
      _e,
      protocol: IndexProtocol,
      host: string,
      port: string,
      indexName: string,
      docId: string,
      fields?: Record<string, string>
    ) => {
      try {
        // 校验 docId 为数字 row_id，避免无效 ID 被服务端静默忽略（unwrap_or(0) 假成功）
        if (!/^\d+$/.test(docId || '')) {
          return { ok: false, message: `无效的文档 ID：${docId || '（空）'}` }
        }
        const client = getClient(protocol, host, port)
        await client.deleteDocument(indexName, docId)
        // 删除后按 BLAKE3 摘要验证真正生效：若该摘要仍命中本条，说明删除未持久化
        const digest = fields?.blake3
        if (digest) {
          const remaining = await client.searchMultiField(indexName, { blake3: digest }, 20)
          if (remaining.some((r) => r.docId === docId && r.fields.blake3 === digest)) {
            return { ok: false, message: '删除未生效：服务端仍存在该条目（doc_id 不匹配？）' }
          }
        }
        return { ok: true, message: '已删除索引文档' }
      } catch (e: any) {
        return { ok: false, message: e.message || '删除索引文档失败' }
      }
    }
  )
}
