/**
 * corpus.test.mjs —— 模块 3 的测试。
 *
 * 含两组**反证**：
 * 1. 不去重时，"全库统计"会被 fork 副本放大（正是实测里 3.1 倍那个现象的缩小版）；
 * 2. 只去重不筛来源时，子代理的委派提示词会被当成用户发言数进去（去重救不了）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadEvents, loadEventsDetailed, dedupe, classifyOrigin, normalizeMeta,
  filterByOrigin, originOfEvent, originBreakdown,
} from '../corpus.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const FORKED = readFileSync(join(FIX, 'events-forked.jsonl'), 'utf8');
const META = JSON.parse(readFileSync(join(FIX, 'sessions.json'), 'utf8'));

test('loadEvents：容错逐行解析，坏行跳过并计数，不抛异常', () => {
  const text = [
    '{"session":"s","seq":1,"kind":"user","text":"正常一行"}',
    '',
    '   ',
    '{"session":"s","seq":2,"kind":"user","text":"被截断的半行',   // 模拟"正在写入"
    '{"session":"s","seq":3,"kind":"assistant","text":"正常"}',
    'not json at all',
  ].join('\n');
  const d = loadEventsDetailed(text);
  assert.equal(d.events.length, 2);
  assert.equal(d.skipped, 2);
  assert.deepEqual(d.skippedLines, [4, 6]);
  assert.equal(d.total, 4, 'total = 非空行数 = 解析成功 2 + 跳过 2（空行不计）');
  assert.deepEqual(loadEvents(text).map((e) => e.seq), [1, 3]);
});

test('loadEvents：字段别名（type/ts）被规格化，text 缺失补空串', () => {
  const e = loadEvents('{"session":"s","seq":1,"type":"tool","ts":123}')[0];
  assert.equal(e.kind, 'tool');
  assert.equal(e.time, 123);
  assert.equal(e.text, '');
});

test('dedupe（宽松）：按 (kind,time,seq) 折叠 fork 种子副本，并给出每个事件的副本数', () => {
  const raw = loadEvents(FORKED);
  assert.equal(raw.length, 18);
  const d = dedupe(raw);
  assert.equal(d.events.length, 10);
  assert.equal(d.duplicates, 8);
  assert.equal(d.totalInput, 18);
  assert.equal(d.missingTime, 0);
  assert.equal(d.strictReliable, true);

  // 出现在 3 个会话里的那条：副本数 3，sids 三份
  const three = d.events.find((e) => e.copies === 3);
  assert.ok(three, '应当存在一条 3 副本事件');
  assert.deepEqual(three.sids, ['s-root', 's-fork', 's-fork2']);
  assert.equal(three.seq, 1);
  assert.equal(three.sids.length, three.copies);

  // sidsOf 与事件上的 sids 一致
  for (const e of d.events) assert.deepEqual(d.sidsOf[e.dedupeKey], e.sids);
});

test('dedupe（严格）：(kind,time) 双元组更激进，会误伤同毫秒的不同事件', () => {
  const raw = loadEvents(FORKED);
  const loose = dedupe(raw, { strict: false });
  const strict = dedupe(raw, { strict: true });
  assert.equal(loose.events.length, 10);
  assert.equal(strict.events.length, 9, 's-root 的 start/prune 两条同毫秒事件被折成一条');
  assert.equal(strict.duplicates, 9);
  assert.ok(strict.events.length < loose.events.length, '严格口径是更激进的上界，必须更小');
});

test('dedupe：缺 time 的事件不能被折叠（严格口径下必须标 strictReliable=false）', () => {
  const text = [
    '{"session":"a","seq":1,"kind":"user","text":"第一条"}',
    '{"session":"b","seq":2,"kind":"user","text":"第二条"}',
    '{"session":"c","seq":3,"kind":"user","text":"第三条"}',
  ].join('\n');
  const raw = loadEvents(text);
  const d = dedupe(raw, { strict: true });
  assert.equal(d.missingTime, 3);
  assert.equal(d.strictReliable, false);
  assert.equal(d.events.length, 3, '没有 time 时：(kind,time) 会把同 kind 全部折成一条 —— 那是数据销毁，不是去重');
  assert.equal(d.duplicates, 0);
});

test('classifyOrigin：subagent 优先于 parent，其次 fork，最后血缘根', () => {
  assert.equal(classifyOrigin({ origin: 'user' }), 'user');
  assert.equal(classifyOrigin({ origin: 'fork', parent: 'p' }), 'fork');
  assert.equal(classifyOrigin({ origin: 'subagent', parent: 'p' }), 'subagent', '子代理即使有 parent 也是 subagent');
  assert.equal(classifyOrigin({ parent: 'p' }), 'fork', '只有 parent 没有 origin ⇒ fork');
  assert.equal(classifyOrigin({}), 'user', '既无 origin 又无 parent ⇒ 血缘根');
  assert.equal(classifyOrigin({ origin: 'SUBAGENT' }), 'subagent', '大小写不敏感');
  assert.equal(classifyOrigin({ origin: 'weird' }), 'unknown');
  assert.equal(classifyOrigin(null), 'unknown');
  assert.equal(classifyOrigin({ parentSession: 'p' }), 'fork', 'parentSession 是别名');
});

test('normalizeMeta：对象映射与数组两种形状都收，且必须幂等（回归）', () => {
  const fromObj = normalizeMeta(META);
  assert.equal(fromObj.get('s-sub').origin, 'subagent');
  assert.equal(fromObj.get('s-fork').parent, 's-root');

  const fromArr = normalizeMeta([
    { session: 'a', origin: 'fork', parent: 'r' },
    { session: 'b' },
  ]);
  assert.equal(fromArr.get('a').origin, 'fork');
  assert.equal(fromArr.get('b').origin, 'user');

  // 幂等：把自己产出的 Map 再喂一次，必须原样返回
  assert.equal(normalizeMeta(fromObj), fromObj);
  assert.equal(normalizeMeta(fromObj).get('s-root').origin, 'user');
});

test('filterByOrigin：只保留血缘根用户会话，并如实报出被剔除的来源分布', () => {
  const d = dedupe(loadEvents(FORKED));
  const kept = filterByOrigin(d.events, ['user'], META);
  assert.equal(kept.length, 6, '去重后 10 条里只有 6 条来自血缘根');
  assert.deepEqual([...new Set(kept.map((e) => e.session))], ['s-root']);

  const b = originBreakdown(d.events, ['user'], META);
  assert.equal(b.total, 10);
  assert.equal(b.kept, 6);
  assert.equal(b.dropped, 4);
  assert.deepEqual(b.byOrigin, { user: 6, fork: 1, subagent: 3 });

  // 也接受已经规格化好的 Map
  const kept2 = filterByOrigin(d.events, ['user'], normalizeMeta(META));
  assert.equal(kept2.length, 6);

  // 事件自带 origin 时可以完全不传 meta
  const inline = [{ session: 'x', kind: 'user', text: 'a', origin: 'user' },
    { session: 'y', kind: 'user', text: 'b', origin: 'subagent' }];
  assert.equal(filterByOrigin(inline, ['user']).length, 1);

  assert.equal(originOfEvent({ session: 's-sub', kind: 'user' }, META), 'subagent');
});

// ──────────────────────────────────────────────────────────────── 反证 1
test('反证：不去重时，同一批事件会被 fork 副本放大（压缩事务 2 → 4）', () => {
  const raw = loadEvents(FORKED);
  const d = dedupe(raw);
  const countCompaction = (xs) => xs.filter((e) => e.kind === 'compaction').length;

  const naively = countCompaction(raw);
  const deduped = countCompaction(d.events);
  assert.equal(naively, 4, 's-root 的 2 条压缩事件在 fork 里各复了一份');
  assert.equal(deduped, 2);
  assert.equal(naively / deduped, 2, '放大倍数 = fork 份数（实测里是 3.1 倍，机理相同）');
  assert.ok(naively > deduped, '不报去重口径就会把一次压缩数成两次');
});

// ──────────────────────────────────────────────────────────────── 反证 2
test('反证：去重救不了来源混淆 —— 子代理的委派提示词会被当成用户发言', () => {
  const d = dedupe(loadEvents(FORKED));   // 已经去重了
  const allUser = d.events.filter((e) => e.kind === 'user');
  const realUser = filterByOrigin(allUser, ['user'], META);

  assert.equal(allUser.length, 5, '去重后 kind=user 共 5 条（s-root 2 + s-fork 1 + s-sub 2）');
  assert.equal(realUser.length, 2, '其中 2 条是 s-sub 的委派提示词，走的是同一条 user 通道');
  assert.notEqual(allUser.length, realUser.length, '去重之后依然混着不该数的东西');

  const subUser = allUser.filter((e) => originOfEvent(e, META) === 'subagent');
  assert.equal(subUser.length, 2);
  assert.ok(subUser.every((e) => e.session === 's-sub'));
});

test('夹具上的预期读数（README 里引用的就是这一组）', () => {
  const d = dedupe(loadEvents(FORKED));
  const b = originBreakdown(d.events, ['user'], META);
  const bRaw = originBreakdown(loadEvents(FORKED), ['user'], META);
  assert.equal(`${d.events.length}/${d.totalInput}`, '10/18');
  assert.equal(d.duplicates, 8);
  assert.equal(`${b.kept}/${b.total}`, '6/10');
  assert.equal(`${bRaw.kept}/${bRaw.total}`, '6/18');
  assert.equal(d.events.filter((e) => e.copies > 1).length, 6);
  assert.equal(Math.max(...d.events.map((e) => e.copies)), 3);
});
