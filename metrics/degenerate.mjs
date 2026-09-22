/**
 * degenerate.mjs —— 模块 5：**退化压缩探测**
 *
 * 判"这次压缩是不是空转"。压缩事务**报 success**，不一定代表它压掉了什么：
 * 有可能摘要比被它替换的内容还大（压力反而上升），也有可能它只遮蔽了 1 个事件。
 * 实测动机：某次留出尝试产出的遮蔽区间**只覆盖 1 个事件**，却记为 success。
 *
 * ## 判据（先写死，不随结果调整）
 *
 * | 标记 | 条件 | 含义 |
 * |---|---|---|
 * | `INFLATED` | `shadowedTokens ≤ summaryTokens`（两者都 >0 才判） | 摘要**不小于**被替换的内容 ⇒ 压缩让上下文更长 |
 * | `TINY-SPAN` | `events ≤ 2` | 只遮蔽 0–2 个事件 ⇒ 几乎没压 |
 * | `SMALL-SPAN` | `shadowedTokens < 2000` | 跨度偏小（绝对门槛） |
 *
 * ## 与"检查器"的区别
 *
 * 这里是**探测器**：只读地找出已经发生的退化压缩，给出频率与形态。
 * 把引擎改成"退化时报 no-op 而不是 success"是另一个决定（要动引擎）。
 *
 * ## 三条判据彼此**独立**求值
 *
 * 一次事务可以同时命中多条（例如遮蔽 1 个事件、1500 token、摘要 3000 token
 * ⇒ `TINY-SPAN` + `SMALL-SPAN` + `INFLATED`）。都报出来，不做 `else if` ——
 * 理由：形态信息本身就是结论的一部分，隐藏它会让"退化率"这个数变得不可解释。
 *
 * ## 门槛为什么是 2 和 2000
 *
 * **经验值**，不是理论值。2 来自"遮蔽 1–2 个事件显然不是压缩"；
 * 2000 是一个绝对下限（该次实测的遮蔽量远小于正常的几万~几十万 token）。
 * 这两个数字**在跑之前写死**，不随观测结果回改。
 */

/** TINY-SPAN 门槛：遮蔽事件数 ≤ 此值 */
export const TINY_SPAN_EVENTS = 2;
/** SMALL-SPAN 门槛：遮蔽 token < 此值 */
export const SMALL_SPAN_TOKENS = 2000;

const REASONS = {
  INFLATED: '摘要 token ≥ 被遮蔽 token：压缩后上下文没有变小（逻辑上不可能有收益）',
  'TINY-SPAN': `遮蔽事件数 ≤ ${TINY_SPAN_EVENTS}：几乎没压到东西`,
  'SMALL-SPAN': `遮蔽 token < ${SMALL_SPAN_TOKENS}：跨度偏小（绝对门槛）`,
};

/**
 * @param {object} tx 一次压缩事务
 * @param {number|null} tx.shadowedTokens 被遮蔽内容的 token 数
 * @param {number|null} tx.summaryTokens 摘要产出的 token 数
 * @param {number|null} tx.events 被遮蔽的事件条数
 * @param {object} [opts]
 * @param {number} [opts.tinySpanEvents=2]
 * @param {number} [opts.smallSpanTokens=2000]
 * @returns {{degenerate: boolean, reasons: string[], notJudged: string[], details: object}}
 */
export function detectDegenerate(tx = {}, opts = {}) {
  const {
    tinySpanEvents = TINY_SPAN_EVENTS,
    smallSpanTokens = SMALL_SPAN_TOKENS,
  } = opts;

  // `null` / `undefined` / `''` 是**缺失**，不是 0。注意 `Number(null) === 0`：
  // 直接 `Number.isFinite(Number(v))` 会把缺失字段悄悄变成真实的零，
  // 于是"没有数据"被读成"遮蔽 0 个事件 ⇒ 退化"，退化率直接虚高。
  const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    return Number.isFinite(Number(v)) ? Number(v) : null;
  };
  const shadowedTokens = num(tx.shadowedTokens);
  const summaryTokens = num(tx.summaryTokens);
  const events = num(tx.events);

  const reasons = [];
  const notJudged = [];
  const checks = {};

  // INFLATED：两个数都得是正数才能判。缺一个数就"不判"，而不是当成 0 判成退化 ——
  // 字段缺失是数据问题，不是压缩问题，混在一起会让退化率虚高。
  if (shadowedTokens !== null && summaryTokens !== null && shadowedTokens > 0 && summaryTokens > 0) {
    checks.INFLATED = {
      judged: true,
      shadowedTokens,
      summaryTokens,
      hit: shadowedTokens <= summaryTokens,
    };
    if (checks.INFLATED.hit) reasons.push('INFLATED');
  } else {
    checks.INFLATED = { judged: false, shadowedTokens, summaryTokens, hit: null };
    notJudged.push('INFLATED');
  }

  if (events !== null) {
    checks['TINY-SPAN'] = { judged: true, events, threshold: tinySpanEvents, hit: events <= tinySpanEvents };
    if (checks['TINY-SPAN'].hit) reasons.push('TINY-SPAN');
  } else {
    checks['TINY-SPAN'] = { judged: false, events, threshold: tinySpanEvents, hit: null };
    notJudged.push('TINY-SPAN');
  }

  if (shadowedTokens !== null) {
    checks['SMALL-SPAN'] = {
      judged: true, shadowedTokens, threshold: smallSpanTokens, hit: shadowedTokens < smallSpanTokens,
    };
    if (checks['SMALL-SPAN'].hit) reasons.push('SMALL-SPAN');
  } else {
    checks['SMALL-SPAN'] = { judged: false, shadowedTokens, threshold: smallSpanTokens, hit: null };
    notJudged.push('SMALL-SPAN');
  }

  return {
    degenerate: reasons.length > 0,
    reasons,
    notJudged,
    details: {
      input: { shadowedTokens, summaryTokens, events },
      thresholds: { tinySpanEvents, smallSpanTokens },
      checks,
      reasonsText: reasons.map((r) => REASONS[r]),
    },
  };
}

/**
 * 批量探测，返回**带分母**的汇总（有多少次事务被判退化 / 总共判了几次）。
 * @param {Array<object>} transactions
 * @param {object} [opts]
 * @returns {{total: number, degenerate: number, rate: number|null, byReason: Record<string, number>, rows: object[]}}
 */
export function detectDegenerateBatch(transactions, opts = {}) {
  const rows = [];
  const byReason = {};
  for (const tx of transactions ?? []) {
    const r = detectDegenerate(tx, opts);
    rows.push({ ...r, tx });
    for (const reason of r.reasons) byReason[reason] = (byReason[reason] ?? 0) + 1;
  }
  const degenerate = rows.filter((r) => r.degenerate).length;
  return {
    total: rows.length,
    degenerate,
    rate: rows.length ? degenerate / rows.length : null,
    byReason,
    rows,
  };
}

export default detectDegenerate;
