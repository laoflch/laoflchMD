import { ipcMain } from 'electron'
import { hostname as getHostname } from 'os'
import { join, basename, extname } from 'path'
import { readFileSync, readdirSync, statSync } from 'fs'
import {
  computeBlake3,
  fetchS3Content,
  getClient,
  indexLocalFile,
  indexS3File,
  localDocId,
  s3DocId,
  type S3IndexConfig
} from './indexSearch'
import {
  raftDeleteMeta,
  raftGetMeta,
  raftPutMeta,
  raftScanMetas,
  type RaftConfig
} from './raftKv'

/**
 * 向量文本索引服务（laoflchdb-rust）客户端。
 * - 仅支持 gRPC：VectorService（生成 embedding）+ EmbeddingIndexService（向量索引存取）
 * - 文档按固定块长分块，每块一条向量，块 ID 由「文件 BLAKE3 摘要 + 块序号」哈希生成（48bit）
 * - 服务端 SearchEmbedding 响应不含 fields，文件是否已索引及 chunk 向量 ID 统一保存在
 *   Raft KV（key 为文件内容 blake3），向量搜索时扫描反查，不保存 chunk 片段内容
 */

const DEFAULT_USER = 'admin'
const DEFAULT_PASS = 'laoflchdb'
const DEFAULT_VECTOR_DIM = 1024
const DEFAULT_CHUNK_SIZE = 800
const DEFAULT_CHUNK_OVERLAP = 100
const DEFAULT_SEARCH_LIMIT = 20

/** 全文索引文档 ID（本机主机名+路径 / S3 地址+key）解析出展示用信息 */
function parseDocId(docId: string): {
  title: string
  path: string
  kind: 'local' | 's3'
  host: string
  server: string
  bucket: string
  key: string
} {
  const hostname = getHostname()
  if (docId.startsWith(hostname)) {
    const p = docId.slice(hostname.length)
    return {
      title: basename(p, extname(p)) || basename(p),
      path: p,
      kind: 'local',
      host: hostname,
      server: '',
      bucket: '',
      key: ''
    }
  }
  const m = docId.match(/^https?:\/\/([^/]+)\/([^/]+)\/(.+)$/)
  if (m) {
    return {
      title: basename(m[3], extname(m[3])) || basename(m[3]),
      path: m[3],
      kind: 's3',
      host: m[1],
      server: m[1],
      bucket: m[2],
      key: m[3]
    }
  }
  return { title: docId, path: docId, kind: 'local', host: '', server: '', bucket: '', key: '' }
}

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

/** 删除该文件已有的全部 chunk 向量（chunk id 记录在 Raft 状态中） */
async function deleteChunksOfDigest(
  raft: RaftConfig,
  client: VectorGrpcClient,
  indexName: string,
  digest: string
): Promise<void> {
  const meta = await raftGetMeta(raft, digest)
  if (!meta) return
  for (const id of meta.chunk_ids) {
    try {
      await client.deleteEmbedding(id, indexName)
    } catch {
      // 单条删除失败不阻塞整体
    }
  }
}

async function deleteVectorFile(
  raft: RaftConfig,
  client: VectorGrpcClient,
  indexName: string,
  kind: 'local' | 's3',
  path: string,
  config?: S3IndexConfig,
  bucket?: string,
  key?: string
): Promise<void> {
  const content =
    kind === 's3' ? await fetchS3Content(config!, bucket!, key!) : readFileSync(path, 'utf8')
  const digest = await computeBlake3(content)
  const meta = await raftGetMeta(raft, digest)
  if (!meta) return
  for (const id of meta.chunk_ids) {
    try {
      await client.deleteEmbedding(id, indexName)
    } catch {
      // 单条删除失败不阻塞整体
    }
  }
  // 仍有全文索引时保留状态记录，仅清除向量标识；否则删除整条状态
  if (meta.has_fulltext === '1') {
    await raftPutMeta(raft, digest, {
      has_fulltext: '1',
      has_vector: '0',
      doc_id: meta.doc_id,
      row_id: meta.row_id,
      chunk_ids: []
    })
  } else {
    await raftDeleteMeta(raft, digest)
  }
}

async function deleteVectorId(
  raft: RaftConfig,
  client: VectorGrpcClient,
  indexName: string,
  id: number
): Promise<void> {
  await client.deleteEmbedding(id, indexName)
  // 扫描 Raft 状态定位该 chunk 所属文件，移除对应 ID
  const entries = await raftScanMetas(raft)
  for (const e of entries) {
    const idx = e.meta.chunk_ids.findIndex((cid) => cid === id)
    if (idx < 0) continue
    const rest = e.meta.chunk_ids.filter((cid) => cid !== id)
    if (!rest.length && e.meta.has_fulltext !== '1') {
      await raftDeleteMeta(raft, e.blake3)
    } else {
      await raftPutMeta(raft, e.blake3, {
        has_fulltext: e.meta.has_fulltext,
        has_vector: rest.length ? '1' : '0',
        doc_id: e.meta.doc_id,
        row_id: e.meta.row_id,
        chunk_ids: rest
      })
    }
    break
  }
}

/** 保存后刷新索引：全文索引与向量索引的服务参数（regenerate 为 false 时仅清理旧索引） */
export interface RefreshFulltextCfg {
  protocol: 'grpc' | 'rest'
  host: string
  port: string
  indexName: string
  regenerate: boolean
}

export interface RefreshVectorCfg {
  host: string
  port: string
  indexName: string
  modelName: string
  chunkSize?: number
  overlap?: number
  regenerate: boolean
}

/**
 * 文件保存后刷新索引：
 * 1. 按规范 doc_id（本机主机名+路径 / S3 地址+bucket+key）找出该文件的所有旧索引状态
 * 2. 删除旧全文索引文档与旧 chunk 向量，并清除旧摘要对应的 Raft 记录
 * 3. 按旧状态中的 has_fulltext / has_vector 标识重新生成索引（子开关关闭时只清理不重建）
 */
async function refreshAfterSave(
  raft: RaftConfig,
  kind: 'local' | 's3',
  filePath: string,
  config: S3IndexConfig | undefined,
  bucket: string | undefined,
  key: string | undefined,
  fulltext: RefreshFulltextCfg | null,
  vector: RefreshVectorCfg | null,
  force = false
): Promise<{ ok: boolean; message: string }> {
  try {
    const content =
      kind === 's3' ? await fetchS3Content(config!, bucket!, key!) : readFileSync(filePath, 'utf8')
    if (!content.trim()) return { ok: true, message: '' }
    const digest = await computeBlake3(content)
    const docId = kind === 's3' ? s3DocId(config!, bucket!, key!) : localDocId(filePath)
    const current = await raftGetMeta(raft, digest)
    const currentRowId = current && current.doc_id === docId ? current.row_id : ''
    const ftClient = fulltext ? getClient(fulltext.protocol, fulltext.host, fulltext.port) : null
    const vecClient = vector ? getVectorClient(vector.host, vector.port) : null

    // 全文索引中该文件的历史条目：新旧 schema 都有 doc_id 字段，可据此定位旧行
    // （旧版 v3 条目还带 blake3 / has_vector / chunks 字段）
    let mdHits: Array<{
      rowId: string
      blake3: string
      hasVector: boolean
      chunkIds: number[]
    }> = []
    if (ftClient && fulltext) {
      try {
        const res = await ftClient.searchMultiField(fulltext.indexName, { doc_id: docId }, 100)
        mdHits = res
          .filter((r) => r.fields?.doc_id === docId)
          .map((r) => {
            let chunkIds: number[] = []
            if (r.fields?.chunks) {
              try {
                const arr = JSON.parse(r.fields.chunks)
                if (Array.isArray(arr)) {
                  chunkIds = arr
                    .map((c: any) => Number(c?.id))
                    .filter((id: any) => Number.isFinite(id))
                }
              } catch {
                // 忽略损坏的 chunks 字段
              }
            }
            return {
              rowId: r.docId,
              blake3: r.fields?.blake3 || '',
              hasVector: r.fields?.has_vector === '1',
              chunkIds
            }
          })
      } catch {
        // 索引表不存在或查询失败时忽略
      }
    }
    const legacyDigests = new Set(mdHits.map((h) => h.blake3).filter(Boolean))

    // Raft 中的旧状态：新格式按 doc_id 匹配，旧格式（无 doc_id）按全文索引条目中的 blake3 匹配
    const entries = await raftScanMetas(raft)
    const staleRaft = entries.filter(
      (e) => e.blake3 !== digest && (e.meta.doc_id === docId || legacyDigests.has(e.blake3))
    )
    // 需要删除的旧全文索引行（排除当前内容对应的行）
    const staleRows = mdHits.filter((h) => h.rowId !== currentRowId).map((h) => h.rowId)
    // 当前摘要的状态记录若缺少行 ID / chunk ID，同样需要重建修复
    const brokenFulltext = !!current && current.has_fulltext === '1' && !/^\d+$/.test(current.row_id)
    const brokenVector = !!current && current.has_vector === '1' && !current.chunk_ids.length
    // 该文件是否已建立过索引（存在状态记录 / 旧索引行 / 旧摘要记录）
    const hasAnyIndex =
      (!!current && (current.has_fulltext === '1' || current.has_vector === '1' || !!current.row_id)) ||
      staleRaft.length > 0 ||
      staleRows.length > 0 ||
      mdHits.length > 0
    if (force) {
      // 强制重新索引：只有已经建立过索引的文件才重建，原本没有索引的直接跳过
      if (!hasAnyIndex) return { ok: true, message: '' }
    } else if (!staleRaft.length && !staleRows.length && !brokenFulltext && !brokenVector) {
      return { ok: true, message: '' }
    }

    const wantFulltext = force
      ? (!!current && current.has_fulltext === '1') ||
        staleRows.length > 0 ||
        mdHits.length > 0 ||
        staleRaft.some((e) => e.meta.has_fulltext === '1')
      : staleRows.length > 0 ||
        brokenFulltext ||
        staleRaft.some((e) => e.meta.has_fulltext === '1')
    const staleChunks = new Set<number>()
    for (const e of staleRaft) for (const id of e.meta.chunk_ids) staleChunks.add(id)
    for (const h of mdHits) if (h.rowId !== currentRowId) for (const id of h.chunkIds) staleChunks.add(id)
    const wantVector = force
      ? (!!current && current.has_vector === '1') ||
        staleChunks.size > 0 ||
        mdHits.some((h) => h.hasVector) ||
        staleRaft.some((e) => e.meta.has_vector === '1')
      : staleChunks.size > 0 || brokenVector || staleRaft.some((e) => e.meta.has_vector === '1')

    // 删除旧全文索引行
    for (const rowId of Array.from(new Set(staleRows))) {
      if (!ftClient || !fulltext || !/^\d+$/.test(rowId)) continue
      try {
        await ftClient.deleteDocument(fulltext.indexName, rowId)
      } catch {
        // 旧全文索引删除失败不阻塞新索引生成
      }
    }
    // 删除旧向量 chunk
    if (vecClient && vector) {
      for (const id of Array.from(staleChunks)) {
        try {
          await vecClient.deleteEmbedding(id, vector.indexName)
        } catch {
          // 单条向量删除失败不阻塞整体
        }
      }
    }
    // 清除旧摘要对应的 Raft 记录
    for (const e of staleRaft) await raftDeleteMeta(raft, e.blake3)

    const generated: string[] = []
    if (wantFulltext && fulltext?.regenerate) {
      const res =
        kind === 's3'
          ? await indexS3File(
              fulltext.protocol,
              fulltext.host,
              fulltext.port,
              fulltext.indexName,
              config!,
              bucket!,
              key!,
              raft
            )
          : await indexLocalFile(
              fulltext.protocol,
              fulltext.host,
              fulltext.port,
              fulltext.indexName,
              filePath,
              raft
            )
      if (!res.ok) return { ok: false, message: `重建全文索引失败：${res.message}` }
      generated.push('全文')
    }
    if (wantVector && vector?.regenerate) {
      const res =
        kind === 's3'
          ? await indexVectorS3File(
              raft,
              vector.host,
              vector.port,
              vector.indexName,
              vector.modelName,
              config!,
              bucket!,
              key!,
              vector.chunkSize || DEFAULT_CHUNK_SIZE,
              vector.overlap === undefined ? DEFAULT_CHUNK_OVERLAP : vector.overlap
            )
          : await indexVectorLocalFile(
              raft,
              vector.host,
              vector.port,
              vector.indexName,
              vector.modelName,
              filePath,
              vector.chunkSize || DEFAULT_CHUNK_SIZE,
              vector.overlap === undefined ? DEFAULT_CHUNK_OVERLAP : vector.overlap
            )
      if (!res.ok) return { ok: false, message: `重建向量索引失败：${res.message}` }
      generated.push('向量')
    }
    return {
      ok: true,
      message: generated.length ? `已重建${generated.join('、')}索引` : '已清理旧索引'
    }
  } catch (e: any) {
    return { ok: false, message: e.message || '刷新索引失败' }
  }
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

/** 向量索引生成后：把 chunk 向量 ID 与向量标识写入 Raft 状态（保留已有全文索引信息） */
async function syncEntryAfterVector(
  raft: RaftConfig,
  digest: string,
  docId: string,
  chunkIds: number[]
): Promise<void> {
  const old = await raftGetMeta(raft, digest)
  await raftPutMeta(raft, digest, {
    has_fulltext: old?.has_fulltext === '1' ? '1' : '0',
    has_vector: chunkIds.length ? '1' : '0',
    // 全文索引文档 ID 与行号仅在已生成全文索引时有效
    doc_id: old?.doc_id || docId,
    row_id: old?.has_fulltext === '1' ? old.row_id : '',
    chunk_ids: chunkIds
  })
}

async function indexVectorLocalFile(
  raft: RaftConfig,
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
    // 重新生成前删除该文件已有的向量数据（chunk id 记录在 Raft 状态中）
    await deleteChunksOfDigest(raft, client, indexName, digest)
    const embeddings = await createEmbeddingsBatched(client, modelName, chunks, DEFAULT_VECTOR_DIM)

    const title = basename(filePath, extname(filePath)) || basename(filePath)
    const chunkIds: number[] = []
    for (let i = 0; i < chunks.length; i++) {
      const id = await chunkId(digest, i)
      chunkIds.push(id)
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

    // 把 chunk 向量 ID 与向量标识写入 Raft 状态
    await syncEntryAfterVector(raft, digest, localDocId(filePath), chunkIds)
    return { ok: true, message: `已生成向量索引：${basename(filePath)}（${chunks.length} 块）`, count: chunks.length }
  } catch (e: any) {
    return { ok: false, message: `向量索引 ${basename(filePath)} 失败：${e.message || e}`, count: 0 }
  }
}

async function indexVectorDir(
  raft: RaftConfig,
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
    const res = await indexVectorLocalFile(raft, host, port, indexName, modelName, filePath, chunkSize, overlap)
    if (res.ok) okCount++
    else if (!firstErr) firstErr = res.message
  }
  if (firstErr) {
    return { ok: false, message: `完成 ${okCount}/${files.length}，出错：${firstErr}`, count: okCount }
  }
  return { ok: true, message: `已为 ${okCount} 个 Markdown 文件生成向量索引`, count: okCount }
}

async function indexVectorS3File(
  raft: RaftConfig,
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
    // 重新生成前删除该文件已有的向量数据（内容未变时摘要一致，可定位旧 chunk）
    await deleteChunksOfDigest(raft, client, indexName, digest)
    const embeddings = await createEmbeddingsBatched(client, modelName, chunks, DEFAULT_VECTOR_DIM)

    const server = (config.endpoint || 's3.amazonaws.com').replace(/\/+$/, '')
    const title = basename(key, extname(key)) || basename(key)
    const chunkIds: number[] = []
    for (let i = 0; i < chunks.length; i++) {
      const id = await chunkId(digest, i)
      chunkIds.push(id)
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

    // 把 chunk 向量 ID 与向量标识写入 Raft 状态
    await syncEntryAfterVector(raft, digest, s3DocId(config, bucket, key), chunkIds)
    return { ok: true, message: `已生成向量索引：${basename(key)}（${chunks.length} 块）`, count: chunks.length }
  } catch (e: any) {
    return { ok: false, message: `向量索引 ${basename(key)} 失败：${e.message || e}`, count: 0 }
  }
}

export interface VectorSearchResult {
  docId: string
  score: number
  distance: number
  fields: Record<string, string>
}

async function searchVector(
  raft: RaftConfig,
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
    // 向量服务搜索结果不含 fields：扫描 Raft 状态，按 chunk 向量 ID 反查所属文件
    const entries = await raftScanMetas(raft)
    const chunkMap = new Map<
      number,
      { blake3: string; docId: string; idx: number; total: number }
    >()
    for (const e of entries) {
      const ids = e.meta.chunk_ids || []
      ids.forEach((cid, idx) => {
        chunkMap.set(cid, { blake3: e.blake3, docId: e.meta.doc_id, idx, total: ids.length })
      })
    }
    const results: VectorSearchResult[] = hits.map((h) => {
      const rec = chunkMap.get(h.id)
      const info = rec ? parseDocId(rec.docId) : null
      let fields: Record<string, string> = {}
      if (rec && info) {
        fields = {
          title: info.title,
          path: info.path,
          kind: info.kind,
          host: info.host,
          server: info.server,
          bucket: info.bucket,
          key: info.key,
          doc_id: rec.docId,
          blake3: rec.blake3,
          chunk_index: String(rec.idx),
          total_chunks: String(rec.total),
          // chunk 片段内容不再保存，仅保留文件信息
          snippet: ''
        }
      }
      return {
        docId: String(h.id),
        // Cosine 距离 → 相似度：1 - distance（clip 下限 0）
        score: Math.max(0, 1 - h.distance),
        distance: h.distance,
        fields
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
      raft: RaftConfig,
      host: string,
      port: string,
      indexName: string,
      modelName: string,
      filePath: string,
      chunkSize?: number,
      overlap?: number
    ) => {
      return indexVectorLocalFile(
        raft,
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
      raft: RaftConfig,
      host: string,
      port: string,
      indexName: string,
      modelName: string,
      dirPath: string,
      chunkSize?: number,
      overlap?: number
    ) => {
      return indexVectorDir(
        raft,
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
      raft: RaftConfig,
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
        raft,
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
      raft: RaftConfig,
      host: string,
      port: string,
      indexName: string,
      modelName: string,
      query: string,
      topK?: number
    ) => {
      return searchVector(raft, host, port, indexName, modelName, query, topK || DEFAULT_SEARCH_LIMIT)
    }
  )

  ipcMain.handle(
    'vector:deleteFile',
    async (
      _e,
      raft: RaftConfig,
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
        await deleteVectorFile(raft, client, indexName, kind, path, config, bucket, key)
        return { ok: true, message: '已删除该文件的向量索引' }
      } catch (e: any) {
        return { ok: false, message: e.message || '删除向量索引失败' }
      }
    }
  )

  ipcMain.handle(
    'vector:deleteId',
    async (
      _e,
      raft: RaftConfig,
      host: string,
      port: string,
      indexName: string,
      id: string | number
    ) => {
      try {
        const num = Number(id)
        if (!/^\d+$/.test(String(num))) {
          return { ok: false, message: `无效的向量 ID：${id}` }
        }
        const client = getVectorClient(host, port)
        await deleteVectorId(raft, client, indexName, num)
        return { ok: true, message: '已删除该向量条目' }
      } catch (e: any) {
        return { ok: false, message: e.message || '删除向量条目失败' }
      }
    }
  )

  // 文件保存后：删除旧全文/向量索引与 Raft 状态，再按旧标识重新生成
  ipcMain.handle(
    'index:refreshAfterSave',
    async (
      _e,
      raft: RaftConfig,
      kind: 'local' | 's3',
      filePath: string,
      config: S3IndexConfig | undefined,
      bucket: string | undefined,
      key: string | undefined,
      fulltext: RefreshFulltextCfg | null,
      vector: RefreshVectorCfg | null,
      force?: boolean
    ) => {
      return refreshAfterSave(raft, kind, filePath, config, bucket, key, fulltext, vector, !!force)
    }
  )
}
