// auto-repair · 通知模块
//
// 修复动作是「偷偷」发生的，你不知道就等于没修 —— 所以每次修复都要播报。
//
// 两个通道，逐级降级：
//   1. Windows 通知气泡 —— toast
//   2. 日志 —— 永远有，任何通道失败都会留痕
//
// 设计：通知**不能阻塞**也不能**抛错**。通知失败绝不能影响修复主流程。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { ROOT } from './diagnose.mjs'

const STATE_DIR = path.join(ROOT, 'auto-repair', 'state')
const POLICY_FILE = path.join(STATE_DIR, 'notify-policy.json')
// 「同一故障重复出现」提醒开关 + 出现次数账本。和上面的总开关互相独立。
const REPEAT_FILE = path.join(STATE_DIR, 'repeat-alert.json')
const REPEAT_WINDOW_MS = 30 * 60 * 1000
const LOG_FILE = path.join(STATE_DIR, 'auto-repair.log')

/**
 * 通知策略：notify（默认，照常推送）| silent（完全不发）。
 * 读不到文件或内容不合法时按 notify 处理，保证老行为不变。
 */
export function readNotifyPolicy() {
  try {
    const doc = JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8').replace(/^\uFEFF/, ''))
    return doc?.mode === 'silent' ? 'silent' : 'notify'
  } catch {
    return 'notify'
  }
}

/** 被拦下的推送要留痕：写到守护进程同一份日志里，方便事后查。 */
function logBlocked(title) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] [notify] 策略=完全不发，已拦下对外推送：${title}`
  try {
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8')
  } catch {}
}

// ── 重复故障提醒开关 ────────────────────────────────────────────────────────
//
// on（默认）= 维持现状，同一故障反复出现就反复提醒。
// off       = 同一故障（指纹相同）在窗口内再次出现时不再提醒；首次出现仍然提醒。
//             修复和 repair-history 记录完全不受影响，只是不弹提醒。
// 「重复」的判定按 code + 级别 + 标题 + 现象文本做指纹（feedHashOf）。

/** 失败特征指纹：code + 级别 + 标题 + 现象文本。同一份日志反复出现时指纹相同。 */
export function feedHashOf(finding) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
  const seed = [
    norm(finding?.code),
    norm(finding?.severity),
    norm(finding?.title),
    norm(finding?.detail).slice(0, 400)
  ].join('|')
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16)
}

function readRepeatDoc() {
  try {
    const doc = JSON.parse(fs.readFileSync(REPEAT_FILE, 'utf8').replace(/^\uFEFF/, ''))
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {}
  } catch {
    return {}
  }
}

function writeRepeatDoc(doc) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    const tmp = `${REPEAT_FILE}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, REPEAT_FILE)
    return true
  } catch {
    return false
  }
}

/** on（默认）| off */
export function readRepeatAlertPolicy() {
  return readRepeatDoc().mode === 'off' ? 'off' : 'on'
}

/** 改开关；保留已有的出现次数账本。 */
export function writeRepeatAlertPolicy(mode) {
  const next = mode === 'off' ? 'off' : 'on'
  const doc = readRepeatDoc()
  const updatedAt = Date.now()
  const ok = writeRepeatDoc({ ...doc, version: 1, mode: next, updatedAt })
  return ok ? { ok: true, mode: next, updatedAt } : { ok: false, error: '写 repeat-alert.json 失败' }
}

/**
 * 记一次「这个故障又出现了」，返回它是不是重复出现、累计几次。
 * 账本按指纹保留 7 天，避免无限增长。
 */
export function noteFaultOccurrence(hash, now = Date.now()) {
  if (!hash) return { repeat: false, count: 1 }
  const doc = readRepeatDoc()
  const seen = doc.seen && typeof doc.seen === 'object' && !Array.isArray(doc.seen) ? { ...doc.seen } : {}
  const rec = seen[hash] && typeof seen[hash] === 'object' ? seen[hash] : {}
  const lastAt = Number(rec.lastAt) || 0
  const count = (Number(rec.count) || 0) + 1
  const repeat = lastAt > 0 && now - lastAt <= REPEAT_WINDOW_MS
  seen[hash] = { firstAt: Number(rec.firstAt) || now, lastAt: now, count }
  const cutoff = now - 7 * 24 * 3600 * 1000
  for (const [k, v] of Object.entries(seen)) {
    if ((Number(v?.lastAt) || 0) < cutoff) delete seen[k]
  }
  writeRepeatDoc({ ...doc, version: 1, seen })
  return { repeat, count }
}

/** 某个指纹累计出现过几次（面板展示用）。 */
export function repeatCountOf(hash) {
  const seen = readRepeatDoc().seen
  const rec = seen && typeof seen === 'object' ? seen[hash] : null
  return Number(rec?.count) || 0
}

/**
 * 重复提醒闸门：记一次「又出现了」，并判断这次要不要因为
 * 「确实是重复 + 开关关着」而拦下提醒。
 * suppress=true 时只拦提醒，不影响调用方继续修复/记录。
 */
export function repeatAlertGate(hash, now = Date.now()) {
  const { repeat, count } = noteFaultOccurrence(hash, now)
  return { suppress: repeat && readRepeatAlertPolicy() === 'off', repeat, count }
}

/** Windows 通知气泡 */
function notifyToast(title, detail) {
  return new Promise((resolve) => {
    try {
      const script = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(1)
$n = $t.GetElementsByTagName("text")
$n.Item(0).AppendChild($t.CreateTextNode($args[0])) | Out-Null
$n.Item(1).AppendChild($t.CreateTextNode($args[1])) | Out-Null
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("大肥鱼").Show([Windows.UI.Notifications.ToastNotification]::new($t))
`
      const p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script, title, detail], {
        windowsHide: true,
        stdio: 'ignore'
      })
      p.on('error', () => resolve(false))
      p.on('close', () => resolve(true))
    } catch {
      resolve(false)
    }
  })
}

/**
 * 发一条通知。逐级降级，任一通道成功即返回。
 * 永远不抛错。
 */
export async function notify(title, detail, kind = 'l1') {
  // 总开关：选了「完全不发」就直接返回，不碰任何对外通道（修复流程照常）。
  if (readNotifyPolicy() === 'silent') {
    logBlocked(title)
    return [['policy', false, 'silent']]
  }
  const results = []
  try {
    results.push(['toast', await notifyToast(title, detail)])
  } catch {}
  return results
}
