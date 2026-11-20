// dsh-auto-repair-ui
// Copyright 2026 蝠羽科技 (fuyu-technology)  —  https://github.com/fuyu-technology
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// 允许二次修改与再分发，但必须保留上述署名与版权声明，不得删除或改写。
// 详见 LICENSE 与 NOTICE。
//

// dsh-auto-repair-ui · 宿主侧
//
// 职责：把 auto-repair 守护进程的数据暴露成 HTTP API，供客户端面板读取和操作。
//
// 它**不自己干活**——真正的诊断和修复都在守护进程（auto-repair.mjs）里，
// 由独立的守护进程执行。这里只是「读状态 + 转发手动触发」的一层壳。
//
// 为什么是这个结构：
//   - 面板是 DSH 插件，跑在 DSH 进程里。DSH 崩了它就没了。
//   - 所以「修 DSH」的逻辑必须在 DSH 之外（auto-repair 守护进程）。
//   - 面板只负责「看」和「手动戳一下」，能力边界清晰。

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const NS = 'dsh-auto-repair-ui'
const API_BASE = '/dsh-auto-repair'
const STATUS_PATH = `${API_BASE}/status`
const DIAGNOSE_PATH = `${API_BASE}/diagnose`
const REPAIR_PATH = `${API_BASE}/repair`
const HISTORY_PATH = `${API_BASE}/history`
const POLICY_PATH = `${API_BASE}/policy`
const REPAIR_ONE_PATH = `${API_BASE}/repair-one`
const REPAIR_ALL_PATH = `${API_BASE}/repair-all`
const IGNORE_PATH = `${API_BASE}/ignore`
const NOTIFY_PATH = `${API_BASE}/notify-policy`
const REPEAT_ALERT_PATH = `${API_BASE}/repeat-alert`
const WORKSPACE_PATH = `${API_BASE}/workspace`
const WORKSPACE_PICK_PATH = `${API_BASE}/workspace/pick`

const HERE = path.dirname(fileURLToPath(import.meta.url))
// auto-repair 守护进程的位置：
//   - 仓库内就地安装时，插件目录就在 auto-repair/ 下，HERE/.. 就是守护进程目录；
//   - 装到 ~/.dsh/plugins 下时两者不在同一棵树，退回插件自身目录（可用 REPAIR_DIR 覆盖）；
//   - 两种情况都可用 REPAIR_DIR 覆盖，方便搬到别的盘符/机器。
const REPAIR_DIR = process.env.REPAIR_DIR || (() => {
  // 两种布局都认：
  //   1) 插件与守护进程同一个仓库（index.js 与 auto-repair.mjs 同级）→ HERE
  //   2) 装到 ~/.dsh/plugins 下、守护进程在 auto-repair/ 子目录 → HERE/..
  for (const c of [HERE, path.resolve(HERE, '..')]) {
    try {
      if (fs.existsSync(path.join(c, 'auto-repair.mjs'))) return c
    } catch {}
  }
  return HERE
})()
const REPAIR_STATE = path.join(REPAIR_DIR, 'state')
const REPAIR_ENTRY = path.join(REPAIR_DIR, 'auto-repair.mjs')

/** 找 node —— 优先用 DSH 自带的那个 */
function findNode() {
  const candidates = [
    path.join(process.env.USERPROFILE || '', '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe')
  ]
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c } catch {}
  }
  return process.execPath
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

// ── 工作区（首次使用 / 重新选择）────────────────────────────────────────────
// 存储：state/workspace.json
// 优先级：环境变量 AUTO_REPAIR_ROOT > 已保存配置 > 未配置（需要用户选）
const WORKSPACE_FILE = path.join(REPAIR_STATE, 'workspace.json')
const DSH_EXE_RE = /^deepseek harness.*\.exe$/i

function hasDshExe(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .some((e) => e.isFile() && DSH_EXE_RE.test(e.name))
  } catch {
    return false
  }
}

/** 校验一个目录是否是可用的工作区根目录（不含 DeepSeek Harness 的都拒绝） */
function validateWorkspace(input) {
  const raw = String(input || '').trim()
  if (!raw) {
    return { ok: false, path: '', missing: ['路径'], message: '请填写或选择工作区目录' }
  }
  const p = path.resolve(raw)
  let st = null
  try { st = fs.statSync(p) } catch {}
  if (!st) {
    return { ok: false, path: p, missing: ['目录不存在'], message: `目录不存在：${p}` }
  }
  if (!st.isDirectory()) {
    return { ok: false, path: p, missing: ['不是目录'], message: `这不是一个目录：${p}` }
  }
  const base = path.basename(p).toLowerCase()
  if (base === 'auto-repair') {
    return {
      ok: false,
      path: p,
      missing: ['层级不对'],
      message: `请选择上一级目录（${path.dirname(p)}），而不是 ${path.basename(p)} 本身`
    }
  }
  const missing = []
  if (!hasDshExe(p)) missing.push('DeepSeek Harness.exe')
  if (missing.length) {
    return {
      ok: false,
      path: p,
      missing,
      message: `这个目录缺少 ${missing.join(' 和 ')}。请选择包含 DeepSeek Harness.exe 的那一级（例如 D:\\大肥鱼）。`
    }
  }
  return { ok: true, path: p, missing: [], message: '' }
}

function readWorkspaceConfig() {
  const doc = readJson(WORKSPACE_FILE, null)
  const v = typeof doc?.workspace === 'string' ? doc.workspace.trim() : ''
  return v ? path.resolve(v) : ''
}

/** 当前工作区快照：给面板显示用 */
function workspaceSnapshot() {
  const envRoot = String(process.env.AUTO_REPAIR_ROOT || '').trim()
  const saved = readWorkspaceConfig()
  const active = envRoot ? path.resolve(envRoot) : saved
  return {
    ok: true,
    // 真正生效的目录；未配置且无环境变量时为 null
    root: active || null,
    source: envRoot ? 'env' : saved ? 'config' : 'unset',
    envRoot: envRoot ? path.resolve(envRoot) : '',
    saved,
    configFile: WORKSPACE_FILE,
    // 首次使用：既没有环境变量、也没有保存过
    needsSetup: !envRoot && !saved,
    validation: active ? validateWorkspace(active) : null
  }
}

function saveWorkspaceConfig(dir) {
  fs.mkdirSync(REPAIR_STATE, { recursive: true })
  const tmp = `${WORKSPACE_FILE}.tmp`
  const doc = { version: 1, workspace: path.resolve(dir), updatedAt: Date.now() }
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8')
  fs.renameSync(tmp, WORKSPACE_FILE)
  return doc
}

/** 传给守护进程子进程的工作区（校验不过就不传，让它走自己的兜底） */
function currentWorkspaceRoot() {
  const snap = workspaceSnapshot()
  if (!snap.root) return ''
  return snap.validation && snap.validation.ok ? snap.root : ''
}

/** 每次调 CLI 都按「当前工作区」注入，面板里改完下一次调用立即生效 */
function childEnv() {
  const ws = currentWorkspaceRoot()
  return ws ? { ...process.env, AUTO_REPAIR_ROOT: ws } : process.env
}

/** 调系统「选择文件夹」对话框（Windows，返回绝对路径） */
function pickFolderViaShell() {
  return new Promise((resolve) => {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
      "$d.Description = '选择工作区根目录（包含 DeepSeek Harness.exe 的那一级）';",
      "$d.ShowNewFolderButton = $false;",
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }'
    ].join(' ')
    execFile(
      'powershell.exe',
      ['-NoProfile', '-STA', '-Command', script],
      { timeout: 180000, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => {
        const picked = String(stdout || '').trim()
        if (err || !picked) {
          resolve({ ok: false, error: picked ? '' : '没有选择目录' })
          return
        }
        resolve({ ok: true, path: picked })
      }
    )
  })
}

/** 读 POST 请求体（JSON） */
function readBody(req) {
  return new Promise((resolve) => {
    let buf = ''
    req.on('data', (c) => { buf += c; if (buf.length > 2e6) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
}

/**
 * 调 auto-repair 的 CLI。
 *
 * ⚠️ 为什么不直接在插件里 import 守护进程的模块？
 *   插件装在 ~/.dsh/plugins/ 下，守护进程在 D:\大肥鱼\auto-repair\ ——
 *   两棵完全不同的目录树，import 不到。只能以子进程方式调 CLI。
 *   好处也在这里：**策略与修复逻辑只有一份实现**（在守护进程那边），
 *   插件只负责传参和显示结果，不会出现两边逻辑对不上的情况。
 */
function runCli(args, timeoutMs = 90000) {
  return new Promise((resolve) => {
    if (!fs.existsSync(REPAIR_ENTRY)) {
      resolve({ ok: false, error: '找不到 auto-repair 脚本', stdout: '', stderr: '' })
      return
    }
    try {
      execFile(
        findNode(),
        [REPAIR_ENTRY, ...args],
        {
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
          encoding: 'utf8',
          // 每次调 CLI 都按「当前工作区」注入，面板里改完立即生效（下一次诊断就走新目录）
          env: childEnv()
        },
        (err, stdout, stderr) => {
          const out = String(stdout || '')
          const errOut = String(stderr || '')
          let json = null
          try { json = JSON.parse(out.trim() || 'null') } catch {}
          resolve({
            ok: !err,
            json,
            stdout: out,
            stderr: errOut,
            error: err ? err.message : ''
          })
        }
      )
    } catch (e) {
      resolve({ ok: false, error: e.message, stdout: '', stderr: '' })
    }
  })
}

/**
 * 读当前审批策略。
 *
 * 直接读 state/repair-policy.json —— 这里**只是显示**，不参与任何判定，
 * 所以不调用 CLI 也行（省一次子进程启动）。真正的写操作一律走
 * `--set-policy`，保证合并语义只有 policy.mjs 一份实现。
 */
function readPolicyFile() {
  const doc = readJson(path.join(REPAIR_STATE, 'repair-policy.json'), null)
  const src = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {}
  return {
    mode: ['manual', 'approve-all', 'reject-all'].includes(String(src.mode)) ? String(src.mode) : 'manual',
    rejectedCodes: Array.isArray(src.rejectedCodes) ? src.rejectedCodes.map(String) : [],
    updatedAt: Number(src.updatedAt) || 0
  }
}

/** 写策略（走 CLI，合并语义由 policy.mjs 负责） */
async function writePolicy(patch) {
  const r = await runCli(['--set-policy', JSON.stringify(patch)], 20000)
  if (r.json?.policy) return { ok: true, policy: r.json.policy }
  return { ok: false, error: r.json?.error || r.error || r.stderr || '改策略失败' }
}

// 「自动修复通知策略」：一个总开关，管所有对外推送（需求箱 / Windows 气泡）。
// 默认 notify（维持现状）；silent = 照常修、只不推送，面板历史与日志照常记录。
const NOTIFY_POLICY_FILE = path.join(REPAIR_STATE, 'notify-policy.json')

function readNotifyPolicy() {
  const doc = readJson(NOTIFY_POLICY_FILE, null) || {}
  const mode = doc.mode === 'silent' ? 'silent' : 'notify'
  return { mode, updatedAt: Number(doc.updatedAt) || 0 }
}

function writeNotifyPolicy(mode) {
  const next = mode === 'silent' ? 'silent' : 'notify'
  try {
    fs.mkdirSync(REPAIR_STATE, { recursive: true })
    const doc = { version: 1, mode: next, updatedAt: Date.now() }
    const tmp = `${NOTIFY_POLICY_FILE}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8')
    fs.renameSync(tmp, NOTIFY_POLICY_FILE)
    return { ok: true, ...doc }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}

// 「同一故障重复出现」的提醒开关：和通知总开关并列，互不影响。
// on（默认）= 照旧提醒；off = 同一故障再次出现时不弹提醒，但修复与历史照常。
const REPEAT_ALERT_FILE = path.join(REPAIR_STATE, 'repeat-alert.json')

function readRepeatAlert() {
  const doc = readJson(REPEAT_ALERT_FILE, null) || {}
  return {
    mode: doc.mode === 'off' ? 'off' : 'on',
    updatedAt: Number(doc.updatedAt) || 0
  }
}

function writeRepeatAlert(mode) {
  const next = mode === 'off' ? 'off' : 'on'
  try {
    fs.mkdirSync(REPAIR_STATE, { recursive: true })
    const old = readJson(REPEAT_ALERT_FILE, null)
    const doc = {
      ...(old && typeof old === 'object' ? old : {}),
      version: 1,
      mode: next,
      updatedAt: Date.now()
    }
    const tmp = `${REPEAT_ALERT_FILE}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, REPEAT_ALERT_FILE)
    return { ok: true, mode: doc.mode, updatedAt: doc.updatedAt }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}

/** 守护进程是否在跑（读它自己的 pid 锁） */
function daemonAlive() {
  try {
    const pid = Number(String(fs.readFileSync(path.join(REPAIR_STATE, 'auto-repair.pid'), 'utf8')).trim())
    if (!pid) return { alive: false, pid: 0 }
    try {
      process.kill(pid, 0)
      return { alive: true, pid }
    } catch {
      return { alive: false, pid }
    }
  } catch {
    return { alive: false, pid: 0 }
  }
}

/** 读最近 N 条修复历史 */
function recentHistory(limit = 40) {
  try {
    const file = path.join(REPAIR_STATE, 'repair-history.jsonl')
    if (!fs.existsSync(file)) return []
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    const out = []
    for (const line of lines.slice(-limit).reverse()) {
      try {
        const o = JSON.parse(line)
        out.push({
          at: o.at,
          code: o.code,
          title: o.title,
          ok: !!o.ok,
          attempted: o.attempted !== false,
          action: o.action,
          detail: o.detail || ''
        })
      } catch {}
    }
    return out
  } catch {
    return []
  }
}

/** 读巡检日志尾部 */
function recentLog(limit = 60) {
  try {
    const file = path.join(REPAIR_STATE, 'auto-repair.log')
    if (!fs.existsSync(file)) return []
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    return lines.slice(-limit).reverse()
  } catch {
    return []
  }
}

/** 频次计数 */
function counters() {
  return readJson(path.join(REPAIR_STATE, 'repair-counter.json'), {})
}

/** 跑一次 auto-repair CLI（只诊断不修复），拿到结构化结论 */
function runDiagnose(timeoutMs = 25000) {
  return new Promise((resolve) => {
    if (!fs.existsSync(REPAIR_ENTRY)) {
      resolve({ ok: false, error: '找不到 auto-repair 脚本', findings: [] })
      return
    }
    try {
      execFile(
        findNode(),
        [REPAIR_ENTRY, '--check'],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', env: childEnv() },
        (err, stdout, stderr) => {
          if (err && !stdout) {
            resolve({ ok: false, error: err.message, findings: [] })
            return
          }
          try {
            const findings = JSON.parse(String(stdout || '[]').trim() || '[]')
            resolve({ ok: true, findings })
          } catch (e) {
            resolve({ ok: false, error: `解析诊断输出失败：${e.message}`, findings: [], raw: String(stdout).slice(0, 500) })
          }
        }
      )
    } catch (e) {
      resolve({ ok: false, error: e.message, findings: [] })
    }
  })
}

/** 触发一次真实修复（跑一轮 --once） */
function runRepair(timeoutMs = 60000) {
  return new Promise((resolve) => {
    if (!fs.existsSync(REPAIR_ENTRY)) {
      resolve({ ok: false, error: '找不到 auto-repair 脚本', output: '' })
      return
    }
    try {
      execFile(
        findNode(),
        [REPAIR_ENTRY, '--once'],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', env: childEnv() },
        (err, stdout, stderr) => {
          resolve({
            ok: !err,
            output: String(stdout || '') + String(stderr || ''),
            error: err ? err.message : ''
          })
        }
      )
    } catch (e) {
      resolve({ ok: false, error: e.message, output: '' })
    }
  })
}

/** 汇总状态 —— 面板首屏要的东西 */
async function collectStatus() {
  const d = daemonAlive()
  const diag = await runDiagnose()
  const findings = diag.findings || []
  const fatal = findings.filter((f) => f.severity === 'fatal')
  const warn = findings.filter((f) => f.severity === 'warn')
  const info = findings.filter((f) => f.severity === 'info')
  const policy = readPolicyFile()

  return {
    ok: true,
    at: Date.now(),
    daemon: {
      alive: d.alive,
      pid: d.pid,
      intervalMs: Number(process.env.AUTO_REPAIR_INTERVAL_MS || 30000),
      installed: fs.existsSync(REPAIR_ENTRY)
    },
    health: fatal.length ? 'fatal' : warn.length ? 'warn' : 'ok',
    counts: { fatal: fatal.length, warn: warn.length, info: info.length, total: findings.length },
    // 审批策略：逐条审批 / 全部自动 / 全拒绝
    policy,
    // 通知策略：notify = 照常推送；silent = 一条都不发（修照常修）
    notify: readNotifyPolicy(),
    // 重复故障提醒：on = 照旧提醒；off = 同一故障再次出现时不弹（修复与记录照常）
    repeatAlert: readRepeatAlert(),
    // findings 里每条都带了 fixable / needsHuman / rejected（由守护进程 enrich）
    findings,
    counters: counters(),
    history: recentHistory(30),
    log: recentLog(40),
    daemonError: diag.ok ? null : diag.error
  }
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function apply(ctx) {
  let webServer
  try {
    webServer = (typeof ctx?.get === 'function' ? ctx.get('webServer') : undefined) || ctx?.webServer
  } catch {
    webServer = ctx?.webServer
  }
  if (!webServer || typeof webServer.register !== 'function') {
    try { ctx?.logger?.warn?.(`[${NS}] webServer 不可用，API 路由未注册`) } catch {}
    return
  }

  const disposers = []

  disposers.push(webServer.register({
    kind: 'exact',
    path: STATUS_PATH,
    handler: async (req, res) => {
      try {
        sendJson(res, 200, await collectStatus())
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e?.message || String(e) })
      }
    }
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: DIAGNOSE_PATH,
    handler: async (req, res) => {
      const r = await runDiagnose()
      sendJson(res, r.ok ? 200 : 500, r)
    }
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: REPAIR_PATH,
    handler: async (req, res) => {
      const r = await runRepair()
      sendJson(res, r.ok ? 200 : 500, r)
    }
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: HISTORY_PATH,
    handler: async (req, res) => {
      sendJson(res, 200, { ok: true, history: recentHistory(200), counters: counters() })
    }
  }))

  // ── 审批策略 ──────────────────────────────────────────────────────────────
  // 同一个 path 只注册一次（webServer 按 path 建表，重复注册会互相覆盖）。
  disposers.push(webServer.register({
    kind: 'exact',
    path: POLICY_PATH,
    handler: async (req, res) => {
      const method = String(req.method || 'GET').toUpperCase()
      if (method === 'GET') {
        sendJson(res, 200, { ok: true, policy: readPolicyFile() })
        return
      }
      if (method === 'POST' || method === 'PUT') {
        const body = await readBody(req)
        const patch = {}
        if (body.mode !== undefined) patch.mode = String(body.mode)
        if (!Object.keys(patch).length) {
          sendJson(res, 400, { ok: false, error: '没有要改的字段' })
          return
        }
        const r = await writePolicy(patch)
        sendJson(res, r.ok ? 200 : 500, r.ok ? { ok: true, policy: r.policy } : { ok: false, error: r.error })
        return
      }
      sendJson(res, 405, { ok: false, error: '方法不允许' })
    }
  }))

  // ── 自动修复通知策略（一个总开关） ────────────────────────────────────────
  disposers.push(webServer.register({
    kind: 'exact',
    path: NOTIFY_PATH,
    handler: async (req, res) => {
      const method = String(req.method || 'GET').toUpperCase()
      if (method === 'GET') {
        sendJson(res, 200, { ok: true, notify: readNotifyPolicy() })
        return
      }
      if (method === 'POST' || method === 'PUT') {
        const body = await readBody(req)
        const mode = String(body.mode || '')
        if (mode !== 'notify' && mode !== 'silent') {
          sendJson(res, 400, { ok: false, error: 'mode 只能是 notify 或 silent' })
          return
        }
        const r = writeNotifyPolicy(mode)
        sendJson(res, r.ok ? 200 : 500, r.ok ? { ok: true, notify: { mode: r.mode, updatedAt: r.updatedAt } } : r)
        return
      }
      sendJson(res, 405, { ok: false, error: '方法不允许' })
    }
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: REPEAT_ALERT_PATH,
    handler: async (req, res) => {
      const method = String(req.method || 'GET').toUpperCase()
      if (method === 'GET') {
        sendJson(res, 200, { ok: true, repeatAlert: readRepeatAlert() })
        return
      }
      if (method === 'POST' || method === 'PUT') {
        const body = await readBody(req)
        const mode = String(body.mode || '')
        if (mode !== 'on' && mode !== 'off') {
          sendJson(res, 400, { ok: false, error: 'mode 只能是 on 或 off' })
          return
        }
        const r = writeRepeatAlert(mode)
        sendJson(res, r.ok ? 200 : 500, r.ok ? { ok: true, repeatAlert: { mode: r.mode, updatedAt: r.updatedAt } } : r)
        return
      }
      sendJson(res, 405, { ok: false, error: '方法不允许' })
    }
  }))

  // ── 工作区：首次使用选择 / 后续修改（保存后下一次诊断立即生效） ──────────────
  disposers.push(webServer.register({
    kind: 'exact',
    path: WORKSPACE_PATH,
    handler: async (req, res) => {
      const method = String(req.method || 'GET').toUpperCase()
      if (method === 'GET') {
        sendJson(res, 200, workspaceSnapshot())
        return
      }
      if (method === 'POST' || method === 'PUT') {
        const body = await readBody(req)
        const v = validateWorkspace(body.path)
        if (!v.ok) {
          sendJson(res, 400, { ok: false, ...v })
          return
        }
        try {
          saveWorkspaceConfig(v.path)
        } catch (e) {
          sendJson(res, 500, { ok: false, path: v.path, missing: [], message: `写入配置失败：${e.message}` })
          return
        }
        sendJson(res, 200, workspaceSnapshot())
        return
      }
      sendJson(res, 405, { ok: false, error: '方法不允许' })
    }
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: WORKSPACE_PICK_PATH,
    handler: async (req, res) => {
      const method = String(req.method || 'GET').toUpperCase()
      if (method !== 'POST' && method !== 'PUT') {
        sendJson(res, 405, { ok: false, error: '方法不允许' })
        return
      }
      const r = await pickFolderViaShell()
      if (!r.ok) {
        sendJson(res, 200, r)
        return
      }
      // 选完先校验但**不保存**：面板把路径填进输入框，用户点「保存」才落盘
      sendJson(res, 200, { ok: true, path: r.path, validation: validateWorkspace(r.path) })
    }
  }))

  // ── 手动修某一条（= 用户点了那一条的「修复」） ────────────────────────────
  disposers.push(webServer.register({
    kind: 'exact',
    path: REPAIR_ONE_PATH,
    handler: async (req, res) => {
      if (String(req.method || '').toUpperCase() !== 'POST') {
        sendJson(res, 405, { ok: false, error: '方法不允许' })
        return
      }
      const body = await readBody(req)
      const code = String(body.code || '').trim()
      if (!code) {
        sendJson(res, 400, { ok: false, error: '缺少 code' })
        return
      }
      const r = await runCli(['--repair', code], 120000)
      const json = r.json || { ok: false, error: r.error || r.stderr || '修复失败' }
      sendJson(res, json.ok ? 200 : 200, { ...json, output: r.stdout })
    }
  }))

  // ── 一次性把能修的全修了 ─────────────────────────────────────────────────
  disposers.push(webServer.register({
    kind: 'exact',
    path: REPAIR_ALL_PATH,
    handler: async (req, res) => {
      if (String(req.method || '').toUpperCase() !== 'POST') {
        sendJson(res, 405, { ok: false, error: '方法不允许' })
        return
      }
      const r = await runCli(['--repair-all'], 180000)
      const json = r.json || { ok: false, error: r.error || r.stderr || '批量修复失败' }
      sendJson(res, 200, { ...json, output: r.stdout })
    }
  }))

  // ── 忽略 / 取消忽略某一条 ─────────────────────────────────────────────────
  disposers.push(webServer.register({
    kind: 'exact',
    path: IGNORE_PATH,
    handler: async (req, res) => {
      if (String(req.method || '').toUpperCase() !== 'POST') {
        sendJson(res, 405, { ok: false, error: '方法不允许' })
        return
      }
      const body = await readBody(req)
      const code = String(body.code || '').trim()
      if (!code) {
        sendJson(res, 400, { ok: false, error: '缺少 code' })
        return
      }
      const ignored = body.ignored !== false
      const r = await writePolicy(ignored ? { addRejected: [code] } : { removeRejected: [code] })
      sendJson(res, r.ok ? 200 : 500, r.ok ? { ok: true, code, ignored, policy: r.policy } : { ok: false, error: r.error })
    }
  }))

  const dispose = () => {
    for (const d of disposers) {
      try { d?.dispose?.() } catch {}
    }
  }
  if (typeof ctx?.effect === 'function') ctx.effect(() => dispose, `${NS}: api routes`)
  try {
    ctx?.logger?.info?.(`[${NS}] API 路由就绪: ${STATUS_PATH}, ${DIAGNOSE_PATH}, ${REPAIR_PATH}, ${HISTORY_PATH}, ${POLICY_PATH}, ${WORKSPACE_PATH}, ${REPAIR_ONE_PATH}, ${REPAIR_ALL_PATH}, ${IGNORE_PATH}`)
  } catch {}
  return dispose
}

/**
 * cordis 依赖注入声明：这个宿主侧 bundle 需要哪些服务。
 * 注意与客户端的 `inject: ['slots']`（插槽）不是一回事 —— 这里是**宿主服务**。
 */
const inject = ['webServer']
const name = NS

export { apply, inject, name, validateWorkspace, workspaceSnapshot, saveWorkspaceConfig }
