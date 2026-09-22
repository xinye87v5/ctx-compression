/**
 * degenerate.test.mjs —— 模块 5 的测试。
 *
 * 含**反证**：把某条判据的门槛调成"永不触发"，结果会变 ——
 * 即"关掉功能"后读数确实不同，说明这条判据真的在做判定而不是装饰。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  detectDegenerate, detectDegenerateBatch,
  TINY_SPAN_EVENTS, SMALL_SPAN_TOKENS,
} from '../degenerate.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

test('三条判据的门槛常量必须写死在代码里', () => {
  assert.equal(TINY_SPAN_EVENTS, 2);
  assert.equal(SMALL_SPAN_TOKENS, 2000);
});

test('INFLATED：遮蔽量 ≤ 摘要量（报告比原文还大）', () => {
  const r = detectDegenerate({ shadowedTokens: 5000, summaryTokens: 6000, events: 40 });
  assert.equal(r.degenerate, true);
  assert.deepEqual(r.reasons, ['INFLATED'], '遮蔽量与事件数都在正常范围，只有 INFLATED 命中');
  assert.equal(r.details.checks.INFLATED.hit, true);
});

test('TINY-SPAN：遮蔽事件 ≤ 2', () => {
  const r = detectDegenerate({ shadowedTokens: 50000, summaryTokens: 1200, events: 2 });
  assert.equal(r.degenerate, true);
  assert.deepEqual(r.reasons, ['TINY-SPAN']);
});

test('SMALL-SPAN：遮蔽 token < 2000', () => {
  const r = detectDegenerate({ shadowedTokens: 1999, summaryTokens: 300, events: 40 });
  assert.equal(r.degenerate, true);
  assert.deepEqual(r.reasons, ['SMALL-SPAN']);
});

test('三条判据彼此独立：可以同时命中，且不隐藏任何一条', () => {
  const r = detectDegenerate({ shadowedTokens: 1500, summaryTokens: 2600, events: 2 });
  assert.deepEqual(r.reasons, ['INFLATED', 'TINY-SPAN', 'SMALL-SPAN']);
  assert.equal(r.details.reasonsText.length, 3);
});

test('边界值：≤ 与 < 的差别必须是写死的那一个', () => {
  // INFLATED：≤ ⇒ 相等也算
  assert.equal(detectDegenerate({ shadowedTokens: 1000, summaryTokens: 1000, events: 9 }).reasons.includes('INFLATED'), true);
  // TINY-SPAN：≤2 ⇒ 2 算，3 不算
  assert.equal(detectDegenerate({ shadowedTokens: 9000, summaryTokens: 100, events: 2 }).reasons.includes('TINY-SPAN'), true);
  assert.equal(detectDegenerate({ shadowedTokens: 9000, summaryTokens: 100, events: 3 }).reasons.includes('TINY-SPAN'), false);
  // SMALL-SPAN：<2000 ⇒ 1999 算，2000 不算
  assert.equal(detectDegenerate({ shadowedTokens: 1999, summaryTokens: 100, events: 9 }).reasons.includes('SMALL-SPAN'), true);
  assert.equal(detectDegenerate({ shadowedTokens: 2000, summaryTokens: 100, events: 9 }).reasons.includes('SMALL-SPAN'), false);
});

test('字段缺失 ⇒ 不判（并如实列出未判的判据），而不是当成 0 判成退化', () => {
  const r = detectDegenerate({});
  assert.equal(r.degenerate, false);
  assert.deepEqual(r.reasons, []);
  assert.deepEqual(r.notJudged, ['INFLATED', 'TINY-SPAN', 'SMALL-SPAN']);

  const partial = detectDegenerate({ shadowedTokens: 50000, summaryTokens: null, events: null });
  assert.equal(partial.degenerate, false);
  assert.deepEqual(partial.notJudged, ['INFLATED', 'TINY-SPAN']);
  assert.equal(partial.details.checks['SMALL-SPAN'].hit, false);

  // 0 与"缺失"是两回事：0 是真实的零，缺失是数据问题
  const zeros = detectDegenerate({ shadowedTokens: 0, summaryTokens: 0, events: 0 });
  assert.deepEqual(zeros.reasons, ['TINY-SPAN', 'SMALL-SPAN'], '0 遮蔽量本来就是退化；但 0/0 的 INFLATED 不判');
  assert.deepEqual(zeros.notJudged, ['INFLATED']);
});

test('正常事务不得被判退化', () => {
  const r = detectDegenerate({ shadowedTokens: 48120, summaryTokens: 1490, events: 37 });
  assert.equal(r.degenerate, false);
  assert.deepEqual(r.reasons, []);
  assert.deepEqual(r.notJudged, []);
});

test('batch：退化率必须带分母', () => {
  const b = detectDegenerateBatch([
    { shadowedTokens: 48120, summaryTokens: 1490, events: 37 },
    { shadowedTokens: 1500, summaryTokens: 2600, events: 2 },
    { shadowedTokens: 9000, summaryTokens: 800, events: 12 },
  ]);
  assert.equal(b.total, 3);
  assert.equal(b.degenerate, 1);
  assert.equal(b.rate.toFixed(4), '0.3333');
  assert.deepEqual(b.byReason, { INFLATED: 1, 'TINY-SPAN': 1, 'SMALL-SPAN': 1 });

  const empty = detectDegenerateBatch([]);
  assert.equal(empty.total, 0);
  assert.equal(empty.rate, null, '空分母是 null，不是 0');
});

test('夹具 compact-ranges.json 上的预期读数', () => {
  const txs = JSON.parse(readFileSync(join(FIX, 'compact-ranges.json'), 'utf8'));
  const b = detectDegenerateBatch(txs);
  assert.equal(b.total, 2);
  assert.equal(b.degenerate, 1);
  assert.equal(b.rate, 0.5);
  assert.deepEqual(b.rows[0].reasons, [], '第一条是正常压缩');
  assert.deepEqual(b.rows[1].reasons, ['INFLATED', 'TINY-SPAN', 'SMALL-SPAN']);
});

// ──────────────────────────────────────────────────────────────── 反证
test('反证：把判据的门槛调成"永不触发"，结果会变', () => {
  const tx = { shadowedTokens: 1500, summaryTokens: 2600, events: 2 };

  const on = detectDegenerate(tx);
  assert.deepEqual(on.reasons, ['INFLATED', 'TINY-SPAN', 'SMALL-SPAN']);
  assert.equal(on.degenerate, true);

  // 关掉 TINY-SPAN（门槛 0 ⇒ 事件数 ≤0 才触发）
  const noTiny = detectDegenerate(tx, { tinySpanEvents: 0 });
  assert.deepEqual(noTiny.reasons, ['INFLATED', 'SMALL-SPAN']);
  assert.notDeepEqual(noTiny.reasons, on.reasons);

  // 关掉 SMALL-SPAN（门槛 0 ⇒ 遮蔽 <0 才触发）
  const noSmall = detectDegenerate(tx, { smallSpanTokens: 0 });
  assert.deepEqual(noSmall.reasons, ['INFLATED', 'TINY-SPAN']);

  // 三条全关 ⇒ 不再判退化（同一份数据，结论翻转）
  const allOff = detectDegenerate(tx, { tinySpanEvents: 0, smallSpanTokens: 0 });
  assert.deepEqual(allOff.reasons, ['INFLATED'], 'INFLATED 没有开关，它是逻辑不可能项');

  const normal = detectDegenerate({ shadowedTokens: 48120, summaryTokens: 1490, events: 37 });
  const normalTinyOff = detectDegenerate({ shadowedTokens: 48120, summaryTokens: 1490, events: 37 }, { tinySpanEvents: 0 });
  assert.equal(normal.degenerate, false);
  assert.equal(normalTinyOff.degenerate, false, '正常事务在两种口径下都不退化');
  // 而退化事务在两种口径下读数不同 ⇒ 证明这道闸门在做事
  assert.notEqual(on.reasons.length, noTiny.reasons.length);
});
