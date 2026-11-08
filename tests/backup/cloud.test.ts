import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CloudBackup, decryptBlob, encryptBlob, mirrorFiles, type CloudConfig } from '@main/backup/cloud'
import { signV4, type S3Fetch } from '@main/backup/s3'
import { createTestApp } from '../helpers/app'
import { installLicense } from '../helpers/license'
import { tmpDir } from '../helpers/tmp'

/** In-memory S3 (path-style) that checks every request is signed. */
function fakeS3() {
  const objects = new Map<string, Buffer>()
  const calls: string[] = []
  const fetch: S3Fetch = async (url, init) => {
    const u = new URL(url)
    expect(init.headers['authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIA\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/)
    expect(init.headers['x-amz-content-sha256']).toBe(createHash('sha256').update(init.body ?? '').digest('hex'))
    const [, bucket, ...rest] = u.pathname.split('/')
    expect(bucket).toBe('shop-backup')
    const key = rest.map(decodeURIComponent).join('/')
    calls.push(`${init.method} ${key}`)
    const ok = (body: string | Buffer = '') => ({ ok: true, status: 200, text: async () => String(body), arrayBuffer: async () => new Uint8Array(Buffer.from(body)).buffer })
    if (init.method === 'PUT') {
      objects.set(key, Buffer.from(init.body!))
      return ok()
    }
    if (init.method === 'DELETE') {
      objects.delete(key)
      return ok()
    }
    if (init.method === 'GET' && key) {
      const o = objects.get(key)
      return o ? ok(o) : { ok: false, status: 404, text: async () => '<Error><Code>NoSuchKey</Code></Error>', arrayBuffer: async () => new ArrayBuffer(0) }
    }
    const prefix = u.searchParams.get('prefix') ?? ''
    const items = [...objects.entries()].filter(([k]) => k.startsWith(prefix))
    return ok(`<ListBucketResult><IsTruncated>false</IsTruncated>${items.map(([k, v]) => `<Contents><Key>${k}</Key><Size>${v.length}</Size><LastModified>2026-11-08T00:00:00.000Z</LastModified></Contents>`).join('')}</ListBucketResult>`)
  }
  return { objects, calls, fetch }
}

const CFG: CloudConfig = { endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto', bucket: 'shop-backup', accessKeyId: 'AKIA', secretAccessKey: 'secret', prefix: 'kposs/branch-a', passphrase: 'correct horse battery' }

describe('S3 Signature V4', () => {
  it('matches the AWS test suite vector (get-vanilla)', () => {
    const auth = signV4({
      method: 'GET',
      path: '/',
      query: {},
      headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
      payloadHash: createHash('sha256').update('').digest('hex'),
      region: 'us-east-1',
      service: 'service',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      amzDate: '20150830T123600Z',
    })
    expect(auth).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    )
  })
})

describe('end-to-end encryption of cloud copies (D43)', () => {
  it('round-trips, and refuses a wrong passphrase or a modified file', () => {
    const plain = Buffer.from('SQLite format 3\0 …bills…')
    const blob = encryptBlob(plain, 'pass-1234')
    expect(blob.includes(plain)).toBe(false)
    expect(decryptBlob(blob, 'pass-1234')).toEqual(plain)
    expect(() => decryptBlob(blob, 'wrong-pass')).toThrow()
    const tampered = Buffer.from(blob)
    tampered[40] = tampered[40]! ^ 1
    expect(() => decryptBlob(tampered, 'pass-1234')).toThrow()
  })
})

describe('cloud mirror of the backup folder', () => {
  it('uploads new/changed files, deletes what retention removed, and restores a new machine', async () => {
    const dir = tmpDir('kposs-cloud-')
    mkdirSync(join(dir, 'journal'), { recursive: true })
    writeFileSync(join(dir, 'kposs-snapshot-20261107-030000.sqlite'), 'snap-1')
    writeFileSync(join(dir, 'kposs-snapshot-20261107-030000.sqlite.json'), '{"id":"1"}')
    writeFileSync(join(dir, 'journal', 'seg-tl1-000000000001.jsonl'), '[1]\n')
    writeFileSync(join(dir, 'journal', 'timeline-tl1.json'), '{}')
    writeFileSync(join(dir, 'replaced-20261107.sqlite'), 'not mirrored')
    expect(mirrorFiles(dir)).toEqual(['journal/seg-tl1-000000000001.jsonl', 'journal/timeline-tl1.json', 'kposs-snapshot-20261107-030000.sqlite', 'kposs-snapshot-20261107-030000.sqlite.json'])

    const s3 = fakeS3()
    const cloud = new CloudBackup(dir, async () => CFG, { fetch: s3.fetch })
    const st1 = await cloud.sync()
    expect(st1).toMatchObject({ uploadedFiles: 4, pendingFiles: 0, lastError: null })
    expect([...s3.objects.keys()].sort()).toEqual([
      'kposs/branch-a/journal/seg-tl1-000000000001.jsonl.enc',
      'kposs/branch-a/journal/timeline-tl1.json.enc',
      'kposs/branch-a/kposs-snapshot-20261107-030000.sqlite.enc',
      'kposs/branch-a/kposs-snapshot-20261107-030000.sqlite.json.enc',
    ])
    // the provider only ever sees ciphertext
    for (const v of s3.objects.values()) expect(v.subarray(0, 8).toString()).toBe('KPOSSENC')

    // nothing changed → nothing sent; the journal grows → only that file is sent again
    s3.calls.length = 0
    await cloud.sync()
    expect(s3.calls).toEqual([])
    writeFileSync(join(dir, 'journal', 'seg-tl1-000000000001.jsonl'), '[1]\n[2]\n')
    await cloud.sync()
    expect(s3.calls).toEqual(['PUT kposs/branch-a/journal/seg-tl1-000000000001.jsonl.enc'])

    // retention pruned the snapshot locally → it goes from the cloud too
    rmSync(join(dir, 'kposs-snapshot-20261107-030000.sqlite'))
    rmSync(join(dir, 'kposs-snapshot-20261107-030000.sqlite.json'))
    writeFileSync(join(dir, 'kposs-snapshot-20261108-030000.sqlite'), 'snap-2')
    await cloud.sync()
    expect([...s3.objects.keys()].filter((k) => k.includes('snapshot'))).toEqual(['kposs/branch-a/kposs-snapshot-20261108-030000.sqlite.enc'])

    // a new machine downloads and decrypts everything
    const fresh = tmpDir('kposs-cloud-new-')
    const restored = new CloudBackup(fresh, async () => CFG, { fetch: s3.fetch })
    expect(await restored.downloadAll()).toBe(3)
    expect(readFileSync(join(fresh, 'kposs-snapshot-20261108-030000.sqlite'), 'utf8')).toBe('snap-2')
    expect(readFileSync(join(fresh, 'journal', 'seg-tl1-000000000001.jsonl'), 'utf8')).toBe('[1]\n[2]\n')
    expect(await restored.downloadAll()).toBe(0) // already there

    // the wrong passphrase cannot read it
    const thief = new CloudBackup(tmpDir('kposs-cloud-x-'), async () => ({ ...CFG, passphrase: 'guess-1234' }), { fetch: s3.fetch })
    await expect(thief.downloadAll()).rejects.toMatchObject({ code: 'CLOUD_FAILED' })
  })

  it('ignores object names that would escape the backup folder', async () => {
    const s3 = fakeS3()
    s3.objects.set('kposs/branch-a/../evil.sqlite.enc', encryptBlob(Buffer.from('x'), CFG.passphrase))
    s3.objects.set('kposs/branch-a/journal/../../evil.enc', encryptBlob(Buffer.from('x'), CFG.passphrase))
    const dir = tmpDir('kposs-cloud-esc-')
    expect(await new CloudBackup(join(dir, 'backup'), async () => CFG, { fetch: s3.fetch }).downloadAll()).toBe(0)
    expect(existsSync(join(dir, 'evil.sqlite'))).toBe(false)
  })

  it('through the API: needs the license feature, keeps secrets out of the DB, records errors', async () => {
    const root = tmpDir('kposs-cloud-app-')
    const s3 = fakeS3()
    const t = createTestApp({ files: { dbPath: join(root, 'data', 'kposs.sqlite'), backupDir: join(root, 'backup') }, cloudFetch: s3.fetch })
    await t.setup()
    await t.call(1, 'backup.run')
    const saved = await t.call(1, 'cloud.save', { enabled: true, endpoint: CFG.endpoint, region: 'auto', bucket: CFG.bucket, prefix: CFG.prefix, accessKeyId: 'AKIA', secretAccessKey: 'secret', passphrase: CFG.passphrase })
    expect(saved).toMatchObject({ configured: true, hasSecretKey: true, hasPassphrase: true, licensed: false })
    expect(JSON.stringify(t.db.prepare('SELECT value_json FROM settings').pluck().all())).not.toContain('secret')
    expect(JSON.stringify(saved)).not.toContain(CFG.passphrase)

    await t.fails('CLOUD_NOT_CONFIGURED', 1, 'cloud.syncNow') // trial: no cloud feature (D29)
    await installLicense(t, { features: { cloudBackup: true } })
    const r = await t.call(1, 'cloud.syncNow')
    expect(r.uploadedFiles).toBeGreaterThanOrEqual(2) // snapshot + manifest
    expect(t.auditActions()).toEqual(expect.arrayContaining(['backup.cloud_credentials', 'backup.cloud_sync']))
    expect((await t.call(1, 'cloud.test')).objects).toBe(r.uploadedFiles)

    // a cashier can neither see the bucket settings nor push
    await t.userOn(2, 'cashier1', 'cashier')
    await t.fails('FORBIDDEN', 2, 'cloud.overview')
    await t.fails('FORBIDDEN', 2, 'cloud.syncNow')
  })
})
