/**
 * Vendor license desk (pnpm license:tool): a small local web page to issue .LIC files, keep the
 * register of what was issued, renew a shop from its last license, and check a .LIC a shop sends back.
 *
 * Runs only on the vendor's machine, bound to 127.0.0.1 with a random token in the URL (other
 * websites cannot call it). The private key is read from ~/.kposs/license-signing-key.pem
 * (or KPOSS_LICENSE_KEY) and never leaves this process; nothing is written inside the repository.
 *
 *   pnpm license:tool                 → prints the URL (and opens the browser)
 *   pnpm license:tool -- --port 4777 --no-open
 */
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { defaultKeyPath, defaultRegisterPath, fileNameFor, inspect, issue, IssueError, keyStatus, readRegister, type IssueInput } from './license-lib'

const argv = process.argv.slice(2).filter((a) => a !== '--')
const portArg = argv.indexOf('--port')
const port = portArg >= 0 ? Number(argv[portArg + 1]) : 0
const token = randomBytes(16).toString('hex')

function send(res: ServerResponse, status: number, body: string, type = 'application/json; charset=utf-8', extra: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra })
  res.end(body)
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > 64_000) throw new IssueError('request too large')
    chunks.push(c as Buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const host = req.headers.host ?? ''
    // DNS-rebinding guard + token: only this page, opened from the printed URL, may talk to us
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host) || url.searchParams.get('t') !== token) return send(res, 403, 'forbidden', 'text/plain')
    try {
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, PAGE.replace('__TOKEN__', token), 'text/html; charset=utf-8', { 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" })
      if (req.method === 'GET' && url.pathname === '/api/state')
        return send(res, 200, JSON.stringify({ key: keyStatus(), register: defaultRegisterPath(), issued: readRegister().map(({ file: _f, ...e }) => e) }))
      if (req.method === 'GET' && url.pathname.startsWith('/api/file/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/file/'.length))
        const e = readRegister().find((x) => x.licenseId === id)
        if (!e) return send(res, 404, 'not found', 'text/plain')
        const name = fileNameFor(e.licensee, e.hardwareId)
        return send(res, 200, e.file, 'application/octet-stream', { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` })
      }
      if (req.method === 'POST' && url.pathname === '/api/issue') {
        const r = issue((await body(req)) as IssueInput, { keyPath: defaultKeyPath() })
        return send(res, 200, JSON.stringify(r))
      }
      if (req.method === 'POST' && url.pathname === '/api/inspect') {
        const { content } = (await body(req)) as { content?: string }
        return send(res, 200, JSON.stringify(inspect(String(content ?? ''))))
      }
      return send(res, 404, 'not found', 'text/plain')
    } catch (err) {
      return send(res, 400, JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
    }
  })()
})

server.listen(port, '127.0.0.1', () => {
  const addr = server.address()
  const p = typeof addr === 'object' && addr ? addr.port : port
  const link = `http://127.0.0.1:${p}/?t=${token}`
  const k = keyStatus()
  console.log(`KPOSS license desk: ${link}`)
  console.log(`private key: ${k.path} (${k.found ? (k.trusted ? 'matches the app' : 'DOES NOT match the app public key') : 'missing — run pnpm license:keygen'})`)
  console.log(`register:    ${defaultRegisterPath()}`)
  console.log('Ctrl+C to stop')
  if (!argv.includes('--no-open')) {
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', link]] : process.platform === 'darwin' ? ['open', [link]] : ['xdg-open', [link]]
    try {
      spawn(cmd[0] as string, cmd[1] as string[], { stdio: 'ignore', detached: true }).unref()
    } catch {
      // no browser: the URL is printed above
    }
  }
})

const PAGE = /* html */ `<!DOCTYPE html>
<html lang="th"><head><meta charset="utf-8"><title>KPOSS · ออก License</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#F7F5F2;color:#1F2430;font:15px/1.5 'Noto Sans Thai',system-ui,sans-serif}
main{max-width:1180px;margin:0 auto;padding:28px;display:grid;grid-template-columns:420px 1fr;gap:20px}
h1{margin:0;font-size:24px}h2{margin:0 0 12px;font-size:18px}.sub{color:#5C6270;font-size:13px}
.card{background:#fff;border-radius:22px;padding:22px;box-shadow:0 1px 3px rgba(40,30,60,.08);position:relative;overflow:hidden}
.card:before{content:'';position:absolute;top:-40px;right:-40px;width:130px;height:130px;border-radius:50%;background:#EDE9FB}
.card>*{position:relative}label{display:flex;flex-direction:column;gap:6px;font-size:14px;font-weight:600;margin-bottom:12px}
input,select,textarea{min-height:44px;border:1.5px solid #E6E1D9;border-radius:14px;padding:0 14px;font:inherit;background:#fff}
textarea{padding:10px 14px;min-height:120px;font-family:monospace;font-size:12px}
.row{display:flex;gap:10px}.row>*{flex:1}
button{min-height:48px;border:0;border-radius:999px;padding:0 22px;font:inherit;font-weight:700;cursor:pointer}
.primary{background:linear-gradient(90deg,#6A47DB,#9776F6);color:#fff;box-shadow:0 8px 16px rgba(106,71,219,.28)}
.ghost{background:#fff;border:1.5px solid #E6E1D9;color:#1F2430;min-height:40px;padding:0 14px;font-weight:600}
.chip{display:inline-block;border-radius:999px;padding:3px 10px;font-size:12px;font-weight:600}
.ok{background:#DDF5E8;color:#11724A}.warn{background:#FFF4D6;color:#7A5200}.bad{background:#FFE3E3;color:#A6232B}
.msg{border-radius:14px;padding:10px 14px;font-size:14px;margin-top:10px;display:none}
table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;color:#5C6270;font-weight:600;padding:8px}td{padding:8px;border-top:1px solid #EFEBE6;vertical-align:top}
.sw{display:flex;align-items:center;justify-content:space-between;min-height:44px;font-weight:600}
.sw input{appearance:none;width:52px;height:32px;min-height:32px;border-radius:16px;background:#D5D1CA;border:0;padding:0;position:relative;cursor:pointer}
.sw input:checked{background:linear-gradient(90deg,#6A47DB,#9776F6)}.sw input:after{content:'';position:absolute;top:3px;left:3px;width:26px;height:26px;border-radius:50%;background:#fff;transition:left .15s}.sw input:checked:after{left:23px}
</style></head><body><main>
<section style="display:flex;flex-direction:column;gap:20px">
  <div><h1>ออก License KPOSS</h1><div class="sub">เครื่องมือฝั่งผู้ขาย · คีย์ลับอยู่นอกรีโปเท่านั้น</div></div>
  <div class="card"><h2>สถานะคีย์</h2><div id="key" class="sub">กำลังตรวจ…</div></div>
  <form class="card" id="f"><h2>ออก License ใหม่</h2>
    <label>Hardware ID (จากหน้า ตั้งค่า → เครื่องและ License ของร้าน)<input name="hardwareId" required placeholder="HW-XXXX-XXXX-XXXX-XXXX" pattern="[Hh][Ww]-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}"></label>
    <label>ชื่อร้าน / ผู้ได้รับสิทธิ์<input name="licensee" required maxlength="160"></label>
    <div class="row"><label>แพ็กเกจ<input name="plan" value="Standard" maxlength="60"></label>
    <label>อายุ<select name="termKind"><option value="days">จำนวนวัน</option><option value="until">ถึงวันที่</option><option value="perpetual">ถาวร</option></select></label></div>
    <div class="row"><label id="daysL">จำนวนวัน<input name="days" type="number" min="1" max="3650" value="365"></label>
    <label id="untilL" style="display:none">หมดอายุสิ้นวันที่<input name="until" type="date"></label></div>
    <div class="row"><label>พนักงานสูงสุด<input name="maxEmployees" type="number" min="1" max="1000" value="10"></label>
    <label>เครื่องลูก (Client)<input name="maxClients" type="number" min="0" max="100" value="0"></label></div>
    <div class="sw">สำรองขึ้นคลาวด์<input type="checkbox" role="switch" name="cloudBackup"></div>
    <label>หมายเหตุ (เก็บในทะเบียนเท่านั้น)<input name="note" maxlength="300"></label>
    <button class="primary" type="submit" style="width:100%">ออก License และดาวน์โหลด .LIC</button>
    <div id="out" class="msg"></div>
  </form>
  <div class="card"><h2>ตรวจไฟล์ .LIC</h2>
    <label>วางเนื้อหาไฟล์ .LIC<textarea id="lic"></textarea></label>
    <button class="ghost" id="chk" type="button">ตรวจไฟล์</button><div id="chkOut" class="msg"></div>
  </div>
</section>
<section class="card"><h2>ทะเบียน License ที่ออกแล้ว</h2><div class="sub" id="reg"></div>
  <input id="q" placeholder="ค้นหาชื่อร้าน / Hardware ID" style="width:100%;margin:12px 0">
  <table><thead><tr><th>ออกเมื่อ</th><th>ร้าน</th><th>Hardware ID</th><th>หมดอายุ</th><th>สิทธิ์</th><th></th></tr></thead><tbody id="rows"></tbody></table>
</section>
</main>
<script>
const T='__TOKEN__';const api=(p,o)=>fetch(p+(p.includes('?')?'&':'?')+'t='+T,o);
const fmt=ms=>ms==null?'ถาวร':new Date(ms).toLocaleString('th-TH',{timeZone:'Asia/Bangkok',dateStyle:'medium',timeStyle:'short'});
const esc=s=>String(s).replace(/[&<>"']/g,c=>'&#'+c.charCodeAt(0)+';');
let issued=[];const f=document.getElementById('f');
f.termKind.onchange=()=>{daysL.style.display=f.termKind.value==='days'?'':'none';untilL.style.display=f.termKind.value==='until'?'':'none'};
function msg(el,cls,html){el.className='msg '+cls;el.style.display='block';el.innerHTML=html}
function download(name,content){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([content],{type:'application/octet-stream'}));a.download=name;a.click();URL.revokeObjectURL(a.href)}
async function load(){const s=await (await api('/api/state')).json();const k=s.key;
 key.innerHTML=(k.found?(k.trusted?'<span class="chip ok">คีย์ตรงกับแอป</span>':'<span class="chip bad">คีย์ไม่ตรงกับ public key ในแอป</span>'):'<span class="chip bad">ไม่พบคีย์ — รัน pnpm license:keygen</span>')+'<br>'+esc(k.path)+(k.error&&k.found?'<br>'+esc(k.error):'');
 reg.textContent='ไฟล์ทะเบียน: '+s.register+' · '+s.issued.length+' รายการ';issued=s.issued;render()}
function render(){const q=document.getElementById('q').value.trim().toLowerCase();const now=Date.now();
 rows.innerHTML=issued.filter(e=>!q||e.licensee.toLowerCase().includes(q)||e.hardwareId.toLowerCase().includes(q)).map(e=>{
  const st=e.expiresAt==null?'<span class="chip ok">ถาวร</span>':e.expiresAt<now?'<span class="chip bad">หมดอายุ</span>':(e.expiresAt-now<30*864e5?'<span class="chip warn">ใกล้หมด</span>':'<span class="chip ok">ใช้งาน</span>');
  return '<tr><td>'+fmt(e.issuedAt)+'</td><td><strong>'+esc(e.licensee)+'</strong><br><span class="sub">'+esc(e.plan)+(e.note?' · '+esc(e.note):'')+'</span></td><td style="font-family:monospace">'+esc(e.hardwareId)+'</td><td>'+fmt(e.expiresAt)+'<br>'+st+'</td><td class="sub">พนักงาน '+e.features.maxEmployees+' · ลูก '+e.features.maxClients+(e.features.cloudBackup?' · คลาวด์':'')+'</td><td><button class="ghost" data-dl="'+esc(e.licenseId)+'">.LIC</button> <button class="ghost" data-renew="'+esc(e.licenseId)+'">ต่ออายุ</button></td></tr>'}).join('')||'<tr><td colspan="6" class="sub">ยังไม่มีรายการ</td></tr>'}
document.getElementById('q').oninput=render;
rows.onclick=async ev=>{const b=ev.target.closest('button');if(!b)return;
 if(b.dataset.dl){location.href='/api/file/'+encodeURIComponent(b.dataset.dl)+'?t='+T;return}
 const e=issued.find(x=>x.licenseId===b.dataset.renew);if(!e)return;
 f.hardwareId.value=e.hardwareId;f.licensee.value=e.licensee;f.plan.value=e.plan;f.maxEmployees.value=e.features.maxEmployees;f.maxClients.value=e.features.maxClients;f.cloudBackup.checked=e.features.cloudBackup;f.termKind.value='days';f.termKind.onchange();f.days.value=365;f.scrollIntoView({behavior:'smooth'})};
f.onsubmit=async ev=>{ev.preventDefault();const k=f.termKind.value;
 const term=k==='days'?{kind:'days',days:Number(f.days.value)}:k==='until'?{kind:'until',date:f.until.value}:{kind:'perpetual'};
 const r=await api('/api/issue',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({hardwareId:f.hardwareId.value,licensee:f.licensee.value,plan:f.plan.value,term,maxEmployees:Number(f.maxEmployees.value),maxClients:Number(f.maxClients.value),cloudBackup:f.cloudBackup.checked,note:f.note.value})});
 const j=await r.json();if(!r.ok)return msg(out,'bad',esc(j.error));
 download(j.fileName,j.content);msg(out,'ok','ออก License แล้ว: <strong>'+esc(j.fileName)+'</strong><br>หมดอายุ '+fmt(j.payload.expiresAt)+' · ส่งไฟล์ให้ร้านนำเข้าที่ ตั้งค่า → เครื่องและ License');load()};
chk.onclick=async()=>{const r=await (await api('/api/inspect',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:lic.value})})).json();
 if(!r.payload)return msg(chkOut,'bad','ไม่ใช่ไฟล์ .LIC ของ KPOSS');const p=r.payload;
 msg(chkOut,r.ok?'ok':'bad',(r.ok?'ลายเซ็นถูกต้อง':'ลายเซ็นไม่ถูกต้อง ('+esc(r.problem)+')')+'<br>'+esc(p.licensee)+' · '+esc(p.plan)+' · '+esc(p.hardwareId)+'<br>ออก '+fmt(p.issuedAt)+' · หมดอายุ '+fmt(p.expiresAt))};
load();
</script></body></html>`
