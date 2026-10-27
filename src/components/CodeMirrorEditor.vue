<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import {
  EditorState,
  Compartment,
  StateEffect,
  StateField,
  type Extension,
  type Range
} from '@codemirror/state'
import {
  EditorView,
  keymap,
  drawSelection,
  placeholder as cmPlaceholder,
  Decoration,
  type DecorationSet
} from '@codemirror/view'
import { defaultKeymap } from '@codemirror/commands'
import {
  syntaxHighlighting,
  HighlightStyle,
  indentUnit,
  bracketMatching,
  StreamLanguage
} from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { yaml } from '@codemirror/lang-yaml'
import { html } from '@codemirror/lang-html'
import { jinja2 } from '@codemirror/legacy-modes/mode/jinja2'
import { useEditorDom, type CodeEditorHandle } from '../composables/useEditorDom'

const props = defineProps<{
  modelValue: string
  fileType: 'markdown' | 'yaml' | 'html' | 'jinja'
  dark: boolean
  placeholder: string
  matches: { start: number; end: number }[]
  currentMatch: number
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  scroll: []
  undo: []
  redo: []
  bold: []
  italic: []
}>()

const editorDom = useEditorDom()
const host = ref<HTMLElement | null>(null)
const view = ref<EditorView | null>(null)

// ——— 主题与高亮样式（颜色随亮/暗主题切换） ———
const lightHighlight = HighlightStyle.define([
  { tag: tags.heading, color: '#005cc5', fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.link, tags.url], color: '#032f62', textDecoration: 'underline' },
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: '#d73a49' },
  { tag: [tags.string, tags.special(tags.string), tags.attributeValue], color: '#032f62' },
  { tag: [tags.number, tags.bool, tags.null], color: '#005cc5' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: '#6a737d', fontStyle: 'italic' },
  { tag: [tags.propertyName, tags.attributeName], color: '#005cc5' },
  { tag: tags.tagName, color: '#22863a' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: '#6f42c1' },
  { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: '#6f42c1' },
  { tag: tags.variableName, color: '#24292e' },
  { tag: [tags.meta, tags.processingInstruction], color: '#6a737d' },
  { tag: tags.monospace, color: '#e36209' }
])

const darkHighlight = HighlightStyle.define([
  { tag: tags.heading, color: '#79b8ff', fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.link, tags.url], color: '#9ecbff', textDecoration: 'underline' },
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: '#f97583' },
  { tag: [tags.string, tags.special(tags.string), tags.attributeValue], color: '#9ecbff' },
  { tag: [tags.number, tags.bool, tags.null], color: '#79b8ff' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: '#6a737d', fontStyle: 'italic' },
  { tag: [tags.propertyName, tags.attributeName], color: '#79b8ff' },
  { tag: tags.tagName, color: '#85e89d' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: '#b392f0' },
  { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: '#b392f0' },
  { tag: tags.variableName, color: '#e1e4e8' },
  { tag: [tags.meta, tags.processingInstruction], color: '#ffab70' },
  { tag: tags.monospace, color: '#e36209' }
])

// 基础外观：沿用原 textarea 的字体、行高与内外边距
const baseTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '14px',
    backgroundColor: 'var(--bg-primary)',
    color: 'var(--text-primary)'
  },
  '.cm-scroller': {
    fontFamily: "'SF Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace",
    lineHeight: '1.7',
    overflow: 'auto'
  },
  '.cm-content': {
    padding: '24px 32px',
    caretColor: 'var(--text-primary)'
  },
  '.cm-line': { padding: '0' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--text-primary)' },
  '.cm-selectionBackground': { backgroundColor: 'rgba(74, 144, 217, 0.28) !important' },
  '.cm-find-match': {
    backgroundColor: 'rgba(255, 213, 79, 0.4)',
    borderRadius: '2px'
  },
  '.cm-find-current': {
    backgroundColor: 'var(--accent-color)',
    color: '#ffffff',
    borderRadius: '2px'
  },
  '.cm-placeholder': { color: 'var(--text-muted)' }
})

function themeExtension(): Extension {
  return [
    baseTheme,
    EditorView.theme({}, { dark: props.dark }),
    syntaxHighlighting(props.dark ? darkHighlight : lightHighlight)
  ]
}

// 按文件类型选择语言
function languageExtension(type: 'markdown' | 'yaml' | 'html' | 'jinja'): Extension {
  switch (type) {
    case 'yaml':
      return yaml()
    case 'html':
      return html()
    case 'jinja':
      return StreamLanguage.define(jinja2)
    default:
      // 使用 GFM 解析器，支持表格、任务列表、删除线等
      return markdown({ base: markdownLanguage })
  }
}

// ——— 查找匹配标记（由父组件传入匹配区间与当前索引） ———
interface FindRanges {
  ranges: { from: number; to: number }[]
  current: number
}

const setFind = StateEffect.define<FindRanges>()

const findField = StateField.define<FindRanges>({
  create: () => ({ ranges: [], current: -1 }),
  update(value, tr) {
    let next = value
    if (tr.docChanged && value.ranges.length) {
      next = {
        ...next,
        ranges: value.ranges.map((r) => ({
          from: tr.changes.mapPos(r.from, 1),
          to: tr.changes.mapPos(r.to, -1)
        }))
      }
    }
    for (const e of tr.effects) {
      if (e.is(setFind)) next = e.value
    }
    return next
  },
  provide: (f) =>
    EditorView.decorations.from(f, (v): DecorationSet => {
      const marks: Range<Decoration>[] = []
      v.ranges.forEach((r, i) => {
        if (r.to <= r.from) return
        marks.push(
          Decoration.mark({
            class: i === v.current ? 'cm-find-current' : 'cm-find-match'
          }).range(r.from, r.to)
        )
      })
      return Decoration.set(marks, true)
    })
})

// ——— 扩展配置分区（切文件类型 / 切主题 / 换占位提示时热替换） ———
const langConf = new Compartment()
const themeConf = new Compartment()
const placeholderConf = new Compartment()

const keymapExt = keymap.of([
  {
    key: 'Mod-z',
    run: () => {
      emit('undo')
      return true
    }
  },
  {
    key: 'Mod-y',
    run: () => {
      emit('redo')
      return true
    }
  },
  {
    key: 'Mod-Shift-z',
    run: () => {
      emit('redo')
      return true
    }
  },
  {
    key: 'Mod-b',
    run: () => {
      emit('bold')
      return true
    }
  },
  {
    key: 'Mod-i',
    run: () => {
      emit('italic')
      return true
    }
  },
  {
    key: 'Tab',
    run: (v) => {
      v.dispatch(v.state.replaceSelection('  '))
      return true
    }
  },
  ...defaultKeymap
])

function onScroll() {
  emit('scroll')
}

onMounted(() => {
  if (!host.value) return
  const instance = new EditorView({
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        keymapExt,
        drawSelection(),
        bracketMatching(),
        indentUnit.of('  '),
        EditorView.lineWrapping,
        findField,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) emit('update:modelValue', u.state.doc.toString())
        }),
        langConf.of(languageExtension(props.fileType)),
        themeConf.of(themeExtension()),
        placeholderConf.of(cmPlaceholder(props.placeholder))
      ]
    }),
    parent: host.value
  })
  view.value = instance
  instance.scrollDOM.addEventListener('scroll', onScroll, { passive: true })
  // 初始查找标记（例如切换视图后重建实例时查找栏仍处于打开状态）
  instance.dispatch({
    effects: setFind.of({
      ranges: props.matches.map((m) => ({ from: m.start, to: m.end })),
      current: props.currentMatch
    })
  })
  editorDom.registerCodeEditor(handle)
})

onBeforeUnmount(() => {
  const instance = view.value
  if (instance) {
    instance.scrollDOM.removeEventListener('scroll', onScroll)
    instance.destroy()
  }
  view.value = null
  editorDom.registerCodeEditor(null)
})

// 外部内容变化（打开文件 / 撤销重做 / 替换 / 切换到本内核）时同步文档
watch(
  () => props.modelValue,
  (val) => {
    const instance = view.value
    if (!instance) return
    const current = instance.state.doc.toString()
    if (current === val) return
    instance.dispatch({ changes: { from: 0, to: current.length, insert: val } })
  }
)

watch(
  () => props.fileType,
  (type) => {
    view.value?.dispatch({ effects: langConf.reconfigure(languageExtension(type)) })
  }
)

watch(
  () => props.dark,
  () => {
    view.value?.dispatch({ effects: themeConf.reconfigure(themeExtension()) })
  }
)

watch(
  () => props.placeholder,
  (text) => {
    view.value?.dispatch({ effects: placeholderConf.reconfigure(cmPlaceholder(text)) })
  }
)

// 查找匹配变化时刷新装饰
watch(
  [() => props.matches, () => props.currentMatch],
  () => {
    const instance = view.value
    if (!instance) return
    instance.dispatch({
      effects: setFind.of({
        ranges: props.matches.map((m) => ({ from: m.start, to: m.end })),
        current: props.currentMatch
      })
    })
  }
)

// ——— 对外句柄：与 textarea 能力对齐 ———
function focus(): void {
  view.value?.focus()
}

function hasFocus(): boolean {
  return view.value?.hasFocus ?? false
}

function getSelectionOffset(): number {
  const instance = view.value
  if (!instance) return 0
  return instance.state.selection.main.head
}

function setSelection(pos: number): void {
  const instance = view.value
  if (!instance) return
  const max = instance.state.doc.length
  const at = Math.max(0, Math.min(max, pos))
  instance.dispatch({ selection: { anchor: at } })
}

function getScrollMetrics(): { top: number; height: number; clientHeight: number } {
  const instance = view.value
  if (!instance) return { top: 0, height: 0, clientHeight: 0 }
  const el = instance.scrollDOM
  return { top: el.scrollTop, height: el.scrollHeight, clientHeight: el.clientHeight }
}

function setScrollTop(top: number): void {
  const instance = view.value
  if (!instance) return
  instance.scrollDOM.scrollTop = top
}

function insertAtSelection(before: string, after: string, current: string): string | null {
  const instance = view.value
  if (!instance) return null
  const { from, to } = instance.state.selection.main
  const selected = current.substring(from, to)
  instance.dispatch({
    changes: { from, to, insert: before + selected + after },
    selection: { anchor: from + before.length + selected.length }
  })
  instance.focus()
  return current.substring(0, from) + before + selected + after + current.substring(to)
}

function scrollToLine(line: number, content: string): void {
  const instance = view.value
  if (!instance) return
  const lines = content.split('\n')
  let offset = 0
  for (let i = 0; i < line && i < lines.length; i++) {
    offset += lines[i].length + 1
  }
  const at = Math.min(offset, instance.state.doc.length)
  instance.dispatch({
    selection: { anchor: at },
    effects: EditorView.scrollIntoView(at, { y: 'start', yMargin: 60 })
  })
  instance.focus()
}

function scrollToMatch(): void {
  const instance = view.value
  if (!instance) return
  const state = instance.state.field(findField, false)
  if (!state) return
  const target = state.ranges[state.current]
  if (!target) return
  instance.dispatch({
    selection: { anchor: target.from, head: target.to },
    effects: EditorView.scrollIntoView(target.from, { y: 'center' })
  })
}

const handle: CodeEditorHandle = {
  insertAtSelection,
  getSelectionOffset,
  setSelection,
  focus,
  hasFocus,
  getScrollMetrics,
  setScrollTop,
  scrollToLine,
  scrollToMatch
}

defineExpose(handle)
</script>

<template>
  <div ref="host" class="cm-host"></div>
</template>

<style scoped>
.cm-host {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
}

.cm-host :deep(.cm-editor) {
  flex: 1;
  min-width: 0;
  height: 100%;
}
</style>
