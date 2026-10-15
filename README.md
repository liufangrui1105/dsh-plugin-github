# dsh-plugin-github

English | [中文](README.zh.md)

Connect GitHub repositories to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): let the agent clone your repositories, read and edit files, commit, and push back to the remote — within the permissions you grant. The first time credentials are needed it asks you to bind a GitHub account, and every later call uses that account by default.

- **Plain ESM JavaScript, no build step, zero runtime dependencies** — it imports no `@deepseek-ai/*` package, so it cannot fail to load because a package did not resolve
- **Account binding** — a first-run prompt collects a PAT once and remembers it; multiple accounts can be bound and switched
- **Read-only-safe by default** — `allowPush` and `allowApiWrite` default to `false`; writing to a remote must be enabled explicitly
- **Credentials never land in the repository, the command line, or the model's context** (see [Security model](#6-security-model))

## 1. Tools

| Tool | What it does |
|---|---|
| `gh_account` | `bind` (prompts for a token when none is passed), `list`, `use` (switch the default account), `remove`, `status` |
| `gh_repo` | `clone` (or fetch an existing clone), `status`, `diff`, `log`, `branches`, `create` (create a remote repository) |
| `gh_file` | `get` (line-numbered window), `list`, `put` (whole-file write/create), `edit` (exact replacement — `oldText` must be unique or `count` must be given) |
| `gh_commit` | Stage and commit; `push: true` commits and pushes in one step |
| `gh_push` | Push to `origin` (gated by `allowPush`; `force` uses `--force-with-lease` only and needs `allowForcePush`) |
| `gh_pull` | Pull from the remote (defaults to `--ff-only`, so a divergence fails loudly instead of creating a merge; `rebase: true` switches to rebase) |
| `gh_config` | `status` (credential source and account, **never the token**), `set`, `unset` — operates on a bare token in the DSH credential service |
| `gh_api` | Call the GitHub REST API directly (issues, PRs, Actions, search, …). `GET`/`HEAD` are read-only; writes need `allowApiWrite: true` |

Typical flow:

```
gh_account(action=bind)            # first run: bind an account (or let the first call that needs credentials prompt)
  → gh_repo(action=clone, repo="owner/repo")
  → gh_file(action=get/edit/put)
  → gh_commit(message="…")
  → gh_push()
```

## 2. Install

Node.js ≥ 20 is required (the runtime bundled with DSH is fine).

```sh
dsh plugin --profile <your profile> add github:liufangrui1105/dsh-plugin-github
```

For the desktop profile:

```sh
dsh plugin --profile desktop add github:liufangrui1105/dsh-plugin-github
```

A local directory or a packed tarball works too:

```sh
dsh plugin --profile desktop add ./dsh-plugin-github
dsh plugin --profile desktop add ./dsh-plugin-github-0.1.0.tgz   # output of pnpm pack
```

Then **fully quit and restart DeepSeek Harness**, and ask it to list the `gh_*` tools it can use.

> This plugin is plain JavaScript: `src/` *is* the runnable artifact, so it needs
> **no `prepare` build script and no `allowBuilds` approval**. The package deliberately defines no
> `prepare` / `build` / `install` script — their mere presence makes npm rebuild the dependency on every install.

> **Upgrading**: a GitHub install resolves the default branch. After changing the code, run
> `add github:liufangrui1105/dsh-plugin-github` again so pnpm re-resolves it, then **restart DSH**.
> Hot reload only reloads modules already loaded; it does not re-fetch dependencies. This is easy to
> mistake for "my change had no effect".

Uninstall:

```sh
dsh plugin --profile desktop remove dsh-plugin-github
```

## 3. Binding a GitHub account

**Option A — let it ask (recommended)**

The first time an operation needs credentials (push, pull, create repository), the plugin opens an input box asking for a Personal Access Token. It validates the token against `/user` first, stores it only on success, and makes it the default account; every later call uses it without asking again.

You can also trigger it explicitly:

```
gh_account(action="bind")                      # open the input box
gh_account(action="bind", token="ghp_xxxx")    # pass the token directly
```

**Option B — without going through the conversation**

If you would rather the token never appear in the session transcript, provide it out of band: set `GITHUB_TOKEN` before starting DSH, or write it into `$DSH_HOME/.credentials.yaml`:

```yaml
version: 1
refs:
  GITHUB_TOKEN: ghp_xxxxxxxxxxxxxxxx
```

Resolution order (first hit wins): **bound account → environment variable → `refs:` in `.credentials.yaml` → workspace `.env`**. A bound account always wins, so "I bound X" is never silently overridden by a `GITHUB_TOKEN` that happens to exist in the environment.

Minimum PAT scope: **`repo`** for read/write repository content (for a fine-grained token, Contents: Read and write); Contents: Read is enough for read-only use. Use `gh_account(action="status")` or `gh_config(action="status")` to check the effective account and remaining rate limit.

**Multiple accounts**: each `bind` accumulates, and the most recent binding becomes the default. Switch with `gh_account(action="use", login="…")` and delete with `action="remove"`.

## 4. Configuration

Configuration lives under the plugin row's `config:` in the profile's `cordis.patch.yml` (that file replaces the whole `config` value; it does not deep-merge).

| Field | Default | Meaning |
|---|---|---|
| `workspaceRoot` | host process working directory | Root for local clones. **Every `gh_*` path is confined to this directory** |
| `gitExecutable` | `git` | The git executable to run. Set it when git lives somewhere unusual — a bundled runtime, a portable install — instead of editing `PATH` |
| `allowRepos` | `[]` | Repository allowlist: `owner/repo`, `owner/*`, `*/repo`, `*`. Empty means no restriction by repository name. **Only strict `owner/repo` is accepted; full URLs are rejected** |
| `allowPush` | `false` | Allow pushing and creating remote repositories. **While off, `gh_push` and `gh_commit{push:true}` are refused outright** |
| `allowForcePush` | `false` | Allow `--force-with-lease` (still requires `allowPush`) |
| `allowApiWrite` | `false` | Allow `POST/PATCH/PUT/DELETE` on `gh_api`, and `gh_repo action=create` |
| `allowApiReadOutsideAllowlist` | `false` | Set `true` to let read-only `gh_api` reach repositories outside the allowlist (e.g. searching public repositories) |
| `allowNonGithubRemotes` | `false` | Allow remotes other than `github.com` (self-hosted Git). **Off by default**: the allowlist constrains `owner/repo` but not the host, so allowing any host means allowing the PAT to be sent anywhere |
| `allowAutoBind` | `true` | Whether to prompt for account binding when credentials are needed |
| `promptForToken` | `true` | Whether the prompt may collect a pasted token |
| `accountStorePath` | `$DSH_HOME/github-accounts.json` | Account file path (used only when the DSH credential service is not mounted) |
| `tokenRef` | `GITHUB_TOKEN` | Credential reference name (the key under `refs:` in `$DSH_HOME/.credentials.yaml`) |
| `tokenEnv` | `GITHUB_TOKEN` | Environment variable to fall back to (then `GITHUB_TOKEN` / `GH_TOKEN`) |
| `dotenv` | `true` | Also fall back to `.env.local` / `.env` in the workspace |
| `commandTimeoutMs` | `120000` | Timeout for a single git command |
| `maxDiffChars` / `maxReadChars` | `20000` / `40000` | Cap on content returned to the model |
| `gitAuthorName` / `gitAuthorEmail` | unset | Commit author; unset means the git global configuration |

Enabling writes:

```yaml
- id: github-repo
  config:
    allowPush: true
    allowApiWrite: true
    allowRepos:
      - your-name/your-repo
    workspaceRoot: '/path/to/clones'
```

## 5. Authorization model

An allowlist and a credential must be judged against **the object actually acted on**, never against a string derived from the arguments. This is the area an independent audit attacked, and every item below is a fix for it:

- **Local directories are named `owner__repo`**, so same-named repositories under different owners cannot collide into one directory.
- **The real remote in the directory is verified before acting**; if it is not the requested repository the operation is refused, so a change can never be pushed to the wrong remote.
- **Every `pushurl` is validated before pushing**, not just the fetch URL — checking only the fetch URL lets `remote.origin.pushurl` redirect a PAT-bearing push to another host.
- **Only `github.com` is an allowed remote host by default.** The allowlist constrains `owner/repo` but not the host; without that check, `http://attacker/your/repo.git` passes the allowlist and the PAT goes to the attacker.
- **`gh_api` authorizes against the normalized `endpoint` path**, so path traversal such as `..` is caught; while an allowlist is active, repository-scoped endpoints whose repository cannot be determined (`/search/code`, `/user/repos`, …) are refused.
- **`gh_file` refuses to write inside `.git/`** (`config` can redirect pushes; `hooks/` is arbitrary code execution). Reading is still allowed.
- **`allowRepos` accepts only strict `owner/repo`**; full URLs are rejected.

## 6. Security model

- **Paths**: every read and write path is resolved to an absolute path, checked to be inside `workspaceRoot`, and the deepest existing ancestor is checked with `realpath` to prevent symlink escape.
- **How the token travels**: only through the child process environment variable `GIT_CONFIG_VALUE_0=http.extraHeader` (Basic auth, `x-access-token:<PAT>`). It **never appears on the command line** (invisible to process listings), is **never written to `.git/config`**, and is **never echoed in a tool result**. Arguments are passed to git as an array with no shell, so there is no command-injection surface.
- **Token exposure window**: only `clone`, `fetch`, `push` and `pull` receive the token; `status`, `diff`, `log`, `branches`, `add` and `commit` never do.
- **Account storage**: prefers a DSH credential record (the token in the `key` field, account metadata in `env`); when the host does not mount that service it falls back to `$DSH_HOME/github-accounts.json`, written with mode 0600 on POSIX.
- **Remote writes**: the explicit `allowPush` / `allowApiWrite` switches plus the `allowRepos` allowlist, both judged against the object actually acted on.

### Known exposure

- **`gh_commit { push: true }` and `gh_push` place the token in the git child process environment**, so a `pre-push` hook shipped by the repository can read it. **Enable pushing only for repositories you trust.**
- **A token pasted into the prompt appears in the session transcript.** To avoid that, supply it via the environment or `.credentials.yaml` (Option B in [Binding a GitHub account](#3-binding-a-github-account)).
- **`url.*.insteadOf` in host-level `git config` can still redirect a remote.** That is the trust boundary of the host machine's configuration.
- The plugin runs as you and can read the files you can read. The list above is a product-level boundary, not an operating-system sandbox.

## 7. Known limitations and troubleshooting

### Networking: clone and push need a wider sandbox

The default `workspace-write` sandbox blocks git's network transport (observed as `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`, plus MSYS `sh.exe` being unable to create a signal pipe). Therefore:

| Operation | `workspace-write` sandbox | `danger-full-access` |
|---|---|---|
| `gh_account` / `gh_config` (Node `fetch`, not git) | ✅ | ✅ |
| `gh_api` (`fetch`) | ✅ | ✅ |
| `gh_repo status/diff/log/branches`, `gh_file`, `gh_commit` (purely local) | ✅ | ✅ |
| `gh_repo clone` / `gh_pull` / `gh_push` (git over HTTPS) | ❌ | ✅ |

To let the agent actually clone and push, set the session to `danger-full-access`, or approve a one-off escalation for those operations.

### Other

| Symptom | Cause / fix |
|---|---|
| No `gh_*` tools visible at all | The plugin is not installed, or DSH was not restarted. Install it, then fully quit and start DSH again |
| "no GitHub account has been bound" | Run `gh_account(action="bind")`, or set the `GITHUB_TOKEN` environment variable |
| A call fails with `value is not lossless JSON` | The plugin is an older version (its output carried `undefined` keys). Upgrade to a version that includes `output-contract.test.mjs` |
| `gh_push` reports `allowPush` | Enable `allowPush: true` in the config and restart |
| 401 / authentication failure | Check credentials with `gh_account(action="status")`; a private repository requires a token |
| 403 with `rate_remaining: 0` | The unauthenticated limit (60/hour) is exhausted; binding a token raises it to 5000/hour |
| `edit` reports "oldText appears N times" | Widen `oldText` until it is unique, or pass `count` explicitly |
| `pull` fails on a divergence | Use `rebase: true`, or commit local changes first |

## 8. Development

```sh
node test/git.test.mjs               # git execution layer: 11 cases
node test/plugin.test.mjs            # plugin end to end: 28 cases (real git + a local smart-HTTP remote)
node test/account.test.mjs           # account binding and first-run prompt: 12 cases
node test/output-contract.test.mjs   # host output contract (lossless JSON): 5 cases
node scripts/verify-registration.mjs # tool registration constraints: 4 cases
node scripts/validate-manifest.mjs   # package manifest and bundle patch wiring
```

`npm test` runs the four suites; `npm run verify` runs the two validators. CI runs all of it on
Ubuntu and Windows across Node 20 and 22 — Windows included on purpose, because `src/git.js`
carries platform-specific handling.

The tests need no internet: the remote is a local smart-HTTP server bridged onto `git http-backend` (`test/git-http-server.mjs`), and clone / fetch / push run for real.

> Do not use `node --test`: under this sandbox its runner starts child processes with piped stdio and returns EPERM.
> For the same reason `src/git.js` redirects a child's stdout/stderr to temporary files instead of using pipes —
> that is what lets this plugin work inside the DSH sandbox at all.

## 9. Layout

```
dsh-plugin-github/
├── package.json              # declares dsh.bundle.patch
├── cordis.patch.yml          # inserts the plugin row into a profile's config layer (with all defaults)
├── README.md / README.zh.md  # this file, and its Chinese counterpart
├── CHANGELOG.md              # release notes
├── SECURITY.md               # how to report a vulnerability, and what is a known exposure
├── src/
│   ├── index.js              # plugin entry: builds ToolDefinitions and registers them
│   ├── tools.js              # the 8 tools: parameter declarations and implementations
│   ├── store.js              # GitHub account storage (credential-service record / JSON file)
│   ├── prompt.js             # the first-run interactive binding prompt
│   ├── git.js                # process layer (file-descriptor stdio) + git command wrappers
│   ├── auth.js               # token resolution (bound account → env → credential service → .env)
│   ├── repos.js              # repository resolution, allowlist, path-escape guards
│   └── api.js                # GitHub REST client (Node fetch)
├── scripts/
│   ├── verify-registration.mjs  # the tool definitions against dsh-tools' registration rules
│   └── validate-manifest.mjs    # package.json ↔ cordis.patch.yml ↔ exported plugin name
├── .github/workflows/test.yml   # CI: Ubuntu + Windows, Node 20 + 22
└── test/                     # test harness + 4 suites + the local git HTTP server
```

## 10. License

[MIT](LICENSE)
