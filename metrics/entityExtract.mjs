/**
 * entityExtract.mjs —— 模块 4：**实体抽取**（"报告里的事实能否回原文核对"）
 *
 * 用途：报告（agent 写的总结/结论）里出现的 URL、路径、版本号、大数字、ASCII 引句，
 * 应该能**回到原文里逐字找到**。找不到的那些，就是"先验拉力"的候选
 * （模型把记忆/常识当成了观测）。这一模块只负责**抽准**，不负责下结论。
 *
 * ## 为什么"斜杠分隔的评分列表"是这一模块的头号敌人
 *
 * 第一版判据用了"路径候选 = 至少两段被 `/` 分开的标识符"，于是把散文里的斜杠当成了路径：
 * `12.5/88/3x`、`AG/MR/HR` 这类**评分列表 / 缩写并列**全部被当成文件路径。
 * 后果不是措辞问题 —— 分母被灌了假实体，"实体回溯率"整个读数作废。
 *
 * ⇒ 本模块的判据**分类型、按顺序**判定，任一条不成立即拒：
 *
 * ### URL
 * - 有 scheme 的（`https://…`）；
 * - **无 scheme 的主机前缀**（`host.tld/path…`）：首段含点、所有标签是字母数字连字符、
 *   **末标签必须是纯字母**（`com`/`io`/`org`/`dev`…）。这类东西**段形上像路径**，
 *   必须分流到 `url:`，否则会污染 `path` 与 `url` 的类型拆分。
 *
 * ### 路径
 * - **本地绝对路径**（`/…` 或 `~/…`）：决定性证据是 `existsSync`；
 *   文件可能已删/尚未创建，所以**父目录存在**也算接受；两者都不成立 ⇒ 拒。
 * - **相对路径**：段形合格（标识符样式、**无纯数字段**）**且末段带已知扩展名**。
 *
 * ### 段频（segment frequency）
 * 统计"本语料里每个路径段出现了几次"。真路径的上级目录名会反复出现。
 *
 * ⚠️ **段频只能当否决权，不能当许可证。**
 * 把"某段出现过多次"当成**接受**规则，就会放行 `12.5/88/3x`（因为 `88` 出现过两次）。
 * 所以它只在**已经通过形状与扩展名闸门**之后，用来**拒**：
 * 每一段的段频都 ≤ 1 ⇒ 疑似散文斜杠 ⇒ 拒。
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { normalize } from './coverage.mjs';

/**
 * 候选正则。三者的**前视/后视都很重要**，不是装饰：
 *
 * - 没有后视时，`ops/systemd/x.timer` 会**同时**产出绝对候选 `/systemd/x.timer`；
 *   `https://a.b/c/d` 会额外产出绝对候选 `/a.b/c/d`；
 *   `/no/such/dir/f.txt` 会额外产出**相对**候选 `no/such/dir/f.txt` —— ，
 *   最后这一条更糟：它会让一条"因不存在而被拒"的绝对路径，**换个身份被接受**。
 * - 后视类里必须同时含 `/` 与 `:`，否则上面第二、三条挡不住。
 */
const ABS_RE = /(?<![\w.@+~:/-])(?:\/[\w.@+-]{2,}){2,}\/?/g;
/** 相对路径候选：≥2 段（`config/ledger.yaml` 也应当能被抽到） */
const REL_RE = /(?<![\w.@+~:/-])(?:[\w.@+-]{2,}\/)+[\w.@+-]{2,}/g;
/** `~/…` 家目录形式（`~user/…` 不支持，属于已知边界） */
const HOME_RE = /(?<![\w.@+~:/-])~\/[\w.@+-]{2,}(?:\/[\w.@+-]{2,})*/g;
/** 有 scheme 的 URL */
const SCHEME_URL_RE = /[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>()[\]{}，。；、）】]+/gi;
/** 版本号 */
const VER_RE = /\bv?\d+\.\d+(?:\.\d+)*\b/g;
/** ≥3 位数字 */
const NUM_RE = /\b\d{3,}\b/g;
/** ASCII 引句：被成对引号包住、长度 ≥40 的纯 ASCII 内容 */
const QUOTE_RE = /["'`“”‘’「」『』]([\x20-\x7E]{40,}?)["'`“”‘’「」『』]/g;

/**
 * 扩展名白名单 —— **相对路径必须以此之一结尾**。
 * 白名单而非黑名单：黑名单永远漏，而漏掉的代价是假实体进分母。
 */
export const KNOWN_EXT = new Set([
  'mjs', 'cjs', 'js', 'jsx', 'ts', 'tsx', 'json', 'jsonl', 'ndjson', 'md', 'markdown', 'txt',
  'py', 'rb', 'rs', 'go', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php',
  'sh', 'bash', 'zsh', 'ps1', 'bat', 'sql', 'graphql', 'proto',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'lock', 'csv', 'tsv', 'xml', 'html', 'htm',
  'css', 'scss', 'less', 'vue', 'svelte', 'tex', 'rst', 'diff', 'patch', 'log', 'zst', 'zstd',
  'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico',
  'pdf', 'mp3', 'mp4', 'wav', 'woff', 'woff2', 'ttf', 'otf',
  // systemd 单元与常见数据/制品格式（白名单里没有它的后果是：真路径被拒，读数偏低）
  'timer', 'service', 'socket', 'target', 'mount', 'parquet', 'npy', 'npz', 'pkl', 'sqlite',
]);

/** `~` 展开（唯一会碰 `homedir()` 的地方；不写死任何绝对路径） */
function expandPath(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return homedir() + p.slice(1);
  return p;
}

/**
 * 无 scheme 的主机前缀判定：`raw.githubusercontent.com/…`、`docs.example.org/guide`
 *
 * 判据：首段（`/` 之前）含点；至少两个标签；标签只含字母数字与 `-`；
 * **末标签是纯字母**（`com`/`io`/`org`/`dev`/`ai`…）。末标签为纯字母这条会把
 * `config/ledger.yaml`（首段 `config` 不含点）与 `v1.2.3/x`（末标签非纯字母）都排除掉。
 *
 * @param {string} p
 * @returns {boolean}
 */
export function looksLikeHostPath(p) {
  const first = String(p ?? '').split('/')[0];
  if (!first || !first.includes('.')) return false;
  const labels = first.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((l) => /^[a-z0-9-]+$/i.test(l))) return false;
  return /^[a-z]{2,24}$/i.test(labels[labels.length - 1]);
}

/** 段形闸门：每段标识符样式、长度 ≥2、**不得是纯数字**（挡掉评分列表） */
export function shapeOk(p) {
  const segs = String(p ?? '').split('/').filter((s) => s && s !== '~');
  if (segs.length < 2) return false;
  return segs.every((s) =>
    s.length >= 2 && /^[\w.@+-]+$/.test(s) && !/^\d+(\.\d+)?$/.test(s));
}

/**
 * 相对路径接受条件：段形合格 **且** 末段带已知扩展名。
 * @param {string} p
 * @returns {boolean}
 */
export function relativeOk(p) {
  if (!shapeOk(p)) return false;
  const last = String(p).split('/').filter(Boolean).pop() ?? '';
  const dot = last.lastIndexOf('.');
  if (dot <= 0) return false;
  return KNOWN_EXT.has(last.slice(dot + 1).toLowerCase());
}

/**
 * 段频统计：本语料全部路径候选拆段后的计数。
 * @param {string[]} [texts]
 * @returns {Map<string, number>}
 */
export function segmentFrequency(texts) {
  const freq = new Map();
  for (const t of texts ?? []) {
    const s = normalize(t);
    for (const m of [...(s.matchAll(ABS_RE) ?? []), ...(s.matchAll(HOME_RE) ?? []), ...(s.matchAll(REL_RE) ?? [])]) {
      for (const seg of m[0].split('/')) {
        if (!seg || seg === '~') continue;
        freq.set(seg, (freq.get(seg) ?? 0) + 1);
      }
    }
  }
  return freq;
}

/**
 * 抽候选并按判据分流。
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string[]} [opts.corpusTexts] 本语料文本（给了才启用段频**否决**）
 * @returns {{url: string[], path: string[], rejected: Array<{candidate: string, reason: string}>}}
 */
export function extractPaths(text, opts = {}) {
  const s = normalize(text);
  const { corpusTexts } = opts;
  const freq = corpusTexts ? segmentFrequency(corpusTexts) : null;

  const url = new Set();
  const path = new Set();
  const rejected = [];

  for (const m of s.matchAll(SCHEME_URL_RE)) url.add(m[0]);

  const cands = new Set();
  for (const m of s.matchAll(ABS_RE)) cands.add(m[0]);
  for (const m of s.matchAll(HOME_RE)) cands.add(m[0]);
  for (const m of s.matchAll(REL_RE)) cands.add(m[0]);

  for (const cand of cands) {
    const p = cand.replace(/\/$/, '') || cand;

    // 先把"无 scheme 的主机前缀"分流出去（否则它会以路径身份混进 path）
    if (!p.startsWith('/') && !p.startsWith('~/') && looksLikeHostPath(p)) {
      url.add(p);
      continue;
    }

    if (p.startsWith('/') || p.startsWith('~/')) {
      if (!shapeOk(p)) {
        rejected.push({ candidate: p, reason: '绝对路径：段形不合格（含纯数字段或非法字符）' });
        continue;
      }
      const abs = expandPath(p);
      if (existsSync(abs)) { path.add(p); continue; }
      if (existsSync(dirname(abs))) { path.add(p); continue; }
      rejected.push({ candidate: p, reason: '绝对路径：不存在且父目录也不存在' });
      continue;
    }

    if (!relativeOk(p)) {
      rejected.push({
        candidate: p,
        reason: shapeOk(p)
          ? '相对路径：末段无已知扩展名（疑似斜杠列表或缩写并列）'
          : '相对路径：段形不合格（含纯数字段或非法字符）',
      });
      continue;
    }
    if (freq) {
      const segs = p.split('/').filter(Boolean);
      if (segs.every((seg) => (freq.get(seg) ?? 0) <= 1)) {
        rejected.push({ candidate: p, reason: '相对路径：每一段的段频都 ≤1（疑似散文斜杠）' });
        continue;
      }
    }
    path.add(p);
  }

  return { url: [...url], path: [...path], rejected };
}

/** 去重并保持首次出现顺序 */
function uniq(list) {
  const seen = new Set();
  const out = [];
  for (const x of list) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

/**
 * 实体抽取。
 *
 * @param {string} text 要抽的文本（通常是 agent 写的报告）
 * @param {object} [opts]
 * @param {string[]} [opts.corpusTexts] 本语料原文（启用段频**否决**；不给则该闸门关闭）
 * @param {boolean} [opts.withRejected=false] 是否附带被拒候选及理由（审计用）
 * @returns {{url: string[], path: string[], ver: string[], num: string[], quote: string[], rejected?: Array}}
 */
export function extractEntities(text, opts = {}) {
  const s = normalize(text);
  const { url, path, rejected } = extractPaths(s, opts);

  const ver = uniq([...s.matchAll(VER_RE)].map((m) => m[0]));
  const num = uniq([...s.matchAll(NUM_RE)].map((m) => m[0]));
  const quote = uniq([...s.matchAll(QUOTE_RE)].map((m) => m[1]));

  const out = { url: uniq(url), path: uniq(path), ver, num, quote };
  if (opts.withRejected) out.rejected = rejected;
  return out;
}

/**
 * 回原文核对：报告里的实体有多少能在语料里逐字找到。
 * **每个数都带分母**（这里是它的用处：不是"回溯率 82.8%"这种没分母的读数）。
 *
 * @param {{url: string[], path: string[], ver: string[], num: string[], quote: string[]}} entities
 * @param {string[]|string} corpusTexts
 * @returns {{byType: Record<string, {total: number, found: number, rate: number|null}>, total: number, found: number, rate: number|null}}
 */
export function verifyAgainstCorpus(entities, corpusTexts) {
  const texts = Array.isArray(corpusTexts) ? corpusTexts : [corpusTexts ?? ''];
  const blob = texts.map((t) => String(t)).join('\n');
  const byType = {};
  let total = 0;
  let found = 0;
  for (const [type, list] of Object.entries(entities ?? {})) {
    if (!Array.isArray(list)) continue;
    const hit = list.filter((x) => blob.includes(x)).length;
    byType[type] = { total: list.length, found: hit, rate: list.length ? hit / list.length : null };
    total += list.length;
    found += hit;
  }
  return { byType, total, found, rate: total ? found / total : null };
}

export default extractEntities;
