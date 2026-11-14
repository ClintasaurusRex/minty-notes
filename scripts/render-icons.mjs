// Renders PNG app icons from public/favicon.svg using the installed Chromium.
// Usage: node scripts/render-icons.mjs
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const svg = readFileSync(new URL('../public/favicon.svg', import.meta.url), 'utf8')
const browser = await chromium.launch()
const page = await browser.newPage()
async function render(size, file, maskable) {
  await page.setViewportSize({ width: size, height: size })
  // Maskable icons keep the artwork inside the central safe zone on a full-bleed background.
  const inner = maskable ? Math.round(size * 0.7) : size
  await page.setContent(`<html><body style="margin:0;background:${maskable ? '#0b0f0e' : 'transparent'};display:grid;place-items:center;width:${size}px;height:${size}px">
    <div style="width:${inner}px;height:${inner}px">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div></body></html>`)
  await page.screenshot({ path: new URL(`../public/icons/${file}`, import.meta.url).pathname, omitBackground: !maskable })
}
await render(192, 'icon-192.png', false)
await render(512, 'icon-512.png', false)
await render(512, 'maskable-512.png', true)
await browser.close()
console.log('icons written')
