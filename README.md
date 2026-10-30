<div align="center">
  <img src="icon.svg" alt="dsh-opencode-engine" width="120">

# dsh-opencode-engine

**简体中文** | [English](#english)

  <img alt="许可证" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square">
  <img alt="版本" src="https://img.shields.io/badge/version-0.2.10-4b6fff?style=flat-square">
  <img alt="协议" src="https://img.shields.io/badge/ACP-1.4.0-2f6f4f?style=flat-square">
  <img alt="宿主" src="https://img.shields.io/badge/host-DeepSeek%20Harness-7da1de?style=flat-square">

</div>

把 **opencode** 编码引擎接进 DeepSeek Harness，作为**进程外子会话**运行：插件自己实现一个
ACP provider，spawn `opencode acp` 子进程，通过 ACP（Agent Client Protocol）驱动它，
并把引擎的权限请求桥接到宿主原生的审批卡上。模型跑在引擎侧，免费车道由引擎自己负责。

> *Plug the **opencode** coding engine into DeepSeek Harness as an **out-of-process
> subagent session**: this plugin owns an ACP provider, spawns `opencode acp`, drives
> it over the Agent Client Protocol, and bridges the engine's permission requests onto
> the host's native approval cards. The models live on the engine side.*

---

## 它解决什么问题

Harness 自带的 `@deepseek-ai/dsh-subagent-acp` 是**一次性**的（只有 `startExternal`，没有
`prepareContinuable`）。而 opencode 声明了 `loadSession: true` 并如实实现 `session/load`。
所以要做的是"**续接**一个真实引擎会话"，而不是"每次重开一个会话再把摘要粘进去"——
就必须自己接管这个 provider。这正是本插件存在的理由，也是 `/opencode -r` 能真正接上
上一轮引擎会话的原因。

## 架构

```
DeepSeek Harness (Host)
   │   ctx.subagents / ctx.commands / ctx.approval / ctx.subprocess / ctx.storageDomain
   ▼
dsh-opencode-engine  (lib/index.js)
   ├─ 注册 provider `opencode-acp`
   ├─ 注册命令 `/opencode`
   ├─ 审批桥  session/request_permission → ctx.approval.request → 审批卡 → 回到 ACP
   ├─ 静默看门狗 + 失败分类回执
   └─ 存储域 opencode_engine（记住"本 Harness 会话用过哪个引擎会话"）
   │   spawn（子进程接缝，Windows 上挂进 Job 对象，dispose 时回收）
   ▼
opencode acp   ← stdio ndjson，ACP 1.4.0
   │   session/new · session/load · session/prompt · session/set_config_option
   ▼
opencode 引擎会话  →  引擎侧的模型（含免费车道）
```

引擎的写入**不经过** Harness 的文件工具，所以插件自己走 git 快照来给出"本次改了哪些文件"
的回执；不在 git 仓库里就省略该列表。

## 安装

前置：Node.js ≥ 20、pnpm（或 npm）、已装好 opencode，以及一个能装 bundle 的 DeepSeek Harness。

```bash
git clone https://github.com/huyu007/dsh-opencode-engine.git
cd dsh-opencode-engine
pnpm install          # 安装 dependencies（宿主侧同名包走 peerDependencies，不会重复打包）
npm pack              # → dsh-opencode-engine-0.2.7.tgz
```

然后二选一：

- **GUI**：宿主插件页 → 安装本地包 → 选中上面那个 `.tgz`。
- **命令行**：用宿主的插件管理入口把该 bundle 装上（`install_bundle`）。

装完宿主会热挂载补丁，**不需要重启**。

## 配置

`cordis.patch.yml` 里的 `config` 就是插件的 `Config`（见 `lib/index.js`）。

| 键 | 类型 / 默认 | 说明 |
| --- | --- | --- |
| `engineCommand` | string / `''` | **必填**。opencode 可执行文件的绝对路径。公共版不带任何机器路径默认值；留空时运行会返回 `【config】` 失败回执并写 operator 日志，不会抛异常。**可在配置面板（Settings → Plugins）里改**，也可写 profile 补丁。 |
| `engineArgs` | string[] / `['acp','--print-logs','--log-level','WARN']` | `--print-logs --log-level WARN` 是**承重的**，不是装饰：opencode 只在自己的日志文件里报告 Zen 车道耗尽，去掉它就等于让"额度墙"和"卡死"长得一模一样。 |
| `permission` | `'allow'｜'reject'｜'ask'` / `'allow'` | 见下**三态语义**。 |
| `idleTimeoutMs` | number / `300000` | **静默**看门狗，不是耗时上限。引擎报告死车道的方式就是"一个字都不输出"，所以阈值取 5 分钟：一次真实写入实测十几到二十几秒，`session/load` 加多步编辑合理地要跑几分钟。设 0 关闭。 |
| `approvalTimeoutMs` | number / `300000` | 审批卡多久没人回答算拒绝。**超时永不等于放行**。 |
| `changeList` | boolean / `true` | 回执附带本次改动文件列表（git 快照）。 |
| `transcriptDir` | string / `'.opencode-engine'` | 每次运行把引擎全文写进 `<cwd>/<transcriptDir>/`，另留一份稳定的 `last-run.md`。它是唯一不依赖宿主投递语义的可见性兜底（宿主在某些状态下会静默丢弃子代理的结算通知）。设 `''` 关闭。 |
| `providerName` | string / `'opencode-acp'` | provider 名。 |
| `commandName` | string / `'opencode'` | 命令名，即 `/opencode`。 |
| `model` / `agent` | string / `''` | 默认透传给引擎的模型 / agent（走 `session/set_config_option`）。 |
| `withSummary` | boolean / `false` | 任务前是否附带本会话的压缩快照。 |
| `cwdAlign` | boolean / `true` | 引擎工作目录对齐父会话工作目录。 |
| `disposeGraceMs` | number / `3000` | 子进程终止宽限。 |

### `permission` 三态语义

- **`ask`** — 每个引擎 `session/request_permission` 都过 `ctx.approval.request`（审批卡），
  结果写回 ACP：`allowed-once → allow_once` 选项，其余一律 `reject_once`。这座桥**fail closed**：
  审批服务缺失、拿不到 agent、审批超时、运行被中止——全部拒绝引擎，绝不因为"没答案"而放行。
- **`allow`** — 不问人，直接取引擎给出的第一个 allow 选项。
- **`reject`** — 全部拒绝，引擎将无法写文件。

### no-turn：`/opencode` 命令路径为什么拿不到审批卡

`ctx.approval.request` 要求**存在一个 open turn**——`approval/asked` 与 `approval/decided`
这对审计记录必须落在持久日志的提交边界内，服务在 turn 外会直接抛错。
而**命令是在 turn 机制之外执行的**（这一点与模型发起的工具调用不同）。

所以在 `/opencode` 路径上、`permission: ask` 时，引擎的每次权限请求都会被判定为 `no-turn`
并**拒绝**（fail closed），回执会明确告诉你原因，而不是让你以为审批卡坏了。
插件**不会**伪造一个 turn——那等于伪造会话结构。

> 需要人在环上审批时：**用 turn 内的 `opencode` 委派工具**（模型自然语言调用那条路径），
> 或者把 `permission` 设为 `allow`。

## 使用

```
/opencode 把 src/ 里的 TODO 注释清掉，改完跑一次测试
/opencode -r 再补一下边界情况的测试        # 续接上一轮引擎会话（session/load）
/opencode --model <id> <任务>
/opencode --agent <name> <任务>
/opencode --with-summary <任务>            # 带上本会话的压缩快照
/opencode --no-context <任务>              # 原样发送，不加任何上下文
/opencode --detach <任务>                  # 立即返回，输出留在子会话里看
/opencode --cwd <path> <任务>              # 进阶：覆盖引擎工作目录
```

默认路径会**等**引擎跑完并把答案贴回当前会话。`--detach` 时进度与输出在侧栏子代理面板的
该会话内查看；`permission: ask` 下越权操作仍会弹审批卡。

**自然语言委派**：补丁同时注册了 `opencode` 工具（绑定到 provider），所以直接说
"让 opencode 去实现 X" 也能到达引擎，而这条路是在 turn 内的——审批卡正常工作。

## 前提

- opencode 已安装，并且**已经登录 / 配好它自己的模型车道**。本插件不管理任何凭据。
- Zen 免费车道的配额是**出口 IP 级的分钟窗口**：同 IP 上多个进程会互相挤占，撞上墙时
  表现是"引擎静默"而不是报错——这就是 `--print-logs` 与静默看门狗存在的原因。
- Windows 上 `engineCommand` **必须指向 `.exe`**，不能是 `opencode.cmd`：子进程接缝走
  `CreateProcessW`，可执行文件探测只认 `.com`/`.exe`，`.cmd` 包装会 `spawn EINVAL`。

## 已知限制

- **长任务上的 interrupt 未在真机验证**。取消会走到 provider 的 dispose 路径，但引擎在
  长 turn 中途被取消的行为我们没有逐场景实测，别把它当作已验证的可靠语义。
- **引擎升级后可能需要改 `engineCommand`**：npm 全局 / Desktop / 不同版本的 opencode 落在
  不同路径上，路径写死在配置里，升级后失效就手动更新。
- ACP 版本钉在 `1.4.0`。引擎若要求更高协商版本，会归为 `protocol` 类失败。
- 改动文件列表依赖 git；非 git 工作区里该列表被省略。

## 失败分类

回执不会只说"任务失败"。四类原因需要用户做四件不同的事：

| kind | 含义 | 你该做什么 |
| --- | --- | --- |
| `quota` | 免费车道额度耗尽（从引擎 stderr 判定） | 等额度恢复，或换 `--model`／订阅 |
| `silent` | 引擎活着但激活后一个事件都没有 | 先重试；持续如此调大 `idleTimeoutMs` 或换模型 |
| `timeout` | 有进展后停住（看门狗触发） | 调大 `idleTimeoutMs`，或先用更小的任务试探 |
| `crash` | 引擎进程异常退出 | 检查 `engineCommand` 是否存在且可执行 |
| `protocol` | ACP 协议不一致 / 会话失效 | 重开一个任务，仍失败则提 issue |

## 0.2.10 变更（相对 0.2.7）

- **宿主包全部改为 peer**：`@deepseek-ai/*` 不再进 `dependencies`。pnpm 会把 `dependencies`
  物理 hoist 进 profile 树（`autoInstallPeers:false` 下 peer 只声明不安装），rc.2 版本的
  `dsh-session`/`dsh-brand`/`dsh-storage-domain` 因此影子化了 asar 内的 rc.5 安装树，
  导致 rc.5 宿主拿不到 `sessions` 服务而启动失败。写 peer 后由 Node 解析到运行中运行时自己的副本。
- **peer 区间放宽为 `>=0.2.1-rc.2 <0.3.0`**，下一次运行时升级不会再因钉死版本被拒绝挂载。
- **`engineCommand`/`model`/`agent` 改为 `volatile`**：可在配置面板内热改；未配置时返回
  `【config】` 失败回执（不抛异常）。
- **回执不再丢弃引擎正文**：正文与运行事实（stop reason / engine session / 改动文件）并存；
  另把引擎全文落盘到 `transcriptDir`，截断与 `--detach` 提示指向真实文件，不再指向不存在的"子会话"。


## English

**What it does.** `dsh-opencode-engine` connects the **opencode** coding engine to
DeepSeek Harness as an **out-of-process subagent session**. The plugin owns an ACP
provider, spawns `opencode acp`, drives it over the Agent Client Protocol, and bridges
permission requests onto the host's native approval cards. Models are the engine's
concern — including its free lanes.

**Why not the stock ACP subagent?** `@deepseek-ai/dsh-subagent-acp` is strictly one-shot
(`startExternal`, no `prepareContinuable`), while opencode advertises `loadSession: true`
and honours `session/load`. Continuing a real engine session — instead of pasting a
summary into a fresh one — requires owning the provider. That is what `/opencode -r` does.

**Install.** `pnpm install && npm pack`, then install the resulting `.tgz` from the host's
plugin page (or via its bundle install entry). No host restart is needed.

**Configuration.** Every key is documented in the table above; `engineCommand` is the only
required one and ships with no default. Keep `--print-logs` in `engineArgs`: opencode
reports an exhausted free lane *only* in its own log file, so without that mirror a quota
wall is indistinguishable from a hang.

**`permission`.** `ask` sends every engine permission request through the host's approval
card and writes the outcome back to ACP, failing **closed** on a missing approval service,
an absent agent, a timeout, or an abort. `allow` takes the first allow option without a
human. `reject` declines everything, leaving the engine unable to write.

**No-turn fail-closed.** `approval.request` needs an open turn, and slash commands execute
outside the turn machinery. So on the `/opencode` path with `permission: ask`, engine
permission requests are denied as `no-turn` and the receipt says so. Use the in-turn
`opencode` delegation tool when you want a human in the loop, or set `permission: allow`.

**Usage.** `/opencode <task>` runs a task and waits for the answer; `-r` continues the last
engine session over `session/load`; `--detach` returns immediately; `--model`/`--agent` pass
configuration through to the engine; `--with-summary`/`--no-context` control context. You can
also ask the model to delegate to opencode in natural language.

**Prerequisites.** opencode must already be installed and logged into its own model lane —
this plugin stores no sign-in material. The Zen free lane is rate-limited per source IP in
minute windows, so several processes behind one IP compete. On Windows `engineCommand` must
point at an `.exe`: the spawn seam goes through `CreateProcessW` and rejects `.cmd` wrappers
with `spawn EINVAL`.

**Known limitations.** Interrupting long-running engine tasks is **not verified on real
hardware** — cancellation reaches the dispose path, but mid-turn engine behaviour was never
exercised scenario by scenario. Engine upgrades may change where the executable lives, so
update `engineCommand` after upgrading. ACP is pinned to 1.4.0.

**Failure receipts** are classified into `quota`, `silent`, `timeout`, `crash`, and
`protocol`, each with an actionable hint — because "the task failed" is never a useful answer.

## License

MIT — see [LICENSE](LICENSE).
