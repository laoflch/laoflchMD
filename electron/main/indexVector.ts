import { app, ipcMain } from 'electron'
import { hostname as getHostname } from 'os'
import { join, basename, extname } from 'path'
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { computeBlake3, fetchS3Content, type S3IndexConfig } from './indexSearch'

/**
 * 向量文本索引服务（laoflchdb-rust）客户端。
 * - 仅支持 gRPC：VectorService（生成 embedding）+ EmbeddingIndexService（向量索引存取）
 * - 文档按固定块长分块，每块一条向量，块 ID 由「文件 BLAKE3 摘要 + 块序号」哈希生成（48bit）
 * - 服务端 SearchEmbedding 响应不含 fields，故客户端本地维护 id→fields 映射
 *   （持久化到 userData/laoflchmd.vector.json）
 */

const DEFAULT_USER = 'admin'
const DEFAULT_PASS = 'laoflchdb'
const DEFAULT_VECTOR_DIM = 1024
const DEFAULT_CHUNK_SIZE = 800
const DEFAULT_CHUNK_OVERLAP = 100
const DEFAULT_SEARCH_LIMIT = 20

// ———————— 手写 protobuf wire format 编解码（与 indexSearch.ts 同一套约定） ————————

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

// repeated float PACKED：整块 4 字节小端 float
function pbFloatFieldPacked(fieldNum: number, floats: number[]): Buffer {
  const payload = Buffer.alloc(floats.length * 4)
  floats.forEach((v, i) => payload.writeFloatLE(v, i * 4))
  return pbLenField(fieldNum, payload)
}

function pbDecodeFloatPacked(buf: Buffer): number[] {
  const out: number[] = []
  for (let i = 0; i + 4 <= buf.length; i += 4) out.push(buf.readFloatLE(i))
  return out
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

// ———————— VectorService（/laoflchdb.vector.VectorService/）消息编解码 ————————

interface EmbeddingResult {
  text: string
  embedding: number[]
  dim: number
}

function encodeCreateEmbeddingRequest(msg: { modelName: string; texts: string[]; dim: number }): Buffer {
  const { modelName, texts, dim } = msg
  return Buffer.concat([
    pbStrField(1, modelName),
    ...(texts || []).map((t) => pbStrField(2, t)),
    dim ? pbVarintField(3, dim) : Buffer.alloc(0)
  ])
}

interface CreateEmbeddingResponse {
  success: boolean
  message: string
  results: EmbeddingResult[]
}

function decodeCreateEmbeddingResponse(buf: Buffer): CreateEmbeddingResponse {
  const out: CreateEmbeddingResponse = { success: false, message: '', results: [] }
  for (const f of pbParse(buf)) {
    if (f.fieldNum === 1) out.success = pbAsBool(f.value)
    else if (f.fieldNum === 2) out.message = pbAsStr(f.value)
    else if (f.fieldNum === 3) {
      const r: EmbeddingResult = { text: '', embedding: [], dim: 0 }
      for (const it of pbParse(f.value as Buffer)) {
        if (it.fieldNum === 1) r.text = pbAsStr(it.value)
        else if (it.fieldNum === 2) r.embedding = pbDecodeFloatPacked(it.value as Buffer)
        else if (it.fieldNum === 3) r.dim = Number(it.value)
      }
      out.results.push(r)
    }
  }
  return out
}

// ———————— EmbeddingIndexService（/laoflchdb.embedding.EmbeddingIndexService/）消息编解码 ————————

interface IndexStats {
  numElements: number
  dim: number
  name: string
}

function encodeGetIndexInfoRequest(indexName: string): Buffer {
  return pbStrField(1, indexName)
}

interface GetIndexInfoResponse {
  success: boolean
  message: string
  stats: IndexStats | null
}

function decodeGetIndexInfoResponse(buf: Buffer): GetIndexInfoResponse {
  const out: GetIndexInfoResponse = { success: false, message: '', stats: null }
  for (const f of pbParse(buf)) {
    if (f.fieldNum === 1) out.success = pbAsBool(f.value)
    else if (f.fieldNum === 2) out.message = pbAsStr(f.value)
    else if (f.fieldNum === 3) {
      const s: IndexStats = { numElements: 0, dim: 0, name: '' }
      for (const it of pbParse(f.value as Buffer)) {
        if (it.fieldNum === 1) s.numElements = Number(it.value)
        else if (it.fieldNum === 7) s.dim = Number(it.value)
        else if (it.fieldNum === 10) s.name = pbAsStr(it.value)
      }
      out.stats = s
    }
  }
  return out
}

function encodeInsertEmbeddingRequest(msg: {
  id: number
  indexName: string
  embedding: number[]
  fields: Record<string, string>
}): Buffer {
  const { id, indexName, embedding, fields } = msg
  return Buffer.concat([
    pbVarintField(1, id),
    pbStrField(2, indexName),
    pbFloatFieldPacked(3, embedding),
    ...pbMapEntries(4, fields || {})
  ])
}

function decodeSimpleResponse(buf: Buffer): { success: boolean; message: string } {
  const out = { success: false, message: '' }
  for (const f of pbParse(buf)) {
    if (f.fieldNum === 1) out.success = pbAsBool(f.value)
    else if (f.fieldNum === 2) out.message = pbAsStr(f.value)
  }
  return out
}

function encodeSearchEmbeddingRequest(msg: {
  queryEmbedding: number[]
  topK: number
  indexName: string
  fieldFilters?: Record<string, string>
}): Buffer {
  const { queryEmbedding, topK, indexName, fieldFilters = {} } = msg
  return Buffer.concat([
    pbFloatFieldPacked(1, queryEmbedding),
    pbVarintField(2, topK),
    pbStrField(3, indexName),
    ...pbMapEntries(4, fieldFilters)
  ])
}

interface SearchEmbeddingHit {
  id: number
  distance: number
}

interface SearchEmbeddingResponse {
  success: boolean
  message: string
  results: SearchEmbeddingHit[]
}

function decodeSearchEmbeddingResponse(buf: Buffer): SearchEmbeddingResponse {
  const out: SearchEmbeddingResponse = { success: false, message: '', results: [] }
  for (const f of pbParse(buf)) {
    if (f.fieldNum === 1) out.success = pbAsBool(f.value)
    else if (f.fieldNum === 2) out.message = pbAsStr(f.value)
    else if (f.fieldNum === 3) {
      const hit: SearchEmbeddingHit = { id: 0, distance: 0 }
      for (const it of pbParse(f.value as Buffer)) {
        if (it.fieldNum === 1) hit.id = Number(it.value)
        else if (it.fieldNum === 2) hit.distance = it.value as number
      }
      out.results.push(hit)
    }
  }
  return out
}

function encodeDeleteEmbeddingRequest(id: number, indexName: string): Buffer {
  return Buffer.concat([pbVarintField(1, id), pbStrField(2, indexName)])
}

interface GetEmbeddingByIdResponse {
  success: boolean
  message: string
  exists: boolean
  dim: number
  embedding: number[]
}

function decodeGetEmbeddingByIdResponse(buf: Buffer): GetEmbeddingByIdResponse {
  const out: GetEmbeddingByIdResponse = { success: false, message: '', exists: false, dim: 0, embedding: [] }
  for (const f of pbParse(buf)) {
    if (f.fieldNum === 1) out.success = pbAsBool(f.value)
    else if (f.fieldNum === 2) out.message = pbAsStr(f.value)
    else if (f.fieldNum === 4) out.exists = pbAsBool(f.value)
    else if (f.fieldNum === 5) out.dim = Number(f.value)
    else if (f.fieldNum === 7) out.embedding = pbDecodeFloatPacked(f.value as Buffer)
  }
  return out
}

// ———————— gRPC 客户端（双服务定义，共享 token） ————————

let grpcModule: any = null

function getGrpc(): any {
  if (!grpcModule) grpcModule = require('@grpc/grpc-js')
  return grpcModule
}

function makeServiceDefinition(
  servicePath: string,
  methods: Record<string, { serialize: (m: any) => Buffer; deserialize: (b: Buffer) => any }>
) {
  const def = (methodName: string, serialize: (m: any) => Buffer, deserialize: (b: Buffer) => any) => ({
    // gRPC 服务端（tonic）注册的路径使用 proto 原始大写驼峰方法名（如 CreateEmbedding），
    // 而 grpc-js 客户端方法名是小驼峰（createEmbedding），必须首字母大写才能匹配服务端
    path: `${servicePath}/${methodName[0].toUpperCase()}${methodName.slice(1)}`,
    requestStream: false,
    responseStream: false,
    requestSerialize: (msg: any) => Buffer.from(serialize(msg)),
    requestDeserialize: (buf: Buffer) => buf,
    responseSerialize: (msg: any) => Buffer.from(msg),
    responseDeserialize: (buf: Buffer) => deserialize(Buffer.from(buf))
  })
  const out: Record<string, any> = {}
  for (const [name, m] of Object.entries(methods)) {
    out[name] = def(name, m.serialize, m.deserialize)
  }
  return out
}

// LaoflchDb 登录（向量/向量索引服务本身不校验 token，但带 token 更保险）
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

function makeAuthServiceDefinition() {
  return makeServiceDefinition('/laoflchdb.rpc.LaoflchDb', {
    login: {
      serialize: (m: any) => encodeLoginRequest(m.username, m.password),
      deserialize: decodeLoginResponse
    }
  })
}

function makeVectorServiceDefinition() {
  return makeServiceDefinition('/laoflchdb.vector.VectorService', {
    createEmbedding: {
      serialize: encodeCreateEmbeddingRequest,
      deserialize: decodeCreateEmbeddingResponse
    }
  })
}

function makeEmbeddingServiceDefinition() {
  return makeServiceDefinition('/laoflchdb.embedding.EmbeddingIndexService', {
    getIndexInfo: {
      serialize: (m: any) => encodeGetIndexInfoRequest(m.indexName),
      deserialize: decodeGetIndexInfoResponse
    },
    insertEmbedding: {
      serialize: encodeInsertEmbeddingRequest,
      deserialize: decodeSimpleResponse
    },
    searchEmbedding: {
      serialize: encodeSearchEmbeddingRequest,
      deserialize: decodeSearchEmbeddingResponse
    },
    deleteEmbedding: {
      serialize: (m: any) => encodeDeleteEmbeddingRequest(m.id, m.indexName),
      deserialize: decodeSimpleResponse
    },
    getEmbeddingById: {
      serialize: (m: any) => encodeDeleteEmbeddingRequest(m.id, m.indexName),
      deserialize: decodeGetEmbeddingByIdResponse
    }
  })
}

class VectorGrpcClient {
  private address: string
  private token: string | null = null
  private authClient: any = null
  private vectorClient: any = null
  private embeddingClient: any = null

  constructor(host: string, port: string) {
    this.address = host.replace(/^https?:\/\//i, '') + ':' + port
  }

  private ensureAuthClient(): any {
    if (!this.authClient) {
      const grpc = getGrpc()
      const Client = grpc.makeClientConstructor(makeAuthServiceDefinition(), 'LaoflchDb')
      this.authClient = new Client(this.address, grpc.credentials.createInsecure())
    }
    return this.authClient
  }

  private ensureVectorClient(): any {
    if (!this.vectorClient) {
      const grpc = getGrpc()
      const Client = grpc.makeClientConstructor(makeVectorServiceDefinition(), 'VectorService')
      this.vectorClient = new Client(this.address, grpc.credentials.createInsecure())
    }
    return this.vectorClient
  }

  private ensureEmbeddingClient(): any {
    if (!this.embeddingClient) {
      const grpc = getGrpc()
      const Client = grpc.makeClientConstructor(makeEmbeddingServiceDefinition(), 'EmbeddingIndexService')
      this.embeddingClient = new Client(this.address, grpc.credentials.createInsecure())
    }
    return this.embeddingClient
  }

  private unary(client: any, method: string, req: any): Promise<any> {
    const grpc = getGrpc()
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
    const resp = await this.unary(this.ensureAuthClient(), 'login', {
      username: DEFAULT_USER,
      password: DEFAULT_PASS
    })
    if (!resp.success || !resp.token) throw new Error(resp.message || '登录失败')
    this.token = resp.token
  }

  async withAuth<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (e: any) {
      const msg = e?.details || (e instanceof Error ? e.message : '')
      const authFailed =
        e?.code === 16 ||
        /unauthor|未提供有效的认证|authentication required|invalid or missing token/i.test(msg)
      if (authFailed) {
        try {
          await this.login()
        } catch {
          // 登录失败不阻塞：部分向量服务可能无需认证，直接重试
        }
        return await fn()
      }
      throw e
    }
  }

  async createEmbedding(modelName: string, texts: string[], dim: number): Promise<EmbeddingResult[]> {
    return this.withAuth(async () => {
      const resp = await this.unary(this.ensureVectorClient(), 'createEmbedding', { modelName, texts, dim })
      if (!resp.success) throw new Error(resp.message || '生成向量失败')
      return resp.results
    })
  }

  async getIndexInfo(indexName: string): Promise<IndexStats | null> {
    return this.withAuth(async () => {
      const resp = await this.unary(this.ensureEmbeddingClient(), 'getIndexInfo', { indexName })
      if (!resp.success) throw new Error(resp.message || '获取向量索引信息失败')
      return resp.stats
    })
  }

  async insertEmbedding(
    id: number,
    indexName: string,
    embedding: number[],
    fields: Record<string, string>
  ): Promise<void> {
    await this.withAuth(async () => {
      const resp = await this.unary(this.ensureEmbeddingClient(), 'insertEmbedding', {
        id,
        indexName,
        embedding,
        fields
      })
      if (!resp.success) throw new Error(resp.message || '写入向量失败')
    })
  }

  async searchEmbedding(queryEmbedding: number[], indexName: string, topK: number): Promise<SearchEmbeddingHit[]> {
    return this.withAuth(async () => {
      const resp = await this.unary(this.ensureEmbeddingClient(), 'searchEmbedding', {
        queryEmbedding,
        topK,
        indexName
      })
      if (!resp.success) throw new Error(resp.message || '向量搜索失败')
      return resp.results
    })
  }

  async deleteEmbedding(id: number, indexName: string): Promise<void> {
    await this.withAuth(async () => {
      const resp = await this.unary(this.ensureEmbeddingClient(), 'deleteEmbedding', { id, indexName })
      if (!resp.success) throw new Error(resp.message || '删除向量失败')
    })
  }

  async getEmbeddingById(id: number, indexName: string): Promise<GetEmbeddingByIdResponse> {
    return this.withAuth(async () => {
      const resp = await this.unary(this.ensureEmbeddingClient(), 'getEmbeddingById', { id, indexName })
      if (!resp.success) throw new Error(resp.message || '查询向量失败')
      return resp
    })
  }
}

const vectorClientCache = new Map<string, VectorGrpcClient>()

function getVectorClient(host: string, port: string): VectorGrpcClient {
  const key = `${host}|${port}`
  let client = vectorClientCache.get(key)
  if (!client) {
    client = new VectorGrpcClient(host, port)
    vectorClientCache.set(key, client)
  }
  return client
}

// ———————— 本地 id→fields 映射（服务端搜索结果不含 fields） ————————

interface VectorEntry {
  title: string
  path: string
  kind: 'local' | 's3'
  host: string
  server: string
  bucket: string
  key: string
  blake3: string
  chunkIndex: number
  totalChunks: number
  snippet: string
}

interface VectorMapping {
  version: number
  files: Record<string, { blake3: string; ids: number[] }>
  entries: Record<string, VectorEntry>
}

let mapping: VectorMapping | null = null

function mappingPath(): string {
  return join(app.getPath('userData'), 'laoflchmd.vector.json')
}

function getMapping(): VectorMapping {
  if (!mapping) {
    try {
      const raw = readFileSync(mappingPath(), 'utf8')
      const parsed = JSON.parse(raw) as VectorMapping
      if (parsed && typeof parsed === 'object' && parsed.files && parsed.entries) {
        mapping = parsed
      } else {
        mapping = { version: 1, files: {}, entries: {} }
      }
    } catch {
      mapping = { version: 1, files: {}, entries: {} }
    }
  }
  return mapping
}

function saveMapping(): void {
  try {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(mappingPath(), JSON.stringify(getMapping()), 'utf8')
  } catch {
    // 映射写入失败不阻塞主流程
  }
}

function fileKeyOf(
  kind: 'local' | 's3',
  path: string,
  config?: S3IndexConfig,
  bucket?: string,
  key?: string
): string {
  if (kind === 's3') {
    const server = (config?.endpoint || 's3.amazonaws.com').replace(/^https?:\/\//i, '').replace(/\/+$/, '')
    return `s3:${server}/${bucket || ''}/${key || ''}`
  }
  return `local:${path}`
}

// ———————— 分块与块 ID ————————

function splitChunks(text: string, chunkSize: number, overlap: number): string[] {
  const clean = text.replace(/\r\n/g, '\n')
  if (clean.length <= chunkSize) {
    const t = clean.trim()
    return t ? [t] : []
  }
  const chunks: string[] = []
  let pos = 0
  while (pos < clean.length) {
    let end = Math.min(pos + chunkSize, clean.length)
    if (end < clean.length) {
      // 优先在换行处断块，避免切断段落
      const nl = clean.lastIndexOf('\n', end)
      if (nl > pos + chunkSize * 0.5) end = nl
    }
    const chunk = clean.slice(pos, end).trim()
    if (chunk) chunks.push(chunk)
    if (end >= clean.length) break
    pos = Math.max(end - overlap, pos + 1)
  }
  return chunks
}

let hashWasmModule: any = null

function getHashWasm(): any {
  if (!hashWasmModule) hashWasmModule = require('hash-wasm')
  return hashWasmModule
}

/** 块 ID：文件摘要 + 块序号的哈希前 48bit，落在安全整数范围 */
async function chunkId(blake3Hex: string, chunkIndex: number): Promise<number> {
  const { blake3 } = getHashWasm()
  const hex = await blake3(blake3Hex + ':' + chunkIndex)
  return parseInt(hex.slice(0, 12), 16)
}

// ———————— 建索引 / 搜索 / 删除 ————————

async function createEmbeddingsBatched(
  client: VectorGrpcClient,
  modelName: string,
  texts: string[],
  dim: number
): Promise<number[][]> {
  const results: number[][] = []
  const BATCH = 50
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH)
    const resp = await client.createEmbedding(modelName, batch, dim)
    if (resp.length !== batch.length) {
      throw new Error(`向量服务返回 ${resp.length} 条，期望 ${batch.length} 条`)
    }
    for (const r of resp) results.push(r.embedding)
  }
  return results
}

async function deleteVectorFile(client: VectorGrpcClient, indexName: string, fileKey: string): Promise<void> {
  const m = getMapping()
  const rec = m.files[fileKey]
  if (!rec) return
  for (const id of rec.ids) {
    try {
      await client.deleteEmbedding(id, indexName)
    } catch {
      // 单条删除失败不阻塞整体
    }
  }
  delete m.files[fileKey]
  for (const id of rec.ids) delete m.entries[String(id)]
  saveMapping()
}

async function deleteVectorId(client: VectorGrpcClient, indexName: string, id: number): Promise<void> {
  const m = getMapping()
  try {
    await client.deleteEmbedding(id, indexName)
  } catch {
    // 服务端删除失败时仍清理本地映射，避免脏条目
  }
  delete m.entries[String(id)]
  for (const fk of Object.keys(m.files)) {
    const rec = m.files[fk]
    if (rec.ids.includes(id)) {
      rec.ids = rec.ids.filter((x) => x !== id)
      if (!rec.ids.length) delete m.files[fk]
    }
  }
  saveMapping()
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

interface IndexVectorOutcome {
  ok: boolean
  message: string
  count: number
}

function entryBaseOf(
  kind: 'local' | 's3',
  title: string,
  path: string,
  blake3: string,
  server: string,
  bucket: string,
  key: string
) {
  return {
    title,
    path,
    kind,
    host: kind === 'local' ? getHostname() : server,
    server,
    bucket,
    key,
    blake3
  }
}

async function indexVectorLocalFile(
  host: string,
  port: string,
  indexName: string,
  modelName: string,
  filePath: string,
  chunkSize: number,
  overlap: number
): Promise<IndexVectorOutcome> {
  try {
    const content = readFileSync(filePath, 'utf8')
    if (!content.trim()) {
      return { ok: true, message: `跳过空文件：${basename(filePath)}`, count: 0 }
    }
    const digest = await computeBlake3(content)
    const chunks = splitChunks(content, chunkSize, overlap)
    if (!chunks.length) {
      return { ok: true, message: `跳过空文件：${basename(filePath)}`, count: 0 }
    }
    const client = getVectorClient(host, port)
    const embeddings = await createEmbeddingsBatched(client, modelName, chunks, DEFAULT_VECTOR_DIM)

    const fileKey = fileKeyOf('local', filePath)
    await deleteVectorFile(client, indexName, fileKey)

    const title = basename(filePath, extname(filePath)) || basename(filePath)
    const ids: number[] = []
    for (let i = 0; i < chunks.length; i++) {
      const id = await chunkId(digest, i)
      ids.push(id)
      await client.insertEmbedding(id, indexName, embeddings[i], {
        title,
        path: filePath,
        kind: 'local',
        host: getHostname(),
        server: '',
        bucket: '',
        key: '',
        blake3: digest,
        chunk_index: String(i),
        total_chunks: String(chunks.length),
        snippet: chunks[i].slice(0, 300)
      })
    }

    const m = getMapping()
    m.files[fileKey] = { blake3: digest, ids }
    const base = entryBaseOf('local', title, filePath, digest, '', '', '')
    for (let i = 0; i < chunks.length; i++) {
      m.entries[String(ids[i])] = {
        ...base,
        chunkIndex: i,
        totalChunks: chunks.length,
        snippet: chunks[i].slice(0, 300)
      }
    }
    saveMapping()
    return { ok: true, message: `已生成向量索引：${basename(filePath)}（${chunks.length} 块）`, count: chunks.length }
  } catch (e: any) {
    return { ok: false, message: `向量索引 ${basename(filePath)} 失败：${e.message || e}`, count: 0 }
  }
}

async function indexVectorDir(
  host: string,
  port: string,
  indexName: string,
  modelName: string,
  dirPath: string,
  chunkSize: number,
  overlap: number,
  onProgress?: (done: number, total: number, fileName: string) => void
): Promise<{ ok: boolean; message: string; count: number }> {
  const files = collectMarkdownFiles(dirPath)
  let okCount = 0
  let firstErr: string | null = null
  for (let i = 0; i < files.length; i++) {
    const filePath = files[i]
    onProgress?.(i + 1, files.length, basename(filePath))
    const res = await indexVectorLocalFile(host, port, indexName, modelName, filePath, chunkSize, overlap)
    if (res.ok) okCount++
    else if (!firstErr) firstErr = res.message
  }
  if (firstErr) {
    return { ok: false, message: `完成 ${okCount}/${files.length}，出错：${firstErr}`, count: okCount }
  }
  return { ok: true, message: `已为 ${okCount} 个 Markdown 文件生成向量索引`, count: okCount }
}

async function indexVectorS3File(
  host: string,
  port: string,
  indexName: string,
  modelName: string,
  config: S3IndexConfig,
  bucket: string,
  key: string,
  chunkSize: number,
  overlap: number
): Promise<IndexVectorOutcome> {
  try {
    const content = await fetchS3Content(config, bucket, key)
    if (!content.trim()) {
      return { ok: true, message: `跳过空文件：${basename(key)}`, count: 0 }
    }
    const digest = await computeBlake3(content)
    const chunks = splitChunks(content, chunkSize, overlap)
    if (!chunks.length) {
      return { ok: true, message: `跳过空文件：${basename(key)}`, count: 0 }
    }
    const client = getVectorClient(host, port)
    const embeddings = await createEmbeddingsBatched(client, modelName, chunks, DEFAULT_VECTOR_DIM)

    const server = (config.endpoint || 's3.amazonaws.com').replace(/\/+$/, '')
    const fileKey = fileKeyOf('s3', key, config, bucket, key)
    await deleteVectorFile(client, indexName, fileKey)

    const title = basename(key, extname(key)) || basename(key)
    const ids: number[] = []
    for (let i = 0; i < chunks.length; i++) {
      const id = await chunkId(digest, i)
      ids.push(id)
      await client.insertEmbedding(id, indexName, embeddings[i], {
        title,
        path: key,
        kind: 's3',
        host: server,
        server,
        bucket,
        key,
        blake3: digest,
        chunk_index: String(i),
        total_chunks: String(chunks.length),
        snippet: chunks[i].slice(0, 300)
      })
    }

    const m = getMapping()
    m.files[fileKey] = { blake3: digest, ids }
    const base = entryBaseOf('s3', title, key, digest, server, bucket, key)
    for (let i = 0; i < chunks.length; i++) {
      m.entries[String(ids[i])] = {
        ...base,
        chunkIndex: i,
        totalChunks: chunks.length,
        snippet: chunks[i].slice(0, 300)
      }
    }
    saveMapping()
    return { ok: true, message: `已生成向量索引：${basename(key)}（${chunks.length} 块）`, count: chunks.length }
  } catch (e: any) {
    return { ok: false, message: `向量索引 ${basename(key)} 失败：${e.message || e}`, count: 0 }
  }
}

export interface VectorSearchResult {
  docId: string
  score: number
  fields: Record<string, string>
}

async function searchVector(
  host: string,
  port: string,
  indexName: string,
  modelName: string,
  query: string,
  topK: number
): Promise<{ ok: boolean; message: string; results: VectorSearchResult[] }> {
  try {
    const client = getVectorClient(host, port)
    const qEmb = await client.createEmbedding(modelName, [query], DEFAULT_VECTOR_DIM)
    if (!qEmb.length) throw new Error('查询向量生成失败')
    const hits = await client.searchEmbedding(qEmb[0].embedding, indexName, topK)
    const m = getMapping()
    const results: VectorSearchResult[] = hits.map((h) => {
      const entry = m.entries[String(h.id)]
      return {
        docId: String(h.id),
        // Cosine 距离 → 相似度：1 - distance（clip 下限 0）
        score: Math.max(0, 1 - h.distance),
        fields: entry
          ? {
              title: entry.title,
              path: entry.path,
              kind: entry.kind,
              host: entry.host,
              server: entry.server,
              bucket: entry.bucket,
              key: entry.key,
              blake3: entry.blake3,
              chunk_index: String(entry.chunkIndex),
              total_chunks: String(entry.totalChunks),
              snippet: entry.snippet
            }
          : {}
      }
    })
    return { ok: true, message: '', results }
  } catch (e: any) {
    return { ok: false, message: e.message || '向量搜索失败', results: [] }
  }
}

async function getVectorIndexInfo(
  host: string,
  port: string,
  indexName: string
): Promise<{ ok: boolean; message: string; stats: IndexStats | null }> {
  try {
    const client = getVectorClient(host, port)
    const stats = await client.getIndexInfo(indexName)
    return { ok: true, message: '', stats }
  } catch (e: any) {
    return { ok: false, message: e.message || '获取向量索引信息失败', stats: null }
  }
}

// ———————— IPC Handlers ————————

export function registerVectorIndexHandlers(): void {
  ipcMain.handle('vector:getInfo', async (_e, host: string, port: string, indexName: string) => {
    return getVectorIndexInfo(host, port, indexName)
  })

  ipcMain.handle(
    'vector:indexLocal',
    async (
      _e,
      host: string,
      port: string,
      indexName: string,
      modelName: string,
      filePath: string,
      chunkSize?: number,
      overlap?: number
    ) => {
      return indexVectorLocalFile(
        host,
        port,
        indexName,
        modelName,
        filePath,
        chunkSize || DEFAULT_CHUNK_SIZE,
        overlap === undefined ? DEFAULT_CHUNK_OVERLAP : overlap
      )
    }
  )

  ipcMain.handle(
    'vector:indexDir',
    async (
      e,
      host: string,
      port: string,
      indexName: string,
      modelName: string,
      dirPath: string,
      chunkSize?: number,
      overlap?: number
    ) => {
      return indexVectorDir(
        host,
        port,
        indexName,
        modelName,
        dirPath,
        chunkSize || DEFAULT_CHUNK_SIZE,
        overlap === undefined ? DEFAULT_CHUNK_OVERLAP : overlap,
        (done, total, fileName) => {
          e.sender.send('vector:progress', { done, total, fileName })
        }
      )
    }
  )

  ipcMain.handle(
    'vector:indexS3',
    async (
      _e,
      host: string,
      port: string,
      indexName: string,
      modelName: string,
      config: S3IndexConfig,
      bucket: string,
      key: string,
      chunkSize?: number,
      overlap?: number
    ) => {
      return indexVectorS3File(
        host,
        port,
        indexName,
        modelName,
        config,
        bucket,
        key,
        chunkSize || DEFAULT_CHUNK_SIZE,
        overlap === undefined ? DEFAULT_CHUNK_OVERLAP : overlap
      )
    }
  )

  ipcMain.handle(
    'vector:search',
    async (
      _e,
      host: string,
      port: string,
      indexName: string,
      modelName: string,
      query: string,
      topK?: number
    ) => {
      return searchVector(host, port, indexName, modelName, query, topK || DEFAULT_SEARCH_LIMIT)
    }
  )

  ipcMain.handle(
    'vector:deleteFile',
    async (
      _e,
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
        const client = getVectorClient(host, port)
        const fileKey = fileKeyOf(kind, path, config, bucket, key)
        await deleteVectorFile(client, indexName, fileKey)
        return { ok: true, message: '已删除该文件的向量索引' }
      } catch (e: any) {
        return { ok: false, message: e.message || '删除向量索引失败' }
      }
    }
  )

  ipcMain.handle(
    'vector:deleteId',
    async (_e, host: string, port: string, indexName: string, id: string | number) => {
      try {
        const num = Number(id)
        if (!/^\d+$/.test(String(num))) {
          return { ok: false, message: `无效的向量 ID：${id}` }
        }
        const client = getVectorClient(host, port)
        await deleteVectorId(client, indexName, num)
        return { ok: true, message: '已删除该向量条目' }
      } catch (e: any) {
        return { ok: false, message: e.message || '删除向量条目失败' }
      }
    }
  )

  // 本地映射查询：文件是否已生成向量索引（向量索引的 fields 在本地，无需访问服务端）
  ipcMain.handle('vector:checkFiles', async (_e, paths: string[]) => {
    const m = getMapping()
    const results: Record<string, boolean> = {}
    for (const p of paths.filter(Boolean)) {
      results[p] = !!m.files[`local:${p}`]
    }
    return { ok: true, message: '', results }
  })

  ipcMain.handle(
    'vector:checkS3Files',
    async (_e, config: S3IndexConfig, bucket: string, keys: string[]) => {
      const m = getMapping()
      const results: Record<string, boolean> = {}
      for (const key of keys.filter(Boolean)) {
        results[key] = !!m.files[fileKeyOf('s3', key, config, bucket, key)]
      }
      return { ok: true, message: '', results }
    }
  )
}
