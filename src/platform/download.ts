/** Save bytes through the browser's normal download flow. */
export function saveBytesAsDownload(bytes: Uint8Array, fileName: string, type = 'application/zip'): void {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.rel = 'noopener'
  document.body.append(a)
  a.click()
  a.remove()
  // Give the browser time to start the download before releasing the bytes.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
