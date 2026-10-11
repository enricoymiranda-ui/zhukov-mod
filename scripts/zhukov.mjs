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
function draw(quiet) {
  const s = S || load();
  const NW = 200, NH = 70, GX = 70, GY = 24, PAD = 24, HEAD = 44;
  const colH = Math.max(...waves.map((w) => w.length));
  const W = PAD * 2 + waves.length * NW + (waves.length - 1) * GX, H = HEAD + PAD * 2 + colH * NH + (colH - 1) * GY;
  const pos = new Map();
  waves.forEach((w, c) => { const ch = w.length * NH + (w.length - 1) * GY, y0 = HEAD + PAD + (colH * NH + (colH - 1) * GY - ch) / 2; w.forEach((n, r) => pos.set(n.id, { x: PAD + c * (NW + GX), y: y0 + r * (NH + GY) })); });
  const esc = (x) => String(x).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const tr = (x, k) => (x.length > k ? x.slice(0, k - 1) + '…' : x);
  let edges = '', boxes = '', heads = '';
  for (const n of nodes) for (const d of n.deps) { const a = pos.get(d), b = pos.get(n.id), x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2, mx = (x1 + x2) / 2; edges += `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 6},${y2}" class="edge" marker-end="url(#arr)"/>`; }
  for (const n of nodes) {
    const p = pos.get(n.id), st = s[n.id], tier = st.tier;
    boxes += `<g class="node s-${st.state} ${n.kind === 'integration' ? 'integ' : ''}" transform="translate(${p.x},${p.y})"><rect width="${NW}" height="${NH}" rx="8"/><rect class="tier t-${tier}" x="${NW - 62}" y="8" width="54" height="16" rx="8"/><text x="${NW - 35}" y="20" class="tt" text-anchor="middle">${tier}</text><text x="12" y="22" class="t">${esc(tr(n.title, 18))}</text><text x="12" y="41" class="id">${esc(n.id)}${n.loadBearing ? ' · load-bearing' : ''}</text><text x="12" y="59" class="st">${esc(st.state)}${st.rounds ? ` · ${st.rounds} fix` : ''}${st.deaths ? ` · ${st.deaths} died` : ''}</text></g>`;
  }
  waves.forEach((w, c) => { heads += `<text x="${PAD + c * (NW + GX) + NW / 2}" y="${HEAD - 8}" class="wave" text-anchor="middle">wave ${c + 1} · ${w.length} parallel</text>`; });
  const c = costs(), done = nodes.filter((n) => s[n.id].state === 'pass').length;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Zhukov Battle Plan</title><style>
:root{--bg:#f7f6f2;--fg:#1d1f1c;--mut:#6b6f69;--card:#fff;--line:#c8ccc5;--pend:#9a9e98;--run:#2f6fd0;--pass:#2a8a55;--fail:#c43d3d;--blk:#b8860b;--hk:#3b7a57;--sn:#7a4bc4}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#131512;--fg:#e8ebe6;--mut:#8d928b;--card:#1c1f1b;--line:#3b403a;--pend:#7b8079;--run:#6aa0ff;--pass:#4fbf7f;--fail:#ff7b7b;--blk:#e0b44a;--hk:#5fae82;--sn:#b38cf2}}
:root[data-theme=dark]{--bg:#131512;--fg:#e8ebe6;--mut:#8d928b;--card:#1c1f1b;--line:#3b403a;--pend:#7b8079;--run:#6aa0ff;--pass:#4fbf7f;--fail:#ff7b7b;--blk:#e0b44a;--hk:#5fae82;--sn:#b38cf2}
body{margin:0;background:var(--bg);color:var(--fg);font:14px system-ui,sans-serif}.wrap{padding:16px}h1{font-size:18px;margin:0 0 4px}.sub{color:var(--mut);margin:0 0 12px}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--card)}.edge{fill:none;stroke:var(--line);stroke-width:1.6}
.node>rect:first-child{fill:var(--card);stroke:var(--pend);stroke-width:2}.t{fill:var(--fg);font-weight:600;font-size:13px}.id{fill:var(--mut);font-size:11px}.st{font-size:11px;fill:var(--pend)}
.tier{stroke:none}.t-haiku{fill:var(--hk)}.t-sonnet{fill:var(--sn)}.tt{fill:#fff;font-size:10px;font-weight:600}
.s-making>rect:first-child,.s-made>rect:first-child,.s-checking>rect:first-child,.s-fixing>rect:first-child{stroke:var(--run)}.s-making .st,.s-made .st,.s-checking .st,.s-fixing .st{fill:var(--run)}
.s-pass>rect:first-child{stroke:var(--pass)}.s-pass .st{fill:var(--pass)}.s-failed>rect:first-child,.s-flagged>rect:first-child{stroke:var(--fail)}.s-failed .st,.s-flagged .st{fill:var(--fail)}
.s-blocked>rect:first-child{stroke:var(--blk)}.s-blocked .st{fill:var(--blk)}.integ>rect:first-child{stroke-dasharray:6 3}.wave{fill:var(--mut);font-size:11px}
.legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:10px;color:var(--mut);font-size:12px}.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}
</style></head><body><div class="wrap"><h1>${esc(plan.title || 'Battle plan')}</h1>
<p class="sub">${nodes.length} soldiers · ${waves.length} waves · ${nodes.filter((n) => s[n.id].tier === 'sonnet').length} on Sonnet · ${done}/${nodes.length} passed · soldiers $${c.total.toFixed(2)} · run ${esc(s._run.state)}</p>
<div class="scroll"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Task graph"><defs><marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--line)"/></marker></defs>${heads}${edges}${boxes}</svg></div>
<div class="legend"><span><i style="background:var(--hk)"></i>haiku</span><span><i style="background:var(--sn)"></i>sonnet</span><span><i style="background:var(--run)"></i>in progress</span><span><i style="background:var(--pass)"></i>passed</span><span><i style="background:var(--fail)"></i>failed / flagged</span><span><i style="background:var(--blk)"></i>blocked</span><span>dashed = integration</span></div></div></body></html>`;
  writeFileSync(P('graph.html'), html);
  if (!quiet) console.log(`wrote ${P('graph.html')}`);
}

// ======================= commands =======================
// ~/.zhukov/active names the run the Zhukov mod shows (pane + status line) and guards.
function markActive() { try { const h = process.env.HOME; if (h) { mkdirSync(join(h, '.zhukov'), { recursive: true }); writeFileSync(join(h, '.zhukov', 'active'), run + '\n'); } } catch {} }
if (['check', 'draw', 'run'].includes(cmd)) markActive();
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
