import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import shell from 'highlight.js/lib/languages/shell'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import json from 'highlight.js/lib/languages/json'
import css from 'highlight.js/lib/languages/css'
import scss from 'highlight.js/lib/languages/scss'
import xml from 'highlight.js/lib/languages/xml'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import java from 'highlight.js/lib/languages/java'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import php from 'highlight.js/lib/languages/php'
import sql from 'highlight.js/lib/languages/sql'
import yaml from 'highlight.js/lib/languages/yaml'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import diff from 'highlight.js/lib/languages/diff'
import kotlin from 'highlight.js/lib/languages/kotlin'
import swift from 'highlight.js/lib/languages/swift'
import ruby from 'highlight.js/lib/languages/ruby'
import lua from 'highlight.js/lib/languages/lua'
import perl from 'highlight.js/lib/languages/perl'
import r from 'highlight.js/lib/languages/r'
import plaintext from 'highlight.js/lib/languages/plaintext'
import nginx from 'highlight.js/lib/languages/nginx'

hljs.registerLanguage('bash', bash)
hljs.registerLanguage('shell', shell)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('css', css)
hljs.registerLanguage('scss', scss)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('python', python)
hljs.registerLanguage('java', java)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('csharp', csharp)
hljs.registerLanguage('go', go)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('php', php)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('dockerfile', dockerfile)
hljs.registerLanguage('diff', diff)
hljs.registerLanguage('kotlin', kotlin)
hljs.registerLanguage('swift', swift)
hljs.registerLanguage('ruby', ruby)
hljs.registerLanguage('lua', lua)
hljs.registerLanguage('perl', perl)
hljs.registerLanguage('r', r)
hljs.registerLanguage('plaintext', plaintext)
hljs.registerLanguage('nginx', nginx)

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  breaks: true,
  highlight: (str: string, lang: string) => {
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
  const viewMode = ref<ViewMode>('live')
  const isDarkTheme = ref(false)

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
    content.value = newContent
  }

  function setFilePath(path: string | null) {
    filePath.value = path
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
    content.value = ''
    filePath.value = null
  }

  async function openFile() {
    const result = await window.api.openFile()
    if (result) {
      content.value = result.content
      filePath.value = result.filePath
    }
  }

  async function saveFile() {
    const result = await window.api.saveFile(content.value, filePath.value || undefined)
    if (result) {
      filePath.value = result
    }
    return result
  }

  async function saveFileAs() {
    const result = await window.api.saveFileAs(content.value)
    if (result) {
      filePath.value = result
    }
    return result
  }

  return {
    content,
    filePath,
    viewMode,
    isDarkTheme,
    renderedHtml,
    fileName,
    setContent,
    setFilePath,
    setViewMode,
    toggleTheme,
    setTheme,
    insertText,
    newFile,
    openFile,
    saveFile,
    saveFileAs
  }
})