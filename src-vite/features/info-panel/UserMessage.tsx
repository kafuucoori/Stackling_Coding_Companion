import { useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { presentUserMessage } from './userMessagePresentation'
import css from './theme.module.css'

export default function UserMessage({ text }: { text: string }) {
  const { body, context } = useMemo(() => presentUserMessage(text), [text])
  const [expanded, setExpanded] = useState(false)
  const canExpand = body.length > 300 || body.split('\n').length > 8

  return (
    <div className={css.userMessage}>
      {body && (
        <div className={css.userBubble}>
          <div
            className={css.markdownContent}
            style={!expanded && canExpand ? { maxHeight: 170, overflow: 'hidden' } : undefined}
          >
            <ReactMarkdown>{body}</ReactMarkdown>
          </div>
          {canExpand && (
            <button
              className={css.userExpand}
              aria-expanded={expanded}
              onClick={() => setExpanded(value => !value)}
            >
              {expanded ? '收起正文' : '展开正文'}
            </button>
          )}
        </div>
      )}
      {context.length > 0 && (
        <details className={css.messageContext}>
          <summary>
            附加信息 · {[...new Set(context.map(item => item.label))].join('、')}
          </summary>
          {context.map((item, index) => (
            <div key={index} className={css.contextItem}>
              <div>{item.label}</div>
              <pre>{item.raw}</pre>
            </div>
          ))}
        </details>
      )}
    </div>
  )
}
