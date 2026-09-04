# Pluxel testing guide for coding agents

先问：删除哪一层以后，断言不再成立？选择仍不可删除的最小边界。

| 事实                                                    | 入口                                                  |
| ------------------------------------------------------- | ----------------------------------------------------- |
| 普通函数/对象                                           | 无 host                                               |
| Core graph、DI、config composition、lifecycle、effects  | `createCoreTestHost()` from `@pluxel/core/test`       |
| Plugin + HTTP、commands、database、Vault、Workbench     | `createRuntimeTestHost()` from `@pluxel/runtime/test` |
| static application configure/prepare/bindings/cold boot | `startStaticApplicationTestHost()`                    |
| dynamic source、Vite/HMR、physical HTTP/WebSocket       | 项目 Vite command 或 `startDynamicDevRuntime()`       |
| Workbench React/Shell                                   | browser/React test                                    |

## Canonical patterns

```ts
await using host = createRuntimeTestHost({ vault: {} })

const plugin = await host.start(Plugin, {
	initialConfig: { endpoint: 'https://upstream.test' },
	catalog: [ProviderPlugin],
})

const response = await host.http.fetch(new URL('/health', host.http.origin))
expect(await response.json()).toEqual({ ok: true })
```

- `host.start/add/stop/remove/restart()` 已经提交并等待稳定；不要再调用无参数 `commit()`。
- 多个独立 root 使用 literal batch：`await host.start([A, B, C])`。
- 多个同边界变化或异构 bootstrap config 使用同步 callback：

```ts
await host.commit((change) => {
	change.start(A, { initialConfig: configA })
	change.start(B, { initialConfig: configB })
})
```

callback 内不使用 `await`、不 return value、不读取 host 状态。预期 lifecycle failure 使用 `commitExpectFail()`，并直接断言
返回的 structured `lifecycleReport`；它不会吞 programming、graph 或 persistence error。

`initialConfig` 只用于首次 lifecycle 前的 fixture bootstrap。运行中或已经进入过 lifecycle 的 Plugin 使用
`await host.config.patch(Plugin, patch)`；需要新 generation 时再显式 `restart()`。

required dependency 只声明在 Consumer constructor。Runtime `{ catalog: [Provider] }` 只让 implementation 可用，不重新声明 dependency；Core 使用
`add([Provider, Consumer])`。

## Inbound boundaries

- HTTP/mounted HTTP RPC：`host.http.fetch()`。
- Workbench entry：`using opened = await host.workbench.open({ target, entry, principal })`。
- pure `RpcTarget` contract：`using api = createLocalRpcClient<Api>(target)`。
- WebSocket/Origin/framing/disconnect：真实 carrier，不使用 local RPC 或 `http.fetch()` 冒充。
- command：`host.commands.execute/list()`。
- database/Vault 内容：从当前 running instance 取得 owner-bound handle；restart/replacement 后重新取得。

`start/add/require()` 返回 raw Plugin instance。它可以观察 Plugin 自身业务状态，但不代表 constructor dependency 的 caller-bound facade。测试
`ctx.caller`、consumer admission 或跨 Plugin withdrawal 时，建立真实 Consumer Plugin 并从注入 dependency 调用。

## Ownership and prohibited shortcuts

- host/static/dynamic resource 使用 `await using`；Workbench/local RPC lease 使用 `using`。
- 不导入 internal registry、node slot/address 或 backend admin来缩短 Plugin author test。
- 不直接修改 Vault/database/persistence backend；优先经过业务 API、HTTP、command 或 RPC。
- 不用 `sleep()` 弥补 lifecycle helper 提前 resolve；eventual external/carrier observation才使用 `expect.poll()`。
- 不创建第二台 test dev server；physical smoke 使用 production launcher和标准 client。
- `@pluxel/test/unsafe` 只模拟明确的 toolchain/module evaluation fact，不能成为普通 fixture API。
