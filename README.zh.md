# dsh-plugin-github

[English](README.md) | 中文

把 GitHub 仓库接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：让 AI 直接 clone 你的仓库、读文件、改代码、提交，并按你的授权推送回远端。首次使用会引导你绑定 GitHub 账号，之后默认用这个账号。

- **纯 ESM JavaScript，无构建步骤、零运行时依赖**——不 import 任何 DSH 内部包，装完即用
- **账号绑定**：首次需要凭据时弹出引导，粘贴一次 PAT 即记住；支持多账号切换
- **默认只读安全**：`allowPush` / `allowApiWrite` 默认 `false`，写远端必须显式打开
- **凭据不落进仓库、不进命令行、不回显给模型**（见 [安全模型](#6-安全模型)）

## 1. 提供的工具

| 工具 | 作用 |
|---|---|
| `gh_account` | `bind`（绑定账号，不传 token 则弹出输入框）、`list`、`use`（切换默认账号）、`remove`、`status` |
| `gh_repo` | `clone`（克隆或 fetch 已存在克隆）、`status`、`diff`、`log`、`branches`、`create`（新建远端仓库） |
| `gh_file` | `get`（带行号窗口读文件）、`list`（列目录）、`put`（整份写入/新建）、`edit`（精确替换，`oldText` 必须唯一或显式给 `count`） |
| `gh_commit` | 暂存 + 提交；`push: true` 可一步提交并推送 |
| `gh_push` | 推送到 `origin`（受 `allowPush` 约束；`force` 仅 `--force-with-lease` 且需 `allowForcePush`） |
| `gh_pull` | 拉取远端（默认 `--ff-only`，分叉时明确失败而不是制造冲突；`rebase: true` 改用 rebase） |
| `gh_config` | `status`（凭据来源与对应账号，**不显示 token**）、`set`、`unset`（直接操作 DSH 凭据服务里的裸 token） |
| `gh_api` | 直接调用 GitHub REST API（issue / PR / Actions / 搜索等）。`GET`/`HEAD` 只读；写操作需要 `allowApiWrite: true` |

典型流程：

```
gh_account(action=bind)            # 首次：绑定账号（或在第一次需要凭据时自动弹出）
  → gh_repo(action=clone, repo="owner/repo")
  → gh_file(action=get/edit/put)
  → gh_commit(message="…")
  → gh_push()
```

## 2. 安装

需要 Node.js ≥ 20（DSH 自带运行时即可）。

```sh
dsh plugin --profile <你的 profile> add github:liufangrui1105/dsh-plugin-github
```

例如 desktop profile：

```sh
dsh plugin --profile desktop add github:liufangrui1105/dsh-plugin-github
```

也可以装本地目录或打包产物：

```sh
dsh plugin --profile desktop add ./dsh-plugin-github
dsh plugin --profile desktop add ./dsh-plugin-github-0.1.0.tgz   # pnpm pack 的产物
```

装完**完全退出并重启 DeepSeek Harness**，然后问一句「列出你能用的 gh_ 工具」验证。

> 本插件是纯 JavaScript，`src/` 就是可直接运行的产物，因此
> **不需要 `prepare` 构建脚本、也不会要求 `allowBuilds` 授权**。
> 插件目录里刻意没有 `prepare` / `build` / `install` 等脚本——它们的存在反而会让 npm 在每次安装时重建依赖。

> **关于升级**：从 GitHub 安装会按默认分支解析。改了代码后，重新执行一次
> `add github:liufangrui1105/dsh-plugin-github` 让 pnpm 重新解析并**重启 DSH**才会生效——
> 热加载不会重新拉取依赖，这点容易误会成「改了没用」。

卸载：

```sh
dsh plugin --profile desktop remove dsh-plugin-github
```

## 3. 绑定 GitHub 账号

**方式 A：让它问你（推荐）**

第一次调用需要凭据的操作（推送、拉取、创建仓库）时，插件会弹出输入框请你粘贴一个 Personal Access Token。它会先用 `/user` 校验身份，成功后才存下来并设为默认账号；之后所有调用都用这个账号，不再询问。

也可以随时主动触发：

```
gh_account(action="bind")                      # 弹出输入框
gh_account(action="bind", token="ghp_xxxx")    # 直接给出 token
```

**方式 B：不经过对话**

不想让 token 出现在会话记录里，就把环境变量 `GITHUB_TOKEN` 设置好再启动 DSH，或写进 `$DSH_HOME/.credentials.yaml`：

```yaml
version: 1
refs:
  GITHUB_TOKEN: ghp_xxxxxxxxxxxxxxxx
```

优先级（第一个命中的胜出）：**已绑定账号 → 环境变量 → `.credentials.yaml` 的 `refs:` → 工作区 `.env`**。绑定账号永远优先，所以「绑定了谁就用谁」不会被环境里恰好存在的 `GITHUB_TOKEN` 盖掉。

PAT 最小权限：读写仓库内容给 **`repo`**（fine-grained token 给 Contents: Read and write）；只读给 Contents: Read 即可。用 `gh_account(action="status")` 或 `gh_config(action="status")` 随时确认生效的账号与剩余配额。

**多账号**：多次 `bind` 会累积，最后一次绑定自动成为默认；用 `gh_account(action="use", login="…")` 切换，`action="remove"` 删除。

## 4. 配置

配置写在 profile 的 `cordis.patch.yml` 里该插件行的 `config:` 下（该文件只替换整行 `config`，不深合并）。

| 字段 | 默认 | 说明 |
|---|---|---|
| `workspaceRoot` | 宿主进程工作目录 | 本地克隆根目录。**所有 `gh_*` 路径都被限制在这个目录之内** |
| `gitExecutable` | `git` | 要执行的 git 可执行文件。当 git 不在常规位置（内置运行时、便携版安装）时指定它，而不是去改 `PATH` |
| `allowRepos` | `[]` | 仓库白名单，支持 `owner/repo`、`owner/*`、`*/repo`、`*`。空数组 = 不按仓库名限制。**只接受严格 owner/repo，完整 URL 会被拒绝** |
| `allowPush` | `false` | 是否允许推送/建远端仓库。**不开则 `gh_push` 与 `gh_commit{push:true}` 直接拒绝** |
| `allowForcePush` | `false` | 是否允许 `--force-with-lease` 强推（仍受 `allowPush` 约束） |
| `allowApiWrite` | `false` | 是否允许 `gh_api` 的 `POST/PATCH/PUT/DELETE`，以及 `gh_repo action=create` |
| `allowApiReadOutsideAllowlist` | `false` | 设为 `true` 可让只读 `gh_api` 访问白名单外的仓库（例如搜索公开仓库） |
| `allowNonGithubRemotes` | `false` | 是否允许 `github.com` 之外的远端（自建 Git 服务）。**默认关闭**：白名单只约束 `owner/repo` 不约束主机，放行任意主机等于允许把 PAT 发给任何主机 |
| `allowAutoBind` | `true` | 需要凭据时是否弹出绑定引导 |
| `promptForToken` | `true` | 是否允许在引导里让用户粘贴 token |
| `accountStorePath` | `$DSH_HOME/github-accounts.json` | 账号文件路径（仅在不使用 DSH 凭据服务时生效） |
| `tokenRef` | `GITHUB_TOKEN` | 凭据引用名（`$DSH_HOME/.credentials.yaml` 里 `refs:` 的键） |
| `tokenEnv` | `GITHUB_TOKEN` | 回退的环境变量名（再回退 `GITHUB_TOKEN` / `GH_TOKEN`） |
| `dotenv` | `true` | 是否再回退到工作区内的 `.env.local` / `.env` |
| `commandTimeoutMs` | `120000` | 单条 git 命令超时 |
| `maxDiffChars` / `maxReadChars` | `20000` / `40000` | 返回给模型的内容上限 |
| `gitAuthorName` / `gitAuthorEmail` | 未设 | 提交作者；不设则用 git 全局配置 |

开启写权限的例子：

```yaml
- id: github-repo
  config:
    allowPush: true
    allowApiWrite: true
    allowRepos:
      - your-name/your-repo
    workspaceRoot: '/path/to/clones'
```

## 5. 授权模型

白名单与凭据都必须针对**真正被操作的对象**判定，而不是参数派生出的字符串。这是本插件被独立审计后逐条修正的地方：

- **本地目录按 `owner__repo` 命名**，不同 owner 的同名仓库不会撞进同一个目录。
- **操作前校验目录里真实的远端地址**，与请求的仓库不一致就拒绝，绝不把改动推到错误的远端。
- **推送校验每一个 `pushurl`**，不只校验 fetch URL——只看 fetch URL 会被 `remote.origin.pushurl` 绕过，把带 PAT 的推送重定向到别的主机。
- **远端主机默认只允许 `github.com`**；白名单只约束 `owner/repo`，不校验主机的话 `http://attacker/your/repo.git` 就能通过白名单把 PAT 发出去。
- **`gh_api` 按规范化后的 `endpoint` 路径判定授权**，`..` 之类的路径穿越会被识破；白名单生效时无法确定仓库的仓库级端点（`/search/code`、`/user/repos` 等）一律拒绝。
- **`gh_file` 禁止写入 `.git/` 内部**（`config` 能重定向推送、`hooks/` 是任意代码执行）；读取仍然允许。
- **`allowRepos` 只接受严格 `owner/repo`**，完整 URL 一律拒绝。

## 6. 安全模型

- **路径**：每个读写路径都先解析成绝对路径、校验在 `workspaceRoot` 之内，并对已存在的最深祖先做一次 `realpath` 校验以防符号链接逃逸。
- **token 传递**：只通过子进程环境变量 `GIT_CONFIG_VALUE_0=http.extraHeader` 传给 git（Basic auth，`x-access-token:<PAT>`）。**不出现在命令行**（进程列表看不到）、**不写进 `.git/config`**、**不回显在工具结果里**。git 参数以数组传入、不经过 shell，因此没有命令注入面。
- **token 暴露窗口**：只有 `clone` / `fetch` / `push` / `pull` 会拿到 token；`status` / `diff` / `log` / `branches` / `add` / `commit` 一律不带。
- **账号存储**：优先用 DSH 凭据服务的 record（token 在 `key` 字段，账号元数据在 `env`）；宿主没挂载该服务时回退到 `$DSH_HOME/github-accounts.json`（POSIX 上按 0600 写入）。
- **写远端**：`allowPush` / `allowApiWrite` 显式开关 + `allowRepos` 白名单双重约束，且按真实操作对象判定。

### 已知暴露面

- **`gh_commit { push: true }` 与 `gh_push` 会把 token 放进 git 子进程环境**，因此仓库自带的 `pre-push` hook 能读到它。**只对可信仓库开启推送。**
- **通过对话输入 token 时，它会出现在会话记录里**。不希望如此就用环境变量或 `.credentials.yaml` 提供（见 [绑定账号](#3-绑定-github-账号) 的方式 B）。
- **宿主级 `git config` 里的 `url.*.insteadOf` 仍能重定向远端**，这属于宿主机配置的信任边界。
- 插件以你的身份运行，能读你能读的文件。上表是产品级边界，不是操作系统级隔离。

## 7. 已知限制与排错

### 网络：clone / push 需要更宽的沙箱权限

DSH 默认的 `workspace-write` 沙箱会挡住 git 的网络传输（实测报 `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`，且 MSYS 的 `sh.exe` 无法创建信号管道）。因此：

| 操作 | `workspace-write` 沙箱 | `danger-full-access` |
|---|---|---|
| `gh_account` / `gh_config`（用 Node `fetch`，非 git） | ✅ | ✅ |
| `gh_api`（`fetch`） | ✅ | ✅ |
| `gh_repo status/diff/log/branches`、`gh_file` 读写、`gh_commit`（纯本地） | ✅ | ✅ |
| `gh_repo clone` / `gh_pull` / `gh_push`（走 git HTTPS） | ❌ | ✅ |

要让 AI 真正 clone 和推送，请把会话权限设为 `danger-full-access`，或在这些操作上批准一次性提权。

### 其他

| 现象 | 原因 / 处理 |
|---|---|
| `gh_*` 工具一个都看不到 | 插件没装上或没重启。装完后完全退出 DSH 再启动 |
| 报「还没有绑定任何账号」 | 用 `gh_account(action="bind")` 绑定，或设置 `GITHUB_TOKEN` 环境变量 |
| 调用报 `value is not lossless JSON` | 插件版本过旧（输出里带 `undefined` 键）。升级到含 `output-contract.test.mjs` 的版本 |
| `gh_push` 报 `allowPush` | 配置里开 `allowPush: true` 并重启 |
| 401 / 认证失败 | `gh_account(action="status")` 确认凭据；私有仓库必须有 token |
| 403 且 `rate_remaining: 0` | 未认证请求的限额（60/小时）用尽；绑定 token 可到 5000/小时 |
| `edit` 报「oldText 出现 N 次」 | 扩大 `oldText` 让它唯一，或显式传 `count` |
| 分叉导致 `pull` 失败 | 用 `rebase: true`，或先提交本地改动 |

## 8. 开发

```sh
node test/git.test.mjs               # Git 执行层：11 项
node test/plugin.test.mjs            # 插件端到端：28 项（真实 git + 本地 smart HTTP 远端）
node test/account.test.mjs           # 账号绑定与首次引导：12 项
node test/output-contract.test.mjs   # 宿主 output 契约（无损 JSON）：5 项
node scripts/verify-registration.mjs # 注册约束：4 项
node scripts/validate-manifest.mjs   # package.json ↔ cordis.patch.yml ↔ 导出的插件名
```

`npm test` 跑四个测试套件，`npm run verify` 跑两个校验脚本。CI 在 Ubuntu 与 Windows、Node 20 与 22 上全部跑一遍——**特意包含 Windows**，因为 `src/git.js` 里有平台相关处理。

测试不需要外网：远端用 `git http-backend` 桥接的本地 smart HTTP 服务（`test/git-http-server.mjs`），clone / fetch / push 全链路都是真的。

> 不要用 `node --test`：受限沙箱下 node:test 的 runner 会用管道 stdio 启动子进程并返回 EPERM。
> 同理，`src/git.js` 把子进程 stdout/stderr 重定向到临时文件而不是用管道——这是本插件能在
> 沙箱里正常工作的关键。

## 9. 目录结构

```
dsh-plugin-github/
├── package.json              # 声明 dsh.bundle.patch
├── cordis.patch.yml          # 把插件行插入 profile 配置层（含全部默认配置）
├── README.md / README.zh.md  # 英文版与本文
├── CHANGELOG.md              # 版本变更记录
├── SECURITY.md               # 漏洞上报方式，以及哪些是已知暴露面
├── src/
│   ├── index.js              # 插件入口：构造 ToolDefinition 并注册
│   ├── tools.js              # 8 个工具的参数声明与实现
│   ├── store.js              # GitHub 账号存储（凭据服务 record / JSON 文件）
│   ├── prompt.js             # 首次使用的交互式绑定引导
│   ├── git.js                # 进程执行层（文件描述符 stdio）+ git 命令封装
│   ├── auth.js               # token 解析（绑定账号 → 环境变量 → 凭据服务 → .env）
│   ├── repos.js              # 仓库定位、白名单、路径越界防护
│   └── api.js                # GitHub REST 客户端（Node fetch）
├── scripts/
│   ├── verify-registration.mjs  # 按 dsh-tools 的注册规则校验工具定义
│   └── validate-manifest.mjs    # package.json ↔ cordis.patch.yml ↔ 导出的插件名
├── .github/workflows/test.yml   # CI：Ubuntu + Windows，Node 20 + 22
└── test/                     # 测试 harness + 4 个套件 + 本地 git HTTP 服务
```

## 10. 许可

[MIT](LICENSE)
