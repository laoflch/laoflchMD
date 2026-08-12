<script setup lang="ts">
import { computed } from 'vue'
import { useEditorStore } from '../stores/editor'

const store = useEditorStore()

interface HeadingItem {
  text: string
  level: number
  line: number
}

const headings = computed<HeadingItem[]>(() => {
  const content = store.content
  if (!content) return []
  const lines = content.split('\n')
  const result: HeadingItem[] = []
  let inCodeBlock = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // 跳过代码块
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock
      continue
    }
    if (inCodeBlock) continue

    // 匹配 # 开头的标题
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (match) {
      result.push({
        text: match[2].trim(),
        level: match[1].length,
        line: i
      })
    }
  }
  return result
})

function scrollToLine(line: number) {
  const textarea = document.querySelector('.editor-textarea') as HTMLTextAreaElement | null
  if (!textarea) return

  const lines = store.content.split('\n')
  let charIndex = 0
  for (let i = 0; i < line; i++) {
    charIndex += lines[i].length + 1
  }

  // 将光标定位到标题行
  textarea.selectionStart = textarea.selectionEnd = charIndex
  textarea.focus()

  // 计算该行在 textarea 中的大致位置并滚动
  const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 20
  const scrollTop = line * lineHeight - textarea.clientHeight / 2
  textarea.scrollTop = Math.max(0, scrollTop)
}
</script>

<template>
  <div class="outline-panel">
    <div class="outline-header">
      <span class="outline-title">文档大纲</span>
      <span class="outline-count">{{ headings.length }}</span>
    </div>
    <div class="outline-list">
      <div v-if="headings.length === 0" class="outline-empty">
        暂无标题，在文档中使用 # 开始的行来创建标题
      </div>
      <div
        v-for="(item, index) in headings"
        :key="index"
        class="outline-item"
        :class="`level-${item.level}`"
        @click="scrollToLine(item.line)"
        :title="item.text"
      >
        <span class="outline-dot"></span>
        <span class="outline-text">{{ item.text }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.outline-panel {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: transparent;
  font-size: 13px;
  overflow: hidden;
}

.outline-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  font-weight: 600;
  color: var(--text-primary);
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.outline-title {
  font-size: 13px;
}

.outline-count {
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  padding: 1px 6px;
  border-radius: 10px;
}

.outline-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px 0;
}

.outline-empty {
  padding: 20px 14px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.6;
}

.outline-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 14px 5px 10px;
  cursor: pointer;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-left: 2px solid transparent;
  transition: all 0.15s ease;
}

.outline-item:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.outline-item.level-1 {
  padding-left: 10px;
  font-weight: 600;
  font-size: 13px;
  color: var(--text-primary);
}

.outline-item.level-2 {
  padding-left: 22px;
  font-weight: 500;
  font-size: 12.5px;
}

.outline-item.level-3 {
  padding-left: 34px;
  font-size: 12px;
}

.outline-item.level-4 {
  padding-left: 46px;
  font-size: 12px;
}

.outline-item.level-5 {
  padding-left: 58px;
  font-size: 12px;
  color: var(--text-muted);
}

.outline-item.level-6 {
  padding-left: 70px;
  font-size: 12px;
  color: var(--text-muted);
}

.outline-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--accent-color);
  flex-shrink: 0;
}

.outline-item.level-1 .outline-dot {
  width: 6px;
  height: 6px;
}

.outline-text {
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
