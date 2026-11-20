// auto-repair · 诊断模块
//
// 职责：**只做诊断，不做修复**。把「现在坏在哪」判断清楚，交给 repair.mjs 去修。
// 分开的理由：诊断是只读的，可以随时跑、可以放心在生产环境跑；
// 修复有副作用，必须经过 repair.mjs 的安全阀（白名单 + 备份 + 频次限制）。
//
// 设计原则：
//   1. 每个诊断结论都要有**证据**（文件字节、崩溃日志、端口状态），不能靠猜。
//   2. 诊断不出来就返回 null，交给上层上报 —— 绝不「猜一个原因去修」。
//   3. 严重程度分级，调用方据此决定是自动修还是通知人。

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { listeningPortsSync, processTable } from './tools/net-listeners.mjs'
import { resolveWorkspaceRoot } from './tools/workspace.mjs'

// 工作区根目录：环境变量 AUTO_REPAIR_ROOT → 面板保存的 state/workspace.json → 仓库自身目录。
// 面板里改完会立即写盘，下一次诊断（子进程）就会用新值，不需要改代码或重启。
export const ROOT = resolveWorkspaceRoot()
export const DSH_HOME = path.join(process.env.USERPROFILE || '', '.dsh')
export const DSH_EXE = path.join(ROOT, 'DeepSeek Harness.exe')
export const APP_LOG_DIR = path.join(
  process.env.APPDATA || '',
  '@deepseek-ai', 'dsh-desktop', 'logs'
)

// ── 严重程度 ────────────────────────────────────────────────────────────────
export const SEVERITY = {
  FATAL: 'fatal',     // 应用起不来，必须立刻修
  WARN: 'warn',       // 功能降级，能跑但不对
  INFO: 'info'        // 提示，无需动作
}

/** 诊断结论的统一结构 */
export function finding(severity, code, title, detail, evidence = {}) {
  return { severity, code, title, detail, evidence, at: Date.now() }
}

// ── 通用工具 ────────────────────────────────────────────────────────────────

/** 读文件头几个字节判断是否带 UTF-8 BOM */
export function hasBom(file) {
  try {
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(3)
    const n = fs.readSync(fd, buf, 0, 3, 0)
    fs.closeSync(fd)
    return n === 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  } catch {
    return false
  }
}

/**
 * 列出本机 127.0.0.1 的监听端口 → Map<port, pid>
 *
 * ⚠️ 这里**不能**用 netstat -ano：本机约 98 个 socket 的 State 枚举值是非法的 0，
 *    netstat 完全不列出它们 —— 而 DSH 的服务端口恰好就落在这批里。
 *    用 netstat 的后果是「DSH 明明在跑，却被诊断成没在监听」，
 *    守护进程于是误判、反复拉起 → 新实例撞端口 EADDRINUSE → 秒退。
 *    详细原理见 tools/net-listeners.mjs。
 *
 * 一次 CIM 查询约 0.9s，而一轮诊断要问好几次，所以加了个 2 秒的短缓存。
 */
let _portsCache = null
let _portsCacheAt = 0
const PORTS_CACHE_MS = 5000

export function listeningPorts() {
  const now = Date.now()
  if (_portsCache && now - _portsCacheAt < PORTS_CACHE_MS) return _portsCache
  const map = listeningPortsSync()
  _portsCache = map
  _portsCacheAt = now
  return map
}

/** 某类进程是否在跑（按命令行匹配，不只看进程名，避免同名误判） */
export function processRunning(pattern) {
  try {
    const out = execSync(
      'tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /FO CSV',
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 }
    )
    if (!/DeepSeek Harness\.exe/i.test(out)) return false
  } catch {
    return false
  }
  // 进程名匹配不足以确认 DSH 在跑，还要确认有监听端口
  return true
}

/** DSH 进程持有的监听端口（DSH 端口是随机的） */
export function dshPorts(ports = listeningPorts()) {
  // 从统一快照里挑 DSH 进程 —— 比再起一次 tasklist 快（快照本来就查了进程表）
  const pids = dshProcessIds()
  const out = []
  for (const [port, pid] of ports) if (pids.includes(Number(pid))) out.push(port)
  return out
}

/** DSH 进程 pid 列表（取自进程快照，不额外起进程） */
export function dshProcessIds() {
  return processTable()
    .filter((p) => p.name.toLowerCase() === 'deepseek harness.exe')
    .map((p) => p.pid)
}

// ── 崩溃日志 ────────────────────────────────────────────────────────────────

/** 读最近一个崩溃日志，解析出错误类型 */
export function latestCrash() {
  try {
    const files = fs.readdirSync(APP_LOG_DIR)
      .filter((f) => /^crash-.*-host\.log$/.test(f))
      .sort()
    if (!files.length) return null
    const file = path.join(APP_LOG_DIR, files[files.length - 1])
    const text = fs.readFileSync(file, 'utf8')
    const stat = fs.statSync(file)

    const time = /time:\s*(.+)/.exec(text)?.[1]?.trim() || ''
    const phase = /phase:\s*(.+)/.exec(text)?.[1]?.trim() || ''
    const errMatch = /--- error ---\s*\n([\s\S]*?)\n\s*at /i.exec(text)
    const errText = errMatch ? errMatch[1] : ''

    let kind = 'unknown'
    if (/Unexpected token|is not valid JSON/i.test(errText)) kind = 'json-parse'
    else if (/Cannot find module|ERR_MODULE_NOT_FOUND/i.test(errText)) kind = 'module-missing'
    else if (/EADDRINUSE|address already in use/i.test(errText)) kind = 'port-conflict'
    else if (/ENOENT|no such file/i.test(errText)) kind = 'file-missing'
    else if (/EACCES|permission denied/i.test(errText)) kind = 'permission'
    else if (/out of memory|heap/i.test(errText)) kind = 'memory'

    // 定位是哪个文件出的问题（JSON.parse 场景从栈帧反推）
    let culprit = null
    if (kind === 'json-parse') {
      // readProfileManifest → profile 目录下的 package.json
      const pkg = path.join(DSH_HOME, 'profiles', 'desktop', 'package.json')
      if (fs.existsSync(pkg) && hasBom(pkg)) culprit = pkg
      else {
        // 退而求其次：扫 profile 目录里所有 json
        const dir = path.join(DSH_HOME, 'profiles', 'desktop')
        if (fs.existsSync(dir)) {
          for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith('.json')) continue
            const p = path.join(dir, f)
            if (fs.existsSync(p) && hasBom(p)) { culprit = p; break }
          }
        }
      }
    }

    return {
      file, kind, time, phase,
      errText: errText.slice(0, 400),
      culprit,
      mtime: stat.mtimeMs
    }
  } catch {
    return null
  }
}

// ── 各项诊断 ────────────────────────────────────────────────────────────────

/** 诊断 1：DSH 崩溃且原因是 JSON 带 BOM —— 这是最常见、也最好修的一类 */
export function diagnoseBomCrash() {
  const crash = latestCrash()
  if (!crash) return null
  if (crash.kind !== 'json-parse') return null
  if (!crash.culprit) return null

  // 崩溃日志必须是新鲜的（10 分钟内），否则那是历史遗留，不算「现在坏了」
  const age = Date.now() - crash.mtime
  if (age > 10 * 60 * 1000) return null

  return finding(
    SEVERITY.FATAL,
    'BOM_CRASH',
    'DSH 因配置文件带 UTF-8 BOM 而无法启动',
    `崩溃日志显示 JSON 解析失败，元凶是 ${crash.culprit}。`,
    {
      culprit: crash.culprit,
      crashFile: crash.file,
      crashTime: crash.time,
      crashErr: crash.errText
    }
  )
}

/** 诊断 2：DSH 进程一个都没有（但没有新鲜崩溃日志） */
export function diagnoseDshDead() {
  const ports = listeningPorts()
  const dshPortList = dshPorts(ports)
  if (dshPortList.length > 0) return null  // 还活着

  // 确认进程真的不在（从进程快照里看，不用再起一次 tasklist）
  try {
    const alive = dshProcessIds().length > 0
    if (alive) {
      // 进程在但没有监听端口：可能还在启动中，或者卡住了
      return finding(
        SEVERITY.WARN,
        'DSH_NO_PORT',
        'DSH 进程存在但没有监听端口',
        '进程在跑却没有对外服务端口，可能卡在启动阶段。',
        { alive: true }
      )
    }
  } catch {}

  const crash = latestCrash()
  return finding(
    SEVERITY.FATAL,
    'DSH_DEAD',
    'DSH 进程完全不在了',
    crash
      ? `最近一次崩溃类型：${crash.kind}（${crash.time}）`
      : '没有找到崩溃日志，可能是被手动关掉了。',
    { crashKind: crash?.kind || null }
  )
}

/** 诊断 5：profile 配置文件带 BOM（还没崩，但迟早会崩） */
export function diagnoseLatentBom() {
  const profileDir = path.join(DSH_HOME, 'profiles', 'desktop')
  if (!fs.existsSync(profileDir)) return null
  const risky = []
  for (const f of fs.readdirSync(profileDir)) {
    if (!/\.(json|ya?ml)$/i.test(f)) continue
    if (/\.bak/i.test(f)) continue
    const p = path.join(profileDir, f)
    try {
      if (!fs.statSync(p).isFile()) continue
      if (hasBom(p)) risky.push(p)
    } catch {}
  }
  if (!risky.length) return null
  return finding(
    SEVERITY.WARN,
    'LATENT_BOM',
    'profile 配置文件带 BOM（尚未导致崩溃）',
    `这些文件当前还没让 DSH 崩，但下次启动就会：${risky.join(', ')}`,
    { files: risky }
  )
}

/**
 * 跑一遍完整诊断，返回所有结论。
 * 按严重程度排序，FATAL 在前。
 *
 * ⚠️ 去重：BOM_CRASH 和 LATENT_BOM 可能指向**同一个文件**
 * （崩溃刚发生时，那个文件既导致了崩溃，也确实带 BOM）。
 * 两个都报会导致修复阶段连剥两次 —— 那是真实踩过的坑，会把 `{` 一起吃掉。
 * 所以这里按「文件」去重：同一个文件只保留严重度最高的那个结论。
 */
export async function diagnoseAll() {
  const out = []

  const bom = diagnoseBomCrash()
  if (bom) out.push(bom)

  const dead = diagnoseDshDead()
  if (dead) out.push(dead)

  const latent = diagnoseLatentBom()
  if (latent) out.push(latent)

  const order = { fatal: 0, warn: 1, info: 2 }
  out.sort((a, b) => order[a.severity] - order[b.severity])

  // 按文件去重：同一文件被多个 code 指向时，只留严重度最高的
  const seenFiles = new Set()
  const deduped = []
  for (const f of out) {
    const files = [
      ...(f.evidence?.culprit ? [f.evidence.culprit] : []),
      ...(f.evidence?.files ? f.evidence.files : [])
    ]
    if (files.length && files.every((x) => seenFiles.has(x))) continue
    for (const x of files) seenFiles.add(x)
    deduped.push(f)
  }
  return deduped
}
