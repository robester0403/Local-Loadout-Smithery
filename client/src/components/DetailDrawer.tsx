import { useEffect, useState, type ReactNode } from 'react'
import { marked } from 'marked'
import type { Skill } from '../types'
import type { MCPUsageSummary, MCPRelationship, CursorUsageReport, CursorRecentUsageReport, SkillVersion } from '../api'
import { fetchSkillVersions, restoreSkillVersion, updateSkillContent } from '../api'
import CopyPromptButton from './CopyPromptButton'
import EditableText from './EditableText'
import { generateFixHealthPrompt } from '../prompts/fixHealthPrompt'
import { generateReclassifyPrompt } from '../prompts/reclassifyPrompt'
import RelationshipMap from './RelationshipMap'

interface Props {
  skill: Skill
  allSkills: Skill[]
  onClose: () => void
  onOpen: (skill: Skill) => void
  onBreakdown: (skill: Skill) => void
  onSelect: (skill: Skill) => void
  onReclassify?: (skill: Skill) => void
  onUninstall?: (skill: Skill) => void
  /** Called after an inline description/body edit succeeds. The parent both
   *  applies the patch to local state (so the change shows immediately) and
   *  kicks off a canonical refetch in the background to refresh derived
   *  fields like token counts and health. */
  onSkillChanged?: (id: string, patch: { description?: string; body?: string }) => void
  mcpUsageMap?: Map<string, MCPUsageSummary>
  mcpRelationships?: MCPRelationship[]
  cursorUsage?: CursorUsageReport | null
  cursorRecent?: CursorRecentUsageReport | null
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

const META_ROWS: { label: string; getValue: (s: Skill) => string }[] = [
  { label: 'Type', getValue: s => s.type },
  { label: 'Scope', getValue: s => s.scope },
  { label: 'Account', getValue: s => s.account },
  { label: 'Version', getValue: s => s.version || '—' },
  { label: 'Modified', getValue: s => formatDate(s.lastModified) },
  { label: 'Path', getValue: s => s.path },
  { label: 'Symlink', getValue: s => s.isSymlink ? `Yes → ${s.realpath}` : 'No' },
  { label: 'Project', getValue: s => s.projectId ?? '—' },
]

const SEVERITY_ICON: Record<string, string> = { error: '✗', warn: '⚠' }

// Collapsible section that reuses the existing .drawer-accordion / .accordion-trigger
// styles so all sections look native. Each section owns its own open state.
function Section({
  title,
  defaultOpen = true,
  kind = 'default',
  rightSlot,
  children,
}: {
  title: ReactNode
  defaultOpen?: boolean
  kind?: 'default' | 'warn' | 'error' | 'rel'
  rightSlot?: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="drawer-accordion">
      <button
        className={`accordion-trigger accordion-trigger-${kind}`}
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
      >
        <span className="accordion-icon">{open ? '▾' : '▸'}</span>
        <span style={{ flex: 1 }}>{title}</span>
        {rightSlot}
      </button>
      {open && children}
    </div>
  )
}

export default function DetailDrawer({ skill, allSkills, onClose, onOpen, onBreakdown, onSelect, onReclassify, onUninstall, onSkillChanged, mcpUsageMap, mcpRelationships, cursorUsage, cursorRecent }: Props) {
  const [showMap, setShowMap] = useState(false)
  const [versions, setVersions] = useState<SkillVersion[]>([])
  const [restoringTs, setRestoringTs] = useState<string | null>(null)

  // Refresh the version list each time the drawer opens onto a different skill.
  // MCP servers have no file-backed body, so no versions exist for them.
  useEffect(() => {
    if (skill.type === 'mcp') { setVersions([]); return }
    let cancelled = false
    fetchSkillVersions(skill.id)
      .then(v => { if (!cancelled) setVersions(v) })
      .catch(() => { if (!cancelled) setVersions([]) })
    return () => { cancelled = true }
  }, [skill.id, skill.type])

  async function handleRestoreVersion(ts: string) {
    if (!window.confirm(
      `Restore this version?\n\nThe current file will be snapshotted first, so this is reversible.`,
    )) return
    setRestoringTs(ts)
    try {
      await restoreSkillVersion(skill.id, ts)
      const fresh = await fetchSkillVersions(skill.id)
      setVersions(fresh)
      // Tell the parent the skill content changed so the inventory refetches
      // and the drawer rerenders with the restored body.
      onSkillChanged?.(skill.id, {})
    } catch {
      // Surfacing the error inline is overkill for v1 — leave it as a no-op
      // and rely on the user reopening the drawer to retry.
    } finally {
      setRestoringTs(null)
    }
  }

  // MCP servers are config-derived, not file-backed — no description/body
  // file exists to rewrite, so the inline editor is hidden for that type.
  const canEdit = skill.type !== 'mcp'
  async function saveField(field: 'description' | 'body', next: string) {
    const patch = { [field]: next }
    await updateSkillContent(skill.id, patch)
    onSkillChanged?.(skill.id, patch)
  }
  const saveDescription = (next: string) => saveField('description', next)
  const saveBody = (next: string) => saveField('body', next)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Note: we intentionally don't reset showMap on skill change — when the user
  // clicks a node inside the relationship map, the drawer skill switches but
  // the map should stay open so they can keep navigating the graph.

  const bodyHtml = skill.body
    ? (marked(skill.body) as string)
    : '<p><em>No body content.</em></p>'

  const { issues } = skill.health

  // Outgoing references (from this skill's body/frontmatter)
  const outgoing = skill.references ?? []

  // Inbound references (other skills that mention this skill). Account-scoped
  // because Claude Code and Cursor are independent ecosystems — a same-named
  // skill in the other account is not a real referencer.
  const inbound = allSkills.filter(s =>
    s.id !== skill.id
    && s.account === skill.account
    && s.references?.some(r => r.name === skill.name)
  )

  const isMCP = skill.type === 'mcp' && !!skill.mcpData
  const mcp = skill.mcpData

  if (isMCP && mcp) {
    const sortedTools = [...mcp.tools].sort((a, b) => b.schemaBytes - a.schemaBytes)
    const statusColor: Record<string, string> = { ok: 'var(--c-mcp)', unavailable: '#f55b5b', unknown: '#f5a55b' }
    const statusIcon: Record<string, string> = { ok: '✓', unavailable: '✗', unknown: '⚠' }
    const usage = mcpUsageMap?.get(skill.name)
    const calledBy = mcpRelationships?.filter(r => r.serverName === skill.name) ?? []

    return (
      <>
        <div className="drawer-overlay" onClick={onClose} />
        <aside className="drawer">
          <div className="drawer-header">
            <div className="drawer-title-row">
              <span className="type-badge type-mcp">mcp</span>
              <h2 className="drawer-title">{skill.name}</h2>
            </div>
            {skill.description && <p className="drawer-desc">{skill.description}</p>}
            {/* MCP servers are config-derived; no inline edit affordance. */}
            <div className="drawer-actions">
              <button className="btn" onClick={onClose}>Close</button>
            </div>
          </div>

          <div className="drawer-content" key={skill.id}>
            <div className="mcp-status-banner" style={{ borderColor: statusColor[mcp.status], color: statusColor[mcp.status] }}>
              <span className="mcp-status-icon">{statusIcon[mcp.status]}</span>
              <span className="mcp-status-text">
                {mcp.status === 'ok' ? 'Connected' : mcp.status === 'unavailable' ? 'Unavailable' : 'Unknown'}
                {mcp.statusReason && <span className="mcp-status-reason"> — {mcp.statusReason}</span>}
              </span>
            </div>

            {mcp.kind === 'session-injected' && (
              <div className="mcp-bridge-warning">
                Bridge server (session-injected) — proxied via Claude.ai; configure in ~/.claude.json to persist
              </div>
            )}

            <Section title="Server info" defaultOpen>
              <div className="mcp-meta-row">
                {mcp.source && <span className="mcp-meta-item"><span className="mcp-meta-label">Source</span> {mcp.source}</span>}
                <span className="mcp-meta-item"><span className="mcp-meta-label">Transport</span> {mcp.transport ?? 'stdio'}</span>
                <span className="mcp-meta-item"><span className="mcp-meta-label">Kind</span> {mcp.kind}</span>
                {mcp.scope && <span className="mcp-meta-item"><span className="mcp-meta-label">Scope</span> {mcp.scope}</span>}
              </div>
            </Section>

            <Section title={`Tools — ${sortedTools.length}`} defaultOpen>
              <div className="mcp-tools-section">
                <table className="mcp-tools-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th className="col-numeric">Schema bytes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedTools.map(tool => (
                      <tr key={tool.name}>
                        <td className="mcp-tool-name">{tool.name}</td>
                        <td className="col-numeric mcp-schema-bytes">{tool.schemaBytes.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>

            {usage && (
              <Section title="Usage" defaultOpen>
                <div className="mcp-usage-section">
                  <div className="mcp-usage-summary">
                    <span><span className="mcp-meta-label">Invocations</span> {usage.invocations}</span>
                    <span><span className="mcp-meta-label">Cost</span> ${usage.dollars.toFixed(4)}</span>
                    <span><span className="mcp-meta-label">Last invoked</span> {formatDate(usage.lastInvoked)}</span>
                  </div>
                  {usage.tools.length > 0 && (
                    <table className="mcp-tools-table">
                      <thead>
                        <tr>
                          <th>Tool</th>
                          <th className="col-numeric">Calls</th>
                          <th>Last invoked</th>
                        </tr>
                      </thead>
                      <tbody>
                        {usage.tools.map(t => (
                          <tr key={t.name}>
                            <td className="mcp-tool-name">{t.name}</td>
                            <td className="col-numeric">{t.calls}</td>
                            <td>{t.lastInvoked ? formatDate(t.lastInvoked) : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </Section>
            )}

            {calledBy.length > 0 && (
              <Section title={`Called by — ${calledBy.length}`} defaultOpen>
                <div className="mcp-called-by-section">
                  <ul className="rel-list">
                    {calledBy.map(r => {
                      const callerSkill = allSkills.find(s => s.name === r.skillName)
                      return (
                        <li key={r.skillName} className="rel-item">
                          {callerSkill
                            ? <button className="rel-link" onClick={() => onSelect(callerSkill)}>{r.skillName}</button>
                            : <span className="rel-broken-name">{r.skillName}</span>
                          }
                          <span className="rel-source">{r.calls} call{r.calls !== 1 ? 's' : ''}</span>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              </Section>
            )}
          </div>
        </aside>
      </>
    )
  }

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <aside className="drawer">
        <div className="drawer-header">
          <div className="drawer-title-row">
            <span className={`type-badge type-${skill.type}`}>{skill.type}</span>
            <h2 className="drawer-title">{skill.name}</h2>
          </div>
          {(skill.description || canEdit) && (
            <EditableText
              className="drawer-desc"
              variant="line"
              value={skill.description ?? ''}
              editable={canEdit}
              emptyText="No description."
              label="Edit description"
              onSave={saveDescription}
            />
          )}
          <div className="drawer-actions">
            <button className="btn btn-primary" onClick={() => onOpen(skill)}>
              Open in editor
            </button>
            <button className="btn" onClick={() => onBreakdown(skill)}>
              Show breakdown
            </button>
            <button className="btn" onClick={() => setShowMap(true)} title="Show Mermaid relationship map">
              Relationship map
            </button>
            {skill.suggestedType && (
              <>
                <CopyPromptButton
                  getPrompt={() => generateReclassifyPrompt(skill)}
                  label="Reclassify with AI"
                />
                {onReclassify && !skill.name.includes(':') && (
                  <button className="btn btn-warn" onClick={() => onReclassify(skill)}>
                    Move to {skill.suggestedType.suggested}s
                  </button>
                )}
              </>
            )}
            {onUninstall && (
              <button className="btn btn-warn" onClick={() => onUninstall(skill)} title="Move to Trash (can be restored)">
                Uninstall
              </button>
            )}
            <button className="btn" onClick={onClose}>Close</button>
          </div>
        </div>

        {/* `key={skill.id}` resets every Section's open state when the user
            opens a different skill — clean slate per skill. */}
        <div className="drawer-content" key={skill.id}>
          {issues.length > 0 && (
            <Section
              title={
                <>
                  {skill.health.status === 'error' ? '✗' : '⚠'}{' '}
                  {issues.length} {issues.length === 1 ? 'issue' : 'issues'}
                </>
              }
              defaultOpen={skill.health.status !== 'ok'}
              kind={skill.health.status === 'error' ? 'error' : 'warn'}
            >
              <ul className="accordion-issue-list">
                {issues.map((issue, i) => (
                  <li key={i} className={`accordion-issue accordion-issue-${issue.severity}`}>
                    <span className="accordion-issue-icon">{SEVERITY_ICON[issue.severity]}</span>
                    <span className="accordion-issue-msg">{issue.message}</span>
                  </li>
                ))}
                <li className="accordion-issue accordion-issue-action">
                  <CopyPromptButton getPrompt={() => generateFixHealthPrompt(skill)} label="Fix with Claude Code" />
                </li>
              </ul>
            </Section>
          )}

          {skill.type !== 'mcp' && (
            <Section
              title={
                versions.length === 0
                  ? 'History — no snapshots yet'
                  : `History — ${versions.length} version${versions.length === 1 ? '' : 's'}`
              }
              defaultOpen={false}
            >
              <div className="drawer-meta">
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>
                  Pre-image snapshots saved before each edit. Restore creates a fresh snapshot so it's reversible.
                </div>
                {versions.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--text-dim)', fontStyle: 'italic' }}>
                    No snapshots yet — your next edit through this drawer will create one.
                    Edits made outside the app (in your editor) are not captured.
                  </div>
                ) : (
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                    {versions.map(v => {
                      const when = (() => {
                        // Stored timestamps replace `:` with `-` to stay
                        // filesystem-safe. Restore them so Date.parse works.
                        const restored = v.timestamp.replace(/-(\d{2})-(\d{2}\.\d+Z)$/, ':$1:$2')
                        const d = new Date(restored)
                        return Number.isNaN(d.getTime())
                          ? v.timestamp
                          : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
                      })()
                      return (
                        <li key={v.timestamp} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0' }}>
                          <span style={{ fontSize: 12 }}>{when} <span style={{ color: 'var(--text-dim)' }}>· {v.sizeBytes} B</span></span>
                          <button
                            className="btn btn-sm"
                            disabled={restoringTs !== null}
                            onClick={() => handleRestoreVersion(v.timestamp)}
                          >
                            {restoringTs === v.timestamp ? 'Restoring…' : 'Restore'}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            </Section>
          )}

          {skill.account === 'cursor' && (() => {
            const histU = cursorUsage?.skills.find(x => x.skill === skill.name)
            const histActivations = histU?.activations ?? 0
            const histSessions = histU?.sessions ?? 0
            const histLast = histU?.lastInvoked ?? 0
            const liveU = cursorRecent?.items.find(x => x.kind === 'skill' && x.name === skill.name)
            const liveCount = liveU?.count ?? 0
            const liveLast = liveU?.lastSeen ?? 0
            const liveFirst = liveU?.firstSeen ?? 0
            const trackingSince = cursorRecent?.trackingSince ?? 0
            const totalActivity = liveCount + histActivations
            return (
              <Section
                title={`Cursor activity — ${totalActivity} total (${liveCount} live, ${histActivations} historical)`}
                defaultOpen={totalActivity > 0}
              >
                <div className="drawer-meta">
                  <h4 style={{ margin: '0 0 6px', fontSize: 12, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '.5px' }}>
                    Live (since LSM polling started)
                  </h4>
                  <table className="meta-table">
                    <tbody>
                      <tr><th>Activations</th><td>{liveCount}</td></tr>
                      <tr>
                        <th>First observed</th>
                        <td>{liveFirst ? formatDate(new Date(liveFirst).toISOString()) : '—'}</td>
                      </tr>
                      <tr>
                        <th>Last observed</th>
                        <td>{liveLast ? formatDate(new Date(liveLast).toISOString()) : '—'}</td>
                      </tr>
                      <tr>
                        <th>Tracking since</th>
                        <td>{trackingSince ? formatDate(new Date(trackingSince).toISOString()) : 'just started'}</td>
                      </tr>
                    </tbody>
                  </table>

                  <h4 style={{ margin: '14px 0 6px', fontSize: 12, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '.5px' }}>
                    Historical (Cursor bubble persistence window)
                  </h4>
                  <table className="meta-table">
                    <tbody>
                      <tr><th>Activations</th><td>{histActivations}</td></tr>
                      <tr><th>Distinct sessions</th><td>{histSessions}</td></tr>
                      <tr>
                        <th>Last invoked</th>
                        <td>{histLast ? formatDate(new Date(histLast).toISOString()) : '—'}</td>
                      </tr>
                    </tbody>
                  </table>
                  {histActivations === 0 && liveCount === 0 && (
                    <p style={{ marginTop: 8, fontSize: 12, color: 'var(--text-dim)' }}>
                      No activations recorded in either source. Live tracking
                      depends on Cursor updating its <code>recentlyUsed</code>
                      list when the skill is invoked; historical depends on
                      bubbles in the local SQLite (which Cursor is phasing out).
                    </p>
                  )}

                  <h4 style={{ margin: '14px 0 6px', fontSize: 12, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '.5px' }}>
                    Per-turn size (static)
                  </h4>
                  <table className="meta-table">
                    <tbody>
                      <tr>
                        <th>Body tokens</th>
                        <td>{skill.bodyTokens ?? '—'}<span style={{ color: 'var(--text-dim)', marginLeft: 6 }}>per turn after invocation</span></td>
                      </tr>
                      <tr>
                        <th>Listing tokens</th>
                        <td>{skill.listingTokens ?? '—'}<span style={{ color: 'var(--text-dim)', marginLeft: 6 }}>per turn while in loadout</span></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </Section>
            )
          })()}

          <Section
            title={
              outgoing.length === 0 && inbound.length === 0
                ? 'Relationships — none'
                : `Relationships — ${outgoing.length} out, ${inbound.length} in`
            }
            defaultOpen={outgoing.length > 0 || inbound.length > 0}
            kind="rel"
          >
            <div className="drawer-relationships">
              {outgoing.length === 0 && inbound.length === 0 ? (
                <span className="rel-orphan">No relationships found — this skill is an island</span>
              ) : (
                <>
                  {outgoing.length > 0 && (
                    <div className="rel-group">
                      <span className="rel-group-label">References</span>
                      <ul className="rel-list">
                        {outgoing.map(ref => {
                          const target = allSkills.find(s => s.name === ref.name)
                          const isBroken = !target
                          return (
                            <li key={ref.name} className={`rel-item ${isBroken ? 'rel-broken' : ''}`}>
                              {isBroken
                                ? <span className="rel-broken-name" title="Skill not found in inventory">⚠ {ref.name}</span>
                                : <button className="rel-link" onClick={() => onSelect(target!)}>
                                    {ref.name}
                                  </button>
                              }
                              <span className="rel-source">{ref.source}</span>
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  )}
                  {inbound.length > 0 && (
                    <div className="rel-group">
                      <span className="rel-group-label">Referenced by</span>
                      <ul className="rel-list">
                        {inbound.map(s => (
                          <li key={s.id} className="rel-item">
                            <button className="rel-link" onClick={() => onSelect(s)}>
                              {s.name}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>
          </Section>

          <Section title="Metadata" defaultOpen>
            <div className="drawer-meta">
              <table className="meta-table">
                <tbody>
                  {META_ROWS
                    .filter(r => {
                      const v = r.getValue(skill)
                      return v && v !== '—'
                    })
                    .map(r => (
                      <tr key={r.label}>
                        <th>{r.label}</th>
                        <td>{r.getValue(skill)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title="Documentation" defaultOpen>
            <EditableText
              className="drawer-body-edit"
              variant="block"
              value={skill.body ?? ''}
              editable={canEdit}
              emptyText="No body content."
              label="Edit body"
              onSave={saveBody}
              renderValue={() => (
                <div
                  className="drawer-body markdown-body"
                  dangerouslySetInnerHTML={{ __html: bodyHtml }}
                />
              )}
            />
          </Section>
        </div>
      </aside>

      {showMap && (
        <RelationshipMap
          skill={skill}
          allSkills={allSkills}
          onClose={() => setShowMap(false)}
          onSelect={onSelect}
          onSkillChanged={onSkillChanged}
        />
      )}
    </>
  )
}
