# 插件发行还需提供哪些信息

一次发行对应 registry 中一个 npm 包的精确版本，一个包可以提供多个 Plugin。市场检查用户选中的发行，Package Manager 预览安装影响，Host 决定哪些定义和节点能接纳。新增发布字段的依据是这些调用方在读取实际 tarball 后仍缺少的事实。[插件市场设计](../../PLUGIN_MARKET.md) · [Plugin 身份](../../PLUGIN_IDENTITY.md)

## 消费者已有的材料

| 消费者                 | 可直接使用的事实                                                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 市场 Worker            | 从 registry 读取包名、版本和 SHA-512，核对整份归档的字节，再检查包内 `package.json`、显式 exports 目标、Core peer 和 `pluxel.pluginPackages`。[发行检查](../../../projects/plugin-market/README.md#制品容量与迁移) |
| 项目与 Package Manager | 发布后的 npm 字段给出公开入口、依赖范围和可选关系。版本及兼容范围由作者维护，项目使用自己的包管理器和锁文件，托管安装由 pnpm 解析。[插件包构建](../../../docs/development/plugin-package.md)                       |
| Host 安装预检          | 编译器生成的 `pluxel.control` 清单列出定义、控制契约及材料。可选的 `dependencies.json` 为能静态确定的定义给出 required、optional、provider 和 fork 信息。缺失声明时预览报告预测缺口。[安装设计]                    |

[安装设计]: https://github.com/PluxelJS/plugins/blob/main/package-manager/DESIGN.md#准备与确认

控制清单逐文件记录的是**控制材料**的长度和 SHA-256。若消费端需要核对某个运行资源，应确定它在包内的路径、当前负责定位或验证它的组件，以及现有整包 SHA-512 为什么不足以支持这项操作。[控制清单](../../../packages/core/src/internal/control-manifest.ts) · [市场归档检查](../../../projects/plugin-market/src/registry/tarball.ts)

## 需要用实际插件回答的问题

- **市场详情。** 对同时导出多个 Plugin 和普通库的包，现有控制材料能否在不加载代码时列出已声明的 Plugin 及其公开入口？遇到没有控制清单的旧包或归属不明的重导出，详情应显示已知范围。
- **Host 预检。** Workbench 已有 `pluxel.workbenchCapnweb` 的构建和准入检查。遇到另一项能改变安装决定的固定服务或版本要求时，再核对已有声明、声明所有者和目标 Host 的装配事实。[共享运行时准入](../../WORKBENCH.md#definition-与-publication) · [安装预检](installation.md#安装与升级的预检)

选用具有上述导出或宿主要求的真实发行，先记录现有字段能支持哪些判断。如果某项材料同时服务于项目依赖和长驻 Host，让两者消费同一 tarball。只有现有材料仍无法回答具体消费者的问题时，再决定扩展原有字段或单独发布 manifest，并确定谁生成、谁读取。

如需增加随包文件，发布者负责从声明或构建结果生成材料。读取方检查受支持的格式、包内路径、实际文件和声明的摘要，拒绝冲突。npm 兼容范围继续由 peer 声明，实际装配的服务由目标 Host 报告。发布、通知和目录收录沿用各自的结果。[发布流程](../../RELEASING.md) · [发行通知](index-production.md#ci-发布通知与-npm-provenance)
