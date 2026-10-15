import { jsPDF } from 'jspdf'

export function downloadCanvas(canvas: HTMLCanvasElement, filename: string) {
  const link = document.createElement('a')
  link.href = canvas.toDataURL('image/png')
  link.download = filename
  link.click()
}

export function downloadPdf(pages: HTMLCanvasElement[], filename: string) {
  const first = pages[0]
  if (!first) return
  const pdf = new jsPDF({
    orientation: first.width >= first.height ? 'landscape' : 'portrait',
    unit: 'px',
    format: [first.width, first.height],
  })
  pages.forEach((canvas, index) => {
    if (index > 0) pdf.addPage([canvas.width, canvas.height], canvas.width >= canvas.height ? 'landscape' : 'portrait')
    const width = pdf.internal.pageSize.getWidth()
    const height = pdf.internal.pageSize.getHeight()
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, width, height)
  })
  pdf.save(filename)
}
