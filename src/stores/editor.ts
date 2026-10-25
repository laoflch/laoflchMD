import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { useS3Store } from './s3'
import { useSettingsStore } from './settings'
import { useToastStore } from './toast'
import { useEditorDom } from '../composables/useEditorDom'
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
    const key = `SHIKI${hlSeq++}`
    pendingCodeBlocks.push({ key, code: str, lang: lang || '' })
    // 骨架：先渲染转义的原始代码，并带上唯一锚点 data-hl；
    // Shiki 高亮完成后用锚点把整个代码块替换为带高亮的 HTML
    return `<pre class="code-block" data-hl="${key}"><code class="language-${escapeHtml(lang || '')}">${escapeHtml(str)}</code></pre>`
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

// 保留段落间的连续空行为空段落 <p><br></p>（所见即所得，Typora 行为）：
// markdown-it 默认把段落间的多个空行折叠为一个段落间距，导致预览(contenteditable)里按 Enter
// 产生的空行在保存后切回预览时「消失」。这里在 block 解析后，依据相邻段落 token 的行号差
// （map 差值）恢复空行数量：标准段落间距消耗 1 个空行，额外空行插入等量空段落 HTML。
md.core.ruler.after('block', 'preserveBlankLines', (state: any) => {
  const tokens = state.tokens
  const out: any[] = []
  let prevEnd = -1
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.type === 'paragraph_open' && Array.isArray(t.map)) {
      if (prevEnd >= 0) {
        const blanks = t.map[0] - prevEnd - 1
        for (let b = 0; b < blanks; b++) {
          const tok = new state.Token('html_inline', '', 0)
          tok.content = '<p><br></p>'
          out.push(tok)
        }
      }
      prevEnd = t.map[1]
    }
    out.push(t)
  }
  state.tokens = out
})

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
      // 提取整个 pre 的完整文本，而非仅第一个 code 元素：
      // contenteditable 中编辑代码块时，浏览器会把内容移到 code 外或拆成多个 code，
      // 若只取 code.textContent 会导致编辑点之后的内容在保存时丢失。
      // 同时把 pre 内的 <br>（代码块内按回车产生）转成换行符，否则 textContent 不含换行。
      const clone = node.cloneNode(true)
      const brs = clone.querySelectorAll('br')
      for (let i = 0; i < brs.length; i++) {
        brs[i].replaceWith(clone.ownerDocument.createTextNode('\n'))
      }
      const code = clone.textContent || ''
      return '\n\n```' + lang + '\n' + code.replace(/\n$/, '') + '\n```\n\n'
    }
  })

  // 段落规则（覆盖 turndown 默认 p 规则）：contenteditable 中按 Enter 产生的空段落
  // （<p><br></p> 或 <p></p>）→ \u0000 占位。turndown 的 join 会把相邻块级输出的换行
  // 压缩到最多 1 空行，普通换行替换会被吞掉导致多空行丢失；非空白占位符可绕过该折叠，
  // 转换完成后由 setContentFromHtml 把占位符重建为等量空行。
  turndown.addRule('p', {
    filter: 'p',
    replacement: function (content: string, node: any) {
      if ((node.textContent || '').trim() === '') return '\u0000'
      return '\n\n' + content + '\n\n'
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
      // 用 data-hl 锚点精确定位骨架代码块，整体替换为 Shiki 高亮后的 HTML
      final = final.replace(
        new RegExp(`<pre class="code-block" data-hl="${r.key}">[\\s\\S]*?<\\/pre>`),
        r.html
      )
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
    let mdText = getTurndown().turndown(html)
    // 空段落占位 \u0000 重建为段落间空行：N 个空段落 = N+1 个空行，
    // 与渲染端 preserveBlankLines 插件配对，实现「预览回车 → 保存 → 切回预览」换行不消失
    mdText = mdText.replace(/\n\n(\u0000+)\n\n/g, (_: string, z: string) => '\n\n' + '\n'.repeat(z.length))
    mdText = mdText.replace(/\u0000/g, '\n')
    setContent(mdText.trim())
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
    // 通过编辑器 DOM 句柄在 textarea 当前选区插入，store 不再直接查 DOM
    const next = useEditorDom().insertAtSelection(before, after, content.value)
    if (next === null) {
      // 退化：无可用编辑器节点（组件未挂载等）时追加到末尾
      content.value += before + after
      return
    }
    setContent(next)
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
    const html = useEditorDom().getEditableHtml()
    if (html !== null) {
      // 预览 DOM 与渲染结果一致（用户未编辑）时跳过逆转换，保留原始 Markdown，避免有损转换
      if (html === renderedHtml.value) return
      setContentFromHtml(html)
    }
  }

  // 保存后刷新索引：删除该文件旧的全文/向量索引与 Raft 状态，
  // 再按旧状态里的 has_fulltext / has_vector 标识重新生成（子开关关闭时只清理不重建）
  async function refreshIndexAfterSave(kind: 'local' | 's3', targetPath: string) {
    const settings = useSettingsStore()
    if (!settings.indexEnabled) return
    const s3 = useS3Store()
    const isS3 = kind === 's3'
    const bucket = isS3 ? s3Source.value?.bucket : undefined
    const key = isS3 ? s3Source.value?.key : undefined
    if (isS3 && (!bucket || !key)) return
    const raft = {
      protocol: settings.raftProtocol,
      host: settings.raftHost,
      port: settings.raftProtocol === 'grpc' ? settings.raftGrpcPort : settings.raftRestPort,
      group: settings.raftGroup
    }
    const fulltext = {
      protocol: settings.indexProtocol,
      host: settings.indexProtocol === 'grpc' ? settings.grpcHost : settings.restHost,
      port: settings.indexProtocol === 'grpc' ? settings.grpcPort : settings.restPort,
      indexName: settings.indexName,
      regenerate: settings.fulltextEnabled
    }
    const vector = {
      host: settings.grpcHost,
      port: settings.grpcPort,
      indexName: settings.vectorIndexName,
      modelName: settings.vectorModelName,
      chunkSize: settings.vectorChunkSize,
      overlap: settings.vectorChunkOverlap,
      regenerate: settings.vectorTextEnabled
    }
    try {
      const res = await window.api.indexRefreshAfterSave(
        raft,
        kind,
        targetPath,
        isS3 ? s3.plainConfig() : undefined,
        bucket,
        key,
        fulltext,
        vector
      )
      // message 为空表示该文件没有旧索引，无需重建，不打扰用户
      if (res?.message) {
        const name = targetPath.split(/[\\/]/).pop() || targetPath
        const toastStore = useToastStore()
        toastStore.pushToast(res.ok ? 'ok' : 'err', `${res.message}：${name}`)
      }
    } catch (e) {
      const toastStore = useToastStore()
      toastStore.pushToast('err', `重建索引失败：${e instanceof Error ? e.message : e}`)
    }
  }

  // 同一文件的索引重建串行执行，避免多次快速保存时并发重建互相干扰
  const refreshQueues = new Map<string, Promise<void>>()

  // 保存后异步调度索引重建：立即返回，不阻塞保存；完成后推送提示
  function scheduleRefreshIndexAfterSave(kind: 'local' | 's3', targetPath: string) {
    const taskKey = `${kind}:${targetPath}`
    const prev = refreshQueues.get(taskKey) || Promise.resolve()
    const next = prev.then(() => refreshIndexAfterSave(kind, targetPath))
    refreshQueues.set(taskKey, next)
    void next.finally(() => {
      if (refreshQueues.get(taskKey) === next) refreshQueues.delete(taskKey)
    })
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
        scheduleRefreshIndexAfterSave('s3', s3Source.value.key)
        return s3Source.value.key
      }
      return null
    }

    const result = await window.api.saveFile(content.value, filePath.value || undefined)
    console.log('[saveFile] result=', result)
    if (result) {
      filePath.value = result
      isModified.value = false
      scheduleRefreshIndexAfterSave('local', result)
    }
    return result
  }

  async function saveFileAs() {
    const result = await window.api.saveFileAs(content.value, fileName.value)
    if (result) {
      filePath.value = result
      isModified.value = false
      scheduleRefreshIndexAfterSave('local', result)
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
