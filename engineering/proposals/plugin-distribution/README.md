# 插件分发与市场提案

现行的目录、镜像、查看器与安装契约见[插件市场设计](../../PLUGIN_MARKET.md)。本提案记录仍待决定的分发问题和验收条件。

市场部署和同步见 [Worker 项目](../../../projects/plugin-market/README.md)与[只读镜像](../../../projects/plugin-market/README.md#只读镜像)。安装用法见 [Package Manager](../../../docs/plugins/package-manager.md)，本地构建发布见 [PNPR 体验指南](../../../docs/development/plugin-market.md)。

自动 provenance 收录仍受原生 Sigstore 在 workerd 中的验证问题阻塞。通知处理和人工 `refresh` 的现有边界见 [Worker 项目](../../../projects/plugin-market/README.md#provenance-边界)，复现见[独立实验](../../spikes/plugin-market-worker/README.md)。

## 剩余问题

| 方向           | 还需要决定或实现的内容                                                     | 设计入口                        |
| -------------- | -------------------------------------------------------------------------- | ------------------------------- |
| 自动收录       | 原生 provenance 正负例、可信材料刷新、租约约束下的验证与目录提交、补漏扫描 | [目录生产](index-production.md) |
| 发布格式       | 独立 Plugin manifest 的最小字段与生产者；真实 tarball 的生成及消费         | [发布格式](package-format.md)   |
| Host 安装      | 全包 Plugin/依赖影响预检、过期前提、实际接纳结果与可重查回执               | [安装与生效](installation.md)   |
| 私有市场消费   | 普通消费者权限、Host 凭据引用与缓存隔离；现有管理员私源能力继续保留        | [市场客户端](market-client.md)  |
| 管理界面与契约 | 管理网页、独立契约导出、客户端版本准入及必要的异步管理任务                 | [市场管理](management.md)       |
| 查询演进       | 候选状态、来源可用性、已验证仓库信息、OpenAPI 与代表查询质量               | [目录消费](index-protocol.md)   |
| 运行与恢复     | 主站与镜像的数据所有权、快照新鲜度、目标 D1 容量与备份恢复                 | [市场运行与恢复](foundation.md) |

[交付与验收](delivery-plan.md)汇总各路径的验证条件。ban、重定向、离线授权与多市场政策冲突仍等待具体需求。目录隐藏、分类和官方标记只表达浏览与运营事实。

[Plugin identity](../../PLUGIN_IDENTITY.md)、[Host / Core](../../PLUGIN_SYSTEM.md)与[生命周期](../../CORE_LIFECYCLE_SEMANTICS.md)继续拥有运行身份、装配和接纳结果。应用发行目录的签名由 [Distribution](../../DISTRIBUTION.md)维护，与这里的 npm 插件市场分别演进。
