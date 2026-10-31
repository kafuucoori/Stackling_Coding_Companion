export interface UserMessageContext {
  label: string
  raw: string
}

export interface UserMessagePresentation {
  body: string
  context: UserMessageContext[]
}

const CONTEXT_LABELS: Record<string, string> = {
  environment_context: '运行环境',
  timestamp: '时间信息',
  external_codex_apps_open_page: '页面上下文',
}

/** Separate known agent envelopes for display; leave the transcript untouched. */
export function presentUserMessage(text: string): UserMessagePresentation {
  const context: UserMessageContext[] = []
  // Fenced code and user_query bodies are opaque: XML examples inside them
  // are user content, even when they use one of the context tag names.
  const envelopes = /(?<fence>```|~~~)[\s\S]*?(?:\k<fence>|$)|(?<inline>`{1,2})[^\n]*?\k<inline>|<(?<tag>user_query|environment_context|timestamp|external_codex_apps_open_page)\b[^>]*>(?<content>[\s\S]*?)<\/\k<tag>>/g
  const body = text.replace(envelopes, (raw: string, ...args: unknown[]) => {
    const groups = args.at(-1) as Record<string, string | undefined>
    if (!groups.tag) return raw
    if (groups.tag === 'user_query') return groups.content?.trim() ?? ''
    const offset = args.at(-3) as number
    // A known tag quoted in an ordinary sentence is still user text.
    if (text.slice(0, offset).split('\n').at(-1)?.trim()) return raw
    context.push({ label: CONTEXT_LABELS[groups.tag], raw })
    return ''
  }).trim()
  return { body, context }
}
