import {
  S3Client,
  ListBucketsCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand
} from '@aws-sdk/client-s3'
import { ipcMain } from 'electron'

export interface S3Config {
  /** 自定义端点（如 MinIO），可省略以使用 AWS 默认端点 */
  endpoint?: string
  region?: string
  accessKeyId: string
  secretAccessKey: string
}

function createClient(config: S3Config): S3Client {
  return new S3Client({
    endpoint: config.endpoint || undefined,
    region: config.region || 'us-east-1',
    // 使用路径式寻址，兼容 MinIO 等自建 S3 兼容存储
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  })
}

function isMarkdownKey(key: string): boolean {
  return /\.(md|markdown|mdown)$/i.test(key)
}

// S3 返回的 Key 中可能含 URL 编码字符（如 %E2%80%91），解码为可读形式后再存储/展示；
// 读写时传入解码后的 Key，由 AWS SDK 在请求时自动重新编码。
function safeDecodeKey(key: string): string {
  try {
    return decodeURIComponent(key)
  } catch {
    return key
  }
}

export function registerS3Handlers(): void {
  // 列出所有桶
  ipcMain.handle('s3:listBuckets', async (_event, config: S3Config) => {
    const client = createClient(config)
    const res = await client.send(new ListBucketsCommand({}))
    return (res.Buckets || [])
      .filter((b) => b.Name)
      .map((b) => ({
        name: b.Name as string,
        creationDate: b.CreationDate ? b.CreationDate.toISOString() : null
      }))
  })

  // 列出指定桶、前缀下的对象（使用分隔符模拟文件夹浏览）
  ipcMain.handle(
    's3:listObjects',
    async (_event, config: S3Config, bucket: string, prefix: string) => {
      const client = createClient(config)
      const res = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          Delimiter: '/'
        })
      )

      const folders = (res.CommonPrefixes || [])
        .map((cp) => safeDecodeKey(cp.Prefix || ''))
        .filter(Boolean)

      const files = (res.Contents || [])
        .filter((o) => o.Key && o.Key !== prefix)
        .map((o) => {
          const key = safeDecodeKey(o.Key as string)
          return {
            key,
            name: key.split('/').pop() || '',
            size: o.Size || 0,
            lastModified: o.LastModified ? o.LastModified.toISOString() : null,
            isMarkdown: isMarkdownKey(key)
          }
        })

      return { folders, files }
    }
  )

  // 下载对象内容（按 UTF-8 文本返回，用于打开 Markdown 文件）
  ipcMain.handle(
    's3:getObject',
    async (_event, config: S3Config, bucket: string, key: string) => {
      const client = createClient(config)
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
      const content = await res.Body?.transformToString('utf-8')
      return content ?? null
    }
  )

  // 上传对象（另存为到 S3）
  ipcMain.handle(
    's3:putObject',
    async (_event, config: S3Config, bucket: string, key: string, content: string) => {
      const client = createClient(config)
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: content }))
      return { key }
    }
  )
}
