// pnpm icon — renders resources/icon.svg to resources/icon.png (1024×1024) with Electron's offscreen renderer.
// electron-builder derives the .ico / .icns / Linux icons from icon.png.
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const { join } = require('path')
const SRC = join(__dirname, '..', 'resources', 'icon.svg')
const OUT = join(__dirname, '..', 'resources', 'icon.png')
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, useContentSize: true, webPreferences: { offscreen: true } })
  win.webContents.setZoomFactor(1)
  const svg = fs.readFileSync(SRC, 'utf8')
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((r) => setTimeout(r, 800))
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  const png = img.resize({ width: 1024, height: 1024 }).toPNG()
  fs.writeFileSync(OUT, png)
  console.log('icon', img.getSize(), png.length)
  app.quit()
})
