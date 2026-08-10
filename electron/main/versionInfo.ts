// 应用版本说明与显示
// 版本号以 package.json 中的 version 为准，这里补充各版本的说明

export interface VersionNote {
  version: string
  date: string
  title: string
  changes: string[]
}

export const VERSION_NOTES: VersionNote[] = [
  {
    version: '1.0.1',
    date: '2026-08-10',
    title: '优化与增强',
    changes: [
      '增加版本说明与显示功能',
      'S3 文件增加右键菜单：删除、显示详情',
      '本地文件树过滤非 Markdown 文件',
      '侧边栏独立背景色变量，便于定制',
      '面包屑与重连/另存按钮同行显示',
      '标签页名称调整：本地文件 / S3'
    ]
  },
  {
    version: '1.0.0',
    date: '2026-07-02',
    title: '首个正式版本',
    changes: [
      '跨平台 Markdown 编辑器（Windows / Linux / macOS）',
      '基于 Electron + Vue 3 构建',
      '实时预览、代码高亮（支持多种语言）',
      '文件树导航、新建/删除/重命名',
      'S3 对象存储访问与另存',
      '双向同步滚动、分割线拖拽调整',
      '亮色/暗色主题自动适配系统配色',
      '导出 HTML / PDF'
    ]
  }
]
