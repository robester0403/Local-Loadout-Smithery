import { useEffect, useState } from 'react'
import { marked } from 'marked'
import type { Skill } from '../types'
import type { MCPUsageSummary, MCPRelationship } from '../api'
import CopyPromptButton from './CopyPromptButton'
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
  mcpUsageMap?: Map<string, MCPUsageSummary>
  mcpRelationships?: MCPRelationship[]
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

export default function DetailDrawer({ skill, allSkills, onClose, onOpen, onBreakdown, onSelect, onReclassify, onUninstall, mcpUsageMap, mcpRelationships }: Props) {
  const [issuesOpen, setIssuesOpen] = useState(skill.health.status !== 'ok')
  const [showMap, setShowMap] = useState(false)
  const [relsOpen, setRelsOpen] = useState(true)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const bodyHtml = skill.body
    ? (marked(skill.body) as string)
    : '<p><em>No body content.</em></p>'

  const { issues } = skill.health

  // Outgoing references (from this skill's body/frontmatter)
  const outgoing = skill.references ?? []

  // Inbound references (other skills that mention this skill)
  const inbound = allSkills.filter(s =>
    s.id !== skill.id && s.references?.some(r => r.name === skill.name)
  )

  // Auto-reset when a different skill is opened
  useEffect(() => {
    setIssuesOpen(skill.health.status !== 'ok')
    setRelsOpen(outgoing.length > 0 || inbound.length > 0)
    setShowMap(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skill.id])

  // (allSkillNames used inline in JSX for broken-ref detection)

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
            <div className="drawer-actions">
              <button className="btn" onClick={onClose}>Close</button>
            </div>
          </div>

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

          <div className="mcp-meta-row">
            {mcp.source && <span className="mcp-meta-item"><span className="mcp-meta-label">Source</span> {mcp.source}</span>}
            <span className="mcp-meta-item"><span className="mcp-meta-label">Transport</span> {mcp.transport ?? 'stdio'}</span>
            <span className="mcp-meta-item"><span className="mcp-meta-label">Kind</span> {mcp.kind}</span>
            {mcp.scope && <span className="mcp-meta-item"><span className="mcp-meta-label">Scope</span> {mcp.scope}</span>}
          </div>

          <div className="mcp-tools-section">
            <span className="mcp-tools-heading">{sortedTools.length} tool{sortedTools.length !== 1 ? 's' : ''}</span>
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

          {usage && (
            <div className="mcp-usage-section">
              <span className="mcp-tools-heading">Usage</span>
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
          )}

          {calledBy.length > 0 && (
            <div className="mcp-called-by-section">
              <span className="mcp-tools-heading">Called by</span>
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
          )}
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
          {skill.description && (
            <p className="drawer-desc">{skill.description}</p>
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

        {issues.length > 0 && (
          <div className="drawer-accordion">
            <button
              className={`accordion-trigger accordion-trigger-${skill.health.status}`}
              onClick={() => setIssuesOpen(o => !o)}
              aria-expanded={issuesOpen}
            >
              <span className="accordion-icon">{issuesOpen ? '▾' : '▸'}</span>
              <span>
                {skill.health.status === 'error' ? '✗' : '⚠'} {issues.length} {issues.length === 1 ? 'issue' : 'issues'}
              </span>
            </button>
            {issuesOpen && (
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
            )}
          </div>
        )}

        <div className="drawer-accordion">
          <button
            className="accordion-trigger accordion-trigger-rel"
            onClick={() => setRelsOpen(o => !o)}
            aria-expanded={relsOpen}
          >
            <span className="accordion-icon">{relsOpen ? '▾' : '▸'}</span>
            <span>
              {outgoing.length === 0 && inbound.length === 0
                ? 'Relationships — none'
                : `Relationships — ${outgoing.length} out, ${inbound.length} in`}
            </span>
          </button>

          {relsOpen && (
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
          )}
        </div>

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

        <div
          className="drawer-body markdown-body"
          dangerouslySetInnerHTML={{ __html: bodyHtml }}
        />
      </aside>

      {showMap && (
        <RelationshipMap
          skill={skill}
          allSkills={allSkills}
          onClose={() => setShowMap(false)}
        />
      )}
    </>
  )
}
