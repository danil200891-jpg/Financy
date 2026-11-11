/** Downscales an image file to a small data URL for an invoice logo (kept locally and in sync). */
export async function logoDataUrl(file: File, maxSide = 480): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error('Не удалось открыть изображение.'))
      i.src = url
    })
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Не удалось обработать изображение.')
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    // PNG keeps transparent logos; fall back to JPEG when PNG would be too large
    let out = canvas.toDataURL('image/png')
    if (out.length > 300000) out = canvas.toDataURL('image/jpeg', 0.85)
    if (out.length > 390000) throw new Error('Логотип слишком большой. Выберите изображение попроще.')
    return out
  } finally {
    URL.revokeObjectURL(url)
  }
}
