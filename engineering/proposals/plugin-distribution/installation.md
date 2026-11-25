# Host 安装预检与结果跟踪

Package Manager 已能用 pnpm 物化不可变候选，审阅整批导出、依赖与消费者变化，并在发布 wrapper 前复核。当前预测范围和失效条件见[包管理器安装与恢复](../../../plugins/package-manager/DESIGN.md#准备与确认)。[安装用法](../../../docs/plugins/package-manager.md) · [市场来源与版本解析](../../PLUGIN_MARKET.md#两条安装路径)

## 插件依赖与普通 npm 依赖

发行坐标包含 registry、包名和精确版本。Plugin 运行身份来自公开定义，同包升级可能改变多个定义、默认节点或 fork。包来源与冲突按既有 [Plugin identity](../../PLUGIN_IDENTITY.md) 处理。普通依赖、下载认证和 peer context 由 pnpm 解析。项目依赖由应用构建和锁文件管理，托管安装由 Package Manager 记录选择和发布入口。

## 安装与升级的预检

Host 已根据候选根定义的 required/optional 引用和当前策略预测 provider 重新绑定及传递阻塞。早期制品、未知重导出及多来源定义会留下预测缺口。固定 import 冲突和审阅过期按现有安装协议报告。[依赖预览](../../../plugins/package-manager/DESIGN.md#准备与确认)

剩余问题是哪些共享运行时版本或宿主服务要求能在发布入口前核对。用真实 Plugin 分别对照已装配服务、缺服务和版本不兼容的 Host，将预检与实际接纳报告对比。作者的 npm peer 表达包版本要求，目标 Host 拥有共享实例和实际服务装配。预检须区分缺少必需服务、可选集成未启用和制品声明不足。需要补充发布信息时，先明确候选包中究竟缺少哪个事实。[发布材料](package-format.md)

## 运行与结果所有权

当前确认回执逐包返回 wrapper 的实际发布或撤回结果。Vite 的 live 接纳、原生 Host 的 next-start 及具体节点的启动结果仍由 Host/Core 报告。[动态来源](../../../docs/host/configuration.md#动态来源)

若调用方需要断线或重启后查询同一次安装，须确定操作标识、回执保存期，以及如何关联固定发行、写入和特定 Host 的接纳结果。验收区分准备失败、部分入口发布、已保存待应用和新代启动失败。重试查询沿用原操作标识，十分钟的内存候选只用于本次确认。[安装与恢复](../../../plugins/package-manager/DESIGN.md) · [生命周期](../../CORE_LIFECYCLE_SEMANTICS.md)

## 卸载、降级与旧制品

Workbench 卸载按已审阅的 revision 撤回 wrapper，保留业务数据与旧 revisions/slots。完整的卸载预检仍需 Host/Core 判断同包节点、required 阻塞与 optional 变化。若需要清理旧制品，先证明安装选择、进行中的操作和执行器都已释放引用。降级按固定发行重新接纳，业务数据与外部副作用的恢复由其所有者负责。
