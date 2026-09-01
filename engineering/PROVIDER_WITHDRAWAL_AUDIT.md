# Provider Withdrawal Audit

本文记录 owner-bound runtime capability 在 provider withdrawal、generation stop 和 cached handle 场景下的
当前事实。它是维护者审计入口，不引入统一 public lifecycle hook。

## 审计词汇

| 词汇                   | 含义                                                                  |
| ---------------------- | --------------------------------------------------------------------- |
| publication withdrawal | 从 registry、route table、layout 或 catalog 撤销未来 discovery/lookup |
| owner admission close  | owner generation 停止接纳新的 capability operation                    |
| accepted work drain    | 停止时等待已接纳的 invocation、setup 或 task settle                   |
| root resource          | runtime root 拥有的长期 backend/carrier/registry                      |
| generation handle      | 绑定某个 Plugin Context/generation 的 view、registration 或 handle    |
| manual dispose         | 只撤销一个 registration/operation，不等价于 owner stop                |

## Capability matrix

| Capability                 | Owner 与 publication                                                                             | Stop 后的 retained handle                                         | In-flight stop                                                                 | Replacement/root ownership                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| caller-bound Plugin facade | Core 为每个 consumer/provider generation pair 编译普通 descriptor facade                         | getter/method/write 在 provider gate 关闭后拒绝                   | 每次 invocation 取得 owner lease；provider stop 等待 settle                    | replacement 建立新 pair cache；不同 consumer 不共享 facade                             |
| root commands              | root catalog 共享；registration 绑定注册者 effects                                               | publication 消失后 installed handle 按 catalog 规则返回 not found | 已接纳 command 收到 owner/call 合成 abort signal，stop 等待 invocation release | registry 属于 root；handler/registration 属于 generation                               |
| carrier command mount      | mount 属于 provider；每条 publication/installer cleanup 属于调用 `registerCommand()` 的 owner    | retained owned command 在 binding 撤回后返回 not found            | 同时持有 provider 与 publication owner admission；任一 stop 均 abort/drain     | replacement 建新 mount/binding；旧 route 不跟随同名或 schema-compatible implementation |
| Elysia contribution        | owning Plugin generation 拥有 sealed app，directory 原子发布                                     | retained app 不再能修改或重新发布                                 | request/stream/WS 取得 owner lease，stop abort request signal 并等待 settle    | physical carrier/root directory 共享；replacement 使用全新 app                         |
| database                   | owner-bound handle 固定 active database instance                                                 | `read()`/`transaction()` 拒绝新 operation                         | 已接纳 operation 等待排空，不强行 abort transaction                            | scheduler/instance registry 属于 root；lineage activation 原子切换                     |
| Node module                | `use()` consumer lease 和 setup cleanup 绑定 owner effects                                       | stop 后 source update ignored，late setup cleanup 立即执行        | stop 等待当前 update task                                                      | source binder/cache 可共享；每个 consumer setup 独立                                   |
| worker task                | caller generation 的 `OwnerLease`；pool/queue 属于 root                                          | 旧 service view 以 `NOT_RUNNING` 拒绝                             | resolving/queued/running task 被取消，并等待 worker 真正退出                   | root pool 复用到 shutdown；active slot 在 termination 后归还                           |
| Workbench entry            | `publish()` 绑定 owning Plugin effects；interactive `openEntry()` 建 fresh roots 和 owner leases | socket epoch/handle 关闭后 stubs 不能继续调用                     | owner stop 关闭 admission、abort open signal 并等待已接纳 Cap’n Web call       | registry/artifacts 属于 root；publication、opened roots、Bridge 属于 generation/open   |
| cache                      | registration 绑定 caller/provider generation                                                     | active gate 关闭后抛 `CacheStoppedError`                          | loader continuation settle 前后仍重新检查 active state                         | backend 可 root/provider 共享；namespace ownership 保持 caller                         |
| rates                      | limiter 绑定 caller/provider generation                                                          | stop/replacement 后抛 `RatesStoppedError`                         | 已提交 backend 的 decision 允许 settle，不回滚                                 | backend state 按具体 provider 生命周期处理                                             |

## Workbench withdrawal 顺序

Workbench 没有独立的 query/event registration 层；interactive Content 使用 framework-owned root，View API 是 Plugin 直接返回的
`RpcTarget`。Withdrawal 固定为：

1. Plugin generation 开始停止时关闭 owner invocation admission；
2. 撤销 definition publication 并推进 registry revision；
3. abort 对应 opened Content/View signals；
4. Workbench session epoch invalidation 关闭全部 opened handles；
5. Shell 先 destroy Bridge，再关闭 host facade 并 dispose opened handle；
6. generation 等待已接纳 calls 释放，然后 drain effects。

Attachment 同时持有 provider 和 consumer owner leases。任一 owner replacement 都使整个 opened Attachment 失效，
不会把剩余 root 接到旧 renderer。Provider factory 保留的 observer/callback stub 必须 `dup()`，subscription target disposer
负责释放 callback 和领域 unsubscribe。

证据集中在：

- `packages/runtime/tests/workbench/workbench-registry.test.ts`
- `packages/runtime/tests/workbench/workbench-client.test.ts`
- `packages/runtime/tests/workbench/workbench-federation.test.tsx`
- `packages/runtime/tests/workbench/workbench-react.test.tsx`
- `packages/workbench-app/tests/workbench-client.test.ts`

## 设计结论

不抽取统一 `GenerationLease`。各 capability 存在真实差异：

- commands 和 Elysia 会 abort 已接纳 work；
- database 等待已接纳 transaction，不强制取消；
- worker task 需要等待物理 worker 退出；
- Workbench 同时拥有 socket epoch、per-open roots 和 Bridge destroy ordering；
- cache 与 rates 的已提交 backend work 语义不同。

只有多个 capability 证明重复同一状态机，并且抽取能删除代码、统一错误与增加测试覆盖时，才评估 internal
primitive。Root-owned durable resource 与 generation-owned handle 不能因抽象而合并。
