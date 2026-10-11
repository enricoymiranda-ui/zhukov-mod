import { expect, mock, test } from 'claude-code/testing'

const RUN = '/h/runs/demo'
const PLAN = JSON.stringify({
  title: 'Demo op',
  nodes: [
    { id: 'core', title: 'Core', deps: [], tier: 'sonnet' },
    { id: 'a', title: 'A', deps: ['core'] },
    { id: 'wire', title: 'Wire', deps: ['a'], kind: 'integration' },
  ],
})
const STATUS = JSON.stringify({
  _run: { state: 'running' },
  core: { state: 'pass', tier: 'sonnet', rounds: 0, deaths: 0 },
  a: { state: 'fixing', tier: 'haiku', rounds: 1, deaths: 1 },
  wire: { state: 'pending', tier: 'haiku', rounds: 0, deaths: 0 },
})

// A fake disk beneath the plugin: the active pointer and one run folder.
function fakeDisk(on: any, files: Record<string, string>) {
  mock.env(on, { HOME: '/h' })
  const clock = mock.clock(on, { now: Date.now() })
  on('fs.read', ($: any, e: any) => {
    const text = files[e.path]
    if (text === undefined) return { deny: `ENOENT ${e.path}` }
    return { value: text }
  })
  on('fs.stat', ($: any, e: any) => {
    if (files[e.path] === undefined) return { deny: `ENOENT ${e.path}` }
    return { value: { kind: 'file', size: files[e.path]!.length, mtimeMs: Date.now(), isLink: false } }
  })
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'completed' }, text: 'agent ran' }))
  // stand-ins for what the engine itself answers in a real session
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  return clock
}

const ACTIVE = {
  '/h/.zhukov/active': RUN + '\n',
  [`${RUN}/plan.json`]: PLAN,
  [`${RUN}/status.json`]: STATUS,
  [`${RUN}/costs.jsonl`]: '{"cost":0.01}\n{"cost":0.02}\n',
  [`${RUN}/events.log`]: '10:00:01 core PASS\n10:00:05 a fix round 1 on haiku\n',
}

async function boot($: any, clock: any) {
  await $.session.start({ cwd: '/h', surface: 'terminal', isInteractive: true })
  await clock.advance(2100)
}

test('with no active run, an Agent call without a model is left alone', async ($, on) => {
  await boot($, fakeDisk(on, {}))
  const ran: any = await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'y' })
  expect(ran.deny).toBeUndefined()
})

test('during a run, an Agent call without a model is refused', async ($, on) => {
  await boot($, fakeDisk(on, ACTIVE))
  const ran: any = await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'y' })
  expect(String(ran.deny ?? ran.text)).toMatch(/must set model/)
})

test('during a run, opus is refused and haiku goes through', async ($, on) => {
  await boot($, fakeDisk(on, ACTIVE))
  const opus: any = await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'y', model: 'opus' })
  expect(String(opus.deny ?? opus.text)).toMatch(/must set model/)
  const haiku: any = await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'y', model: 'haiku' })
  expect(haiku.deny).toBeUndefined()
})

test('the pane draws the live graph on terminal and desktop', async ($, on) => {
  await boot($, fakeDisk(on, ACTIVE))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui: any = await ($ as any).ui.mount({
      plugin: 'zhukov', surface, component: 'Pane', requestId: 'zhukov',
      props: { title: 'Zhukov', isFocused: false, bodyColumns: 60 },
    })
    expect(await ui.find({ type: 'Text', text: /Demo op/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /WAVE 2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 fix · 1 died/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /soldiers \$0\.030/ })).toBeDefined()
    await ui.unmount()
  }
})
