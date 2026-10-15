import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

function bytesOf(file: File, count: number) {
  return file.slice(0, count).arrayBuffer()
}

function sniffImage(bytes: Uint8Array) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png' as const
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg' as const
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp' as const
  return ''
}

export async function prepareImage(file: File) {
  if (file.size > 8 * 1024 * 1024) throw new Error('Obraz może mieć najwyżej 8 MB.')
  const kind = sniffImage(new Uint8Array(await bytesOf(file, 16)))
  if (!kind) throw new Error('Dozwolone są pliki PNG, JPG i WebP.')
  const bitmap = await createImageBitmap(file)
  const maxEdge = 1800
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Nie udało się przygotować obrazu.')
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  const type = kind === 'image/jpeg' ? 'image/jpeg' : 'image/png'
  return {
    src: canvas.toDataURL(type, 0.86),
    width,
    height,
    name: file.name,
  }
}

export async function renderPdf(file: File) {
  if (file.size > 20 * 1024 * 1024) throw new Error('PDF może mieć najwyżej 20 MB.')
  const header = new Uint8Array(await file.slice(0, 5).arrayBuffer())
  const signature = String.fromCharCode(...header)
  if (!signature.startsWith('%PDF')) throw new Error('To nie jest plik PDF.')
  const data = new Uint8Array(await file.arrayBuffer())
  const task = getDocument({ data })
  const pdf = await task.promise
  const total = Math.min(pdf.numPages, 20)
  const pages: Array<{ src: string; width: number; height: number }> = []
  for (let index = 1; index <= total; index += 1) {
    const page = await pdf.getPage(index)
    const viewport = page.getViewport({ scale: 1.35 })
    const limit = 1600
    const fit = Math.min(1, limit / Math.max(viewport.width, viewport.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(viewport.width * fit))
    canvas.height = Math.max(1, Math.round(viewport.height * fit))
    const context = canvas.getContext('2d')
    if (!context) continue
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    const fitted = page.getViewport({ scale: 1.35 * fit })
    await page.render({ canvas, canvasContext: context, viewport: fitted }).promise
    pages.push({
      src: canvas.toDataURL('image/jpeg', 0.82),
      width: canvas.width,
      height: canvas.height,
    })
  }
  await pdf.cleanup()
  if (!pages.length) throw new Error('PDF nie zawiera stron.')
  return { pages, truncated: pdf.numPages > total, total: pdf.numPages }
}
