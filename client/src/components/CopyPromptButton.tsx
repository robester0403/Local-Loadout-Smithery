import { useState } from 'react'
import { launchClaude } from '../api'

interface Props {
  getPrompt: () => string
  label?: string
}

export default function CopyPromptButton({ getPrompt, label = 'Fix with Claude Code' }: Props) {
  const [state, setState] = useState<'idle' | 'copied' | 'launched' | 'error'>('idle')

  async function handleCopy(e: React.MouseEvent) {
    e.stopPropagation()
    const prompt = getPrompt()
    try {
      await navigator.clipboard.writeText(prompt)
      setState('copied')
      setTimeout(() => setState('idle'), 2000)
    } catch {
      setState('error')
      setTimeout(() => setState('idle'), 2000)
    }
  }

  async function handleLaunch(e: React.MouseEvent) {
    e.stopPropagation()
    const prompt = getPrompt()
    try {
      const result = await launchClaude(prompt)
      if (result.platform === 'unsupported') {
        await navigator.clipboard.writeText(prompt)
      }
      setState('launched')
      setTimeout(() => setState('idle'), 2500)
    } catch {
      setState('error')
      setTimeout(() => setState('idle'), 2000)
    }
  }

  const copyLabel = state === 'copied' ? '✓ Copied' : state === 'error' ? '✗ Failed' : label
  const launchLabel = state === 'launched' ? '✓ Opened' : '⚡ Open in CC'

  return (
    <span className="prompt-actions" onClick={e => e.stopPropagation()}>
      <button className="prompt-btn" onClick={handleCopy}>{copyLabel}</button>
      <button className="prompt-btn prompt-btn-launch" onClick={handleLaunch}>{launchLabel}</button>
    </span>
  )
}
