# dsh-auto-repair · 独立版

DeepSeek Harness 的自愈套装：一个**独立于 DSH 进程**的守护进程，加上 DSH 设置页里的「自愈」面板。守护进程负责诊断与修复，面板负责展示与手动触发。

这个「独立版」只关心 DSH 自己：不依赖、不检测、也不重启任何外部服务（SnowLuma、QQ 桥接等）。装上以后只需要两样东西——`DeepSeek Harness.exe` 所在的目录，和 DSH 自带的 node。

> 面板只是**看**和**手动触发**。真正的修复逻辑在独立的守护进程里，不在 DSH 进程树内。
> 这是故意的：DSH 自己起不来的时候，插件也跟着加载不了——而「起不来」恰恰是最需要自动修的那一类。

## 能诊断和修复什么

| 诊断项 | 级别 | 自动修复 |
|---|---|---|
| `BOM_CRASH` — profile 配置文件带 UTF-8 BOM，DSH 启动崩溃 | fatal | 剥掉 BOM 并重启 DSH |
| `LATENT_BOM` — 配置文件带 BOM，还没崩但下次启动会崩 | warn | 剥掉 BOM（不重启） |
| `DSH_DEAD` — DSH 进程完全不在了 | fatal | 不自动处理（可能是你主动关的） |
| `DSH_NO_PORT` — 进程在但没有监听端口 | warn | 不自动处理（可能在启动中） |

所有写文件的修复都会先备份原文件（`.auto-repair.bak-<时间戳>`），并在 `state/repair-history.jsonl` 里留记录。

## 功能

- 守护进程状态：是否存活、pid、巡检间隔
- 诊断结论：按 fatal / warn / info 分级展示，带证据
- 修复历史：最近修过什么、哪些没修成
- 一键修复 / 单条修复 / 忽略某一条
- **审批策略三档**：`manual`（默认，逐条审批）/ `approve-all`（全部自动）/ `reject-all`（全拒绝）
- **通知策略**：发通知 / 完全不发（修照常修，只不推送）
- **重复故障提醒**：同一故障反复出现时是否重复弹提醒
- **工作区选择**：首次使用自己指定，之后可随时修改，保存即生效

## 安装

```bash
dsh plugin --profile web add <你的安装源>
```

或本地开发安装：

```bash
dsh plugin --profile web add link:/path/to/dsh-auto-repair-ui
```

装完重启 DSH，面板出现在：**DSH → 左下角账号菜单 → 设置 → 左侧导航「自愈」**。

守护进程需要单独常驻（它必须在 DSH 之外，DSH 崩了它才救得了）：

```bash
node auto-repair.mjs
```

## 工作区（首次使用必读）

面板本身只是 UI，真正干活的是伴生守护进程 `auto-repair.mjs`。它需要一个「工作区根目录」——也就是**放着 `DeepSeek Harness.exe` 的那一级**（例如 `D:\大肥鱼`）。

### 第一次使用：自己指定

第一次打开面板时，最上方会出现「**首次使用：请先选择工作区**」，下面是「工作区」卡片：

- **手输**：直接在输入框填路径，回车或点「保存」；
- **选目录**：点「选择目录…」弹出系统文件夹对话框，选好后路径会填进输入框——**仍然要点「保存」才生效**，只选不保存不会写盘。

### 选错了会被拦下

保存时会校验目录，必须同时满足：

1. 路径存在，且是目录；
2. 里面有 **DeepSeek Harness 可执行文件**（`DeepSeek Harness*.exe`，不区分大小写）；
3. 不能直接选 `auto-repair` 本身——那样会提示「请选择上一级目录」。

任一条不满足都会**拒绝保存**，并在卡片下方列出缺少的项，同时说明应该指向哪一级。

### 以后怎么改

随时在同一个「工作区」卡片里改，输入或重新选择后点「保存」即可。生效值有三个来源，优先级从高到低：

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | 环境变量 `AUTO_REPAIR_ROOT` | 最高。一旦设置，**面板里怎么改都不生效**——面板保存的是配置文件，而环境变量始终压过它；此时卡片上会写明「当前由环境变量 AUTO_REPAIR_ROOT 指定」。要改就去改环境变量或取消它 |
| 2 | 面板保存的配置 | 存在 `state/workspace.json`，面板里修改的就是这一项 |
| 3 | 仓库自身目录 | 兜底。前两者都没有时使用，保证未配置也能启动（此时通常缺 DSH，面板会提示不可用） |

### 为什么保存后不用重启

面板每次触发诊断 / 修复时，都会把当前工作区以 `AUTO_REPAIR_ROOT` 注入到守护进程**子进程**的环境变量里。因此保存的那一刻起，**下一次诊断就走新目录**——不需要重启 DSH、不需要重启守护进程，也不需要改代码。守护进程自己下次启动时也会读取同一份 `state/workspace.json`。

## 审批策略

面板顶部的「审批策略」区可以切换三档，选择结果写回 `state/repair-policy.json`：

| 档位 | 行为 | 适用场景 |
|---|---|---|
| `manual`（默认） | 只诊断、不动手；所有修复都要人点 | 生产环境，或想先看清结论再决定 |
| `approve-all` | 白名单内的故障自动修复，不需要逐条确认 | 自家机器，追求无人值守 |
| `reject-all` | 一律不自动修，只报警 | 排障期，或怀疑自动修复会干扰现场 |

策略文件由守护进程在每次巡检时读取，所以**切换后立即生效，不用重启 DSH**。

## 通知策略

| 档位 | 行为 |
|---|---|
| `notify`（默认） | 修复成功 / 失败 / 待审批都照常推送（Windows 通知气泡） |
| `silent` | 照常修，但一条都不对外推送；修复历史与 `state/auto-repair.log` 照常记录 |

通知通道是 Windows 通知气泡，失败只留日志，绝不影响修复主流程。

## 安装位置与状态文件

| 组件 | 说明 |
|---|---|
| `index.js` | 宿主侧：把守护进程的能力暴露成 `/dsh-auto-repair/*` 接口 |
| `client.js` | 设置页里的「自愈」面板 |
| `auto-repair.mjs` | 巡检 + 修复的执行体，**必须在 DSH 进程树之外**常驻 |
| `diagnose.mjs` / `repair.mjs` / `policy.mjs` / `notify.mjs` | 诊断、修复、策略、通知 |
| `tools/workspace.mjs` | 工作区解析（环境变量 → `state/workspace.json` → 仓库自身） |
| `tools/net-listeners.mjs` | 可靠的监听端口探测（绕开 Windows state=0 的坑） |

状态文件（都在 `state/` 下，不会进仓库）：

| 文件 | 用途 |
|---|---|
| `auto-repair.pid` | 常驻进程的单实例锁 |
| `repair-policy.json` | 审批策略与忽略列表 |
| `notify-policy.json` | 通知总开关 |
| `repeat-alert.json` | 重复故障提醒开关 + 指纹账本 |
| `workspace.json` | 面板保存的工作区 |
| `repair-history.jsonl` | 修复历史 |
| `auto-repair.log` | 巡检日志 |

## 配置

| 变量 | 含义 | 默认 |
|---|---|---|
| `REPAIR_DIR` | 守护进程所在目录 | 插件目录或 `..` 下能找到 `auto-repair.mjs` 的那一级 |
| `AUTO_REPAIR_ROOT` | 工作区根目录（优先级最高，面板里改不动它） | 无；未设时读 `state/workspace.json`，再退回仓库自身目录 |
| `AUTO_REPAIR_INTERVAL_MS` | 巡检间隔（毫秒） | `30000` |

策略文件 `state/repair-policy.json` 字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `mode` | string | `manual` / `approve-all` / `reject-all` |
| `rejectedCodes` | string[] | 逐条忽略过的故障 code |

面板写策略一律通过守护进程的 `--set-policy`，保证合并语义只在 `policy.mjs` 一处实现。

## API

宿主侧注册在 DSH 的 webServer 上，前缀 `/dsh-auto-repair`：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-auto-repair/status` | 守护进程状态摘要 |
| GET | `/dsh-auto-repair/diagnose` | 跑一遍诊断，返回结论列表 |
| POST | `/dsh-auto-repair/repair` | 手动触发一轮修复 |
| GET | `/dsh-auto-repair/history` | 修复历史与频次计数 |
| GET / POST / PUT | `/dsh-auto-repair/policy` | 读 / 写审批策略（`mode`、`addRejected` / `removeRejected`） |
| GET / POST | `/dsh-auto-repair/notify-policy` | 读 / 写通知策略（`mode`: `notify` / `silent`） |
| GET / POST | `/dsh-auto-repair/repeat-alert` | 读 / 写重复故障提醒（`mode`: `on` / `off`） |
| GET / POST | `/dsh-auto-repair/workspace` | 读当前工作区 / 保存新的工作区（body: `path`；校验失败返回 400 并给出 `missing`） |
| POST | `/dsh-auto-repair/workspace/pick` | 弹系统「选择文件夹」对话框，返回路径（**不保存**，仍需再 POST 一次 `workspace`） |
| POST | `/dsh-auto-repair/repair-one` | 修指定的单条（body: `code`） |
| POST | `/dsh-auto-repair/repair-all` | 修补所有可修项 |
| POST | `/dsh-auto-repair/ignore` | 忽略 / 取消忽略（body: `code`、`ignored`） |

守护进程 CLI：`--check`、`--repair <CODE>`、`--repair-all`、`--once`、`--get-policy`、`--set-policy`、`--notify-test`。

## 版本与兼容性

当前版本 **1.5.0（独立版）**。

- 独立版：移除全部 SnowLuma 与 QQ 桥接相关能力（桥接进程 / 端口检测与重启、console-token 心跳、MCP 注册检查、面板里的相关卡片与文案），诊断与修复只保留 DSH 自身
- 保留：审批策略、通知策略、重复故障提醒、逐条处置、全部修复、工作区选择
- 依赖宿主守护进程支持 `--check`、`--repair <code>`、`--repair-all`、`--set-policy`、`--notify-test`

## 许可

Apache-2.0 · 蝠羽科技

**允许二次修改与再分发（含商业用途），但不得更改制作方署名。**

- 许可证全文：[LICENSE](./LICENSE)
- 署名与二改规则：[NOTICE](./NOTICE)
- 源码文件头部已带 Copyright 2026 蝠羽科技 版权声明，二次修改时必须保留；
  依 Apache-2.0 第 4(c)、4(d) 条，衍生作品须保留全部版权与署名声明，
  并复制 NOTICE 中的署名内容。删除或改写署名即不再符合本许可。
- 二次修改者可以在保留原署名的前提下，额外标注自己的修改说明与版权声明。
