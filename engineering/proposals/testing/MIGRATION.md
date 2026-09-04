# Testing v2 migration ledger

> 状态：实施清单。API 语义以 [`CONTRACT.md`](CONTRACT.md) 为准。这里记录旧调用如何分类、由哪个 package 接收，以及自动化不能替代的人工判断。

## 迁移原则

1. 先实现并验证新 entry，再迁移调用方；不在 main 发布新旧两套 public surface。
2. codemod 只处理可证明等价的局部模式。provider candidate、initial/live config、root/internal authority 必须按产品事实分类。
3. package 自有 fixture 可以封装重复业务拓扑，但不能重新导出 generic host alias。
4. 每一批迁移完成后运行 package typecheck/test，再进入下游 package。

## Vitest 5.0.0 runner migration

Testing v2 的 runner baseline 是**精确的 `vitest@5.0.0`**，不是“能通过测试的任意 Vitest 5 版本”，更不是仅把 catalog
从 v4 改到 v5。当前 workspace 仍在 Vitest 4.1.x 时，runner migration 是本重构的前置批次：在继续迁移 host 调用之前，必须让所有
package、plugin、project、template、benchmark、test helper、runner extension 与 CI 都使用 v5 API 和语义。不得保留 v4 alias、compatibility
wrapper、suppressed type error 或只在旧 runner 下才成立的配置。

升级必须同时满足 Node.js `>=22.12.0`、Vite `>=6.4.0`；catalog 和 lockfile 中 `vitest` 必须为 `5.0.0`，已有的
`@vitest/*` companion package 也必须与 `5.0.0` 对齐。这里的完整规则以
[Vitest 5.0.0 migration guide](https://vitest.dev/guide/migration) 为外部 authority；以下 checklist 将其转化为本 workspace 的
不可跳过验收项。

### 全量写法与语义 checklist

| 范围 | 必须迁移或审计的 Vitest 5.0.0 变化 |
| --- | --- |
| test source | `vi.mock`、`vi.unmock`、`vi.hoisted` 只可位于 module top level；需要运行时 mock 时改用非 hoisted 的 `vi.doMock`/`vi.doUnmock`。删除 `test.sequential`、`describe.sequential` 与 `{ sequential: true }`，改用 `{ concurrent: false }`。所有 `resolves`、`rejects`、`expect.poll`、file snapshot 等 async assertion 必须显式 `await`/return；`expect.poll` timeout 后会 reject，async callback 应接受并传递 `AbortSignal`。`toThrow('')` 不再表示空 message，改为 `/^$/`。检查 `test.each`/`test.for` title 和受 snapshot 覆盖的 inspected output，因为 formatter 改为 `pretty-format`。 |
| mock、clock 与 test isolation | `clearMocks` 默认为 `true`：不得依赖 module top level、setup 或 `beforeAll` 的 mock call history；应把断言所需调用放入对应 test，或以明确产品理由局部配置。browser automock 现在返回真正的 stub；要执行真实实现时用 `{ spy: true }` 或 factory。class mock 现在保留 prototype method/`instanceof`，应删除依赖旧 broken mock shape 的断言。fake timer 与 `setSystemTime` 同时控制 `Temporal`，若必须使用真实 `Temporal`，明确放入 `toNotFake`。 |
| matcher、runner extension 与类型 | 自定义 matcher 必须 augment `vitest.Matchers<R, T>` 并返回 `R`（async matcher 显式 `Promise<void>`）；不得继续使用 v4 的单一 generic `Matchers<T>` 或 `jest.Matchers` 代替 Vitest declaration。`@pluxel/test/vitest` 的 lifecycle matcher、type fixture 与 preset augmentation 必须只通过 v5 `vitest` entry 共享同一 `expect` state。直接使用 assertion type 时改为 `Assertion<R, T>`。 |
| config、projects 与 CLI | `-t`/`testNamePattern` 按 `'suite > test'` full name 匹配。inline project 默认继承 root config，并默认共享 Vite server；审计 plugin/setup array merge、per-project instance state，并在确有隔离要求时显式 `extends: false` 或 `sharedViteServer: false`。被 `test.projects` 引用的 config 自己声明 `projects` 时会形成 nested project，不能再 merge root project config。Vitest 不再向父目录查找 config：从子目录执行时显式传 `--config`，并按需要传 `--dir`。 |
| browser mode | `browser.api` 迁到顶层 `test.api`，`browser.isolate` 迁到顶层 `test.isolate`；不得手工访问无 session 的 `/__vitest_test__/` 或无 token 的 UI URL。custom browser command 的 locator 参数改接收 `SerializedLocator` 并读取 `{ selector }`。locator 默认 exact；需要旧 partial matching 时显式 `browser.locators.exact: false`。`toHaveTextContent` 改为 exact string，partial/RegExp 改用 `toMatchTextContent`。使用 `vitest-browser-vue` 或 `vitest-browser-svelte` 的 `render` 必须 `await`。 |
| coverage、reporter 与 artifacts | 每个 coverage glob threshold 独立设置 `perFile`；重新审计相对 project root 精确匹配的 `coverage.include`/`exclude`。读取 `.vitest/` 下的新 attachment、blob、HTML、JSON、JUnit artifact 路径；JSON/JUnit 默认写 file，依赖 stdout 的 consumer 显式配置 `stdout: true`。自定义 screenshot directory 迁至 `browser.expect.toMatchScreenshot.screenshotDirectory`。 |
| custom environment、reporter 与 programmatic API | DOM environment 对 `globalThis`/`window` assignment 现在会更新底层 window。`populateGlobal(...).originals` 保存 property descriptor，恢复时使用 `Object.defineProperty`。worker/pool ID 从 1 起计，定制并发资源名、array index 和 reporter 都必须审计；reporter 要区分 `workerId` 与 `concurrencyId`。`resolveConfig()` 现在返回 resolved Vite config，Vitest config 由 `viteConfig.test` 取得。 |
| benchmark 与 package import | module-scope `bench()` 和 `bench.*` modifier 删除；改为 `test(name, async ({ bench }) => await bench(...).run())`，report/JSON 也迁到 top-level reporter config。移除 `vitest/coverage`、`vitest/reporters`、`vitest/environments`、`vitest/snapshot`、`vitest/runners`、`vitest/suite`、`vitest/mocker`、`vitest/internal/module-runner` imports，并使用其 v5 replacement。不得让 `@vitest/runner`、`@vitest/ws-client` 或独立 `@vitest/expect` 代替从 `vitest` 导入并注册的 runner-owned API。 |

一个条目在当前 workspace 没有命中时，迁移记录必须写明其审计范围和零命中证据；不能因为没有代表性 test 而把该 v5 change 从 gate 中省略。

## Mechanical mappings

| 旧形状                                            | 新形状                                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `@pluxel/test.createHost/withHost`                | `@pluxel/core/test.createCoreTestHost` + `await using`                              |
| `@pluxel/runtime/test.createRuntimeHost`          | `createRuntimeTestHost`                                                             |
| staged Core `add/remove/restart + commit()`       | immediate host command；同一边界多变化才用 callback `commit()`                      |
| staged Runtime `add + start + commit()`           | `await host.start(target, { catalog })`                                             |
| `commitAllowFail()`                               | `commitExpectFail(change => ...)`                                                   |
| pre-lifecycle `cfg().set()`                       | `initialConfig` 或 draft `config.seed()`                                            |
| running `cfg().set()`                             | `await host.config.patch()`                                                         |
| `host.fetch()`                                    | `host.http.fetch()`                                                                 |
| `host.ctx.commands.list/execute`                  | `host.commands.list/execute`                                                        |
| mutable `host.fork()`                             | pure `definePluginFork()`                                                           |
| durable fork deletion mixed with staged mutations | dedicated `commit(change => change.forks.remove(ref))`; it must be the only command |
| lifecycle assert helper                           | Vitest `toHavePluginLifecycleIssue()`                                               |
| `createStaticRuntimeTestHost()`                   | `startStaticApplicationTestHost()`                                                  |
| dynamic create/start/stop                         | `await using runtime = await startDynamicDevRuntime({ entry, signal? })`            |

## `host.ctx` authority ledger

Before the migration, workspace tests contain these main receiver groups. Counts are discovery hints, not acceptance facts; the zero gate below is authoritative.

| Receiver group                                                  | Default destination                                                           | Human decision                                                                 |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `host.ctx.commands`                                             | public `host.commands` driver                                                 | none for list/execute; registration/mount remains internal/domain-owned        |
| `host.ctx.workbench` / internal registry                        | public `host.workbench.open()` for Plugin behavior                            | raw registry, layout revision and failure injection remain internal            |
| `host.ctx.vaultAdmin` / root Vault                              | Plugin Workbench/domain controller or internal Vault tests                    | never create generic author backend admin                                      |
| `host.ctx.adminAccess`                                          | Runtime internal test harness for first-party privileged provider conformance | retain real Runtime Session carrier smoke; do not add author driver by default |
| `host.ctx.root`, logger, effects, runtime state, config service | corresponding package internal test harness                                   | no public service locator                                                      |
| Plugin database/Vault handle                                    | `host.require(Plugin).ctx` owner-bound handle                                 | reacquire after restart/replacement                                            |
| node modules/workers/events capability internals                | Plugin public behavior or Runtime internal harness                            | classify by whether assertion survives removal of the root service             |

Every old `host.ctx` call must appear in one of these categories before deletion. An unclassified call is a migration blocker, not permission to re-add public `ctx`.

## Representative gates

| Risk                            | Required real migration                                            |
| ------------------------------- | ------------------------------------------------------------------ |
| common Runtime lifecycle/config | Rates or Cache single-root and batch suites                        |
| expected lifecycle failure      | Package Manager plus provider-blocked case                         |
| Workbench/Vault                 | S3 credential rotation and Fonts manager/selection                 |
| privileged Management           | Auth provider unit/integration plus physical Runtime Session smoke |
| fork/replacement                | Redis default/forks and definition replacement                     |
| database                        | Cache/storage owner-bound read and cleanup                         |
| static application              | bindings-required and partial startup report cases                 |
| dynamic                         | ready origin, HMR replacement, startup abort and disposal          |
| templates/projects              | create templates, plugin-host, docs showcase compile/test          |

## Executable zero gates

Final verification must encode these checks in repository scripts/type tests rather than depend on this prose:

- catalog、lockfile 和实际 runner 都解析到精确 `vitest@5.0.0`，CI/开发环境同时满足其 Node/Vite 前提；
- AST/import-aware 检查确保 hoisted mock APIs 只在 module top level，所有 async assertion 都被 `await`/return，且不存在
  `*.sequential`、`sequential: true`、v4 matcher generic、removed Vitest entrypoint 或废弃 `@vitest/*` package import；
- 所有 `vitest.config.*`、project config、test CLI、custom environment/reporter、browser command、coverage/reporter artifact consumer 和
  benchmark 都通过上表的 Vitest 5.0.0 semantic audit；没有以 `clearMocks: false` 或其他 compatibility setting 掩盖旧行为；
- no public imports of removed root `@pluxel/test` or old host/launcher symbols;
- no author receiver with staged parameterless `commit()`/`commitAllowFail()`, `cfg()`, mutable `fork()` or root `ctx`;
- no public package export for removed aliases or `@pluxel/test` root;
- no dynamic Vite/direct-launch `{ config }` option;
- matcher augmentation is visible from the canonical preset without importing runner code from Core/Runtime test entries;
- docs, templates and package READMEs contain only current API after implementation;
- each affected public package has a pending Tegami major entry.

Text searches must constrain import path or receiver type so unrelated production transactions and local functions named `createHost` do not produce false positives.
