// auto-repair · 审批策略与手动修复的回归测试
//
// 跑法（在仓库根目录）：
//   node --test scripts/test-repair-policy.mjs
//
// ⚠️ 隔离：所有涉及策略文件的测试都用 REPAIR_STATE_DIR 指到临时目录，
//    绝不去改真实的那份 state/repair-policy.json。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const ENTRY = path.join(ROOT, 'auto-repair.mjs')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-policy-'))
process.env.REPAIR_STATE_DIR = tmpDir

// 策略模块在 import 时读 REPAIR_STATE_DIR，所以必须**动态 import**（静态 import 会被提升）
const { readPolicy, writePolicy, canAutoRepair, canManualRepair, isRejected, MODES } =
  await import('../policy.mjs')

function reset() {
  try { fs.unlinkSync(path.join(tmpDir, 'repair-policy.json')) } catch {}
}

function runCli(args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [ENTRY, ...args],
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', env: { ...process.env, REPAIR_STATE_DIR: tmpDir } },
      (err, stdout, stderr) => {
        let json = null
        try { json = JSON.parse(String(stdout || '').trim()) } catch {}
        resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || ''), json })
      }
    )
  })
}

// ── 策略本身 ────────────────────────────────────────────────────────────────

test('默认策略：逐条审批', () => {
  reset()
  const p = readPolicy()
  assert.equal(p.mode, 'manual')
  assert.deepEqual(p.rejectedCodes, [])
  // manual：守护进程不自动动手，但面板上手工点「修复」是可以的
  assert.equal(canAutoRepair('LATENT_BOM', p), false)
  assert.equal(canManualRepair('LATENT_BOM', p), true)
})

test('全部自动：能自动修，且手工点也能修', () => {
  reset()
  const p = writePolicy({ mode: 'approve-all' })
  assert.equal(p.mode, 'approve-all')
  assert.equal(canAutoRepair('LATENT_BOM', p), true)
  assert.equal(canManualRepair('LATENT_BOM', p), true)
})

test('全拒绝：一律不许修（自动与手工都不行）', () => {
  reset()
  const p = writePolicy({ mode: 'reject-all' })
  assert.equal(p.mode, 'reject-all')
  assert.equal(canAutoRepair('LATENT_BOM', p), false)
  assert.equal(canManualRepair('LATENT_BOM', p), false)
})

test('非法 mode 回落成 manual，不把文件写坏', () => {
  reset()
  const p = writePolicy({ mode: '乱写的' })
  assert.equal(p.mode, 'manual')
  assert.ok(MODES.includes(p.mode))
})

test('逐条忽略：被忽略的 code 不自动修、也不能手工修', () => {
  reset()
  let p = writePolicy({ mode: 'approve-all' })
  assert.equal(canAutoRepair('DSH_DEAD', p), true)

  p = writePolicy({ addRejected: ['DSH_DEAD'] })
  assert.equal(isRejected('DSH_DEAD', p), true)
  assert.equal(canAutoRepair('DSH_DEAD', p), false)
  assert.equal(canManualRepair('DSH_DEAD', p), false)
  // 别的 code 不受影响
  assert.equal(canAutoRepair('LATENT_BOM', p), true)

  p = writePolicy({ removeRejected: ['DSH_DEAD'] })
  assert.equal(isRejected('DSH_DEAD', p), false)
  assert.equal(canAutoRepair('DSH_DEAD', p), true)
})

test('策略文件坏了也不抛错，回落到默认值', () => {
  reset()
  fs.writeFileSync(path.join(tmpDir, 'repair-policy.json'), '{ 这不是 JSON', 'utf8')
  const p = readPolicy()
  assert.equal(p.mode, 'manual')
  assert.deepEqual(p.rejectedCodes, [])
})

test('策略文件写出来不带 BOM（DSH profile 同款坑，不能再踩）', () => {
  reset()
  writePolicy({ mode: 'approve-all' })
  const buf = fs.readFileSync(path.join(tmpDir, 'repair-policy.json'))
  assert.ok(!(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf), '策略文件带了 BOM')
})

// ── CLI 往返 ────────────────────────────────────────────────────────────────

test('CLI：--get-policy / --set-policy 往返', async () => {
  reset()
  const g = await runCli(['--get-policy'])
  assert.equal(g.json?.ok, true)
  assert.equal(g.json?.policy?.mode, 'manual')

  const s = await runCli(['--set-policy', JSON.stringify({ mode: 'approve-all' })])
  assert.equal(s.json?.ok, true)
  assert.equal(s.json?.policy?.mode, 'approve-all')

  const g2 = await runCli(['--get-policy'])
  assert.equal(g2.json?.policy?.mode, 'approve-all')
})

test('CLI：--set-policy 支持增量忽略', async () => {
  reset()
  await runCli(['--set-policy', JSON.stringify({ addRejected: ['DSH_DEAD'] })])
  const g = await runCli(['--get-policy'])
  assert.deepEqual(g.json?.policy?.rejectedCodes, ['DSH_DEAD'])

  await runCli(['--set-policy', JSON.stringify({ removeRejected: ['DSH_DEAD'] })])
  const g2 = await runCli(['--get-policy'])
  assert.deepEqual(g2.json?.policy?.rejectedCodes, [])
})

test('CLI：--check 输出纯 JSON 数组，每条带 fixable 标记', async () => {
  reset()
  const r = await runCli(['--check'], 90000)
  assert.equal(r.err, null, `stderr: ${r.stderr}`)
  assert.ok(Array.isArray(r.json), `--check 不是 JSON 数组：${r.stdout.slice(0, 200)}`)
  for (const f of r.json) {
    assert.equal(typeof f.code, 'string')
    assert.equal(typeof f.fixable, 'boolean')
    assert.equal(typeof f.needsHuman, 'boolean')
    assert.equal(typeof f.rejected, 'boolean')
    assert.equal(typeof f.autoApproved, 'boolean')
  }
})

test('CLI：全拒绝时 --repair 不动手（只报错）', async () => {
  reset()
  await runCli(['--set-policy', JSON.stringify({ mode: 'reject-all' })])
  const r = await runCli(['--repair', 'LATENT_BOM'], 90000)
  assert.equal(r.json?.ok, false)
  assert.match(String(r.json?.error || ''), /全拒绝/)
})

test('CLI：全拒绝时 --repair-all 也不动手', async () => {
  reset()
  await runCli(['--set-policy', JSON.stringify({ mode: 'reject-all' })])
  const r = await runCli(['--repair-all'], 90000)
  assert.equal(r.json?.ok, false)
  assert.match(String(r.json?.error || ''), /全拒绝/)
})

test('CLI：--repair 对不存在的 code 给出明确提示，不乱动', async () => {
  reset()
  await runCli(['--set-policy', JSON.stringify({ mode: 'manual' })])
  const r = await runCli(['--repair', 'NO_SUCH_CODE_XYZ'], 90000)
  assert.equal(r.json?.ok, false)
  assert.match(String(r.json?.error || ''), /没有/)
})

// ── 收尾 ────────────────────────────────────────────────────────────────────

test.after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
})
