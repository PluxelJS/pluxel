# Core 实现入口

公开导出以 [package.json](./package.json) 为准；作者用法见[插件模型](../../docs/plugin-development/model.md)，工程约束见 [CORE.md](../../engineering/CORE.md)。

| 位置                                                  | 修改范围                                                                                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                                        | Plugin 作者 API 与只读契约                                                                                                                |
| `src/host.ts`                                         | 服务作者 token/descriptor                                                                                                                 |
| `src/plugins/`                                        | identity、definition、composition 与 generation lifecycle；详见[目录说明](./src/plugins/README.md)                                        |
| `src/internal/di/`                                    | 增量依赖图、snapshot、instance store                                                                                                      |
| `src/plugins/runtime/PluginActor.ts`                  | 单 generation 的显式状态转移、启动、abort 与 drain                                                                                        |
| `src/plugins/runtime/plugin-service/HostLifecycle.ts` | pre-root generation finalization、commit preparation 与原子 publication                                                                   |
| `src/services/`                                       | effects、events、内存 config facts                                                                                                        |
| `src/fs/`、`src/tinybase/`                            | 固定 FS、原子写入、TinyBase 文档/Store、保存屏障与最终关闭，见 [FS](../../engineering/FS.md) 和 [TinyBase](../../engineering/TINYBASE.md) |
| `src/vault/`                                          | 内建凭据契约、owner 隔离、惰性加密与部署绑定、watch 和最终关闭，见 [Vault](../../docs/plugin-development/vault.md)                        |
| `src/logger/`                                         | Context logger facade 与 category identity                                                                                                |
| `src/context/core-facilities.ts`                      | Core 与应用 Host 设施声明的同步校验和快照                                                                                                 |
| `src/context/plugin-execution.ts`                     | Host 执行默认值、期限校验与节点期限接线                                                                                                   |
| `src/logging/`                                        | Core 日志安装、policy、store、query 与最终关闭，见 [Logging](../../engineering/LOGGING.md)                                                |
| `src/http/`                                           | 原生 Wretch 与 Fetch、Host 策略、代理资源和节点活动，见 [出站 HTTP](../../engineering/OUTBOUND_HTTP.md)                                   |
| `src/toolchain.ts`                                    | 构建生成 metadata 的内部协作入口                                                                                                          |

Core 不拥有 Vite/HMR、HTTP、Host 配置复制或宿主退出策略。内部 helpers 不扩展为 Plugin 作者 API。
