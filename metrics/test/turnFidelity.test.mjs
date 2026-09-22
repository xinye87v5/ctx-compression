/**
 * turnFidelity.test.mjs —— 模块 2 的测试。
 *
 * 含**反证**：把锚长度改回"整条 assistant 消息"，所指有痕的判定会翻转 ——
 * 证明这条代理指标对 `anchorChars` 是敏感的（所以它是代理，不是事实）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  grams, tail, referentLink, turnFidelity,
  DEP_MAX_LEN, SELF_MIN_LEN, SELF_LCS,
} from '../turnFidelity.mjs';
import { loadEvents } from '../corpus.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const CK = readFileSync(join(FIX, 'checkpoint.txt'), 'utf8');
const EVENTS = loadEvents(readFileSync(join(FIX, 'events.jsonl'), 'utf8'));

test('grams：滑窗取集合，短于 n 时返回空集', () => {
  assert.deepEqual([...grams('abcdef', 3)].sort(), ['abc', 'bcd', 'cde', 'def']);
  assert.equal(grams('abcdef', 3).size, 4);
  assert.equal(grams('abc', 3).size, 1);
  assert.equal(grams('ab', 3).size, 0, '不足 n 个字构不出 gram，不能把整段当成一个 gram');
  assert.equal(grams('', 3).size, 0);
  assert.equal(grams('aaaa', 2).size, 1, '是集合：重复 gram 只算一次');
  assert.equal(grams('汉字测试串', 2).size, 4);
  assert.equal(grams('😀😀😀', 2).size, 1, '按码点切，emoji 不会被劈成两半');
});

test('tail：取末 k 个码点', () => {
  assert.equal(tail('abcdef', 3), 'def');
  assert.equal(tail('abc', 10), 'abc');
  assert.equal(tail('', 3), '');
});

test('referentLink：命中率的算术（n=2 便于手算）', () => {
  // 锚 'abcd' 的 2-gram = {ab, bc, cd}（3 个）；摘要里只有 'ab' ⇒ 命中 1/3
  const r = referentLink('随便一条发言', 'abcd', 'ab', { n: 2, minRate: 0.1 });
  assert.equal(r.judged, true);
  assert.equal(r.gramCount, 3);
  assert.equal(r.hitCount, 1);
  assert.ok(Math.abs(r.rate - 1 / 3) < 1e-12);
  assert.equal(r.linked, true, '1/3 ≥ 0.10');

  // 完全不相交 ⇒ 0
  const z = referentLink('随便一条发言', 'abcd', 'zzzz', { n: 2 });
  assert.equal(z.hitCount, 0);
  assert.equal(z.rate, 0);
  assert.equal(z.linked, false);

  // 锚与摘要相同 ⇒ 1.0
  const f = referentLink('随便一条发言', 'abcd', 'abcd', { n: 2 });
  assert.equal(f.rate, 1);
});

test('referentLink：门槛就在 0.10 上（≥ 记有痕）', () => {
  // 10 个 gram 命中 1 个 = 0.10 ⇒ 记有痕
  const anchor = 'abcdefghijkl';           // 11 个 2-gram? 见下
  const g = grams(anchor, 2);
  assert.equal(g.size, 11);
  const one = [...g][0];
  const hit1 = referentLink('x', anchor, one, { n: 2, minRate: 0.10 });
  assert.ok(Math.abs(hit1.rate - 1 / 11) < 1e-12);
  assert.equal(hit1.linked, false, '1/11 = 0.0909 < 0.10 ⇒ 没痕迹');

  const hit2 = referentLink('x', anchor, [...g].slice(0, 2).join(' '), { n: 2, minRate: 0.10 });
  assert.ok(hit2.rate >= 0.10);
  assert.equal(hit2.linked, true);
});

test('referentLink：三种"不判"的情形都必须显式给出理由', () => {
  const empty = referentLink('   ', 'abcd', 'abcd', { n: 2 });
  assert.equal(empty.judged, false);
  assert.equal(empty.reason, 'empty-utterance');
  assert.equal(empty.linked, null, '不判就是 null，不能默认成 false');

  const noPrev = referentLink('那就这样吧', null, 'abcd', { n: 2 });
  assert.equal(noPrev.judged, false);
  assert.equal(noPrev.reason, 'no-previous-assistant');
  assert.equal(noPrev.linked, null);

  const shortAnchor = referentLink('那就这样吧', 'abc', 'abc', { n: 12 });
  assert.equal(shortAnchor.judged, false);
  assert.equal(shortAnchor.reason, 'anchor-shorter-than-n');
});

test('referentLink：输出必须自带"我是代理指标"的标注', () => {
  const r = referentLink('x', 'abcd', 'abcd', { n: 2 });
  assert.equal(r.proxy, true);
  assert.equal(r.n, 2);
  assert.equal(r.minRate, 0.1);
  assert.equal(r.anchorChars, 2000);
});

test('turnFidelity：DEP / MID / SELF 的分界按长度严格切', () => {
  const ck = '字'.repeat(40);
  const mk = (len) => '字'.repeat(len);
  const events = [
    { session: 's', seq: 1, kind: 'assistant', text: ck },
    { session: 's', seq: 2, kind: 'user', text: mk(DEP_MAX_LEN) },        // 12 ⇒ DEP
    { session: 's', seq: 3, kind: 'user', text: mk(DEP_MAX_LEN + 1) },    // 13 ⇒ MID
    { session: 's', seq: 4, kind: 'user', text: mk(SELF_MIN_LEN - 1) },   // 19 ⇒ MID
    { session: 's', seq: 5, kind: 'user', text: mk(SELF_MIN_LEN) },       // 20 ⇒ SELF
  ];
  const r = turnFidelity(events, ck);
  assert.equal(r.DEP.total, 1);
  assert.equal(r.MID.total, 2);
  assert.equal(r.SELF.total, 1);
  assert.equal(r.MID.decided, false, 'MID 只报告不判定');
  assert.equal(r.DEP.decided, true);
  assert.equal(r.DEP.primary, 'link');
  assert.equal(r.SELF.primary, 'selfSurvived');
  assert.equal(r.boundary.depMaxLen, 12);
  assert.equal(r.boundary.selfMinLen, 20);
  assert.equal(r.boundary.selfLcs, 8);
});

test('turnFidelity：自身存活 = LCS ≥ 8', () => {
  const ck = '这是一段被保留下来的摘要内容，长度足够做 LCS 判据。';
  const events = [
    { session: 's', seq: 1, kind: 'user', text: '这是一段被保留下来的摘要内容，长度足够做判据。' },
    { session: 's', seq: 2, kind: 'user', text: '完全不相干的一句话，一个字都不重合的另一种说法。' },
  ];
  const r = turnFidelity(events, ck);
  const rows = r.DEP.total ? [] : [];
  assert.equal(rows.length, 0);
  assert.equal(r.SELF.total, 2);
  assert.equal(r.SELF.selfSurvived, 1, '第一条 LCS ≥8 存活；第二条不相干');
  assert.equal(r.SELF.selfRate, 0.5);
});

test('turnFidelity：空发言被剔除并计数（不许进分母）', () => {
  const events = [
    { session: 's', seq: 1, kind: 'assistant', text: 'AI 说了一句话' },
    { session: 's', seq: 2, kind: 'user', text: '   \t\n  ' },
    { session: 's', seq: 3, kind: 'user', text: '好' },
  ];
  const r = turnFidelity(events, 'AI 说了一句话');
  assert.equal(r.skippedEmpty, 1);
  assert.equal(r.totalUnits, 1, '空发言不进任何一组');
  assert.equal(r.DEP.total, 1, '只剩"好"这一条');
});

test('turnFidelity：锚取"上一条 assistant"，且能越过窗口左边界', () => {
  const anchorText = 'anchor-sentence-abcdefghij';
  const events = [
    { session: 's', seq: 10, kind: 'assistant', text: anchorText },
    { session: 's', seq: 20, kind: 'user', text: '好' },
  ];
  // 单元从 seq=20 开始（锚在窗口之外），锚仍必须取到 seq=10 那条
  const r = turnFidelity(events, 'anchor-sentence-abcdefghij', { from: 20, to: 20, n: 6, keepRows: true });
  assert.equal(r.totalUnits, 1);
  assert.equal(r.rows[0].seq, 20);
  assert.equal(r.rows[0].link.judged, true, '锚越过了窗口左边界仍然判定');
  assert.equal(r.rows[0].link.rate, 1, '锚与摘要逐字相同 ⇒ 命中率 1.0');

  // 对照组：如果窗口把 assistant 也一起切掉（from 提到 20 之后仍取全流），这里用 from 过滤后
  // 锚依然存在；把它删掉才是"没有上一条 assistant"。
  const noAnchor = turnFidelity([events[1]], 'anchor-sentence-abcdefghij', { n: 6, keepRows: true });
  assert.equal(noAnchor.rows[0].link.judged, false);
  assert.equal(noAnchor.rows[0].link.reason, 'no-previous-assistant');
});

test('turnFidelity：输出里必须带 proxy 标注（防止下游当成事实引用）', () => {
  const r = turnFidelity(EVENTS, CK, { from: 100, to: 900 });
  assert.equal(r.proxy, true);
  assert.match(r.proxyNote, /代理指标/);
  assert.ok(r.proxyNote.length > 40);
  assert.equal(r.DEP.linkProxy, true);
});

test('turnFidelity：夹具上的预期读数（README 里引用的就是这一组）', () => {
  const r = turnFidelity(EVENTS, CK, { from: 100, to: 900 });
  assert.equal(r.totalUnits, 9);
  assert.equal(r.skippedEmpty, 1, 'seq 150 是全空白');
  assert.equal(r.checkpointLength, 581);

  assert.equal(r.DEP.total, 2);
  assert.equal(r.DEP.selfSurvived, 0, 'DEP 组自身存活恒为 0：不足 8 字达不到 LCS ≥8');
  assert.equal(r.DEP.linkJudged, 2);
  assert.equal(r.DEP.linked, 1, 'seq 110 的锚（A_RICH）与摘要高度重合；seq 120 的锚（A_DRY）完全不重合');
  assert.equal(r.DEP.linkRate, 0.5);
  assert.equal(r.DEP.meanLinkRate.toFixed(4), '0.3521');

  assert.equal(r.SELF.total, 6);
  assert.equal(r.SELF.selfSurvived, 6);
  assert.equal(r.SELF.linkUnjudged, 1, '第一条用户发言之前没有 assistant ⇒ 不判');
  assert.equal(r.MID.total, 1);
});

// ──────────────────────────────────────────────────────────────── 反证
test('反证：把锚从"末 2000 字符"改回"整条消息"，判定会翻转', () => {
  // 锚 = 一长段无关噪声 + 末尾 15 个有效字符；摘要只含那 15 个有效字符。
  // 噪声必须**不重复**：如果用 'A'.repeat(100)，它的 8-gram 会被集合折叠成一个，
  // 反而稀释不动命中率（这是集合口径的一个真实性质，不是 bug）。
  const useful = 'BCDEFGHIJKLMNOP';
  const noise = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore';
  const anchor = noise + useful;
  const ck = useful;

  const windowed = referentLink('这条发言', anchor, ck, { anchorChars: useful.length, n: 8 });
  assert.equal(windowed.rate, 1, '只看末尾那段 ⇒ 全是有效内容，命中率 1.0');
  assert.equal(windowed.linked, true);

  const whole = referentLink('这条发言', anchor, ck, { anchorChars: 2000, n: 8 });
  assert.ok(whole.rate < 0.10, `整条当锚 ⇒ 被噪声稀释到 ${whole.rate}`);
  assert.equal(whole.linked, false, '同一个锚、同一份摘要，判定翻转 ⇒ 印证这是代理指标');

  assert.notEqual(windowed.linked, whole.linked);
});
