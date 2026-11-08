// Child process for power-failure.test.ts: writes "bills" with their lines in one BEGIN IMMEDIATE
// transaction each, forever, using the app's connection settings (WAL + synchronous=NORMAL).
// The test kills it at random moments, like pulling the plug on the app.
const Database = require('better-sqlite3')

const db = new Database(process.argv[2])
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
db.pragma('foreign_keys = ON')
db.pragma('busy_timeout = 5000')
db.exec(`CREATE TABLE IF NOT EXISTS bills (id INTEGER PRIMARY KEY, lines INTEGER NOT NULL, total INTEGER NOT NULL) STRICT;
         CREATE TABLE IF NOT EXISTS bill_lines (bill_id INTEGER NOT NULL REFERENCES bills(id), n INTEGER NOT NULL, amount INTEGER NOT NULL) STRICT;
         CREATE TABLE IF NOT EXISTS stock (id INTEGER PRIMARY KEY, qty INTEGER NOT NULL) STRICT;
         INSERT OR IGNORE INTO stock VALUES (1, 0);`)
const addBill = db.prepare('INSERT INTO bills (lines, total) VALUES (?, ?)')
const addLine = db.prepare('INSERT INTO bill_lines VALUES (?, ?, ?)')
const takeStock = db.prepare('UPDATE stock SET qty = qty - ? WHERE id = 1')
const fixTotal = db.prepare('UPDATE bills SET total = ? WHERE id = ?')

let done = 0
const sell = db.transaction(() => {
  const lines = 1 + Math.floor(Math.random() * 25)
  const id = addBill.run(lines, 0).lastInsertRowid
  let total = 0
  for (let n = 0; n < lines; n++) {
    const amount = 100 + n
    addLine.run(id, n, amount)
    takeStock.run(1)
    total += amount
    // stretch the transaction so a kill often lands in the middle of it
    const until = Date.now() + (Math.random() < 0.3 ? 1 : 0)
    while (Date.now() < until);
  }
  fixTotal.run(total, id)
})
for (;;) {
  sell.immediate()
  if (++done % 20 === 0) process.stdout.write(`${done}\n`)
}
