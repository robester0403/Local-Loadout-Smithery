export type Timeframe = 'day' | 'week' | 'month' | 'quarter' | 'year' | 'all'

export function sinceDate(tf: Timeframe): Date | null {
  if (tf === 'all') return null
  const now = Date.now()
  const MS: Record<Timeframe, number> = {
    day:     24 * 60 * 60 * 1000,
    week:    7  * 24 * 60 * 60 * 1000,
    month:   30 * 24 * 60 * 60 * 1000,
    quarter: 90 * 24 * 60 * 60 * 1000,
    year:   365 * 24 * 60 * 60 * 1000,
    all: 0,
  }
  return new Date(now - MS[tf])
}

export function parseTimeframe(raw: unknown): Timeframe {
  const valid: Timeframe[] = ['day', 'week', 'month', 'quarter', 'year', 'all']
  return valid.includes(raw as Timeframe) ? (raw as Timeframe) : 'all'
}
