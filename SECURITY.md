# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Use GitHub's private
vulnerability reporting instead: open the **Security** tab of this repository and
choose **Report a vulnerability**. That opens a private thread with the maintainer.

If you cannot use that form, open a normal issue that says only that you have a
security report and how to reach you, without the technical detail, and the
maintainer will follow up privately.

Please include, as far as you can:

- what an attacker would gain, and what access they need to start with;
- the exact tool call, configuration, and repository state that triggers it;
- whether the token, the local filesystem outside `workspaceRoot`, or a remote
  repository is affected.

## Supported versions

The latest release on `main` is supported. Fixes are released as a new commit on
`main`; there are no maintained release branches.

## What this plugin defends, and what it does not

The model-facing tools are the attack surface: a tool call can be influenced by
content the agent reads. The defenses are listed in the README under
[Authorization model](README.md#5-authorization-model) and
[Security model](README.md#6-security-model). In short:

- the token is only ever passed to git through the child process environment
  (`GIT_CONFIG_VALUE_0=http.extraHeader`), never on a command line, never in
  `.git/config`, never in a tool result, and it is scrubbed from captured output;
- only `clone`, `fetch`, `push` and `pull` receive it at all;
- `allowPush`, `allowForcePush` and `allowApiWrite` are off by default;
- authorization is judged against the object actually acted on — the real remote
  in the directory (including every `pushurl`), the normalized API path, the host;
- paths are confined to `workspaceRoot`, with a `realpath` check against symlink
  escape, and `gh_file` refuses to write inside `.git/`.

Known exposures, deliberate and documented rather than hidden:

1. **`gh_push` and `gh_commit { push: true }` put the token in the git child
   environment**, so a `pre-push` hook shipped by the repository can read it.
   Only push to repositories you trust.
2. **A token pasted into the binding prompt enters the session transcript.** Use
   the environment variable or `.credentials.yaml` instead if that matters.
3. **Host-level `git config` (`url.*.insteadOf`) can redirect a remote.** That is
   the trust boundary of the machine's own git configuration.
4. **The plugin runs with your user's file access.** A sandbox mode is a
   product-level boundary, not an operating-system one: under
   `danger-full-access` — which `clone`/`pull`/`push` need — the plugin can read
   what you can read.

Reports about 1–4 are welcome as documentation improvements, but they are known
and are not treated as vulnerabilities.
