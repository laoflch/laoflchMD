import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { useS3Store } from './s3'
import MarkdownIt from 'markdown-it'
import TurndownService from 'turndown'
import { createHighlighterCore, isPlainLang, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import type { ShikiTransformer } from '@shikijs/types'

// ——— Shiki 语法高亮（VS Code 同款 TextMate 引擎） ———
// 首屏只加载常用语言 + 两个主题；其余语言在首次遇到时动态 import 加载。

// 语言加载器映射：显式列出，Vite 只把下列语言打包为独立 chunk，按需加载
const langImporters: Record<string, () => Promise<any>> = {
  javascript: () => import('@shikijs/langs/javascript'),
  typescript: () => import('@shikijs/langs/typescript'),
  json: () => import('@shikijs/langs/json'),
  markdown: () => import('@shikijs/langs/markdown'),
  bash: () => import('@shikijs/langs/bash'),
  shell: () => import('@shikijs/langs/shell'),
  css: () => import('@shikijs/langs/css'),
  scss: () => import('@shikijs/langs/scss'),
  xml: () => import('@shikijs/langs/xml'),
  python: () => import('@shikijs/langs/python'),
  java: () => import('@shikijs/langs/java'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  go: () => import('@shikijs/langs/go'),
  rust: () => import('@shikijs/langs/rust'),
  php: () => import('@shikijs/langs/php'),
  sql: () => import('@shikijs/langs/sql'),
  yaml: () => import('@shikijs/langs/yaml'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  diff: () => import('@shikijs/langs/diff'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  swift: () => import('@shikijs/langs/swift'),
  ruby: () => import('@shikijs/langs/ruby'),
  lua: () => import('@shikijs/langs/lua'),
  perl: () => import('@shikijs/langs/perl'),
  r: () => import('@shikijs/langs/r'),
  nginx: () => import('@shikijs/langs/nginx')
}

// 首屏加载的常用语言（足够欢迎页/常见场景，保持启动轻量；其余语言按需动态加载）
const INITIAL_LANGS = ['javascript', 'json', 'markdown', 'bash']

const THEMES = {
  light: () => import('@shikijs/themes/github-light'),
  dark: () => import('@shikijs/themes/github-dark')
}

// 当前主题（亮/暗），由 store 同步；高亮时据此选择 Shiki 主题
const currentThemeName = ref<'light' | 'dark'>('light')

let highlighterPromise: Promise<HighlighterCore> | null = null

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [THEMES.light(), THEMES.dark()],
      langs: INITIAL_LANGS.map((l) => langImporters[l]()),
      engine: createJavaScriptRegexEngine()
    }).catch((err: unknown) => {
      console.error('[shiki] highlighter init failed', err)
      throw err
    })
  }
  return highlighterPromise
}

// 按需加载语言（带去重，避免并发重复加载同一语言）
const loadingLangs = new Set<string>()
async function ensureLanguage(hi: HighlighterCore, lang: string): Promise<boolean> {
  // plaintext/text/txt 是 shiki 内置特殊语言，无需加载 grammar
  if (isPlainLang(lang)) return true
  if (hi.getLoadedLanguages().includes(lang)) return true
  if (loadingLangs.has(lang)) {
    // 等待并发加载完成
    while (loadingLangs.has(lang)) {
      await new Promise((r) => setTimeout(r, 5))
    }
    return hi.getLoadedLanguages().includes(lang)
  }
  loadingLangs.add(lang)
  try {
    const importer = langImporters[lang]
    if (!importer) return false
    await hi.loadLanguage(importer())
    return true
  } catch {
    return false
  } finally {
    loadingLangs.delete(lang)
  }
}

// 给 Shiki 输出附加 class，便于 Turndown 反向转换时识别代码块与语言
function codeBlockTransformer(lang: string): ShikiTransformer {
  return {
    name: 'code-block-meta',
    pre(node) {
      const cls = Array.isArray(node.properties.class)
        ? node.properties.class.map(String)
        : []
      if (!cls.includes('code-block')) cls.push('code-block')
      node.properties.class = cls
    },
    code(node) {
      const cls = Array.isArray(node.properties.class)
        ? node.properties.class.map(String)
        : []
      if (!cls.includes(`language-${lang}`)) cls.push(`language-${lang}`)
      node.properties.class = cls
    }
  }
}

async function highlightCode(code: string, lang: string): Promise<string> {
  const cleanLang = (lang || '').trim().toLowerCase()
  try {
    const hi = await getHighlighter()
    if (cleanLang && (await ensureLanguage(hi, cleanLang))) {
      return hi.codeToHtml(code, {
        lang: cleanLang,
        theme: currentThemeName.value === 'dark' ? 'github-dark' : 'github-light',
        transformers: [codeBlockTransformer(cleanLang)]
      })
    }
  } catch {
    // 高亮失败，fallthrough 到纯文本
  }
  return `<pre class="code-block"><code>${escapeHtml(code)}</code></pre>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ——— MarkdownIt：highlight 回调同步返回「骨架」（转义原始代码），
// 异步 Shiki 高亮完成后整体替换为带高亮的 HTML ———
interface PendingCodeBlock {
  key: string
  code: string
  lang: string
}
let pendingCodeBlocks: PendingCodeBlock[] = []
let hlSeq = 0

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  breaks: true,
  highlight: (str: string, lang: string): string => {
    const key = `\u0000SHIKI${hlSeq++}\u0000`
    pendingCodeBlocks.push({ key, code: str, lang: lang || '' })
    // 骨架：先渲染转义的原始代码，Shiki 高亮完成后整体替换
    return `<pre class="code-block"><code class="language-${escapeHtml(lang || '')}">${escapeHtml(str)}</code></pre>`
  }
})

// 给渲染出的标题加 id 锚点，便于大纲跳转
function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s]+/g, '-')
    .replace(/[^\w\u4e00-\u9fa5-]/g, '')
}

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

  // 额外的代码块规则：从 Shiki 生成的结构（class="code-block" + language-xxx）恢复原始代码
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

  // —— 异步渲染：先输出骨架（未高亮代码），Shiki 高亮完成后替换 ——
  const renderedHtml = ref('')
  let renderSeq = 0

  async function renderMarkdown(): Promise<void> {
    const batch = ++renderSeq
    const pending: PendingCodeBlock[] = []
    pendingCodeBlocks = pending

    const skeleton = md.render(content.value)
    if (batch !== renderSeq) return
    renderedHtml.value = skeleton

    if (pending.length === 0) return

    const results = await Promise.all(
      pending.map(async (p) => ({ key: p.key, html: await highlightCode(p.code, p.lang) }))
    )
    if (batch !== renderSeq) return

    let final = skeleton
    for (const r of results) {
      final = final.split(r.key).join(r.html)
    }
    renderedHtml.value = final
  }

  // 内容变化或主题切换时重新渲染
  watch(
    [content, isDarkTheme],
    () => {
      currentThemeName.value = isDarkTheme.value ? 'dark' : 'light'
      void renderMarkdown()
    },
    { immediate: true }
  )

  // 供导出（HTML/PDF）使用：确保拿到最新渲染结果
  async function ensureRendered(): Promise<string> {
    await renderMarkdown()
    return renderedHtml.value
  }

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
    ensureRendered,
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
