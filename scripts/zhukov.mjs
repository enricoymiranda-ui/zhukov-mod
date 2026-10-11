#!/usr/bin/env node
// zhukov v2 — the runner. Soldiers are headless `claude -p` processes, so the whole
// make -> check -> fix loop runs OUTSIDE the Commander's (Opus) context. Opus plans, launches
// one run, waits, and only wakes for exceptions and the final review.
//
//   node zhukov.mjs check  <run>                 validate plan.json (waves, tiers, budgets, blast radius)
//   node zhukov.mjs draw   <run>                 check + write <run>/graph.html
//   node zhukov.mjs run    <run> [--jobs 6]      execute the graph (long-running; launch with nohup … &)
//   node zhukov.mjs wait   <run> [--max 540]     block until the run stops (done / needs Commander) or --max s
//   node zhukov.mjs status <run>                 one compact summary (cheap to read)
//   node zhukov.mjs set    <run> <id> pending|pass|failed|escalate   Commander override, then `run` again
//
// <run>/plan.json is written by the Commander. Everything else in <run>/ is written by the runner:
// status.json (ledger), receipts/, verdicts/, logs/<id>.<job>.<n>.json, costs.jsonl, events.log, graph.html.
// Env: ZHUKOV_CLAUDE (binary, default "claude"), ZHUKOV_HAIKU / ZHUKOV_SONNET (model ids).
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, rmSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

// ---------- tunables (measured 2026-10-10 on Claude Code 2.1.296; adjust from costs.jsonl) ----------
const CHARS_PER_TOKEN = 2.5;
const HARNESS_TOKENS = 17000;    // slim soldier (custom system prompt, 4 tools, no MCP) measured ~16.5k
const TIER_LINE = 100000;        // Haiku 5.5 price x5 above this prompt size
const READ_WARN = 50000, READ_MAX = 65000;
const LOAD_BEARING = 3;          // >2 non-integration dependents
const MAX_NODES = 16;
const CAP = { haiku: 3, sonnet: 2 };          // fix rounds before escalate / fail
const INTEGRATION_ROUNDS = 4;
const MAX_DEATHS = 2;                          // 2 deaths on haiku -> sonnet; 3rd death -> failed
const BUDGET = { haiku: 0.6, sonnet: 4 };      // --max-budget-usd per soldier call
const MODEL = { haiku: process.env.ZHUKOV_HAIKU || 'haiku', sonnet: process.env.ZHUKOV_SONNET || 'sonnet' };
const CLAUDE = process.env.ZHUKOV_CLAUDE || 'claude';
// Workers must never reach the user's connectors (real Chrome, Supabase, Vercel, Gmail…): --strict-mcp-config
// does NOT remove claude.ai connectors, so every spawn also denies mcp__* (verified 2026-10-11).
const NO_MCP = ['--disallowedTools', 'mcp__*'];
const SYS = 'You are a precise worker in a parallel build. Do exactly the task, nothing more. Use your tools. Do not explore beyond what you are told to read. Be terse.';

const argv = process.argv.slice(2);

// ======================= ask: one slim job, no run folder =======================
//   node zhukov.mjs ask --model haiku|sonnet --prompt-file F [--tools Read,Bash,WebFetch] [--cwd DIR]
//                       [--budget USD] [--max-chars 3000] [--log FILE]
// For fact-checks, final-review verifiers, repo scouts and "read this big thing and summarize".
// ~16k-token harness instead of the Agent tool's ~100k+, and the Commander only ever sees
// the capped answer — never the raw documents the worker read.
if (argv[0] === 'ask') {
  const a = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const model = a('--model');
  const pf = a('--prompt-file');
  if (!['haiku', 'sonnet'].includes(model) || !pf || !existsSync(pf)) {
    console.error('ask --model haiku|sonnet --prompt-file F [--tools T] [--cwd D] [--budget USD] [--max-chars N] [--log FILE]  (opus is not allowed)');
    process.exit(2);
  }
  const tools = a('--tools', 'Read,Glob,Grep');
  const maxChars = +a('--max-chars', 3000);
  const args = ['-p', '--model', MODEL[model], '--output-format', 'json', '--no-session-persistence',
    '--permission-mode', 'acceptEdits', '--tools', tools, '--allowedTools', tools, '--strict-mcp-config', ...NO_MCP,
    '--system-prompt', 'You are a precise assistant. Do exactly the task. Your final reply is all the requester will see: make it complete but as short as possible.',
    '--max-budget-usd', String(+a('--budget', model === 'sonnet' ? 3 : 0.5))];
  const t0 = Date.now();
  const child = spawn(CLAUDE, args, { cwd: a('--cwd', process.cwd()), stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (err += d));
  child.on('close', (code) => {
    let j = null; try { j = JSON.parse(out); } catch {}
    const cost = j?.total_cost_usd || 0, models = j?.modelUsage ? Object.keys(j.modelUsage).join(',') : '?';
    if (a('--log')) appendFileSync(a('--log'), JSON.stringify({ job: 'ask', model, models, cost, ms: Date.now() - t0, code }) + '\n');
    let res = j?.result ?? `(no result: exit ${code} ${err.slice(0, 300)})`;
    if (res.length > maxChars) res = res.slice(0, maxChars) + `\n…[truncated at ${maxChars} chars — ask for a shorter answer]`;
    console.log(res);
    console.log(`\n[ask: ${models} $${cost.toFixed(4)} ${Math.round((Date.now() - t0) / 1000)}s]`);
    process.exit(code === 0 ? 0 : 1);
  });
  child.stdin.end(readFileSync(pf, 'utf8'));
}
else {
const [cmd, runArg, ...rest] = argv;
const opt = (n, d) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : d; };
if (!cmd || !runArg) { console.error('usage: zhukov.mjs check|draw|run|wait|status <run> | set <run> <id> <state>'); process.exit(2); }
const run = resolve(runArg);
const P = (...p) => join(run, ...p);
if (!existsSync(P('plan.json'))) { console.error(`no plan.json in ${run}`); process.exit(2); }
const plan = JSON.parse(readFileSync(P('plan.json'), 'utf8'));
const nodes = plan.nodes || [];
const byId = new Map();
const errors = [], warns = [];

// ======================= validation =======================
for (const n of nodes) {
  if (!n.id || !n.title || !n.out) errors.push(`node missing id/title/out: ${JSON.stringify(n).slice(0, 80)}`);
  if (byId.has(n.id)) errors.push(`duplicate id: ${n.id}`);
  byId.set(n.id, n);
  n.deps ||= []; n.reads ||= []; n.rubric ||= [];
  n.outs = Array.isArray(n.out) ? n.out : [n.out];
  n.tier ||= 'haiku'; n.kind ||= 'build';
  if (!['haiku', 'sonnet'].includes(n.tier)) errors.push(`${n.id}: tier must be haiku or sonnet`);
  if (n.tier === 'sonnet' && !n.why) errors.push(`${n.id}: sonnet node needs "why" (urgent | load-bearing | reason)`);
  if (!n.task) errors.push(`${n.id}: missing task (the surgical order)`);
  if (!n.contract) errors.push(`${n.id}: missing contract`);
  if (!n.rubric.length) warns.push(`${n.id}: no rubric — checker has nothing concrete to judge`);
  if (!n.observe && n.kind !== 'research') warns.push(`${n.id}: no observe command — checker will improvise`);
}
const owner = new Map();
for (const n of nodes) {
  for (const d of n.deps) if (!byId.has(d)) errors.push(`${n.id}: unknown dependency "${d}"`);
  if (n.deps.includes(n.id)) errors.push(`${n.id}: depends on itself`);
  for (const o of n.outs) { if (owner.has(o)) errors.push(`${n.id} and ${owner.get(o)} both write ${o}`); owner.set(o, n.id); }
}
if (nodes.length > 1 && !nodes.some((n) => n.kind === 'integration')) errors.push('no integration node');
if (nodes.length > MAX_NODES) errors.push(`${nodes.length} nodes > ${MAX_NODES}; split the run`);
const depth = new Map();
function visit(id, stack = []) {
  if (depth.has(id)) return depth.get(id);
  if (stack.includes(id)) { errors.push(`cycle: ${[...stack, id].join(' -> ')}`); depth.set(id, 0); return 0; }
  const n = byId.get(id); if (!n) return 0;
  const d = n.deps.length ? 1 + Math.max(...n.deps.map((x) => visit(x, [...stack, id]))) : 0;
  depth.set(id, d); return d;
}
nodes.forEach((n) => visit(n.id));
const children = new Map(nodes.map((n) => [n.id, []]));
for (const n of nodes) for (const d of n.deps) children.get(d)?.push(n.id);
function downstream(id, seen = new Set()) { for (const c of children.get(id) || []) if (!seen.has(c)) { seen.add(c); downstream(c, seen); } return seen; }
for (const n of nodes) {
  n.blast = [...downstream(n.id)].filter((x) => byId.get(x)?.kind !== 'integration').length;
  n.loadBearing = n.kind !== 'integration' && n.blast >= LOAD_BEARING;
  if (n.loadBearing && n.tier !== 'sonnet' && !n.accept_risk) errors.push(`${n.id}: load-bearing (topples ${n.blast}) — tier "sonnet" + why "load-bearing", split it, or accept_risk:true`);
}
function readTokens(spec) {
  const m = /^(.*?):(\d+)-(\d+)$/.exec(spec); const p = m ? m[1] : spec;
  if (!existsSync(p)) return { tokens: 0, missing: true };
  if (!m) return { tokens: Math.ceil(statSync(p).size / CHARS_PER_TOKEN) };
  return { tokens: Math.ceil(readFileSync(p, 'utf8').split('\n').slice(+m[2] - 1, +m[3]).join('\n').length / CHARS_PER_TOKEN) };
}
const shared = plan.shared && existsSync(plan.shared) ? readFileSync(plan.shared, 'utf8') : '';
const sharedTok = Math.ceil(shared.length / CHARS_PER_TOKEN);
if (sharedTok > 3000) warns.push(`shared brief ~${sharedTok} tokens — every soldier pays it every turn; keep < 3k`);
for (const n of nodes) {
  let t = sharedTok; const depOuts = new Set(n.deps.flatMap((d) => byId.get(d)?.outs || [])); const missing = [];
  for (const r of n.reads) { const x = readTokens(r); t += x.tokens; if (x.missing && !depOuts.has(r.replace(/:\d+-\d+$/, ''))) missing.push(r); }
  n.readTok = t;
  if (missing.length) warns.push(`${n.id}: reads not found: ${missing.join(', ')}`);
  if (n.tier === 'haiku' && n.kind !== 'integration') {
    if (t > READ_MAX) errors.push(`${n.id}: ~${t} tokens of reads + ~${HARNESS_TOKENS} harness crosses Haiku's 100k line — split or use line ranges`);
    else if (t > READ_WARN) warns.push(`${n.id}: ~${t} tokens of reads — tight under 100k; prefer line ranges`);
  }
}
if (errors.length) {
  console.error('PLAN INVALID:\n- ' + [...new Set(errors)].join('\n- '));
  if (warns.length) console.error('warnings:\n- ' + warns.join('\n- '));
  process.exit(1);
}
const waves = []; for (const n of nodes) (waves[depth.get(n.id)] ||= []).push(n);

// ======================= ledger =======================
const TERMINAL = ['pass', 'failed', 'blocked', 'flagged'];
function load() {
  const s = existsSync(P('status.json')) ? JSON.parse(readFileSync(P('status.json'), 'utf8')) : {};
  s._run ||= { state: 'idle', started: null, ended: null, note: '' };
  for (const n of nodes) s[n.id] ||= { state: 'pending', tier: n.tier, rounds: 0, deaths: 0, checkDeaths: 0, lastDefects: [], log: [] };
  return s;
}
let S;
const save = () => writeFileSync(P('status.json'), JSON.stringify(S, null, 2));
const ev = (m) => { const line = `${new Date().toISOString().slice(11, 19)} ${m}`; appendFileSync(P('events.log'), line + '\n'); };
function propagate() {
  const dead = new Set(nodes.filter((n) => S[n.id].state === 'failed').flatMap((n) => [...downstream(n.id)]));
  for (const n of nodes) {
    const st = S[n.id];
    if (dead.has(n.id) && !['pass', 'failed', 'blocked'].includes(st.state)) { st.state = 'blocked'; ev(`${n.id} blocked (upstream failed)`); }
    if (!dead.has(n.id) && st.state === 'blocked') { st.state = 'pending'; ev(`${n.id} unblocked`); }
  }
}

// ======================= prompts =======================
const rd = (n) => [...n.reads, ...n.deps.flatMap((d) => byId.get(d).outs)];
const contractsOf = (n) => n.deps.map((d) => `${d}: ${byId.get(d).contract}`).join(' | ') || '(none)';
function receiptLine(n, round) {
  return `As your LAST action write ${P('receipts', n.id + '.json')} containing exactly {"id":"${n.id}","round":${round},"status":"done","note":"<=15 words"}. ` +
    `If you cannot do it without reading files not listed, write status "oversize" with a note naming exactly what you need, and stop. ` +
    `If the contract is contradictory or impossible, status "blocked" with the reason, and stop. Reply with one line.`;
}
function soldierPrompt(n, st, round, defects) {
  const parts = [];
  if (shared) parts.push(shared.trim(), '---');
  parts.push(`You are soldier "${n.id}". Other soldiers build other parts at the same time; you cannot see them — follow the contract exactly.`);
  if (defects?.length) {
    parts.push(round > 0
      ? `FIX ROUND ${round}. The file(s) already exist. Fix exactly these defects by editing in place; keep everything else that works:`
      : `A previous (cheaper) soldier's attempt failed review. Read the existing file(s) if present; you may rewrite them. Make sure these defects are gone:`);
    defects.forEach((d, i) => parts.push(`${i + 1}. ${d.defect} -> ${d.fix}`));
    parts.push(`ORIGINAL TASK (for context): ${n.task}`);
  } else parts.push(`TASK: ${n.task}`);
  parts.push(`YOU OWN (write only these): ${n.outs.join(', ')}`,
    `CONTRACT: ${n.contract}`, `YOU CONSUME: ${contractsOf(n)}`,
    n.kind === 'integration' ? `PARTS YOU WIRE (id: file — rubric): ${n.deps.map((d) => `${d}: ${byId.get(d).outs.join(',')} — ${byId.get(d).rubric.join('; ')}`).join(' | ')}` : '',
    `READ ONLY THESE (line ranges are path:start-end): ${rd(n).join(', ') || '(nothing)'}`,
    `Do not search, glob or open anything else. Do not run or test your output — a separate checker will.`,
    `RUBRIC the checker will apply: ${n.rubric.map((r, i) => `(${i + 1}) ${r}`).join(' ')}`,
    receiptLine(n, round));
  return parts.filter(Boolean).join('\n');
}
function checkerPrompt(n, round) {
  const vpath = P('verdicts', `${n.id}.r${round}.json`);
  const integ = n.kind === 'integration';
  return [
    `You check work produced by other models. You do NOT fix anything — you only report.`,
    `TASK they were given: ${n.task}`, `CONTRACT: ${n.contract}`, `OUTPUT: ${n.outs.join(', ')}`,
    integ ? `PARTS (id: contract -> file): ${n.deps.map((d) => `${d}: ${byId.get(d).contract} -> ${byId.get(d).outs.join(',')}`).join(' | ')}` : '',
    `RUBRIC: ${n.rubric.map((r, i) => `(${i + 1}) ${r}`).join(' ')}`,
    `1. Observe the REAL output, never judge from source alone: ${n.observe || 'run or render it in the most direct way'}. Look at every screenshot you make.`,
    n.kind === 'research' ? `For research: open every cited URL and confirm each quoted claim is actually there.` : '',
    `2. Read the source for bugs your probe could miss; check contract names and shapes exactly.`,
    `FAIL only for rubric/contract violations or real bugs, not taste. Max 5 defects, worst first. Each fix must be concrete, with exact numbers/names.`,
    integ ? `For each defect set "node" to the id of the part whose file is at fault (or "${n.id}" if the wiring itself is wrong).` : '',
    `Write ${vpath} as JSON: {"verdict":"PASS"|"FAIL","defects":[{${integ ? '"node":"<id>",' : ''}"defect":"<what + how reproduced>","fix":"<concrete fix>"}]}. Then reply with one line: the verdict.`,
  ].filter(Boolean).join('\n');
}

// ======================= process runner =======================
function soldier({ id, job, model, prompt, tools, budget }) {
  const n = byId.get(id);
  const k = (S[id].calls = (S[id].calls || 0) + 1);
  const logf = P('logs', `${id}.${job}.${k}.json`);
  const args = ['-p', '--model', model, '--output-format', 'json', '--no-session-persistence',
    '--permission-mode', 'acceptEdits', '--tools', tools, '--allowedTools', tools, '--strict-mcp-config', ...NO_MCP,
    '--system-prompt', SYS, '--max-budget-usd', String(budget), '--add-dir', run];
  for (const d of new Set(n.outs.map((o) => o.replace(/\/[^/]*$/, '')))) args.push('--add-dir', d);
  const timeout = (plan.timeout_s || 900) * 1000;
  return new Promise((res) => {
    const t0 = Date.now();
    let out = '', err = '', killed = false;
    let child;
    try { child = spawn(CLAUDE, args, { cwd: plan.cwd || process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { return res({ ok: false, why: `spawn failed: ${e.message}` }); }
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { err += e.message; });
    child.on('close', (code) => {
      clearTimeout(timer);
      let j = null; try { j = JSON.parse(out); } catch {}
      writeFileSync(logf, out || err || '(no output)');
      const cost = j?.total_cost_usd || 0;
      const models = j?.modelUsage ? Object.keys(j.modelUsage) : [];
      appendFileSync(P('costs.jsonl'), JSON.stringify({ id, job, model, models, cost, ms: Date.now() - t0, code, killed }) + '\n');
      res({ ok: code === 0 && !killed && j && !j.is_error, why: killed ? 'timeout' : code !== 0 ? `exit ${code}: ${err.slice(0, 200)}` : j?.is_error ? 'error result' : '', reply: j?.result || '' });
    });
    child.stdin.end(prompt);
  });
}
function receipt(id, round) {
  const rp = P('receipts', `${id}.json`);
  if (!existsSync(rp)) return null;
  try {
    const r = JSON.parse(readFileSync(rp, 'utf8'));
    if (r.id !== id || (r.round ?? 0) < round) return null;
    if (r.status && r.status !== 'done') return r;
    return byId.get(id).outs.every((o) => existsSync(o) && statSync(o).size > 0) ? r : null;
  } catch { return null; }
}

// ======================= jobs =======================
function died(id, why) {
  const st = S[id];
  st.deaths++;
  if (st.deaths > MAX_DEATHS) { st.state = 'failed'; ev(`${id} FAILED: died ${st.deaths}x (${why})`); return; }
  if (st.deaths === MAX_DEATHS && st.tier === 'haiku') { st.tier = 'sonnet'; st.rounds = 0; ev(`${id} died twice -> escalated to sonnet`); }
  else ev(`${id} died (${why}) -> redeploy`);
  st.state = st.state === 'fixing' ? 'made' : 'pending';
}
async function makeJob(id) {
  const n = byId.get(id), st = S[id];
  rmSync(P('receipts', `${id}.json`), { force: true });
  st.state = 'making'; save(); ev(`${id} make on ${st.tier}`);
  const carry = st.tier !== n.tier ? st.lastDefects : null;     // escalated fresh make carries the open defects
  const r = await soldier({ id, job: 'make', model: MODEL[st.tier], prompt: soldierPrompt(n, st, 0, carry), tools: 'Read,Write,Edit', budget: BUDGET[st.tier] });
  const rc = receipt(id, 0);
  if (rc && rc.status && rc.status !== 'done') { st.state = 'flagged'; st.flag = `${rc.status}: ${rc.note || ''}`; ev(`${id} FLAGGED ${st.flag}`); }
  else if (rc) { st.state = 'made'; st.rounds = 0; ev(`${id} made`); }
  else died(id, r.why || 'no receipt');
}
async function fixJob(id, defects) {
  const n = byId.get(id), st = S[id];
  st.state = 'fixing'; st.rounds++; const round = st.rounds; save(); ev(`${id} fix round ${round} on ${st.tier}`);
  const r = await soldier({ id, job: `fix${round}`, model: MODEL[st.tier], prompt: soldierPrompt(n, st, round, defects), tools: 'Read,Write,Edit', budget: BUDGET[st.tier] });
  const rc = receipt(id, round);
  if (rc && rc.status && rc.status !== 'done') { st.state = 'flagged'; st.flag = `${rc.status}: ${rc.note || ''}`; ev(`${id} FLAGGED ${st.flag}`); return false; }
  if (rc) { st.state = 'made'; return true; }
  died(id, r.why || 'no receipt'); return false;
}
function escalateOrFail(id, why) {
  const st = S[id];
  if (st.tier === 'haiku') { st.tier = 'sonnet'; st.rounds = 0; st.state = 'pending'; st.log.push(`escalated: ${why}`); ev(`${id} ESCALATED to sonnet (${why})`); }
  else { st.state = 'failed'; st.log.push(`failed: ${why}`); ev(`${id} FAILED on sonnet (${why})`); }
}
async function checkJob(id) {
  const n = byId.get(id), st = S[id];
  const round = st.rounds; const vpath = P('verdicts', `${id}.r${round}.json`);
  rmSync(vpath, { force: true });
  st.state = 'checking'; save(); ev(`${id} check r${round}`);
  await soldier({ id, job: `check${round}`, model: MODEL.haiku, prompt: checkerPrompt(n, round), tools: 'Read,Write,Bash,Glob', budget: BUDGET.haiku });
  let v = null; try { v = JSON.parse(readFileSync(vpath, 'utf8')); } catch {}
  if (!v || !['PASS', 'FAIL'].includes(v.verdict)) {
    st.checkDeaths++;
    if (st.checkDeaths > 2) { st.state = 'flagged'; st.flag = 'checker could not produce a verdict 3x — check the observe command'; ev(`${id} FLAGGED checker dead`); }
    else { st.state = 'made'; ev(`${id} checker died -> recheck`); }
    return;
  }
  if (v.verdict === 'PASS') { st.state = 'pass'; ev(`${id} PASS (tier ${st.tier}, ${st.rounds} fix rounds)`); return; }
  const defects = (v.defects || []).slice(0, 5);
  st.log.push(`r${round} FAIL: ${defects.map((d) => (d.defect || '').slice(0, 60)).join(' | ')}`);
  ev(`${id} FAIL r${round}: ${defects.length} defect(s)`);
  // brakes
  const prev = st.lastDefects || [];
  const noProgress = round > 0 && defects.length >= prev.length;
  st.lastDefects = defects;
  if (n.kind === 'integration') {
    st.irounds = (st.irounds || 0) + 1;
    if (st.irounds >= INTEGRATION_ROUNDS) { st.state = 'failed'; st.log.push(`failed: ${INTEGRATION_ROUNDS} integration rounds`); ev(`${id} FAILED: ${INTEGRATION_ROUNDS} integration rounds`); return; }
    const groups = new Map();
    for (const d of defects) { const t = byId.has(d.node) && (d.node === id || n.deps.includes(d.node)) ? d.node : id; if (!groups.has(t)) groups.set(t, []); groups.get(t).push(d); }
    ev(`${id} routing defects to: ${[...groups.keys()].join(', ')}`);
    const parts = [...groups.keys()].filter((t) => t !== id);
    for (const t of parts) S[t].state = 'fixing';
    st.state = 'fixing'; save();
    const results = await Promise.all([...groups].map(async ([t, ds]) => {
      const ok = await fixJob(t, ds);
      if (ok && t !== id) S[t].state = 'pass';   // part re-verified by the next integration check
      return ok;
    }));
    // a routed fix that died/flagged leaves that part non-pass; integration waits (pending) until it passes again
    if (st.state !== 'flagged') st.state = results.every(Boolean) && parts.every((t) => S[t].state === 'pass') ? 'made' : 'pending';
    return;
  }
  if (noProgress) return escalateOrFail(id, `no progress (${prev.length} -> ${defects.length} defects)`);
  if (round >= CAP[st.tier]) return escalateOrFail(id, `${CAP[st.tier]} fix rounds used`);
  await fixJob(id, defects);
}

// ======================= run loop =======================
async function runLoop() {
  const jobs = +opt('--jobs', plan.jobs || 6);
  S = load();
  // crash recovery: anything mid-flight when the last runner died is presumed dead
  for (const n of nodes) {
    const st = S[n.id];
    if (st.state === 'making' || st.state === 'fixing') { const rc = receipt(n.id, st.rounds); if (rc && (!rc.status || rc.status === 'done')) st.state = 'made'; else died(n.id, 'runner restarted'); }
    if (st.state === 'checking') st.state = 'made';
  }
  S._run = { state: 'running', pid: process.pid, started: new Date().toISOString(), ended: null, note: '' };
  propagate(); save(); ev(`RUN start (jobs=${jobs})`);
  const running = new Map();
  for (;;) {
    propagate();
    const free = () => jobs - running.size;
    const launch = (id, fn) => { const p = fn(id).catch((e) => { ev(`${id} runner error ${e.message}`); S[id].state = 'flagged'; S[id].flag = e.message; }).finally(() => { running.delete(id); save(); }); running.set(id, p); };
    for (const n of nodes) {
      if (free() <= 0) break;
      if (running.has(n.id)) continue;
      const st = S[n.id];
      const depsPass = n.deps.every((d) => S[d].state === 'pass');
      if (st.state === 'pending' && n.kind === 'integration' && st.irounds && depsPass) st.state = 'made'; // re-check wiring, don't rebuild
      if (st.state === 'made') launch(n.id, checkJob);
      else if (st.state === 'pending' && n.deps.every((d) => S[d].state === 'pass')) launch(n.id, makeJob);
    }
    save(); draw(true);
    if (!running.size) break;
    await Promise.race(running.values());
  }
  const all = nodes.map((n) => S[n.id].state);
  S._run.state = all.every((x) => x === 'pass') ? 'done' : 'needs-commander';
  S._run.ended = new Date().toISOString();
  save(); draw(true); ev(`RUN end: ${S._run.state}`);
  console.log(summary());
}

// ======================= reporting =======================
function costs() {
  const t = {}; let total = 0;
  if (existsSync(P('costs.jsonl'))) for (const l of readFileSync(P('costs.jsonl'), 'utf8').trim().split('\n').filter(Boolean)) {
    const c = JSON.parse(l); if (!c.cost && !c.models.length) continue; const m = (c.models[0] || c.model).replace(/^claude-/, ''); t[m] = (t[m] || 0) + c.cost; total += c.cost;
  }
  return { total, by: Object.entries(t).map(([m, c]) => `${m} $${c.toFixed(3)}`).join(', ') };
}

function summary() {
  S ||= load();
  const c = costs();
  const by = (k) => nodes.filter((n) => S[n.id].state === k).map((n) => n.id);
  const lines = [`RUN ${S._run.state} — ${by('pass').length}/${nodes.length} pass · soldiers $${c.total.toFixed(3)} (${c.by || 'none yet'})`];
  for (const k of ['flagged', 'failed', 'blocked']) {
    const ids = by(k); if (!ids.length) continue;
    lines.push(`${k.toUpperCase()}: ` + ids.map((id) => {
      const st = S[id]; const why = k === 'flagged' ? st.flag : k === 'failed' ? (st.log.at(-1) || '') : '';
      return `${id}${why ? ` (${why.slice(0, 140)})` : ''}`;
    }).join('; '));
  }
  const esc = nodes.filter((n) => S[n.id].tier !== n.tier).map((n) => n.id);
  if (esc.length) lines.push(`escalated to sonnet: ${esc.join(', ')}`);
  const active = nodes.filter((n) => ['making', 'checking', 'fixing'].includes(S[n.id].state)).map((n) => `${n.id}:${S[n.id].state}`);
  if (active.length) lines.push(`in flight: ${active.join(', ')}`);
  return lines.join('\n');
}
function preview() {
  console.log(`plan OK: ${nodes.length} nodes, ${waves.length} waves, widest ${Math.max(...waves.map((w) => w.length))}`);
  waves.forEach((w, i) => console.log(`  wave ${i + 1}: ${w.map((n) => `${n.id}[${n.tier[0]}${n.loadBearing ? '!' : ''}]`).join(', ')}`));
  const big = [...nodes].sort((a, b) => b.readTok - a.readTok)[0];
  console.log(`  largest soldier start: ${big.id} ~${big.readTok + HARNESS_TOKENS} tokens (line ${TIER_LINE})`);
  // calibrated 2026-10-11 from live runs: a Haiku node (make + check) ≈ $0.004–0.005; a fix round adds about the same;
  // Sonnet ≈ 15–20× Haiku. Low = no fixes; high = one fix round everywhere. Big reads push both up.
  const per = (n) => (n.tier === 'sonnet' ? 0.08 : 0.005) * (1 + n.readTok / 40000);
  const lo = nodes.reduce((a, n) => a + per(n), 0), hi = nodes.reduce((a, n) => a + per(n) * 2.2, 0);
  console.log(`  est. soldier cost: ~$${lo.toFixed(3)}–$${hi.toFixed(3)} (calibrated from live runs; costs.jsonl has the truth)`);
  if (warns.length) console.log('warnings:\n- ' + warns.join('\n- '));
}
// ---------- battle map (WW2 operations-map style), published by the Commander as an artifact ----------
const MAPC = { paper: '#e8e0c4', paperDark: '#d9cfae', grid: '#c9bd98', ink: '#2a2a22', faint: '#7c745c', blue: '#2c5a9e', blueFill: '#b9cbe6',
  green: '#2f7a45', greenFill: '#bfe0c3', red: '#b3261e', amber: '#b7791f', amberFill: '#f2dcae', grey: '#8d8672', greyFill: '#ddd5bb' };
const PHASE = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT', 'GOLF', 'HOTEL'];
const LIVE = new Set(['making', 'made', 'checking', 'fixing']);
const xesc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const xcut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
function unitLook(st) {
  if (st.state === 'pass') return { stroke: MAPC.green, fill: MAPC.greenFill, word: 'OBJECTIVE TAKEN' };
  if (st.state === 'failed') return { stroke: MAPC.red, fill: MAPC.paper, word: 'DESTROYED' };
  if (st.state === 'flagged') return { stroke: MAPC.amber, fill: MAPC.amberFill, word: 'AWAITING ORDERS' };
  if (st.state === 'blocked') return { stroke: MAPC.amber, fill: MAPC.amberFill, word: 'CUT OFF' };
  if (LIVE.has(st.state)) return { stroke: MAPC.blue, fill: MAPC.blueFill, word: st.state === 'fixing' ? `REGROUPING · R${st.rounds}` : st.state === 'checking' ? 'UNDER INSPECTION' : 'ADVANCING' };
  return { stroke: MAPC.grey, fill: MAPC.greyFill, word: 'IN RESERVE' };
}
function unitSvg(n, st, x, y) {
  const L = unitLook(st), w = 58, h = 38, cx = x + w / 2, cy = y + h / 2;
  let mark;
  if (n.kind === 'integration') {
    const pts = []; for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 5.9 : 13; pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`); }
    mark = `<polygon points="${pts.join(' ')}" fill="${L.stroke}" opacity="0.85"/>`;
  } else if (st.tier === 'sonnet') mark = `<ellipse cx="${cx}" cy="${cy}" rx="18" ry="9" fill="none" stroke="${L.stroke}" stroke-width="2.2"/>`;
  else mark = `<path d="M${x} ${y}L${x + w} ${y + h}M${x + w} ${y}L${x} ${y + h}" stroke="${L.stroke}" stroke-width="1.8"/>`;
  const pulse = LIVE.has(st.state) ? `<rect x="${x - 4}" y="${y - 4}" width="${w + 8}" height="${h + 8}" rx="3" fill="none" stroke="${MAPC.blue}" stroke-width="2" class="pulse"/>` : '';
  const dead = st.state === 'failed' ? `<path d="M${x - 6} ${y - 6}L${x + w + 6} ${y + h + 6}M${x + w + 6} ${y - 6}L${x - 6} ${y + h + 6}" stroke="${MAPC.red}" stroke-width="4" stroke-linecap="round"/>` : '';
  const flag = st.state === 'pass' ? `<path d="M${x + w - 2} ${y - 16}v16M${x + w - 2} ${y - 16}h13l-4 4 4 4h-13" fill="${MAPC.green}" stroke="${MAPC.green}" stroke-width="1.5"/>` : '';
  const cas = st.deaths ? `<text x="${x}" y="${y - 6}" font-size="10" fill="${MAPC.red}">${'✝'.repeat(Math.min(st.deaths, 3))}</text>` : '';
  const tip = `${n.id} — ${n.title}\n${st.tier.toUpperCase()} · ${L.word}${st.rounds ? ` · ${st.rounds} fix round(s)` : ''}${st.deaths ? ` · ${st.deaths} died` : ''}`;
  return `<g><title>${xesc(tip)}</title>${pulse}<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${L.fill}" stroke="${L.stroke}" stroke-width="2.4"${st.state === 'pending' ? ' stroke-dasharray="5 3"' : ''}/>${mark}${dead}${flag}${cas}
<text x="${cx}" y="${y + h + 15}" text-anchor="middle" font-size="12" font-weight="700" fill="${MAPC.ink}">${xesc(xcut(n.id.toUpperCase(), 16))}</text>
<text x="${cx}" y="${y + h + 28}" text-anchor="middle" font-size="9.5" letter-spacing="0.6" fill="${L.stroke}">${xesc(L.word)}</text></g>`;
}
function mapSvg(s) {
  const COL = 190, ROW = 92, PADX = 46, TOP = 88, BOTTOM = 64;
  const rows = Math.max(1, ...waves.map((w) => w.length)), W = PADX * 2 + Math.max(1, waves.length) * COL, H = TOP + rows * ROW + BOTTOM;
  const pos = new Map();
  waves.forEach((w, c) => { const y0 = TOP + (rows * ROW - w.length * ROW) / 2; w.forEach((n, r) => pos.set(n.id, { x: PADX + c * COL + (COL - 58) / 2, y: y0 + r * ROW + 10 })); });
  const P = [`<rect width="${W}" height="${H}" fill="${MAPC.paper}"/>`];
  for (let gx = 0; gx < W; gx += 40) P.push(`<path d="M${gx} 0V${H}" stroke="${MAPC.grid}" stroke-width="0.6"/>`);
  for (let gy = 0; gy < H; gy += 40) P.push(`<path d="M0 ${gy}H${W}" stroke="${MAPC.grid}" stroke-width="0.6"/>`);
  P.push(`<path d="M0 ${H * 0.72} C ${W * 0.25} ${H * 0.6}, ${W * 0.5} ${H * 0.9}, ${W} ${H * 0.68}" fill="none" stroke="${MAPC.paperDark}" stroke-width="10" opacity="0.7"/>`);
  waves.forEach((_, c) => { const x = PADX + c * COL; P.push(`<path d="M${x} ${TOP - 18}V${TOP + rows * ROW}" stroke="${MAPC.faint}" stroke-width="1.2" stroke-dasharray="7 5"/><text x="${x + 6}" y="${TOP - 24}" font-size="10" letter-spacing="1.2" fill="${MAPC.faint}">PL ${PHASE[c] ?? c + 1}</text>`); });
  let taken = -1; for (let c = 0; c < waves.length; c++) { if (waves[c].length && waves[c].every((n) => s[n.id].state === 'pass')) taken = c; else break; }
  if (taken >= 0) { const fx = PADX + (taken + 1) * COL - 8; let d = `M${fx} ${TOP - 10}`; for (let y = TOP - 10; y < TOP + rows * ROW; y += 16) d += ` q ${y % 32 ? 7 : -7} 8 0 16`;
    P.push(`<path d="${d}" fill="none" stroke="${MAPC.red}" stroke-width="3"/><text x="${fx + 6}" y="${TOP + rows * ROW + 14}" font-size="10" font-weight="700" fill="${MAPC.red}">FLOT</text>`); }
  for (const n of nodes) { const b = pos.get(n.id); for (const dId of n.deps) { const a = pos.get(dId); if (!a || !b) continue;
    const x1 = a.x + 62, y1 = a.y + 19, x2 = b.x - 10, y2 = b.y + 19, mx = (x1 + x2) / 2, st = s[n.id].state, live = LIVE.has(st);
    const col = st === 'pass' ? MAPC.green : st === 'failed' || st === 'blocked' ? MAPC.red : live ? MAPC.blue : MAPC.grey;
    P.push(`<path d="M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" fill="none" stroke="${col}" stroke-width="7" stroke-linecap="round" opacity="0.28"/><path d="M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" fill="none" stroke="${col}" stroke-width="2.2"${live ? ' stroke-dasharray="9 6" class="march"' : ''}/><path d="M${x2 + 9} ${y2} l -13 -7 v 14 z" fill="${col}"/>`); } }
  for (const n of nodes) { const p = pos.get(n.id); P.push(unitSvg(n, s[n.id], p.x, p.y)); }
  const c = costs(), pass = nodes.filter((n) => s[n.id].state === 'pass').length, deaths = nodes.reduce((a, n) => a + (s[n.id].deaths || 0), 0);
  const lost = nodes.filter((n) => s[n.id].state === 'failed').length, armor = nodes.filter((n) => s[n.id].tier === 'sonnet').length;
  const word = { running: 'OFFENSIVE IN PROGRESS', done: 'ALL OBJECTIVES TAKEN', 'needs-commander': 'HALTED — ORDERS NEEDED', 'runner-died': 'COMMS LOST', idle: 'PLANNING' }[s._run.state] ?? s._run.state.toUpperCase();
  P.push(`<rect x="0" y="0" width="${W}" height="44" fill="${MAPC.ink}"/><text x="16" y="28" font-size="17" font-weight="800" letter-spacing="2" fill="${MAPC.paper}" font-family="Impact,'Arial Narrow',system-ui,sans-serif">OPERATION ${xesc(xcut((plan.title || 'ZHUKOV').toUpperCase(), 40))}</text><text x="${W - 16}" y="28" text-anchor="end" font-size="11" letter-spacing="1.4" fill="${s._run.state === 'done' ? '#9fd8a8' : s._run.state === 'running' ? '#a9c4ef' : '#f0b8a8'}">${xesc(word)}</text>`);
  P.push(`<text x="16" y="${H - 34}" font-size="11" fill="${MAPC.ink}">OBJECTIVES ${pass}/${nodes.length}  ·  ARMOR ${armor}  ·  CASUALTIES ${deaths}${lost ? `  ·  UNITS LOST ${lost}` : ''}  ·  SUPPLY $${c.total.toFixed(3)}</text><text x="16" y="${H - 14}" font-size="10" fill="${MAPC.faint}">☒ INFANTRY = HAIKU   ⬭ ARMOR = SONNET   ★ OBJECTIVE   ✝ CASUALTY   — FLOT = FRONT LINE</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="ui-monospace,Menlo,monospace" role="img" aria-label="Battle map: ${pass} of ${nodes.length} objectives taken">${P.join('')}</svg>`;
}
function draw(quiet) {
  const s = S || load();
  const evs = existsSync(P('events.log')) ? readFileSync(P('events.log'), 'utf8').trim().split('\n').filter(Boolean).slice(-10) : [];
  const html = `<title>Operation ${xesc(xcut(plan.title || 'Zhukov', 40))}</title>
<style>
:root{--bg:#1b1c18;--fg:#e8e0c4;--mut:#a39b80;--line:#3a3a32}
body{margin:0;background:var(--bg);color:var(--fg);font:13px ui-monospace,Menlo,monospace}
.wrap{padding-inline:16px;padding-block:16px 24px;max-width:1400px;margin:0 auto;display:grid;gap:12px}
.map{overflow-x:auto;border:1px solid var(--line);border-radius:6px;width:fit-content;max-width:100%}
.map svg{display:block}
.pulse{animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.15}}
.march{animation:m .9s linear infinite}@keyframes m{to{stroke-dashoffset:-30}}
@media (prefers-reduced-motion:reduce){.pulse,.march{animation:none}}
h2{font-size:11px;letter-spacing:.14em;color:var(--mut);margin:0;font-weight:600}
pre{margin:0;white-space:pre-wrap;color:var(--mut);line-height:1.6;min-width:0}
</style>
<div class="wrap">
<div class="map">${mapSvg(s)}</div>
<h2>HQ DISPATCHES</h2>
<pre>${xesc(evs.join('\n')) || 'No dispatches yet.'}</pre>
</div>`;
  writeFileSync(P('graph.html'), html);
  if (!quiet) console.log(`wrote ${P('graph.html')} — publish it as an artifact (same file path every time keeps one URL)`);
}

// ======================= commands =======================
for (const d of ['receipts', 'verdicts', 'logs']) mkdirSync(P(d), { recursive: true });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
if (cmd === 'check') preview();
else if (cmd === 'draw') { preview(); draw(); }
else if (cmd === 'status') console.log(summary());
else if (cmd === 'run') {
  const cur = load()._run;
  if (cur.state === 'running' && cur.pid && alive(cur.pid) && cur.pid !== process.pid) { console.error(`already running (pid ${cur.pid})`); process.exit(3); }
  await runLoop();
}
else if (cmd === 'wait') {
  const max = +opt('--max', 540) * 1000, t0 = Date.now();
  await new Promise((r) => setTimeout(r, 1500));
  for (;;) {
    S = load();
    const r = S._run;
    if (r.state !== 'running' || (r.pid && !alive(r.pid))) { if (r.state === 'running') { r.state = 'runner-died'; } break; }
    if (Date.now() - t0 > max) break;
    await new Promise((res) => setTimeout(res, 5000));
  }
  console.log(summary() + (S._run.state === 'runner-died' ? '\nRUNNER DIED — relaunch `run` (it recovers from the ledger)' : ''));
}
else if (cmd === 'set') {
  const [id, state] = rest;
  if (!byId.has(id) || !['pending', 'pass', 'failed', 'escalate'].includes(state)) { console.error('set <run> <id> pending|pass|failed|escalate'); process.exit(2); }
  S = load(); const st = S[id];
  if (state === 'escalate') { st.tier = 'sonnet'; st.rounds = 0; st.state = 'pending'; }
  else { st.state = state; if (state === 'pending') { st.rounds = 0; st.deaths = 0; st.checkDeaths = 0; st.flag = ''; } }
  propagate(); save(); console.log(`${id}: ${st.state} (tier ${st.tier})`);
}
else { console.error(`unknown command ${cmd}`); process.exit(2); }
}
