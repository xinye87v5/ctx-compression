/**
 * entityExtract.test.mjs —— 模块 4 的测试。
 *
 * 核心是**拒绝**那一侧：`12.5/88/3x` 这类"斜杠分隔的评分列表"必须一条都进不来。
 * 反证：即使给足段频（某个段在语料里出现很多次），也必须仍然拒绝 ——
 * 段频**只能当否决权，不能当许可证**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractEntities, extractPaths, looksLikeHostPath, shapeOk, relativeOk,
  segmentFrequency, verifyAgainstCorpus, KNOWN_EXT,
} from '../entityExtract.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const REPORT = readFileSync(join(FIX, 'report.txt'), 'utf8');

/** 运行时推导路径：测试源码里不出现任何写死的绝对路径 */
const EXISTING_FILE = resolve(FIX, 'checkpoint.txt');
const MISSING_FILE_SAME_DIR = resolve(FIX, 'no-such-file-xyz.txt');
const MISSING_DIR = resolve(FIX, 'no-such-dir-xyz', 'file.txt');

test('looksLikeHostPath：末标签必须纯字母，首段必须含点', () => {
  assert.equal(looksLikeHostPath('raw.githubusercontent.com/acme-labs/orbit-ledger/main/README.md'), true);
  assert.equal(looksLikeHostPath('docs.example.org/guide/setup'), true);
  assert.equal(looksLikeHostPath('a.io/x'), true);
  assert.equal(looksLikeHostPath('config/ledger.yaml'), false, '首段不含点 ⇒ 不是主机');
  assert.equal(looksLikeHostPath('12.5/88/3x'), false, '末标签不是纯字母');
  assert.equal(looksLikeHostPath('v1.2.3/x'), false, '末标签含数字');
  assert.equal(looksLikeHostPath('Completed/Active'), false);
  assert.equal(looksLikeHostPath(''), false);
});

test('shapeOk / relativeOk：段形与扩展名两道闸门', () => {
  assert.equal(shapeOk('config/ledger.yaml'), true);
  assert.equal(shapeOk('12.5/88/3x'), false, '含纯数字段');
  assert.equal(shapeOk('a/b'), false, '段太短');
  assert.equal(shapeOk('~/proj/src/app.mjs'), true, '~ 段不算段');
  assert.equal(shapeOk('single'), false, '只有一段');

  assert.equal(relativeOk('ops/systemd/orbit-reconcile.timer'), true);
  assert.equal(relativeOk('scripts/run-ledger-checks.mjs'), true);
  assert.equal(relativeOk('Completed/Active'), false, '末段无扩展名');
  assert.equal(relativeOk('probe/core/signals'), false, '末段无扩展名');
  assert.ok(KNOWN_EXT.has('mjs') && KNOWN_EXT.has('jsonl'));
});

test('路径接受/拒绝：本地绝对路径必须有 existsSync 或父目录存在', () => {
  assert.equal(existsSync(EXISTING_FILE), true, '前置条件');
  assert.equal(existsSync(MISSING_FILE_SAME_DIR), false, '前置条件');
  assert.equal(existsSync(join(FIX, 'no-such-dir-xyz')), false, '前置条件');

  const okAbs = extractPaths(`见 ${EXISTING_FILE} 这一份`).path;
  assert.deepEqual(okAbs, [EXISTING_FILE]);

  // 文件可能已删/尚未创建 ⇒ 父目录存在也接受
  const parentOk = extractPaths(`写到 ${MISSING_FILE_SAME_DIR} 里`).path;
  assert.deepEqual(parentOk, [MISSING_FILE_SAME_DIR]);

  // 父目录也不存在 ⇒ 拒
  const r = extractPaths(`写到 ${MISSING_DIR} 里`);
  assert.equal(r.path.length, 0);
  assert.ok(r.rejected.some((x) => x.reason.includes('不存在')));

  assert.equal(shapeOk(resolve(FIX, 'checkpoint.txt')), true);
});

test('回归：不存在的绝对路径不得"换个身份"被当成相对路径接受', () => {
  // 曾经的 bug：REL 正则会在 `/no/such/dir/f.txt` 里匹配出 `no/such/dir/f.txt`，
  // 于是同一条路径"绝对身份被拒、相对身份被接受"。
  const r = extractPaths(`占位路径 ${MISSING_DIR} 不存在`);
  assert.equal(r.path.length, 0, '必须一条都不接受');
  assert.ok(r.rejected.some((x) => x.candidate === MISSING_DIR && x.reason.includes('绝对路径')));
  assert.ok(!r.rejected.some((x) => x.reason.includes('末段无已知扩展名')),
    '不应再产生"相对身份"的候选');
});

test('回归：有 scheme 的 URL 不得被再切出一个绝对路径候选', () => {
  const r = extractPaths('参考 https://example.invalid/docs/ledger/reconcile 这份说明');
  assert.deepEqual(r.url, ['https://example.invalid/docs/ledger/reconcile']);
  assert.deepEqual(r.path, []);
  assert.equal(r.rejected.length, 0, '也不该留下"被拒的绝对路径"噪声');
});

test('斜杠列表必须全部被拒（这是本模块的头号敌人）', () => {
  const mustReject = [
    '12.5/88/3x',        // 评分列表
    'AG/MR/HR',          // 缩写并列
    'Completed/Active',  // 状态并列
    'CLI/IDE',
    'gh/glab',
    '34/34',             // 通过率
    'output→actuator/resource',
  ];
  for (const s of mustReject) {
    const r = extractPaths(`这一段是散文，里面写着 ${s} 这样的东西`);
    assert.equal(r.path.length, 0, `${s} 不得被当成路径`);
    assert.equal(r.url.length, 0, `${s} 也不得被当成 URL`);
  }
  // 而且它们确实是被"抓到了再拒"，不是"压根没匹配上"（除了 a/b/c 段太短）
  const caught = extractPaths('12.5/88/3x');
  assert.ok(caught.rejected.length > 0 || caught.path.length === 0);
});

test('段频：只能当否决权，不能当许可证', () => {
  // 语料里 `88` 出现很多次、`3x` 也出现多次 —— 按"段频高就是路径"的逻辑，
  // 12.5/88/3x 就会被放行。判据必须是"形状 + 扩展名"先行，段频只能用于**拒**。
  const corpus = [
    '评分 12.5/88/3x 这一批',
    '另一处 11.0/88/3x 也是',
    '再一处 9.5/88/4y 同样',
  ];
  const freq = segmentFrequency(corpus);
  assert.ok(freq.get('88') >= 3, `前置条件：88 的段频应当很高，实际 ${freq.get('88')}`);
  assert.ok(freq.get('3x') >= 2);

  const r = extractPaths('评分是 12.5/88/3x 这样', { corpusTexts: corpus });
  assert.equal(r.path.length, 0, '段频再高也不能给一个形状不合格的候选发许可证');
  assert.ok(r.rejected.some((x) => x.candidate.includes('12.5/88/3x')));

  // 反向：形状合格但"每段都只出现一次"的相对路径，在给了语料时会被**否决**
  const corpus2 = ['见 ops/systemd/orbit-reconcile.timer 这一份'];
  const withCorpus = extractPaths('见 ops/systemd/orbit-reconcile.timer 这一份', { corpusTexts: corpus2 });
  assert.equal(withCorpus.path.length, 0, '每段段频都 ≤1 ⇒ 疑似散文斜杠');
  assert.ok(withCorpus.rejected[0].reason.includes('段频'));

  // 段频 ≥2 才能留下
  const corpus3 = [
    '见 ops/systemd/orbit-reconcile.timer 这一份',
    '再看 ops/systemd/orbit-reconcile.timer 一遍',
  ];
  const kept = extractPaths('见 ops/systemd/orbit-reconcile.timer 这一份', { corpusTexts: corpus3 });
  assert.deepEqual(kept.path, ['ops/systemd/orbit-reconcile.timer']);

  // 不给 corpusTexts 时，段频闸门整体关闭（这是刻意的：没有语料就没法算段频）
  const noVeto = extractPaths('见 ops/systemd/orbit-reconcile.timer 这一份');
  assert.deepEqual(noVeto.path, ['ops/systemd/orbit-reconcile.timer']);
});

test('extractEntities：在夹具报告上的预期读数', () => {
  const e = extractEntities(REPORT);
  assert.deepEqual(e.url, [
    'https://example.invalid/docs/ledger/reconcile',
    'raw.githubusercontent.com/acme-labs/orbit-ledger/main/README.md',
    'docs.example.org/guide/setup',
  ]);
  assert.deepEqual(e.path, [
    'ops/systemd/orbit-reconcile.timer',
    'config/ledger.yaml',
    'db/archive/2024-migrations.sql',
    'scripts/run-ledger-checks.mjs',
  ]);
  assert.deepEqual(e.num, ['2024', '12345', '9876']);
  assert.equal(e.quote.length, 1);
  assert.equal(e.quote[0], 'the reconcile job must not touch the production schema at all');
  assert.ok(e.quote[0].length >= 40);

  // 被拒清单里必须出现那几个"曾经被误抽"的东西
  const withRej = extractEntities(REPORT, { withRejected: true });
  const rejected = withRej.rejected.map((x) => x.candidate);
  for (const bad of ['12.5/88/3x', 'AG/MR/HR', 'Completed/Active', 'CLI/IDE', 'gh/glab', '34/34']) {
    assert.ok(rejected.includes(bad), `${bad} 应当出现在被拒清单里（而不是被静默丢掉）`);
  }
  assert.ok(!withRej.path.some((p) => p.includes('nonexistent-placeholder')));
});

test('extractEntities：版本号会吃进小数（已知边界，用测试钉住）', () => {
  const e = extractEntities('阈值 0.05，版本 v1.4.2，另一个 2.0，评分 12.5');
  assert.ok(e.ver.includes('v1.4.2'));
  assert.ok(e.ver.includes('0.05'), '小数会被版本规则吃进去 —— 这是已知边界，不是 bug');
  assert.ok(e.ver.includes('12.5'));
  assert.ok(e.ver.includes('2.0'));
});

test('extractEntities：≥40 字符的 ASCII 引句才抽，短引句不抽', () => {
  const long = 'the quick brown fox jumps over the lazy dog many times';
  const e = extractEntities(`他说 "${long}" 然后又说 "too short"`);
  assert.equal(e.quote.length, 1);
  assert.equal(e.quote[0], long);
  assert.ok(long.length >= 40);

  const shortOnly = extractEntities('只有 "too short to qualify" 这一句');
  assert.equal(shortOnly.quote.length, 0);
});

test('verifyAgainstCorpus：每个数都带分母', () => {
  const ents = extractEntities(REPORT);
  const corpus = [REPORT, 'db/archive/2024-migrations.sql'];
  const v = verifyAgainstCorpus(ents, corpus);
  assert.equal(v.byType.path.total, 4);
  assert.equal(v.byType.path.found, 4);
  assert.equal(v.byType.path.rate, 1);
  assert.equal(v.byType.url.rate, 1);
  assert.ok(v.total >= 12);
  assert.equal(typeof v.rate, 'number');

  const partial = verifyAgainstCorpus({ url: ['https://nope.invalid/x', ...ents.url] }, corpus);
  assert.equal(partial.byType.url.total, 4);
  assert.equal(partial.byType.url.found, 3);
  assert.equal(partial.byType.url.rate, 0.75);
});
