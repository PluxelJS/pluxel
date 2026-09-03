# Testing v2 migration ledger

> 状态：实施清单。API 语义以 [`CONTRACT.md`](CONTRACT.md) 为准。这里记录旧调用如何分类、由哪个 package 接收，以及自动化不能替代的人工判断。

## 迁移原则

1. 先实现并验证新 entry，再迁移调用方；不在 main 发布新旧两套 public surface。
2. codemod 只处理可证明等价的局部模式。provider candidate、initial/live config、root/internal authority 必须按产品事实分类。
3. package 自有 fixture 可以封装重复业务拓扑，但不能重新导出 generic host alias。
4. 每一批迁移完成后运行 package typecheck/test，再进入下游 package。

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

- no public imports of removed root `@pluxel/test` or old host/launcher symbols;
- no author receiver with staged parameterless `commit()`/`commitAllowFail()`, `cfg()`, mutable `fork()` or root `ctx`;
- no public package export for removed aliases or `@pluxel/test` root;
- no dynamic Vite/direct-launch `{ config }` option;
- matcher augmentation is visible from the canonical preset without importing runner code from Core/Runtime test entries;
- docs, templates and package READMEs contain only current API after implementation;
- each affected public package has a pending Tegami major entry.

Text searches must constrain import path or receiver type so unrelated production transactions and local functions named `createHost` do not produce false positives.
