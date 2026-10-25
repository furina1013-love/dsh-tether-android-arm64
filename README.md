# dsh-tether-android-arm64

> **目标平台：Android / Linux-arm64。** 纯 JS 运行时，无原生模块、无编译依赖。

**有界操作 + 检查点。** `dsh-tether-android-arm64`（简称 Tether）是 DeepSeek Harness 的 Host 插件：默认只暴露两个很小的工具，批量读取时对结果做硬上限和引用去重，高级工具按需注册；每完成一轮可工作的阶段，在会话工作目录里自动打一个 git 检查点，把成果留到上下文之外。

> 名字 = **dsh**（DeepSeek Harness）+ **tether**（系绳/活动范围 + 锚点）+ **android-arm64**（目标平台）。工具前缀保留 `tether_`，避免每次请求为更长的工具名多付 token。

## 1. 三层结构性节省

Tether 不靠事后把聊天记录剪短，而是在工具进入请求之前减少成本。

### 第一层：渐进式披露（progressive disclosure）

默认只注册两个 core 工具：

| 工具 | 作用 |
|---|---|
| `tether_batch` | 一次调用执行多个独立的只读操作（read / grep / list / stat / fetch），结果有界。 |
| `tether_activate` | 查看、启用、停用高级工具；手动创建检查点。 |

高级工具 `tether_document`（PDF/DOCX/文本）和 `tether_patch`（多文件字面替换）定义在工厂里，**启用前不注册**，所以它们的 schema 不进入系统提示词。启用时调用 `ctx.tools.register()`，DSH 会在下一次请求的工具历史中产生 `tool-addition` 记录；停用时 dispose，产生移除记录。插件**不手写工具增删事件**，也不依赖某个未公开的事件名，只使用注册/注销这个公开边界。

高级定义带 `deferLoading: true`，作为“默认不展开”的额外标记；真正的可见性由“是否注册”决定。支持工具更新声明的 provider 走 `addition-only` / `in-history` 投影；不支持的路由会退回当前有效工具集，这时仍然可用，只是省不到高级 schema 的那部分 token。

### 第二层：批处理 + 引用 + 去重

- 一个 `tether_batch` 调用可以读多个文件、跑多条 grep、列多个目录，减少“读一个文件 → 等结果 → 再读下一个”的往返；每一步重发的上下文更少。
- 每个结果都会写入内容寻址的 ref（`r_<sha256 前 12 位>`）。相同内容命中同一个 ref；同一批里重复的 op 直接折叠为 `duplicate of #n`。
- 短时间内在同一路径重复 read，会用文件版本判断是否变化；没变就只返回 `ref has N tokens — use fetch to view`，不重复把全文塞回上下文。
- `op: "fetch"` 可按行窗口取回 ref 的必要片段，不重新读文件；ref 只存在内存中，是派生缓存，不是会话真相。丢失时重新 read 即可。
- 跨调用去重有 30 分钟窗口；文件版本一变就重新读取。

### 第三层：有界输出 + 纯函数压缩

- 单个结果默认硬上限 `maxResultTokens = 320`；一批结果总上限约为它的 1.5 倍。≤1600 字符的结果用 js-tiktoken 精确计数；更长的输入用头尾采样估计并乘 1.05 安全系数，避免极端重复串让 BPE 变慢。超过预算就压缩，不会全量倾倒。
- 文本：保留头尾行，折叠连续重复行，插入 `… [omitted N lines] …`。
- JSON：先 minify；仍然超限就保留 key 骨架、数组长度和少量样本，再按 token 裁剪。
- CSV：保留表头、前 3 行、后 2 行、列数和省略行数。
- 压缩器是纯函数、确定性、不调用模型；任何异常都 fail-open，原样放行，不额外注册“恢复”工具。
- 每个结果带 `saved`（估算省下的 token）；批处理总输出也带 `saved`。`tokens` 是压缩后结果的 token 计数：短结果精确，长输入为带安全系数的采样估计。

## 2. Git 检查点怎么协作

- 自动：监听 DSH 已持久化的 `session/event`，在 `turn/end` 且 `reason.kind === "completed"` 时触发。默认 `autoSaveInterval = 1`，即每个完成的工作轮；设为 `0` 关闭自动检查点。
- 手动：`tether_activate` 的 `action: "checkpoint"`，使用调用 Agent 的当前工作目录。
- 仓库判断：`git rev-parse --is-inside-work-tree`。不是仓库就跳过（返回 `skipped / not-a-git-repository`），除非显式配置 `autoInit: true`。
- 只提交当前工作目录范围内、有变化的路径：先 `git status --porcelain -- .`，再 `git add -A -- .`，再 `git commit --only -m <one-line> -- .`。`--only` + pathspec 尽量不让工作目录外已暂存的内容混入检查点。
- 提交信息一行、带固定前缀，例如：`[dsh-tether] checkpoint t3 2026-10-25T09:40:00.000Z`。
- **不会** push、reset --hard、clean、rebase 或改写历史。失败只写日志并记录到状态文件，不阻断对话。
- 会话到检查点的映射写在 `$DSH_HOME/dsh-tether-android-arm64.json`（DSH_HOME 不存在时回退 `~/.dsh`），绝不写进工作目录；文件权限 0600，先写临时文件再 rename。状态写失败也只告警。
- 没有改动时返回 `skipped / no-changes`，不会制造空提交。

## 3. 配置

`Config` 用 `Schema.object` 声明，默认值在 schema 里；`apply(ctx, config)` 的第二个参数是已经过校验的配置。

| 字段 | 默认 | 说明 |
|---|---:|---|
| `enabled` | `true` | 关闭后不注册任何工具，也不监听检查点。 |
| `schemaBudget` | `900` | 本插件拥有的工具 schema 总 token 预算。core 两个约 405 tok（精确计数）；启用高级工具前检查，超预算就拒绝。 |
| `batchEnabled` | `true` | `false` 时 `tether_batch` 每次只允许 1 个 op。 |
| `maxResultTokens` | `320` | 单个结果的硬 token 上限；批处理总上限约为 1.5 倍。 |
| `autoSaveInterval` | `1` | 每多少个“已完成轮次”自动检查点一次；`0` 关闭。 |
| `commitPrefix` | `[dsh-tether]` | 提交信息固定前缀，强制一行。 |
| `maxBatchOps` | `8` | 单次批处理/补丁的最大条目数（1–16）。 |
| `autoInit` | `false` | 不是 git 仓库时是否 `git init`；默认不主动创建仓库。 |
| `refCacheSize` | `128` | 内存 ref 数量上限；总字节另有 8 MiB 上限。 |

> **schema 预算只约束 Tether 自己注册的工具**，不是整个 Harness 的工具总量。core 两个是控制面，始终注册；如果 `schemaBudget` 小于 core 成本，插件会告警，并拒绝所有高级工具激活。要验证预算真的生效，可以把 `schemaBudget` 设成 500，再尝试 `enable document`。

`cordis.patch.yml` 示例：

```yaml
- insert:
    - id: dsh-tether-android-arm64
      name: '@local/dsh-tether-android-arm64'
      config:
        enabled: true
        schemaBudget: 900
        batchEnabled: true
        maxResultTokens: 320
        autoSaveInterval: 1
        commitPrefix: '[dsh-tether]'
        maxBatchOps: 8
        autoInit: false
        refCacheSize: 128
```

## 4. 下载与安装

### 方式一：SSH clone（推荐）

```bash
git clone git@github.com:furina1013-love/dsh-tether-android-arm64.git
cd dsh-tether-android-arm64
npm install --no-audit --no-fund
npm test
```

### 方式二：HTTPS clone

```bash
git clone https://github.com/furina1013-love/dsh-tether-android-arm64.git
cd dsh-tether-android-arm64
npm install --no-audit --no-fund
npm test
```

### 方式三：下载 main 分支压缩包

```bash
curl -L -o dsh-tether-android-arm64.tar.gz \
  https://github.com/furina1013-love/dsh-tether-android-arm64/archive/refs/heads/main.tar.gz
tar -xzf dsh-tether-android-arm64.tar.gz
cd dsh-tether-android-arm64-main
npm install --no-audit --no-fund
npm test
```

### 安装到 DSH profile

用 Host 的 Plugin Manager 把 checkout 目录作为 bundle 安装（不要在 profile 里手写 package.json / patch）：

```text
plugin_manager action=install_bundle target=$(pwd)
```

安装后确认 Plugin Manager 条目名为 **dsh-tether-android-arm64**，并且工具列表里有 `tether_batch` / `tether_activate`。高级工具默认隐藏，按 README 第 1 节的方式按需启用。

安装后检查：

1. Plugin Manager 里出现 **dsh-tether-android-arm64** 条目，locale 的 `meta.title` / `meta.description` 正常。
2. 新会话或当前会话的可见工具中出现 `tether_batch`、`tether_activate`；高级工具默认不出现。
3. 让模型调用 `tether_activate action=list`，再 `enable document`，下一步工具列表出现 `tether_document`；`disable document` 后下一步移除。
4. `tether_batch` 一次读多个文件，确认结果有 `~N tok`、`saved`、`ref` 和 `truncated`，超限内容有省略标记。
5. 在 git 仓库里调用 `tether_activate action=checkpoint`，确认 `git log -1 --oneline` 有一行 `[dsh-tether] checkpoint ...`；在非仓库目录调用应返回 `skipped / not-a-git-repository`。
6. 自动检查点：完成一轮工具工作后看 `git log`；失败只应出现在日志，不应让对话失败。

## 5. 验证记录（本次交付）

- Android/Linux-arm64、Node `v24.19.0`、npm `11.17.0`、git `2.43.0`。
- `npm install` 成功；`js-tiktoken@1.0.21` 只有纯 JS 的 `dist`，`hasInstallScript` 为 false，`getEncoding('cl100k_base')` 可直接调用（实测加载+初始化约 0.5s），arm64 上不需要编译。没有 `node-gyp`、没有原生 `.node`、没有安装脚本。
- `@deepseek-ai/schemastery@3.18.5` 也是纯 JS，作为运行时依赖。
- 工具 schema 的每个 object 节点都显式有 `additionalProperties: true|false`；所有 `type` 都是单一字符串，没有 `["string","null"]`；可选字段靠缺失表达，没有用联合类型数组。
- 精确 schema 计数（js-tiktoken，cl100k_base；随描述文字会有小幅变化）：`tether_batch` 282、`tether_activate` 123、`tether_document` 138、`tether_patch` 192；core 合计 405，四个全开 735，低于默认 900。
- 用 `plugin_manager install_bundle` 安装本目录，返回 `application: "applied"`、`warnings: []`；当前会话可见 `tether_batch`、`tether_activate`，高级工具默认隐藏。
- 实际批处理：一次读 README（约 5.3k tok）+ 重复读 + 2 行窗口，输出 248 tok，`saved` 约 10394，`budget` 480；重复读折叠为 `duplicate of #0` / `unchanged`，`fetch` 能按行窗口取回内容。
- 渐进式披露：`enable document` 后 schema 543/900，下一次请求出现 `tether_document`；`enable patch` 后 735/900，两个高级工具同时可见。`schemaBudget` 小于 core + 高级工具成本时，单测确认 `enable` 返回错误且不注册。
- 实际 git：在临时仓库中手动检查点提交成功（示例 hash `1c5f934`，message `[dsh-tether] checkpoint t1 ...`）；非仓库返回 `checkpoint skipped: not-a-git-repository`；状态写入 `$DSH_HOME/dsh-tether-android-arm64.json` 的会话映射。
- 自动检查点：`shouldAutoCheckpoint()` 对 interval、重复 turn、NaN 的边界做了单测；上一轮真实 `turn/end` 已触发监听，因当前 workspace 非 git 仓库按设计记录 `skipped / not-a-git-repository`，没有制造空提交。
- 单测共 28 个（`npm test`）：压缩 token 上限/头尾保留、JSON 骨架、CSV 抽样、ref 去重/LRU、batch 去重/行窗口/失败隔离/窗口不污染全读缓存、PDF/DOCX 提取、git 首次提交/无改动跳过/非仓库跳过、schema 预算拒绝/停用扣减、自动检查点间隔、schema 规则。

### 本次 token 收紧

审计报告：[reports/token-audit.md](reports/token-audit.md)。只改描述、默认预算和缓存窗口，没有扩大能力，也没有动宿主/Android 的安全边界。

| 指标 | 收紧前 | 收紧后 | 变化 |
|---|---:|---:|---:|
| core schema | 509 tok | **405 tok** | −20.4% |
| 四个 schema 全开 | 883 tok | **735 tok** | −16.8% |
| 单结果上限 | 400 tok | **320 tok** | −20% |
| 多 op 总预算 | 2x | **1.5x** | 默认 800→480 |
| read cache 去重窗口 | 10 分钟 | **30 分钟** | 3x |
| 单测 | 25 | **28** | +3 |

## 6. 已知限制

- 渐进式披露的 schema 节省依赖 provider 支持工具更新声明。不支持的路由仍能工作，但会退回当前有效工具集，高级 schema 可能仍被一起发送。
- schema 预算只算 Tether 自己的工具，不是全局预算；core 控制面始终存在，预算很小时会告警而不是把控制面藏掉。
- **Tether 不是全局上下文压缩器**：它只影响自己注册的工具和结果，不裁剪其他工具结果、历史消息、系统提示词或模型输出。近全局方案应另做 context-guard（全局 `tools/post-execute` + 复用 compaction pruner），不要塞进本插件。
- ref 是内存派生缓存，进程重启/插件重载后失效；`fetch` 会明确报 unknown/expired，重新 read 即可。跨调用 read 去重有 30 分钟窗口，窗口外会重新返回内容。
- `tether_patch` 默认 `preview`；`apply` 逐个文件执行，**没有跨文件事务/回滚**。它使用每文件版本检查，适用普通文本文件；不处理二进制、重命名、删除。需要严格 read-before-edit 策略的场景，仍应使用 Harness 内置 edit 工具。
- PDF 只提取文本层；扫描件/OCR、复杂 CID 字体、表单和排版不在范围内。DOCX 只读 `word/document.xml`，不保留图片、批注、样式。旧版 `.doc/.xls/.ppt` 直接拒绝并提示转换。
- 自动检查点每个完成轮次都可能产生一次 commit（默认 interval 1）；仓库会很“密”。可用 `autoSaveInterval` 调大或设 0。
- `autoInit: true` 会在当前工作目录创建仓库；如果目录不对，可能把不该提交的文件纳入版本控制。默认关闭。
- git 提交需要本机有可用的 `user.name` / `user.email`；缺失时检查点失败并记录，不会伪造身份。
- 批量 grep 自己遍历目录（跳过 `.git`、`node_modules` 等常见目录），不读取 `.gitignore`；只适合有界排查，不是完整搜索实现。
- >1600 字符的 token 计数是头尾采样估计（带 5% 安全系数），不是逐 token 精确值；硬上限按这个上界执行。

## 7. 依赖选择

**运行时依赖**

| 依赖 | 版本 | 为什么 |
|---|---|---|
| `js-tiktoken` | `^1.0.21` | 纯 JS 的 BPE 计数，Android arm64 无需 WASM/原生编译；用 `cl100k_base` 对 schema 和短结果做精确计数，对超长输入做头尾采样估计。动态 import + 失败回退，加载失败不会让工具挂掉。 |
| `@deepseek-ai/schemastery` | `~3.18.5` | DSH 的 `Schema.object` 配置 DSL；默认值、范围校验都在 schema 里。纯 JS。 |

**开发依赖**：无。测试用 Node 内置 `node:test` / `node:assert`；git 操作用 Node 内置 `child_process.execFile`，不需要 simple-git。没有 YAML/JSON5 解析需求（patch 是静态 YAML，配置走 Schema）。

**不使用的**：原生模块、需要编译的包、带 install 脚本的包、Windows 专属依赖。`js-tiktoken` 的 22 MiB 是词表数据，不是二进制；首次加载约 0.5s，之后计数同步完成。

## 8. 文件结构

```text
dsh-tether-android-arm64/
  index.js              # Host apply：注册 core、自动检查点、动态能力
  src/config.js         # Schema.object 配置与默认值
  src/names.js          # 包/工具/状态文件名的单一来源
  src/compress.js       # 纯函数文本/JSON/CSV 压缩
  src/tokens.js         # js-tiktoken 懒加载 + fail-open 回退
  src/refs.js           # 内容寻址、LRU 有界 ref 缓存
  src/batch.js          # tether_batch 执行器
  src/document.js       # PDF/DOCX/文本提取 + tether_document
  src/patch.js          # 多文件字面替换 + tether_patch
  src/activate.js       # 渐进式披露控制面 + 手动检查点
  src/git-checkpoint.js # git 操作、状态文件、原子写
  src/schema-check.js   # additionalProperties / type 规则自检
  src/tool-defs.js      # 所有 wire schema
  cordis.patch.yml      # bundle 挂载
  locale/en.json        # 英文显示元数据
  locale/zh.json        # 中文显示元数据
  icon.svg              # 插件图标
  test/                 # node:test 单元测试
```

## 9. 为什么叫 dsh-tether-android-arm64

- **有界**：tether 是一根系绳，限定活动范围；对应批处理上限、token 硬上限、schema 预算、ref 缓存上限。
- **检查点**：tether 也是锚点；对应每轮结束的 git commit 和 `$DSH_HOME/dsh-tether-android-arm64.json` 里的会话映射。
- `dsh-` 一眼看出是 Harness 插件；`android-arm64` 一眼看出目标平台，不是通用 x64 包。
- `tether` 一个词、两个意象，短且好记；不会和 `ops_batch`、`checkpoint` 这类通用词混淆。
- 统一命名：包 `@local/dsh-tether-android-arm64`、导出 `name = "dsh-tether-android-arm64"`、状态文件 `dsh-tether-android-arm64.json`、patch 行 id `dsh-tether-android-arm64`、README 标题 `dsh-tether-android-arm64`。
- 工具前缀仍为 `tether_`：工具名常驻在每个请求里，保留短前缀符合省 token 的目标；包/仓库/状态文件才使用完整平台名。
