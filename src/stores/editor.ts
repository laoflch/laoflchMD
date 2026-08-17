import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useS3Store } from './s3'
import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'

// ——— 懒加载语言模块（首屏不注册，首次渲染代码块后异步注册剩余语言） ———
const lazyLanguages: Array<[string, () => any]> = [
  ['bash', () => require('highlight.js/lib/languages/bash')],
  ['shell', () => require('highlight.js/lib/languages/shell')],
  ['typescript', () => require('highlight.js/lib/languages/typescript')],
  ['css', () => require('highlight.js/lib/languages/css')],
  ['scss', () => require('highlight.js/lib/languages/scss')],
  ['xml', () => require('highlight.js/lib/languages/xml')],
  ['python', () => require('highlight.js/lib/languages/python')],
  ['java', () => require('highlight.js/lib/languages/java')],
  ['cpp', () => require('highlight.js/lib/languages/cpp')],
  ['csharp', () => require('highlight.js/lib/languages/csharp')],
  ['go', () => require('highlight.js/lib/languages/go')],
  ['rust', () => require('highlight.js/lib/languages/rust')],
  ['php', () => require('highlight.js/lib/languages/php')],
  ['sql', () => require('highlight.js/lib/languages/sql')],
  ['yaml', () => require('highlight.js/lib/languages/yaml')],
  ['dockerfile', () => require('highlight.js/lib/languages/dockerfile')],
  ['diff', () => require('highlight.js/lib/languages/diff')],
  ['kotlin', () => require('highlight.js/lib/languages/kotlin')],
  ['swift', () => require('highlight.js/lib/languages/swift')],
  ['ruby', () => require('highlight.js/lib/languages/ruby')],
  ['lua', () => require('highlight.js/lib/languages/lua')],
  ['perl', () => require('highlight.js/lib/languages/perl')],
  ['r', () => require('highlight.js/lib/languages/r')],
  ['plaintext', () => require('highlight.js/lib/languages/plaintext')],
  ['nginx', () => require('highlight.js/lib/languages/nginx')]
]

let lazyLanguagesRegistered = false

// 首屏只注册最常用的 3 种语言（足够欢迎页展示）
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('markdown', markdown)

// 空闲时注册其余语言（在首次渲染后的下一个空闲周期执行）
function ensureAllLanguages() {
  if (lazyLanguagesRegistered) return
  lazyLanguagesRegistered = true
  // 用 setTimeout(0) 让出主线程，不阻塞首屏
  setTimeout(() => {
    for (const [name, loader] of lazyLanguages) {
      try {
        const mod = loader()
        hljs.registerLanguage(name, mod.default || mod)
      } catch (e) {
        // 静默忽略加载失败的语言
      }
    }
  }, 0)
}

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
    // 首次进入代码高亮时，触发剩余语言的延迟注册
    if (!lazyLanguagesRegistered) {
      ensureAllLanguages()
    }
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
// 懒初始化 —— 只有在预览区编辑并提交时才创建实例
type TurndownServiceInstance = {
  turndown: (html: string) => string
  addRule: (name: string, rule: any) => void
}

let turndown: TurndownServiceInstance | null = null

function getTurndown(): TurndownServiceInstance {
  if (turndown) return turndown

  const TurndownService = require('turndown') as any
  const instance: TurndownServiceInstance = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*'
  })

  // 额外的代码块规则：从 highlight.js 生成的结构中恢复原始代码
  instance.addRule('codeBlockHighlighted', {
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

  turndown = instance
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