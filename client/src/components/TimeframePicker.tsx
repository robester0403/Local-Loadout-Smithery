import type { Timeframe } from '../types'

const TIMEFRAMES: { value: Timeframe; label: string }[] = [
  { value: 'day',     label: '24h' },
  { value: 'week',    label: '7d' },
  { value: 'month',   label: '30d' },
  { value: 'quarter', label: '90d' },
  { value: 'year',    label: '1y' },
  { value: 'all',     label: 'All' },
]

interface Props {
  value: Timeframe
  onChange: (tf: Timeframe) => void
}

export default function TimeframePicker({ value, onChange }: Props) {
  return (
    <div className="timeframe-picker">
      {TIMEFRAMES.map(tf => (
        <button
          key={tf.value}
          className={`tf-pill${value === tf.value ? ' active' : ''}`}
          onClick={() => onChange(tf.value)}
          type="button"
        >
          {tf.label}
        </button>
      ))}
    </div>
  )
}
