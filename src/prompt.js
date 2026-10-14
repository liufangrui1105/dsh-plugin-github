/**
 * dsh-plugin-github — interactive guidance on first use
 *
 * When a call genuinely needs GitHub credentials and no account has been bound yet, ask the user
 * for a Personal Access Token directly through DSH's official `ctx.userQuestions` service; once it
 * arrives, verify the identity right away, bind it as the default account, and let the caller retry
 * that one operation. This is the "on the first call, first ask which account to bind" flow.
 *
 * A few deliberate boundaries:
 *   - Use only `ctx.get('userQuestions')` (an optional dependency). When that service is absent
 *     (a subagent, or a runtime with no UI), return `unavailable` cleanly and let the caller
 *     produce the actionable "bind it manually" hint, instead of hanging the call.
 *   - The answer may carry options such as "skip / later"; selecting one of those counts as the
 *     user refusing, not as a binding.
 *   - The token is written into the session transcript (because it is the return value of a model
 *     tool). The plugin documentation states this, and offers "write the credentials file
 *     yourself" as the alternative path that never goes through the conversation.
 */

const SKIP_LABELS = ['skip', 'not now', 'cancel', 'later', 'do not bind now']

/** Pick the stretch of free text that looks like a GitHub token. */
export function extractToken(answer) {
  const text = String(answer ?? '').trim()
  if (text === '') return undefined
  const match = text.match(/\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/)
  if (match) return match[1]
  // The user may have pasted a whole line of prose; fall back to the longest whitespace-free fragment.
  const words = text.split(/\s+/).filter(word => word.length >= 20 && !word.includes('：') && !word.includes(':'))
  if (words.length === 1) return words[0]
  return undefined
}

/** Whether the user chose to skip. */
export function isSkipAnswer(label) {
  const text = String(label ?? '').trim().toLowerCase()
  if (text === '') return false
  return SKIP_LABELS.some(skip => text.includes(skip))
}

/**
 * Ask the user for a PAT.
 *
 * @param {{
 *   userQuestions?: {ask?: (request: any) => Promise<any>},
 *   agent?: unknown,
 *   signal?: AbortSignal,
 *   reason: string,
 *   allowSkip?: boolean,
 * }} options
 * @returns {Promise<{status: 'answered', token: string} | {status: 'skipped'} | {status: 'unavailable', detail: string}>}
 */
export async function askForToken(options) {
  const service = options.userQuestions
  if (service === undefined || typeof service.ask !== 'function') {
    return {
      status: 'unavailable',
      detail: 'This runtime has no usable user-question service (ctx.userQuestions), so the binding prompt cannot be shown.',
    }
  }

  const optionsList = [
    {
      label: 'Use the existing environment variable (when GITHUB_TOKEN is already set)',
      description: 'The plugin reads the token straight from the environment; nothing is typed in here.',
    },
    ...(options.allowSkip === false ? [] : [
      {
        label: 'Skip, do not bind now',
        description: 'This operation will be refused; you can bind later with gh_account action=bind.',
      },
    ]),
  ]

  let answer
  try {
    answer = await service.ask({
      questions: [{
        id: 'github_bind',
        header: 'Bind a GitHub account',
        question: `${options.reason} Please paste a GitHub Personal Access Token (fine-grained or classic).`,
        detail: [
          'The plugin uses it to call /user to confirm the identity, then stores it as the current default account and does not ask again.',
          'Permissions needed: repo for reading and writing repository contents (for fine-grained tokens, Contents: Read and write); Contents: Read alone is enough for read-only.',
          'Note: a token typed in here becomes part of this session transcript. If you do not want that, cancel and write GITHUB_TOKEN into the refs: section',
          'of $DSH_HOME/.credentials.yaml yourself, or supply it through an environment variable.',
        ].join('\n'),
        options: optionsList,
      }],
      ...(options.agent === undefined ? {} : { agent: options.agent }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (error) {
    return {
      status: 'unavailable',
      detail: `Could not show the binding prompt: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const item = Array.isArray(answer?.answers)
    ? answer.answers.find(entry => entry?.id === 'github_bind')
    : undefined
  if (item === undefined) return { status: 'skipped' }

  for (const label of item.selected ?? []) {
    if (isSkipAnswer(label)) return { status: 'skipped' }
  }

  const token = extractToken(item.custom) ?? extractToken((item.selected ?? []).join(' '))
  if (token === undefined) {
    // The user may have picked "use the existing environment variable" — that is not a token, so
    // leave it to the caller to take the environment-variable fallback.
    return { status: 'skipped' }
  }
  return { status: 'answered', token }
}

/** The single error text used when credentials are needed but nothing is bound yet. */
export function unboundMessage(detail, extra) {
  return [
    'This operation needs GitHub credentials, but no account is bound yet.',
    detail === undefined ? '' : `(${detail})`,
    extra === undefined ? '' : `${extra}`,
    'Bind one in any of these ways:',
    '  1. Ask me to call gh_account action=bind (a prompt appears; just paste the PAT);',
    '  2. Write GITHUB_TOKEN into the refs: section of $DSH_HOME/.credentials.yaml yourself;',
    '  3. Set the GITHUB_TOKEN environment variable before starting DSH.',
  ].filter(Boolean).join('\n')
}
