import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useS3Store } from './s3'
import MarkdownIt from 'markdown-it'
import TurndownService from 'turndown'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'

// ——— 懒加载语言模块（首屏只同步注册常用语言，其余异步预注册） ———
// 使用动态 import()：Vite 会将其拆分为独立 chunk，浏览器环境可用
const lazyLanguages: Array<[string, () => Promise<any>]> = [
  ['bash', () => import('highlight.js/lib/languages/bash')],
  ['shell', () => import('highlight.js/lib/languages/shell')],
  ['typescript', () => import('highlight.js/lib/languages/typescript')],
  ['css', () => import('highlight.js/lib/languages/css')],
  ['scss', () => import('highlight.js/lib/languages/scss')],
  ['xml', () => import('highlight.js/lib/languages/xml')],
  ['python', () => import('highlight.js/lib/languages/python')],
  ['java', () => import('highlight.js/lib/languages/java')],
  ['cpp', () => import('highlight.js/lib/languages/cpp')],
  ['csharp', () => import('highlight.js/lib/languages/csharp')],
  ['go', () => import('highlight.js/lib/languages/go')],
  ['rust', () => import('highlight.js/lib/languages/rust')],
  ['php', () => import('highlight.js/lib/languages/php')],
  ['sql', () => import('highlight.js/lib/languages/sql')],
  ['yaml', () => import('highlight.js/lib/languages/yaml')],
  ['dockerfile', () => import('highlight.js/lib/languages/dockerfile')],
  ['diff', () => import('highlight.js/lib/languages/diff')],
  ['kotlin', () => import('highlight.js/lib/languages/kotlin')],
  ['swift', () => import('highlight.js/lib/languages/swift')],
  ['ruby', () => import('highlight.js/lib/languages/ruby')],
  ['lua', () => import('highlight.js/lib/languages/lua')],
  ['perl', () => import('highlight.js/lib/languages/perl')],
  ['r', () => import('highlight.js/lib/languages/r')],
  ['plaintext', () => import('highlight.js/lib/languages/plaintext')],
  ['nginx', () => import('highlight.js/lib/languages/nginx')]
]

let lazyLanguagesRegistered = false
let lazyLanguagesPromise: Promise<void> | null = null

// 响应式标记：全部语言注册完成。renderedHtml 依赖它，注册完成后自动重渲染，
// 解决「首次渲染时语言尚未加载完导致代码块无高亮」的时序问题
const languagesReady = ref(false)

// 首屏只注册最常用的 3 种语言（足够欢迎页展示）
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('markdown', markdown)

// 异步预注册其余语言（模块加载后立即触发，不阻塞首屏渲染）
function ensureAllLanguages(): Promise<void> {
  if (lazyLanguagesPromise) return lazyLanguagesPromise
  if (lazyLanguagesRegistered) return Promise.resolve()
  lazyLanguagesPromise = (async () => {
    await Promise.all(
      lazyLanguages.map(async ([name, loader]) => {
        try {
          const mod = await loader()
          hljs.registerLanguage(name, mod.default || mod)
        } catch {
          // 静默忽略加载失败的语言
        }
      })
    )
    lazyLanguagesRegistered = true
    languagesReady.value = true
  })()
  return lazyLanguagesPromise
}

// 立即启动语言预注册（不阻塞模块初始化）
void ensureAllLanguages()

// 给渲染出的标题加 id 锚点，便于大纲跳转
function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s]+/g, '-')
    .replace(/[^\w\u4e00-\u9fa5-]/g, '')
}

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  breaks: true,
  highlight: (str: string, lang: string): string => {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="code-block"><code class="hljs language-${lang}">${
          hljs.highlight(str, { language: lang, ignoreIllegals: true }).value
        }</code></pre>`
      } catch (_) {
        // fallthrough
      }
    }
    return `<pre class="code-block"><code class="hljs">${md.utils.escapeHtml(str)}</code></pre>`
  }
})

const originalHeadingOpen = md.renderer.rules.heading_open || function (tokens, idx, options, _env, self) {
  return self.renderToken(tokens, idx, options)
}
md.renderer.rules.heading_open = function (tokens, idx, options, env, self) {
  const next = tokens[idx + 1]
  if (next && next.type === 'inline') {
    const id = 'heading-' + slugify(next.content)
    return `<h${tokens[idx].tag.slice(1)} id="${id}">`
  }
  return originalHeadingOpen(tokens, idx, options, env, self)
}

// Turndown: HTML -> Markdown (用于预览区编辑后回写)
// 懒初始化 —— 模块已打包，但实例化推迟到首次预览区编辑提交时
let turndown: TurndownService | null = null

function getTurndown(): TurndownService {
  if (turndown) return turndown

  turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*'
  })

  // 额外的代码块规则：从 highlight.js 生成的结构中恢复原始代码
  turndown.addRule('codeBlockHighlighted', {
    filter: (node: any) =>
      node.nodeName === 'PRE' &&
      node.className.includes?.('code-block'),
    replacement: function (_content: string, node: any) {
      const codeEl = node.querySelector('code')
      const lang = codeEl?.className.match(/language-(\w+)/)?.[1] || ''
      const code = codeEl?.textContent || node.textContent || ''
      return '\n\n```' + lang + '\n' + code.replace(/\n$/, '') + '\n```\n\n'
    }
  })

  return turndown
}

export type ViewMode = 'edit' | 'preview' | 'live'

export const useEditorStore = defineStore('editor', () => {
  const content = ref(`# 欢迎使用 LaoflchMD 🎉

## 跨平台 Markdown 编辑器

基于 Electron + Vue 3 构建，支持 **Windows**、**Linux** 和 **macOS**。

---

### 功能特性

- **实时预览** — 编辑时即时渲染 Markdown
- **多种视图模式** — 编辑、预览、实时预览
- **代码高亮** — 支持多种编程语言
- **文件管理** — 打开、保存、导出
- **主题切换** — 亮色与暗色主题
- **导出功能** — 导出为 HTML 或 PDF

### 代码示例

\`\`\`javascript
function hello() {
  console.log("Hello, LaoflchMD!");
}
\`\`\`

### 任务列表

- [x] 跨平台支持
- [ ] 更多主题
- [ ] 自定义快捷键

### 表格

| 功能 | 状态 | 版本 |
|------|------|------|
| Markdown 渲染 | ✅ | 1.0 |
| 文件操作 | ✅ | 1.0 |
| 导出 PDF | ✅ | 1.0 |

> **提示**: 使用 \`Ctrl+Shift+T\` 切换主题，\`Ctrl+S\` 保存文件。

开始编辑你的 Markdown 文档吧！
`)

  const filePath = ref<string | null>(null)
  // S3 源信息：当当前文件来自 S3 时记录，用于保存回 S3（而非写入本地相对路径）
  const s3Source = ref<{ bucket: string; key: string } | null>(null)
  const viewMode = ref<ViewMode>('preview')
  const isDarkTheme = ref(false)
  const isModified = ref(false)

  // Undo / Redo history
  const MAX_HISTORY = 200
  const history = ref<string[]>([''])
  let historyIndex = 0

  function pushHistory(state: string) {
    // 丢弃当前分支之后的 redo 历史
    if (historyIndex < history.value.length - 1) {
      history.value = history.value.slice(0, historyIndex + 1)
    }
    history.value.push(state)
    if (history.value.length > MAX_HISTORY) {
      history.value.shift()
    } else {
      historyIndex = history.value.length - 1
    }
  }

  function undo() {
    if (historyIndex > 0) {
      historyIndex--
      content.value = history.value[historyIndex]
    }
  }

  function redo() {
    if (historyIndex < history.value.length - 1) {
      historyIndex++
      content.value = history.value[historyIndex]
    }
  }

  const renderedHtml = computed(() => {
    // 依赖 languagesReady：语言异步注册完成后触发重新渲染，
    // 确保最初未注册的语言（如 rust）也能正确高亮
    languagesReady.value
    return md.render(content.value)
  })

  const fileName = computed(() => {
    if (filePath.value) {
      const parts = filePath.value.split(/[/\\]/)
      return parts[parts.length - 1]
    }
    return '无标题文档'
  })

  function setContent(newContent: string) {
    if (newContent === content.value) return
    pushHistory(content.value)
    content.value = newContent
    isModified.value = true
  }

  function setContentFromHtml(html: string) {
    const mdText = getTurndown().turndown(html)
    setContent(mdText)
  }

  // 预览区(contenteditable)每次内容变动时调用，仅标记为未保存，不做重渲染、不入历史
  function markModified() {
    isModified.value = true
  }

  // 加载文件内容（从文件树/S3 打开时调用）：设置内容、重置历史、标记为未修改
  function loadFile(contentText: string, path: string | null, s3: { bucket: string; key: string } | null = null) {
    history.value = [contentText]
    historyIndex = 0
    content.value = contentText
    filePath.value = path
    s3Source.value = s3
    isModified.value = false
  }

  function setFilePath(path: string | null) {
    filePath.value = path
  }

  function setS3Source(bucket: string | null, key: string | null) {
    s3Source.value = bucket && key ? { bucket, key } : null
  }

  function setViewMode(mode: ViewMode) {
    viewMode.value = mode
  }

  function toggleTheme() {
    isDarkTheme.value = !isDarkTheme.value
  }

  function setTheme(dark: boolean) {
    isDarkTheme.value = dark
  }

  function insertText(before: string, after: string = '') {
    const selection = window.getSelection()
    if (!selection || !selection.rangeCount) {
      content.value += before + after
      return
    }

    // When in edit mode, the textarea approach is simpler
    // We use textarea-based insertion
    const textarea = document.querySelector('.editor-textarea') as HTMLTextAreaElement
    if (textarea) {
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      const selectedText = content.value.substring(start, end)
      const newText = before + selectedText + after
      content.value =
        content.value.substring(0, start) + newText + content.value.substring(end)
      
      // Restore cursor position after Vue reactivity
      requestAnimationFrame(() => {
        textarea.focus()
        textarea.selectionStart = textarea.selectionEnd = start + before.length + selectedText.length
      })
    }
  }

  function newFile() {
    loadFile('', null, null)
  }

  async function openFile() {
    const result = await window.api.openFile()
    if (result) {
      loadFile(result.content, result.filePath, null)
    }
  }

  // 若当前处于可编辑预览态（contenteditable），先把 DOM 中的最新内容同步回 content.value，
  // 否则 Ctrl+S 时（焦点仍在内容区内、未触发 blur）会保存到旧内容。
  function syncEditablePreviewToContent() {
    if (typeof document === 'undefined') return
    const el = document.querySelector(
      '.preview-content[contenteditable="true"]'
    ) as HTMLElement | null
    if (el && el.innerHTML !== undefined) {
      setContentFromHtml(el.innerHTML)
    }
  }

  async function saveFile() {
    syncEditablePreviewToContent()
    console.log('[saveFile] triggered, s3Source=', s3Source.value, 'filePath=', filePath.value,
      'contentLen=', content.value.length, 'contentHead=', JSON.stringify(content.value.slice(0, 80)))

    // S3 文件直接保存回 S3（Ctrl+S 与工具栏「保存」一致）
    if (s3Source.value) {
      const s3 = useS3Store()
      const ok = await s3.putObject(
        s3Source.value.key,
        content.value,
        s3Source.value.bucket
      )
      if (ok) {
        isModified.value = false
        return s3Source.value.key
      }
      return null
    }

    const result = await window.api.saveFile(content.value, filePath.value || undefined)
    console.log('[saveFile] result=', result)
    if (result) {
      filePath.value = result
      isModified.value = false
    }
    return result
  }

  async function saveFileAs() {
    const result = await window.api.saveFileAs(content.value, fileName.value)
    if (result) {
      filePath.value = result
      isModified.value = false
    }
    return result
  }

  return {
    content,
    filePath,
    s3Source,
    viewMode,
    isDarkTheme,
    isModified,
    renderedHtml,
    fileName,
    setContent,
    setContentFromHtml,
    markModified,
    loadFile,
    setFilePath,
    setS3Source,
    setViewMode,
    toggleTheme,
    setTheme,
    insertText,
    newFile,
    openFile,
    saveFile,
    saveFileAs,
    undo,
    redo
  }
})