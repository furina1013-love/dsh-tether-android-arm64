# Tether model-facing schema token 审计（只读）

> 范围：`src/tool-defs.js` 以及 `src/batch.js` / `src/activate.js` / `src/document.js` / `src/patch.js` 中进入模型的 `name + description + parameters`。`output.schema` 不参与 `schemaTokenCount`，本次不涉及。
> 结论：**core 509 → 405 tok（−104，−20.4%）**，advanced 374 → 330（−44，−11.8%），四个全开 883 → 735（−148，−16.8%）。22 处改动全部只改 `description` 文本，没有增删或修改任何 schema 关键字。

## 1. 测量口径与基线

计数函数与运行时一致：`src/tokens.js` 的 `schemaTokenCount(definition)`，即 `cl100k_base.encode(JSON.stringify({ name, description, parameters })).length`。`tokens.js` 对超过 1600 字符的输入采用头/尾采样并乘 1.05（`MAX_EXACT_CHARS = 1600`）：改动前 `tether_batch` 的 JSON 为 1660 字符，因此运行时显示 **369**，而完整精确编码为 **352**；改动后为 1295 字符，直接精确计数为 **282**。所以 batch 的运行时削减 87 = 文本削减 70 + 取消 >1600 采样估算的 17。其余三个定义本来就低于 1600 字符，两种口径完全一致。

因此本报告的 **total 一律使用运行时口径**（与 README/委派基线 369+140=509 完全对齐），单条 description 的 token 削减使用完整 cl100k 编码（可加总，不受采样影响）。

基线复现（全部由 `schemaTokenCount` 实测，未修改源码）：

| 工具 | README/委派基线 | 本次复测 | 完整 cl100k（参考） |
|---|---|---|---|
| tether_batch | 369 | 369 | 352（1660 字符，触发采样） |
| tether_activate | 140 | 140 | 140 |
| tether_document | 164 | 164 | 164 |
| tether_patch | 210 | 210 | 210 |
| **core 合计** | **509** | **509** | **492** |
| **四个全开** | **883** | **883** | **866** |

## 2. 汇总（运行时口径）

| 工具 | before | after | 削减 | 削减比例 |
|---|---|---|---|---|
| `tether_batch` | 369 | 282 | −87 | −23.6% |
| `tether_activate` | 140 | 123 | −17 | −12.1% |
| **core 小计** | **509** | **405** | **−104** | **−20.4%** |
| `tether_document` | 164 | 138 | −26 | −15.9% |
| `tether_patch` | 210 | 192 | −18 | −8.6% |
| **advanced 小计** | **374** | **330** | **−44** | **−11.8%** |
| **四个全开** | **883** | **735** | **−148** | **−16.8%** |

若完全不做采样估算、直接 cl100k 编码整段 JSON：core 492 → 405（−87，−17.7%），四个全开 866 → 735（−131，−15.1%）。两种口径都超过 10% 目标。

## 3. 逐项改动

每条都给出当前源码行号、JSON 路径、上下三行、精确 old/new 字符串、描述自身的 token 变化和语义保持理由。所有 old 字符串在仓库源码中只出现一次，所有 new 字符串当前不存在，可直接做字面替换。

### 3.1 `tether_batch`（369 → 282，−87）

#### B1 · `src/batch.js:258`

- JSON 路径：`tether_batch.description`
- 该描述 token：51 → 27（−24）
- 前后文：

```js
257	    name: toolName('batch'),
258	    description: 'Run several independent read-only filesystem operations in one call. Reads, greps, listings, and stats return bounded text; oversized results get a content-addressed ref that op=fetch can reopen. Duplicate reads and duplicate payloads are collapsed before they enter context.',
259	    parameters: batchParameters,
```

- old：

```text
Run several independent read-only filesystem operations in one call. Reads, greps, listings, and stats return bounded text; oversized results get a content-addressed ref that op=fetch can reopen. Duplicate reads and duplicate payloads are collapsed before they enter context.
```

- new：

```text
Run independent read-only filesystem operations in one call. Output is bounded; oversized results return a fetchable ref, and duplicates are collapsed.
```

- 语义保持：保留 read-only 范围、单次批量、bounded 输出、ref 可再次 fetch 与去重；去掉实现细节（content-addressed、payloads）以及 enum 已覆盖的 op 枚举。

#### B2 · `src/tool-defs.js:49`

- JSON 路径：`tether_batch.parameters.properties.ops.description`
- 该描述 token：21 → 16（−5）
- 前后文：

```js
48	      type: 'array',
49	      description: 'Independent operations executed in one call. The configured per-call limit is enforced; the whole output is bounded.',
50	      items: opItem
```

- old：

```text
Independent operations executed in one call. The configured per-call limit is enforced; the whole output is bounded.
```

- new：

```text
Independent operations run in one call; per-call count and total output are bounded.
```

- 语义保持：两个上限保持不变，仅改为主动语态。

#### B3 · `src/tool-defs.js:13`

- JSON 路径：`tether_batch.parameters.properties.ops.items.properties.op.description`
- 该描述 token：26 → 10（−16）
- 前后文：

```js
12	  properties: {
13	    op: { type: 'string', enum: ['read', 'grep', 'list', 'stat', 'fetch'], description: 'Operation: read one file, grep one file or directory, list one directory, stat one path, or fetch a saved ref.' },
14	    path: { type: 'string', description: 'Path for read/grep/list/stat. Relative paths use the Session working directory.' },
```

- old：

```text
Operation: read one file, grep one file or directory, list one directory, stat one path, or fetch a saved ref.
```

- new：

```text
Operation to run (fetch reads a saved ref).
```

- 语义保持：enum 已列出操作名；保留唯一不直观的约束（fetch 需要先前结果的 ref）。

#### B4 · `src/tool-defs.js:14`

- JSON 路径：`tether_batch.parameters.properties.ops.items.properties.path.description`
- 该描述 token：16 → 14（−2）
- 前后文：

```js
13	    op: { type: 'string', enum: ['read', 'grep', 'list', 'stat', 'fetch'], description: 'Operation: read one file, grep one file or directory, list one directory, stat one path, or fetch a saved ref.' },
14	    path: { type: 'string', description: 'Path for read/grep/list/stat. Relative paths use the Session working directory.' },
15	    pattern: { type: 'string', description: 'JavaScript regular expression for grep; required when op is grep.' },
```

- old：

```text
Path for read/grep/list/stat. Relative paths use the Session working directory.
```

- new：

```text
Path for read/grep/list/stat; relative paths use session cwd.
```

- 语义保持：cwd 是模型通用词汇；相对路径解析规则不变。

#### B5 · `src/tool-defs.js:15`

- JSON 路径：`tether_batch.parameters.properties.ops.items.properties.pattern.description`
- 该描述 token：12 → 9（−3）
- 前后文：

```js
14	    path: { type: 'string', description: 'Path for read/grep/list/stat. Relative paths use the Session working directory.' },
15	    pattern: { type: 'string', description: 'JavaScript regular expression for grep; required when op is grep.' },
16	    include: { type: 'string', description: 'Optional grep file filter, for example *.js or *.ts.' },
```

- old：

```text
JavaScript regular expression for grep; required when op is grep.
```

- new：

```text
JavaScript regex for grep (required for grep).
```

- 语义保持：regex 与 JavaScript regular expression 同义；required 提示保留。

#### B6 · `src/tool-defs.js:16`

- JSON 路径：`tether_batch.parameters.properties.ops.items.properties.include.description`
- 该描述 token：13 → 11（−2）
- 前后文：

```js
15	    pattern: { type: 'string', description: 'JavaScript regular expression for grep; required when op is grep.' },
16	    include: { type: 'string', description: 'Optional grep file filter, for example *.js or *.ts.' },
17	    ignoreCase: { type: 'boolean', description: 'grep: case-insensitive matching.' },
```

- old：

```text
Optional grep file filter, for example *.js or *.ts.
```

- new：

```text
Grep file filter, e.g. *.js.
```

- 语义保持：未列入 required 已表示可选；一个示例足够。

#### B7 · `src/tool-defs.js:17`

- JSON 路径：`tether_batch.parameters.properties.ops.items.properties.ignoreCase.description`
- 该描述 token：7 → 5（−2）
- 前后文：

```js
16	    include: { type: 'string', description: 'Optional grep file filter, for example *.js or *.ts.' },
17	    ignoreCase: { type: 'boolean', description: 'grep: case-insensitive matching.' },
18	    ref: { type: 'string', description: 'Ref returned by an earlier result; required when op is fetch.' },
```

- old：

```text
grep: case-insensitive matching.
```

- new：

```text
Case-insensitive grep.
```

- 语义保持：布尔含义不变。

#### B8 · `src/tool-defs.js:18`

- JSON 路径：`tether_batch.parameters.properties.ops.items.properties.ref.description`
- 该描述 token：13 → 10（−3）
- 前后文：

```js
17	    ignoreCase: { type: 'boolean', description: 'grep: case-insensitive matching.' },
18	    ref: { type: 'string', description: 'Ref returned by an earlier result; required when op is fetch.' },
19	    offset: { type: 'integer', description: 'read: 0-based first line; fetch: 0-based first line. Negative values clamp to 0.' },
```

- old：

```text
Ref returned by an earlier result; required when op is fetch.
```

- new：

```text
Ref from an earlier result (required for fetch).
```

- 语义保持：来源与必填条件不变。

#### B9 · `src/tool-defs.js:19`

- JSON 路径：`tether_batch.parameters.properties.ops.items.properties.offset.description`
- 该描述 token：23 → 15（−8）
- 前后文：

```js
18	    ref: { type: 'string', description: 'Ref returned by an earlier result; required when op is fetch.' },
19	    offset: { type: 'integer', description: 'read: 0-based first line; fetch: 0-based first line. Negative values clamp to 0.' },
20	    limit: { type: 'integer', description: 'Maximum lines to return for read/fetch.' },
```

- old：

```text
read: 0-based first line; fetch: 0-based first line. Negative values clamp to 0.
```

- new：

```text
0-based first line for read/fetch; negatives clamp to 0.
```

- 语义保持：0-based 窗口与负数截断行为不变。

#### B10 · `src/tool-defs.js:20`

- JSON 路径：`tether_batch.parameters.properties.ops.items.properties.limit.description`
- 该描述 token：9 → 7（−2）
- 前后文：

```js
19	    offset: { type: 'integer', description: 'read: 0-based first line; fetch: 0-based first line. Negative values clamp to 0.' },
20	    limit: { type: 'integer', description: 'Maximum lines to return for read/fetch.' },
21	    maxBytes: { type: 'integer', description: 'Per-operation byte cap; clamped by the plugin.' }
```

- old：

```text
Maximum lines to return for read/fetch.
```

- new：

```text
Max lines for read/fetch.
```

- 语义保持：Max 即最大行数上限。

#### B11 · `src/tool-defs.js:21`

- JSON 路径：`tether_batch.parameters.properties.ops.items.properties.maxBytes.description`
- 该描述 token：11 → 8（−3）
- 前后文：

```js
20	    limit: { type: 'integer', description: 'Maximum lines to return for read/fetch.' },
21	    maxBytes: { type: 'integer', description: 'Per-operation byte cap; clamped by the plugin.' }
22	  },
```

- old：

```text
Per-operation byte cap; clamped by the plugin.
```

- new：

```text
Per-op byte cap (clamped).
```

- 语义保持：保留作用域与 clamp 行为；由谁执行属于实现细节。

### 3.2 `tether_activate`（140 → 123，−17）

#### A1 · `src/activate.js:49`

- JSON 路径：`tether_activate.description`
- 该描述 token：37 → 30（−7）
- 前后文：

```js
48	    name: toolName('activate'),
49	    description: 'List, enable, or disable optional tools without keeping their schemas in every request. Also creates a manual git checkpoint for the current Session workspace. Advanced tools become available on the next step.',
50	    parameters: activateParameters,
```

- old：

```text
List, enable, or disable optional tools without keeping their schemas in every request. Also creates a manual git checkpoint for the current Session workspace. Advanced tools become available on the next step.
```

- new：

```text
List, enable, or disable optional tools; schemas stay out of requests until enabled. Also creates a manual git checkpoint. Enabled tools appear next step.
```

- 语义保持：保留渐进披露、checkpoint 动作与下一步可用；去掉重复限定语。

#### A2 · `src/tool-defs.js:75`

- JSON 路径：`tether_activate.parameters.properties.action.description`
- 该描述 token：18 → 12（−6）
- 前后文：

```js
74	      enum: ['list', 'enable', 'disable', 'status', 'checkpoint'],
75	      description: 'list capabilities, enable/disable one capability, show status, or create a git checkpoint now.'
76	    },
```

- old：

```text
list capabilities, enable/disable one capability, show status, or create a git checkpoint now.
```

- new：

```text
list capabilities, enable/disable one, status, or checkpoint.
```

- 语义保持：四个动作及其对象均保留，仅压缩措辞。

#### A3 · `src/tool-defs.js:80`

- JSON 路径：`tether_activate.parameters.properties.capability.description`
- 该描述 token：21 → 17（−4）
- 前后文：

```js
79	      enum: ['document', 'patch'],
80	      description: 'Capability for enable/disable. document reads PDF/DOCX/text; patch performs bounded multi-file literal edits.'
81	    }
```

- old：

```text
Capability for enable/disable. document reads PDF/DOCX/text; patch performs bounded multi-file literal edits.
```

- new：

```text
For enable/disable: document reads PDF/DOCX/text; patch edits files literally.
```

- 语义保持：两个能力及其行为不变；bounded 由工具本身执行。

### 3.3 `tether_document`（164 → 138，−26）

#### D1 · `src/document.js:15`

- JSON 路径：`tether_document.description`
- 该描述 token：46 → 26（−20）
- 前后文：

```js
14	    name: toolName('document'),
15	    description: 'Extract bounded text from a PDF, DOCX, or UTF-8 document. PDF extraction covers text drawn in content streams; scanned pages need OCR and are reported as empty. DOCX text is read directly with no native module.',
16	    parameters: documentParameters,
```

- old：

```text
Extract bounded text from a PDF, DOCX, or UTF-8 document. PDF extraction covers text drawn in content streams; scanned pages need OCR and are reported as empty. DOCX text is read directly with no native module.
```

- new：

```text
Extract bounded text from a PDF, DOCX, or UTF-8 document. Scanned pages need OCR and are reported empty.
```

- 语义保持：保留格式、bounded 提取与 OCR 限制；去掉不影响用法的解析器内部细节。

#### D2 · `src/tool-defs.js:106`

- JSON 路径：`tether_document.parameters.properties.offset.description`
- 该描述 token：9 → 8（−1）
- 前后文：

```js
105	    format: { type: 'string', enum: ['auto', 'text', 'docx', 'pdf'], description: 'Parser override; auto uses the extension.' },
106	    offset: { type: 'integer', description: '0-based character offset into the extracted text.' },
107	    maxChars: { type: 'integer', description: 'Maximum extracted characters to consider; bounded by the plugin.' }
```

- old：

```text
0-based character offset into the extracted text.
```

- new：

```text
0-based character offset in extracted text.
```

- 语义保持：含义完全相同。

#### D3 · `src/tool-defs.js:107`

- JSON 路径：`tether_document.parameters.properties.maxChars.description`
- 该描述 token：11 → 6（−5）
- 前后文：

```js
106	    offset: { type: 'integer', description: '0-based character offset into the extracted text.' },
107	    maxChars: { type: 'integer', description: 'Maximum extracted characters to consider; bounded by the plugin.' }
108	  },
```

- old：

```text
Maximum extracted characters to consider; bounded by the plugin.
```

- new：

```text
Max extracted characters (bounded).
```

- 语义保持：上限不变；执行者属于内部细节。

### 3.4 `tether_patch`（210 → 192，−18）

#### P1 · `src/patch.js:13`

- JSON 路径：`tether_patch.description`
- 该描述 token：36 → 29（−7）
- 前后文：

```js
12	    name: toolName('patch'),
13	    description: 'Preview or apply bounded exact literal replacements across files in one call. Preview reports match counts without writing; apply uses per-file version checks and reports every failure without rolling back successful edits.',
14	    parameters: patchParameters,
```

- old：

```text
Preview or apply bounded exact literal replacements across files in one call. Preview reports match counts without writing; apply uses per-file version checks and reports every failure without rolling back successful edits.
```

- new：

```text
Preview or apply bounded exact literal replacements across files. Preview reports match counts without writing; apply checks per-file versions and reports every failure without rollback.
```

- 语义保持：保留字面替换、批量、preview、逐文件版本检查与失败不回滚的汇报。

#### P2 · `src/tool-defs.js:130`

- JSON 路径：`tether_patch.parameters.properties.mode.description`
- 该描述 token：14 → 13（−1）
- 前后文：

```js
129	  properties: {
130	    mode: { type: 'string', enum: ['preview', 'apply'], description: 'preview (default) reports matches without writing; apply performs the edits.' },
131	    edits: {
```

- old：

```text
preview (default) reports matches without writing; apply performs the edits.
```

- new：

```text
preview (default) reports matches without writing; apply writes them.
```

- 语义保持：默认值与写入行为不变。

#### P3 · `src/tool-defs.js:133`

- JSON 路径：`tether_patch.parameters.properties.edits.description`
- 该描述 token：17 → 11（−6）
- 前后文：

```js
132	      type: 'array',
133	      description: 'Literal replacements. The configured per-call edit limit is enforced; preview first is recommended.',
134	      items: {
```

- old：

```text
Literal replacements. The configured per-call edit limit is enforced; preview first is recommended.
```

- new：

```text
Literal replacements; per-call limit enforced. Preview first.
```

- 语义保持：保留上限与建议；preview 本身就是默认模式。

#### P4 · `src/tool-defs.js:139`

- JSON 路径：`tether_patch.parameters.properties.edits.items.properties.oldString.description`
- 该描述 token：11 → 8（−3）
- 前后文：

```js
138	          path: { type: 'string', description: 'File to edit.' },
139	          oldString: { type: 'string', description: 'Exact literal text to replace; must be non-empty.' },
140	          newString: { type: 'string', description: 'Replacement text.' },
```

- old：

```text
Exact literal text to replace; must be non-empty.
```

- new：

```text
Exact non-empty literal text to replace.
```

- 语义保持：精确匹配与非空约束不变。

#### P5 · `src/tool-defs.js:141`

- JSON 路径：`tether_patch.parameters.properties.edits.items.properties.replaceAll.description`
- 该描述 token：9 → 8（−1）
- 前后文：

```js
140	          newString: { type: 'string', description: 'Replacement text.' },
141	          replaceAll: { type: 'boolean', description: 'Replace every occurrence; otherwise replace exactly one.' }
142	        },
```

- old：

```text
Replace every occurrence; otherwise replace exactly one.
```

- new：

```text
Replace all occurrences; default replaces one.
```

- 语义保持：默认替换一处 vs 替换全部的语义不变。

## 4. 约束完整性验证

对四个改动后的参数 schema 做了机器校验：

1. `validateSchemaNode`（`src/schema-check.js`）全部通过。
2. 删除所有 `description` 键后，修改后的 `parameters` 与原 `parameters` 的 JSON 完全相等（4/4 true）：没有改动 `type`、`enum`、`required`、`items`、属性名、属性顺序或任何值。
3. 四个顶层 `required` 数组逐一比对相同；`batch` 的 `ops`、`grep` 仍要求 `pattern`，`patch` 的 `path` / `oldString` / `newString` 仍在 `required` 中且描述保留。
4. 每个 object 节点仍显式声明 `additionalProperties`；所有 `type` 仍是单字符串，没有 union type array，也没有任何新关键字。
5. 没有删除或弱化行为说明：read-only、bounded、per-call limits、preview/apply、per-file version checks、no rollback、PDF OCR 限制、ref/fetch 关系都保留。

## 5. 实施注意事项

- 只改这 22 段 `description` 字符串；不要改 `name`、`enum`、`required`、`items` 或对象结构。按表中 `文件:行` 与 old/new 字面替换即可（行号基于当前工作区，替换不会改变行数）。
- 现有测试没有断言任何 description 文本（已 grep 确认），因此不会因这些措辞改动而失败。
- README 中记录的 `369 / 140 / 164 / 210`、core `509`、四个全开 `883` 在实施后会变成 `282 / 123 / 138 / 192`、core `405`、四个全开 `735`。本任务按要求没有改 README；建议实施时另行同步（含默认 `schemaBudget` 900 的说明，届时余量约 165 tok）。
- `tether_activate list` 的 `schemaTokens` 来自运行时计数，会自动反映新成本，无需硬编码。
- 改完可再用 `schemaTokenCount` 复测；若 batch 的 JSON 字符数仍可能超过 1600，请以运行时口径为准。

## 6. 复测方法

```js
import { initTokenizer, schemaTokenCount } from './src/tokens.js';
import { createBatchTool } from './src/batch.js';
await initTokenizer({});
const batch = createBatchTool({ ctx: {}, config: {}, refs: {}, logger: {} });
console.log(schemaTokenCount(batch)); // 期望 282
```

单条字符串的 token 数可用 `getEncoding('cl100k_base').encode(text).length` 直接核对；本报告中的 51/27 等数字均按此方式独立测量。
