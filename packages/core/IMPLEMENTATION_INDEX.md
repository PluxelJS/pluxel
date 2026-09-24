# Core 实现入口

公开导出以 [package.json](./package.json) 为准；作者用法见[插件模型](../../docs/getting-started/plugin-model.md)，工程约束见 [CORE.md](../../engineering/CORE.md)。

| 位置                                                  | 修改范围                                                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/index.ts`                                        | Plugin 作者 API 与只读契约                                                                         |
| `src/host.ts`                                         | 服务作者 token/descriptor                                                                          |
| `src/plugins/`                                        | identity、definition、composition 与 generation lifecycle；详见[目录说明](./src/plugins/README.md) |
| `src/internal/di/`                                    | 增量依赖图、snapshot、instance store                                                               |
| `src/internal/fsm/`                                   | PluginActor 的 baked state machine                                                                 |
| `src/plugins/runtime/plugin-service/HostLifecycle.ts` | pre-root generation finalization、commit preparation 与原子 publication                            |
| `src/services/`                                       | effects、events、内存 config facts                                                                 |
| `src/logger/`                                         | Context logger facade 与 category identity                                                         |
| `src/toolchain.ts`                                    | 构建生成 metadata 的内部协作入口                                                                   |

Core 不拥有 Vite/HMR、HTTP、持久化或宿主退出策略。内部 helpers 不扩展为 Plugin 作者 API。
