# metrics · 压缩测量内核（零依赖）

一个**与 harness 无关**的测量内核：只回答"压缩到底压掉了什么、压得好不好"，
不关心你用的是哪个 agent、哪种日志格式。

- **语言**：JavaScript（ESM，`.mjs`）
- **依赖**：**零第三方依赖**，只用 Node 标准库（`node:fs` / `node:path` / `node:os`）
- **运行环境**：Node 22（`node --test metrics/` 全绿）
- **纯函数**：五个模块都不读盘（唯一例外：模块 4 的绝对路径判据要用 `existsSync`）；
  读文件全部在 `cli.mjs` 里做

```bash
node --test metrics/          # 跑测试
node metrics/cli.mjs --help   # 看用法
```

---

## 1. 输入契约

### `events.jsonl` —— 事件流（每行一个 JSON）

```json
{"session":"s1","seq":12,"kind":"user","text":"..."}
```

| 字段 | 必填 | 含义 |
|---|---|---|
| `session` | 是 | 会话 id。模块 2 靠它分组、模块 3 靠它判来源 |
| `seq` | 是 | 会话内单调递增的序号。**窗口（`--from/--to`）就是按它切的** |
| `kind` | 是 | `user` / `assistant` / `tool` / `compaction` |
| `text` | 是 | 文本。`kind=compaction` 时可放事件名（如 `start` / `end`） |
| `time` | 否 | 时间戳（毫秒级整数最常见）。**只有模块 3 的去重要用它**，缺了会降级（见 §4） |

`kind` 的语义约定：

- `user` = **用户发言**。模块 1 的分母只收这一类，模块 2 的单元也只收这一类。
- `assistant` = agent 发言。模块 2 用它做"上一条 assistant 消息"这个锚。
- `tool` = 工具调用/输出。**当前不被任何指标当单位**（它既不是用户的意图，也不是 agent 的承诺）。
- `compaction` = 一次压缩边界。用来切窗口，不参与文本度量。

容错：空行跳过；**半行**（JSON 不完整，正在写入的日志）跳过并计数。
解析器返回 `{events, total, skipped, skippedLines}`，`total` 是**非空行数**。
跳过多少行一定要看 —— 静默丢行和静默放大是同一种错误。

字段别名：`type`→`kind`、`ts`/`timestamp`/`t`→`time`、`parentSession`→`parent`、`sequence`→`seq`。

### `checkpoint.txt` —— 压缩产出的摘要

纯文本。实现按**字符串**接收，不做任何格式假设（markdown / 纯段落都行）。
模块内部先归一化（去首尾空白、连续空白折成一个空格）再度量，所以排版差异不会被记成"内容丢失"。

### `compact-ranges.json` —— 压缩区间表（可选）

```json
[{"session":"s1","start":100,"end":900,"checkpoint":"ck.txt",
  "shadowedTokens":48120,"summaryTokens":1490,"events":37}]
```

模块 5 直接吃这份表；`shadowedTokens` / `summaryTokens` / `events` 三个字段就是它的全部输入。

---

## 2. 五个模块各测什么

### 模块 1 `coverage.mjs` —— 逐字覆盖

> **压缩之后，用户说过的话还有多少字面留存？**

- **单位**：窗口内 `kind=user` 的发言
- **归一化**：去首尾空白 + 连续空白折成一个空格；长度按**归一化后的 Unicode 码点**计
  （emoji 算 1 个字符，不算 2 个 —— 阈值比较与 `lcs/len` 用同一个口径）
- **分母**：归一化长度 **≥ 阈值** 的发言。**短于阈值的必须剔除**
- **命中**：`LCS(发言, 摘要) ≥ 阈值`
- **两档**：严格 **30**（主指标）、宽松 **12**（参考）
- 导出：`lcs(a,b)`、`lcsBound(a,b)`、`normalize(s)`、`charLength(s)`、`coverage(utterances, checkpoint, {threshold})`

为什么分母要剔短发言：不是"短发言不重要"，而是 **LCS 对它们数学上不可达**。
一条 8 个字的发言，`LCS ≤ 8 < 30`，它**永远**不可能命中严格档。
把它留在分母里，等于往分母里掺必然失败的样本 ——
覆盖率最后由**发言长度的分布**决定，而不是由压缩质量决定
（`test/coverage.test.mjs` 里有一条反证：同一份数据，关掉这道闸门，读数从 100% 掉到 10%）。

返回值里 `rate` / `meanLcsRatio` 在**分母为 0 时是 `null` 而不是 `0`**。
`0/0` 没有比率：把空分母打成 `0.0%` 是最常见的一种读数污染。
另外还给出 `topShare`（LCS 总量里最大那一条占多少）—— 接近 1 说明这个"覆盖率"
其实是由**单条长发言**决定的。

### 模块 2 `turnFidelity.mjs` —— 回合级保真

> **用户的短发言是回指，它的含义挂在上一轮 agent 说的话上。
> 摘要丢掉那段话之后，这条发言在摘要里就成了一个没有所指的短语。**

模块 1 测不到这类损失（发言太短，够不着阈值）。所以按长度分三组：

| 组 | 判据（归一化长度） | 判什么 |
|---|---|---|
| `DEP` | `≤ 12` | **回指型** → 判「所指有痕」 |
| `SELF` | `≥ 20` | **自足型** → 判「自身存活」 |
| `MID` | `12 < len < 20` | **只报告，不判定**（这条带上的样本太少，判了就是编） |

- **自身存活**：`LCS(发言, 摘要) ≥ 8`
- **所指有痕**：取该发言**上一条 assistant 消息的末 2,000 字符**，切成 **12-gram 集合**
  （按码点滑窗、去重），命中率 = 出现在摘要里的 gram 比例，**≥ 10% 记"有痕迹"**
- 导出：`grams(text,n)`、`tail(text,k)`、`referentLink(utterance, prevAssistant, checkpoint, {anchorChars=2000,n=12,minRate=0.10})`、`turnFidelity(events, checkpoint, {from,to,...})`

两类**不判**的情形会显式给出理由（`judged:false` + `reason`），而不是默认成 `false`：

- `no-previous-assistant`：这条发言之前没有 assistant 消息（它就是第一句，本来就不是回指）
- `anchor-shorter-than-n`：锚文本不足 n 个字，构不出任何 n-gram
- `empty-utterance`：归一化后为空的发言（它没有所指可丢）

`from` / `to` **只筛"哪些发言算单元"**；找锚时用的是**完整事件流**，
所以窗口左边界的发言也能拿到正确的锚 —— 而压掉那个锚的压缩，往往就发生在窗口左边界之前。

### 模块 3 `corpus.mjs` —— 语料卫生（最容易被忽略、后果最重）

前两个模块算的都是**比值**，分子分母都从语料里数出来。语料脏了，比值可以完全正确而结论完全错。

**污染源 1：fork 复制。** 会话被 fork 时，**父会话的事件会被原文拷进子会话的种子区**，
于是父会话的每一次压缩、每一次裁剪，都在每个子会话里各出现一次。实测（未去重口径）：

| 口径 | 压缩事务 | 裁剪 token |
|---|---|---|
| 直接数事件 | **73** | **930,205** |
| 事件级去重后 | **33** | **302,945** |

放大 **3.1 倍**；"失败事务 15 个"里有 11 个是**同一次失败的副本**。

判据（先写死）：**同 `(kind, time, seq)` 的事件在别的会话里也出现，就判为副本。**

- 用三元组而不是单个 `time`：真实的不同事件可能落在同一毫秒（实测确实存在）。
  退化口径 `strict: true`（`(kind,time)`）会**误伤**这种事件 —— 所以要两个口径一起报，
  避免"挑一个对自己有利的分母"。
- **不做"整会话排除"**：fork 种子区**之后**的事件是该会话自己产生的，排除整会话会丢真样本。
- 没有 `time` 字段时，事件被赋予**唯一哨兵**，永远不会被判成副本；
  同时返回 `strictReliable: false`。否则 `(kind,time)` 会把"同 kind 的全部事件"折成一条 ——
  那不是去重，是数据销毁。

**污染源 2：来源混淆（去重救不了）。** 子代理（subagent）收到的"用户发言"
其实是**父代理下发的委派提示词**，走的是同一条 user 通道。只读类任务的提示词
几乎必然含"不要修改…"之类的否定词，于是任何"用户不满/纠正率"类指标在子代理会话上都是假的。
实测某次 33 条价值信号 **33/33 全被判成 NEG**，总体里 26/31 是 subagent。

⇒ **数重了可以靠去重救；数了不该数的东西，只能靠按来源剔除。**

```
{"session":"s1","origin":"user"|"subagent"|"fork","parent":"s0"}
```

`classifyOrigin` 的规则（先写死）：`origin==='subagent'` ⇒ `subagent`（最高优先）；
否则有父会话 ⇒ `fork`；否则 ⇒ `user`。`filterByOrigin(events, origins, meta)` 默认只保留
`['user']` —— **保守默认**：宁可少算，不要数了不该数的。它同时返回/配套
`originBreakdown`，把"剔掉了多少"如实报出来，而不是静默丢弃。

- 导出：`loadEvents(text)`、`loadEventsDetailed(text)`、`dedupe(events,{strict})`、`classifyOrigin`、`normalizeMeta`、`originOfEvent`、`filterByOrigin`、`originBreakdown`

### 模块 4 `entityExtract.mjs` —— 实体抽取

> **报告里的事实，能否回到原文逐字核对？**

抽 URL、本地/相对路径、版本号、≥3 位数字、≥40 字符的 ASCII 引句。
用于把"先验拉力"（模型把记忆当成了观测）变成可比对的候选。

**头号敌人是"斜杠分隔的评分列表"**：第一版判据把"两个 `/` 分开的标识符"当路径，
于是 `12.5/88/3x`、`AG/MR/HR`、`Completed/Active` 全被当成文件路径，
分母被灌了假实体，整个读数作废。

判据（分类型、按顺序，任一条不成立即拒）：

| 类型 | 判据 |
|---|---|
| URL（有 scheme） | `scheme://…` |
| URL（无 scheme 的主机前缀） | 首段含点、标签只含字母数字与 `-`、**末标签纯字母**（`raw.githubusercontent.com/…`） |
| 本地绝对路径 | `existsSync(路径)` **或** `existsSync(父目录)`（文件可能已删/尚未创建）；两者都不成立 ⇒ 拒 |
| 相对路径 | **段形合格**（标识符样式、**无纯数字段**）**且** 末段带**已知扩展名**（白名单） |

**段频只能当否决权，不能当许可证。** 统计"本语料里每个路径段出现了几次"，
真路径的上级目录名会反复出现。但它**只在已经通过形状与扩展名闸门之后**用来**拒**：
每一段的段频都 ≤1 ⇒ 疑似散文斜杠。反过来把"某段出现过多次"当**接受**规则，
`12.5/88/3x` 就会因为 `88` 出现过两次而被放行（这是真踩过的坑，测试里钉住了）。

- 导出：`extractEntities(text,{corpusTexts})` → `{url,path,ver,num,quote}`、
  `extractPaths`、`looksLikeHostPath(p)`、`shapeOk(p)`、`relativeOk(p)`、
  `segmentFrequency(texts)`、`verifyAgainstCorpus(entities, texts)`、`KNOWN_EXT`

### 模块 5 `degenerate.mjs` —— 退化压缩探测

> **这次压缩是不是空转？报 success 不等于压掉了东西。**

| 标记 | 条件 | 含义 |
|---|---|---|
| `INFLATED` | `shadowedTokens ≤ summaryTokens`（两者都 >0 才判） | 摘要**不小于**被替换的内容 ⇒ 压缩后上下文更长 |
| `TINY-SPAN` | `events ≤ 2` | 只遮蔽 0–2 个事件 ⇒ 几乎没压 |
| `SMALL-SPAN` | `shadowedTokens < 2000` | 跨度偏小（绝对门槛） |

- 三条判据**彼此独立**求值，一次事务可以同时命中多条，**都报出来**（不做 `else if`）：
  形态信息本身就是结论的一部分，隐藏它会让"退化率"这个数变得不可解释。
- 字段缺失（`null` / `undefined`）时**不判**，并把它列进 `notJudged`。
  ⚠️ 注意 `Number(null) === 0`：把缺失当 0 会让"没有数据"被读成"遮蔽 0 个事件 ⇒ 退化"。
- 导出：`detectDegenerate({shadowedTokens,summaryTokens,events})` → `{degenerate,reasons[],notJudged[],details}`、`detectDegenerateBatch`

这是**探测器**，不是检查器：只读地找出已经发生的退化压缩，给出频率与形态。
把引擎改成"退化时报 no-op 而不是 success"是另一个决定（要动引擎）。

---

## 3. CLI

```bash
node metrics/cli.mjs coverage  --events events.jsonl --checkpoint ck.txt --from 100 --to 900 [--threshold 30]
node metrics/cli.mjs referent  --events events.jsonl --checkpoint ck.txt --from 100 --to 900
node metrics/cli.mjs corpus    --events events.jsonl --meta sessions.json
node metrics/cli.mjs entities  --text report.txt
node metrics/cli.mjs degenerate --ranges compact-ranges.json     # 模块 5（模块 5 没有对应的一行契约）
```

各命令的附加开关（`--json` 通用，输出可直接喂给别的程序）：

| 命令 | 开关 |
|---|---|
| `coverage` | `--loose 12` `--session S` `--rows` |
| `referent` | `--anchor 2000` `--n 12` `--min-rate 0.10` `--session S` `--rows` |
| `corpus` | `--origins user,fork,subagent` `--strict` |
| `entities` | `--corpus a.txt[,b.txt]`（给语料才启用段频否决） `--rejected` |

约定：

- 路径一律**相对当前工作目录**解析。
- **每个数都带分母**（`命中 4/6 = 66.7%`）。分母为 0 时打印 `n/a`。
- 退出码：`0` 正常运行（**即使分母为 0 或检出退化压缩** —— 那是测量结果，不是失败）；
  `2` 用法错误 / 文件读不到。

---

## 4. 已知边界

**这是代理指标的：**

- **`referentLink`（模块 2 的"所指有痕"）** —— 用上一条 assistant 消息**末段**的
  12-gram 命中率，近似"这条短发言的所指还在不在"。它**既会漏**（摘要换了措辞复述同一件事，
  逐字 gram 不命中，但所指其实在）**也会高估**（只是共享了同一批标识符/路径）。
  不用 LCS 的原因很工程：assistant 消息可达上万字，`O(n·m)` 的 DP 在整批语料上不可行。
  所以 `turnFidelity` 的输出里**必须**带 `proxy: true` 与 `proxyNote`，
  下游引用时要连着"这是代理指标"一起引用。
- **模块 4 的实体集合**只说明"这些字符串出现在报告里"，**不说明**它们是真是假。
  它给的是**候选**，核对要人来做。

**阈值是经验值，不是理论值：**

| 阈值 | 值 | 依据 |
|---|---|---|
| 覆盖严格档 | 30 | 一段能独立阅读的最短长度（经验） |
| 覆盖宽松档 | 12 | 只用于对比，量化"片段被收录"冒充"判据被保留"的空间 |
| DEP / SELF 分界 | 12 / 20 | 中间的 12–20 带样本太少，**故意不判定** |
| 自身存活 | LCS ≥ 8 | 低于此长度"存活"没有意义 |
| 锚长度 | 2,000 字符 | 再长就被噪声稀释（测试里有反证：换成整条消息判定会翻转） |
| n-gram | 12 | 中文里 12 字约等于一个短句；英文偏长 |
| 有痕门槛 | 0.10 | 经验值，且**故意设得低**：宁可放过，不要错杀 |
| `TINY-SPAN` / `SMALL-SPAN` | 2 事件 / 2,000 token | **跑之前写死**，不随结果回改 |

**其他边界（都写进测试钉住了）：**

- `lcs` 是**精确**的 `O(n·m)` DP（滚动两行 + 交换，行宽取较短一侧）。**没有**复杂度上限：
  拿一条几千字的发言去比一份几万字的摘要会明显变慢。需要预筛时用 `lcsBound`（廉价上界：
  `bound < threshold` ⇒ 必然不命中；但 `bound ≥ threshold` **不能**宣称命中）。
- 版本号规则 `v?\d+\.\d+(\.\d+)*` 会**吃进小数**：`0.05`、`12.5` 都会被当成版本号。
  这是已知边界，复核 `ver` 时要看上下文。
- `num`（≥3 位数字）会从 `2024-migrations.sql` 里抽出 `2024`，也会从 URL/版本号里抽数字。
- `quote` 只认**单行、纯 ASCII、≥40 字符、成对引号**包住的内容；多行引句抽不到。
- 相对路径必须落在扩展名白名单里。**白名单里没有的扩展名会导致真路径被拒**（读数偏低），
  而不是假路径被收（读数偏高）—— 这是刻意的方向选择。
- `~/…` 支持，`~user/…` 不支持。
- 绝对路径判据会真的去 `existsSync`。**测量结果依赖运行环境**（同一个文本在另一台机器上
  可能给出不同的 `path` 集合）；要可复现就得固定语料与夹具。
- 模块 1/2 只看 `kind=user`。**agent 自己的话被压掉不算损失**（那是设计意图）；
  `tool` 事件目前不被任何指标当单位。
- `turnFidelity` 按 `(session, seq)` 排序后找锚；`seq` 缺失时保持输入顺序。
- 覆盖率的两档**必须连着分母一起引用**。同一次压缩，严格档和宽松档可以差 20 个百分点以上
  （夹具里是 66.7% vs 85.7%），只报一个数没有意义。

---

## 5. 最小示例

夹具**全部是自造的合成数据**（虚构项目 `orbit-ledger`、保留域名、编造发言），
放在 `fixtures/`，不包含任何真实语料。

```
fixtures/
  events.jsonl          16 行：11 条用户发言 + assistant/tool/compaction
  checkpoint.txt        合成摘要（归一化后 581 字符）
  events-forked.jsonl   18 行 / 4 个会话：fork 种子副本 + 子代理委派提示词
  sessions.json         会话来源表
  report.txt            合成报告：URL / 路径 / 版本号 / 数字 / 引句 + 若干"必须被拒"的斜杠列表
  compact-ranges.json   2 次压缩事务（1 次正常、1 次退化）
```

从仓库根目录跑：

```bash
cd metrics

node cli.mjs coverage --events fixtures/events.jsonl --checkpoint fixtures/checkpoint.txt --from 100 --to 900
```

预期输出（下面每一行都是 `node --test metrics/` 里断言过的实际输出）：

```
# 逐字覆盖（模块 1）
事件文件   fixtures/events.jsonl（共 16 行，解析 16 条）
摘要文件   fixtures/checkpoint.txt（归一化后 581 字符）
窗口       seq ∈ [100, 900]
单位       用户发言 10 条

严格档（阈值 30）  命中 4/6 = 66.7%   被剔除（长度不足） 4/10 条
宽松档（阈值 12）  命中 6/7 = 85.7%   被剔除（长度不足） 3/10 条
meanLcsRatio（严格档分母上）  0.7727   最大 1.0000
支配度 topShare  0.5133（其中 seq=160 一条占 51.3% 的 LCS 总量，len=256）
```

怎么读这一屏：

- **分母只有 6**：11 条用户发言里，4 条长度不足 30 被剔除（含 1 条全空白），另 1 条在窗口外（`seq=950`）。
- **严格 4/6 vs 宽松 6/7**：多出来的两条正是"严格 miss / 宽松 hit"的样本 ——
  `seq=170`（`lcs=29`，差 1 就够 30）和 `seq=140`（语义完全无关，只因为共享字符拿到 `lcs=15`）。
  后者就是宽松档会**高估**的地方：**"片段被收录"冒充"判据被保留"**。
- **topShare 0.51**：LCS 总量的一半来自 `seq=160` 这一条长发言。
  也就是说这个 66.7% 里，一半的"留存"由单条样本贡献 —— 报覆盖率时必须连着它一起报。

```bash
node cli.mjs referent --events fixtures/events.jsonl --checkpoint fixtures/checkpoint.txt --from 100 --to 900
```

```
# 回合级保真（模块 2）
事件文件   fixtures/events.jsonl（共 16 行，解析 16 条）
摘要文件   fixtures/checkpoint.txt（归一化后 581 字符）
窗口       seq ∈ [100, 900]
发言单元   9 条（空发言剔除 1 条）
判据       DEP ≤12 字 · SELF ≥20 字 · 自身存活 LCS ≥8 · 锚 2000 字符 / 12-gram / 门槛 10.0%
⚠️  referent link 是**代理指标**（见注释与 README「已知边界」），不可当作"所指被保留"的证明。

组                          单元      自身存活      所指有痕  未判  均命中率
DEP 回指型（≤12 字）           2      0/2 0.0%     1/2 50.0%     0     0.352
SELF 自足型（≥20 字）          6    6/6 100.0%      0/5 0.0%     1     0.000
MID 中间带（12<len<20）（只报告）     1      0/1 0.0%      0/1 0.0%     0     0.000

主判据：DEP → 所指有痕；SELF → 自身存活；MID → 只报告不判定。
注意：DEP 组的"自身存活"必然接近 0，因为不足 8 字的发言在数学上达不到 LCS ≥8。
```

- DEP 组 2 条：`seq=110`（上一条 assistant 消息与摘要高度重合 ⇒ 有痕）、
  `seq=120`（上一条 assistant 消息与摘要零重合 ⇒ 无痕）。
- SELF 组"所指有痕 0/5"不是发现，是**分母结构**：自足型发言的下一条 assistant 消息
  往往与摘要无关，这条指标对它们没有解释力 —— 所以 SELF 的主判据是"自身存活"。
- 未判 1 条：`seq=100` 之前没有 assistant 消息。

```bash
node cli.mjs corpus --events fixtures/events-forked.jsonl --meta fixtures/sessions.json
```

```
# 语料卫生（模块 3）
事件文件   fixtures/events-forked.jsonl（18 行，解析 18 条）
会话数     4
去重口径   宽松 (kind,time,seq)
去重后     事件 10/18 条（丢弃副本 8 条）
多副本事件 6/10 条，最多 3 份

来源筛选（保留 user）
  去重后  保留 6/10 = 60.0%
  未去重  保留 6/18 = 33.3%
  按来源  user 6 · fork 1 · subagent 3

说明：去重救"数重了"，来源筛选救"数了不该数的"（子代理的委派提示词走 user 通道）。
```

18 行里只有 10 个**真实事件**：`s-fork` / `s-fork2` 的 8 行是 fork 种子副本（其中一个事件有 3 份）。
再按来源剔掉 `fork` 与 `subagent`，只剩 `s-root` 的 6 条。
**去重 + 来源筛选一起用**才是"用户发言"的正确分母。

```bash
node cli.mjs entities --text fixtures/report.txt --rejected
```

```
# 实体抽取（模块 4）
文本       fixtures/report.txt
段频闸门   未启用（未给 --corpus ⇒ 相对路径不做段频否决）

url     3 条
        https://example.invalid/docs/ledger/reconcile
        raw.githubusercontent.com/acme-labs/orbit-ledger/main/README.md
        docs.example.org/guide/setup
path    4 条
        ops/systemd/orbit-reconcile.timer
        config/ledger.yaml
        db/archive/2024-migrations.sql
        scripts/run-ledger-checks.mjs
ver     5 条
        0.05
        v1.4.2
        0.5.1
        2.0
        12.5
num     3 条
        2024
        12345
        9876
quote   1 条
        the reconcile job must not touch the production schema at all

被拒候选 7 条（判据自查用）
  /nonexistent-placeholder/dir/file.txt  →  绝对路径：不存在且父目录也不存在
  34/34  →  相对路径：段形不合格（含纯数字段或非法字符）
  Completed/Active  →  相对路径：末段无已知扩展名（疑似斜杠列表或缩写并列）
  CLI/IDE  →  相对路径：末段无已知扩展名（疑似斜杠列表或缩写并列）
  gh/glab  →  相对路径：末段无已知扩展名（疑似斜杠列表或缩写并列）
  12.5/88/3x  →  相对路径：段形不合格（含纯数字段或非法字符）
  AG/MR/HR  →  相对路径：末段无已知扩展名（疑似斜杠列表或缩写并列）
```

- `raw.githubusercontent.com/…` 被记进 `url` 而**不是** `path`：段形上它像路径，
  分流错了会污染 `path` vs `url` 的类型拆分。
- `ver` 里的 `0.05` 与 `12.5` 是**小数被版本规则吃进去**的已知边界。
- 被拒清单不是垃圾：它是"判据在按预期拒绝"的证据。`12.5/88/3x` 必须在里面。

```bash
node cli.mjs degenerate --ranges fixtures/compact-ranges.json
```

```
# 退化压缩探测（模块 5）
事务文件   fixtures/compact-ranges.json
判据       INFLATED 遮蔽 ≤ 摘要 · TINY-SPAN 遮蔽事件 ≤2 · SMALL-SPAN 遮蔽 token <2000

退化事务   1/2 = 50.0%
按标记     INFLATED 1 · TINY-SPAN 1 · SMALL-SPAN 1
  #1 session=s1 [100..900] 遮蔽 48120 token / 37 事件，摘要 1490 token → 正常
  #2 session=s1 [910..911] 遮蔽 1500 token / 2 事件，摘要 2600 token → INFLATED,TINY-SPAN,SMALL-SPAN
```

第 2 次事务：遮蔽 1,500 token 却产出 2,600 token 的摘要 —— **压缩之后上下文更长了**，
但它当时会被记成 success。三条判据同时命中就是它退化的形态。

---

## 6. 测试

```bash
node --test metrics/          # 或在 metrics/ 下：node --test .
```

`test/` 下六个文件，覆盖：

| 文件 | 覆盖什么 |
|---|---|
| `coverage.test.mjs` | LCS 正确性（含 CLRS 经典用例、对称性、码点口径）、归一化、**有效分母剔除**、两档行为、空分母 `null`、范围过滤、支配度 |
| `turnFidelity.test.mjs` | n-gram 构造、`referentLink` 命中率算术与 0.10 门槛、三种"不判"、DEP/MID/SELF 分界、锚越过窗口 |
| `corpus.test.mjs` | 逐行容错解析、去重（宽松/严格）、缺 `time` 的降级、来源分类与筛选、`normalizeMeta` 幂等 |
| `entityExtract.test.mjs` | 主机前缀判定、绝对路径 `existsSync` 三条路径、**斜杠列表必须全拒**、段频否决权、版本/数字/引句、回归用例 |
| `degenerate.test.mjs` | 三条判据各自成立、边界值（`≤` vs `<`）、缺失 ≠ 0、批量分母 |
| `cli.test.mjs` | 四个子命令端到端、`--json`、退出码（0 vs 2）、空分母打印 `n/a` |
| `readme.test.mjs` | **README 里的示例数字必须与代码实际输出一致**（防文档漂移） |

**反证**（证明"功能关掉时结果会变"，而不是"看起来在跑"）在四处：

1. `coverage.test.mjs`：关掉短发言剔除这道闸门，覆盖率从 **100% → 10%**（同一份数据）。
2. `turnFidelity.test.mjs`：锚从"末 N 字符"改回"整条消息"，**有痕/无痕判定翻转**。
3. `corpus.test.mjs`：不去重时压缩事务被 fork 副本放大 **2 → 4**；
   只去重不筛来源时，子代理的委派提示词被当成用户发言（去重救不了）。
4. `degenerate.test.mjs`：把判据门槛调成"永不触发"，退化标记随之消失。
