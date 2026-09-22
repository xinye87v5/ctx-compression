/**
 * corpus.mjs —— 模块 3：**语料卫生**（最容易被忽略、后果最重）
 *
 * 前两个模块都在算"保真度"。但保真度是**比值**，分子分母都是从语料里数出来的 ——
 * 语料脏了，比值本身可以完全正确，而结论完全错。这一模块就管这件事。
 *
 * ## 污染源 1：fork 复制（放大 3.1 倍）
 *
 * 会话被 fork 时，**父会话的事件会被原文拷进子会话的种子区**。于是父会话的每一次压缩、
 * 每一次裁剪，都在每个子会话里各出现一次。实测（未去重口径）：
 *
 * | 口径 | 压缩事务 | 裁剪 token |
 * |---|---|---|
 * | 直接数事件 | **73** | **930,205** |
 * | 事件级去重后 | **33** | **302,945** |
 *
 * 放大 **3.1 倍**。而且"失败事务 15 个"里有 11 个是**同一次失败的副本**。
 *
 * ⇒ 判据（先写死）：**同 `(kind, time, seq)` 的事件在别的会话里也出现，就判为副本。**
 * - 用三元组而不是单个 `time`：真实的不同事件可能落在同一毫秒（实测确实存在）。
 * - **不做"整会话排除"**：fork 种子区**之后**的事件是该会话自己产生的，排除整会话会丢真样本。
 * - `strict: true` 时退化成 `(kind, time)` 双元组，作为**更激进的上界**一起报 ——
 *   两个口径都给，避免"挑一个对自己有利的分母"。
 *
 * ## 污染源 2：来源混淆（去重救不了）
 *
 * **子代理（subagent）收到的"用户发言"其实是父代理下发的委派提示词**，
 * 走的是同一条 user 通道。只读类任务的提示词几乎必然含"不要修改…"之类的否定词，
 * 于是任何"用户不满/纠正率"类指标在子代理会话上都是假的。
 * 实测某次 33 条价值信号 **33/33 全被判成 NEG**，总体里 26/31 是 subagent。
 *
 * ⇒ **数重了可以靠去重救；数了不该数的东西，只能靠按来源剔除。**
 * 任何"用户行为"类统计，跑批量之前必须先 `filterByOrigin(events, ['user'])`。
 *
 * 本模块是**纯函数**，不读盘：`loadEvents` 接收文本，CLI 负责读文件。
 */

/** 已知来源 */
export const ORIGINS = ['user', 'fork', 'subagent', 'unknown'];

/**
 * 字段名兼容层：把外部事件规格化成内部形状。
 * 契约字段是 `{session, seq, kind, text}`；`time` 是**可选**的（去重需要它，缺失时见 `dedupe`）。
 * 同时接受 `type`/`ts`/`timestamp`/`t` 这类别名，避免调用方为了喂数据先做一遍改名。
 */
function normEvent(e) {
  if (!e || typeof e !== 'object') return null;
  const kind = e.kind ?? e.type ?? null;
  const time = e.time ?? e.ts ?? e.timestamp ?? e.t ?? null;
  const seq = e.seq ?? e.sequence ?? null;
  return {
    raw: e,
    session: e.session == null ? null : String(e.session),
    seq: Number.isFinite(Number(seq)) ? Number(seq) : null,
    kind: kind == null ? null : String(kind),
    time: time == null ? null : time,
    text: e.text == null ? '' : String(e.text),
    origin: e.origin ?? null,
    parent: e.parent ?? e.parentSession ?? null,
  };
}

/**
 * 逐行解析 JSONL。**容错**：空行跳过；正在写入的半行（JSON 不完整）跳过并计数，
 * 不抛异常 —— 线上会话日志经常在写一半时被读到，能解析多少算多少，但要**如实报告**丢了几行，
 * 否则又是"静默放大/静默缩小"。
 *
 * @param {string} text
 * @returns {{events: object[], total: number, skipped: number, skippedLines: number[]}}
 *   `total` = **非空行数**（= 解析成功 + 跳过），空行不计入任何一边。
 */
export function loadEventsDetailed(text) {
  const events = [];
  const skippedLines = [];
  const lines = String(text ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      skippedLines.push(i + 1);
      continue;
    }
    const e = normEvent(parsed);
    if (e) events.push(e);
    else skippedLines.push(i + 1);
  }
  return { events, total: events.length + skippedLines.length, skipped: skippedLines.length, skippedLines };
}

/**
 * 逐行解析 JSONL，只返回事件数组（契约签名）。
 * 需要"丢了几行"这类元信息时用 `loadEventsDetailed`。
 * @param {string} text
 * @returns {object[]}
 */
export function loadEvents(text) {
  return loadEventsDetailed(text).events;
}

/** 去重键。`time` 缺失时用逐事件唯一哨兵 —— 见 `dedupe` 的说明。 */
function keyOf(e, strict, uniq) {
  const time = e.time == null ? `\u0000NO_TIME:${uniq}` : String(e.time);
  return strict ? `${e.kind}\u0000${time}` : `${e.kind}\u0000${time}\u0000${e.seq ?? ''}`;
}

/**
 * 事件级去重。
 *
 * ⚠️ **`time` 缺失时的行为**：严格模式 `(kind, time)` 若把缺失的 `time` 都当成 `null`，
 * 会把"同 kind 的所有事件"折叠成一条 —— 这不是去重，是数据销毁。
 * 所以缺失 `time` 的事件被赋予**唯一哨兵**，永远不会被判定为副本；
 * 同时返回值里给 `missingTime` 与 `strictReliable: false`，让调用方知道这一档不可信。
 *
 * @param {Array<object>} events 事件数组（可以先过 `loadEvents`）
 * @param {object} [opts]
 * @param {boolean} [opts.strict=false] 用 `(kind, time)` 双元组（更激进，作为上界）
 * @returns {{
 *   events: object[], duplicates: number, sidsOf: Record<string, string[]>,
 *   totalInput: number, missingTime: number, strictReliable: boolean
 * }}
 *   - `events`：去重后保留的事件，每个带 `copies`（副本数，含自己）与 `sids`（出现过的会话）
 *   - `duplicates`：被丢掉的副本条数
 *   - `sidsOf`：`{去重键: [会话id...]}`
 */
export function dedupe(events, opts = {}) {
  const { strict = false } = opts;
  const seen = new Map();
  const out = [];
  let missingTime = 0;

  const list = (events ?? []).map((e) => (e && e.raw ? e : normEvent(e))).filter(Boolean);

  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.time == null) missingTime++;
    const key = keyOf(e, strict, i);
    const hit = seen.get(key);
    if (hit) {
      hit.copies++;
      if (e.session != null && !hit.sids.includes(e.session)) hit.sids.push(e.session);
      continue;
    }
    const rec = {
      ...(e.raw ?? {}),
      session: e.session,
      seq: e.seq,
      kind: e.kind,
      time: e.time,
      text: e.text,
      copies: 1,
      sids: e.session == null ? [] : [e.session],
      dedupeKey: key,
    };
    seen.set(key, rec);
    out.push(rec);
  }

  const sidsOf = {};
  for (const e of out) sidsOf[e.dedupeKey] = e.sids;

  return {
    events: out,
    duplicates: list.length - out.length,
    sidsOf,
    totalInput: list.length,
    missingTime,
    strictReliable: missingTime === 0,
  };
}

/**
 * 判定一个会话的来源。
 *
 * 规则（先写死，不接受"看情况"）：
 * 1. `origin === 'subagent'` ⇒ `subagent`（最高优先：子代理的 user 通道不是用户）
 * 2. 否则有父会话 ⇒ `fork`
 * 3. 否则 ⇒ `user`（血缘根）
 *
 * @param {{session?: string, origin?: string, parent?: string, parentSession?: string}} record
 * @returns {'user'|'fork'|'subagent'|'unknown'}
 */
export function classifyOrigin(record) {
  if (!record || typeof record !== 'object') return 'unknown';
  const origin = record.origin == null ? '' : String(record.origin).toLowerCase();
  const parent = record.parent ?? record.parentSession ?? null;
  if (origin === 'subagent') return 'subagent';
  if (origin === 'fork') return 'fork';
  if (parent) return 'fork';
  if (origin === '' || origin === 'user') return 'user';
  return 'unknown';
}

/**
 * 把 `sessions.json` 规格化成 `Map<session, {origin, parent}>`。
 * 接受两种形状：对象映射 `{"s1": {...}}`，或数组 `[{"session":"s1", ...}]`。
 * @param {object|Array} meta
 * @returns {Map<string, {origin: string, parent: string|null}>}
 */
export function normalizeMeta(meta) {
  const map = new Map();
  if (!meta) return map;
  // 幂等：已经规格化过的 Map 直接返回。否则 `filterByOrigin` 会把自己产出的 Map
  // 再喂一次 `Object.entries`（结果为空）⇒ 所有事件都被判成 unknown ⇒ 静默筛成 0 条。
  if (meta instanceof Map) return meta;
  const entries = Array.isArray(meta)
    ? meta.map((r) => [r?.session, r])
    : Object.entries(meta).map(([k, v]) => [k, { ...(v ?? {}), session: v?.session ?? k }]);
  for (const [sid, rec] of entries) {
    if (sid == null) continue;
    map.set(String(sid), {
      origin: classifyOrigin(rec),
      parent: rec?.parent ?? rec?.parentSession ?? null,
    });
  }
  return map;
}

/**
 * 取一个事件的来源：事件自带的 `origin`/`parent` 优先，其次查 `meta`。
 * @returns {'user'|'fork'|'subagent'|'unknown'}
 */
export function originOfEvent(event, meta) {
  if (!event || typeof event !== 'object') return 'unknown';
  if (event.origin != null || event.parent != null) {
    const o = classifyOrigin(event);
    if (o !== 'unknown') return o;
  }
  const m = normalizeMeta(meta);
  const rec = m.get(String(event.session));
  return rec ? rec.origin : 'unknown';
}

/**
 * 按来源筛选。
 *
 * `origins` 默认 `['user']` —— **保守默认**：宁可少算，不要数了不该数的东西。
 * 想显式包含子代理，就写 `['user','subagent']`，别依赖默认值。
 *
 * @param {Array<object>} events
 * @param {string|string[]} [origins=['user']]
 * @param {object|Array} [meta] `sessions.json` 的内容（可选；事件自带 origin 时可不传）
 * @returns {object[]} 过滤后的事件（原对象引用，不做拷贝）
 */
export function filterByOrigin(events, origins = ['user'], meta = null) {
  const want = new Set(
    (Array.isArray(origins) ? origins : [origins]).map((o) => String(o).toLowerCase()),
  );
  const m = normalizeMeta(meta);
  return (events ?? []).filter((e) => want.has(originOfEvent(e, m)));
}

/**
 * 来源分布统计（用于把"剔除了多少"**如实报出来**，而不是静默丢弃）。
 * @returns {{total: number, byOrigin: Record<string, number>, dropped: number, kept: number, keptOrigins: string[]}}
 */
export function originBreakdown(events, origins = ['user'], meta = null) {
  const want = new Set(
    (Array.isArray(origins) ? origins : [origins]).map((o) => String(o).toLowerCase()),
  );
  const m = normalizeMeta(meta);
  const list = events ?? [];
  const byOrigin = {};
  let kept = 0;
  for (const e of list) {
    const o = originOfEvent(e, m);
    byOrigin[o] = (byOrigin[o] ?? 0) + 1;
    if (want.has(o)) kept++;
  }
  return {
    total: list.length,
    byOrigin,
    kept,
    dropped: list.length - kept,
    keptOrigins: [...want],
  };
}

export default { loadEvents, dedupe, classifyOrigin, filterByOrigin };
