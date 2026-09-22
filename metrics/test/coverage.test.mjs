/**
 * coverage.test.mjs —— 模块 1 的测试。
 *
 * 含**反证**：把"剔除短发言"这道闸门关掉，覆盖率会明显变化（见最后一个 test）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  lcs, lcsBound, normalize, charLength, coverage,
  DEFAULT_THRESHOLD, DEFAULT_LOOSE_THRESHOLD,
} from '../coverage.mjs';
import { loadEvents } from '../corpus.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const CK = readFileSync(join(FIX, 'checkpoint.txt'), 'utf8');
const EVENTS = loadEvents(readFileSync(join(FIX, 'events.jsonl'), 'utf8'));

test('normalize：去首尾空白、连续空白折成一个空格（含全角空格与制表）', () => {
  assert.equal(normalize('  a  b\t\tc\n\nd  '), 'a b c d');
  assert.equal(normalize('　全角　空格　'), '全角 空格');
  assert.equal(normalize(''), '');
  assert.equal(normalize(null), '');
  assert.equal(normalize(undefined), '');
  assert.equal(normalize(42), '42');
});

test('charLength：按 Unicode 码点计，emoji 算 1 不算 2', () => {
  assert.equal(charLength('汉字'), 2);
  assert.equal(charLength('😀'), 1);
  assert.equal('😀'.length, 2, '前置条件：UTF-16 码元确实是 2');
  assert.equal(charLength('a😀b'), 3);
});

test('lcs：相同 / 不相交 / 空 / 顺序敏感', () => {
  assert.equal(lcs('abc', 'abc'), 3);
  assert.equal(lcs('abc', 'xyz'), 0);
  assert.equal(lcs('', 'abc'), 0);
  assert.equal(lcs('abc', ''), 0);
  assert.equal(lcs('ab', 'ba'), 1, 'LCS 是子序列，不是子串：顺序必须保持');
  assert.equal(lcs('ace', 'abcde'), 3);
});

test('lcs：经典用例与教科书答案一致', () => {
  // CLRS 的经典例子：LCS(ABCBDAB, BDCABA) = 4（BCBA / BCAB / BDAB）
  assert.equal(lcs('ABCBDAB', 'BDCABA'), 4);
  // 另一组（LCS = 4：GTAB）
  assert.equal(lcs('AGGTAB', 'GXTXAYB'), 4);
});

test('lcs：对称、自反、且不超过较短一侧的码点数', () => {
  const pairs = [
    ['nightly-reconcile', 'reconcile the nightly job'],
    ['汉字测试', '测试汉字的顺序'],
    ['a😀b😀c', '😀b😀'],
  ];
  for (const [a, b] of pairs) {
    assert.equal(lcs(a, b), lcs(b, a), `对称性：${a} / ${b}`);
    assert.ok(lcs(a, b) <= Math.min(charLength(a), charLength(b)), '不超过较短一侧');
  }
  assert.equal(lcs('a😀b', 'a😀b'), charLength('a😀b'), '自反：x 与 x 的 LCS 就是它的码点数');
});

test('lcsBound：必须是上界（且可能严格大于真值）', () => {
  const pairs = [
    ['ABCBDAB', 'BDCABA'],
    ['ab', 'ba'],
    ['nightly-reconcile', 'reconcile nightly'],
  ];
  for (const [a, b] of pairs) {
    const bound = lcsBound(a, b);
    assert.ok(bound >= lcs(a, b), `上界被违反：${a} / ${b}`);
  }
  // 上界不是估计值：'ab' vs 'ba' 的界是 2，真值是 1
  assert.equal(lcsBound('ab', 'ba'), 2);
  assert.equal(lcs('ab', 'ba'), 1);
});

test('coverage：分母只收 ≥ 阈值的发言，短发言必须被剔除并计数', () => {
  const ck = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu';
  const longOk = 'alpha beta gamma delta epsilon zeta eta theta';       // 43 字，逐字在摘要里
  const shortOk = 'alpha beta gamma';                                   // 16 字，也逐字在摘要里
  const r = coverage([longOk, shortOk], ck, { threshold: 30, looseThreshold: 12 });

  assert.equal(r.total, 2);
  assert.equal(r.denominator, 1, '只有 43 字那条进严格档分母');
  assert.equal(r.hits, 1);
  assert.equal(r.rate, 1);
  assert.equal(r.excluded, 1);
  // 短的那条在宽松档里是命中（它确实逐字留存了），但它**不进严格档分母**
  assert.equal(r.loose.denominator, 2);
  assert.equal(r.loose.hits, 2);
  assert.equal(r.loose.excluded, 0);
});

test('coverage：两档之间确实存在"严格 miss / 宽松 hit"的带', () => {
  const ck = '把 nightly-reconcile 的调度从 cron 改成 systemd timer';
  // 与摘要共享 "systemd timer" 与零散字，但远不到 30
  const mid = 'systemd timer 这个选择我想再确认一下，先别动。';
  const r = coverage([mid], ck, { threshold: 30, looseThreshold: 12 });
  const row = r.rows[0];
  assert.ok(row.lcs >= 12 && row.lcs < 30, `预期落在带内，实际 lcs=${row.lcs}`);
  assert.equal(row.hit, false, '严格档：miss');
  assert.equal(r.loose.hits, 1, '宽松档：hit —— 这正是宽松档会高估的地方');
  assert.equal(r.rate, 0);
});

test('coverage：空分母返回 null（不是 0）', () => {
  const r = coverage(['短'], '很长的摘要文本，但这条发言不足阈值', { threshold: 30 });
  assert.equal(r.denominator, 0);
  assert.equal(r.rate, null, '0/0 不是 0.0% —— 是"没有可测单位"');
  assert.equal(r.meanLcsRatio, null);
  assert.equal(r.topShare, null);
});

test('coverage：传事件对象时默认只取 kind=user，且按 window 过滤由调用方负责', () => {
  const rows = EVENTS.filter((e) => e.kind === 'user' && e.seq >= 100 && e.seq <= 900);
  const withAssistant = [...EVENTS]; // 里面混着 assistant / tool / compaction
  const a = coverage(rows, CK, { threshold: 30 });
  const b = coverage(withAssistant, CK, { threshold: 30 });
  assert.equal(a.total, 10);
  assert.equal(b.total, 11, 'assistant/tool/compaction 不得进入用户发言的分母');
  const c = coverage(withAssistant, CK, { threshold: 30, userOnly: false });
  assert.equal(b.total, 11, '夹具里 kind=user 的事件共 11 条（含窗口外那条）');
  assert.equal(c.total, 16, '显式关掉 userOnly 才会全收（16 行全部）');
});

test('coverage：夹具上的预期读数（README 里引用的就是这一组）', () => {
  const rows = EVENTS.filter((e) => e.kind === 'user' && e.seq >= 100 && e.seq <= 900);
  const r = coverage(rows, CK, { threshold: DEFAULT_THRESHOLD, looseThreshold: DEFAULT_LOOSE_THRESHOLD });
  assert.equal(r.total, 10);
  assert.equal(r.denominator, 6);
  assert.equal(r.hits, 4);
  assert.equal(r.rate.toFixed(4), '0.6667');
  assert.equal(r.excluded, 4);
  assert.equal(r.loose.denominator, 7);
  assert.equal(r.loose.hits, 6);
  assert.equal(r.loose.excluded, 3);
  assert.equal(r.meanLcsRatio.toFixed(4), '0.7727');
  assert.equal(r.topShare.toFixed(4), '0.5133', 'seq 160 一条占了 LCS 总量的一半 ⇒ 支配度要报出来');

  // 逐条明细：seq 170 是"严格 miss / 宽松 hit"的带内样本
  const bySeq = new Map(r.rows.map((x) => [x.seq, x]));
  assert.equal(bySeq.get(170).lcs, 29);
  assert.equal(bySeq.get(170).hit, false);
  assert.ok(bySeq.get(170).lcs >= 12, '但它进了宽松档的分母且命中');
  // seq 140 是宽松档的高估样本：语义无关，却因共享字符拿到 lcs=15
  assert.equal(bySeq.get(140).lcs, 15);
  assert.equal(bySeq.get(140).hit, false);
  assert.equal(bySeq.get(150).len, 0, '全空白发言归一化后长度为 0');
});

test('coverage：seq 950 在窗口外，剔除窗口会改变分子与分母（范围过滤的反证）', () => {
  const inWin = EVENTS.filter((e) => e.kind === 'user' && e.seq >= 100 && e.seq <= 900);
  const all = EVENTS.filter((e) => e.kind === 'user');
  const a = coverage(inWin, CK, { threshold: 30 });
  const b = coverage(all, CK, { threshold: 30 });
  assert.equal(`${a.hits}/${a.denominator}`, '4/6');
  assert.equal(`${b.hits}/${b.denominator}`, '5/7', '窗口外那条是逐字命中，必须被范围剔掉');
});

// ──────────────────────────────────────────────────────────────── 反证
test('反证：关掉"短发言剔除"这道闸门，覆盖率会从 100% 掉到 10%', () => {
  const ck = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu';
  const longUnit = 'alpha beta gamma delta epsilon zeta eta theta';
  // 9 条"短且与摘要零重合"的发言。用希腊字母，确保 lcs 真的是 0（而不是碰巧蒙到）。
  const shorts = ['αα', 'ββ', 'γγ', 'δδ', 'εε', 'ζζ', 'ηη', 'θθ', 'ιι'];
  const units = [longUnit, ...shorts];

  for (const s of shorts) assert.equal(lcs(s, ck), 0, `前置条件被破坏：${s} 与摘要竟然有公共子序列`);

  // 正确口径：短发言不进分母
  const gated = coverage(units, ck, { threshold: 30 });
  assert.equal(`${gated.hits}/${gated.denominator}`, '1/1');
  assert.equal(gated.rate, 1);
  assert.equal(gated.excluded, 9);

  // 关掉闸门（阈值降到 1 ⇒ 长度≥1 的发言全进分母）
  const ungated = coverage(units, ck, { threshold: 1 });
  assert.equal(`${ungated.hits}/${ungated.denominator}`, '1/10');
  assert.equal(ungated.rate, 0.1);

  // 同一批数据、同一个压缩结果，读数从 100% 变成 10% —— 差别全部来自分母口径
  assert.notEqual(gated.rate, ungated.rate);
  assert.ok(gated.rate - ungated.rate > 0.5, '差异必须显著，否则这条反证没有说服力');
});
