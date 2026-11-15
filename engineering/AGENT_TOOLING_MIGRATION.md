# Agent 工具入口与迁移

普通调用方统一使用 `@pluxel/agent-sdk` 的具名子入口；公开用法由 [Agent SDK](../docs/development/agent-sdk.md)、[源码查询](../docs/development/inspection.md) 和[自动化脚本](../docs/development/scripts.md)维护。

| 任务                                           | 作者入口                                                          | 实现所有者                             |
| ---------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------- |
| 发现定义、定位声明/Part/Schema、依赖和文件归属 | `/source` 的 inspectPlugin/listPlugins/inspectFile/inspectProject | Rolldown 静态分析器与查询快照          |
| 配置、实例、生命周期、运行节点发现和日志       | `/host` 的 ScriptSdk；同进程通过 createScriptScope 借用 Host      | Host SDK、coordinator 与 Core          |
| Vite 当前模块图与 Context                      | ProjectScript / ProjectSdk                                        | Host-vite，在 Host SDK 上增加实例访问  |
| 上传编译、控制类型材料同步                     | 原 compileScript、CLI sync                                        | Rolldown compiler、Host materials、CLI |
| 查询/取消已提交操作                            | 原 receipt                                                        | 原 executor 与 transport owner         |

源码查询改为每次调用自行结算的函数，删除了人为 query session、Host inspection backend、SDK 查询方法、双重错误转换和类型反向依赖。源码定义与运行节点继续共享 Core 地址；应用源码发现按显式 import 图返回 definition，不把它当成运行 catalog。

Host 发现保留有界分页和身份清单复用。源码查询保留输入快照、解析来源、文件预算、变更核对、section gaps 和分页失效语义。Control、receipt、真实运行 scope 及资源关闭仍有独立职责，继续由原实现维护。

Host 内核与载体使用 `@pluxel/host/internal/agent*`，源码实现从 `@pluxel/rolldown/internal/agent` 发布给作者包。旧作者导出不保留 alias。模板、CLI 生成说明、skill 和示例统一迁移到两条公共入口。
