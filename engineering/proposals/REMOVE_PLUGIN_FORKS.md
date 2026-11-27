# 是否删除 Plugin fork

Core 与 Host 继续支持同一 concrete definition 的 default 和 fork 节点。待决定的是实际应用是否需要 Host 分别管理这些节点的上游依赖、启停与持久身份。每个节点有自己的运行代和配置，同一定义的节点共享代码、HMR 与进程。[Plugin 身份](../PLUGIN_IDENTITY.md)、[Host](../HOST.md)

## 已知调用方

- Redis connections 和 S3 buckets 已由各自的 Plugin 管理。consumer 通过 ID 选择连接或 bucket，provider 对句柄和资源寿命负责。这两种装配已有领域实现。[Redis 连接目录](../../docs/plugins/redis.md#连接目录与生命周期)、[S3 bucket 目录](../../docs/plugins/storage.md#bucket-目录与生命周期)
- 实验插件 `InvoicePlugin` 声明 `forkable: true`，依赖抽象 `Playwright`，并读取本节点的配置和 Vault。其测试装配启动默认节点。需从实际应用核对是否同时部署多个 Invoice 节点，各自选择哪个 Playwright provider，以及谁依赖该节点的独立启停。[Invoice 实现](https://github.com/PluxelJS/plugins/blob/main/browser/invoice/src/index.ts)、[测试装配](https://github.com/PluxelJS/plugins/blob/main/browser/invoice/tests/setup.ts)
- 生成的 `control` 入口公开 `nodeAddress(forkId)`。脚本可列出已声明的 fork，再按地址读配置、启停或调用实例。调查下游时也要查这样的脚本以及保存的节点引用。仓库另有演示 consumer 选择 fork 的示例。[插件控制](../../docs/development/plugin-control.md)、[Fork 示例](../../projects/plugin-host/src/demo/advanced/DemoForks.ts)

## 用实际装配决定

选一个使用同一定义多个节点的应用，核对其 Host 声明、已保存的 profile 和实际 consumer。记录谁创建节点、为谁选择上游、当某个 provider 缺失或被替换时哪些 consumer 应停止、重绑或继续运行。核对切换时缓存句柄和在途操作如何结算，以及重启后由哪个节点接回持久数据。

如果这些有界、持久的实例需要 Host 独立控制，且放入一个领域目录就必须重新实现依赖阻塞、替换与清理，应保留 fork。另有下游依赖不可替代的 node 身份时也应纳入保留依据。若已知实际装配都能通过领域条目或不同 concrete definitions 保持这些行为，且所有节点身份都有明确迁移去向，才评估把 durable owner 收缩为 definition。当前公开声明和默认节点测试都不足以作这个决定。

## 选择收缩时的迁移条件

1. 从 lowering 的 forkability、Core address/slot/family、Host 的依赖选择与启停，一直核对到 SDK 生成与动态发现、Management RPC、Workbench route 及持久 namespace。目标是 definition 成为唯一持久身份，每个 concrete definition 仍有独立的运行代和 effects。可选依赖和抽象 provider 的选择在 Native、Vite/HMR、test Host 上须保持原语义。[各领域身份与持久化格式](../PLUGIN_IDENTITY.md#各领域作用域)
2. 按 profile 列出 default 与 fork 的记录和反向引用，包含配置、上游选择、自动启动、日志及派生的数据键。仅有 default 时按 definition 转换。仍有旧 Redis/S3 fork 时同时映射领域条目和 consumer 的选择。冲突或第三方 fork 缺少可证明的映射时，离线转换报告具体节点，由其所有者提供迁移规则。
3. 在 breaking release 中同步替换公开地址、生成的控制入口、引用和持久格式。用已有 profile 验证离线转换与重开，运行时只读取新格式。收缩后若仍需持久的 fork ID 或另一套多实例协调器，应重新评估这项变更。
