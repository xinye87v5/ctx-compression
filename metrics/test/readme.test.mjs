/**
 * readme.test.mjs —— 文档与代码一致性（防文档漂移）。
 *
 * README 里的示例输出是**手抄**进去的。手抄的数字会腐烂：
 * 改了夹具、改了阈值，README 还写着旧数，读到的人就会被误导。
 * 所以这里把 README 里那几个关键读数**钉回代码的实际输出**。
 *
 * 这些断言故意做得"笨"：直接查字符串。它的作用不是测代码，是测文档。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { coverage } from '../coverage.mjs';
import { turnFidelity } from '../turnFidelity.mjs';
import { loadEvents, dedupe, originBreakdown } from '../corpus.mjs';
import { extractEntities } from '../entityExtract.mjs';
import { detectDegenerateBatch } from '../degenerate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');
const FIX = join(ROOT, 'fixtures');

function run(...args) {
  const r = spawnSync(process.execPath, [join(ROOT, 'cli.mjs'), ...args], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test('README 声明了输入契约、五个模块与已知边界', () => {
  for (const needle of [
    'events.jsonl', 'checkpoint.txt', 'compact-ranges.json',
    '模块 1 `coverage.mjs`', '模块 2 `turnFidelity.mjs`', '模块 3 `corpus.mjs`',
    '模块 4 `entityExtract.mjs`', '模块 5 `degenerate.mjs`',
    '## 4. 已知边界', '## 5. 最小示例', 'cd metrics && node --test',
  ]) {
    assert.ok(README.includes(needle), `README 缺少：${needle}`);
  }
  assert.match(README, /零第三方依赖|零依赖|只用 Node 标准库/);
});

test('README 必须如实说明 `node --test <目录>` 在 Node 22.23 上不可用', () => {
  // 与其让读者踩一次坑，不如把坑写进文档，并给出可用的等价命令
  assert.ok(README.includes('不要用 `node --test metrics/`'));
  assert.ok(README.includes("node --test 'metrics/**/*.test.mjs'"));
  assert.match(README, /\d+\s*个测试/, 'README 应当写明测试数量');
  assert.ok(README.includes('最小复现'));
});

test('README 写的测试数量 = test/ 下实际的 test() 数量', () => {
  // 断言"文档声称的数"而不是一个写死的数：加一条测试会让这条断言失败，
  // 于是被迫同步 README —— 而修 README 就是修复方式（不会再牵动测试本身）。
  const claimed = Number((README.match(/(\d+)\s*个测试/) ?? [])[1]);
  assert.ok(Number.isFinite(claimed) && claimed > 0, 'README 应当写明"N 个测试"');

  const files = readdirSync(HERE).filter((f) => f.endsWith('.test.mjs'));
  let count = 0;
  for (const f of files) {
    count += (readFileSync(join(HERE, f), 'utf8').match(/^test\(/gm) ?? []).length;
  }
  assert.equal(count, claimed, `test/ 下实际有 ${count} 个 test()，README 写的是 ${claimed} —— 请同步 README`);
  assert.ok(files.length >= 7, `测试文件数应当 ≥7，实际 ${files.length}`);
});

test('README 不引用任何写死的绝对 home 路径、也不含真实语料痕迹', () => {
  // 注意：这里的正则是一个**探测器**（用来查 README 里有没有绝对路径），
  // 它本身不是一条被引用的路径。
  assert.ok(!/\/home\/[a-z0-9_-]+/i.test(README), 'README 里不得出现 /home/... 这类绝对路径');
  assert.ok(!/\/(root|Users)\//.test(README));
  // 示例一律用相对路径或占位形式
  assert.ok(README.includes('fixtures/events.jsonl'));
  assert.ok(README.includes('/nonexistent-placeholder/'));
});

test('README 的模块 1 示例数字 == 实际输出', () => {
  const out = run('coverage', '--events', 'fixtures/events.jsonl', '--checkpoint', 'fixtures/checkpoint.txt', '--from', '100', '--to', '900');
  for (const line of [
    '摘要文件   fixtures/checkpoint.txt（归一化后 581 字符）',
    '单位       用户发言 10 条',
    '严格档（阈值 30）  命中 4/6 = 66.7%   被剔除（长度不足） 4/10 条',
    '宽松档（阈值 12）  命中 6/7 = 85.7%   被剔除（长度不足） 3/10 条',
    'meanLcsRatio（严格档分母上）  0.7727   最大 1.0000',
    '支配度 topShare  0.5133（LCS 总量 452 里，seq=160 一条占 232，即 51.3%；len=256）',
  ]) {
    assert.ok(out.includes(line), `CLI 实际输出与预期不符：${line}`);
    assert.ok(README.includes(line), `README 与 CLI 实际输出不一致：${line}`);
  }
});

test('README 的模块 2 示例数字 == 实际输出', () => {
  const out = run('referent', '--events', 'fixtures/events.jsonl', '--checkpoint', 'fixtures/checkpoint.txt', '--from', '100', '--to', '900');
  for (const line of [
    '发言单元   9 条（空发言剔除 1 条）',
    'DEP 回指型（≤12 字）           2      0/2 0.0%     1/2 50.0%     0     0.352',
    'SELF 自足型（≥20 字）          6    6/6 100.0%      0/5 0.0%     1     0.000',
  ]) {
    assert.ok(out.includes(line), `CLI 实际输出与预期不符：${line}`);
    assert.ok(README.includes(line), `README 与 CLI 实际输出不一致：${line}`);
  }
  assert.ok(README.includes('代理指标'));
});

test('README 的模块 3 示例数字 == 实际输出', () => {
  const out = run('corpus', '--events', 'fixtures/events-forked.jsonl', '--meta', 'fixtures/sessions.json');
  for (const line of [
    '事件文件   fixtures/events-forked.jsonl（18 行，解析 18 条）',
    '去重后     事件 10/18 条（丢弃副本 8 条）',
    '  去重后  保留 6/10 = 60.0%',
    '  未去重  保留 6/18 = 33.3%',
    '  按来源  user 6 · fork 1 · subagent 3',
  ]) {
    assert.ok(out.includes(line), `CLI 实际输出与预期不符：${line}`);
    assert.ok(README.includes(line), `README 与 CLI 实际输出不一致：${line}`);
  }
});

test('README 的模块 4 示例数字 == 实际输出', () => {
  const out = run('entities', '--text', 'fixtures/report.txt', '--rejected');
  for (const line of [
    'url     3 条',
    'path    4 条',
    'ver     5 条',
    'num     3 条',
    'quote   1 条',
    '被拒候选 7 条（判据自查用）',
    '  12.5/88/3x  →  相对路径：段形不合格（含纯数字段或非法字符）',
  ]) {
    assert.ok(out.includes(line), `CLI 实际输出与预期不符：${line}`);
    assert.ok(README.includes(line), `README 与 CLI 实际输出不一致：${line}`);
  }
});

test('README 的模块 5 示例数字 == 实际输出', () => {
  const out = run('degenerate', '--ranges', 'fixtures/compact-ranges.json');
  for (const line of [
    '退化事务   1/2 = 50.0%',
    '按标记     INFLATED 1 · TINY-SPAN 1 · SMALL-SPAN 1',
  ]) {
    assert.ok(out.includes(line), `CLI 实际输出与预期不符：${line}`);
    assert.ok(README.includes(line), `README 与 CLI 实际输出不一致：${line}`);
  }
});

test('README 引用的关键读数与模块 API 直接调用一致（不依赖 CLI 排版）', () => {
  const ck = readFileSync(join(FIX, 'checkpoint.txt'), 'utf8');
  const ev = loadEvents(readFileSync(join(FIX, 'events.jsonl'), 'utf8'));
  const win = ev.filter((e) => e.kind === 'user' && e.seq >= 100 && e.seq <= 900);
  const c = coverage(win, ck, { threshold: 30, looseThreshold: 12 });
  assert.equal(`${c.hits}/${c.denominator}`, '4/6');
  assert.equal(`${c.loose.hits}/${c.loose.denominator}`, '6/7');
  assert.equal(c.checkpointLength, 581);

  const t = turnFidelity(ev, ck, { from: 100, to: 900 });
  assert.equal(t.totalUnits, 9);
  assert.equal(`${t.DEP.linked}/${t.DEP.linkJudged}`, '1/2');
  assert.equal(t.proxy, true);

  const fk = loadEvents(readFileSync(join(FIX, 'events-forked.jsonl'), 'utf8'));
  const d = dedupe(fk);
  const meta = JSON.parse(readFileSync(join(FIX, 'sessions.json'), 'utf8'));
  const b = originBreakdown(d.events, ['user'], meta);
  assert.equal(`${d.events.length}/${d.totalInput}`, '10/18');
  assert.equal(`${b.kept}/${b.total}`, '6/10');

  const ents = extractEntities(readFileSync(join(FIX, 'report.txt'), 'utf8'));
  assert.equal(ents.url.length, 3);
  assert.equal(ents.path.length, 4);

  const deg = detectDegenerateBatch(JSON.parse(readFileSync(join(FIX, 'compact-ranges.json'), 'utf8')));
  assert.equal(`${deg.degenerate}/${deg.total}`, '1/2');
});

test('README 承诺的反证确实存在（四个测试文件里都能找到）', () => {
  const t = (f) => readFileSync(join(HERE, f), 'utf8');
  assert.ok(t('coverage.test.mjs').includes('反证：关掉"短发言剔除"'));
  assert.ok(t('turnFidelity.test.mjs').includes('反证：把锚从"末 2000 字符"改回"整条消息"'));
  assert.ok(t('corpus.test.mjs').includes('反证：不去重时'));
  assert.ok(t('corpus.test.mjs').includes('反证：去重救不了来源混淆'));
  assert.ok(t('degenerate.test.mjs').includes('反证：把判据的门槛调成"永不触发"'));
});
