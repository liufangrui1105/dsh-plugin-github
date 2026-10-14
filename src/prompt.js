/**
 * dsh-plugin-github — 首次使用的交互式引导
 *
 * 当一次调用确实需要 GitHub 凭据、但还没有绑定任何账号时，用 DSH 官方的
 * `ctx.userQuestions` 服务直接问用户一个 Personal Access Token，拿到后立即验证身份、
 * 绑定为默认账号，然后让调用方重试这一次操作。这就是「第一次调用先问绑定哪个账号」。
 *
 * 几条刻意的边界：
 *   - 只用 `ctx.get('userQuestions')`（可选依赖）。没有这个服务（例如子代理、无 UI 的
 *     运行时）就干净地返回 `unavailable`，由调用方给出「请手动绑定」的可操作提示，
 *     而不是把调用挂死。
 *   - 答案里可能带「跳过 / 稍后」这类选项，选中它们等同于用户拒绝，不算绑定。
 *   - token 会被写进会话记录（因为它是模型工具的返回内容）。插件文档里说明了这一点，
 *     并给出「自己写凭据文件」这条不经过对话的替代路径。
 */

const SKIP_LABELS = ['跳过', '暂不绑定', '稍后', 'skip', 'not now', 'cancel', '取消']

/** 从自由文本里挑出看起来像 GitHub token 的那一段。 */
export function extractToken(answer) {
  const text = String(answer ?? '').trim()
  if (text === '') return undefined
  const match = text.match(/\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/)
  if (match) return match[1]
  // 用户可能直接粘了一整行带说明的文字；取最长的无空白片段作为兜底。
  const words = text.split(/\s+/).filter(word => word.length >= 20 && !word.includes('：') && !word.includes(':'))
  if (words.length === 1) return words[0]
  return undefined
}

/** 用户是否选择了「跳过」。 */
export function isSkipAnswer(label) {
  const text = String(label ?? '').trim().toLowerCase()
  if (text === '') return false
  return SKIP_LABELS.some(skip => text.includes(skip))
}

/**
 * 问用户要一个 PAT。
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
      detail: '当前运行环境没有可用的用户问答服务（ctx.userQuestions），无法弹出绑定引导。',
    }
  }

  const optionsList = [
    {
      label: '使用已有的环境变量（如果已设置 GITHUB_TOKEN）',
      description: '插件会直接读取环境变量里的 token，不在这里输入任何内容。',
    },
    ...(options.allowSkip === false ? [] : [
      {
        label: '跳过，暂不绑定',
        description: '本次操作会被拒绝；之后可用 gh_account action=bind 再绑定。',
      },
    ]),
  ]

  let answer
  try {
    answer = await service.ask({
      questions: [{
        id: 'github_bind',
        header: '绑定 GitHub 账号',
        question: `${options.reason} 请粘贴一个 GitHub Personal Access Token（fine-grained 或 classic）。`,
        detail: [
          '插件会用它调用 /user 确认身份，成功后把它存为当前默认账号，之后不再询问。',
          '需要的权限：读写仓库内容用 repo（fine-grained 给 Contents: Read and write）；只读只要 Contents: Read。',
          '注意：在这里输入的 token 会进入本次会话记录。若不希望如此，请取消并在 $DSH_HOME/.credentials.yaml',
          '的 refs: 段自行写入 GITHUB_TOKEN，或用环境变量提供。',
        ].join('\n'),
        options: optionsList,
      }],
      ...(options.agent === undefined ? {} : { agent: options.agent }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (error) {
    return {
      status: 'unavailable',
      detail: `无法弹出绑定引导：${error instanceof Error ? error.message : String(error)}`,
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
    // 用户可能选了「使用已有的环境变量」——这不算给了 token，交给调用方走环境变量回退。
    return { status: 'skipped' }
  }
  return { status: 'answered', token }
}

/** 需要凭据但尚未绑定时的统一错误文案。 */
export function unboundMessage(detail, extra) {
  return [
    '这个操作需要 GitHub 凭据，但当前还没有绑定任何账号。',
    detail === undefined ? '' : `（${detail}）`,
    extra === undefined ? '' : `${extra}`,
    '请任选一种方式绑定：',
    '  1. 让我调用 gh_account action=bind（会弹出输入框，粘贴 PAT 即可）；',
    '  2. 自己在 $DSH_HOME/.credentials.yaml 的 refs: 段写入 GITHUB_TOKEN；',
    '  3. 在启动 DSH 前设置环境变量 GITHUB_TOKEN。',
  ].filter(Boolean).join('\n')
}
