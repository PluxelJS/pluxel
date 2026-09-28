# 公开 API 审查：实施决策与验证记录

本轮审查基线为 `4edb0f3b13842e26ee018e44cd0b2c7549fb7ef6`（2026-09-26），盘点 28 个第一方包的 exports/bin，
核对重点契约、真实调用与测试。原 12 项提案已进入本次修复；本页只保留决策与验证索引，
当前用法由链接的正式文档拥有，不保留第二套 API 规范。A13 将唯一 Elysia 2 + srvx 接线收敛为显式公共入口。

依据 [Library API Design](../../.agents/rules/library-api-design.md)：
A02/A06/A08/A09/A10/A12 修正类型、运行时与公开承诺不一致；A01/A04/A05 修正实现中的资源所有权；
A03/A07/A11 在核对真实消费者后明确边界。不能将这 12 项都归为命名或重载设计错误。

## 已采用的决策

| 项目                    | 修复与取舍                                                                                                                                                | 当前事实与回归入口                                                                                                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01 Effects transaction | 用事务身份跟踪资源，重叠 sibling 拒绝，nested 通过活动 tx 进入；关闭后撤回 tx，late acquire 补偿释放；rollback/dispose 共享 cleanup 等待并退休历史 handle | [Effects](../../packages/core/src/services/effects/DESIGN.md)、[回归](../../packages/core/tests/EffectsService.test.ts)                                                                        |
| A02 readonly            | 所有内建路径复用只读 wrapper；Service 也约束声明 readonly 的 custom backend，不靠 preflight 代替执行检查                                                  | [Runtime services](../../docs/reference/runtime-services.md)、[回归](../../packages/services/tests/persistence.test.ts)                                                                        |
| A03 namespace/key       | 相对分层路径，保留合法原字面，拒绝 absolute、点段、空段与模糊分隔符；root 创建时固定。仅约束字面路径，不承诺 symlink sandbox                              | 同上                                                                                                                                                                                           |
| A04 HTTP shutdown       | endpoint 接收 invocation/client 组合 signal，carrier 仍映射原始 ingress 身份                                                                              | [HTTP](../../docs/runtime/http.md)、[回归](../../packages/services/tests/http.test.ts)                                                                                                         |
| A05 React ownership     | render 只建立本地状态，commit 才获取远程订阅；保留命令式 eager API                                                                                        | [Renderer resources](../../docs/workbench/renderer-resources.md)、[回归](../../packages/workbench/tests/remote-value-react.test.tsx)                                                           |
| A06 Fixture fs/fsp      | 显式替换上游冲突成员；callback fs 不再承诺 Promise，缺 callback 报错；Promise 操作用 fsp                                                                  | [Testing](../../docs/development/testing.md)、[回归](../../packages/test/tests/fixtures.test.ts)、[类型](../../packages/test/tests/fixtures.types.ts)                                          |
| A07 Backend listing     | 依据 Vault 的真实目录消费统一 sorted direct-child list 与目录 stat，不增加平行递归 API                                                                    | [Runtime services](../../docs/reference/runtime-services.md)、[回归](../../packages/services/tests/persistence.test.ts)                                                                        |
| A08 AutoForm            | 编辑态使用 InferInput，保留准确 TanStack options/callback；解析输出由显式 parse 产生；命令式 submit 可 await                                              | [Form usage](../../packages/valibot-form/USAGE.md)、[行为](../../packages/valibot-form/src/tests/autoForm.behavior.spec.tsx)、[类型](../../packages/valibot-form/src/tests/autoForm.types.tsx) |
| A09 Config snapshot     | configs.use 复用深只读 ConfigSnapshot，迁移 Auth 等真实 reader，不创建可写 alias                                                                          | [Configuration](../../docs/getting-started/configuration.md)、[类型](../../packages/core/tests/PluginConfigs.types.test.ts)                                                                    |
| A10 Fixture options     | Memory 不接受 fs/tempDir；disk 保留 tempDir、拒绝自定义 fs；JS 同样 fail fast                                                                             | [Testing](../../docs/development/testing.md)、[回归](../../packages/test/tests/fixtures.test.ts)                                                                                               |
| A11 Build ownership     | runner 收窄至 CLI 内部协作入口；普通 package 构建继续使用 CLI，底层集成使用 pluginPackage。非 watch 内部清理，watch 由命令进程拥有                        | [Plugin package](../../docs/development/plugin-package.md)、[Toolchain](../TOOLCHAIN.md)                                                                                                       |
| A12 Redis ARGV          | 必需 tuple 使 arguments 必填，允许空数组的参数契约仍可省略；保留原生 Redis 错误与 NOSCRIPT fallback                                                       | [Redis](../../docs/plugins/redis.md)、[类型](../../plugins/redis/tests/scripts.types.ts)                                                                                                       |

## 交叉评审补充

- A01 不能仅把共享 checkpoint 换成每事务数组：必须处理 parent/child rollback 的准入锁、并发 dispose 的同一 cleanup 等待，以及失败重试的历史 handle 累积。对应情景进入永久回归。
- A11 最初尝试返回 tsdown 原生 bundles，但底层配置变化会重建 watcher，旧数组不拥有新 watcher；stdin shortcuts 也未由 bundle dispose 完整释放。真实 CLI-only 用途支持收窄入口，不能把普通源文件 watch 测试通过当作完整 session 清理证明。
- Fixture Promise-to-callback adapter 不能把 consumer callback 的异常再次送给同一 callback 当作 IO 失败；成功和 IO 拒绝分支已分开。
- Core ConfigService.flush 的基类说明已收窄到内存实现，Host 持久 override 保持原责任；没有把基类 no-op 误报成 Host 丢写入。

## 数据与调用迁移

所有已知 workspace 类型调用同步迁移，无同义兼容 alias、旧 namespace reader 或启动迁移器。
Persistence 过去把 `@pluxel/...` 改为 `_pluxel/...`；现保留原名，因此既有该类磁盘数据需要一次性搬迁。
已只读盘点 local-projects 的业务路径，未发现受影响数据；没有修改运行应用的数据，也不能推断工作区外根目录已完成迁移。
部署前按实际配置 root 核对，数据迁移不能由静默 fallback 掩盖。

## 验证范围

针对性测试覆盖 Effects 嵌套/并发/撤回、HTTP Host shutdown/carrier、Persistence memory/Node 同契约、
React StrictMode/abandoned render/迟到订阅、fixture 两后端、表单 input/callback/submit 与 Redis typed ARGV。
配置只读与入口变化额外检查真实 Auth、Shell、CLI 和插件调用；公开包行为变化都有 pending Tegami 条目。

全包盘点不等于逐方法穷尽测试。本轮保留原生 SDK、明确的低层入口、输入输出推导重载与不同生命周期阶段；
没有依据将它们统一为万能 API。没有进行在线应用操作或完整安全审计；整体验证结果以交付记录为准。

## A13：唯一 Elysia 入口

`/elysia` 公开 `ElysiaApp`、`elysia()`、`createElysiaHandler(host)`；`/elysia/node` 只公开
`listenElysia(host, options?)`，内建 Host handler；`/elysia/vite` 提供 `elysiaDevelopment()`。
删除 `/http`、`/http/node`、`/http/vite`，不保留兼容 alias。Plugin 使用原生 Elysia，生产 listener 固定 srvx；
目录、endpoint/fallback 与 carrier 接线只供框架内部协作，不形成另一套公共 server/adapter 契约。
`ctx.elysia`、URL 和测试 driver 的 `http.fetch` 保留各自真实含义。

主仓库、模板、文档及 local-projects 的 backend、bot-new-omni、chatbot、rhythm 同步迁移。

## 本轮交付验证

`pnpm verify` 对 Core、Services、Test、Workbench、valibot-form、Rolldown、CLI、Auth、Redis 及其构建依赖
完成 35/35 个任务；治理、全仓 lint、格式与源码声明门禁通过。
Redis 套件有 1 个现有跳过项，不能宣称全部外部集成已运行。公开 fixture 构建入口另验 Promise IO、缺 callback 拒绝和非法 options。
文档本地链接与锚点检查通过。
