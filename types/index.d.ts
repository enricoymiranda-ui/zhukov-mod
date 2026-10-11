export type ZhukovNode = {
  id: string
  title: string
  wave: number
  kind: string
  deps: string[]
  tier: string
  state: string
  rounds: number
  deaths: number
}

export type ZhukovSnap = {
  run: string
  title: string
  state: string
  nodes: ZhukovNode[]
  cost: number
  events: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'zhukov-pane': { snap: ZhukovSnap | null; opusCalls: number; runKey: string }
  }
}
