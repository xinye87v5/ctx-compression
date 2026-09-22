/**
 * cli.test.mjs —— CLI 的端到端测试。
 *
 * 用子进程跑真命令（不是 import 函数），因为契约的一部分就是**命令行本身**：
 * 参数名、相对路径解析、退出码、以及"每个数都带分母"这条纪律。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CLI = join(ROOT, 'cli.mjs');

function run(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

test('coverage：/ 形式的分数与百分号必须成对出现（每个数都带分母）', () => {
  const r = run('coverage', '--events', 'fixtures/events.jsonl', '--checkpoint', 'fixtures/checkpoint.txt', '--from', '100', '--to', '900');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /命中 4\/6 = 66\.7%/);
  assert.match(r.out, /命中 6\/7 = 85\.7%/);
  assert.match(r.out, /被剔除（长度不足） 4\/10 条/);
  assert.match(r.out, /meanLcsRatio/);
  assert.match(r.out, /topShare/);
});

test('coverage --json：可机器解析，且带分母字段', () => {
  const r = run('coverage', '--events', 'fixtures/events.jsonl', '--checkpoint', 'fixtures/checkpoint.txt', '--from', '100', '--to', '900', '--json');
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.strict.hits, 4);
  assert.equal(j.strict.denominator, 6);
  assert.equal(j.loose.denominator, 7);
  assert.equal(j.rows.length, 10);
  assert.equal(j.input.userUnits, 10);
  assert.equal(j.checkpointChars, 581);
});

test('referent：输出必须自带代理指标标注，且三组都带分母', () => {
  const r = run('referent', '--events', 'fixtures/events.jsonl', '--checkpoint', 'fixtures/checkpoint.txt', '--from', '100', '--to', '900');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /代理指标/);
  assert.match(r.out, /DEP/);
  assert.match(r.out, /1\/2 50\.0%/);
  assert.match(r.out, /6\/6 100\.0%/);
  assert.match(r.out, /空发言剔除 1 条/);
});

test('corpus：去重口径与来源筛选两行都必须带分母', () => {
  const r = run('corpus', '--events', 'fixtures/events-forked.jsonl', '--meta', 'fixtures/sessions.json');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /事件 10\/18 条/);
  assert.match(r.out, /保留 6\/10 = 60\.0%/);
  assert.match(r.out, /保留 6\/18 = 33\.3%/);
  assert.match(r.out, /user 6 · fork 1 · subagent 3/);
});

test('corpus --strict：报告更激进的去重口径', () => {
  const r = run('corpus', '--events', 'fixtures/events-forked.jsonl', '--meta', 'fixtures/sessions.json', '--strict');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /严格 \(kind,time\)/);
  assert.match(r.out, /事件 9\/18 条/);
});

test('entities：被拒清单里必须有 12.5/88/3x；默认不显示，--rejected 才展开', () => {
  const plain = run('entities', '--text', 'fixtures/report.txt');
  assert.equal(plain.code, 0, plain.err);
  assert.match(plain.out, /url     3 条/);
  assert.match(plain.out, /path    4 条/);
  assert.match(plain.out, /被拒；加 --rejected 查看/);

  const rej = run('entities', '--text', 'fixtures/report.txt', '--rejected');
  assert.equal(rej.code, 0, rej.err);
  assert.match(rej.out, /12\.5\/88\/3x/);
  assert.match(rej.out, /AG\/MR\/HR/);
  assert.match(rej.out, /段形不合格/);
});

test('entities --corpus：启用段频闸门后给出"回原文核对"的分母', () => {
  const r = run('entities', '--text', 'fixtures/report.txt', '--corpus', 'fixtures/report.txt', '--json');
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.corpus.length, 1);
  assert.ok(j.verify.byType.path.total >= 0);
  assert.equal(typeof j.verify.rate === 'number' || j.verify.rate === null, true);
});

test('degenerate：退化率带分母，并列出每条事务的标记', () => {
  const r = run('degenerate', '--ranges', 'fixtures/compact-ranges.json');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /退化事务   1\/2 = 50\.0%/);
  assert.match(r.out, /INFLATED,TINY-SPAN,SMALL-SPAN/);
});

test('用法错误 ⇒ 退出码 2，且提示写到 stderr', () => {
  const noCmd = run();
  assert.equal(noCmd.code, 2);
  const badFile = run('coverage', '--events', 'no-such-file.jsonl', '--checkpoint', 'fixtures/checkpoint.txt');
  assert.equal(badFile.code, 2);
  assert.match(badFile.err, /读不到/);
  const unknown = run('nope');
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /未知子命令/);
});

test('度量结果不是错误：空分母时仍然退出 0，但打印 n/a 而不是 0.0%', () => {
  const r = run('coverage', '--events', 'fixtures/events.jsonl', '--checkpoint', 'fixtures/checkpoint.txt', '--from', '9000', '--to', '9001');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /命中 0\/0 = n\/a/);
  assert.doesNotMatch(r.out, /0\/0 = 0\.0%/);
});
