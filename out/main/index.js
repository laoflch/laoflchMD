"use strict";
const electron = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
let s3Module = null;
function getS3Module() {
  if (!s3Module) {
    s3Module = require("@aws-sdk/client-s3");
  }
  return s3Module;
}
function createClient(config) {
  const { S3Client } = getS3Module();
  let endpoint = config.endpoint || void 0;
  if (endpoint && !endpoint.startsWith("http")) {
    endpoint = "http://" + endpoint;
  }
  console.log("S3 client config:", { endpoint, region: config.region, accessKeyId: config.accessKeyId });
  return new S3Client({
    endpoint,
    region: config.region || "us-east-1",
    // 使用路径式寻址，兼容 MinIO 等自建 S3 兼容存储
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  });
}
function isMarkdownKey(key) {
  return /\.(md|markdown|mdown)$/i.test(key);
}
function safeDecodeKey(key) {
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}
function registerS3Handlers() {
  electron.ipcMain.handle("s3:listBuckets", async (_event, config) => {
    try {
      const { ListBucketsCommand } = getS3Module();
      const client = createClient(config);
      const res = await client.send(new ListBucketsCommand({}));
      return (res.Buckets || []).filter((b) => b.Name).map((b) => ({
        name: b.Name,
        creationDate: b.CreationDate ? b.CreationDate.toISOString() : null
      }));
    } catch (e) {
      console.error("s3:listBuckets error:", e);
      const errMsg = e.message || e.toString && e.toString() || "未知错误";
      throw new Error(errMsg);
    }
  });
  electron.ipcMain.handle(
    "s3:listObjects",
    async (_event, config, bucket, prefix) => {
      try {
        const { ListObjectsV2Command } = getS3Module();
        const client = createClient(config);
        const res = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            Delimiter: "/"
          })
        );
        const folders = (res.CommonPrefixes || []).map((cp) => safeDecodeKey(cp.Prefix || "")).filter(Boolean);
        const files = (res.Contents || []).filter((o) => o.Key && o.Key !== prefix).filter((o) => isMarkdownKey(o.Key)).map((o) => {
          const key = safeDecodeKey(o.Key);
          return {
            key,
            name: key.split("/").pop() || "",
            size: o.Size || 0,
            lastModified: o.LastModified ? o.LastModified.toISOString() : null,
            eTag: o.ETag,
            isMarkdown: true
          };
        });
        return { folders, files };
      } catch (e) {
        console.error("s3:listObjects error:", e);
        const errMsg = e.message || e.toString && e.toString() || "未知错误";
        throw new Error(errMsg);
      }
    }
  );
  electron.ipcMain.handle(
    "s3:getObject",
    async (_event, config, bucket, key) => {
      try {
        const { GetObjectCommand } = getS3Module();
        const client = createClient(config);
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const content = await res.Body?.transformToString("utf-8");
        return content ?? null;
      } catch (e) {
        console.error("s3:getObject error:", e);
        const errMsg = e.message || e.toString && e.toString() || "未知错误";
        throw new Error(errMsg);
      }
    }
  );
  electron.ipcMain.handle(
    "s3:putObject",
    async (_event, config, bucket, key, content) => {
      try {
        const { PutObjectCommand } = getS3Module();
        const client = createClient(config);
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: content }));
        return { key };
      } catch (e) {
        console.error("s3:putObject error:", e);
        const errMsg = e.message || e.toString && e.toString() || "未知错误";
        throw new Error(errMsg);
      }
    }
  );
  electron.ipcMain.handle(
    "s3:deleteObject",
    async (_event, config, bucket, key) => {
      try {
        const { DeleteObjectCommand } = getS3Module();
        const client = createClient(config);
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch (e) {
        console.error("s3:deleteObject error:", e);
        const errMsg = e.message || e.toString && e.toString() || "未知错误";
        throw new Error(errMsg);
      }
    }
  );
}
const DEFAULT_USER$1 = "admin";
const DEFAULT_PASS$1 = "laoflchdb";
const DEFAULT_SEARCH_LIMIT$1 = 20;
const INDEX_SCHEMA_VERSION = 3;
function buildFields(f) {
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
    blake3: f.blake3,
    has_fulltext: f.hasFulltext ?? "0",
    has_vector: f.hasVector ?? "0",
    chunks: f.chunks ?? "[]"
  };
}
function pbVarint$1(value) {
  const bytes = [];
  let v = value;
  while (v >= 128) {
    bytes.push(v & 127 | 128);
    v = Math.floor(v / 128);
  }
  bytes.push(v);
  return Buffer.from(bytes);
}
function pbTag$1(fieldNum, wireType) {
  return pbVarint$1(fieldNum << 3 | wireType);
}
function pbLenField$1(fieldNum, payload) {
  return Buffer.concat([pbTag$1(fieldNum, 2), pbVarint$1(payload.length), payload]);
}
function pbStrField$1(fieldNum, s) {
  return pbLenField$1(fieldNum, Buffer.from(s, "utf8"));
}
function pbVarintField$1(fieldNum, value) {
  return Buffer.concat([pbTag$1(fieldNum, 0), pbVarint$1(value)]);
}
function pbMapEntries$1(fieldNum, obj) {
  return Object.entries(obj).map(([k, v]) => {
    const inner = Buffer.concat([pbStrField$1(1, k), pbStrField$1(2, v)]);
    return pbLenField$1(fieldNum, inner);
  });
}
function pbReadVarint$1(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length) {
    const byte = buf[i];
    result |= BigInt(byte & 127) << shift;
    if ((byte & 128) === 0) return { value: result, offset: i + 1 };
    shift += 7n;
    i++;
  }
  throw new Error("protobuf: invalid varint");
}
function pbParse$1(buf) {
  const fields = [];
  let offset = 0;
  while (offset < buf.length) {
    const r = pbReadVarint$1(buf, offset);
    const tagVal = r.value;
    offset = r.offset;
    const fieldNum = Number(tagVal >> 3n);
    const wireType = Number(tagVal & 7n);
    if (wireType === 0) {
      const vr = pbReadVarint$1(buf, offset);
      fields.push({ fieldNum, wireType, value: vr.value });
      offset = vr.offset;
    } else if (wireType === 1) {
      fields.push({ fieldNum, wireType, value: buf.readBigUInt64LE(offset) });
      offset += 8;
    } else if (wireType === 2) {
      const lr = pbReadVarint$1(buf, offset);
      const len = Number(lr.value);
      offset = lr.offset;
      fields.push({ fieldNum, wireType, value: buf.subarray(offset, offset + len) });
      offset += len;
    } else if (wireType === 5) {
      fields.push({ fieldNum, wireType, value: buf.readFloatLE(offset) });
      offset += 4;
    } else {
      throw new Error("protobuf: unsupported wire type " + wireType);
    }
  }
  return fields;
}
function pbAsStr$1(v) {
  return v.toString("utf8");
}
function pbAsBool$1(v) {
  return v !== 0n;
}
function pbDecodeMap(buf) {
  const out = {};
  let key = null;
  for (const f of pbParse$1(buf)) {
    if (f.fieldNum === 1) key = pbAsStr$1(f.value);
    else if (f.fieldNum === 2 && key) {
      out[key] = pbAsStr$1(f.value);
      key = null;
    }
  }
  return out;
}
function encodeLoginRequest$1(username, password) {
  return Buffer.concat([pbStrField$1(1, username), pbStrField$1(2, password)]);
}
function decodeLoginResponse$1(buf) {
  const out = { success: false, message: "", token: "" };
  for (const f of pbParse$1(buf)) {
    if (f.fieldNum === 1) out.success = pbAsBool$1(f.value);
    else if (f.fieldNum === 2) out.message = pbAsStr$1(f.value);
    else if (f.fieldNum === 3) out.token = pbAsStr$1(f.value);
  }
  return out;
}
function decodeListIndicesResponse(buf) {
  const out = { success: false, indexNames: [], message: "" };
  for (const f of pbParse$1(buf)) {
    if (f.fieldNum === 1) out.success = pbAsBool$1(f.value);
    else if (f.fieldNum === 2) out.indexNames.push(pbAsStr$1(f.value));
    else if (f.fieldNum === 3) out.message = pbAsStr$1(f.value);
  }
  return out;
}
function encodeCreateIndexRequest(msg) {
  const { indexName, fields } = msg;
  const fieldParts = (fields || []).map((f) => {
    const inner = Buffer.concat([
      pbStrField$1(1, f.name),
      pbVarintField$1(2, f.fieldType),
      f.comment ? pbStrField$1(3, f.comment) : Buffer.alloc(0)
    ]);
    return pbLenField$1(2, inner);
  });
  return Buffer.concat([pbStrField$1(1, indexName), ...fieldParts]);
}
function decodeCreateIndexResponse(buf) {
  const out = { success: false, indexId: 0, message: "" };
  for (const f of pbParse$1(buf)) {
    if (f.fieldNum === 1) out.success = pbAsBool$1(f.value);
    else if (f.fieldNum === 2) out.indexId = Number(f.value);
    else if (f.fieldNum === 3) out.message = pbAsStr$1(f.value);
  }
  return out;
}
function encodeDropIndexRequest(indexName) {
  return pbStrField$1(1, indexName);
}
function decodeDropIndexResponse(buf) {
  const out = { success: false, message: "" };
  for (const f of pbParse$1(buf)) {
    if (f.fieldNum === 1) out.success = pbAsBool$1(f.value);
    else if (f.fieldNum === 2) out.message = pbAsStr$1(f.value);
  }
  return out;
}
function encodeGetIndexFieldsRequest(indexName) {
  return pbStrField$1(1, indexName);
}
function decodeGetIndexFieldsResponse(buf) {
  const out = { success: false, fieldNames: [], message: "" };
  for (const f of pbParse$1(buf)) {
    if (f.fieldNum === 1) out.success = pbAsBool$1(f.value);
    else if (f.fieldNum === 2) {
      for (const it of pbParse$1(f.value)) {
        if (it.fieldNum === 3) out.fieldNames.push(pbAsStr$1(it.value));
      }
    } else if (f.fieldNum === 3) out.message = pbAsStr$1(f.value);
  }
  return out;
}
function encodeDeleteDocumentRequest(indexName, docId) {
  return Buffer.concat([pbStrField$1(1, indexName), pbStrField$1(2, docId)]);
}
function decodeDeleteDocumentResponse(buf) {
  const out = { success: false, message: "" };
  for (const f of pbParse$1(buf)) {
    if (f.fieldNum === 1) out.success = pbAsBool$1(f.value);
    else if (f.fieldNum === 2) out.message = pbAsStr$1(f.value);
  }
  return out;
}
function encodeAddDocumentRequest(msg) {
  const { indexName, docId, fields } = msg;
  return Buffer.concat([
    pbStrField$1(1, indexName),
    docId ? pbStrField$1(2, docId) : Buffer.alloc(0),
    ...pbMapEntries$1(3, fields || {})
  ]);
}
function decodeAddDocumentResponse(buf) {
  const out = { success: false, docId: "", message: "" };
  for (const f of pbParse$1(buf)) {
    if (f.fieldNum === 1) out.success = pbAsBool$1(f.value);
    else if (f.fieldNum === 2) out.docId = pbAsStr$1(f.value);
    else if (f.fieldNum === 3) out.message = pbAsStr$1(f.value);
  }
  return out;
}
function encodeSearchIndexRequest(msg) {
  const { indexName, query = "", limit = DEFAULT_SEARCH_LIMIT$1, fieldQueries = {} } = msg;
  return Buffer.concat([
    pbStrField$1(1, indexName),
    pbStrField$1(2, query || ""),
    pbVarintField$1(3, limit),
    ...pbMapEntries$1(4, fieldQueries)
  ]);
}
function decodeSearchIndexResponse(buf) {
  const out = { success: false, results: [], message: "" };
  for (const f of pbParse$1(buf)) {
    if (f.fieldNum === 1) out.success = pbAsBool$1(f.value);
    else if (f.fieldNum === 2) {
      const item = { docId: "", score: 0, fields: {} };
      for (const it of pbParse$1(f.value)) {
        if (it.fieldNum === 1) item.docId = pbAsStr$1(it.value);
        else if (it.fieldNum === 2) item.score = it.value;
        else if (it.fieldNum === 3) Object.assign(item.fields, pbDecodeMap(it.value));
      }
      out.results.push(item);
    } else if (f.fieldNum === 3) out.message = pbAsStr$1(f.value);
  }
  return out;
}
let grpcModule$1 = null;
function getGrpc$1() {
  if (!grpcModule$1) {
    grpcModule$1 = require("@grpc/grpc-js");
  }
  return grpcModule$1;
}
function makeGrpcServiceDefinition() {
  const def = (methodName, serialize, deserialize) => ({
    path: `/laoflchdb.rpc.LaoflchDb/${methodName}`,
    requestStream: false,
    responseStream: false,
    requestSerialize: (msg) => Buffer.from(serialize(msg)),
    requestDeserialize: (buf) => buf,
    responseSerialize: (msg) => Buffer.from(msg),
    responseDeserialize: (buf) => deserialize(Buffer.from(buf))
  });
  return {
    login: def("Login", (m) => encodeLoginRequest$1(m.username, m.password), decodeLoginResponse$1),
    createIndex: def("CreateIndex", encodeCreateIndexRequest, decodeCreateIndexResponse),
    dropIndex: def("DropIndex", (m) => encodeDropIndexRequest(m.indexName), decodeDropIndexResponse),
    listIndices: def("ListIndices", () => Buffer.alloc(0), decodeListIndicesResponse),
    getIndexFields: def("GetIndexFields", (m) => encodeGetIndexFieldsRequest(m.indexName), decodeGetIndexFieldsResponse),
    addDocument: def("AddDocument", encodeAddDocumentRequest, decodeAddDocumentResponse),
    deleteDocument: def("DeleteDocument", (m) => encodeDeleteDocumentRequest(m.indexName, m.docId), decodeDeleteDocumentResponse),
    searchIndex: def("SearchIndex", encodeSearchIndexRequest, decodeSearchIndexResponse)
  };
}
class GrpcClient {
  constructor(host, port) {
    this.token = null;
    this.client = null;
    this.address = host.replace(/^https?:\/\//i, "") + ":" + port;
  }
  ensureClient() {
    if (!this.client) {
      const grpc = getGrpc$1();
      const Client = grpc.makeClientConstructor(makeGrpcServiceDefinition(), "LaoflchDb");
      this.client = new Client(this.address, grpc.credentials.createInsecure());
    }
    return this.client;
  }
  unary(method, req) {
    const grpc = getGrpc$1();
    const client = this.ensureClient();
    return new Promise((resolve, reject) => {
      const md = new grpc.Metadata();
      if (this.token) md.set("authorization", "Bearer " + this.token);
      client[method](req, md, (err, res) => {
        if (err) reject(err);
        else resolve(res);
      });
    });
  }
  async login() {
    const resp = await this.unary("login", { username: DEFAULT_USER$1, password: DEFAULT_PASS$1 });
    if (!resp.success || !resp.token) throw new Error(resp.message || "登录失败");
    this.token = resp.token;
  }
  async withAuth(fn) {
    try {
      return await fn();
    } catch (e) {
      const msg = e?.details || (e instanceof Error ? e.message : "");
      const authFailed = e?.code === 16 || /unauthor|未提供有效的认证|authentication required|invalid or missing token/i.test(msg);
      if (authFailed) {
        await this.login();
        return await fn();
      }
      throw e;
    }
  }
  async listIndices() {
    return this.withAuth(async () => {
      const resp = await this.unary("listIndices", {});
      if (!resp.success) throw new Error(resp.message || "列出索引失败");
      return resp.indexNames;
    });
  }
  async createIndex(indexName, fields) {
    await this.withAuth(async () => {
      const resp = await this.unary("createIndex", { indexName, fields });
      if (!resp.success) throw new Error(resp.message || "创建索引失败");
    });
  }
  async dropIndex(indexName) {
    await this.withAuth(async () => {
      const resp = await this.unary("dropIndex", { indexName });
      if (!resp.success) throw new Error(resp.message || "删除索引失败");
    });
  }
  async getIndexFields(indexName) {
    return this.withAuth(async () => {
      const resp = await this.unary("getIndexFields", { indexName });
      if (!resp.success) throw new Error(resp.message || "获取索引字段失败");
      return resp.fieldNames;
    });
  }
  async addDocument(indexName, docId, fields) {
    return this.withAuth(async () => {
      const resp = await this.unary("addDocument", { indexName, docId, fields });
      if (!resp.success) throw new Error(resp.message || "添加文档失败");
      return resp.docId;
    });
  }
  async deleteDocument(indexName, docId) {
    await this.withAuth(async () => {
      const resp = await this.unary("deleteDocument", { indexName, docId });
      if (!resp.success) throw new Error(resp.message || "删除文档失败");
    });
  }
  async search(indexName, query, limit) {
    return this.withAuth(async () => {
      const resp = await this.unary("searchIndex", { indexName, query, limit });
      if (!resp.success) throw new Error(resp.message || "搜索失败");
      return resp.results;
    });
  }
  async searchMultiField(indexName, fieldQueries, limit) {
    return this.withAuth(async () => {
      const resp = await this.unary("searchIndex", { indexName, fieldQueries, limit });
      if (!resp.success) throw new Error(resp.message || "搜索失败");
      return resp.results;
    });
  }
}
class RestClient {
  constructor(host, port) {
    this.token = null;
    let h = host.trim();
    if (h && !/^https?:\/\//i.test(h)) h = "http://" + h;
    this.base = `${h}:${port}`;
  }
  async request(path2, opts = {}) {
    const headers = { "Content-Type": "application/json" };
    if (this.token) headers["Authorization"] = "Bearer " + this.token;
    let res;
    try {
      res = await fetch(this.base + path2, {
        method: opts.method || "GET",
        headers,
        body: opts.body ? JSON.stringify(opts.body) : void 0
      });
    } catch (e) {
      throw new Error(`连接服务失败: ${e.message || e}`);
    }
    let json;
    try {
      json = await res.json();
    } catch {
      throw new Error(`服务响应异常 (HTTP ${res.status})`);
    }
    if (json.success !== true) {
      throw new Error(json.message || `请求失败 (HTTP ${res.status})`);
    }
    return json.data;
  }
  async login() {
    const data = await this.request("/api/v1/login", {
      method: "POST",
      body: { username: DEFAULT_USER$1, password: DEFAULT_PASS$1 }
    });
    if (!data || !data.token) throw new Error("登录失败：未获取到 token");
    this.token = data.token;
  }
  async withAuth(fn) {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/unauthor|token|登录/i.test(msg)) {
        await this.login();
        return await fn();
      }
      throw e;
    }
  }
  async listIndices() {
    return this.withAuth(async () => {
      const data = await this.request("/api/v1/index/indices");
      return data?.indices || [];
    });
  }
  async createIndex(indexName, fields) {
    await this.withAuth(async () => {
      await this.request("/api/v1/index/indices", {
        method: "POST",
        body: {
          index_name: indexName,
          fields: fields.map((f) => ({
            name: f.name,
            field_type: "STRING",
            comment: f.comment || void 0
          }))
        }
      });
    });
  }
  async dropIndex(indexName) {
    await this.withAuth(async () => {
      await this.request(`/api/v1/index/indices/${indexName}`, { method: "DELETE" });
    });
  }
  async getIndexFields(indexName) {
    return this.withAuth(async () => {
      const data = await this.request(
        `/api/v1/index/indices/${indexName}/fields`
      );
      return (data || []).map((f) => f.column_name || f.name || "");
    });
  }
  async addDocument(indexName, docId, fields) {
    return this.withAuth(async () => {
      const data = await this.request(`/api/v1/index/indices/${indexName}/docs`, {
        method: "POST",
        body: {
          doc_id: docId || null,
          fields
        }
      });
      return data?.doc_id || docId || "";
    });
  }
  async deleteDocument(indexName, docId) {
    await this.withAuth(async () => {
      await this.request(`/api/v1/index/indices/${indexName}/docs/${docId}/delete`, { method: "DELETE" });
    });
  }
  async search(indexName, query, limit) {
    return this.withAuth(async () => {
      const data = await this.request(
        `/api/v1/index/indices/${indexName}/search?q=${encodeURIComponent(query)}&limit=${limit}`
      );
      return (data?.results || []).map(mapRestSearchResult);
    });
  }
  async searchMultiField(indexName, fieldQueries, limit) {
    return this.withAuth(async () => {
      const data = await this.request(
        `/api/v1/index/indices/${indexName}/search/multi`,
        {
          method: "POST",
          body: { field_queries: fieldQueries, limit }
        }
      );
      return (data?.results || []).map(mapRestSearchResult);
    });
  }
}
function mapRestSearchResult(r) {
  return {
    docId: typeof r?.doc_id === "string" ? r.doc_id : "",
    score: typeof r?.score === "number" ? r.score : 0,
    fields: r?.fields && typeof r.fields === "object" ? { ...r.fields } : {}
  };
}
const clientCache = /* @__PURE__ */ new Map();
function getClient(protocol, host, port) {
  const key = `${protocol}|${host}|${port}`;
  let client = clientCache.get(key);
  if (!client) {
    client = protocol === "grpc" ? new GrpcClient(host, port) : new RestClient(host, port);
    clientCache.set(key, client);
  }
  return client;
}
function localDocId(filePath) {
  return os.hostname() + filePath;
}
function s3DocId(config, bucket, key) {
  let endpoint = (config.endpoint || "s3.amazonaws.com").replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(endpoint)) endpoint = "http://" + endpoint;
  return `${endpoint}/${bucket}/${key}`;
}
async function ensureIndex(protocol, host, port, indexName, allowRebuild) {
  try {
    const client = getClient(protocol, host, port);
    const indices = await client.listIndices();
    if (indices.includes(indexName)) {
      let names = null;
      try {
        names = await client.getIndexFields(indexName);
      } catch {
        names = null;
      }
      if (names === null) {
        return {
          ok: false,
          message: `索引 ${indexName} 字段信息读取失败，未做任何变更（请检查服务状态后重试）`,
          created: false
        };
      }
      const hasAll = INDEX_FIELDS.every((f) => names.includes(f.name));
      if (hasAll) {
        return { ok: true, message: `索引 ${indexName} 已存在`, created: false };
      }
      if (!allowRebuild) {
        return {
          ok: false,
          message: `索引 ${indexName} 字段结构已变更（v${INDEX_SCHEMA_VERSION}），需要在全局设置中开启「索引结构变更时重建」后才能清空重建`,
          created: false
        };
      }
      await client.dropIndex(indexName);
      await client.createIndex(indexName, INDEX_FIELDS);
      return { ok: true, message: `索引 ${indexName} schema 已升级（v${INDEX_SCHEMA_VERSION}）并重建`, created: true };
    }
    await client.createIndex(indexName, INDEX_FIELDS);
    return { ok: true, message: `已创建索引 ${indexName}（v${INDEX_SCHEMA_VERSION}）`, created: true };
  } catch (e) {
    return { ok: false, message: e.message || "检查索引失败", created: false };
  }
}
const INDEX_FIELDS = [
  { name: "doc_id", fieldType: 0, comment: "自定义文档 ID（主机名+绝对路径 / 服务器地址+保存绝对地址）" },
  { name: "title", fieldType: 0, comment: "标题（文件名）" },
  { name: "content", fieldType: 0, comment: "正文全文" },
  { name: "path", fieldType: 0, comment: "本地绝对路径 / S3 key" },
  { name: "kind", fieldType: 0, comment: "来源类型：local / s3" },
  { name: "host", fieldType: 0, comment: "主机名 / S3 服务器地址" },
  { name: "server", fieldType: 0, comment: "S3 服务器地址（本地为空）" },
  { name: "bucket", fieldType: 0, comment: "S3 桶（本地为空）" },
  { name: "key", fieldType: 0, comment: "S3 key（本地为空）" },
  { name: "updated_at", fieldType: 0, comment: "修改时间（ISO）" },
  { name: "blake3", fieldType: 0, comment: "文件内容 BLAKE3 摘要（64位hex，去重标识）" },
  { name: "has_fulltext", fieldType: 0, comment: "是否已生成全文索引：1/0" },
  { name: "has_vector", fieldType: 0, comment: "是否已生成向量索引：1/0" },
  { name: "chunks", fieldType: 0, comment: "向量索引 chunk 信息 JSON：[{id,idx,total,snippet}]" }
];
let hashWasmModule$1 = null;
function getHashWasm$1() {
  if (!hashWasmModule$1) {
    hashWasmModule$1 = require("hash-wasm");
  }
  return hashWasmModule$1;
}
async function computeBlake3(content) {
  const { blake3 } = getHashWasm$1();
  return await blake3(Buffer.isBuffer(content) ? content.toString("utf8") : content);
}
async function queryByDigest(protocol, host, port, indexName, digest) {
  if (!digest) return null;
  const client = getClient(protocol, host, port);
  const results = await client.searchMultiField(indexName, { blake3: digest }, 20);
  return results.find((r) => r.fields.blake3 === digest) || null;
}
async function upsertDocument(client, indexName, fields) {
  const digest = fields.blake3;
  if (digest) {
    try {
      const old = await client.searchMultiField(indexName, { blake3: digest }, 50);
      for (const hit of old) {
        if (hit.fields.blake3 === digest) {
          await client.deleteDocument(indexName, hit.docId);
        }
      }
    } catch {
    }
  }
  return client.addDocument(indexName, "", fields);
}
function collectMarkdownFiles$1(dirPath) {
  const results = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const full = path.join(d, entry);
      try {
        const st = fs.statSync(full);
        if (st.isDirectory()) {
          walk(full);
        } else if (/\.(md|markdown|mdown)$/i.test(entry)) {
          results.push(full);
        }
      } catch {
      }
    }
  };
  walk(dirPath);
  return results;
}
async function indexLocalFile(protocol, host, port, indexName, filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    if (!content.trim()) {
      return { ok: true, message: `跳过空文件：${path.basename(filePath)}`, docId: void 0 };
    }
    const digest = await computeBlake3(content);
    let mtime = (/* @__PURE__ */ new Date()).toISOString();
    try {
      mtime = fs.statSync(filePath).mtime.toISOString();
    } catch {
    }
    let oldHasVector = "0";
    let oldChunks = "[]";
    try {
      const old = await queryByDigest(protocol, host, port, indexName, digest);
      if (old) {
        oldHasVector = old.fields.has_vector === "1" ? "1" : "0";
        oldChunks = old.fields.chunks || "[]";
      }
    } catch {
    }
    const fields = buildFields({
      docId: localDocId(filePath),
      title: path.basename(filePath, path.extname(filePath)) || path.basename(filePath),
      content,
      path: filePath,
      kind: "local",
      host: os.hostname(),
      server: "",
      bucket: "",
      key: "",
      updatedAt: mtime,
      blake3: digest,
      hasFulltext: "1",
      hasVector: oldHasVector,
      chunks: oldChunks
    });
    const client = getClient(protocol, host, port);
    const docId = await upsertDocument(client, indexName, fields);
    return { ok: true, message: `已生成索引：${path.basename(filePath)}`, docId };
  } catch (e) {
    return { ok: false, message: `索引 ${path.basename(filePath)} 失败：${e.message || e}`, docId: void 0 };
  }
}
async function indexDir(protocol, host, port, indexName, dirPath, onProgress) {
  const files = collectMarkdownFiles$1(dirPath);
  let okCount = 0;
  let firstErr = null;
  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    onProgress?.(i + 1, files.length, path.basename(filePath));
    const res = await indexLocalFile(protocol, host, port, indexName, filePath);
    if (res.ok) okCount++;
    else if (!firstErr) firstErr = res.message;
  }
  if (firstErr) {
    return { ok: false, message: `完成 ${okCount}/${files.length}，出错：${firstErr}`, count: okCount };
  }
  return { ok: true, message: `已为 ${okCount} 个 Markdown 文件生成索引`, count: okCount };
}
async function fetchS3Content(config, bucket, key) {
  let s3Mod = null;
  if (!s3Mod) s3Mod = require("@aws-sdk/client-s3");
  const { S3Client, GetObjectCommand } = s3Mod;
  let endpoint = config.endpoint || void 0;
  if (endpoint && !endpoint.startsWith("http")) endpoint = "http://" + endpoint;
  const client = new S3Client({
    endpoint,
    region: config.region || "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  });
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function indexS3File(protocol, host, port, indexName, config, bucket, key) {
  try {
    const content = await fetchS3Content(config, bucket, key);
    if (!content.trim()) {
      return { ok: true, message: `跳过空文件：${path.basename(key)}`, docId: void 0 };
    }
    const digest = await computeBlake3(content);
    let oldHasVector = "0";
    let oldChunks = "[]";
    try {
      const old = await queryByDigest(protocol, host, port, indexName, digest);
      if (old) {
        oldHasVector = old.fields.has_vector === "1" ? "1" : "0";
        oldChunks = old.fields.chunks || "[]";
      }
    } catch {
    }
    const fields = buildFields({
      docId: s3DocId(config, bucket, key),
      title: path.basename(key, path.extname(key)) || path.basename(key),
      content,
      path: key,
      kind: "s3",
      host: (config.endpoint || "s3.amazonaws.com").replace(/\/+$/, ""),
      server: (config.endpoint || "s3.amazonaws.com").replace(/\/+$/, ""),
      bucket,
      key,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      blake3: digest,
      hasFulltext: "1",
      hasVector: oldHasVector,
      chunks: oldChunks
    });
    const client = getClient(protocol, host, port);
    const docId = await upsertDocument(client, indexName, fields);
    return { ok: true, message: `已生成索引：${path.basename(key)}`, docId };
  } catch (e) {
    return { ok: false, message: `索引 ${path.basename(key)} 失败：${e.message || e}`, docId: void 0 };
  }
}
function encodeRaftPutRequest(key, value, groupId) {
  return Buffer.concat([pbLenField$1(1, key), pbLenField$1(2, value), pbStrField$1(3, groupId)]);
}
function decodeRaftPutResponse(buf) {
  const out = { success: false, message: "" };
  for (const f of pbParse$1(buf)) {
    if (f.fieldNum === 1) out.success = pbAsBool$1(f.value);
    else if (f.fieldNum === 2) out.message = pbAsStr$1(f.value);
  }
  return out;
}
function encodeRaftGetRequest(key, groupId) {
  return Buffer.concat([pbLenField$1(1, key), pbStrField$1(2, groupId)]);
}
function decodeRaftGetResponse(buf) {
  const out = { found: false, value: "" };
  for (const f of pbParse$1(buf)) {
    if (f.fieldNum === 1) out.found = pbAsBool$1(f.value);
    else if (f.fieldNum === 2) out.value = pbAsStr$1(f.value);
  }
  return out;
}
let raftGrpcClient = null;
let raftGrpcAddress = "";
function getRaftGrpcClient(host, port) {
  const address = host.trim().replace(/^https?:\/\//i, "") + ":" + port.trim();
  if (raftGrpcClient && raftGrpcAddress === address) return raftGrpcClient;
  const grpc = getGrpc$1();
  const Client = grpc.makeClientConstructor(
    {
      put: {
        path: "/laoflchdb.raft.RaftKvService/Put",
        requestStream: false,
        responseStream: false,
        requestSerialize: (m) => Buffer.from(encodeRaftPutRequest(Buffer.from(m.key), Buffer.from(m.value), m.groupId)),
        requestDeserialize: (buf) => Buffer.from(buf),
        responseSerialize: (m) => Buffer.from(m),
        responseDeserialize: (buf) => decodeRaftPutResponse(Buffer.from(buf))
      },
      get: {
        path: "/laoflchdb.raft.RaftKvService/Get",
        requestStream: false,
        responseStream: false,
        requestSerialize: (m) => Buffer.from(encodeRaftGetRequest(Buffer.from(m.key), m.groupId)),
        requestDeserialize: (buf) => Buffer.from(buf),
        responseSerialize: (m) => Buffer.from(m),
        responseDeserialize: (buf) => decodeRaftGetResponse(Buffer.from(buf))
      }
    },
    "RaftKvService"
  );
  raftGrpcClient = new Client(address, grpc.credentials.createInsecure());
  raftGrpcAddress = address;
  return raftGrpcClient;
}
function raftPutGrpc(cfg, key, value) {
  const grpc = getGrpc$1();
  const client = getRaftGrpcClient(cfg.host, cfg.port);
  return new Promise((resolve) => {
    client.put(
      { key: Buffer.from(key, "utf8"), value: Buffer.from(value, "utf8"), groupId: cfg.group },
      new grpc.Metadata(),
      (err, res) => resolve(!err && !!res?.success)
    );
  });
}
async function raftGetIndexMeta(cfg, digest) {
  const key = "INDEX\0" + digest;
  try {
    let raw = "";
    if (cfg.protocol === "grpc") {
      const grpc = getGrpc$1();
      const client = getRaftGrpcClient(cfg.host, cfg.port);
      const res = await new Promise((resolve, reject) => {
        client.get(
          { key: Buffer.from(key, "utf8"), groupId: cfg.group },
          new grpc.Metadata(),
          (err, r) => err ? reject(err) : resolve(r)
        );
      });
      if (!res?.found || !res.value) return null;
      raw = res.value;
    } else {
      let base = cfg.host.trim().replace(/\/+$/, "");
      if (!/^https?:\/\//i.test(base)) base = "http://" + base;
      const url = `${base}:${cfg.port.trim()}/api/v1/raft/kv?group_id=${encodeURIComponent(
        cfg.group
      )}&key=${encodeURIComponent(key)}`;
      const resp = await fetch(url);
      const json = await resp.json().catch(() => null);
      if (json?.success !== true || json.data == null) return null;
      raw = String(json.data);
    }
    const obj = JSON.parse(raw);
    return { hasFulltext: obj?.has_fulltext === "1", hasVector: obj?.has_vector === "1" };
  } catch {
    return null;
  }
}
async function syncIndexMetaToRaft(protocol, host, port, indexName, raft) {
  try {
    if (!raft.host.trim() || !raft.port.trim() || !raft.group.trim()) {
      return { ok: false, message: "Raft 服务配置不完整", count: 0 };
    }
    const client = getClient(protocol, host, port);
    const docs = await client.searchMultiField(
      indexName,
      { has_fulltext: "1", has_vector: "1" },
      1e5
    );
    const items = docs.map((d) => ({
      blake3: d.fields?.blake3 || "",
      has_fulltext: d.fields?.has_fulltext === "1" ? "1" : "0",
      has_vector: d.fields?.has_vector === "1" ? "1" : "0"
    })).filter((it) => it.blake3);
    const isGrpc = raft.protocol === "grpc";
    let restUrl = "";
    if (!isGrpc) {
      let base = raft.host.trim().replace(/\/+$/, "");
      if (!/^https?:\/\//i.test(base)) base = "http://" + base;
      restUrl = `${base}:${raft.port.trim()}/api/v1/raft/kv`;
    }
    const groupId = raft.group.trim();
    const putOne = async (it) => {
      const key = "INDEX\0" + it.blake3;
      const value = JSON.stringify(it);
      if (isGrpc) return raftPutGrpc(raft, key, value);
      try {
        const res = await fetch(restUrl, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ group_id: groupId, key, value })
        });
        const json = await res.json().catch(() => null);
        return json?.success === true;
      } catch {
        return false;
      }
    };
    let count = 0;
    const CONCURRENCY = 8;
    for (let i = 0; i < items.length; i += CONCURRENCY) {
      const batch = items.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map((it) => putOne(it)));
      count += results.filter(Boolean).length;
    }
    return { ok: true, message: "", count };
  } catch (e) {
    return { ok: false, message: e.message || "同步索引状态到 Raft 失败", count: 0 };
  }
}
function registerIndexSearchHandlers() {
  electron.ipcMain.handle("app:hostname", () => os.hostname());
  electron.ipcMain.handle(
    "index:ensure",
    async (_e, protocol, host, port, indexName, allowRebuild) => {
      return ensureIndex(protocol, host, port, indexName, !!allowRebuild);
    }
  );
  electron.ipcMain.handle(
    "index:search",
    async (_e, protocol, host, port, indexName, query, limit) => {
      try {
        const client = getClient(protocol, host, port);
        const results = await client.search(indexName, query, limit || DEFAULT_SEARCH_LIMIT$1);
        return { ok: true, message: "", results };
      } catch (e) {
        return { ok: false, message: e.message || "搜索失败", results: [] };
      }
    }
  );
  electron.ipcMain.handle(
    "index:indexLocal",
    async (_e, protocol, host, port, indexName, filePath) => {
      return indexLocalFile(protocol, host, port, indexName, filePath);
    }
  );
  electron.ipcMain.handle(
    "index:indexDir",
    async (e, protocol, host, port, indexName, dirPath) => {
      return indexDir(protocol, host, port, indexName, dirPath, (done, total, fileName) => {
        e.sender.send("index:progress", { done, total, fileName });
      });
    }
  );
  electron.ipcMain.handle(
    "index:indexS3",
    async (_e, protocol, host, port, indexName, config, bucket, key) => {
      return indexS3File(protocol, host, port, indexName, config, bucket, key);
    }
  );
  electron.ipcMain.handle(
    "index:checkFiles",
    async (_e, protocol, host, port, indexName, paths, raft) => {
      const results = {};
      const CONCURRENCY = 4;
      const work = paths.filter(Boolean);
      const useRaft = !!raft?.enabled;
      let cursor = 0;
      const worker = async () => {
        while (cursor < work.length) {
          const p = work[cursor++];
          try {
            const content = fs.readFileSync(p, "utf8");
            if (!content.trim()) {
              results[p] = { hasFulltext: false, hasVector: false };
              continue;
            }
            const digest = await computeBlake3(content);
            if (useRaft) {
              const st = await raftGetIndexMeta(raft, digest);
              results[p] = { hasFulltext: !!st?.hasFulltext, hasVector: !!st?.hasVector };
              continue;
            }
            const hit = await queryByDigest(protocol, host, port, indexName, digest);
            results[p] = {
              hasFulltext: !!hit && hit.fields.has_fulltext === "1",
              hasVector: !!hit && hit.fields.has_vector === "1"
            };
          } catch {
            results[p] = { hasFulltext: false, hasVector: false };
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, Math.max(work.length, 1)) }, () => worker())
      );
      return { ok: true, message: "", results };
    }
  );
  electron.ipcMain.handle(
    "index:checkS3Files",
    async (_e, protocol, host, port, indexName, config, bucket, keys, raft) => {
      const results = {};
      const CONCURRENCY = 4;
      const work = keys.filter(Boolean);
      const useRaft = !!raft?.enabled;
      let cursor = 0;
      const worker = async () => {
        while (cursor < work.length) {
          const key = work[cursor++];
          try {
            const content = await fetchS3Content(config, bucket, key);
            if (!content.trim()) {
              results[key] = { hasFulltext: false, hasVector: false };
              continue;
            }
            const digest = await computeBlake3(content);
            if (useRaft) {
              const st = await raftGetIndexMeta(raft, digest);
              results[key] = { hasFulltext: !!st?.hasFulltext, hasVector: !!st?.hasVector };
              continue;
            }
            const hit = await queryByDigest(protocol, host, port, indexName, digest);
            results[key] = {
              hasFulltext: !!hit && hit.fields.has_fulltext === "1",
              hasVector: !!hit && hit.fields.has_vector === "1"
            };
          } catch {
            results[key] = { hasFulltext: false, hasVector: false };
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, Math.max(work.length, 1)) }, () => worker())
      );
      return { ok: true, message: "", results };
    }
  );
  electron.ipcMain.handle(
    "index:getDoc",
    async (_e, protocol, host, port, indexName, kind, path2, config, bucket, key) => {
      try {
        let content;
        if (kind === "s3") {
          if (!config || !bucket || !key) return { ok: false, message: "无效的对象参数", doc: null };
          content = await fetchS3Content(config, bucket, key);
        } else {
          content = fs.readFileSync(path2, "utf8");
        }
        if (!content.trim()) return { ok: false, message: "空文件没有索引条目", doc: null };
        const digest = await computeBlake3(content);
        const hit = await queryByDigest(protocol, host, port, indexName, digest);
        if (!hit) return { ok: false, message: "未找到对应的索引条目", doc: null };
        return { ok: true, message: "", doc: hit };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : "获取索引详情失败", doc: null };
      }
    }
  );
  electron.ipcMain.handle(
    "index:deleteDoc",
    async (_e, protocol, host, port, indexName, docId, fields) => {
      try {
        if (!/^\d+$/.test(docId || "")) {
          return { ok: false, message: `无效的文档 ID：${docId || "（空）"}` };
        }
        const client = getClient(protocol, host, port);
        let oldEntry = null;
        const digest = fields?.blake3;
        if (digest) {
          try {
            oldEntry = await queryByDigest(protocol, host, port, indexName, digest);
          } catch {
            oldEntry = null;
          }
        }
        await client.deleteDocument(indexName, docId);
        if (digest) {
          const remaining = await client.searchMultiField(indexName, { blake3: digest }, 20);
          if (remaining.some((r) => r.docId === docId && r.fields.blake3 === digest)) {
            return { ok: false, message: "删除未生效：服务端仍存在该条目（doc_id 不匹配？）" };
          }
        }
        if (oldEntry && oldEntry.fields.has_vector === "1") {
          const merged = { ...oldEntry.fields };
          merged.has_fulltext = "0";
          merged.content = "";
          await client.addDocument(indexName, "", merged);
          return { ok: true, message: "已删除全文索引（保留向量索引条目）" };
        }
        return { ok: true, message: "已删除索引文档" };
      } catch (e) {
        return { ok: false, message: e.message || "删除索引文档失败" };
      }
    }
  );
  electron.ipcMain.handle(
    "index:syncRaft",
    async (_e, protocol, host, port, indexName, raft) => {
      return syncIndexMetaToRaft(protocol, host, port, indexName, raft);
    }
  );
}
const DEFAULT_USER = "admin";
const DEFAULT_PASS = "laoflchdb";
const DEFAULT_VECTOR_DIM = 1024;
const DEFAULT_CHUNK_SIZE = 800;
const DEFAULT_CHUNK_OVERLAP = 100;
const DEFAULT_SEARCH_LIMIT = 20;
function pbVarint(value) {
  const bytes = [];
  let v = value;
  while (v >= 128) {
    bytes.push(v & 127 | 128);
    v = Math.floor(v / 128);
  }
  bytes.push(v);
  return Buffer.from(bytes);
}
function pbTag(fieldNum, wireType) {
  return pbVarint(fieldNum << 3 | wireType);
}
function pbLenField(fieldNum, payload) {
  return Buffer.concat([pbTag(fieldNum, 2), pbVarint(payload.length), payload]);
}
function pbStrField(fieldNum, s) {
  return pbLenField(fieldNum, Buffer.from(s, "utf8"));
}
function pbVarintField(fieldNum, value) {
  return Buffer.concat([pbTag(fieldNum, 0), pbVarint(value)]);
}
function pbFloatFieldPacked(fieldNum, floats) {
  const payload = Buffer.alloc(floats.length * 4);
  floats.forEach((v, i) => payload.writeFloatLE(v, i * 4));
  return pbLenField(fieldNum, payload);
}
function pbDecodeFloatPacked(buf) {
  const out = [];
  for (let i = 0; i + 4 <= buf.length; i += 4) out.push(buf.readFloatLE(i));
  return out;
}
function pbMapEntries(fieldNum, obj) {
  return Object.entries(obj).map(([k, v]) => {
    const inner = Buffer.concat([pbStrField(1, k), pbStrField(2, v)]);
    return pbLenField(fieldNum, inner);
  });
}
function pbReadVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length) {
    const byte = buf[i];
    result |= BigInt(byte & 127) << shift;
    if ((byte & 128) === 0) return { value: result, offset: i + 1 };
    shift += 7n;
    i++;
  }
  throw new Error("protobuf: invalid varint");
}
function pbParse(buf) {
  const fields = [];
  let offset = 0;
  while (offset < buf.length) {
    const r = pbReadVarint(buf, offset);
    const tagVal = r.value;
    offset = r.offset;
    const fieldNum = Number(tagVal >> 3n);
    const wireType = Number(tagVal & 7n);
    if (wireType === 0) {
      const vr = pbReadVarint(buf, offset);
      fields.push({ fieldNum, wireType, value: vr.value });
      offset = vr.offset;
    } else if (wireType === 1) {
      fields.push({ fieldNum, wireType, value: buf.readBigUInt64LE(offset) });
      offset += 8;
    } else if (wireType === 2) {
      const lr = pbReadVarint(buf, offset);
      const len = Number(lr.value);
      offset = lr.offset;
      fields.push({ fieldNum, wireType, value: buf.subarray(offset, offset + len) });
      offset += len;
    } else if (wireType === 5) {
      fields.push({ fieldNum, wireType, value: buf.readFloatLE(offset) });
      offset += 4;
    } else {
      throw new Error("protobuf: unsupported wire type " + wireType);
    }
  }
  return fields;
}
function pbAsStr(v) {
  return v.toString("utf8");
}
function pbAsBool(v) {
  return v !== 0n;
}
function encodeCreateEmbeddingRequest(msg) {
  const { modelName, texts, dim } = msg;
  return Buffer.concat([
    pbStrField(1, modelName),
    ...(texts || []).map((t) => pbStrField(2, t)),
    dim ? pbVarintField(3, dim) : Buffer.alloc(0)
  ]);
}
function decodeCreateEmbeddingResponse(buf) {
  const out = { success: false, message: "", results: [] };
  for (const f of pbParse(buf)) {
    if (f.fieldNum === 1) out.success = pbAsBool(f.value);
    else if (f.fieldNum === 2) out.message = pbAsStr(f.value);
    else if (f.fieldNum === 3) {
      const r = { text: "", embedding: [], dim: 0 };
      for (const it of pbParse(f.value)) {
        if (it.fieldNum === 1) r.text = pbAsStr(it.value);
        else if (it.fieldNum === 2) r.embedding = pbDecodeFloatPacked(it.value);
        else if (it.fieldNum === 3) r.dim = Number(it.value);
      }
      out.results.push(r);
    }
  }
  return out;
}
function encodeGetIndexInfoRequest(indexName) {
  return pbStrField(1, indexName);
}
function decodeGetIndexInfoResponse(buf) {
  const out = { success: false, message: "", stats: null };
  for (const f of pbParse(buf)) {
    if (f.fieldNum === 1) out.success = pbAsBool(f.value);
    else if (f.fieldNum === 2) out.message = pbAsStr(f.value);
    else if (f.fieldNum === 3) {
      const s = { numElements: 0, dim: 0, name: "" };
      for (const it of pbParse(f.value)) {
        if (it.fieldNum === 1) s.numElements = Number(it.value);
        else if (it.fieldNum === 7) s.dim = Number(it.value);
        else if (it.fieldNum === 10) s.name = pbAsStr(it.value);
      }
      out.stats = s;
    }
  }
  return out;
}
function encodeInsertEmbeddingRequest(msg) {
  const { id, indexName, embedding, fields } = msg;
  return Buffer.concat([
    pbVarintField(1, id),
    pbStrField(2, indexName),
    pbFloatFieldPacked(3, embedding),
    ...pbMapEntries(4, fields || {})
  ]);
}
function decodeSimpleResponse(buf) {
  const out = { success: false, message: "" };
  for (const f of pbParse(buf)) {
    if (f.fieldNum === 1) out.success = pbAsBool(f.value);
    else if (f.fieldNum === 2) out.message = pbAsStr(f.value);
  }
  return out;
}
function encodeSearchEmbeddingRequest(msg) {
  const { queryEmbedding, topK, indexName, fieldFilters = {} } = msg;
  return Buffer.concat([
    pbFloatFieldPacked(1, queryEmbedding),
    pbVarintField(2, topK),
    pbStrField(3, indexName),
    ...pbMapEntries(4, fieldFilters)
  ]);
}
function decodeSearchEmbeddingResponse(buf) {
  const out = { success: false, message: "", results: [] };
  for (const f of pbParse(buf)) {
    if (f.fieldNum === 1) out.success = pbAsBool(f.value);
    else if (f.fieldNum === 2) out.message = pbAsStr(f.value);
    else if (f.fieldNum === 3) {
      const hit = { id: 0, distance: 0 };
      for (const it of pbParse(f.value)) {
        if (it.fieldNum === 1) hit.id = Number(it.value);
        else if (it.fieldNum === 2) hit.distance = it.value;
      }
      out.results.push(hit);
    }
  }
  return out;
}
function encodeDeleteEmbeddingRequest(id, indexName) {
  return Buffer.concat([pbVarintField(1, id), pbStrField(2, indexName)]);
}
function decodeGetEmbeddingByIdResponse(buf) {
  const out = { success: false, message: "", exists: false, dim: 0, embedding: [] };
  for (const f of pbParse(buf)) {
    if (f.fieldNum === 1) out.success = pbAsBool(f.value);
    else if (f.fieldNum === 2) out.message = pbAsStr(f.value);
    else if (f.fieldNum === 4) out.exists = pbAsBool(f.value);
    else if (f.fieldNum === 5) out.dim = Number(f.value);
    else if (f.fieldNum === 7) out.embedding = pbDecodeFloatPacked(f.value);
  }
  return out;
}
let grpcModule = null;
function getGrpc() {
  if (!grpcModule) grpcModule = require("@grpc/grpc-js");
  return grpcModule;
}
function makeServiceDefinition(servicePath, methods) {
  const def = (methodName, serialize, deserialize) => ({
    // gRPC 服务端（tonic）注册的路径使用 proto 原始大写驼峰方法名（如 CreateEmbedding），
    // 而 grpc-js 客户端方法名是小驼峰（createEmbedding），必须首字母大写才能匹配服务端
    path: `${servicePath}/${methodName[0].toUpperCase()}${methodName.slice(1)}`,
    requestStream: false,
    responseStream: false,
    requestSerialize: (msg) => Buffer.from(serialize(msg)),
    requestDeserialize: (buf) => buf,
    responseSerialize: (msg) => Buffer.from(msg),
    responseDeserialize: (buf) => deserialize(Buffer.from(buf))
  });
  const out = {};
  for (const [name, m] of Object.entries(methods)) {
    out[name] = def(name, m.serialize, m.deserialize);
  }
  return out;
}
function encodeLoginRequest(username, password) {
  return Buffer.concat([pbStrField(1, username), pbStrField(2, password)]);
}
function decodeLoginResponse(buf) {
  const out = { success: false, message: "", token: "" };
  for (const f of pbParse(buf)) {
    if (f.fieldNum === 1) out.success = pbAsBool(f.value);
    else if (f.fieldNum === 2) out.message = pbAsStr(f.value);
    else if (f.fieldNum === 3) out.token = pbAsStr(f.value);
  }
  return out;
}
function makeAuthServiceDefinition() {
  return makeServiceDefinition("/laoflchdb.rpc.LaoflchDb", {
    login: {
      serialize: (m) => encodeLoginRequest(m.username, m.password),
      deserialize: decodeLoginResponse
    }
  });
}
function makeVectorServiceDefinition() {
  return makeServiceDefinition("/laoflchdb.vector.VectorService", {
    createEmbedding: {
      serialize: encodeCreateEmbeddingRequest,
      deserialize: decodeCreateEmbeddingResponse
    }
  });
}
function makeEmbeddingServiceDefinition() {
  return makeServiceDefinition("/laoflchdb.embedding.EmbeddingIndexService", {
    getIndexInfo: {
      serialize: (m) => encodeGetIndexInfoRequest(m.indexName),
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
      serialize: (m) => encodeDeleteEmbeddingRequest(m.id, m.indexName),
      deserialize: decodeSimpleResponse
    },
    getEmbeddingById: {
      serialize: (m) => encodeDeleteEmbeddingRequest(m.id, m.indexName),
      deserialize: decodeGetEmbeddingByIdResponse
    }
  });
}
class VectorGrpcClient {
  constructor(host, port) {
    this.token = null;
    this.authClient = null;
    this.vectorClient = null;
    this.embeddingClient = null;
    this.address = host.replace(/^https?:\/\//i, "") + ":" + port;
  }
  ensureAuthClient() {
    if (!this.authClient) {
      const grpc = getGrpc();
      const Client = grpc.makeClientConstructor(makeAuthServiceDefinition(), "LaoflchDb");
      this.authClient = new Client(this.address, grpc.credentials.createInsecure());
    }
    return this.authClient;
  }
  ensureVectorClient() {
    if (!this.vectorClient) {
      const grpc = getGrpc();
      const Client = grpc.makeClientConstructor(makeVectorServiceDefinition(), "VectorService");
      this.vectorClient = new Client(this.address, grpc.credentials.createInsecure());
    }
    return this.vectorClient;
  }
  ensureEmbeddingClient() {
    if (!this.embeddingClient) {
      const grpc = getGrpc();
      const Client = grpc.makeClientConstructor(makeEmbeddingServiceDefinition(), "EmbeddingIndexService");
      this.embeddingClient = new Client(this.address, grpc.credentials.createInsecure());
    }
    return this.embeddingClient;
  }
  unary(client, method, req) {
    const grpc = getGrpc();
    return new Promise((resolve, reject) => {
      const md = new grpc.Metadata();
      if (this.token) md.set("authorization", "Bearer " + this.token);
      client[method](req, md, (err, res) => {
        if (err) reject(err);
        else resolve(res);
      });
    });
  }
  async login() {
    const resp = await this.unary(this.ensureAuthClient(), "login", {
      username: DEFAULT_USER,
      password: DEFAULT_PASS
    });
    if (!resp.success || !resp.token) throw new Error(resp.message || "登录失败");
    this.token = resp.token;
  }
  async withAuth(fn) {
    try {
      return await fn();
    } catch (e) {
      const msg = e?.details || (e instanceof Error ? e.message : "");
      const authFailed = e?.code === 16 || /unauthor|未提供有效的认证|authentication required|invalid or missing token/i.test(msg);
      if (authFailed) {
        try {
          await this.login();
        } catch {
        }
        return await fn();
      }
      throw e;
    }
  }
  async createEmbedding(modelName, texts, dim) {
    return this.withAuth(async () => {
      const resp = await this.unary(this.ensureVectorClient(), "createEmbedding", { modelName, texts, dim });
      if (!resp.success) throw new Error(resp.message || "生成向量失败");
      return resp.results;
    });
  }
  async getIndexInfo(indexName) {
    return this.withAuth(async () => {
      const resp = await this.unary(this.ensureEmbeddingClient(), "getIndexInfo", { indexName });
      if (!resp.success) throw new Error(resp.message || "获取向量索引信息失败");
      return resp.stats;
    });
  }
  async insertEmbedding(id, indexName, embedding, fields) {
    await this.withAuth(async () => {
      const resp = await this.unary(this.ensureEmbeddingClient(), "insertEmbedding", {
        id,
        indexName,
        embedding,
        fields
      });
      if (!resp.success) throw new Error(resp.message || "写入向量失败");
    });
  }
  async searchEmbedding(queryEmbedding, indexName, topK) {
    return this.withAuth(async () => {
      const resp = await this.unary(this.ensureEmbeddingClient(), "searchEmbedding", {
        queryEmbedding,
        topK,
        indexName
      });
      if (!resp.success) throw new Error(resp.message || "向量搜索失败");
      return resp.results;
    });
  }
  async deleteEmbedding(id, indexName) {
    await this.withAuth(async () => {
      const resp = await this.unary(this.ensureEmbeddingClient(), "deleteEmbedding", { id, indexName });
      if (!resp.success) throw new Error(resp.message || "删除向量失败");
    });
  }
  async getEmbeddingById(id, indexName) {
    return this.withAuth(async () => {
      const resp = await this.unary(this.ensureEmbeddingClient(), "getEmbeddingById", { id, indexName });
      if (!resp.success) throw new Error(resp.message || "查询向量失败");
      return resp;
    });
  }
}
const vectorClientCache = /* @__PURE__ */ new Map();
function getVectorClient(host, port) {
  const key = `${host}|${port}`;
  let client = vectorClientCache.get(key);
  if (!client) {
    client = new VectorGrpcClient(host, port);
    vectorClientCache.set(key, client);
  }
  return client;
}
function splitChunks(text, chunkSize, overlap) {
  const clean = text.replace(/\r\n/g, "\n");
  if (clean.length <= chunkSize) {
    const t = clean.trim();
    return t ? [t] : [];
  }
  const chunks = [];
  let pos = 0;
  while (pos < clean.length) {
    let end = Math.min(pos + chunkSize, clean.length);
    if (end < clean.length) {
      const nl = clean.lastIndexOf("\n", end);
      if (nl > pos + chunkSize * 0.5) end = nl;
    }
    const chunk = clean.slice(pos, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= clean.length) break;
    pos = Math.max(end - overlap, pos + 1);
  }
  return chunks;
}
let hashWasmModule = null;
function getHashWasm() {
  if (!hashWasmModule) hashWasmModule = require("hash-wasm");
  return hashWasmModule;
}
async function chunkId(blake3Hex, chunkIndex) {
  const { blake3 } = getHashWasm();
  const hex = await blake3(blake3Hex + ":" + chunkIndex);
  return parseInt(hex.slice(0, 12), 16);
}
async function createEmbeddingsBatched(client, modelName, texts, dim) {
  const results = [];
  const BATCH = 50;
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const resp = await client.createEmbedding(modelName, batch, dim);
    if (resp.length !== batch.length) {
      throw new Error(`向量服务返回 ${resp.length} 条，期望 ${batch.length} 条`);
    }
    for (const r of resp) results.push(r.embedding);
  }
  return results;
}
async function deleteChunksOfDigest(searchCfg, client, indexName, digest) {
  let old = null;
  try {
    old = await queryByDigest(searchCfg.protocol, searchCfg.host, searchCfg.port, searchCfg.indexName, digest);
  } catch {
    return;
  }
  if (!old) return;
  let chunks = [];
  try {
    chunks = JSON.parse(old.fields.chunks || "[]");
  } catch {
    return;
  }
  for (const c of chunks) {
    try {
      await client.deleteEmbedding(Number(c.id), indexName);
    } catch {
    }
  }
}
async function deleteVectorFile(searchCfg, client, indexName, kind, path2, config, bucket, key) {
  const content = kind === "s3" ? await fetchS3Content(config, bucket, key) : fs.readFileSync(path2, "utf8");
  const digest = await computeBlake3(content);
  const old = await queryByDigest(searchCfg.protocol, searchCfg.host, searchCfg.port, searchCfg.indexName, digest);
  if (!old) return;
  let chunks = [];
  try {
    chunks = JSON.parse(old.fields.chunks || "[]");
  } catch {
    chunks = [];
  }
  for (const c of chunks) {
    try {
      await client.deleteEmbedding(Number(c.id), indexName);
    } catch {
    }
  }
  const searchClient = getClient(searchCfg.protocol, searchCfg.host, searchCfg.port);
  if (old.fields.has_fulltext === "1") {
    const merged = { ...old.fields };
    merged.has_vector = "0";
    merged.chunks = "[]";
    await searchClient.deleteDocument(searchCfg.indexName, old.docId);
    await searchClient.addDocument(searchCfg.indexName, "", merged);
  } else {
    await searchClient.deleteDocument(searchCfg.indexName, old.docId);
  }
}
async function deleteVectorId(searchCfg, client, indexName, id) {
  await client.deleteEmbedding(id, indexName);
  const searchClient = getClient(searchCfg.protocol, searchCfg.host, searchCfg.port);
  const entries = await searchClient.searchMultiField(searchCfg.indexName, { has_vector: "1" }, 1e4);
  for (const e of entries) {
    let chunks = [];
    try {
      chunks = JSON.parse(e.fields.chunks || "[]");
    } catch {
      continue;
    }
    const idx = chunks.findIndex((c) => Number(c.id) === id);
    if (idx < 0) continue;
    chunks.splice(idx, 1);
    const merged = { ...e.fields };
    merged.chunks = JSON.stringify(chunks);
    merged.has_vector = chunks.length ? "1" : "0";
    if (!chunks.length && e.fields.has_fulltext !== "1") {
      await searchClient.deleteDocument(searchCfg.indexName, e.docId);
    } else {
      await searchClient.deleteDocument(searchCfg.indexName, e.docId);
      await searchClient.addDocument(searchCfg.indexName, "", merged);
    }
    break;
  }
}
function collectMarkdownFiles(dirPath) {
  const results = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const full = path.join(d, entry);
      try {
        const st = fs.statSync(full);
        if (st.isDirectory()) {
          walk(full);
        } else if (/\.(md|markdown|mdown)$/i.test(entry)) {
          results.push(full);
        }
      } catch {
      }
    }
  };
  walk(dirPath);
  return results;
}
async function syncEntryAfterVector(searchCfg, meta) {
  let oldHasFulltext = "0";
  let oldContent = "";
  try {
    const old = await queryByDigest(searchCfg.protocol, searchCfg.host, searchCfg.port, searchCfg.indexName, meta.blake3);
    if (old) {
      oldHasFulltext = old.fields.has_fulltext === "1" ? "1" : "0";
      oldContent = oldHasFulltext === "1" ? old.fields.content || "" : "";
    }
  } catch {
  }
  const fields = buildFields({
    docId: meta.docId,
    title: meta.title,
    content: oldContent,
    path: meta.path,
    kind: meta.kind,
    host: meta.host,
    server: meta.server,
    bucket: meta.bucket,
    key: meta.key,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    blake3: meta.blake3,
    hasFulltext: oldHasFulltext,
    hasVector: "1",
    chunks: JSON.stringify(meta.chunkRecords)
  });
  const client = getClient(searchCfg.protocol, searchCfg.host, searchCfg.port);
  await upsertDocument(client, searchCfg.indexName, fields);
}
async function indexVectorLocalFile(searchCfg, host, port, indexName, modelName, filePath, chunkSize, overlap) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    if (!content.trim()) {
      return { ok: true, message: `跳过空文件：${path.basename(filePath)}`, count: 0 };
    }
    const digest = await computeBlake3(content);
    const chunks = splitChunks(content, chunkSize, overlap);
    if (!chunks.length) {
      return { ok: true, message: `跳过空文件：${path.basename(filePath)}`, count: 0 };
    }
    const client = getVectorClient(host, port);
    await deleteChunksOfDigest(searchCfg, client, indexName, digest);
    const embeddings = await createEmbeddingsBatched(client, modelName, chunks, DEFAULT_VECTOR_DIM);
    const title = path.basename(filePath, path.extname(filePath)) || path.basename(filePath);
    const chunkRecords = [];
    for (let i = 0; i < chunks.length; i++) {
      const id = await chunkId(digest, i);
      chunkRecords.push({ id, idx: i, total: chunks.length, snippet: chunks[i].slice(0, 300) });
      await client.insertEmbedding(id, indexName, embeddings[i], {
        title,
        path: filePath,
        kind: "local",
        host: os.hostname(),
        server: "",
        bucket: "",
        key: "",
        blake3: digest,
        chunk_index: String(i),
        total_chunks: String(chunks.length),
        snippet: chunks[i].slice(0, 300)
      });
    }
    await syncEntryAfterVector(searchCfg, {
      docId: localDocId(filePath),
      title,
      path: filePath,
      kind: "local",
      host: os.hostname(),
      server: "",
      bucket: "",
      key: "",
      blake3: digest,
      chunkRecords
    });
    return { ok: true, message: `已生成向量索引：${path.basename(filePath)}（${chunks.length} 块）`, count: chunks.length };
  } catch (e) {
    return { ok: false, message: `向量索引 ${path.basename(filePath)} 失败：${e.message || e}`, count: 0 };
  }
}
async function indexVectorDir(searchCfg, host, port, indexName, modelName, dirPath, chunkSize, overlap, onProgress) {
  const files = collectMarkdownFiles(dirPath);
  let okCount = 0;
  let firstErr = null;
  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    onProgress?.(i + 1, files.length, path.basename(filePath));
    const res = await indexVectorLocalFile(searchCfg, host, port, indexName, modelName, filePath, chunkSize, overlap);
    if (res.ok) okCount++;
    else if (!firstErr) firstErr = res.message;
  }
  if (firstErr) {
    return { ok: false, message: `完成 ${okCount}/${files.length}，出错：${firstErr}`, count: okCount };
  }
  return { ok: true, message: `已为 ${okCount} 个 Markdown 文件生成向量索引`, count: okCount };
}
async function indexVectorS3File(searchCfg, host, port, indexName, modelName, config, bucket, key, chunkSize, overlap) {
  try {
    const content = await fetchS3Content(config, bucket, key);
    if (!content.trim()) {
      return { ok: true, message: `跳过空文件：${path.basename(key)}`, count: 0 };
    }
    const digest = await computeBlake3(content);
    const chunks = splitChunks(content, chunkSize, overlap);
    if (!chunks.length) {
      return { ok: true, message: `跳过空文件：${path.basename(key)}`, count: 0 };
    }
    const client = getVectorClient(host, port);
    await deleteChunksOfDigest(searchCfg, client, indexName, digest);
    const embeddings = await createEmbeddingsBatched(client, modelName, chunks, DEFAULT_VECTOR_DIM);
    const server = (config.endpoint || "s3.amazonaws.com").replace(/\/+$/, "");
    const title = path.basename(key, path.extname(key)) || path.basename(key);
    const chunkRecords = [];
    for (let i = 0; i < chunks.length; i++) {
      const id = await chunkId(digest, i);
      chunkRecords.push({ id, idx: i, total: chunks.length, snippet: chunks[i].slice(0, 300) });
      await client.insertEmbedding(id, indexName, embeddings[i], {
        title,
        path: key,
        kind: "s3",
        host: server,
        server,
        bucket,
        key,
        blake3: digest,
        chunk_index: String(i),
        total_chunks: String(chunks.length),
        snippet: chunks[i].slice(0, 300)
      });
    }
    await syncEntryAfterVector(searchCfg, {
      docId: s3DocId(config, bucket, key),
      title,
      path: key,
      kind: "s3",
      host: server,
      server,
      bucket,
      key,
      blake3: digest,
      chunkRecords
    });
    return { ok: true, message: `已生成向量索引：${path.basename(key)}（${chunks.length} 块）`, count: chunks.length };
  } catch (e) {
    return { ok: false, message: `向量索引 ${path.basename(key)} 失败：${e.message || e}`, count: 0 };
  }
}
async function searchVector(searchCfg, host, port, indexName, modelName, query, topK) {
  try {
    const client = getVectorClient(host, port);
    const qEmb = await client.createEmbedding(modelName, [query], DEFAULT_VECTOR_DIM);
    if (!qEmb.length) throw new Error("查询向量生成失败");
    const hits = await client.searchEmbedding(qEmb[0].embedding, indexName, topK);
    const searchClient = getClient(searchCfg.protocol, searchCfg.host, searchCfg.port);
    const entries = await searchClient.searchMultiField(searchCfg.indexName, { has_vector: "1" }, 1e4);
    const chunkMap = /* @__PURE__ */ new Map();
    for (const e of entries) {
      let chunks = [];
      try {
        chunks = JSON.parse(e.fields.chunks || "[]");
      } catch {
        continue;
      }
      for (const c of chunks) {
        chunkMap.set(Number(c.id), { fields: e.fields, chunk: c });
      }
    }
    const results = hits.map((h) => {
      const rec = chunkMap.get(h.id);
      return {
        docId: String(h.id),
        // Cosine 距离 → 相似度：1 - distance（clip 下限 0）
        score: Math.max(0, 1 - h.distance),
        distance: h.distance,
        fields: rec ? {
          title: rec.fields.title || "",
          path: rec.fields.path || "",
          kind: rec.fields.kind || "local",
          host: rec.fields.host || "",
          server: rec.fields.server || "",
          bucket: rec.fields.bucket || "",
          key: rec.fields.key || "",
          blake3: rec.fields.blake3 || "",
          chunk_index: String(rec.chunk.idx),
          total_chunks: String(rec.chunk.total),
          snippet: rec.chunk.snippet || ""
        } : {}
      };
    });
    return { ok: true, message: "", results };
  } catch (e) {
    return { ok: false, message: e.message || "向量搜索失败", results: [] };
  }
}
async function getVectorIndexInfo(host, port, indexName) {
  try {
    const client = getVectorClient(host, port);
    const stats = await client.getIndexInfo(indexName);
    return { ok: true, message: "", stats };
  } catch (e) {
    return { ok: false, message: e.message || "获取向量索引信息失败", stats: null };
  }
}
function registerVectorIndexHandlers() {
  electron.ipcMain.handle("vector:getInfo", async (_e, host, port, indexName) => {
    return getVectorIndexInfo(host, port, indexName);
  });
  electron.ipcMain.handle(
    "vector:indexLocal",
    async (_e, searchCfg, host, port, indexName, modelName, filePath, chunkSize, overlap) => {
      return indexVectorLocalFile(
        searchCfg,
        host,
        port,
        indexName,
        modelName,
        filePath,
        chunkSize || DEFAULT_CHUNK_SIZE,
        overlap === void 0 ? DEFAULT_CHUNK_OVERLAP : overlap
      );
    }
  );
  electron.ipcMain.handle(
    "vector:indexDir",
    async (e, searchCfg, host, port, indexName, modelName, dirPath, chunkSize, overlap) => {
      return indexVectorDir(
        searchCfg,
        host,
        port,
        indexName,
        modelName,
        dirPath,
        chunkSize || DEFAULT_CHUNK_SIZE,
        overlap === void 0 ? DEFAULT_CHUNK_OVERLAP : overlap,
        (done, total, fileName) => {
          e.sender.send("vector:progress", { done, total, fileName });
        }
      );
    }
  );
  electron.ipcMain.handle(
    "vector:indexS3",
    async (_e, searchCfg, host, port, indexName, modelName, config, bucket, key, chunkSize, overlap) => {
      return indexVectorS3File(
        searchCfg,
        host,
        port,
        indexName,
        modelName,
        config,
        bucket,
        key,
        chunkSize || DEFAULT_CHUNK_SIZE,
        overlap === void 0 ? DEFAULT_CHUNK_OVERLAP : overlap
      );
    }
  );
  electron.ipcMain.handle(
    "vector:search",
    async (_e, searchCfg, host, port, indexName, modelName, query, topK) => {
      return searchVector(searchCfg, host, port, indexName, modelName, query, topK || DEFAULT_SEARCH_LIMIT);
    }
  );
  electron.ipcMain.handle(
    "vector:deleteFile",
    async (_e, searchCfg, host, port, indexName, kind, path2, config, bucket, key) => {
      try {
        const client = getVectorClient(host, port);
        await deleteVectorFile(searchCfg, client, indexName, kind, path2, config, bucket, key);
        return { ok: true, message: "已删除该文件的向量索引" };
      } catch (e) {
        return { ok: false, message: e.message || "删除向量索引失败" };
      }
    }
  );
  electron.ipcMain.handle(
    "vector:deleteId",
    async (_e, searchCfg, host, port, indexName, id) => {
      try {
        const num = Number(id);
        if (!/^\d+$/.test(String(num))) {
          return { ok: false, message: `无效的向量 ID：${id}` };
        }
        const client = getVectorClient(host, port);
        await deleteVectorId(searchCfg, client, indexName, num);
        return { ok: true, message: "已删除该向量条目" };
      } catch (e) {
        return { ok: false, message: e.message || "删除向量条目失败" };
      }
    }
  );
}
const VERSION_NOTES = [
  {
    version: "1.0.5",
    date: "2026-10-20",
    title: "索引与状态栏增强",
    changes: [
      "索引表名可在全局设置中配置，默认 md_docs，创建索引/检索/删除/标签检测均使用该索引名",
      "目录生成索引时逐文件显示蓝色进度提示（多条堆叠、8 秒后消失），完成后绿色提示汇总结果",
      "内容为空的 Markdown 文件自动跳过索引，也不参与已索引检测",
      "子目录「全文」标签修复：按文件自身路径精确判断索引状态",
      "「检查索引」结果提示移入主界面右上角通知",
      "目录树交互优化：点击目录即选中并展开，点击三角号同样可展开收起",
      "底部状态栏显示当前打开文件地址：本地文件显示主机名+绝对路径，S3 文件显示完整协议与地址",
      "已索引标签文字由「已索引」改为「全文」"
    ]
  },
  {
    version: "1.0.4",
    date: "2026-10-20",
    title: "全文检索与界面体验升级",
    changes: [
      "新增「全文检索」：集成 laoflchdb-rust 索引服务，支持 gRPC/REST 双协议切换（默认端口 29777/38080）",
      "本地文件树与 S3 右键菜单支持「生成索引」，目录可递归索引并逐文件显示进度",
      "索引以 BLAKE3 摘要去重，同一文件仅保留一条索引；内容为空的文件自动跳过",
      "已索引的 Markdown 文件显示「全文」标签，目录展开时自动检测索引状态",
      "全文检索结果卡片支持打开文档与删除索引条目（仅删索引，不影响原文件）",
      "编辑 / 实时预览 / 预览三个界面统一底部状态栏，高度对齐，按实际有效字符统计",
      "编辑与预览切换时保持光标所在行位置一致",
      "索引结果提示改为主界面右上角通知，多条依次堆叠显示、可点击关闭",
      "目录树交互优化：点击目录即选中并展开，点击三角号同样可展开收起"
    ]
  },
  {
    version: "1.0.3",
    date: "2026-08-25",
    title: "全新启动体验与高亮引擎升级",
    changes: [
      "新增启动闪屏：过场画面 + 加载进度条，启动不再白屏等待",
      "启动性能优化：代码高亮语言按需加载、Turndown 懒初始化、S3 SDK 延迟加载",
      "代码高亮引擎升级为 Shiki（VS Code 同款），语法着色更精细，命令行也可分色",
      "代码高亮改为异步渲染，首次使用某语言时自动加载并补渲",
      "修复侧边栏与预览区分割线拖拽过快的问题",
      "修复文档内嵌图片被 CSP 策略拦截无法显示的问题",
      "拖拽逻辑重构为可复用组合式函数，便于后续扩展"
    ]
  },
  {
    version: "1.0.2",
    date: "2026-08-12",
    title: "保存与预览体验优化",
    changes: [
      "修复 Ctrl+S 快捷键在预览模式下无法正确保存的问题",
      "预览区内容变动实时标记「未保存」，保存后恢复「已保存」",
      "状态栏固定在预览框底部，不再随内容滚动",
      "S3 文件保存行为统一：Ctrl+S 与工具栏按钮均直接写回 S3",
      "优化预览区与编辑区同步滚动，避免循环抖动"
    ]
  },
  {
    version: "1.0.1",
    date: "2026-08-10",
    title: "优化与增强",
    changes: [
      "增加版本说明与显示功能",
      "S3 文件增加右键菜单：删除、显示详情",
      "本地文件树过滤非 Markdown 文件",
      "侧边栏独立背景色变量，便于定制",
      "面包屑与重连/另存按钮同行显示",
      "标签页名称调整：本地文件 / S3"
    ]
  },
  {
    version: "1.0.0",
    date: "2026-07-02",
    title: "首个正式版本",
    changes: [
      "跨平台 Markdown 编辑器（Windows / Linux / macOS）",
      "基于 Electron + Vue 3 构建",
      "实时预览、代码高亮（支持多种语言）",
      "文件树导航、新建/删除/重命名",
      "S3 对象存储访问与另存",
      "双向同步滚动、分割线拖拽调整",
      "亮色/暗色主题自动适配系统配色",
      "导出 HTML / PDF"
    ]
  }
];
let mainWindow = null;
let splashWindow = null;
function getAppVersion() {
  try {
    const pkgPath = path.join(electron.app.getAppPath(), "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (pkg.version) return pkg.version;
    }
  } catch {
  }
  return electron.app.getVersion();
}
function getSplashHtml(version) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>LaoflchMD</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:100%;height:100%;overflow:hidden;user-select:none;-webkit-user-select:none}
    body{
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
      background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      color:#fff;position:relative;-webkit-app-region:drag;
    }
    /* 背景装饰光斑 */
    .blob{position:absolute;border-radius:50%;filter:blur(60px);opacity:.35;z-index:0}
    .blob.b1{width:280px;height:280px;background:#7c3aed;top:-80px;right:-60px}
    .blob.b2{width:220px;height:220px;background:#06b6d4;bottom:-60px;left:-40px}
    .blob.b3{width:160px;height:160px;background:#ec4899;top:40%;left:-30px;opacity:.2}
    /* Logo 容器 */
    .logo-wrap{
      width:110px;height:110px;border-radius:28px;
      background:rgba(255,255,255,.18);
      backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);
      border:1.5px solid rgba(255,255,255,.3);
      display:flex;align-items:center;justify-content:center;
      margin-bottom:24px;z-index:1;
      box-shadow:
        0 20px 50px rgba(0,0,0,.25),
        0 8px 20px rgba(0,0,0,.15),
        inset 0 1px 0 rgba(255,255,255,.3);
      animation:float 3.5s ease-in-out infinite;
    }
    .logo-wrap .icon{font-size:54px;filter:drop-shadow(0 4px 8px rgba(0,0,0,.2))}
    @keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
    .name{font-size:34px;font-weight:700;margin-bottom:8px;z-index:1;letter-spacing:1px;
      text-shadow:0 2px 10px rgba(0,0,0,.15)}
    .desc{font-size:15px;opacity:.8;margin-bottom:48px;z-index:1;letter-spacing:.5px}
    .wrap{width:300px;z-index:1}
    .bar{
      width:100%;height:6px;
      background:rgba(255,255,255,.18);
      border-radius:3px;overflow:hidden;margin-bottom:16px;
      box-shadow:inset 0 1px 3px rgba(0,0,0,.1);
    }
    .fill{
      height:100%;
      background:linear-gradient(90deg,#fff 0%,#e0e7ff 100%);
      border-radius:3px;width:0%;
      transition:width .35s cubic-bezier(.4,0,.2,1);
      box-shadow:0 0 16px rgba(255,255,255,.6),0 0 4px rgba(255,255,255,.8);
      position:relative;
    }
    .fill::after{
      content:'';position:absolute;top:0;right:0;bottom:0;
      width:20px;
      background:linear-gradient(90deg,transparent,rgba(255,255,255,.6),transparent);
      animation:shine 1.5s infinite;
    }
    @keyframes shine{0%{transform:translateX(-100%)}100%{transform:translateX(280px)}}
    .text{font-size:13px;opacity:.78;text-align:center;min-height:20px;letter-spacing:.3px}
    .ver{position:absolute;bottom:28px;left:0;right:0;text-align:center;font-size:12px;opacity:.55;z-index:1;letter-spacing:.5px}
  </style>
</head>
<body>
  <div class="blob b1"></div>
  <div class="blob b2"></div>
  <div class="blob b3"></div>
  <div class="logo-wrap"><div class="icon">📝</div></div>
  <div class="name">LaoflchMD</div>
  <div class="desc">跨平台 Markdown 编辑器</div>
  <div class="wrap">
    <div class="bar"><div class="fill" id="f"></div></div>
    <div class="text" id="t">正在初始化...</div>
  </div>
  <div class="ver">v${version}</div>
  <script>
    const{ipcRenderer}=require('electron')
    const f=document.getElementById('f'),t=document.getElementById('t')
    ipcRenderer.on('splash:progress',(_e,p,msg)=>{
      f.style.width=Math.max(0,Math.min(100,p))+'%'
      if(msg)t.textContent=msg
    })
  <\/script>
</body>
</html>`;
}
function createSplashWindow() {
  const version = getAppVersion();
  splashWindow = new electron.BrowserWindow({
    width: 560,
    height: 400,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    center: true,
    show: true,
    backgroundColor: "#667eea",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  const dataUrl = "data:text/html;charset=utf-8," + encodeURIComponent(getSplashHtml(version));
  splashWindow.loadURL(dataUrl);
}
function updateSplashProgress(progress, message) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send("splash:progress", progress, message);
  }
}
function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    updateSplashProgress(100, "加载完成");
    setTimeout(() => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close();
        splashWindow = null;
      }
    }, 250);
  }
}
function ensureMdExtension(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mdExts = [".md", ".markdown", ".mdown", ".mdx"];
  if (mdExts.includes(ext)) return filePath;
  if (ext && ext !== ".") return filePath;
  return filePath + ".md";
}
function createWindow() {
  mainWindow = new electron.BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    show: false
  });
  mainWindow.on("ready-to-show", () => {
    closeSplash();
    setTimeout(() => {
      mainWindow?.show();
      updateSplashProgress(100);
    }, 300);
  });
  mainWindow.on("maximize", () => {
    mainWindow?.webContents.send("window:maximized-changed", true);
  });
  mainWindow.on("unmaximize", () => {
    mainWindow?.webContents.send("window:maximized-changed", false);
  });
  const menuTemplate = [
    {
      label: "文件",
      submenu: [
        {
          label: "新建",
          accelerator: "CmdOrCtrl+N",
          click: () => mainWindow?.webContents.send("menu-new-file")
        },
        {
          label: "打开",
          accelerator: "CmdOrCtrl+O",
          click: () => mainWindow?.webContents.send("menu-open-file")
        },
        {
          label: "保存",
          click: () => mainWindow?.webContents.send("menu-save-file")
        },
        {
          label: "另存为",
          click: () => mainWindow?.webContents.send("menu-save-as-file")
        },
        { type: "separator" },
        {
          label: "导出 HTML",
          click: () => mainWindow?.webContents.send("menu-export-html")
        },
        {
          label: "导出 PDF",
          click: () => mainWindow?.webContents.send("menu-export-pdf")
        },
        { type: "separator" },
        { role: "quit", label: "退出" }
      ]
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" }
      ]
    },
    {
      label: "视图",
      submenu: [
        { role: "reload", label: "刷新" },
        { role: "forceReload", label: "强制刷新" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "resetZoom", label: "重置缩放" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "全屏" },
        { type: "separator" },
        {
          label: "切换侧边栏",
          accelerator: "CmdOrCtrl+Shift+L",
          click: () => mainWindow?.webContents.send("menu-toggle-sidebar")
        }
      ]
    },
    {
      label: "主题",
      submenu: [
        {
          label: "切换亮色/暗色主题",
          accelerator: "CmdOrCtrl+Shift+T",
          click: () => mainWindow?.webContents.send("menu-toggle-theme")
        }
      ]
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "关于 LaoflchMD",
          accelerator: "CmdOrCtrl+Shift+A",
          click: () => mainWindow?.webContents.send("menu-about")
        }
      ]
    }
  ];
  if (process.platform === "darwin") {
    menuTemplate.unshift({
      label: electron.app.name,
      submenu: [
        { role: "about", label: "关于" },
        { type: "separator" },
        { role: "hide", label: "隐藏" },
        { role: "hideOthers", label: "隐藏其他" },
        { role: "unhide", label: "显示全部" },
        { type: "separator" },
        { role: "quit", label: "退出" }
      ]
    });
  }
  const menu = electron.Menu.buildFromTemplate(menuTemplate);
  electron.Menu.setApplicationMenu(menu);
  if (process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}
electron.ipcMain.handle("getSystemTheme", () => {
  return electron.nativeTheme.shouldUseDarkColors;
});
electron.ipcMain.handle("app:getInfo", () => {
  let version = electron.app.getVersion();
  try {
    const pkgPath = path.join(electron.app.getAppPath(), "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (pkg.version) version = pkg.version;
    }
  } catch {
  }
  return {
    version,
    notes: VERSION_NOTES
  };
});
electron.nativeTheme.on("updated", () => {
  mainWindow?.webContents.send("system-theme-changed", electron.nativeTheme.shouldUseDarkColors);
});
electron.ipcMain.handle("dialog:openFile", async () => {
  if (!mainWindow) return null;
  const result = await electron.dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [
      { name: "Markdown", extensions: ["md", "markdown", "mdown", "mdx"] },
      { name: "所有文件", extensions: ["*"] }
    ]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const content = fs.readFileSync(filePath, "utf-8");
  return { content, filePath };
});
electron.ipcMain.handle("dialog:saveFile", async (_event, content, filePath) => {
  if (!mainWindow) return null;
  try {
    if (filePath) {
      const finalPath2 = ensureMdExtension(filePath);
      fs.writeFileSync(finalPath2, content, "utf-8");
      return finalPath2;
    }
    const result = await electron.dialog.showSaveDialog(mainWindow, {
      filters: [
        { name: "Markdown", extensions: ["md"] },
        { name: "所有文件", extensions: ["*"] }
      ]
    });
    if (result.canceled || !result.filePath) return null;
    const finalPath = ensureMdExtension(result.filePath);
    fs.writeFileSync(finalPath, content, "utf-8");
    return finalPath;
  } catch (err) {
    console.error("Save file error:", err);
    return null;
  }
});
electron.ipcMain.handle("dialog:saveFileAs", async (_event, content, defaultName) => {
  if (!mainWindow) return null;
  const options = {
    filters: [
      { name: "Markdown", extensions: ["md"] },
      { name: "所有文件", extensions: ["*"] }
    ]
  };
  if (defaultName) {
    options.defaultPath = defaultName;
  }
  const result = await electron.dialog.showSaveDialog(mainWindow, options);
  if (result.canceled || !result.filePath) return null;
  const finalPath = ensureMdExtension(result.filePath);
  fs.writeFileSync(finalPath, content, "utf-8");
  return finalPath;
});
electron.ipcMain.handle("setTitle", (_event, title) => {
  if (mainWindow) {
    mainWindow.setTitle(title ? `${title} - LaoflchMD` : "LaoflchMD");
  }
});
electron.ipcMain.handle("getFilePath", () => {
  return null;
});
electron.ipcMain.handle("window:minimize", () => {
  mainWindow?.minimize();
});
electron.ipcMain.handle("window:maximize", () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
electron.ipcMain.handle("window:close", () => {
  mainWindow?.close();
});
electron.ipcMain.handle("window:isMaximized", () => {
  return mainWindow?.isMaximized() ?? false;
});
electron.ipcMain.handle("export:html", async (_event, html) => {
  if (!mainWindow) return;
  const result = await electron.dialog.showSaveDialog(mainWindow, {
    filters: [
      { name: "HTML", extensions: ["html", "htm"] }
    ]
  });
  if (result.canceled || !result.filePath) return;
  const fullHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${mainWindow?.getTitle() || "Markdown Export"}</title>
  <style>
    body { max-width: 860px; margin: 0 auto; padding: 40px 20px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif; line-height: 1.6; }
    ${getExportStyles()}
  </style>
</head>
<body>${html}</body>
</html>`;
  fs.writeFileSync(result.filePath, fullHtml, "utf-8");
});
electron.ipcMain.handle("export:pdf", async (_event, html) => {
  if (!mainWindow) return;
  const result = await electron.dialog.showSaveDialog(mainWindow, {
    filters: [
      { name: "PDF", extensions: ["pdf"] }
    ]
  });
  if (result.canceled || !result.filePath) return;
  const printWindow = new electron.BrowserWindow({
    width: 860,
    height: 1100,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  const fullHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Markdown Export</title>
  <style>
    body { max-width: 860px; margin: 0 auto; padding: 40px 20px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif; line-height: 1.6; }
    ${getExportStyles()}
  </style>
</head>
<body>${html}</body>
</html>`;
  await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fullHtml)}`);
  const pdfData = await printWindow.webContents.printToPDF({
    printBackground: true,
    margins: { top: 20, bottom: 20, left: 20, right: 20 }
  });
  fs.writeFileSync(result.filePath, pdfData);
  printWindow.close();
});
electron.ipcMain.handle("filetree:readFile", async (_event, filePath) => {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return content;
  } catch {
    return null;
  }
});
electron.ipcMain.handle("filetree:readDir", async (_event, dirPath) => {
  try {
    const entries = fs.readdirSync(dirPath);
    const result = [];
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const fullPath = path.join(dirPath, entry);
      const stats = fs.statSync(fullPath);
      const isDir = stats.isDirectory();
      const ext = entry.toLowerCase();
      const isMarkdownFile = !isDir && [".md", ".markdown", ".mdown"].some((e) => ext.endsWith(e));
      if (isDir || isMarkdownFile) {
        result.push({
          name: entry,
          path: fullPath,
          isDirectory: isDir,
          isMarkdown: isMarkdownFile
        });
      }
    }
    result.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
    return result;
  } catch {
    return [];
  }
});
electron.ipcMain.handle("filetree:openDirectory", async () => {
  if (!mainWindow) return null;
  const result = await electron.dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});
electron.ipcMain.handle("filetree:getFileDir", async (_event, filePath) => {
  if (!filePath) return null;
  return path.dirname(filePath);
});
electron.ipcMain.handle("filetree:newFile", async (_event, dirPath) => {
  if (!mainWindow) return null;
  let index = 1;
  let fileName = `untitled-${index}.md`;
  while (fs.existsSync(path.join(dirPath, fileName))) {
    index++;
    fileName = `untitled-${index}.md`;
  }
  const filePath = path.join(dirPath, fileName);
  fs.writeFileSync(filePath, "", "utf-8");
  return { name: fileName, path: filePath };
});
electron.ipcMain.handle("filetree:newFolder", async (_event, dirPath) => {
  let index = 1;
  let folderName = `new-folder-${index}`;
  while (fs.existsSync(path.join(dirPath, folderName))) {
    index++;
    folderName = `new-folder-${index}`;
  }
  const folderPath = path.join(dirPath, folderName);
  fs.mkdirSync(folderPath, { recursive: true });
  return { name: folderName, path: folderPath };
});
electron.ipcMain.handle("filetree:rename", async (_event, oldPath, newName) => {
  try {
    const dir = path.dirname(oldPath);
    const newPath = path.join(dir, newName);
    fs.renameSync(oldPath, newPath);
    return newPath;
  } catch {
    return null;
  }
});
electron.ipcMain.handle("filetree:delete", async (_event, targetPath) => {
  if (!mainWindow) return false;
  const stats = fs.statSync(targetPath);
  const name = path.basename(targetPath);
  const isDir = stats.isDirectory();
  const result = await electron.dialog.showMessageBox(mainWindow, {
    type: "warning",
    buttons: ["取消", "删除"],
    defaultId: 0,
    title: "确认删除",
    message: isDir ? `确定删除文件夹 "${name}" 及其所有内容？` : `确定删除文件 "${name}"？`
  });
  if (result.response !== 1) return false;
  try {
    if (isDir) {
      const deleteRecursive = (dirPath) => {
        const entries = fs.readdirSync(dirPath);
        for (const entry of entries) {
          const fullPath = path.join(dirPath, entry);
          const entryStat = fs.statSync(fullPath);
          if (entryStat.isDirectory()) {
            deleteRecursive(fullPath);
          } else {
            fs.unlinkSync(fullPath);
          }
        }
        fs.rmdirSync(dirPath);
      };
      deleteRecursive(targetPath);
    } else {
      fs.unlinkSync(targetPath);
    }
    return true;
  } catch {
    return false;
  }
});
function getExportStyles() {
  return `
    h1, h2, h3, h4, h5, h6 { margin-top: 24px; margin-bottom: 16px; font-weight: 600; line-height: 1.25; }
    h1 { font-size: 2em; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
    h2 { font-size: 1.5em; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
    h3 { font-size: 1.25em; }
    p { margin-top: 0; margin-bottom: 16px; }
    code { background-color: rgba(27,31,35,0.05); border-radius: 3px; padding: 0.2em 0.4em; font-size: 85%; }
    pre code { padding: 16px; overflow: auto; line-height: 1.45; background-color: #f6f8fa; border-radius: 3px; display: block; }
    blockquote { padding: 0 1em; color: #6a737d; border-left: 0.25em solid #dfe2e5; margin: 0 0 16px 0; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 16px; }
    table th, table td { border: 1px solid #dfe2e5; padding: 6px 13px; }
    table th { background-color: #f6f8fa; }
    img { max-width: 100%; }
    hr { height: 0.25em; padding: 0; margin: 24px 0; background-color: #e1e4e8; border: 0; }
    ul, ol { padding-left: 2em; margin-bottom: 16px; }
    li { word-wrap: break-all; }
  `;
}
electron.app.whenReady().then(() => {
  createSplashWindow();
  updateSplashProgress(15, "正在启动应用...");
  setTimeout(() => {
    updateSplashProgress(30, "加载编辑器组件...");
    createWindow();
    registerS3Handlers();
    registerIndexSearchHandlers();
    registerVectorIndexHandlers();
    updateSplashProgress(65, "初始化服务...");
  }, 200);
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    electron.app.quit();
  }
});
