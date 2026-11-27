# Host 安装预检与结果跟踪

Package Manager 已能用 pnpm 物化不可变候选，审阅整批导出、依赖与消费者变化，并在发布 wrapper 前复核。当前预测范围和失效条件见[包管理器安装与恢复](https://github.com/PluxelJS/plugins/blob/main/package-manager/DESIGN.md#准备与确认)。[安装用法](../../../docs/plugins/package-manager.md) · [市场来源与版本解析](../../PLUGIN_MARKET.md#两条安装路径)

## 插件依赖与普通 npm 依赖

发行坐标包含 registry、包名和精确版本。Plugin 运行身份来自公开定义，同包升级可能改变多个定义、默认节点或 fork。包来源与冲突按既有 [Plugin identity](../../PLUGIN_IDENTITY.md) 处理。普通依赖、下载认证和 peer context 由 pnpm 解析。项目依赖由应用构建和锁文件管理，托管安装由 Package Manager 记录选择和发布入口。

## 安装与升级的预检

Host 已根据候选根定义的 required/optional 引用和当前策略预测 provider 重新绑定及传递阻塞。早期制品、未知重导出及多来源定义会留下预测缺口。固定 import 冲突和审阅过期按现有安装协议报告。[依赖预览](https://github.com/PluxelJS/plugins/blob/main/package-manager/DESIGN.md#准备与确认)

Otel 的 Prometheus 开关改变启动时用到的宿主服务，两种配置得到相同的插件依赖预测。此类条件由节点在运行时解析，源码 import 或 npm peer 都不足以把服务列为每次安装的必需项。[预览与启动对照](../../records/host-deployment.md#otel-安装预览与启动2026-11-25)

尚待验证的是固定的宿主要求。若真实插件要求特定服务或共享运行时版本，且安装方会据此换用其他发行或调整装配，先核对候选已有的声明和目标 Host 可报告的事实。在相容和不相容的 Host 上对照实际结果，再决定是否扩展预检。[发布材料](package-format.md)

## 运行与结果所有权

当前确认回执逐包返回 wrapper 的实际发布或撤回结果。Vite 的 live 接纳、原生 Host 的 next-start 及具体节点的启动结果仍由 Host/Core 报告。[动态来源](../../../docs/host/configuration.md#动态来源)

若调用方需要断线或重启后查询同一次安装，须确定操作标识、回执保存期，以及如何关联固定发行、写入和特定 Host 的接纳结果。验收区分准备失败、部分入口发布、已保存待应用和新代启动失败。重试查询沿用原操作标识，十分钟的内存候选只用于本次确认。[安装与恢复](https://github.com/PluxelJS/plugins/blob/main/package-manager/DESIGN.md) · [生命周期](../../CORE_LIFECYCLE_SEMANTICS.md)

## 卸载、降级与旧制品

Workbench 卸载按已审阅的 revision 撤回 wrapper，保留业务数据与旧 revisions/slots。完整的卸载预检仍需 Host/Core 判断同包节点、required 阻塞与 optional 变化。若需要清理旧制品，先证明安装选择、进行中的操作和执行器都已释放引用。降级按固定发行重新接纳，业务数据与外部副作用的恢复由其所有者负责。
