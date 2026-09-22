/**
 * coverage.mjs —— 模块 1：**逐字覆盖**（verbatim coverage）
 *
 * 问的问题只有一个：**压缩之后，用户说过的话还有多少字面留存？**
 *
 * ## 单位（为什么是"用户发言"而不是"事件"或"token"）
 *
 * 单位是窗口内 `kind === 'user'` 的发言。理由：agent 自己的话被压缩掉是设计意图，
 * 用户的话被压缩掉是**信息丢失**。两者混在一个分母里，指标就没有含义了。
 *
 * ## 归一化
 *
 * 去首尾空白 + 把连续空白折成一个空格。**长度按归一化后的 Unicode 码点数计**。
 * 归一化的目的：换行/缩进差异不该算"没留存"，那只是排版。
 *
 * ## 分母（短发言必须剔除）
 *
 * 分母 = 归一化长度 **≥ 阈值** 的发言。原因不是"短发言不重要"，而是
 * **LCS 对短发言数学上不可达**：一条 6 字的发言，`LCS ≤ 6 < 30`，
 * 它永远不可能命中严格档。把它留在分母里，等于往分母里掺必然失败的样本，
 * 覆盖率会被**发言长度的分布**（而不是压缩质量）决定。
 *
 * ## 两档
 *
 * | 档 | 阈值 | 角色 |
 * |---|---|---|
 * | 严格 | 30 | 主指标。逐字留存一段可独立阅读的内容 |
 * | 宽松 | 12 | 参考。**只用于对比**，看"片段被收录"冒充"判据被保留"的空间 |
 *
 * 两档都要报，且必须连着分母一起报。
 */

/** 严格档阈值（主指标） */
export const DEFAULT_THRESHOLD = 30;
/** 宽松档阈值（参考） */
export const DEFAULT_LOOSE_THRESHOLD = 12;

/**
 * 归一化：去首尾空白，连续空白（含全角空格、不换行空格、换行、制表）折成一个空格。
 * @param {unknown} s
 * @returns {string}
 */
export function normalize(s) {
  if (s == null) return '';
  return String(s).replace(/\s+/g, ' ').trim();
}

/**
 * 按 Unicode 码点计的长度。emoji 等增补平面字符算 1，不算 2。
 * 阈值比较与 `lcs/len` 一律用这个口径，保证 `lcs(a,b) <= charLength(a)` 恒成立。
 * @param {string} s 已归一化的字符串
 * @returns {number}
 */
export function charLength(s) {
  return typeof s === 'string' ? Array.from(s).length : 0;
}

/**
 * 最长公共子序列长度（精确值，不是估计）。
 *
 * 复杂度 `O(n·m)`，内存 `O(min(n,m))`（滚动两行 + 交换，使行宽取较短的一侧）。
 * 对"用户发言（几十~几千字）× 摘要（几千~几万字）"是可接受的；
 * 对"助手消息（上万字）"不可接受 —— 那正是模块 2 改用 n-gram 的原因。
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} 公共子序列的最大长度（码点计）
 */
export function lcs(a, b) {
  const x = typeof a === 'string' ? a : String(a ?? '');
  const y = typeof b === 'string' ? b : String(b ?? '');
  if (!x.length || !y.length) return 0;
  if (x === y) return charLength(x);

  const A = Array.from(x);
  const B = Array.from(y);
  // 行宽取较短的一侧：内存与"每个单元格的代价"都随之下降
  const [short, long] = A.length <= B.length ? [A, B] : [B, A];

  const w = short.length;
  let prev = new Uint32Array(w + 1);
  let cur = new Uint32Array(w + 1);
  for (let j = 0; j < long.length; j++) {
    const cj = long[j];
    for (let i = 1; i <= w; i++) {
      cur[i] = short[i - 1] === cj
        ? prev[i - 1] + 1
        : (prev[i] >= cur[i - 1] ? prev[i] : cur[i - 1]);
    }
    const t = prev; prev = cur; cur = t;
    // 被换出去的 `cur` 下一轮每个下标都会被覆写，且下标 0 恒为 0，无需清零
  }
  return prev[w];
}

/**
 * LCS 的**廉价上界**：`Σ_char min(countA(char), countB(char))`。
 *
 * 这是**上界**而不是估计值：每个字符最多被匹配 `min(出现次数)` 次。
 * 用途是**预筛**：`lcsBound(a,b) < threshold` ⇒ 必然 `lcs(a,b) < threshold`，
 * 可以省掉整次 DP。**不能**用它宣称命中（`bound ≥ threshold` 不蕴含命中）。
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function lcsBound(a, b) {
  const x = typeof a === 'string' ? a : String(a ?? '');
  const y = typeof b === 'string' ? b : String(b ?? '');
  if (!x.length || !y.length) return 0;
  const counts = new Map();
  for (const ch of x) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bound = 0;
  for (const ch of y) {
    const n = counts.get(ch);
    if (n) { bound++; counts.set(ch, n - 1); }
  }
  return bound;
}

/**
 * 从任意输入里取出"发言单元"。字符串数组直接用；对象数组取 `.text`。
 * @param {Array<string|{text?: unknown, kind?: string, seq?: number, session?: string}>} input
 * @param {{userOnly?: boolean}} [opts]
 * @returns {Array<{text: string, seq: number|null, session: string|null, kind: string|null}>}
 */
function toUnits(input, { userOnly = true } = {}) {
  const out = [];
  for (const item of input ?? []) {
    if (typeof item === 'string') {
      out.push({ text: item, seq: null, session: null, kind: null });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const kind = typeof item.kind === 'string' ? item.kind : null;
    // 传事件对象时默认只取用户发言；传纯字符串时这条规则不适用
    if (userOnly && kind !== null && kind !== 'user') continue;
    out.push({
      text: item.text == null ? '' : String(item.text),
      seq: Number.isFinite(item.seq) ? item.seq : null,
      session: item.session ?? null,
      kind,
    });
  }
  return out;
}

/** 单档统计：给定阈值，算命中 / 分母 / 均值。 */
function tier(rows, threshold) {
  const units = rows.filter((r) => r.len >= threshold && r.len > 0);
  const hits = units.filter((r) => r.lcs >= threshold).length;
  const lcsSum = units.reduce((a, r) => a + r.lcs, 0);
  const ratioSum = units.reduce((a, r) => a + (r.len ? r.lcs / r.len : 0), 0);
  const top = units.length
    ? units.reduce((a, r) => (r.lcs > a.lcs ? r : a), units[0])
    : null;
  return {
    threshold,
    hits,
    denominator: units.length,
    // 分母为 0 时返回 null 而不是 0：空分母没有"覆盖率"，报 0 会被读成"覆盖率为零"
    rate: units.length ? hits / units.length : null,
    meanLcsRatio: units.length ? ratioSum / units.length : null,
    maxLcsRatio: units.length
      ? units.reduce((a, r) => Math.max(a, r.len ? r.lcs / r.len : 0), 0)
      : null,
    lcsSum,
    // 支配度：LCS 总量里最大的那一条占多少。接近 1 说明"覆盖率"其实由单条长发言决定
    topShare: lcsSum > 0 && top ? top.lcs / lcsSum : null,
    top: top ? { seq: top.seq, len: top.len, lcs: top.lcs, text: top.text } : null,
    excluded: rows.length - units.length,
  };
}

/**
 * 逐字覆盖。
 *
 * @param {Array<string|object>} utterances 用户发言（字符串，或带 `text` 的事件对象）
 * @param {string} checkpoint 压缩产出的摘要文本（纯文本）
 * @param {object} [opts]
 * @param {number} [opts.threshold=30] 严格档阈值（主指标）
 * @param {number} [opts.looseThreshold=12] 宽松档阈值（参考）
 * @param {boolean} [opts.userOnly=true] 传事件对象时是否只保留 `kind==='user'`
 * @param {boolean} [opts.keepRows=true] 是否在返回值里带上逐条明细
 * @returns {{
 *   threshold: number, total: number, hits: number, denominator: number,
 *   rate: number|null, meanLcsRatio: number|null, excluded: number,
 *   loose: object, rows: Array<object>, checkpointLength: number
 * }}
 */
export function coverage(utterances, checkpoint, opts = {}) {
  const {
    threshold = DEFAULT_THRESHOLD,
    looseThreshold = DEFAULT_LOOSE_THRESHOLD,
    userOnly = true,
    keepRows = true,
  } = opts;

  const ck = normalize(checkpoint);
  const units = toUnits(utterances, { userOnly });

  const rows = units.map((u) => {
    const text = normalize(u.text);
    const len = charLength(text);
    const score = len ? lcs(text, ck) : 0;
    return {
      seq: u.seq,
      session: u.session,
      kind: u.kind,
      text,
      len,
      lcs: score,
      ratio: len ? score / len : 0,
      included: len >= threshold && len > 0,
      hit: len >= threshold && len > 0 && score >= threshold,
    };
  });

  const strict = tier(rows, threshold);
  const loose = tier(rows, looseThreshold);

  return {
    threshold,
    total: rows.length,
    hits: strict.hits,
    denominator: strict.denominator,
    rate: strict.rate,
    meanLcsRatio: strict.meanLcsRatio,
    excluded: strict.excluded,
    maxLcsRatio: strict.maxLcsRatio,
    lcsSum: strict.lcsSum,
    topShare: strict.topShare,
    top: strict.top,
    loose,
    checkpointLength: charLength(ck),
    rows: keepRows ? rows : [],
  };
}

export default coverage;
