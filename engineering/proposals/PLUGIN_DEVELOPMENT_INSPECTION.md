# 插件开发查询：后续方向

第一版 TypeScript 查询已实现。当前公开用法见
[离线插件查询](../../docs/development/inspection.md)，实现边界见
[Toolchain](../TOOLCHAIN.md#offline-plugin-inspection)。本文只保留尚未实现的设计，不构成当前 API 承诺。

## 保留的设计方向

插件开发使用三种互相衔接的能力：

- 普通 TypeScript 查询源码，得到可确认的 Plugin/Part/config 信息和文件归属。
- 现有 devconsole 在固定的 Vite 实例执行 TypeScript，读取或修改当前应用。
- 现有 package scripts、Vitest 和 test host 验证独立行为。

统一点是既有 Plugin identity、可定位的证据和真实领域合同。查询结果使用普通数据，组合使用普通 TypeScript，
不为 agent 建立第二套 config、RPC 或生命周期协议，也不要求作者重复描述插件元数据。

当前 `openProject()` 实现 `overview/plugins/plugin/file`，Plugin section 为
`parts/config/dependencies/checks`。以下能力需要真实声明分析和验证后再进入公开 API，不发布占位 section。

## Coding agent 接手路径

先读仓库 `AGENTS.md`、[API 设计规则](../../.agents/rules/library-api-design.md)、
[工程原则](../DESIGN_PRINCIPLES.md) 和 [Plugin system](../PLUGIN_SYSTEM.md)，再读对应领域文档。
本文中的建议入口和顺序是研究起点，不代表已经确定的新 API 合同。

推荐从一个最小真实任务开始：**给定明确的 Host entry 和 Plugin，定位它的 config/env/file binding，
返回源码位置及无法静态解析的原因，全程不执行应用工厂。** 先完成这一条，再扩展其他能力。

| 顺序 | 未完成工作                                               | 首先检查的实现入口                                                                                           | 最小交付证据                                                                               |
| ---- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 1    | 显式 application selection、config/env/file binding 定位 | `src/inspect/project.ts`、`src/cli/static-application.ts`、`src/rolldown/plugins/staticConfigEnvironment.ts` | 两个 Host 使用同一 Plugin，按所选 entry 返回不同绑定；有顶层副作用的 entry 不被执行        |
| 2    | source-space Plugin identity 与发现                      | `src/rolldown/plugins/pluginSemanticsPlugin.ts`、现有 Core identity codec                                    | application root 与 workspace root 不同、显式 sourceSpaces、symlink 的结果与正式工具链一致 |
| 3    | Vault bindings 与直接 usages                             | `src/inspect/config.ts` 的定位方式、Host input bindings、Vault 当前合同                                      | 部署绑定与业务 key 分开，动态 key 有 gap，Part 不获得虚假的独立 namespace                  |
| 4    | Workbench descriptor/RPC 与业务 API 定位                 | `src/workbench/semantic-lowering.ts`、实际 Plugin descriptor、TypeScript 类型服务                            | 正确定位跨模块类型、overload 和 publish callsite，不把声明存在当成当前已发布               |
| 5    | 测试关联与更广的文件反查                                 | `src/inspect/project.ts` 的 checks/file 查询、实际 package scripts 与 tests                                  | 每条关联注明依据，生成的窄测试命令可执行；不宣称关联就是覆盖率                             |

表中 `src/` 均相对 `packages/rolldown/`。公共类型集中在
[`contracts.ts`](../../packages/rolldown/src/inspect/contracts.ts)，入口为
[`index.ts`](../../packages/rolldown/src/inspect/index.ts)。新增 section 时同时维护 literal tuple、
动态数组、可选 include 和省略 include 的类型推导，不能把可能不存在的 section 标为必选。

### 当前限制与容易回归的边界

- `checks` 只返回声明的 scripts；config 只给声明/schema 定位，没有完整字段、默认值或 binding 投影。
- 当前只支持 package-root 源码 Plugin。没有 concrete Plugin 根导出的普通源码包不能因为有 abstract class 就被提升为 Plugin package。
- 包中的语义错误可以令该包整体不可分析；目前不会在失败后继续返回该包里尚未校验的 Plugin 身份。跨包查询保留其他包的结果及 gaps。
- 外部 Part 缺少可解析目标时保留 gap；重复挂载、nested Part 和共享 schema 必须按 occurrence 展开，不能按 class 去重。
- 每次查询新建 resolver；成功读取的文件会复核，但 negative lookup、目录成员变化和自定义 resolver 状态没有完整 snapshot 保证。
- 查询参数在调用时复制；排队期间修改调用者的 options/include/partPath 不能改变已接纳查询。稀疏数组必须拒绝。
- 查询不能读取或写入运行应用来补齐静态事实。需要验证当前实例时，按[devconsole 指南](../../docs/development/dev-console.md)先发现并固定 root/instance。

### 验证与完成标准

从仓库根目录运行直接相关测试，再按改动范围扩大：

```sh
pnpm --filter @pluxel/rolldown exec vitest run tests/inspection-project.test.ts tests/inspection-workspace.test.ts tests/inspect-config.test.ts tests/rolldown/plugin-inspection.test.ts
pnpm --filter @pluxel/rolldown typecheck
pnpm --filter @pluxel/rolldown build
pnpm source-declarations:check
```

改共享 semantic/config/parser 时运行整个 `@pluxel/rolldown` 测试；改共享 workspace 解析时检查 CLI 的
`tests/workspace-governance.test.ts` 与 `tests/source-workspace.test.ts`。首版交接时工具链全量 399 项、
这两组 CLI 回归 14 项通过；此数量只记录交接基线，不替代后续重新验证。

还需用普通 Node `.mts` 脚本从构建后的 `@pluxel/rolldown/inspect` 入口查询真实项目，
确认不依赖 Vite runner、不会执行目标源码，并记录结果范围、缺口、输出大小和耗时。
首版已实测 `@pluxel/agent-tools` 的 Plugin/config 定位及全 workspace 分页查询；全 workspace 可能为 partial，不能隐藏无源码包的缺口。

每批交付必须有具体可运行用例、精确类型、对应失败与无求值回归、当前 `docs/` 用法及必要的 Tegami changelog。
实现后的事实移入当前工程文档和用户文档，并从本文删去已完成任务。制品索引、长期缓存或常驻服务应在真实需求与测量支持后另行决策。

## 应用声明与 source-space Plugin

拟在打开查询作用域时接受显式 application root、entry 和现有 sourceSpaces 声明，增加 `application()`。
该方法定位固定目录、source provider 声明以及 config/Vault env/file bindings，不执行应用工厂，不读取部署输入值。

需要先解决：

- workspace root、application root 和 Vite root 不一定相同，不能隐式把 workspace root 映射为 `source:app`。
- 复用现有 static application validator 的语法；动态配置、computed binding、任意 resolver hook 保留缺口。
- `overview` 检索到的 entry 仅为有依据的候选，不能猜选当前 Host。
- source definition 与 package definition 沿现有 canonicalization 规则生成，不能再建立身份 codec。

验收覆盖多 Host、显式 sourceSpace、symlink 和嵌套 root；离线报告不能声称确定当前 catalog membership。

## Vault 用法

新增 `vault` section 时分开输出部署 `bindings` 和业务 `usages`。

bindings 需要已选 application；usages 定位实际 Vault token、handle、namespace、key 和操作位置。
字面量可直接返回；动态 key 只给表达式位置，不能猜有限枚举。Part 的使用位置与所属 Plugin 的 Vault owner 分开，
partPath 不能自动变成 Vault namespace。

先实现可证明的直接调用和有限 local alias，跨函数或动态 handle 留下 gap。未发现用法不能证明永不访问 Vault。
不要求私有 KV 重复声明根 schema，也不把导入的某个 schema 自动认定为完整业务数据合同。

验收包括同 owner 多 Part、显式 namespace、动态账号 key、部署只读记录以及没有 Vault 服务的项目。

## Workbench RPC 与业务 API 定位

新增 `rpc` section 时定位实际 definition、entry、descriptor import、provider factory、API 类型和 publish callsite。
通过 TypeScript 类型服务读取方法签名与 overload，不生成字符串 RPC invoke，不要求作者手写重复 schema。

需要明确区分 View RPC、Content data/action、Attachment 与 Plugin 普通业务方法。声明存在、代码中有 publish 调用、
当前已发布是三个不同事实。类型为 capability、stream 或复杂泛型时保留原类型，不伪造 JSON DTO。

查询提供调用所需的真实符号位置；在线调用继续使用 descriptor 推导、项目 principal、原有 `using` 与结果消费协议。
不根据方法名推测 read-only、idempotent 或 cancellation 语义。

验收须包括条件发布、动态 factory、跨模块 descriptor、重载方法和需要释放的 RPC 结果。

## 更具体的测试关联

第一版 checks 只报告 package 实际声明的 scripts，不宣称脚本关联等于行为覆盖。
后续可加入 test/fixture 的 direct import、传递源码引用和同 package 等具名关联依据。
只有识别 runner 的真实调用合同后才生成文件级测试命令，不能向任意 test script 拼接文件名。

文件反查也可扩展可证明的 import 与 test-import 边，但普通 import 不能变成 Plugin dependency 或 config ownership。
实际重启范围仍属于 Host graph；不能用源码引用图替代运行时 apply report。

## 制品、性能与新鲜度

现有 package dependency inventory 不能枚举本包的 Plugin。当前实现从源码根导出推导；无法读取源码的包明确报告分析失败。
是否额外发布 compact discovery artifact，应由真实 built-only 消费需求决定，不默认增加大型随包索引。

当前查询每次新建解析状态，复核成功观察到的文件。revision 不是文件系统原子 snapshot；失败的 resolution candidate、
新增目录项和自定义 resolver 状态不能靠已有文件 hash 完全证明稳定。未来若增加缓存，必须覆盖真实失效输入，
不能把负缓存问题交给 agent 手工 refresh，也不能用源码 revision 冒充 Host revision。

增加 TS 类型服务、更多 analysis scope 或缓存前，记录真实任务的读取文件数、耗时、输出字节和内存。
已知 Plugin 应一次查询得到所需修改位置；已知文件应一次查询得到可确认的全部 owner，并明确 scope 和缺口。
不要先引入常驻 daemon、公开 analyzer registry、通用查询 DSL 或另一套 CLI 命令树。
