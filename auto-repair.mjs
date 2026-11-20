// auto-repair · 大肥鱼自愈守护
//
// 每 N 秒跑一轮：诊断 → 按**审批策略**决定动不动手 → 修完/修不了都播报。
//
// 定位：这是 **DSH 之外** 的守护进程。
// 为什么不能做成 DSH 插件？因为 DSH 自己起不来的时候插件也加载不了 ——
// 而「起不来」恰恰是最需要自动修的那一类（package.json 带 BOM 就是这么来的）。
// 所以它必须活在 DSH 之外，像 supervisor / watchdog / port-guard 那样独立常驻。
//
// 审批策略（见 policy.mjs，用户在设置页里改）：
//
//   manual       逐条审批（**默认**）
//                守护进程只诊断、只报告，**不自动动手**。
//                用户点某条错误的「修复」才真的修（= --repair <code>）。
//   approve-all  全部自动 —— 守护进程发现能修的直接修。
//   reject-all   全拒绝 —— 一律不修，面板上的修复按钮也禁用，只做报告。
//
// 「修不了怎么办」：
//   白名单修复器之外的故障只报告、不擅自处理。面板上能看到诊断结论与修复历史，
//   需要人判断的（比如 DSH 被手动关掉）留给用户自己决定。
//
// 用法：
//   node auto-repair.mjs                # 常驻巡检
//   node auto-repair.mjs --once         # 跑一轮就退出（按策略，排查用）
//   node auto-repair.mjs --check        # 只诊断不修复，输出 JSON
//   node auto-repair.mjs --repair CODE  # 手动修某一条（= 面板上点「修复」）
//   node auto-repair.mjs --repair-all    # 手动把能修的一次修完
//   node auto-repair.mjs --get-policy   # 输出当前策略 JSON
//   node auto-repair.mjs --set-policy '{"mode":"approve-all"}'  # 改策略

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { diagnoseAll, SEVERITY } from './diagnose.mjs'
import { applyRepair, FIXERS, NEEDS_HUMAN } from './repair.mjs'
import { notify, readNotifyPolicy, repeatAlertGate, feedHashOf } from './notify.mjs'
import { readPolicy, writePolicy, canAutoRepair, isRejected, MODES } from './policy.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STATE = path.join(HERE, 'state')
const LOG = path.join(STATE, 'auto-repair.log')
const PIDFILE = path.join(STATE, 'auto-repair.pid')

const INTERVAL = Number(process.env.AUTO_REPAIR_INTERVAL_MS || 30000)

fs.mkdirSync(STATE, { recursive: true })

// ── 命令行参数 ──────────────────────────────────────────────────────────────

const ARGS = process.argv.slice(2)
const argOf = (name, fallback = '') => {
  const i = ARGS.indexOf(name)
  return i >= 0 ? String(ARGS[i + 1] ?? '').trim() : fallback
}

// --check / --repair / --repair-all / --get-policy / --set-policy 是**命令式调用**
// （面板会调、排查时会调），stdout 必须**只有 JSON**，否则调用方解析不了。
// 所以那时日志只落文件，不写 stdout。
const JSON_ONLY = ARGS.some((a) =>
  ['--check', '--repair', '--repair-all', '--get-policy', '--set-policy', '--notify-test'].includes(a)
)
const QUIET_STDOUT = JSON_ONLY

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${msg}`
  try {
    fs.appendFileSync(LOG, line + '\n', 'utf8')
  } catch {}
  if (!QUIET_STDOUT) console.log(line)
}

// ── 单实例锁 ────────────────────────────────────────────────────────────────

function acquireLock() {
  try {
    const old = Number(String(fs.readFileSync(PIDFILE, 'utf8')).trim())
    if (old && old !== process.pid) {
      try {
        process.kill(old, 0)
        return old   // 已经有一个在跑
      } catch {
        // 进程不在了，锁是陈旧的
      }
    }
  } catch {}
  fs.writeFileSync(PIDFILE, String(process.pid), 'utf8')
  return 0
}

// ⚠️ 命令式调用（--check / --once / --repair …）**不受单实例锁限制**：
//   - --check 只读诊断，多跑几个完全无害
//   - --once 是「手动修一轮」，本来就该允许在守护进程运行时手动触发
//   - --repair 是面板上点了「修复」，更该允许
// 只有「常驻模式」才需要独占锁 —— 否则两个常驻进程会互相打架。
const IS_ONESHOT = JSON_ONLY || ARGS.includes('--once')

if (!IS_ONESHOT) {
  const existing = acquireLock()
  if (existing) {
    log(`已有 auto-repair 在跑 (pid=${existing}))，本实例退出`)
    process.exit(0)
  }
  process.on('exit', () => {
    try {
      if (Number(String(fs.readFileSync(PIDFILE, 'utf8')).trim()) === process.pid) fs.unlinkSync(PIDFILE)
    } catch {}
  })
}

// ── 判定辅助 ────────────────────────────────────────────────────────────────

/** 这个 code 有没有白名单修复器 */
export function isFixable(f) {
  return !!FIXERS[f.code] && !NEEDS_HUMAN.has(f.code)
}

// ── 最近一次修复结果 ────────────────────────────────────────────────────────
//
// 面板要能直接看出来这条问题是不是插件修好的。
// 记在 state/repair-outcomes.json，每轮覆盖，读起来比翻日志快。
const OUTCOME_FILE = path.join(STATE, 'repair-outcomes.json')

export function readOutcomes() {
  try {
    const doc = JSON.parse(fs.readFileSync(OUTCOME_FILE, 'utf8').replace(/^\uFEFF/, ''))
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {}
  } catch {
    return {}
  }
}

function writeOutcome(code, route, detail = '') {
  const all = readOutcomes()
  all[String(code)] = { route, detail: String(detail).slice(0, 200), at: Date.now() }
  try {
    fs.mkdirSync(STATE, { recursive: true })
    fs.writeFileSync(OUTCOME_FILE, JSON.stringify(all, null, 2) + '\n', 'utf8')
  } catch {}
}

// ── 核心：一轮巡检 ──────────────────────────────────────────────────────────

let lastNotified = new Map()

/**
 * 故障提醒的统一出口：先按指纹记一次「又出现了」，再决定要不要弹提醒。
 *
 * 判定「重复」按 code + 级别 + 标题 + 现象文本做指纹，
 * 不另立标准。面板里「重复故障提醒」关掉后，重复出现的那几次不再弹，
 * 但修复、repair-history、守护日志照常，一条不少。
 */
async function notifyFault(f, title, detail, kind = 'l1') {
  try {
    const { suppress, count } = repeatAlertGate(feedHashOf(f))
    if (suppress) {
      log(`   🔇 重复故障提醒已关闭，跳过提醒：${f.code}（该故障累计 ${count} 次）`)
      return
    }
  } catch {}
  return notify(title, detail, kind)
}

/**
 * 跑一轮。
 *
 * @param {object} opts
 * @param {boolean} opts.dryRun      只诊断不修
 * @param {object}  opts.policy      策略（默认现读）
 * @param {boolean} opts.forceRepair 不看 manual 模式，一律修（面板上点「修复」时用）
 */
async function runOnce({ dryRun = false, policy = readPolicy(), forceRepair = false } = {}) {
  let findings
  try {
    findings = await diagnoseAll()
  } catch (e) {
    log(`❌ 诊断异常: ${e?.message || e}`)
    return
  }

  if (!findings.length) {
    log('巡检 ok：一切正常')
    return
  }

  for (const f of findings) {
    const icon = f.severity === SEVERITY.FATAL ? '🔴' : f.severity === SEVERITY.WARN ? '🟡' : '🔵'
    log(`${icon} [${f.code}] ${f.title}`)

    if (dryRun) {
      log(`   （dry-run，不执行修复）${f.detail}`)
      continue
    }

    // ① 用户明确忽略过的 → 一律不动
    if (isRejected(f.code, policy)) {
      log('   ⛔ 你标记过「忽略」，跳过')
      continue
    }

    // ② 全拒绝 → 一律不动
    if (policy.mode === 'reject-all') {
      log('   ⛔ 策略是「全拒绝」，不自动处理')
      continue
    }

    // ③ 能不能自动动手
    const allowed = forceRepair || canAutoRepair(f.code, policy)

    if (!allowed) {
      // 逐条审批模式：只报告，等人在面板上点
      log('   ⏸ 逐条审批模式：等你在设置页点「修复」')
      if (f.severity === SEVERITY.FATAL) {
        const last = lastNotified.get(f.code) || 0
        if (Date.now() - last > 10 * 60 * 1000) {
          await notifyFault(f, `❓ 待你审批：${f.title}`, `${f.detail}\n\n打开设置页 → 自愈 → 点「修复」。`, 'l1')
          lastNotified.set(f.code, Date.now())
        }
      }
      continue
    }

    // ④ 动手修
    const r = await applyRepair(f)

    if (r.ok) {
      log(`   ✅ ${r.action}`)
      if (r.detail) log(r.detail.split('\n').map((l) => '      ' + l).join('\n'))
      writeOutcome(f.code, 'plugin', r.action)
      await notifyFault(f, `✅ 自动修复：${f.title}`, `${r.action}\n${r.detail || f.detail}`, 'l1')
    } else {
      const needHuman = r.action.includes('需人工')
      log(`   ${needHuman ? 'ℹ️' : '⚠️'} ${r.action}`)
      // 只对需要人管的严重问题播报，避免刷屏
      if (f.severity === SEVERITY.FATAL && !needHuman) {
        await notifyFault(f, `⚠️ 自动修复未成功：${f.title}`, `${r.action}\n${f.detail}`, 'sos')
      } else if (needHuman && (f.severity === SEVERITY.FATAL || f.severity === SEVERITY.WARN)) {
        // 同一个问题 10 分钟内只播报一次
        const last = lastNotified.get(f.code) || 0
        if (Date.now() - last > 10 * 60 * 1000) {
          await notifyFault(f, `❓ 需要你处理：${f.title}`, f.detail, f.severity === SEVERITY.FATAL ? 'sos' : 'l1')
          lastNotified.set(f.code, Date.now())
        }
      }
    }
  }
}

// ── 手动修复（面板上点按钮走这里） ───────────────────────────────────────────

/**
 * 手动修某一条 —— 等价于「用户在面板上点了这一条的修复」。
 *
 * 会绕过 manual 模式（否则点了也没用），但**仍然尊重 reject-all**：
 * 全拒绝就是全拒绝，面板上的按钮也应该点不动。
 */
async function repairCodes(codes, { policy = readPolicy() } = {}) {
  if (policy.mode === 'reject-all') {
    return { ok: false, error: '当前策略是「全拒绝」，不执行任何修复。请先在设置页改回「逐条审批」或「全部自动」。' }
  }
  const wanted = new Set(codes.map((c) => String(c).trim()).filter(Boolean))
  const findings = await diagnoseAll()
  const targets = findings.filter((f) => wanted.has(String(f.code)))
  if (!targets.length) {
    return { ok: false, error: `当前没有 ${[...wanted].join('、')} 这类问题（可能已经自己好了）` }
  }
  const results = []
  for (const f of targets) {
    const r = await applyRepair(f)
    if (r.ok) writeOutcome(f.code, 'plugin', r.action)
    results.push(r)
    log(`手动修复 [${f.code}] → ${r.ok ? '✅' : '⚠️'} ${r.action}`)
  }
  const okCount = results.filter((r) => r.ok).length
  return {
    ok: okCount > 0,
    code: targets[0].code,
    repaired: okCount,
    total: results.length,
    results
  }
}

/** 把诊断结果整成带「能不能修 / 要不要人管 / 最近一次是不是插件修好的」的形状，给面板用 */
function enrich(findings, policy) {
  const outcomes = readOutcomes()
  return findings.map((f) => {
    const outcome = outcomes[String(f.code)] || null
    return {
      ...f,
      fixable: isFixable(f),
      needsHuman: NEEDS_HUMAN.has(f.code),
      rejected: isRejected(f.code, policy),
      autoApproved: canAutoRepair(f.code, policy),
      // 'plugin' = 插件自己修好了；null = 还没修过
      route: outcome?.route || null,
      routeAt: Number(outcome?.at) || 0,
      routeDetail: outcome?.detail || ''
    }
  })
}

// ── 入口 ────────────────────────────────────────────────────────────────────

// 模拟一条「自动修复成功」的通知，用来验证通知策略：silent 时应被拦下。
if (ARGS.includes('--notify-test')) {
  const mode = readNotifyPolicy()
  const results = await notify(
    '✅ 自动修复：通知策略自检（模拟）',
    '这是一条模拟的「修复成功」通知，只用于验证当前通知策略会不会对外推送。',
    'l1'
  )
  const pushed = results.some(([, ok]) => ok === true)
  console.log(JSON.stringify({ ok: true, mode, results, pushed }))
  process.exit(0)
}

if (ARGS.includes('--get-policy')) {
  console.log(JSON.stringify({ ok: true, policy: readPolicy(), modes: MODES }))
  process.exit(0)
}

if (ARGS.includes('--set-policy')) {
  const raw = argOf('--set-policy')
  let patch = {}
  try { patch = JSON.parse(raw || '{}') } catch { patch = {} }
  const policy = writePolicy(patch)
  console.log(JSON.stringify({ ok: true, policy }))
  process.exit(0)
}

if (ARGS.includes('--check')) {
  const policy = readPolicy()
  const findings = await diagnoseAll()
  console.log(JSON.stringify(enrich(findings, policy), null, 2))
  process.exit(0)
}

if (ARGS.includes('--repair')) {
  const code = argOf('--repair')
  if (!code) {
    console.log(JSON.stringify({ ok: false, error: '需要 --repair <CODE>' }))
    process.exit(0)
  }
  const r = await repairCodes([code])
  console.log(JSON.stringify(r))
  process.exit(0)
}

if (ARGS.includes('--repair-all')) {
  const policy = readPolicy()
  if (policy.mode === 'reject-all') {
    console.log(JSON.stringify({ ok: false, error: '当前策略是「全拒绝」，不执行任何修复。' }))
    process.exit(0)
  }
  const findings = await diagnoseAll()
  const codes = findings.filter((f) => isFixable(f)).map((f) => f.code)
  if (!codes.length) {
    console.log(JSON.stringify({ ok: false, error: '当前没有可以自动修复的问题' }))
    process.exit(0)
  }
  const r = await repairCodes(codes)
  console.log(JSON.stringify(r))
  process.exit(0)
}

if (ARGS.includes('--once')) {
  await runOnce()
  process.exit(0)
}

// 常驻模式
log(`===== auto-repair 启动 pid=${process.pid}（每 ${INTERVAL / 1000}s 一轮）=====`)
log(`审批策略：${readPolicy().mode}（改策略下一轮生效，不用重启）`)
let running = true
process.on('SIGINT', () => { running = false; process.exit(0) })
process.on('SIGTERM', () => { running = false; process.exit(0) })

await runOnce()
while (running) {
  await new Promise((r) => setTimeout(r, INTERVAL))
  try {
    await runOnce()
  } catch (e) {
    log(`❌ 巡检异常: ${e?.stack || e}`)
  }
}
