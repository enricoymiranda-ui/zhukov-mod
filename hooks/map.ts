import type { ZhukovNode, ZhukovSnap } from '../types'

// The Zhukov battle map: one SVG, drawn from a run snapshot. Pure (no $), so it renders the same in the
// pane, in tests and in a local preview. Map paper is a deliberate single look (it reads on light and dark
// hosts alike because it paints its own ground).
//
// Reading the map
//   phase lines (PL ALPHA, BRAVO, …)  = waves; a unit can't jump off before the line behind it is taken
//   unit symbols (NATO style)         = soldiers: ☒ infantry = Haiku, oval = armor = Sonnet, ★ = integration objective
//   attack arrows                     = dependencies; they animate while the target unit is in action
//   FLOT (front line)                 = how far the offensive has pushed: the last phase line fully taken
//   colours                           = reserve grey · in action blue · objective taken green · destroyed red · halted amber

const C = {
  paper: '#e8e0c4', paperDark: '#d9cfae', grid: '#c9bd98', ink: '#2a2a22', faint: '#7c745c',
  blue: '#2c5a9e', blueFill: '#b9cbe6', green: '#2f7a45', greenFill: '#bfe0c3', red: '#b3261e',
  amber: '#b7791f', amberFill: '#f2dcae', grey: '#8d8672', greyFill: '#ddd5bb', front: '#b3261e',
}
const PHASE = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT', 'GOLF', 'HOTEL']
const ACTIVE = new Set(['making', 'made', 'checking', 'fixing'])

const esc = (s: string) => s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch)
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

function look(n: ZhukovNode) {
  if (n.state === 'pass') return { stroke: C.green, fill: C.greenFill, word: 'OBJECTIVE TAKEN' }
  if (n.state === 'failed') return { stroke: C.red, fill: C.paper, word: 'DESTROYED' }
  if (n.state === 'flagged') return { stroke: C.amber, fill: C.amberFill, word: 'AWAITING ORDERS' }
  if (n.state === 'blocked') return { stroke: C.amber, fill: C.amberFill, word: 'CUT OFF' }
  if (ACTIVE.has(n.state)) {
    const word = n.state === 'fixing' ? `REGROUPING · R${n.rounds}` : n.state === 'checking' ? 'UNDER INSPECTION' : 'ADVANCING'
    return { stroke: C.blue, fill: C.blueFill, word }
  }
  return { stroke: C.grey, fill: C.greyFill, word: 'IN RESERVE' }
}

// NATO-style unit frame (friendly = rectangle) with the branch mark inside.
function unit(n: ZhukovNode, x: number, y: number): string {
  const L = look(n)
  const w = 58, h = 38, cx = x + w / 2, cy = y + h / 2
  const active = ACTIVE.has(n.state)
  let mark = ''
  if (n.kind === 'integration') {
    const r = 13, pts: string[] = []
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.45 : r
      pts.push(`${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`)
    }
    mark = `<polygon points="${pts.join(' ')}" fill="${L.stroke}" opacity="0.85"/>`
  } else if (n.tier === 'sonnet') {
    mark = `<ellipse cx="${cx}" cy="${cy}" rx="18" ry="9" fill="none" stroke="${L.stroke}" stroke-width="2.2"/>`
  } else {
    mark = `<path d="M${x} ${y}L${x + w} ${y + h}M${x + w} ${y}L${x} ${y + h}" stroke="${L.stroke}" stroke-width="1.8"/>`
  }
  const pulse = active
    ? `<rect x="${x - 4}" y="${y - 4}" width="${w + 8}" height="${h + 8}" rx="3" fill="none" stroke="${C.blue}" stroke-width="2"><animate attributeName="opacity" values="0.9;0.15;0.9" dur="1.6s" repeatCount="indefinite"/></rect>`
    : ''
  const dead = n.state === 'failed'
    ? `<path d="M${x - 6} ${y - 6}L${x + w + 6} ${y + h + 6}M${x + w + 6} ${y - 6}L${x - 6} ${y + h + 6}" stroke="${C.red}" stroke-width="4" stroke-linecap="round"/>`
    : ''
  const taken = n.state === 'pass'
    ? `<path d="M${x + w - 2} ${y - 16}v16M${x + w - 2} ${y - 16}h13l-4 4 4 4h-13" fill="${C.green}" stroke="${C.green}" stroke-width="1.5"/>`
    : ''
  const casualties = n.deaths
    ? `<text x="${x}" y="${y - 6}" font-size="10" fill="${C.red}" font-family="ui-monospace,Menlo,monospace">${'✝'.repeat(Math.min(n.deaths, 3))}</text>`
    : ''
  const dashed = n.state === 'pending' ? ' stroke-dasharray="5 3"' : ''
  const tip = `${n.id} — ${n.title}\n${n.tier.toUpperCase()} · ${L.word}${n.rounds ? ` · ${n.rounds} fix round(s)` : ''}${n.deaths ? ` · ${n.deaths} died` : ''}`
  return `<g><title>${esc(tip)}</title>${pulse}
<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${L.fill}" stroke="${L.stroke}" stroke-width="2.4"${dashed}/>${mark}${dead}${taken}${casualties}
<text x="${cx}" y="${y + h + 15}" text-anchor="middle" font-size="12" font-weight="700" fill="${C.ink}" font-family="ui-monospace,Menlo,monospace">${esc(cut(n.id.toUpperCase(), 16))}</text>
<text x="${cx}" y="${y + h + 28}" text-anchor="middle" font-size="9.5" letter-spacing="0.6" fill="${L.stroke}" font-family="ui-monospace,Menlo,monospace">${esc(L.word)}</text></g>`
}

export function battleMap(s: ZhukovSnap, opusCalls: number): string {
  const waves: ZhukovNode[][] = []
  for (const n of s.nodes) (waves[n.wave] ??= []).push(n)
  for (let i = 0; i < waves.length; i++) waves[i] ??= []
  const COL = 190, ROW = 92, PADX = 46, TOP = 88, BOTTOM = 64
  const rows = Math.max(1, ...waves.map(w => w!.length))
  const W = PADX * 2 + Math.max(1, waves.length) * COL
  const H = TOP + rows * ROW + BOTTOM
  const pos = new Map<string, { x: number; y: number }>()
  waves.forEach((w, c) => {
    const colH = w!.length * ROW, y0 = TOP + (rows * ROW - colH) / 2
    w!.forEach((n, r) => pos.set(n.id, { x: PADX + c * COL + (COL - 58) / 2, y: y0 + r * ROW + 10 }))
  })

  const parts: string[] = []
  // map paper, grid squares and a faint contour or two
  parts.push(`<rect width="${W}" height="${H}" fill="${C.paper}"/>`)
  for (let gx = 0; gx < W; gx += 40) parts.push(`<path d="M${gx} 0V${H}" stroke="${C.grid}" stroke-width="0.6"/>`)
  for (let gy = 0; gy < H; gy += 40) parts.push(`<path d="M0 ${gy}H${W}" stroke="${C.grid}" stroke-width="0.6"/>`)
  parts.push(`<path d="M0 ${H * 0.72} C ${W * 0.25} ${H * 0.6}, ${W * 0.5} ${H * 0.9}, ${W} ${H * 0.68}" fill="none" stroke="${C.paperDark}" stroke-width="10" opacity="0.7"/>`)

  // phase lines between waves
  waves.forEach((_, c) => {
    const x = PADX + c * COL
    parts.push(`<path d="M${x} ${TOP - 18}V${TOP + rows * ROW}" stroke="${C.faint}" stroke-width="1.2" stroke-dasharray="7 5"/>`)
    parts.push(`<text x="${x + 6}" y="${TOP - 24}" font-size="10" letter-spacing="1.2" fill="${C.faint}" font-family="ui-monospace,Menlo,monospace">PL ${PHASE[c] ?? c + 1}</text>`)
  })

  // FLOT: forward of the last phase where every unit has taken its objective
  let taken = -1
  for (let c = 0; c < waves.length; c++) { if (waves[c]!.length && waves[c]!.every(n => n.state === 'pass')) taken = c; else break }
  if (taken >= 0) {
    const fx = PADX + (taken + 1) * COL - 8
    let d = `M${fx} ${TOP - 10}`
    for (let y = TOP - 10; y < TOP + rows * ROW; y += 16) d += ` q ${y % 32 ? 7 : -7} 8 0 16`
    parts.push(`<path d="${d}" fill="none" stroke="${C.front}" stroke-width="3"/>`)
    parts.push(`<text x="${fx + 6}" y="${TOP + rows * ROW + 14}" font-size="10" font-weight="700" fill="${C.front}" font-family="ui-monospace,Menlo,monospace">FLOT</text>`)
  }

  // attack arrows along dependencies (broad, tapered); animated while the target is in action
  for (const n of s.nodes) {
    const b = pos.get(n.id); if (!b) continue
    for (const dId of n.deps) {
      const a = pos.get(dId); if (!a) continue
      const x1 = a.x + 62, y1 = a.y + 19, x2 = b.x - 10, y2 = b.y + 19, mx = (x1 + x2) / 2
      const live = ACTIVE.has(n.state)
      const col = n.state === 'pass' ? C.green : n.state === 'failed' || n.state === 'blocked' ? C.red : live ? C.blue : C.grey
      parts.push(`<path d="M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" fill="none" stroke="${col}" stroke-width="7" stroke-linecap="round" opacity="0.28"/>`)
      parts.push(`<path d="M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" fill="none" stroke="${col}" stroke-width="2.2"${live ? ' stroke-dasharray="9 6"' : ''}>${live ? '<animate attributeName="stroke-dashoffset" from="30" to="0" dur="0.9s" repeatCount="indefinite"/>' : ''}</path>`)
      parts.push(`<path d="M${x2 + 9} ${y2} l -13 -7 v 14 z" fill="${col}"/>`)
    }
  }
  for (const n of s.nodes) { const p = pos.get(n.id); if (p) parts.push(unit(n, p.x, p.y)) }

  // title block and order of battle
  const pass = s.nodes.filter(n => n.state === 'pass').length
  const lost = s.nodes.filter(n => n.state === 'failed').length
  const deaths = s.nodes.reduce((a, n) => a + n.deaths, 0)
  const armor = s.nodes.filter(n => n.tier === 'sonnet').length
  const stateWord: Record<string, string> = { running: 'OFFENSIVE IN PROGRESS', done: 'ALL OBJECTIVES TAKEN', 'needs-commander': 'HALTED — ORDERS NEEDED', 'runner-died': 'COMMS LOST', planned: 'PLANNING', idle: 'PLANNING' }
  parts.push(`<rect x="0" y="0" width="${W}" height="44" fill="${C.ink}"/>`)
  parts.push(`<text x="16" y="28" font-size="17" font-weight="800" letter-spacing="2" fill="${C.paper}" font-family="Impact,'Arial Narrow',system-ui,sans-serif">OPERATION ${esc(cut(s.title.toUpperCase(), 40))}</text>`)
  parts.push(`<text x="${W - 16}" y="28" text-anchor="end" font-size="11" letter-spacing="1.4" fill="${s.state === 'done' ? '#9fd8a8' : s.state === 'running' ? '#a9c4ef' : '#f0b8a8'}" font-family="ui-monospace,Menlo,monospace">${esc(stateWord[s.state] ?? s.state.toUpperCase())}</text>`)
  const by = H - 22
  parts.push(`<text x="16" y="${by}" font-size="11" fill="${C.ink}" font-family="ui-monospace,Menlo,monospace">OBJECTIVES ${pass}/${s.nodes.length}  ·  ARMOR ${armor}  ·  CASUALTIES ${deaths}${lost ? `  ·  UNITS LOST ${lost}` : ''}  ·  SUPPLY $${s.cost.toFixed(3)}  ·  HQ CALLS ${opusCalls}</text>`)
  parts.push(`<text x="${W - 16}" y="${by}" text-anchor="end" font-size="10" fill="${C.faint}" font-family="ui-monospace,Menlo,monospace">☒ HAIKU  ⬭ SONNET  ★ OBJECTIVE</text>`)

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${parts.join('')}</svg>`
}
