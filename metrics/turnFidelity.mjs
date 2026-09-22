/**
 * turnFidelity.mjs —— 模块 2：**回合级保真**
 *
 * 模块 1 只能回答"用户说过的字还在不在"。它漏掉了压缩里最贵的一类损失：
 *
 * > 用户的**短发言**是**回指**（"那改用 B 方案吧"、"继续"、"为什么？"）。
 * > 它本身没几个字，但它的**含义挂在上一轮 agent 说的话上**。
 * > 摘要把那段 agent 的话丢掉之后，这条发言在摘要里变成了一个**没有所指的短语**。
 *
 * 这类损失用模块 1 永远测不到：发言太短，LCS 数学上够不着阈值（见 coverage.mjs 的分母说明）。
 *
 * ## 三类
 *
 * | 组 | 判据（归一化后码点长度） | 判什么 |
 * |---|---|---|
 * | `DEP`  | `≤ 12` | **回指型**：判"所指有痕"（referent link） |
 * | `SELF` | `≥ 20` | **自足型**：判"自身存活"（LCS ≥ 8） |
 * | `MID`  | `12 < len < 20` | **只报告，不判定**（落在这条带上的样本太少，判了就是编） |
 *
 * ## 两个判据
 *
 * 1. **自身存活** `selfSurvived = LCS(发言, checkpoint) ≥ 8`。
 *    对 DEP 组基本恒为 false（不足 8 个字的发言不可能达到 8），**这不是 bug**：
 *    DEP 组的判据本来就不是这一条。
 *
 * 2. **所指有痕** `referentLink`：取该发言**上一条 assistant 消息的末 2,000 字符**，
 *    切成 **12-gram 集合**，命中率 = 出现在 checkpoint 里的 gram 比例，**≥ 10% 记"有痕迹"**。
 *
 * ## ⚠️ 这是代理指标（proxy），不是"所指被保留"的证明
 *
 * 为什么不用 LCS 量 assistant 那段话：assistant 消息可达上万字，
 * `O(n·m)` 的 DP 在整批语料上不可行（这是工程约束，不是方法论选择）。
 *
 * 为什么 n-gram 命中率只是**代理**：
 * - 摘要可能复述了同一段的**别处措辞**，逐字 gram 不命中，但所指其实在；
 * - 也可能只是**共享了同一批标识符/路径**（比如两边都提同一个文件名）而记成"有痕迹"。
 *
 * ⇒ 所以本模块的输出里**必须**带 `proxy: true` 与 `proxyNote`，
 * 下游任何引用都要连着"这是代理指标"一起引用。0.10 与 12 都是**经验阈值**，不是理论值。
 */

import { normalize, lcs, charLength } from './coverage.mjs';

/** DEP 上界：归一化长度 ≤ 此值算回指型 */
export const DEP_MAX_LEN = 12;
/** SELF 下界：归一化长度 ≥ 此值算自足型 */
export const SELF_MIN_LEN = 20;
/** 自身存活的 LCS 门槛 */
export const SELF_LCS = 8;

/**
 * 取 n-gram 集合（滑窗，按码点）。
 *
 * 注意是**集合**：重复出现的 gram 只算一次。这样"命中率"度量的是
 * "锚文本里**有多少种** 12 字片段还在摘要里"，不会被一段重复内容灌水。
 *
 * 文本短于 n 时返回**空集**（没有完整的 n-gram 存在），而不是把整段当成一个 gram ——
 * 后者会让短锚文本凭空获得一次命中。
 *
 * @param {string} text
 * @param {number} [n=12]
 * @returns {Set<string>}
 */
export function grams(text, n = 12) {
  const s = normalize(text);
  const cps = Array.from(s);
  const out = new Set();
  if (!Number.isFinite(n) || n <= 0 || cps.length < n) return out;
  for (let i = 0; i + n <= cps.length; i++) out.add(cps.slice(i, i + n).join(''));
  return out;
}

/** 取字符串末 `k` 个码点。 */
export function tail(text, k) {
  const cps = Array.from(typeof text === 'string' ? text : String(text ?? ''));
  return cps.length <= k ? cps.join('') : cps.slice(cps.length - k).join('');
}

/**
 * 所指有痕（**代理指标**）。
 *
 * @param {string} utterance 该用户发言
 * @param {string} prevAssistant 该发言**之前最近的一条** assistant 消息原文
 * @param {string} checkpoint 摘要文本
 * @param {object} [opts]
 * @param {number} [opts.anchorChars=2000] 只取上一条 assistant 消息的末多少字符作锚
 * @param {number} [opts.n=12] gram 长度
 * @param {number} [opts.minRate=0.10] 判定"有痕迹"的命中率门槛
 * @returns {{
 *   judged: boolean, linked: boolean|null, rate: number|null,
 *   gramCount: number, hitCount: number, anchorChars: number,
 *   anchorLength: number, n: number, minRate: number, proxy: true, reason?: string
 * }}
 */
export function referentLink(utterance, prevAssistant, checkpoint, opts = {}) {
  const { anchorChars = 2000, n = 12, minRate = 0.10 } = opts;
  const base = {
    judged: false, linked: null, rate: null, gramCount: 0, hitCount: 0,
    anchorChars, anchorLength: 0, n, minRate, proxy: true,
    utteranceLength: charLength(normalize(utterance)),
  };

  // 空发言没有"所指"可丢。若不在这里挡掉，它会带着"锚命中率很高"被计成 linked=true，
  // 从而把 DEP 组的 linkRate 灌高 —— 这是最隐蔽的一种分母污染。
  if (base.utteranceLength === 0) {
    return { ...base, reason: 'empty-utterance' };
  }

  // 没有上一条 assistant 消息 ⇒ 这条发言本来就不是回指（是第一句），不判
  if (prevAssistant == null || normalize(prevAssistant) === '') {
    return { ...base, reason: 'no-previous-assistant' };
  }

  const anchor = tail(normalize(prevAssistant), anchorChars);
  const ag = grams(anchor, n);
  if (ag.size === 0) {
    // 锚文本不足 n 个字：构不出 gram。不判，也不当成"没痕迹"
    return { ...base, anchorLength: charLength(anchor), reason: 'anchor-shorter-than-n' };
  }

  const cg = grams(checkpoint, n);
  let hit = 0;
  for (const g of ag) if (cg.has(g)) hit++;

  const rate = hit / ag.size;
  return {
    ...base,
    judged: true,
    linked: rate >= minRate,
    rate,
    gramCount: ag.size,
    hitCount: hit,
    anchorLength: charLength(anchor),
  };
}

/** 汇总一组单元的判定结果。所有率都连着分母一起给。 */
function summarize(label, rows, primary) {
  const total = rows.length;
  const selfOk = rows.filter((r) => r.selfSurvived).length;
  const judged = rows.filter((r) => r.link.judged);
  const linked = judged.filter((r) => r.link.linked).length;
  const meanLinkRate = judged.length
    ? judged.reduce((a, r) => a + r.link.rate, 0) / judged.length
    : null;
  const rateSum = rows.reduce((a, r) => a + r.ratio, 0);
  return {
    label,
    primary,
    decided: primary !== null,
    total,
    selfSurvived: selfOk,
    selfRate: total ? selfOk / total : null,
    linkJudged: judged.length,
    linkUnjudged: total - judged.length,
    linked,
    linkRate: judged.length ? linked / judged.length : null,
    meanLinkRate,
    meanLcsRatio: total ? rateSum / total : null,
    linkProxy: true,
  };
}

/** 从事件流里取出单元（默认 kind==='user'）。 */
function userUnits(events, { from, to, session, userOnly = true } = {}) {
  const out = [];
  for (const e of events ?? []) {
    if (!e || typeof e !== 'object') continue;
    if (session != null && e.session !== session) continue;
    if (userOnly && e.kind !== 'user') continue;
    const seq = Number(e.seq);
    if (from != null && !(seq >= from)) continue;
    if (to != null && !(seq <= to)) continue;
    out.push(e);
  }
  return out;
}

/**
 * 回合级保真汇总。
 *
 * `from` / `to` **只筛"哪些发言算单元"**；找"上一条 assistant 消息"时
 * 用的是**完整事件流**，所以窗口左边界的发言也能拿到正确的锚
 * （这是刻意的：压掉锚的那次压缩，往往正好发生在窗口左边界之前）。
 *
 * @param {Array<object>} events 事件流（`{session, seq, kind, text}`）
 * @param {string} checkpoint 摘要文本
 * @param {object} [opts]
 * @param {number} [opts.from] seq 下界（含）
 * @param {number} [opts.to] seq 上界（含）
 * @param {string} [opts.session] 只取该会话
 * @param {number} [opts.anchorChars=2000]
 * @param {number} [opts.n=12]
 * @param {number} [opts.minRate=0.10]
 * @param {boolean} [opts.keepRows=false]
 * @returns {object}
 */
export function turnFidelity(events, checkpoint, opts = {}) {
  const {
    from, to, session, anchorChars = 2000, n = 12, minRate = 0.10, keepRows = false,
  } = opts;

  const ck = normalize(checkpoint);

  // 按会话分组、组内按 seq 升序：锚的取法必须沿时间顺序，否则"上一条 assistant"没有意义
  const order = [];
  const byS = new Map();
  for (const e of events ?? []) {
    if (!e || typeof e !== 'object') continue;
    const s = String(e.session ?? '');
    if (!byS.has(s)) { byS.set(s, []); order.push(s); }
    byS.get(s).push(e);
  }
  for (const s of order) {
    byS.get(s).sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
  }

  const selected = new Set(userUnits(events, { from, to, session }));

  const rows = [];
  let skippedEmpty = 0;
  for (const s of order) {
    let prevAssistant = null;
    for (const e of byS.get(s)) {
      if (e.kind === 'assistant') {
        prevAssistant = e.text == null ? '' : String(e.text);
      } else if (e.kind === 'user' && selected.has(e)) {
        const text = normalize(e.text);
        const len = charLength(text);
        // 归一化后为空（全空白 / 空串）不算一条发言：它没有长度也没有所指，
        // 留在任何一组里都只会污染分母。剔除并**如实报数**。
        if (len === 0) { skippedEmpty++; continue; }
        const score = len ? lcs(text, ck) : 0;
        const link = referentLink(text, prevAssistant, ck, { anchorChars, n, minRate });
        rows.push({
          session: s,
          seq: Number.isFinite(Number(e.seq)) ? Number(e.seq) : null,
          text,
          len,
          lcs: score,
          ratio: len ? score / len : 0,
          selfSurvived: score >= SELF_LCS,
          link,
          group: len <= DEP_MAX_LEN ? 'DEP' : (len >= SELF_MIN_LEN ? 'SELF' : 'MID'),
        });
      }
    }
  }

  const pick = (g) => rows.filter((r) => r.group === g);
  const DEP = summarize('DEP 回指型（≤12 字）', pick('DEP'), 'link');
  const SELF = summarize('SELF 自足型（≥20 字）', pick('SELF'), 'selfSurvived');
  const MID = summarize('MID 中间带（12<len<20）', pick('MID'), null);

  return {
    checkpointLength: charLength(ck),
    events: (events ?? []).length,
    sessions: order.length,
    totalUnits: rows.length,
    skippedEmpty,
    groups: { DEP, SELF, MID },
    // 兼容扁平访问
    DEP,
    SELF,
    MID,
    boundary: {
      depMaxLen: DEP_MAX_LEN,
      selfMinLen: SELF_MIN_LEN,
      selfLcs: SELF_LCS,
      anchorChars,
      n,
      minRate,
    },
    proxy: true,
    proxyNote:
      'referentLink 是**代理指标**：用上一条 assistant 消息末段的 12-gram 在摘要里的命中率，'
      + '近似"这条短发言的所指还在不在"。它既会漏（摘要换措辞复述同一件事）也会高估'
      + '（只共享了同一批标识符）。不可作为"所指被保留"的证明；阈值 12 / 0.10 为经验值。',
    rows: keepRows ? rows : [],
  };
}

export default turnFidelity;
