// Rasterizes the Trusplex emblem into terminal cells (quadrant or half-block
// characters, two colors per cell) for the pane's badge. Run with Node and
// Playwright's Chromium: node dev/emblem-cells.mjs <cols> <rows> [half|quad]
// Prints a JSON array of [codePoint, fg, bg|null] rows (null: the badge fill).
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright')

const [cols = 6, rows = 3, mode = 'quad'] = process.argv.slice(2).map((v, i) => (i < 2 ? Number(v) : v))
const svg = readFileSync(new URL('./assets/trusplex-emblem.svg', import.meta.url), 'utf8')
const sub = mode === 'quad' ? [2, 2] : [1, 2]
const W = cols * sub[0], H = rows * sub[1]
const SS = 16 // supersampling per subpixel
// A terminal cell is about twice as tall as it is wide: subpixels are (1/sub0) x (2/sub1) cell-widths.
const pxW = 1 / sub[0], pxH = 2 / sub[1]
const boxW = W * pxW, boxH = H * pxH // in cell-widths
const vb = [894.27, 842.1]
const scale = Math.min(boxW / vb[0], boxH / vb[1])

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium' }).catch(() => chromium.launch())
const page = await browser.newPage()
const data = await page.evaluate(async ({ svg, W, H, SS, pxW, pxH, scale, vb, boxW, boxH }) => {
  const unit = SS / pxW // canvas px per cell-width horizontally
  const cw = W * SS, ch = H * SS * (pxH / pxW)
  const canvas = document.createElement('canvas')
  canvas.width = cw; canvas.height = Math.round(ch)
  const ctx = canvas.getContext('2d')
  const img = new Image()
  img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)))
  await img.decode()
  const dw = vb[0] * scale * unit, dh = vb[1] * scale * unit
  ctx.drawImage(img, (cw - dw) / 2, (canvas.height - dh) / 2, dw, dh)
  const px = ctx.getImageData(0, 0, cw, canvas.height).data
  const out = []
  const sy = canvas.height / H, sx = cw / W
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0, a = 0, n = 0
    for (let j = Math.floor(y * sy); j < Math.floor((y + 1) * sy); j++) for (let i = Math.floor(x * sx); i < Math.floor((x + 1) * sx); i++) {
      const k = (j * cw + i) * 4, al = px[k + 3] / 255
      r += px[k] * al; g += px[k + 1] * al; b += px[k + 2] * al; a += al; n++
    }
    out.push(a > 0 ? [r / a, g / a, b / a, a / n] : [0, 0, 0, 0])
  }
  return out
}, { svg, W, H, SS, pxW, pxH, scale, vb, boxW, boxH })
await browser.close()

const FILL = [0x0b, 0x0b, 0x1b]
const over = ([r, g, b, a]) => [r * a + FILL[0] * (1 - a), g * a + FILL[1] * (1 - a), b * a + FILL[2] * (1 - a)]
const hex = c => (Math.round(c[0]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[2])
const dist = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2
const mean = cs => (cs.length ? [0, 1, 2].map(i => cs.reduce((s, c) => s + c[i], 0) / cs.length) : null)
// quadrant chars by mask bits: 1=TL 2=TR 4=BL 8=BR
const QUAD = { 0: 0x20, 1: 0x2598, 2: 0x259d, 3: 0x2580, 4: 0x2596, 5: 0x258c, 6: 0x259e, 7: 0x259b, 8: 0x2597, 9: 0x259a, 10: 0x2590, 11: 0x259c, 12: 0x2584, 13: 0x2599, 14: 0x259f, 15: 0x2588 }
const HALF = { 0: 0x20, 1: 0x2580, 2: 0x2584, 3: 0x2588 }
const cells = []
for (let cy = 0; cy < rows; cy++) {
  const row = []
  for (let cx = 0; cx < cols; cx++) {
    const subs = []
    for (let j = 0; j < sub[1]; j++) for (let i = 0; i < sub[0]; i++) subs.push(data[(cy * sub[1] + j) * W + cx * sub[0] + i])
    const blended = subs.map(over)
    const n = subs.length
    let best = null
    for (let mask = 0; mask < 1 << n; mask++) {
      const on = blended.filter((_, k) => mask & (1 << k)), off = blended.filter((_, k) => !(mask & (1 << k)))
      const fg = mean(on), bg = mean(off)
      const err = blended.reduce((s, c, k) => s + dist(c, mask & (1 << k) ? fg : bg), 0)
      if (!best || err < best.err - 1e-6) best = { mask, fg, bg, err }
    }
    const table = mode === 'quad' ? QUAD : HALF
    const fgHex = best.fg ? hex(best.fg) : hex(FILL)
    const bgIsFill = !best.bg || dist(best.bg, FILL) < 30
    row.push([table[best.mask], fgHex, bgIsFill ? null : hex(best.bg)])
  }
  cells.push(row)
}
console.log(JSON.stringify(cells))
