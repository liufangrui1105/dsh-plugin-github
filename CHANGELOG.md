# Changelog

Notable changes per release. This project follows [Semantic Versioning](https://semver.org/)
and the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [Unreleased]

Nothing yet.

## [0.1.0] — 2026-10-15

First release.

### Added

- **Eight model-facing tools**: `gh_account`, `gh_repo`, `gh_file`, `gh_commit`,
  `gh_push`, `gh_pull`, `gh_config`, `gh_api`.
- **Account binding.** The first call that needs credentials prompts for a PAT,
  validates it against `/user`, stores it, and continues the original operation.
  Several accounts can be bound and switched with `gh_account use`; a bound account
  outranks a `GITHUB_TOKEN` in the environment.
- **Account storage** in a DSH credential record when the host mounts
  `ctx.credentials`, otherwise in `$DSH_HOME/github-accounts.json` (mode 0600 on
  POSIX).
- **Local git workflow**: clone or fetch into the workspace, read a file with line
  numbers, list a directory, write or exact-replace a file, diff, log, branches,
  commit, push (`--force-with-lease` only), and fast-forward pull.
- **`gh_api`** for the REST surface the other tools do not cover (issues, PRs,
  Actions, search), with writes behind `allowApiWrite`.
- **Permission model**: `allowPush`, `allowForcePush`, `allowApiWrite` and
  `allowApiReadOutsideAllowlist` default to `false`; `allowRepos` accepts strict
  `owner/repo`, `owner/*`, `*/repo` and `*`.
- **Authorization against the acted-on object** rather than argument-derived
  strings: `owner__repo` local directory names, verification of the real remote
  before acting, validation of every `pushurl`, a `github.com`-only remote host by
  default, endpoint-path authorization for `gh_api`, and refusal to write inside
  `.git/`.
- **CI** running the suites on Ubuntu and Windows across Node 20 and 22.

### Security

Seven issues found by an adversarial review and fixed before the first release,
each with a regression test. The recurring shape was authorizing a *derived
string* instead of the object actually acted on:

1. same-named repositories under different owners could collide into one local
   directory and push to the wrong remote;
2. `gh_api` authorized `args.repo` but sent the request to `args.endpoint`;
3. read-only `gh_api` calls ignored `allowRepos`;
4. `allowRepos` rules could be full URLs, so a host was never checked;
5. `gh_repo action=create` mutated GitHub with no allowlist check;
6. `GH_TOKEN` was dead code in the fallback chain;
7. `status`/`log`/`branches` reported success on a broken repository.

A second review round added: validation of every push URL (a `pushurl` in
`.git/config` could redirect a PAT-bearing push), refusal to write inside `.git/`,
a host check on the clone target, endpoint-path normalization so `..` cannot
escape the allowlist, refusal of repository-scoped endpoints whose repository
cannot be determined while an allowlist is active, and `owner` required for
`create` when `allowRepos` is set.

### Fixed

- Tool output carrying `undefined` keys was rejected by the host with
  `value is not lossless JSON`; optional fields are now removed before returning.
- Commits failed with "Author identity unknown" on a machine with no global git
  config; `gitAuthorName` / `gitAuthorEmail` supply the identity, and a test runs
  with the global config removed.
- A clone inherited the operator's `core.autocrlf`, so on Windows every file was
  rewritten to CRLF and an exact-match edit failed; clones now pass
  `-c core.autocrlf=false`.
- Credentials echoed by git in captured output are now redacted.
- A corrupt account file is moved aside rather than silently dropped.

[Unreleased]: https://github.com/liufangrui1105/dsh-plugin-github/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/liufangrui1105/dsh-plugin-github/releases/tag/v0.1.0
