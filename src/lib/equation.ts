import katex from 'katex'

export const EQUATION_PRESETS = [
  { label: 'a/b', tex: '\\frac{a}{b}' },
  { label: '√x', tex: '\\sqrt{x}' },
  { label: 'x²', tex: 'x^{2}' },
  { label: 'π', tex: '\\pi' },
  { label: 'α', tex: '\\alpha' },
  { label: 'β', tex: '\\beta' },
  { label: 'θ', tex: '\\theta' },
  { label: 'Δ', tex: '\\Delta' },
  { label: 'Σ', tex: '\\sum_{i=1}^{n}' },
  { label: '≤', tex: '\\le' },
  { label: '≠', tex: '\\ne' },
  { label: '∞', tex: '\\infty' },
]

export async function rasterizeEquation(tex: string, color: string, fontSize: number) {
  const html = katex.renderToString(tex, { throwOnError: false, displayMode: true })
  const host = document.createElement('div')
  host.style.position = 'fixed'
  host.style.left = '0'
  host.style.top = '0'
  host.style.opacity = '0'
  host.style.pointerEvents = 'none'
  host.style.fontSize = `${fontSize}px`
  host.style.color = color
  host.style.padding = '10px 12px'
  host.innerHTML = html
  document.body.appendChild(host)
  await document.fonts.ready
  const origin = host.getBoundingClientRect()
  const scale = 2
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(2, Math.ceil(origin.width * scale))
  canvas.height = Math.max(2, Math.ceil(origin.height * scale))
  const context = canvas.getContext('2d')
  if (!context) {
    host.remove()
    return { src: '', width: 120, height: 48 }
  }
  context.scale(scale, scale)
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    const text = node.textContent ?? ''
    const parent = node.parentElement
    if (text.trim() && parent) {
      const style = getComputedStyle(parent)
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
      context.fillStyle = color
      const range = document.createRange()
      range.selectNodeContents(node)
      for (const rect of range.getClientRects()) {
        context.fillText(text, rect.left - origin.left, rect.top - origin.top + rect.height * 0.8)
      }
    }
    node = walker.nextNode()
  }
  for (const element of host.querySelectorAll<HTMLElement>('*')) {
    const style = getComputedStyle(element)
    const width = Number.parseFloat(style.borderTopWidth)
    if (width > 0 && style.borderTopStyle !== 'none') {
      const rect = element.getBoundingClientRect()
      context.fillStyle = color
      context.fillRect(rect.left - origin.left, rect.top - origin.top, rect.width, width)
    }
  }
  host.remove()
  return {
    src: canvas.toDataURL('image/png'),
    width: Math.max(24, Math.ceil(origin.width)),
    height: Math.max(24, Math.ceil(origin.height)),
  }
}
