import { useEffect, useState, type ReactNode } from 'react'
import { useForm, Controller, type Control, type UseFormRegister, type SubmitHandler } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { IconChevronDown, IconChevronRight, IconX } from '@tabler/icons-react'
import { useConfirm } from './ConfirmDialog'
import {
  COLUMN_KEYS,
  COLUMN_LABELS,
  FLAG_LABELS,
  defaultSettings,
  loadSettings,
  saveSettings,
  settingsSchema,
  type Settings,
  type FlagKey,
} from '../lib/settings'

interface Props {
  onClose: () => void
}

// ─── Identifier model ───────────────────────────────────────────────────────
//
// Each diagnostic identifier owns a toggle (`flags.<key>`) and zero or more
// threshold inputs. Co-locating them in the UI makes the relationship
// obvious: turning on the Dormant flag and adjusting "Dormant after N days"
// is the same conceptual action.
//
// Shared thresholds (e.g. loadedHighUsd gates both Removal and Winner) appear
// in every owning identifier card, all bound to the same RHF field — editing
// in one updates the other. The duplicate-but-bound-once pattern is the
// cheapest way to keep the "shared" relationship visible without a separate
// "shared values" subsection that splits the user's mental model.

type ThresholdKey = keyof Settings['thresholds']

interface ThresholdFieldSpec {
  key: ThresholdKey
  label: string
  hint: string
  step: number
  unit?: '$' | 'days' | 'chars'
}

const TF: Record<ThresholdKey, ThresholdFieldSpec> = {
  loadedHighUsd: {
    key: 'loadedHighUsd',
    label: 'Loaded $ floor',
    hint: 'Skills below this loaded cost are exempt from "winner" / "removal candidate" flags.',
    step: 0.0001, unit: '$',
  },
  activeHighUsd: {
    key: 'activeHighUsd',
    label: 'Active $ floor',
    hint: 'Below this active cost, a skill counts as never-invoked.',
    step: 0.0001, unit: '$',
  },
  dormantDays: {
    key: 'dormantDays',
    label: 'Dormant after',
    hint: 'Skills not invoked in this many days are flagged dormant.',
    step: 1, unit: 'days',
  },
  gracePeriodDays: {
    key: 'gracePeriodDays',
    label: 'New-skill grace',
    hint: 'Recently-modified skills are exempt from the removal-candidate flag for this many days.',
    step: 1, unit: 'days',
  },
  descBloatChars: {
    key: 'descBloatChars',
    label: 'Description bloat at',
    hint: 'Descriptions longer than this many characters get a bloat warning.',
    step: 1, unit: 'chars',
  },
  newSkillGraceDays: {
    key: 'newSkillGraceDays',
    label: '"New" badge window',
    hint: 'Skills installed within this many days display a NEW badge.',
    step: 1, unit: 'days',
  },
}

interface IdentifierCardSpec {
  flag: FlagKey
  description: string
  /** Thresholds this identifier exposes. Order matters in the UI. */
  thresholds: ThresholdKey[]
  /** Thresholds in this card that are also configured by another identifier
   *  — used to render a small "(shared with …)" label. */
  sharedWith?: Partial<Record<ThresholdKey, FlagKey[]>>
}

const HEALTH_FLAGS: FlagKey[] = ['healthOk', 'healthWarn', 'healthError']

const DIAGNOSTIC_CARDS: IdentifierCardSpec[] = [
  {
    flag: 'removal',
    description: 'Loaded but never invoked (and out of the new-skill grace window).',
    thresholds: ['loadedHighUsd', 'activeHighUsd', 'gracePeriodDays'],
    sharedWith: {
      loadedHighUsd: ['winner'],
      activeHighUsd: ['winner'],
    },
  },
  {
    flag: 'winner',
    description: 'High loaded cost and actively invoked — earning its keep.',
    thresholds: ['loadedHighUsd', 'activeHighUsd'],
    sharedWith: {
      loadedHighUsd: ['removal'],
      activeHighUsd: ['removal'],
    },
  },
  {
    flag: 'dormant',
    description: 'Not invoked for a long time — review whether it\'s still earning its slot.',
    thresholds: ['dormantDays'],
  },
  {
    flag: 'bloat',
    description: 'Description is long enough to be paying meaningful per-turn token tax.',
    thresholds: ['descBloatChars'],
  },
  {
    flag: 'mismatch',
    description: 'Server suggests this artifact is misclassified (e.g. a command shaped like a skill).',
    thresholds: [],
  },
  {
    flag: 'newSkill',
    description: 'Recently installed — file birthtime (or mtime fallback) within the grace window.',
    thresholds: ['newSkillGraceDays'],
  },
]

// ─── Component ──────────────────────────────────────────────────────────────

export default function SettingsModal({ onClose }: Props) {
  const confirm = useConfirm()
  const {
    register, handleSubmit, control, watch, reset, getValues, formState: { isDirty },
  } = useForm<Settings>({
    resolver: zodResolver(settingsSchema),
    defaultValues: loadSettings(),
    mode: 'onTouched',
  })

  const flags = watch('flags')

  async function attemptClose() {
    if (isDirty) {
      const ok = await confirm({
        title: 'Discard changes?',
        message: 'You have unsaved settings changes.',
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
        destructive: true,
      })
      if (!ok) return
    }
    onClose()
  }

  // Esc closes (with dirty-check). Backdrop click is handled inline on the
  // overlay. Listener rebinds when isDirty changes so attemptClose sees the
  // current value via closure.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        attemptClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty])

  const onSubmit: SubmitHandler<Settings> = (values) => {
    saveSettings(values)
    onClose()
  }

  function handleResetToDefaults() {
    reset(defaultSettings(), { keepDefaultValues: true })
  }

  function setAllColumns(visible: boolean) {
    const next = { ...getValues('columns') }
    for (const k of COLUMN_KEYS) next[k] = visible
    reset({ ...getValues(), columns: next }, { keepDirty: true, keepDefaultValues: true })
  }

  return (
    <div
      className="modal-overlay"
      onClick={e => { if (e.target === e.currentTarget) attemptClose() }}
      role="presentation"
    >
      <form
        className="modal settings-modal"
        onSubmit={handleSubmit(onSubmit)}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        style={{ maxWidth: 640 }}
      >
        <div className="modal-header">
          <div>
            <div id="settings-modal-title" className="modal-title">Settings</div>
            <div className="modal-subtitle">
              Customize what the inventory shows and tune the values that trigger each
              diagnostic. Changes commit only when you click Accept.
            </div>
          </div>
          <button
            type="button"
            className="btn btn-sm modal-close"
            onClick={attemptClose}
            aria-label="Close"
          >
            <IconX size={14} stroke={1.75} aria-hidden />
          </button>
        </div>

        <div className="settings-modal-body">
          <CollapsibleSection
            id="columns"
            title="Columns"
            subtitle="Show or hide columns in the inventory table."
            defaultOpen
          >
            <div className="settings-bulk">
              <button type="button" className="settings-link" onClick={() => setAllColumns(true)}>
                Select all
              </button>
              <span className="settings-bulk-sep">·</span>
              <button type="button" className="settings-link" onClick={() => setAllColumns(false)}>
                Deselect all
              </button>
            </div>
            <div className="settings-checks">
              {COLUMN_KEYS.map(key => (
                <label key={key} className="settings-check">
                  <input type="checkbox" {...register(`columns.${key}` as const)} />
                  <span>{COLUMN_LABELS[key]}</span>
                </label>
              ))}
            </div>
          </CollapsibleSection>

          <CollapsibleSection
            id="health"
            title="Health"
            subtitle="Which health states surface in the table and count toward the Issues filter."
            defaultOpen
          >
            <div className="settings-flags-help">
              Health status (ok / warn / error) is determined server-side by validators
              like missing description, broken references, etc. These toggles control
              which states surface, not how they're classified.
            </div>
            <div className="settings-checks">
              {HEALTH_FLAGS.map(key => (
                <label key={key} className="settings-check">
                  <input type="checkbox" {...register(`flags.${key}` as const)} />
                  <span>{FLAG_LABELS[key]}</span>
                </label>
              ))}
            </div>
          </CollapsibleSection>

          <CollapsibleSection
            id="diagnostics"
            title="Diagnostics"
            subtitle="Each identifier has a toggle and the values that decide when it fires."
            defaultOpen
          >
            <div className="settings-identifier-list">
              {DIAGNOSTIC_CARDS.map(spec => (
                <IdentifierCard
                  key={spec.flag}
                  spec={spec}
                  enabled={flags[spec.flag]}
                  register={register}
                  control={control}
                />
              ))}
            </div>
          </CollapsibleSection>
        </div>

        <div className="modal-footer settings-modal-footer">
          <button
            type="button"
            className="btn btn-sm"
            onClick={handleResetToDefaults}
          >
            Reset to defaults
          </button>
          <div className="settings-modal-footer-actions">
            <button type="button" className="btn btn-sm" onClick={attemptClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-sm btn-primary" disabled={!isDirty}>
              Accept
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}

// ─── CollapsibleSection ─────────────────────────────────────────────────────

function CollapsibleSection({
  id, title, subtitle, defaultOpen = true, children,
}: {
  id: string
  title: string
  subtitle?: string
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const bodyId = `settings-section-${id}-body`
  return (
    <section className="settings-section">
      <button
        type="button"
        className="settings-section-head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(o => !o)}
      >
        {open
          ? <IconChevronDown size={14} stroke={2} aria-hidden />
          : <IconChevronRight size={14} stroke={2} aria-hidden />}
        <span className="settings-section-title">{title}</span>
        {subtitle && <span className="settings-section-subtitle">{subtitle}</span>}
      </button>
      {open && <div id={bodyId} className="settings-section-body">{children}</div>}
    </section>
  )
}

// ─── IdentifierCard ─────────────────────────────────────────────────────────

function IdentifierCard({
  spec, enabled, register, control,
}: {
  spec: IdentifierCardSpec
  enabled: boolean
  register: UseFormRegister<Settings>
  control: Control<Settings>
}) {
  return (
    <div className={`identifier-card${enabled ? '' : ' is-flag-off'}`}>
      <label className="identifier-card-head">
        <input type="checkbox" {...register(`flags.${spec.flag}` as const)} />
        <span className="identifier-card-label">{FLAG_LABELS[spec.flag]}</span>
      </label>
      <div className="identifier-card-desc">{spec.description}</div>
      {spec.thresholds.length > 0 && (
        <div className="identifier-card-thresholds">
          {spec.thresholds.map(tk => {
            const field = TF[tk]
            const shared = spec.sharedWith?.[tk]
            return (
              <Controller
                key={tk}
                control={control}
                name={`thresholds.${tk}` as const}
                render={({ field: ctl, fieldState }) => (
                  <div className={`settings-threshold${enabled ? '' : ' is-disabled'}`}>
                    <label
                      className="settings-threshold-label"
                      htmlFor={`th-${spec.flag}-${tk}`}
                      title={enabled
                        ? field.hint
                        : `Enable "${FLAG_LABELS[spec.flag]}" to edit`}
                    >
                      {field.label}
                      {shared && shared.length > 0 && (
                        <span className="settings-threshold-shared">
                          {' '}(shared with {shared.map(f => FLAG_LABELS[f]).join(', ')})
                        </span>
                      )}
                    </label>
                    <div className="settings-threshold-input">
                      {field.unit === '$' && <span className="settings-threshold-prefix">$</span>}
                      <input
                        id={`th-${spec.flag}-${tk}`}
                        type="number"
                        inputMode="decimal"
                        step={field.step}
                        min={0}
                        disabled={!enabled}
                        aria-invalid={!!fieldState.error}
                        value={ctl.value}
                        onChange={e => {
                          const raw = e.target.value
                          ctl.onChange(raw === '' ? Number.NaN : Number(raw))
                        }}
                        onBlur={ctl.onBlur}
                      />
                      {field.unit && field.unit !== '$' && (
                        <span className="settings-threshold-suffix">{field.unit}</span>
                      )}
                    </div>
                  </div>
                )}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
