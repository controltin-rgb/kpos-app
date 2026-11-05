import { BrowserWindow } from 'electron'

/**
 * Prints self-contained HTML through the OS print dialog (the printer model is still an open
 * question — Implement.md §13 #6). Once a receipt printer is configured this can switch to
 * `silent: true` with `deviceName`, or to raw ESC/POS.
 */
export async function printHtml(html: string, opts: { paperMm: 58 | 80 }): Promise<void> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
  })
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    await new Promise<void>((resolve, reject) => {
      win.webContents.print(
        { silent: false, printBackground: true, margins: { marginType: 'none' }, pageSize: { width: opts.paperMm * 1000, height: 297_000 } },
        (success, reason) => (success || reason === 'cancelled' ? resolve() : reject(new Error(reason))),
      )
    })
  } finally {
    if (!win.isDestroyed()) win.close()
  }
}
