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

// dsh-auto-repair-ui · 客户端
//
// 在 DSH 设置页里加一个「自愈」页面，展示 auto-repair 守护进程的状态。
//
// 挂载方式（DSH 官方插槽契约）：
//   ctx.slots.inject('settings.section', () =>
//     ctx.slots.register({ name:'settings.section', id:'auto-repair', order:50, label:'自愈' }, Component)
//   )
//
// 设计约束（DSH 插件规范）：
//   - 只用主题令牌（CSS 变量），不硬编码颜色 → 亮/暗色都正确
//   - 不 import 任何 Harness Client 包（@deepseek-ai/dsh-client-ui-*）
//   - 不崩：所有取数都要有兜底，面板不能把设置页搞挂

window.__ModuleLoader__.load({
  id: 'dsh-auto-repair-ui',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const API = '/dsh-auto-repair'
    const MAKER = '蝠羽科技'

    // ── 样式：只用主题令牌，亮/暗都跟着系统走 ───────────────────────────
    const STYLE = `
.ar-root {
  --ar-ok: var(--dsw-alias-state-success-primary, #39d98a);
  --ar-warn: var(--dsw-alias-state-warn-primary, #e0a44a);
  --ar-fatal: var(--dsw-alias-state-error-primary, #e05a5a);
  --ar-idle: var(--dsw-alias-label-secondary, #8a8a8a);
  padding: 4px 2px 24px;
  font-size: 13px;
  line-height: 1.6;
}
.ar-head {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px; margin-bottom: 12px;
  border: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, #ffffff08);
}
.ar-dot {
  width: 10px; height: 10px; border-radius: 50%;
  flex: 0 0 auto;
}
.ar-dot.ok { background: var(--ar-ok); box-shadow: 0 0 8px var(--ar-ok); }
.ar-dot.warn { background: var(--ar-warn); box-shadow: 0 0 8px var(--ar-warn); }
.ar-dot.fatal { background: var(--ar-fatal); box-shadow: 0 0 8px var(--ar-fatal); animation: ar-pulse 1.2s ease-in-out infinite; }
@keyframes ar-pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
.ar-title { font-weight: 600; font-size: 14px; }
.ar-sub { color: var(--dsw-alias-label-secondary, #8a8a8a); font-size: 12px; }
/* 标题块允许收缩换行，徽章与按钮保持单行不被挤扁 */
.ar-head-main { flex: 1 1 auto; min-width: 0; }
.ar-head-right { margin-left: auto; flex: 0 0 auto; display: flex; align-items: center; gap: 8px; white-space: nowrap; }
.ar-maker {
  font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8a8a);
  border: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
  border-radius: 999px; padding: 1px 8px;
  flex: 0 0 auto; white-space: nowrap;
}

.ar-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 14px; }
.ar-card {
  border: 1px solid var(--dsw-alias-border-l1, #ffffff12);
  border-radius: 9px; padding: 10px 12px;
  background: var(--dsw-alias-bg-layer-1, #ffffff06);
}
.ar-card-label { color: var(--dsw-alias-label-secondary, #8a8a8a); font-size: 11px; margin-bottom: 3px; }
.ar-card-value { font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; }
.ar-card-value.ok { color: var(--ar-ok); }
.ar-card-value.warn { color: var(--ar-warn); }
.ar-card-value.fatal { color: var(--ar-fatal); }

.ar-btn {
  border: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
  background: var(--dsw-alias-bg-layer-2, #ffffff0d);
  color: var(--dsw-alias-label-primary, inherit);
  border-radius: 7px; padding: 5px 12px; font-size: 12px;
  cursor: pointer; font-family: inherit; white-space: nowrap;
}
.ar-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary, #5b8cff); }
.ar-btn:disabled { opacity: .45; cursor: not-allowed; }
.ar-btn.primary {
  /* 成对使用 DSH 的 primary fill / foreground 令牌，
     这样在任意主题（亮/暗/赛博红）下前景与背景都自带对比度，
     不会出现「白底白字」按钮看不见的情况。 */
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #5b8cff));
  border-color: transparent;
  color: var(--dsw-alias-label-primary-foreground, #fff);
}
.ar-btn.primary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-button-primary-fill, #5b8cff));
}

.ar-section-title {
  font-size: 12px; font-weight: 600; margin: 16px 0 8px;
  color: var(--dsw-alias-label-secondary, #8a8a8a);
  text-transform: uppercase; letter-spacing: .06em;
}

.ar-finding {
  border: 1px solid var(--dsw-alias-border-l1, #ffffff12);
  border-left-width: 3px; border-radius: 7px;
  padding: 9px 12px; margin-bottom: 7px;
  background: var(--dsw-alias-bg-layer-1, #ffffff06);
}
.ar-finding.fatal { border-left-color: var(--ar-fatal); }
.ar-finding.warn { border-left-color: var(--ar-warn); }
.ar-finding.info { border-left-color: var(--ar-idle); }
.ar-finding-title { font-weight: 600; margin-bottom: 2px; }
.ar-finding-detail { color: var(--dsw-alias-label-secondary, #8a8a8a); font-size: 12px; word-break: break-word; }
.ar-badge {
  display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 4px;
  background: var(--dsw-alias-bg-layer-2, #ffffff12); margin-right: 7px;
  color: var(--dsw-alias-label-secondary, #8a8a8a);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.ar-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.ar-table th {
  text-align: left; padding: 5px 8px; font-weight: 600;
  color: var(--dsw-alias-label-secondary, #8a8a8a);
  border-bottom: 1px solid var(--dsw-alias-border-l1, #ffffff12);
}
.ar-table td { padding: 5px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1, #ffffff0a); vertical-align: top; }
.ar-table tr:last-child td { border-bottom: none; }
.ar-time { color: var(--dsw-alias-label-secondary, #8a8a8a); white-space: nowrap; font-variant-numeric: tabular-nums; }
.ar-ok-mark { color: var(--ar-ok); }
.ar-fail-mark { color: var(--ar-fatal); }

.ar-log {
  max-height: 220px; overflow-y: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px; line-height: 1.55;
  border: 1px solid var(--dsw-alias-border-l1, #ffffff12);
  border-radius: 8px; padding: 9px 11px;
  background: var(--dsw-alias-bg-layer-1, #ffffff06);
  white-space: pre-wrap; word-break: break-word;
}
.ar-empty { color: var(--dsw-alias-label-secondary, #8a8a8a); font-size: 12px; padding: 14px 0; }
.ar-note {
  margin-top: 14px; padding: 9px 11px; border-radius: 7px; font-size: 12px;
  border: 1px solid var(--dsw-alias-border-l1, #ffffff12);
  color: var(--dsw-alias-label-secondary, #8a8a8a);
  background: var(--dsw-alias-bg-layer-1, #ffffff06);
}
.ar-note code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px; background: var(--dsw-alias-bg-layer-2, #ffffff12);
  padding: 1px 5px; border-radius: 4px;
}
.ar-toast {
  margin-top: 10px; padding: 8px 11px; border-radius: 7px; font-size: 12px;
  border: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
}
.ar-toast.ok { border-left: 3px solid var(--ar-ok); }
.ar-toast.err { border-left: 3px solid var(--ar-fatal); }

/* ── 审批策略 ─────────────────────────────────────────────────────────── */
.ar-policy {
  border: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
  border-radius: 10px; padding: 12px 14px; margin-bottom: 14px;
  background: var(--dsw-alias-bg-layer-1, #ffffff08);
}
.ar-policy-head { display: flex; align-items: center; gap: 10px; margin-bottom: 9px; flex-wrap: wrap; }
.ar-policy-title { font-weight: 600; font-size: 13px; }
.ar-policy-hint { color: var(--dsw-alias-label-secondary, #8a8a8a); font-size: 12px; flex: 1 1 240px; min-width: 0; }
.ar-seg { display: inline-flex; border: 1px solid var(--dsw-alias-border-l2, #ffffff1f); border-radius: 8px; overflow: hidden; }
.ar-seg-btn {
  border: none; background: transparent; color: var(--dsw-alias-label-secondary, #8a8a8a);
  padding: 5px 12px; font-size: 12px; cursor: pointer; font-family: inherit; white-space: nowrap;
}
.ar-seg-btn + .ar-seg-btn { border-left: 1px solid var(--dsw-alias-border-l2, #ffffff1f); }
.ar-seg-btn.on {
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #5b8cff));
  color: var(--dsw-alias-label-primary-foreground, #fff);
}
.ar-seg-btn:disabled { opacity: .5; cursor: not-allowed; }
.ar-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; color: var(--dsw-alias-label-primary, inherit); }
.ar-check input { margin: 0; cursor: pointer; }
.ar-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ar-select {
  border: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
  background: var(--dsw-alias-bg-layer-2, #ffffff0d);
  color: var(--dsw-alias-label-primary, inherit);
  border-radius: 8px; padding: 5px 8px; font-size: 12px; font-family: inherit;
  min-width: 200px; max-width: 100%;
}
.ar-select:disabled { opacity: .5; }
/* 客户端路径输入：与下拉框同款令牌，不引入新控件风格 */
.ar-input {
  border: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
  background: var(--dsw-alias-bg-layer-2, #ffffff0d);
  color: var(--dsw-alias-label-primary, inherit);
  border-radius: 8px; padding: 5px 8px; font-size: 12px; font-family: inherit;
  flex: 1 1 320px; min-width: 200px; max-width: 100%;
}
.ar-input:disabled { opacity: .5; }
/* 工作区：输入框 + 选择/保存 */
.ar-ws-row { display: flex; gap: 8px; flex-wrap: wrap; }
.ar-ws-row .ar-input { flex: 1 1 340px; }
.ar-ws-err { color: var(--ar-fatal); font-size: 12px; margin-top: 6px; word-break: break-all; }
.ar-ws-ok { color: var(--ar-ok); font-size: 12px; margin-top: 6px; word-break: break-all; }
.ar-ws-note { color: var(--dsw-alias-label-secondary, #8a8a8a); font-size: 12px; margin-top: 6px; word-break: break-all; }

/* ── 每条错误的操作按钮 ───────────────────────────────────────────────── */
.ar-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 7px; }
.ar-actions .ar-btn { padding: 3px 10px; font-size: 11px; }
.ar-flag {
  font-size: 10px; padding: 1px 6px; border-radius: 4px; margin-left: 7px;
  border: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
  color: var(--dsw-alias-label-secondary, #8a8a8a);
}
.ar-flag.rejected { color: var(--ar-warn); border-color: var(--ar-warn); }
`

    function fmtTime(ts) {
      try {
        return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
      } catch {
        return '--:--:--'
      }
    }

    async function fetchJson(pathname, options) {
      try {
        const res = await fetch(API + pathname, options || {})
        if (!res.ok && res.status !== 200) {
          const t = await res.text().catch(() => '')
          throw new Error(`HTTP ${res.status} ${t.slice(0, 120)}`)
        }
        return await res.json()
      } catch (e) {
        throw new Error(e?.message || String(e))
      }
    }

    function AutoRepairPanel() {
      const [data, setData] = useState(null)
      const [loading, setLoading] = useState(true)
      const [busy, setBusy] = useState(false)
      const [toast, setToast] = useState(null)
      const [err, setErr] = useState('')
      const [busyCode, setBusyCode] = useState('')
      const [policyBusy, setPolicyBusy] = useState(false)
      // 自动修复通知策略（总开关）：notify = 照常推送；silent = 只修不推
      const [notifyBusy, setNotifyBusy] = useState(false)
      // 同一故障重复出现的提醒开关：on = 照旧提醒；off = 重复出现时不再弹
      const [repeatAlertBusy, setRepeatAlertBusy] = useState(false)
      // 工作区：首次使用选择 / 后续修改
      const [ws, setWs] = useState(null)
      const [wsDraft, setWsDraft] = useState('')
      const [wsBusy, setWsBusy] = useState(false)
      const [wsError, setWsError] = useState('')
      const [wsMissing, setWsMissing] = useState([])
      const timerRef = useRef(null)

      const load = useCallback(async (silent) => {
        try {
          const s = await fetchJson('/status')
          setData(s)
          setErr('')
        } catch (e) {
          setErr(e?.message || String(e))
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => {
        load()
        // 面板开着的时候定时刷新，能看到状态实时变化
        timerRef.current = setInterval(() => load(true), 10000)
        return () => { if (timerRef.current) clearInterval(timerRef.current) }
      }, [load])

      const postJson = useCallback(async (pathname, body) => {
        return await fetchJson(pathname, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {})
        })
      }, [])

      /** 读工作区设置（首次使用 / 当前生效值） */
      const loadWorkspace = useCallback(async () => {
        try {
          const r = await fetchJson('/workspace', { cache: 'no-store' })
          setWs(r)
          setWsDraft((prev) => prev || r?.root || r?.envRoot || '')
        } catch (e) {
          setWs({ ok: false, error: e?.message || String(e) })
        }
      }, [])

      useEffect(() => { loadWorkspace() }, [loadWorkspace])

      const doRepair = useCallback(async () => {
        setBusy(true)
        setToast(null)
        try {
          const r = await fetchJson('/repair', { method: 'POST' })
          const out = String(r.output || '').trim()
          setToast({ ok: r.ok !== false, text: out ? out.slice(-600) : (r.ok ? '已完成' : '失败') })
          await load(true)
        } catch (e) {
          setToast({ ok: false, text: e?.message || String(e) })
        } finally {
          setBusy(false)
        }
      }, [load])

      /** 改审批策略（逐条审批 / 全部自动 / 全拒绝） */
      const setPolicy = useCallback(async (patch) => {
        setPolicyBusy(true)
        setToast(null)
        try {
          const r = await postJson('/policy', patch)
          if (r && r.ok) {
            setToast({ ok: true, text: '策略已更新，下一轮巡检就按新策略走' })
          } else {
            setToast({ ok: false, text: r?.error || '改策略失败' })
          }
          await load(true)
        } catch (e) {
          setToast({ ok: false, text: e?.message || String(e) })
        } finally {
          setPolicyBusy(false)
        }
      }, [postJson, load])

      /** 改「自动修复通知策略」总开关（发通知 / 完全不发） */
      const setNotifyMode = useCallback(async (mode) => {
        setNotifyBusy(true)
        setToast(null)
        try {
          const r = await postJson('/notify-policy', { mode })
          if (r && r.ok) {
            setToast({ ok: true, text: mode === 'silent'
              ? '已切换为「完全不发」：自动修复照常执行，但不再推送任何对外消息'
              : '已切换为「发通知」：自动修复的消息会照常推送' })
          } else {
            setToast({ ok: false, text: r?.error || '改通知策略失败' })
          }
          await load(true)
        } catch (e) {
          setToast({ ok: false, text: e?.message || String(e) })
        } finally {
          setNotifyBusy(false)
        }
      }, [postJson, load])

      /** 改「同一故障重复出现」的提醒开关 */
      const setRepeatAlertMode = useCallback(async (mode) => {
        setRepeatAlertBusy(true)
        setToast(null)
        try {
          const r = await postJson('/repeat-alert', { mode })
          if (r && r.ok) {
            setToast({ ok: true, text: mode === 'off'
              ? '已关闭重复故障提醒：同一故障再次出现时不再弹提醒，修复和历史照常记录'
              : '已开启重复故障提醒：同一故障再次出现时会照常提醒' })
          } else {
            setToast({ ok: false, text: r?.error || '改重复故障提醒失败' })
          }
          await load(true)
        } catch (e) {
          setToast({ ok: false, text: e?.message || String(e) })
        } finally {
          setRepeatAlertBusy(false)
        }
      }, [postJson, load])

      /** 修某一条（= 审批通过这一条） */
      const repairOne = useCallback(async (code) => {
        setBusyCode(code)
        setToast(null)
        try {
          const r = await postJson('/repair-one', { code })
          const lines = Array.isArray(r?.results) && r.results.length
            ? r.results.map((x) => `${x.code}：${x.ok ? '✅' : '⚠️'} ${x.action || ''}`).join('\n')
            : String(r?.error || '（无输出）')
          setToast({ ok: r?.ok !== false, text: lines })
          await load(true)
        } catch (e) {
          setToast({ ok: false, text: e?.message || String(e) })
        } finally {
          setBusyCode('')
        }
      }, [postJson, load])

      /** 把能修的一次全修了 */
      const repairAll = useCallback(async () => {
        setBusy(true)
        setToast(null)
        try {
          const r = await postJson('/repair-all', {})
          const lines = Array.isArray(r?.results) && r.results.length
            ? r.results.map((x) => `${x.code}：${x.ok ? '✅' : '⚠️'} ${x.action || ''}`).join('\n')
            : String(r?.error || '（无输出）')
          setToast({ ok: r?.ok !== false, text: lines })
          await load(true)
        } catch (e) {
          setToast({ ok: false, text: e?.message || String(e) })
        } finally {
          setBusy(false)
        }
      }, [postJson, load])

      /** 忽略 / 取消忽略某一条 */
      const toggleIgnore = useCallback(async (code, ignored) => {
        setBusyCode(code)
        setToast(null)
        try {
          const r = await postJson('/ignore', { code, ignored })
          setToast({
            ok: r?.ok !== false,
            text: r?.ok ? (ignored ? `已忽略 ${code}，以后不再自动处理` : `已取消忽略 ${code}`) : String(r?.error || '操作失败')
          })
          await load(true)
        } catch (e) {
          setToast({ ok: false, text: e?.message || String(e) })
        } finally {
          setBusyCode('')
        }
      }, [postJson, load])

      /** 选目录（系统对话框，选完只填进输入框，不直接保存） */
      const pickWorkspace = useCallback(async () => {
        setWsBusy(true)
        setWsError('')
        setWsMissing([])
        try {
          const r = await postJson('/workspace/pick', {})
          if (r?.ok && r.path) {
            setWsDraft(r.path)
            const v = r.validation || {}
            if (v.ok === false) {
              setWsError(String(v.message || '这个目录不可用'))
              setWsMissing(Array.isArray(v.missing) ? v.missing : [])
            }
          } else if (r && r.error) {
            setWsError(String(r.error))
          }
        } catch (e) {
          setWsError(e?.message || String(e))
        } finally {
          setWsBusy(false)
        }
      }, [postJson])

      /** 保存工作区：校验不过就停在面板上，不落盘 */
      const saveWorkspace = useCallback(async () => {
        setWsBusy(true)
        setWsError('')
        setWsMissing([])
        try {
          const res = await fetch(API + '/workspace', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: wsDraft })
          })
          const r = await res.json().catch(() => null)
          if (res.ok && r?.ok) {
            setWs(r)
            setToast({ ok: true, text: `工作区已保存：${r.root}（下一次诊断立即生效）` })
            await load(true)
          } else {
            setWsError(String(r?.message || r?.error || `保存失败（HTTP ${res.status}）`))
            setWsMissing(Array.isArray(r?.missing) ? r.missing : [])
          }
        } catch (e) {
          setWsError(e?.message || String(e))
        } finally {
          setWsBusy(false)
        }
      }, [wsDraft, load])

      if (loading) {
        return h('div', { className: 'ar-root' },
          h('div', { className: 'ar-empty' }, '正在读取自愈状态…')
        )
      }

      if (err && !data) {
        return h('div', { className: 'ar-root' },
          h('div', { className: 'ar-finding fatal' },
            h('div', { className: 'ar-finding-title' }, '读不到自愈守护进程'),
            h('div', { className: 'ar-finding-detail' }, err)
          )
        )
      }

      const d = data || {}
      const health = d.health || 'ok'
      const counts = d.counts || { fatal: 0, warn: 0, info: 0, total: 0 }
      const daemon = d.daemon || {}
      const policy = d.policy || { mode: 'manual', rejectedCodes: [] }
      const rejectAll = policy.mode === 'reject-all'
      const healthText = health === 'fatal' ? '发现严重故障' : health === 'warn' ? '有可修复项' : '一切正常'
      const healthClass = health === 'fatal' ? 'fatal' : health === 'warn' ? 'warn' : 'ok'
      const policyHint = rejectAll
        ? '全拒绝：守护进程不会自动修任何东西，面板上的「修复」也点不动。改回别的模式即可恢复。'
        : policy.mode === 'approve-all'
          ? '全部自动：守护进程发现能修的直接修，不用等你点。'
          : '逐条审批：守护进程只报告不改，等你点某一条的「修复」才动手。'

      // 通知策略：默认 notify（维持现状），只有明确存了 silent 才是「完全不发」
      const notifyMode = d.notify && d.notify.mode === 'silent' ? 'silent' : 'notify'
      const notifyHint = notifyMode === 'silent'
        ? '当前「完全不发」：自动修复照常执行，但 Windows 气泡一条都不推；修复历史和日志照常记录。'
        : '当前「发通知」：自动修复的消息会照常通过 Windows 气泡推送。'

      // 同一故障重复出现的提醒开关：默认 on，只有明确存了 off 才屏蔽
      const repeatAlertMode = d.repeatAlert && d.repeatAlert.mode === 'off' ? 'off' : 'on'

      return h('div', { className: 'ar-root' },
        h('style', null, STYLE),

        // 顶部状态条
        h('div', { className: 'ar-head' },
          h('span', { className: `ar-dot ${healthClass}` }),
          h('div', { className: 'ar-head-main' },
            h('div', { className: 'ar-title' }, healthText),
            h('div', { className: 'ar-sub' },
              daemon.alive
                ? `守护进程运行中 (pid ${daemon.pid}) · 每 ${Math.round((daemon.intervalMs || 30000) / 1000)} 秒巡检`
                : '⚠️ 守护进程未运行 —— supervisor 会在一分钟内补回'
            )
          ),
          h('span', { className: 'ar-maker' }, `制作方：${MAKER}`),
          h('div', { className: 'ar-head-right' },
            h('button', {
              className: 'ar-btn', disabled: busy,
              onClick: () => load()
            }, '刷新'),
            h('button', {
              className: 'ar-btn primary', disabled: busy,
              onClick: doRepair
            }, busy ? '巡检中…' : '巡检一轮')
          )
        ),

        // 首次使用：还没配置过工作区时，先把这一步摆在最上面
        ws && ws.needsSetup
          ? h('div', { className: 'ar-finding warn' },
            h('div', { className: 'ar-finding-title' }, '首次使用：请先选择工作区'),
            h('div', { className: 'ar-finding-detail' },
              '选择包含 DeepSeek Harness.exe 的那一级目录（例如 D:\\大肥鱼）。选错会在这里被拦下，并说明缺少什么。')
          )
          : null,

        // ── 工作区：首次使用 / 随时修改 ──────────────────────────────────
        h('div', { className: 'ar-policy' },
          h('div', { className: 'ar-policy-head' },
            h('span', { className: 'ar-policy-title' }, '工作区'),
            h('span', { className: 'ar-policy-hint' },
              ws?.source === 'env'
                ? '当前由环境变量 AUTO_REPAIR_ROOT 指定（面板里修改不会覆盖它）'
                : ws?.root
                  ? `当前生效：${ws.root}`
                  : '尚未配置，请选择工作区目录'
            )
          ),
          h('div', { className: 'ar-ws-row' },
            h('input', {
              className: 'ar-input',
              value: wsDraft,
              placeholder: '例如 D:\\大肥鱼',
              disabled: wsBusy,
              onChange: (e) => {
                setWsDraft(e.target.value)
                setWsError('')
                setWsMissing([])
              },
              onKeyDown: (e) => { if (e.key === 'Enter' && !wsBusy) saveWorkspace() }
            }),
            h('button', {
              className: 'ar-btn',
              disabled: wsBusy,
              onClick: pickWorkspace
            }, '选择目录…'),
            h('button', {
              className: 'ar-btn primary',
              disabled: wsBusy || !String(wsDraft || '').trim(),
              onClick: saveWorkspace
            }, wsBusy ? '处理中…' : '保存')
          ),
          wsError
            ? h('div', { className: 'ar-ws-err' },
              `${wsError}${wsMissing.length ? `（缺少：${wsMissing.join('、')}）` : ''}`)
            : ws?.validation && ws.validation.ok === false
              ? h('div', { className: 'ar-ws-err' }, `当前配置不可用：${ws.validation.message}`)
              : ws?.root
                ? h('div', { className: 'ar-ws-ok' }, `已就绪：${ws.root}`)
                : null,
          h('div', { className: 'ar-ws-note' },
            '规则：目录必须存在，且包含 DeepSeek Harness.exe；不能直接选 auto-repair 本身。保存后下一次诊断立即生效，无需改代码。')
        ),

        // 概览卡片
        h('div', { className: 'ar-grid' },
          h('div', { className: 'ar-card' },
            h('div', { className: 'ar-card-label' }, '严重故障'),
            h('div', { className: `ar-card-value ${counts.fatal ? 'fatal' : 'ok'}` }, counts.fatal || 0)
          ),
          h('div', { className: 'ar-card' },
            h('div', { className: 'ar-card-label' }, '可修复项'),
            h('div', { className: `ar-card-value ${counts.warn ? 'warn' : 'ok'}` }, counts.warn || 0)
          ),
          h('div', { className: 'ar-card' },
            h('div', { className: 'ar-card-label' }, '待人工'),
            h('div', { className: `ar-card-value ${counts.info ? 'warn' : 'ok'}` }, counts.info || 0)
          ),
          h('div', { className: 'ar-card' },
            h('div', { className: 'ar-card-label' }, '累计修复'),
            h('div', { className: 'ar-card-value' },
              (d.history || []).filter((x) => x.ok).length
            )
          )
        ),

        toast ? h('div', { className: `ar-toast ${toast.ok ? 'ok' : 'err'}` }, toast.text) : null,

        // ── 审批策略 ────────────────────────────────────────────────────
        h('div', { className: 'ar-policy' },
          h('div', { className: 'ar-policy-head' },
            h('span', { className: 'ar-policy-title' }, '审批策略'),
            h('span', { className: 'ar-policy-hint' }, policyHint)
          ),
          h('div', { className: 'ar-row' },
            h('div', { className: 'ar-seg' },
              h('button', {
                className: `ar-seg-btn ${policy.mode === 'manual' ? 'on' : ''}`,
                disabled: policyBusy,
                onClick: () => setPolicy({ mode: 'manual' })
              }, '逐条审批'),
              h('button', {
                className: `ar-seg-btn ${policy.mode === 'approve-all' ? 'on' : ''}`,
                disabled: policyBusy,
                onClick: () => setPolicy({ mode: 'approve-all' })
              }, '全部自动'),
              h('button', {
                className: `ar-seg-btn ${rejectAll ? 'on' : ''}`,
                disabled: policyBusy,
                onClick: () => setPolicy({ mode: 'reject-all' })
              }, '全拒绝')
            ),
            h('button', {
              className: 'ar-btn', disabled: busy || rejectAll,
              onClick: repairAll
            }, busy ? '修复中…' : '全部修复')
          )
        ),

        // ── 自动修复通知策略（一个总开关，管所有对外推送） ────────────────
        h('div', { className: 'ar-policy' },
          h('div', { className: 'ar-policy-head' },
            h('span', { className: 'ar-policy-title' }, '通知策略'),
            h('span', { className: 'ar-policy-hint' }, notifyHint)
          ),
          h('div', { className: 'ar-row' },
            h('div', { className: 'ar-seg' },
              h('button', {
                className: `ar-seg-btn ${notifyMode === 'notify' ? 'on' : ''}`,
                disabled: notifyBusy,
                onClick: () => setNotifyMode('notify')
              }, '发通知'),
              h('button', {
                className: `ar-seg-btn ${notifyMode === 'silent' ? 'on' : ''}`,
                disabled: notifyBusy,
                onClick: () => setNotifyMode('silent')
              }, '完全不发')
            )
          ),
          h('div', { className: 'ar-policy-hint', style: { marginTop: '8px' } },
            '这一个总开关同时管自动修复的全部对外消息：待你审批、自动修复成功、自动修复未成功、需要你处理，渠道是 Windows 通知气泡。选「完全不发」时这些一律不推，但修复照常执行，面板的修复历史和 auto-repair.log 仍照常记录。')
        ),

        // ── 同一故障重复出现的提醒（和上面的总开关并列，互不影响） ─────────
        h('div', { className: 'ar-policy' },
          h('div', { className: 'ar-policy-head' },
            h('span', { className: 'ar-policy-title' }, '重复故障提醒'),
            h('span', { className: 'ar-policy-hint' },
              repeatAlertMode === 'off'
                ? '当前「不提醒」：同一故障再次出现时不再弹提醒（面板和气泡都不弹），但故障照常记录、修复照常执行。'
                : '当前「提醒」：同一故障每次出现都会照常提醒。')
          ),
          h('div', { className: 'ar-row' },
            h('div', { className: 'ar-seg' },
              h('button', {
                className: `ar-seg-btn ${repeatAlertMode === 'on' ? 'on' : ''}`,
                disabled: repeatAlertBusy,
                onClick: () => setRepeatAlertMode('on')
              }, '提醒'),
              h('button', {
                className: `ar-seg-btn ${repeatAlertMode === 'off' ? 'on' : ''}`,
                disabled: repeatAlertBusy,
                onClick: () => setRepeatAlertMode('off')
              }, '不提醒')
            )
          ),
          h('div', { className: 'ar-policy-hint', style: { marginTop: '8px' } },
            '只管「同一个故障反复出现」这一类提醒：故障代码 + 级别 + 标题 + 现象文本相同、30 分钟内算同一次。首次出现的提醒始终保留；上方的「通知策略」总开关仍然优先，选「完全不发」时这里开不开都不会推送。')
        ),

        // 当前诊断结论
        h('div', { className: 'ar-section-title' }, '当前诊断'),
        (d.findings || []).length
          ? h('div', null, (d.findings || []).map((f, i) => {
              const itemBusy = busyCode === f.code
              const canRepair = f.fixable !== false && !rejectAll && !f.rejected
              return h('div', { key: i, className: `ar-finding ${f.severity}` },
                h('div', { className: 'ar-finding-title' },
                  h('span', { className: 'ar-badge' }, f.code),
                  f.title,
                  f.rejected ? h('span', { className: 'ar-flag rejected' }, '已忽略') : null,
                  f.fixable ? null : h('span', { className: 'ar-flag' }, '不能自动修'),
                  f.route === 'plugin' ? h('span', { className: 'ar-flag', title: f.routeDetail || '' }, '插件已修复') : null
                ),
                h('div', { className: 'ar-finding-detail' }, f.detail || ''),
                h('div', { className: 'ar-actions' },
                  h('button', {
                    className: 'ar-btn primary',
                    disabled: itemBusy || !canRepair,
                    onClick: () => repairOne(f.code)
                  }, itemBusy ? '处理中…' : '修复'),
                  h('button', {
                    className: 'ar-btn',
                    disabled: itemBusy,
                    onClick: () => toggleIgnore(f.code, !f.rejected)
                  }, f.rejected ? '取消忽略' : '忽略')
                )
              )
            }))
          : h('div', { className: 'ar-empty' }, '没有发现任何问题 —— 大肥鱼很健康 🐟'),

        // 修复历史
        h('div', { className: 'ar-section-title' }, '修复历史'),
        (d.history || []).length
          ? h('table', { className: 'ar-table' },
              h('thead', null, h('tr', null,
                h('th', null, '时间'), h('th', null, '代码'),
                h('th', null, '结果'), h('th', null, '说明')
              )),
              h('tbody', null, (d.history || []).slice(0, 25).map((x, i) =>
                h('tr', { key: i },
                  h('td', { className: 'ar-time' }, fmtTime(x.at)),
                  h('td', null, h('span', { className: 'ar-badge' }, x.code)),
                  h('td', null, x.ok
                    ? h('span', { className: 'ar-ok-mark' }, '✓ 成功')
                    : h('span', { className: 'ar-fail-mark' }, '✗ ' + (x.attempted ? '失败' : '未处理'))
                  ),
                  h('td', null, x.action || '')
                )
              ))
            )
          : h('div', { className: 'ar-empty' }, '还没有修复记录'),

        // 巡检日志
        h('div', { className: 'ar-section-title' }, '巡检日志'),
        (d.log || []).length
          ? h('div', { className: 'ar-log' }, (d.log || []).slice(0, 40).join('\n'))
          : h('div', { className: 'ar-empty' }, '暂无日志'),

        h('div', { className: 'ar-note' },
          '这个面板只是「看」和「手动戳一下」。真正的自动修复由独立守护进程执行——',
          '因为 DSH 自己崩溃的时候，面板也跟着没了。',
          h('br'),
          '逐条审批模式下，守护进程只诊断不修；点某一条的「修复」才会执行对应的白名单修复器。',
          h('br'),
          '手动诊断：',
          h('code', null, 'node auto-repair.mjs --check')
        )
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'auto-repair', order: 50, label: '自愈' },
            AutoRepairPanel
          )
        )
      }
    }
  }
})
