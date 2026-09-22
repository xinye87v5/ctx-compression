#!/usr/bin/env node
/**
 * cli.mjs —— 零依赖命令行入口。
 *
 * 用法（路径一律相对当前工作目录）：
 *
 *   node metrics/cli.mjs coverage  --events events.jsonl --checkpoint ck.txt --from 100 --to 900 [--threshold 30]
 *   node metrics/cli.mjs referent  --events events.jsonl --checkpoint ck.txt --from 100 --to 900
 *   node metrics/cli.mjs corpus    --events events.jsonl --meta sessions.json
 *   node metrics/cli.mjs entities  --text report.txt
 *
 * 通用开关：`--json`（机器可读）、`--rows`（逐条明细）、`--help`。
 *
 * **纪律**：输出里**每个数都带分母**。分母为 0 时打印 `n/a` 而不是 `0.0%` ——
 * 空分母没有比率，把 "0/0" 打成 "0.0%" 是最常见的一种读数污染。
 *
 * 退出码：`0` 正常运行（即使分母为 0）；`2` 用法错误或文件读不到。
 * 退化压缩、覆盖率为 0 之类都**不是**错误退出 —— 它们是测量结果，不是失败。
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { coverage, DEFAULT_THRESHOLD, DEFAULT_LOOSE_THRESHOLD } from './coverage.mjs';
import { turnFidelity } from './turnFidelity.mjs';
import { loadEventsDetailed, dedupe, filterByOrigin, originBreakdown, normalizeMeta } from './corpus.mjs';
import { extractEntities, verifyAgainstCorpus } from './entityExtract.mjs';
import { detectDegenerate, detectDegenerateBatch } from './degenerate.mjs';

const USAGE = `用法:
  node metrics/cli.mjs coverage  --events <jsonl> --checkpoint <txt> [--from N] [--to N] [--threshold 30] [--loose 12] [--session S] [--rows] [--json]
  node metrics/cli.mjs referent  --events <jsonl> --checkpoint <txt> [--from N] [--to N] [--session S] [--anchor 2000] [--n 12] [--min-rate 0.10] [--rows] [--json]
  node metrics/cli.mjs corpus    --events <jsonl> [--meta sessions.json] [--origins user] [--strict] [--json]
  node metrics/cli.mjs entities  --text <txt> [--corpus <txt[,txt...]>] [--rejected] [--json]
  node metrics/cli.mjs degenerate --ranges compact-ranges.json [--json]
`;

/** 极简参数解析：支持 `--k v`、`--k=v`、布尔开关。未知参数不报错，但会被忽略。 */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 0) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}

class UsageError extends Error {}

function readText(p, label) {
  if (typeof p !== 'string' || !p) throw new UsageError(`缺少 ${label} 参数`);
  try {
    return readFileSync(p, 'utf8');
  } catch (e) {
    throw new UsageError(`读不到 ${label} 文件：${p}（${e.code ?? e.message}）`);
  }
}

const num = (v) => (v === undefined || v === true ? undefined : Number(v));
const pct = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const frac = (h, d) => `${h}/${d}`;

// 中日韩字符在终端里占**两列**。按码元数补空格会让中文表格整体错位，
// 而这张表是要贴进 README 的 —— 错位的表会被读成"这个工具不严谨"。
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
const w = (s) => { let n = 0; for (const ch of String(s)) n += WIDE.test(ch) ? 2 : 1; return n; };
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - w(s)));
const lpad = (s, n) => ' '.repeat(Math.max(0, n - w(s))) + String(s);

function loadStream(args) {
  const raw = readText(args.events, '--events');
  const ld = loadEventsDetailed(raw);
  return ld;
}

function windowLabel(from, to) {
  if (from === undefined && to === undefined) return '全窗口（未限制 seq 范围）';
  return `seq ∈ [${from ?? '-∞'}, ${to ?? '+∞'}]`;
}

// ─────────────────────────────────────────────────────────── coverage
function cmdCoverage(args) {
  const ck = readText(args.checkpoint, '--checkpoint');
  const ld = loadStream(args);
  const from = num(args.from);
  const to = num(args.to);
  const threshold = num(args.threshold) ?? DEFAULT_THRESHOLD;
  const loose = num(args.loose) ?? DEFAULT_LOOSE_THRESHOLD;

  const units = ld.events.filter((e) =>
    e.kind === 'user'
    && (args.session === undefined || e.session === String(args.session))
    && (from === undefined || (e.seq !== null && e.seq >= from))
    && (to === undefined || (e.seq !== null && e.seq <= to)));

  const r = coverage(units, ck, { threshold, looseThreshold: loose });

  if (args.json) {
    console.log(JSON.stringify({
      window: { from: from ?? null, to: to ?? null, session: args.session ?? null },
      input: { lines: ld.total, skippedLines: ld.skipped, userUnits: units.length },
      strict: { threshold, hits: r.hits, denominator: r.denominator, rate: r.rate, meanLcsRatio: r.meanLcsRatio, excluded: r.excluded, maxLcsRatio: r.maxLcsRatio, topShare: r.topShare },
      loose: r.loose,
      checkpointChars: r.checkpointLength,
      rows: r.rows,
    }, null, 2));
    return 0;
  }

  console.log(`# 逐字覆盖（模块 1）`);
  console.log(`事件文件   ${args.events}（共 ${ld.total} 行，解析 ${ld.events.length} 条${ld.skipped ? `，跳过 ${ld.skipped} 行` : ''}）`);
  console.log(`摘要文件   ${args.checkpoint}（归一化后 ${r.checkpointLength} 字符）`);
  console.log(`窗口       ${windowLabel(from, to)}${args.session !== undefined ? ` · 会话 ${args.session}` : ''}`);
  console.log(`单位       用户发言 ${r.total} 条\n`);

  console.log(`严格档（阈值 ${threshold}）  命中 ${frac(r.hits, r.denominator)} = ${pct(r.rate)}   被剔除（长度不足） ${r.excluded}/${r.total} 条`);
  console.log(`宽松档（阈值 ${loose}）  命中 ${frac(r.loose.hits, r.loose.denominator)} = ${pct(r.loose.rate)}   被剔除（长度不足） ${r.loose.excluded}/${r.total} 条`);
  console.log(`meanLcsRatio（严格档分母上）  ${r.meanLcsRatio === null ? 'n/a' : r.meanLcsRatio.toFixed(4)}   最大 ${r.maxLcsRatio === null ? 'n/a' : r.maxLcsRatio.toFixed(4)}`);
  console.log(`支配度 topShare  ${r.topShare === null ? 'n/a' : r.topShare.toFixed(4)}` +
    (r.top ? `（其中 seq=${r.top.seq} 一条占 ${r.topShare === null ? 'n/a' : pct(r.topShare)} 的 LCS 总量，len=${r.top.len}）` : ''));

  if (args.rows) {
    console.log(`\n${pad('seq', 6)}${lpad('len', 6)}${lpad('lcs', 6)}${lpad('ratio', 8)}  判定  文本`);
    for (const row of r.rows) {
      const tag = row.hit ? 'HIT ' : (row.len >= threshold ? 'miss' : `剔除`);
      console.log(`${pad(row.seq ?? '-', 6)}${lpad(row.len, 6)}${lpad(row.lcs, 6)}${lpad(row.ratio.toFixed(3), 8)}  ${tag}  ${row.text.slice(0, 40).replace(/\n/g, ' ')}`);
    }
  }
  return 0;
}

// ─────────────────────────────────────────────────────────── referent
function cmdReferent(args) {
  const ck = readText(args.checkpoint, '--checkpoint');
  const ld = loadStream(args);
  const from = num(args.from);
  const to = num(args.to);

  const r = turnFidelity(ld.events, ck, {
    from, to,
    session: args.session === undefined ? undefined : String(args.session),
    anchorChars: num(args.anchor) ?? 2000,
    n: num(args.n) ?? 12,
    minRate: num(args['min-rate']) ?? 0.10,
    keepRows: Boolean(args.rows),
  });

  if (args.json) {
    console.log(JSON.stringify({
      window: { from: from ?? null, to: to ?? null, session: args.session ?? null },
      boundary: r.boundary,
      proxy: r.proxy,
      proxyNote: r.proxyNote,
      totalUnits: r.totalUnits,
      skippedEmpty: r.skippedEmpty,
      groups: r.groups,
      checkpointChars: r.checkpointLength,
      rows: r.rows,
    }, null, 2));
    return 0;
  }

  console.log('# 回合级保真（模块 2）');
  console.log(`事件文件   ${args.events}（共 ${ld.total} 行，解析 ${ld.events.length} 条${ld.skipped ? `，跳过 ${ld.skipped} 行` : ''}）`);
  console.log(`摘要文件   ${args.checkpoint}（归一化后 ${r.checkpointLength} 字符）`);
  console.log(`窗口       ${windowLabel(from, to)}`);
  console.log(`发言单元   ${r.totalUnits} 条（空发言剔除 ${r.skippedEmpty} 条）`);
  console.log(`判据       DEP ≤${r.boundary.depMaxLen} 字 · SELF ≥${r.boundary.selfMinLen} 字 · 自身存活 LCS ≥${r.boundary.selfLcs} · 锚 ${r.boundary.anchorChars} 字符 / ${r.boundary.n}-gram / 门槛 ${pct(r.boundary.minRate)}`);
  console.log(`⚠️  referent link 是**代理指标**（见注释与 README「已知边界」），不可当作"所指被保留"的证明。\n`);

  console.log(`${pad('组', 26)}${lpad('单元', 6)}${lpad('自身存活', 14)}${lpad('所指有痕', 14)}${lpad('未判', 6)}${lpad('均命中率', 10)}`);
  for (const g of ['DEP', 'SELF', 'MID']) {
    const x = r[g];
    console.log(
      pad(x.label + (x.decided ? '' : '（只报告）'), 26)
      + lpad(x.total, 6)
      + lpad(`${frac(x.selfSurvived, x.total)} ${pct(x.selfRate)}`, 14)
      + lpad(`${frac(x.linked, x.linkJudged)} ${pct(x.linkRate)}`, 14)
      + lpad(x.linkUnjudged, 6)
      + lpad(x.meanLinkRate === null ? 'n/a' : x.meanLinkRate.toFixed(3), 10),
    );
  }
  console.log('\n主判据：DEP → 所指有痕；SELF → 自身存活；MID → 只报告不判定。');
  console.log('注意：DEP 组的"自身存活"必然接近 0，因为不足 8 字的发言在数学上达不到 LCS ≥8。');

  if (args.rows) {
    console.log(`\n${pad('seq', 6)}${pad('组', 6)}${lpad('len', 6)}${lpad('lcs', 6)}  自身存活  所指有痕   命中率  文本`);
    for (const row of r.rows) {
      console.log(
        pad(row.seq ?? '-', 6) + pad(row.group, 6) + lpad(row.len, 6) + lpad(row.lcs, 6)
        + '  ' + pad(row.selfSurvived ? 'yes' : 'no', 8)
        + '  ' + pad(row.link.judged ? (row.link.linked ? 'yes' : 'no') : `未判(${row.link.reason})`, 9)
        + '  ' + pad(row.link.rate === null ? 'n/a' : row.link.rate.toFixed(3), 7)
        + '  ' + row.text.slice(0, 30),
      );
    }
  }
  return 0;
}

// ─────────────────────────────────────────────────────────── corpus
function cmdCorpus(args) {
  const ld = loadStream(args);
  const meta = args.meta ? JSON.parse(readText(args.meta, '--meta')) : null;
  const origins = String(args.origins ?? 'user').split(',').map((s) => s.trim()).filter(Boolean);
  const strict = Boolean(args.strict);

  const dd = dedupe(ld.events, { strict });
  const filtered = filterByOrigin(dd.events, origins, meta);
  const before = originBreakdown(dd.events, origins, meta);
  const rawBreak = originBreakdown(ld.events, origins, meta);

  if (args.json) {
    console.log(JSON.stringify({
      input: { lines: ld.total, parsed: ld.events.length, skipped: ld.skipped },
      dedupe: {
        mode: strict ? 'strict (kind,time)' : 'loose (kind,time,seq)',
        unique: dd.events.length,
        duplicates: dd.duplicates,
        missingTime: dd.missingTime,
        strictReliable: dd.strictReliable,
      },
      originFilter: { origins, ...before },
      originFilterOnRaw: rawBreak,
      kept: filtered.length,
      sessions: [...new Set(dd.events.map((e) => e.session))],
    }, null, 2));
    return 0;
  }

  console.log('# 语料卫生（模块 3）');
  console.log(`事件文件   ${args.events}（${ld.total} 行，解析 ${ld.events.length} 条${ld.skipped ? `，跳过 ${ld.skipped} 行` : ''}）`);
  console.log(`会话数     ${new Set(ld.events.map((e) => e.session)).size}`);
  console.log(`去重口径   ${strict ? '严格 (kind,time)' : '宽松 (kind,time,seq)'}`);
  console.log(`去重后     事件 ${dd.events.length}/${ld.events.length} 条（丢弃副本 ${dd.duplicates} 条）`);
  const multi = dd.events.filter((e) => e.copies > 1);
  console.log(`多副本事件 ${multi.length}/${dd.events.length} 条` + (multi.length ? `，最多 ${Math.max(...multi.map((e) => e.copies))} 份` : ''));
  if (dd.missingTime) {
    console.log(`⚠️  ${dd.missingTime}/${dd.events.length} 条事件没有 time 字段 ⇒ 严格口径不可信（strictReliable=${dd.strictReliable}）`);
  }

  console.log(`\n来源筛选（保留 ${origins.join(',')}）`);
  console.log(`  去重后  保留 ${frac(before.kept, before.total)} = ${pct(before.total ? before.kept / before.total : null)}`);
  console.log(`  未去重  保留 ${frac(rawBreak.kept, rawBreak.total)} = ${pct(rawBreak.total ? rawBreak.kept / rawBreak.total : null)}`);
  console.log(`  按来源  ${Object.entries(before.byOrigin).map(([k, v]) => `${k} ${v}`).join(' · ') || '（无）'}`);
  console.log(`\n说明：去重救"数重了"，来源筛选救"数了不该数的"（子代理的委派提示词走 user 通道）。`);
  return 0;
}

// ─────────────────────────────────────────────────────────── entities
function cmdEntities(args) {
  const text = readText(args.text, '--text');
  const corpusPaths = args.corpus ? String(args.corpus).split(',').map((s) => s.trim()).filter(Boolean) : [];
  const corpusTexts = corpusPaths.map((p) => readText(p, '--corpus'));
  const ents = extractEntities(text, { corpusTexts: corpusTexts.length ? corpusTexts : undefined, withRejected: true });
  const verify = corpusTexts.length ? verifyAgainstCorpus(ents, corpusTexts) : null;

  if (args.json) {
    console.log(JSON.stringify({
      file: basename(args.text),
      entities: ents,
      ...(corpusPaths.length ? { corpus: corpusPaths, verify } : {}),
    }, null, 2));
    return 0;
  }

  console.log('# 实体抽取（模块 4）');
  console.log(`文本       ${args.text}`);
  console.log(`段频闸门   ${corpusTexts.length ? `已启用（语料 ${corpusPaths.length} 份）` : '未启用（未给 --corpus ⇒ 相对路径不做段频否决）'}\n`);

  for (const [type, list] of [['url', ents.url], ['path', ents.path], ['ver', ents.ver], ['num', ents.num], ['quote', ents.quote]]) {
    console.log(`${pad(type, 7)} ${list.length} 条`);
    for (const x of list) console.log(`        ${x.length > 88 ? `${x.slice(0, 88)}…` : x}`);
    if (verify) {
      const v = verify.byType[type];
      console.log(`        回原文核对 ${frac(v.found, v.total)} = ${pct(v.rate)}`);
    }
  }
  if (verify) {
    console.log(`\n合计     回原文核对 ${frac(verify.found, verify.total)} = ${pct(verify.rate)}`);
  }
  if (args.rejected) {
    console.log(`\n被拒候选 ${ents.rejected.length} 条（判据自查用）`);
    for (const r of ents.rejected) console.log(`  ${r.candidate}  →  ${r.reason}`);
  } else if (ents.rejected.length) {
    console.log(`\n（另有 ${ents.rejected.length} 条候选被拒；加 --rejected 查看）`);
  }
  return 0;
}

// ─────────────────────────────────────────────────────────── degenerate
function cmdDegenerate(args) {
  let txs = [];
  if (args.ranges) {
    txs = JSON.parse(readText(args.ranges, '--ranges'));
    if (!Array.isArray(txs)) throw new UsageError('--ranges 文件必须是数组');
  } else {
    throw new UsageError('degenerate 需要 --ranges <compact-ranges.json>');
  }
  const batch = detectDegenerateBatch(txs);

  if (args.json) {
    console.log(JSON.stringify({
      total: batch.total,
      degenerate: batch.degenerate,
      rate: batch.rate,
      byReason: batch.byReason,
      rows: batch.rows.map((r) => ({ reasons: r.reasons, notJudged: r.notJudged, input: r.details.input })),
    }, null, 2));
    return 0;
  }

  console.log('# 退化压缩探测（模块 5）');
  console.log(`事务文件   ${args.ranges}`);
  console.log(`判据       INFLATED 遮蔽 ≤ 摘要 · TINY-SPAN 遮蔽事件 ≤2 · SMALL-SPAN 遮蔽 token <2000\n`);
  console.log(`退化事务   ${frac(batch.degenerate, batch.total)} = ${pct(batch.rate)}`);
  console.log(`按标记     ${Object.entries(batch.byReason).map(([k, v]) => `${k} ${v}`).join(' · ') || '（无）'}`);
  batch.rows.forEach((r, i) => {
    const src = txs[i] ?? {};
    console.log(`  #${i + 1} session=${src.session ?? '-'} [${src.start ?? '-'}..${src.end ?? '-'}] 遮蔽 ${src.shadowedTokens ?? '-'} token / ${src.events ?? '-'} 事件，摘要 ${src.summaryTokens ?? '-'} token → ${r.reasons.length ? r.reasons.join(',') : '正常'}${r.notJudged.length ? `（未判：${r.notJudged.join(',')}）` : ''}`);
  });
  return 0;
}

// ─────────────────────────────────────────────────────────── main
const COMMANDS = { coverage: cmdCoverage, referent: cmdReferent, corpus: cmdCorpus, entities: cmdEntities, degenerate: cmdDegenerate };

function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (!cmd || args.help || cmd === 'help') {
    process.stdout.write(USAGE);
    return cmd && cmd !== 'help' ? 0 : (cmd ? 0 : 2);
  }
  const fn = COMMANDS[cmd];
  if (!fn) {
    process.stderr.write(`未知子命令：${cmd}\n\n${USAGE}`);
    return 2;
  }
  try {
    return fn(args);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n\n${USAGE}`);
      return 2;
    }
    throw e;
  }
}

process.exit(main(process.argv.slice(2)));
