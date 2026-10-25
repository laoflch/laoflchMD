/**
 * Raft KV 客户端：保存每个文件的索引状态。
 * key 为 "INDEX" + \0 + 文件内容的 BLAKE3 摘要，value 为 JSON：
 *   { has_fulltext: '1'|'0', has_vector: '1'|'0', doc_id: 全文索引文档 ID,
 *     row_id: 全文索引行 ID, chunk_ids: 向量 ID 数组 }
 * 全文索引（md_docs）不再保存摘要、索引状态与 chunk 片段，状态唯一真源在这里。
 */

export type RaftProtocol = 'grpc' | 'rest'

export interface RaftConfig {
  protocol: RaftProtocol
  host: string
  port: string
  group: string
}

export interface RaftIndexMeta {
  /** 是否已生成全文索引：1/0 */
  has_fulltext: string
  /** 是否已生成向量索引：1/0 */
  has_vector: string
  /** 全文索引文档 ID（本机主机名+路径 / S3 地址+bucket+key），未生成时为空串 */
  doc_id: string
  /** 全文索引行 ID（服务端行号，删除时使用），未生成时为空串 */
  row_id: string
  /** 该文件所有 chunk 的向量索引 ID（按 chunk 顺序） */
  chunk_ids: number[]
}

/** Raft key 前缀：区分本应用的索引状态条目与其他业务数据 */
const KEY_PREFIX = 'INDEX\0'

function metaKey(blake3: string): string {
  return KEY_PREFIX + blake3
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
    offset = r.offset
    const fieldNum = Number(r.value >> 3n)
    const wireType = Number(r.value & 7n)
    if (wireType === 0) {
      const vr = pbReadVarint(buf, offset)
      fields.push({ fieldNum, wireType, value: vr.value })
      offset = vr.offset
    } else if (wireType === 2) {
      const lr = pbReadVarint(buf, offset)
      const len = Number(lr.value)
      offset = lr.offset
      fields.push({ fieldNum, wireType, value: buf.subarray(offset, offset + len) })
      offset += len
    } else if (wireType === 5) {
      fields.push({ fieldNum, wireType, value: buf.readFloatLE(offset) })
      offset += 4
    } else if (wireType === 1) {
      fields.push({ fieldNum, wireType, value: buf.readBigUInt64LE(offset) })
      offset += 8
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

// ———————— 编解码 ————————

function encodePutRequest(key: string, value: string, groupId: string): Buffer {
  return Buffer.concat([pbStrField(1, key), pbStrField(2, value), pbStrField(3, groupId)])
}

function encodeKeyRequest(key: string, groupId: string): Buffer {
  return Buffer.concat([pbStrField(1, key), pbStrField(2, groupId)])
}

function encodeScanRequest(groupId: string): Buffer {
  return pbStrField(1, groupId)
}

function decodeResult(buf: Buffer): { ok: boolean; message: string } {
  const out = { ok: false, message: '' }
  for (const f of pbParse(buf)) {
    if (f.fieldNum === 1) out.ok = pbAsBool(f.value)
    else if (f.fieldNum === 2) out.message = pbAsStr(f.value)
  }
  return out
}

function decodeGetResponse(buf: Buffer): { found: boolean; value: string } {
  const out = { found: false, value: '' }
  for (const f of pbParse(buf)) {
    if (f.fieldNum === 1) out.found = pbAsBool(f.value)
    else if (f.fieldNum === 2) out.value = pbAsStr(f.value)
  }
  return out
}

function decodeScanResponse(buf: Buffer): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = []
  for (const f of pbParse(buf)) {
    if (f.fieldNum !== 1) continue
    let key = ''
    let value = ''
    for (const it of pbParse(f.value as Buffer)) {
      if (it.fieldNum === 1) key = pbAsStr(it.value)
      else if (it.fieldNum === 2) value = pbAsStr(it.value)
    }
    out.push({ key, value })
  }
  return out
}

// ———————— gRPC 客户端（按地址缓存） ————————

let grpcModule: any = null

function getGrpc(): any {
  if (!grpcModule) grpcModule = require('@grpc/grpc-js')
  return grpcModule
}

let cachedClient: any = null
let cachedAddress = ''

function getGrpcClient(cfg: RaftConfig): any {
  const address = cfg.host.trim().replace(/^https?:\/\//i, '') + ':' + cfg.port.trim()
  if (cachedClient && cachedAddress === address) return cachedClient
  const grpc = getGrpc()
  const unary = (
    method: string,
    serialize: (m: any) => Buffer,
    deserialize: (b: Buffer) => any
  ) => ({
    path: `/laoflchdb.raft.RaftKvService/${method}`,
    requestStream: false,
    responseStream: false,
    requestSerialize: (m: any) => Buffer.from(serialize(m)),
    requestDeserialize: (buf: Buffer) => buf,
    responseSerialize: (m: any) => Buffer.from(m),
    responseDeserialize: (buf: Buffer) => deserialize(Buffer.from(buf))
  })
  const Client = grpc.makeClientConstructor(
    {
      put: unary(
        'Put',
        (m: any) => encodePutRequest(m.key, m.value, m.groupId),
        decodeResult
      ),
      get: unary(
        'Get',
        (m: any) => encodeKeyRequest(m.key, m.groupId),
        decodeGetResponse
      ),
      delete: unary(
        'Delete',
        (m: any) => encodeKeyRequest(m.key, m.groupId),
        decodeResult
      ),
      scan: unary(
        'Scan',
        (m: any) => encodeScanRequest(m.groupId),
        decodeScanResponse
      )
    },
    'RaftKvService'
  )
  cachedClient = new Client(address, grpc.credentials.createInsecure())
  cachedAddress = address
  return cachedClient
}

function unaryCall(cfg: RaftConfig, method: string, req: Record<string, any>): Promise<any> {
  const grpc = getGrpc()
  const client = getGrpcClient(cfg)
  return new Promise((resolve, reject) => {
    client[method](req, new grpc.Metadata(), (err: any, res: any) =>
      err ? reject(err) : resolve(res)
    )
  })
}

function restBase(cfg: RaftConfig): string {
  let base = cfg.host.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) base = 'http://' + base
  return `${base}:${cfg.port.trim()}/api/v1/raft`
}

// ———————— 对外接口 ————————

/** 读取文件的索引状态；不存在或读取失败返回 null */
export async function raftGetMeta(cfg: RaftConfig, blake3: string): Promise<RaftIndexMeta | null> {
  if (!blake3 || !cfg.host.trim() || !cfg.port.trim() || !cfg.group.trim()) return null
  try {
    let raw: string | null = null
    if (cfg.protocol === 'grpc') {
      const res = await unaryCall(cfg, 'get', { key: metaKey(blake3), groupId: cfg.group.trim() })
      raw = res?.found && res.value ? res.value : null
    } else {
      const url = `${restBase(cfg)}/kv?group_id=${encodeURIComponent(cfg.group.trim())}&key=${encodeURIComponent(metaKey(blake3))}`
      const resp = await fetch(url)
      const json: any = await resp.json().catch(() => null)
      if (json?.success !== true || json.data == null) return null
      raw = String(json.data)
    }
    if (!raw) return null
    const obj = JSON.parse(raw)
    return {
      has_fulltext: obj?.has_fulltext === '1' ? '1' : '0',
      has_vector: obj?.has_vector === '1' ? '1' : '0',
      doc_id: typeof obj?.doc_id === 'string' ? obj.doc_id : String(obj?.doc_id ?? ''),
      row_id: typeof obj?.row_id === 'string' ? obj.row_id : String(obj?.row_id ?? ''),
      chunk_ids: Array.isArray(obj?.chunk_ids) ? obj.chunk_ids.map(Number).filter(Number.isFinite) : []
    }
  } catch {
    return null
  }
}

/** 写入文件的索引状态，失败返回 false */
export async function raftPutMeta(
  cfg: RaftConfig,
  blake3: string,
  meta: RaftIndexMeta
): Promise<boolean> {
  if (!blake3 || !cfg.host.trim() || !cfg.port.trim() || !cfg.group.trim()) return false
  const value = JSON.stringify({
    has_fulltext: meta.has_fulltext === '1' ? '1' : '0',
    has_vector: meta.has_vector === '1' ? '1' : '0',
    doc_id: meta.doc_id || '',
    row_id: meta.row_id || '',
    chunk_ids: meta.chunk_ids || []
  })
  try {
    if (cfg.protocol === 'grpc') {
      const res = await unaryCall(cfg, 'put', {
        key: metaKey(blake3),
        value,
        groupId: cfg.group.trim()
      })
      return !!res?.ok
    }
    const resp = await fetch(`${restBase(cfg)}/kv`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        group_id: cfg.group.trim(),
        key: metaKey(blake3),
        value
      })
    })
    const json: any = await resp.json().catch(() => null)
    return json?.success === true && json?.data !== false
  } catch {
    return false
  }
}

/** 删除文件的索引状态，失败返回 false */
export async function raftDeleteMeta(cfg: RaftConfig, blake3: string): Promise<boolean> {
  if (!blake3 || !cfg.host.trim() || !cfg.port.trim() || !cfg.group.trim()) return false
  try {
    if (cfg.protocol === 'grpc') {
      const res = await unaryCall(cfg, 'delete', {
        key: metaKey(blake3),
        groupId: cfg.group.trim()
      })
      return !!res?.ok
    }
    const url = `${restBase(cfg)}/kv?group_id=${encodeURIComponent(cfg.group.trim())}&key=${encodeURIComponent(metaKey(blake3))}`
    const resp = await fetch(url, { method: 'DELETE' })
    const json: any = await resp.json().catch(() => null)
    return json?.success === true && json?.data !== false
  } catch {
    return false
  }
}

/** 扫描组内全部索引状态（key 为 blake3），读取失败返回空数组 */
export async function raftScanMetas(
  cfg: RaftConfig
): Promise<Array<{ blake3: string; meta: RaftIndexMeta }>> {
  if (!cfg.host.trim() || !cfg.port.trim() || !cfg.group.trim()) return []
  try {
    let entries: Array<{ key: string; value: string }> = []
    if (cfg.protocol === 'grpc') {
      entries = await unaryCall(cfg, 'scan', { groupId: cfg.group.trim() })
    } else {
      const url = `${restBase(cfg)}/kv/scan?group_id=${encodeURIComponent(cfg.group.trim())}`
      const resp = await fetch(url)
      const json: any = await resp.json().catch(() => null)
      if (json?.success !== true || !Array.isArray(json.data)) return []
      entries = json.data
    }
    const out: Array<{ blake3: string; meta: RaftIndexMeta }> = []
    for (const e of entries) {
      // 仅处理本应用写入的条目（key 带 "INDEX\0" 前缀）
      if (!e.key.startsWith(KEY_PREFIX)) continue
      try {
        const obj = JSON.parse(e.value)
        out.push({
          blake3: e.key.slice(KEY_PREFIX.length),
          meta: {
            has_fulltext: obj?.has_fulltext === '1' ? '1' : '0',
            has_vector: obj?.has_vector === '1' ? '1' : '0',
            doc_id: typeof obj?.doc_id === 'string' ? obj.doc_id : String(obj?.doc_id ?? ''),
            row_id: typeof obj?.row_id === 'string' ? obj.row_id : String(obj?.row_id ?? ''),
            chunk_ids: Array.isArray(obj?.chunk_ids)
              ? obj.chunk_ids.map(Number).filter(Number.isFinite)
              : []
          }
        })
      } catch {
        // 忽略非本应用写入的条目
      }
    }
    return out
  } catch {
    return []
  }
}
