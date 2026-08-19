# CLI Scaffolding Refactor

> 状态：draft proposal。本文描述尚未实现的脚手架重构，不是当前命令、模板格式或远程模板支持的承诺。
> 当前事实仍以 [`../TOOLCHAIN.md`](../TOOLCHAIN.md)、
> [`../../packages/cli/README.md`](../../packages/cli/README.md) 和用户文档为准。

## 摘要

本提案保留 `@pluxel/create -> pluxel new` 的单向委托，但把 CLI 内部脚手架从一个同时负责模板定位、
prompt、渲染、文件写入和安装的模块，重构为五个明确阶段：

```text
template source
    -> acquire
    -> validate contract
    -> build immutable plan
    -> materialize
    -> optionally install
```

关键决策：

1. 官方 `plugin` 与 `app-monorepo` 模板继续随同版本 CLI 打包，不经网络下载。
2. giget 只作为未来远程模板 source 的 acquisition adapter，不负责 prompt、渲染、覆盖策略或安装策略。
3. 不采用完整 Handlebars。当前 `.hbs` 改为诚实命名的 `.tpl`，并冻结一个只支持变量与白名单 helper
   的受限插值语法。
4. `@pluxel/create` 仍是 npm/pnpm create 协议 adapter；`@pluxel/cli` 仍是项目版本锁定的命令 adapter。
   两个 executable 共享同一实现，不新增 `@pluxel/scaffold` public package。
5. 当前 `app-monorepo` 明确定位为 opinionated、可增长的团队 starter，不伪装成最小应用。新增轻量
   `app` 前必须先用真实 production pipeline 证明其 Plugin identity、build 和依赖边界，不能只删文件得到一个
   表面更小的模板。

## 问题与证据

### 一个模块承担了五类决策

当前 `packages/cli/src/scaffold/template.ts` 同时：

- 从 bundled name 或本地路径定位模板；
- 解析 prompt control file 并执行交互；
- 解释文件名和文件内容中的占位符；
- 处理 bundled docs 的特殊复制规则；
- 检查 collision、询问 overwrite 并写入目标目录。

这使新增 remote source 看似只需要“下载一个目录”，实际会立刻影响信任、缓存、目标覆盖、非交互默认值、
安装脚本和版本一致性。若直接在此模块调用 giget，这些边界会继续混在一起。

### `.hbs` 描述了不存在的契约

当前实现没有依赖或执行 Handlebars。它只识别：

```text
{{ key }}
{{ helper key }}
```

并提供 `kebabCase`、`pascalCase`、`capitalize` 和 `json` 四个 helper。它没有 HTML escaping、block、
condition、loop、partial 或 Handlebars AST。`.hbs` 因此会错误暗示模板作者可以依赖 Handlebars 语义。

当前 49 个模板文件中有 32 个 `.hbs` 文件，但实际占位符只涉及 `className`、`packageName`、
`pluginName`、`description` 和 `json description`。现有需求没有证明需要一门通用模板语言。

### giget 与 Pluxel scaffold 解决不同层次的问题

giget 能解析 Git provider、registry、ref 和 subdirectory，并提供 tarball 下载、cache、offline、auth 与解压。
它不定义 Pluxel template prompt、变量类型、文件 collision、docs bundle、package manager policy 或生成结果验证。

用 giget 替换整个 scaffold 会把尚未解决的职责留给 glue code；把全部官方模板迁到远程 source 还会让同版本
CLI 与模板脱钩，使一次相同命令随 registry、branch 或网络状态得到不同结果。

### `create` 与 `cli` 是不同分发入口，不应变成两套实现

`pnpm create @pluxel` 需要 npm 包名 `@pluxel/create` 和 bin `create-pluxel`；项目安装、全局 launcher 与其他命令
需要 `@pluxel/cli` 和 bin `pluxel`。这是 package manager 协议与安装生命周期造成的差异，不代表需要两个
scaffold domain。

当前 thin wrapper 还保留一个重要性质：`@pluxel/create` 与 `@pluxel/cli` 属于同版本 release group，wrapper
直接加载自己的精确 CLI dependency。把完整实现移动到 create，再让 `pluxel new` 反向依赖它，会新增 public
library contract 或进程委托；删除 `pluxel new` 则失去项目锁定 CLI 版本的本地入口。当前没有足够收益支持这种反转。

### `app-monorepo` 清楚，但不是最小

当前模板的所有权方向成立：

```text
web host -> Plugin -> domain
web client ---------> domain
```

它同时生成 pnpm catalog、Turbo、CI、governance、format/lint/typecheck/test/build 门禁和完整 Pluxel docs。
这些内容适合团队基线，却会让只想验证一个 Pluxel application 的用户同时理解多个 workspace 和治理工具。
问题不是 monorepo 本身错误，而是必须让模板名称、选择说明和默认行为诚实表达它的成本。

## 目标

- 同一个 template source 经解析后形成可打印、可测试、不可变的 generation plan。
- bundled、local 和 remote source 在进入 plan 前通过同一 template contract 校验。
- 官方模板在相同 CLI 版本和相同输入下不依赖网络，生成相同字节集合。
- template language 足够小，未知 key/helper、输出逃逸、collision 和 control file 错误都在写入前失败。
- remote template 不获得比用户明确请求更多的文件覆盖或命令执行权限。
- `create-pluxel` 与 `pluxel new` 的参数、错误和输出共享同一 command implementation。
- starter 的复杂度是显式产品选择，并由独立 smoke test 证明可安装和可构建。

## 非目标

- 不设计通用 Yeoman 式 generator/plugin API。
- 不让第三方 JavaScript hook 在 CLI 进程内执行。
- 不让模板声明任意 post-generation shell command。
- 不把 giget registry 变成 Pluxel plugin market 或 CLI capability registry。
- 不为只有两个 executable 的现状发布 `@pluxel/scaffold` library API。
- 不在本重构中改变 Plugin、runtime、build pipeline 或 package identity。
- 不用模板 inheritance、condition 或 loop 合并 starter；没有真实重复成本证据前保持普通目录可审查。

## 选择记录

| 议题                 | 采用                            | 不采用                   | 原因                                               |
| -------------------- | ------------------------------- | ------------------------ | -------------------------------------------------- |
| 官方模板交付         | bundled with CLI                | 默认从 Git/registry 下载 | 保持版本一致、离线与发布 tarball 可验证            |
| 远程 acquisition     | giget adapter                   | 自写 provider/tar/cache  | giget 已覆盖真实下载问题，adapter 可隔离其契约     |
| 渲染语言             | 受限 `.tpl` interpolation       | 完整 Handlebars          | 当前无 block/loop 需求，限制能力可降低误用和安全面 |
| executable ownership | create thin wrapper，CLI 单实现 | create/CLI 各自实现      | 避免 prompt、错误和覆盖语义漂移                    |
| scaffold library     | CLI internal modules            | 新 public package        | 当前无独立 library consumer，不建立假设扩展点      |
| remote install       | 默认关闭                        | 下载后默认 install       | dependency lifecycle script 属于独立信任提升       |
| existing target      | Pluxel preflight/materializer   | giget `forceClean`       | 不允许 acquisition adapter 删除用户目录            |

## 目标架构

### 入口和所有权

```text
pnpm create @pluxel               project/global pluxel new
          |                                  |
          v                                  v
 @pluxel/create bin                 @pluxel/cli launcher
          |                                  |
          +----------> shared new command <--+
                              |
                              v
                    internal scaffold pipeline
```

`@pluxel/create` 继续只做：

- 解析同版本 `@pluxel/cli` 的 executable；
- 设置 direct invocation/startup cwd；
- 在 argv 前插入 `new`；
- 原样传播 CLI exit status 和诊断。

它不得包含 templates、prompt schema、giget 或 package-manager install 实现。`@pluxel/cli` 不导出 scaffold
library API；共享发生在同一个 CLI command 内，不通过 public subpath。

### 内部模块

建议把 `packages/cli/src/scaffold/` 收敛为以下职责：

```text
source.ts          parse source syntax; return discriminated source
acquire.ts         dispatch bundled/local/remote acquisition
contract.ts        parse and validate pluxel-template.jsonc
prompts.ts         collect validated answers; no filesystem writes
plan.ts            resolve identity, outputs, collisions and install policy
render.ts          pure .tpl interpolation
materialize.ts     preflight and write only planned outputs
install.ts         execute the selected package manager after materialization
command.ts         clack/gunshi adapter and user-facing diagnostics
adapters/giget.ts  optional remote download adapter
```

模块类型只在 CLI 内部共享。除非未来至少出现一个不能通过 executable 满足的真实外部 consumer，否则不得从
`@pluxel/cli` 或 `@pluxel/create` 导出这些类型。

### Source contract

模板 source 必须先解析为互斥类型，不能用一个 string 在后续阶段反复猜测：

```ts
type TemplateSource =
	| { kind: 'bundled'; name: string }
	| { kind: 'local'; path: string }
	| { kind: 'remote'; specifier: string }
```

建议命令语法：

```sh
pluxel new --template plugin
pluxel new --template ./templates/company-plugin
pluxel new --template gh:acme/pluxel-template#v1
```

解析规则必须无 fallback：

- bare identifier 只解析 bundled template；未知名称直接列出可用 bundled templates；
- `./`、`../`、absolute path 或 `file:` 只解析 local source；
- 只有显式受支持 provider prefix/URL 才解析 remote source；
- bundled name 不因网络 registry 中出现同名项而改变含义。

acquisition 只返回一个已解析的只读 template root 与 provenance。remote adapter 总是下载到 CLI 创建的临时目录，
不得把 giget 的 destination 指向最终用户目录，也不得使用 `forceClean`。

```ts
type AcquiredTemplate = {
	root: string
	provenance:
		| { kind: 'bundled'; name: string; cliVersion: string }
		| { kind: 'local'; path: string }
		| { kind: 'remote'; requested: string; resolvedSource: string; url?: string }
	dispose(): Promise<void>
}
```

cleanup 必须幂等，并由 command 在 prompt、plan、materialize 或 install 任一阶段失败时调用。

### Template manifest

每个 template root 使用单一 `pluxel-template.jsonc`。它替代分散的 `prompts.jsonc` 与
`pluxel-docs.jsonc`，并带显式 schema version：

```jsonc
{
	"schemaVersion": 1,
	"id": "app-monorepo",
	"kind": "workspace",
	"packageManager": {
		"name": "pnpm",
		"range": ">=11 <12",
	},
	"prompts": [
		{
			"name": "description",
			"type": "text",
			"message": "Application description",
			"default": "A clean Pluxel application monorepo",
		},
	],
	"docs": {
		"bundle": "pluxel",
		"target": "docs/pluxel",
	},
}
```

约束：

- manifest 从 filesystem/network 进入时视为 `unknown`，先完成运行时 schema 校验；
- unknown field 默认拒绝，避免拼写错误静默失效；
- `schemaVersion` 不受 CLI semver 猜测；不支持的版本给出稳定错误 code；
- prompt name 不得覆盖 CLI reserved inputs；prompt default 必须与 type/choices 一致；
- 非交互执行时每个 prompt 必须有合法 default 或由显式 flag 提供答案；
- docs bundle 只能引用 CLI 已知 bundled resource，remote template 不能读取任意 CLI/package 文件；
- package manager policy 是 template fact，命令行 override 只有满足 policy 时才有效。

manifest 是 data contract，不允许 module、hook、command、condition expression 或 arbitrary environment lookup。

### Template interpolation

`.tpl` 表示“输出时去掉扩展名并执行 Pluxel interpolation”。没有 `.tpl` 的文件按字节复制。路径和文本文件使用
同一语法：

```text
{{ key }}
{{ helper key }}
```

v1 只保留当前已证明需要的 helper：

- `json`：生成可嵌入 JSON/JavaScript literal 的 JSON string；
- `kebabCase`；
- `pascalCase`；
- `capitalize`。

不支持 raw/escaped 双重语义、block、loop、condition、partial、动态 helper、嵌套 lookup 或函数执行。新增 helper
必须先有至少一个 bundled template 的真实调用点、确定性测试和输入/输出定义。

所有 reserved input 和 prompt answer 在 render 前归一为 string scalar。未知 key/helper、未闭合 token、重复输出、
absolute output、`..` 逃逸和 file/directory collision 必须在 generation plan 阶段失败，不能写出部分目标。

`.hbs -> .tpl` 是 template author contract 变更，但不改变生成文件名或现有官方模板输出。CLI 不长期同时支持两个
扩展名；迁移 release 可以为 local template 的 `.hbs` 给出一次明确错误和迁移提示，不把它静默当普通文件复制。

### Immutable generation plan

prompt 完成后生成完整 plan：

```ts
type ScaffoldPlan = {
	template: TemplateProvenance
	targetDir: string
	outputs: readonly PlannedOutput[]
	overwrite: readonly string[]
	packageManager?: { name: string; install: boolean }
}
```

plan build 完成以下全部检查：

- target containment 与 normalized relative path；
- template control files 不会成为输出；
- template outputs、docs outputs 之间无 collision；
- existing file/directory 类型冲突；
- `--force` 的精确覆盖集合；
- source trust 对 install default 的影响；
- dry-run 打印的内容与真实 materialization 使用同一个 plan。

materializer 不再重新发现模板文件或解释选项。`--force` 只覆盖 plan 中列出的 existing files，不删除额外目录或文件；
不提供 `--force-clean`。写入失败时诊断必须包含已写入集合；进入实现阶段时应评估 temp-file + rename 是否能让单文件
替换原子化，但不得声称整个非空目录事务可回滚，除非实现和故障测试真正证明该语义。

### Remote template trust boundary

remote support 若实现，必须满足：

- remote source 只通过 giget adapter 下载到 temporary root；
- auth 只传给 acquisition，不进入 prompt/render data 或日志；
- CLI 显示 requested source 与 giget 返回的 resolved provenance；
- cache/offline 选项只影响 remote acquisition，不改变 bundled/local 行为；
- remote/local custom template 默认 `install: false`，只有用户显式 `--install` 才执行依赖安装；
- bundled official template 可以维持当前默认 install，因为其内容由同版本 CLI tarball 和 release smoke 覆盖；
- template 不能声明 post-create command；package manager lifecycle scripts 只在显式 install 后由 package manager 执行；
- remote failure、auth failure、offline cache miss、invalid template contract 和 materialization failure 使用不同错误 code，
  message 可以补充 provider cause，但程序不得依赖 message 分支。

giget 是 internal adapter dependency，不应出现在 template manifest 或生成项目中。若 bundle size 或 CLI cold start 受影响，
adapter 必须 lazy import；`pluxel --help`、bundled template 与 local template 不加载 giget。

## Starter 产品边界

### 保留 `plugin`

`plugin` 继续是已有 workspace 中新增可发布 Plugin package 的 canonical starter，也是没有显式 template 时的
non-interactive fallback。它必须保持 standalone pack smoke，并继续使用 package root concrete Plugin entry。

### 保留并诚实描述 `app-monorepo`

`app-monorepo` 保留当前三部分：deployable web host、example Plugin 与 neutral domain package。它的 template metadata
和交互说明必须明确：

- 这是 pnpm/Turbo/team-governed monorepo；
- 适合从零创建需要 host、Plugin、shared domain 和 CI 基线的产品仓库；
- 已有 monorepo 不应嵌套生成；
- domain package 是因为示例中 web client 与 Plugin 真实共享 contract/logic，不是要求所有业务先拆 domain；
- `web/` 是单 deployable app 的简化位置；出现多个 app 时才迁入 `apps/*`，或在首次 major 前一次性决定改用
  `apps/web`。两种布局不得长期并存为隐式约定。

模板保留 docs、governance 和完整 verify，是因为这些是该 starter 的产品承诺，而不是 scaffold engine 的默认能力。

### 轻量 `app` 的进入条件

本提案不凭空规定一个 single-package app。Pluxel toolchain 对 concrete Plugin root export、source-entry identity 和 static
application catalog 有真实约束；把 Plugin 随手内联进 host 可能得到开发可跑、production semantic pass 不合法的模板。

只有满足以下条件后才新增 `app`：

1. 先建立不进入 shipped templates 的 fixture prototype；
2. 使用真实 Vite source route 和 `staticApplication()` production build；
3. 明确 Plugin 是合法的 source-entry definition，或保留最小的第二 workspace package；
4. 不需要 Turbo、domain package、copied docs 或 governance script 也能完成 install、typecheck、test 和 build；
5. 与 `app-monorepo` 的选择文案能用用户意图区分，而不是“简单/高级”这种不可验证标签；
6. package/template smoke 覆盖 registry tarball 后再加入交互列表。

若原型必须复制 `app-monorepo` 大部分治理或违反 Plugin package root 约束，则否决新增 `app`，改为优化
`app-monorepo` 的 onboarding。

## 命令契约

第一阶段保持以下入口等价：

```sh
pnpm create @pluxel --template plugin --name @acme/orders
pluxel new --template plugin --name @acme/orders
```

两者必须进入相同 command definition、source parser 和 plan。`create` wrapper 不自行解析 flags。

remote support 建议新增但不一次性照搬 giget 全部 flags：

- `--offline`；
- `--prefer-offline`；
- `--auth` 不建议成为可出现在 shell history 的首选入口，优先读取 giget 支持的 environment credential；
- 不暴露 `--force-clean`、`--shell` 或任意 custom provider JavaScript。

flags 只有在 source kind 适用时才接受；例如 bundled template 使用 `--offline` 应直接报参数语义错误，而不是静默忽略。

## 失败契约

实现阶段应定义 internal stable codes，并让两个 executable 保持一致：

```text
TEMPLATE_NOT_FOUND
TEMPLATE_ACQUIRE_FAILED
TEMPLATE_AUTH_FAILED
TEMPLATE_OFFLINE_MISS
TEMPLATE_CONTRACT_INVALID
TEMPLATE_SCHEMA_UNSUPPORTED
TEMPLATE_RENDER_INVALID
TEMPLATE_OUTPUT_CONFLICT
TARGET_CONFLICT
INSTALL_FAILED
```

provider/package-manager 原始错误放入 `cause`。错误 message 包含 source、目标和可行动建议，但不得泄漏 auth header、token、
完整环境或不必要的用户文件内容。用户取消不是异常 stack；已开始 materialization 后的失败必须清楚报告目标状态。

## 迁移计划

### Phase 0：characterization

- 为两个官方模板保存 normalized output inventory 和关键文件 snapshot；
- 覆盖 filename rendering、unknown token、path escape、docs collision、existing directory 和 non-interactive prompt；
- 记录 CLI tarball 中 templates/docs inventory，作为后续等价基线。

### Phase 1：无用户行为变化的内部拆分

- 引入 source、contract、prompt、plan、render、materialize、install 内部模块；
- 先兼容现有 control files 和 `.hbs`，但所有 write 必须来自 immutable plan；
- `create` wrapper、命令 flags、bundled template 输出和安装默认值保持不变；
- 更新 `IMPLEMENTATION_INDEX.md`，但当前架构文档只在实现落地后修改。

### Phase 2：template contract v1

- 把 bundled templates 合并为 `pluxel-template.jsonc`；
- 把 `.hbs` 一次性迁为 `.tpl`；
- local template 遇到旧 control files/`.hbs` 时给出明确迁移错误；
- 更新 template tests、CLI README 和用户文档；
- 这是 public CLI 可观察行为变化，必须为 `@pluxel/cli` 与同步 release group 中的 `@pluxel/create` 添加 Tegami changelog。

### Phase 3：remote acquisition（独立决策）

- lazy 集成 giget adapter；
- 只开放明确 provider syntax、offline/cache 和 credential path；
- remote install 默认关闭；
- 增加本地 HTTP fixture、cache/offline、auth redaction、temporary cleanup 和 malicious path 测试；
- 在真实用户或至少一个受维护的 remote template 出现前，不建立 Pluxel registry。

### Phase 4：starter portfolio（独立决策）

- 保留并重新审查 `app-monorepo` 目录命名与 onboarding；
- 轻量 `app` 必须先通过前述工具链 prototype gate；
- 每个新增 starter 都增加仓库外 pack/install/typecheck/test/build smoke，不能只做内存文件测试。

每个 phase 可以单独交付和回退。Phase 1/2 不依赖 giget；Phase 3 不依赖新增 `app`。

## 验证矩阵

| 边界                    | 必须验证                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| create/CLI 等价         | 相同 argv 生成相同 plan、文件 inventory、exit code 与错误 code                                   |
| bundled reproducibility | packed CLI 在断网环境生成；相同 version/input 输出一致                                           |
| local source            | relative/absolute/file path、missing manifest、旧格式迁移错误                                    |
| remote source           | provider/ref/subdir、auth redaction、offline hit/miss、temporary cleanup                         |
| contract                | unknown fields、schema version、prompt defaults/choices、reserved names、PM policy               |
| rendering               | 所有 helper、unknown token、malformed token、JSON escaping、path escape、collision               |
| destination             | empty target、existing files、directory conflict、dry-run、精确 `--force` overwrite              |
| install                 | bundled default、custom explicit opt-in、PM failure cause、no install on materialization failure |
| plugin starter          | install、lint、typecheck、test、build、pack contents/public exports                              |
| app-monorepo            | install、governance、format、lint、typecheck、test、production distribution build                |
| package boundary        | create 无 template/giget 实现；CLI help 不加载 remote adapter/optional toolchain owners          |

## 验收条件

Phase 1/2 完成必须同时满足：

1. `@pluxel/create` 仍只有 bin 和精确同版本 CLI dependency；
2. scaffold source/plan/materializer 无 public export；
3. 两个 bundled templates 的 normalized output 与批准的迁移基线一致；
4. `.hbs` 和两个旧 control file 不再存在于 bundled templates；
5. dry-run 与真实执行消费同一 plan；
6. 所有 path/collision/contract 错误在首次目标写入前发生；
7. packed CLI 的仓库外 template smoke 全部通过；
8. 当前事实写回 `engineering/TOOLCHAIN.md`、CLI README 和相关 `docs/`，并从本提案删除已实现部分。

Phase 3 只有在 giget adapter 不进入 bundled/local hot path、remote install 默认关闭、credential redaction 和 offline
测试通过后才可称为完成。

## 否决条件

出现任一情况应停止或缩小对应方向：

- giget 迫使 bundled template 也经过 network/cache provider；
- remote adapter 需要接管最终 destination 或使用 destructive clean；
- `.tpl` 为满足 bundled template 被扩张出 condition/loop/arbitrary code；
- 为共享两个 executable 而新增没有独立 consumer 的 public scaffold API；
- 轻量 `app` 只能通过绕过 production semantic pass 或复制第二套 Plugin authoring model 工作；
- 新 layering 只增加文件转发，无法让 plan 在无 prompt、无 filesystem write 的测试中独立构造；
- 所谓原子生成无法在 failure injection 下恢复，却在 API/文档中声称可回滚。

## 未决问题

1. `app-monorepo` 在首次公开 major 前应继续使用顶层 `web/`，还是一次性改为 `apps/web/`？决定必须基于预期 deployable
   app 数量和生成后真实项目，而不是仅为目录对称。
2. remote template v1 是否只接受 immutable commit/tag，还是允许 branch 并在 plan 中显示 mutable provenance？在定义 cache
   reproducibility 和 CI 行为前不开放模糊 ref。
3. template contract 是否需要公开 JSON Schema 供第三方编辑器使用？只有 remote/local template author 成为真实受支持用户后再承诺；
   runtime validator 仍是信任边界，JSON Schema 不能替代它。
