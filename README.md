# zhukov-pane

The Zhukov skill (an Opus Commander running cheap Haiku soldiers through a fault-tolerant task graph) plus a mod that shows each run live.

- **Scripts** — `scripts/zhukov.mjs` and `scripts/render.mjs`, downloaded by the Zhukov account skill at setup and checked against pinned hashes.

- **Pane** — opens by itself when a Zhukov run starts; shows every soldier by wave, its model, state, fix rounds and deaths, plus the latest dispatches. Updates from the run's files every 2 s, with no model calls. `/zhukov-pane` reopens it.
- **Status line** — pass count, soldier spend, and how many Opus calls the Commander has made during the run.
- **Guard** — while a run is active, an Agent call that doesn't set `model: "haiku"` or `"sonnet"` is refused, so delegated work never silently inherits Opus.

## Install

```
/plugin install zhukov-pane --marketplace enricoymiranda-ui/zhukov-mod
```

Answer `y` to add the marketplace, then choose the user scope.
