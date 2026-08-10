import {
  S3Client,
  ListBucketsCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand
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
  let endpoint = config.endpoint || undefined
  if (endpoint && !endpoint.startsWith('http')) {
    endpoint = 'http://' + endpoint
  }
  console.log('S3 client config:', { endpoint, region: config.region, accessKeyId: config.accessKeyId })
  return new S3Client({
    endpoint,
    region: config.region || 'us-east-1',
    // 使用路径式寻址，兼容 MinIO 等自建 S3 兼容存储
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    },
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
    try {
      const client = createClient(config)
      const res = await client.send(new ListBucketsCommand({}))
      return (res.Buckets || [])
        .filter((b) => b.Name)
        .map((b) => ({
          name: b.Name as string,
          creationDate: b.CreationDate ? b.CreationDate.toISOString() : null
        }))
    } catch (e: any) {
      console.error('s3:listBuckets error:', e)
      const errMsg = e.message || (e.toString && e.toString()) || '未知错误'
      throw new Error(errMsg)
    }
  })

  // 列出指定桶、前缀下的对象（使用分隔符模拟文件夹浏览）
  ipcMain.handle(
    's3:listObjects',
    async (_event, config: S3Config, bucket: string, prefix: string) => {
      try {
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
          // 只显示 Markdown 文件（.md 结尾），过滤掉其他类型的对象
          .filter((o) => isMarkdownKey(o.Key as string))
          .map((o) => {
            const key = safeDecodeKey(o.Key as string)
            return {
              key,
              name: key.split('/').pop() || '',
              size: o.Size || 0,
              lastModified: o.LastModified ? o.LastModified.toISOString() : null,
              eTag: o.ETag,
              isMarkdown: true
            }
          })

        return { folders, files }
      } catch (e: any) {
        console.error('s3:listObjects error:', e)
        const errMsg = e.message || (e.toString && e.toString()) || '未知错误'
        throw new Error(errMsg)
      }
    }
  )

  // 下载对象内容（按 UTF-8 文本返回，用于打开 Markdown 文件）
  ipcMain.handle(
    's3:getObject',
    async (_event, config: S3Config, bucket: string, key: string) => {
      try {
        const client = createClient(config)
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
        const content = await res.Body?.transformToString('utf-8')
        return content ?? null
      } catch (e: any) {
        console.error('s3:getObject error:', e)
        const errMsg = e.message || (e.toString && e.toString()) || '未知错误'
        throw new Error(errMsg)
      }
    }
  )

  // 上传对象（另存为到 S3）
  ipcMain.handle(
    's3:putObject',
    async (_event, config: S3Config, bucket: string, key: string, content: string) => {
      try {
        const client = createClient(config)
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: content }))
        return { key }
      } catch (e: any) {
        console.error('s3:putObject error:', e)
        const errMsg = e.message || (e.toString && e.toString()) || '未知错误'
        throw new Error(errMsg)
      }
    }
  )

  // 删除对象
  ipcMain.handle(
    's3:deleteObject',
    async (_event, config: S3Config, bucket: string, key: string) => {
      try {
        const client = createClient(config)
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
        return true
      } catch (e: any) {
        console.error('s3:deleteObject error:', e)
        const errMsg = e.message || (e.toString && e.toString()) || '未知错误'
        throw new Error(errMsg)
      }
    }
  )
}
