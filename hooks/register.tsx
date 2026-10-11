import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ZhukovNode, ZhukovSnap } from '../types'
import { battleMap } from './map'

// The Zhukov mod: follows the run named in ~/.zhukov/active (written by zhukov.mjs check/draw/run).
// - a live pane of the task graph, read straight from the run's files (no model calls, $0 per update)
// - a status-line entry: pass count, soldier spend, Opus calls since the run became active
// - a guard: while a run is active, every Agent call must name haiku or sonnet

const PANE = 'zhukov'
const POLL_MS = 2000
const STALE_MS = 3 * 60 * 60 * 1000

const snap = atom({ plugin: 'zhukov-pane', key: 'snap' } as const, null)
const opusCalls = atom({ plugin: 'zhukov-pane', key: 'opusCalls' } as const, 0)
const runKey = atom({ plugin: 'zhukov-pane', key: 'runKey' } as const, '')

type Plan = { title?: string; nodes?: { id: string; title?: string; deps?: string[]; kind?: string; tier?: string }[] }
type NodeStatus = { state?: string; tier?: string; rounds?: number; deaths?: number }

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

function waves(plan: Plan): Map<string, number> {
  const deps = new Map((plan.nodes ?? []).map(n => [n.id, n.deps ?? []]))
  const depth = new Map<string, number>()
  const visit = (id: string, seen: string[]): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    if (seen.includes(id)) return 0
    const ds = (deps.get(id) ?? []).filter(d => deps.has(d))
    const d = ds.length ? 1 + Math.max(...ds.map(x => visit(x, [...seen, id]))) : 0
    depth.set(id, d)
    return d
  }
  for (const id of deps.keys()) visit(id, [])
  return depth
}

// Reads the active run's files and returns a compact snapshot, or null when no run is active.
async function loadSnap($: EngineInterface): Promise<ZhukovSnap | null> {
  const home = await $.env.get('HOME')
  if (!home) return null
  const run = (await readText($, `${home}/.zhukov/active`))?.trim()
  if (!run) return null
  const planText = await readText($, `${run}/plan.json`)
  if (!planText) return null
  let plan: Plan
  let status: Record<string, NodeStatus> & { _run?: { state?: string } } = {}
  try {
    plan = JSON.parse(planText)
  } catch {
    return null
  }
  const statusText = await readText($, `${run}/status.json`)
  try {
    if (statusText) status = JSON.parse(statusText)
  } catch {
    // a write in progress: keep the plan-only view for this tick
  }
  const state = status._run?.state ?? 'planned'
  if (state !== 'running') {
    const stat = await $.fs.stat(statusText ? `${run}/status.json` : `${run}/plan.json`).catch(() => undefined)
    if (!stat || Date.now() - stat.mtimeMs > STALE_MS) return null
  }
  const depth = waves(plan)
  const nodes: ZhukovNode[] = (plan.nodes ?? []).map(n => {
    const st = status[n.id] ?? {}
    return {
      id: n.id,
      title: n.title ?? n.id,
      wave: depth.get(n.id) ?? 0,
      kind: n.kind ?? 'build',
      deps: n.deps ?? [],
      tier: st.tier ?? n.tier ?? 'haiku',
      state: st.state ?? 'pending',
      rounds: st.rounds ?? 0,
      deaths: st.deaths ?? 0,
    }
  })
  let cost = 0
  for (const line of ((await readText($, `${run}/costs.jsonl`)) ?? '').split('\n')) {
    if (!line.trim()) continue
    try {
      cost += Number(JSON.parse(line).cost) || 0
    } catch {
      // a half-written line; the next tick reads it whole
    }
  }
  const events = ((await readText($, `${run}/events.log`)) ?? '').trim().split('\n').filter(Boolean).slice(-6)
  return { run, title: plan.title ?? run.split('/').pop() ?? 'Zhukov run', state, nodes, cost, events }
}

function statusLine(s: ZhukovSnap, calls: number): string {
  const pass = s.nodes.filter(n => n.state === 'pass').length
  return `Zhukov ${s.state} · ${pass}/${s.nodes.length} passed · soldiers $${s.cost.toFixed(3)} · Opus calls ${calls}`
}

const GLYPH: Record<string, string> = {
  pending: '○', making: '◐', made: '◑', checking: '◐', fixing: '◐',
  pass: '●', failed: '✕', flagged: '!', blocked: '⊘',
}
const COLOR: Record<string, string> = {
  making: 'suggestion', made: 'suggestion', checking: 'suggestion', fixing: 'suggestion',
  pass: 'success', failed: 'error', flagged: 'error', blocked: 'warning',
  running: 'suggestion', done: 'success', 'needs-commander': 'error', 'runner-died': 'error',
}

// Module state: starts over on a hot reload, which only costs one redraw.
let lastSig = ''
let openedFor = ''

async function poll($: EngineInterface) {
  const s = await loadSnap($)
  const sig = JSON.stringify(s)
  if (sig === lastSig) return
  lastSig = sig
  await update($, snap, () => s)
  if (!s) {
    $.ui.status(undefined)
    return
  }
  if ((await read($, runKey)) !== s.run) {
    await update($, runKey, () => s.run)
    await update($, opusCalls, () => 0)
  }
  $.ui.status(statusLine(s, await read($, opusCalls)))
  if (s.state === 'running' && openedFor !== s.run) {
    openedFor = s.run
    void $.ui.open({ id: PANE, title: 'Zhukov' })
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'zhukov-pane', description: 'Show the live Zhukov battle plan in a pane' })
    $.clock.every(POLL_MS, () => {
      void poll($)
    })
    return next(e)
  })

  on('command.run', { command: 'zhukov-pane' }, async $ => {
    await poll($)
    await $.ui.open({ id: PANE, title: 'Zhukov' })
    return { text: 'Zhukov pane opened.' }
  })

  // Counts the expensive model requests (the Commander's) while a run is active.
  on('turn.step', async function* ($, e, next) {
    if (/opus|fable/i.test(e.model) && (await read($, snap))) {
      const calls = await update($, opusCalls, n => (n ?? 0) + 1)
      const s = await read($, snap)
      if (s) $.ui.status(statusLine(s, typeof calls === 'number' ? calls : await read($, opusCalls)))
    }
    return yield* next(e)
  })

  // While a run is active, delegated work never silently inherits Opus.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.model === 'haiku' || e.model === 'sonnet' || e.subagent_type === 'fork') return next(e)
    if (!(await read($, snap))) return next(e)
    return {
      deny: `zhukov-pane: a Zhukov run is active, so every Agent call must set model "haiku" or "sonnet" (this one was ${e.model ? `"${e.model}"` : 'unset, which inherits Opus'}). Prefer \`zhukov.mjs ask\` for one-off jobs.`,
    }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = await read($, snap)
    if (!s) {
      return (
        <Box flexDirection="column">
          <Text bold>No active Zhukov run</Text>
          <Text dimColor>This pane follows a run live once the zhukov skill plans or launches one.</Text>
        </Box>
      )
    }
    const calls = await read($, opusCalls)
    const els = $.ui.resolve(e)
    if ((e.surface === 'desktop' || e.surface === 'mobile') && 'Svg' in els) {
      const { Svg } = els as typeof els & { Svg: (p: { source: string; alt: string; isInteractive?: boolean }) => unknown }
      const done = s.nodes.filter(n => n.state === 'pass').length
      return (
        <Box flexDirection="column">
          <Svg source={battleMap(s, calls)} alt={`Battle map: ${s.title}, ${done} of ${s.nodes.length} objectives taken, ${s.state}`} isInteractive />
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>HQ DISPATCHES</Text>
            {s.events.length === 0 && <Text dimColor>No dispatches yet.</Text>}
            {s.events.map((line, i) => (
              <Text key={`d${i}`} dimColor wrap="truncate-end">
                {line}
              </Text>
            ))}
          </Box>
        </Box>
      )
    }
    const pass = s.nodes.filter(n => n.state === 'pass').length
    const sonnet = s.nodes.filter(n => n.tier === 'sonnet').length
    const byWave: ZhukovNode[][] = []
    for (const n of s.nodes) (byWave[n.wave] ??= []).push(n)
    const width = Math.max(4, ...s.nodes.map(n => n.id.length))
    return (
      <Box flexDirection="column">
        <Text bold>{s.title}</Text>
        <Text>
          <Text color={COLOR[s.state] ?? 'subtle'}>{s.state}</Text>
          <Text dimColor> · </Text>
          {pass}/{s.nodes.length} passed
          <Text dimColor> · </Text>
          {sonnet} on Sonnet
        </Text>
        <Text dimColor>
          soldiers ${s.cost.toFixed(3)} · Opus calls {calls}
        </Text>
        {byWave.map((wave, i) => (
          <Box key={`w${i}`} flexDirection="column" marginTop={1}>
            <Text dimColor>
              WAVE {i + 1} · {(wave ?? []).length} parallel
            </Text>
            {(wave ?? []).map(n => (
              <Text key={n.id} wrap="truncate-end">
                <Text color={COLOR[n.state] ?? 'inactive'}>{GLYPH[n.state] ?? '○'}</Text> {n.id.padEnd(width)}{' '}
                <Text color={n.tier === 'sonnet' ? 'claude' : 'subtle'}>{n.tier.padEnd(6)}</Text>{' '}
                <Text color={COLOR[n.state]}>{n.state}</Text>
                <Text dimColor>
                  {n.kind === 'integration' ? ' · integration' : ''}
                  {n.rounds ? ` · ${n.rounds} fix` : ''}
                  {n.deaths ? ` · ${n.deaths} died` : ''}
                </Text>
              </Text>
            ))}
          </Box>
        ))}
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>RECENT</Text>
          {s.events.length === 0 && <Text dimColor>No dispatches yet.</Text>}
          {s.events.map((line, i) => (
            <Text key={`e${i}`} dimColor wrap="truncate-end">
              {line}
            </Text>
          ))}
        </Box>
      </Box>
    )
  })
}
