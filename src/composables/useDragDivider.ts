import { ref, onUnmounted } from 'vue'

export interface DragDividerOptions {
  /**
   * 拖拽开始时的回调，参数为原始 mousedown 事件
   */
  onDragStart?: (e: MouseEvent) => void

  /**
   * 拖拽过程中的回调
   * @param deltaX 鼠标 X 轴移动距离
   * @param deltaY 鼠标 Y 轴移动距离
   */
  onDragMove: (deltaX: number, deltaY: number) => void

  /**
   * 拖拽结束时的回调
   */
  onDragEnd?: () => void

  /**
   * 是否阻止默认事件，默认为 true
   */
  preventDefault?: boolean
}

/**
 * 可复用的拖拽分割线组合式函数
 *
 * 提供统一的拖拽交互逻辑，包括：
 * - 事件监听器的自动添加和清理
 * - 光标样式和用户选择控制
 * - 拖拽状态管理
 *
 * @example
 * ```typescript
 * const { isDragging, startDrag } = useDragDivider({
 *   onDragMove: (deltaX) => {
 *     width.value = Math.max(200, Math.min(600, startWidth + deltaX))
 *   },
 *   onDragEnd: () => {
 *     localStorage.setItem('width', String(width.value))
 *   }
 * })
 * ```
 */
export function useDragDivider(options: DragDividerOptions) {
  const {
    onDragStart,
    onDragMove,
    onDragEnd,
    preventDefault = true
  } = options

  const isDragging = ref(false)
  let startX = 0
  let startY = 0

  function startDrag(e: MouseEvent) {
    if (preventDefault) {
      e.preventDefault()
    }

    isDragging.value = true
    startX = e.clientX
    startY = e.clientY

    // 调用开始回调
    onDragStart?.(e)

    // 设置全局样式
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    // 添加事件监听器
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  function onMouseMove(e: MouseEvent) {
    const deltaX = e.clientX - startX
    const deltaY = e.clientY - startY
    onDragMove(deltaX, deltaY)
  }

  function onMouseUp() {
    isDragging.value = false

    // 清理事件监听器
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)

    // 恢复全局样式
    document.body.style.cursor = ''
    document.body.style.userSelect = ''

    // 调用结束回调
    onDragEnd?.()
  }

  // 组件卸载时自动清理
  onUnmounted(() => {
    if (isDragging.value) {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  })

  return {
    isDragging,
    startDrag
  }
}
