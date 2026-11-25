# 插件分发与市场提案

现行的目录、镜像、查看器与安装契约见[插件市场设计](../../PLUGIN_MARKET.md)。本提案记录仍待决定的分发问题和验收条件。

私有来源可以显式启用无证明发行的自动收录。带 npm provenance 的发行仍受原生 Sigstore 在目标 workerd 中的验证问题阻塞。[Worker 项目](../../../projects/plugin-market/README.md#provenance-边界) · [独立实验](../../spikes/plugin-market-worker/README.md)

## 剩余问题

| 方向           | 还需要决定或实现的内容                                                   | 设计入口                        |
| -------------- | ------------------------------------------------------------------------ | ------------------------------- |
| 自动收录       | 原生 provenance 正负例与可信根刷新，将结果接入现有通知事务，补漏扫描     | [目录生产](index-production.md) |
| 发布材料       | 用真实发行确认市场展示或安装决定还缺哪项 npm 与控制材料未提供的事实      | [发布材料](package-format.md)   |
| Host 安装      | 哪些固定服务或版本要求值得预检，哪些调用方需要重查实际接纳结果           | [安装与生效](installation.md)   |
| 私有市场消费   | 普通消费者权限、Host 凭据引用与缓存隔离；现有管理员私源能力继续保留      | [市场客户端](market-client.md)  |
| 管理界面与契约 | 浏览器运营编辑的实际需求，独立管理客户端与异步刷新的采用条件             | [市场管理](management.md)       |
| 查询演进       | 候选状态、来源可用性和已验证仓库信息如何展示，哪些外部客户端需要 OpenAPI | [目录消费](index-protocol.md)   |
| 运行与恢复     | 目标部署的镜像新鲜度、D1 恢复与旧写入失效，自建 registry 的 R2 归档恢复  | [市场运行与恢复](foundation.md) |

[交付与验收](delivery-plan.md)汇总各路径的验证条件。ban、重定向、离线授权与多市场政策冲突仍等待具体需求。目录隐藏、分类和官方标记只表达浏览与运营事实。

[Plugin identity](../../PLUGIN_IDENTITY.md)、[Host / Core](../../PLUGIN_SYSTEM.md)与[生命周期](../../CORE_LIFECYCLE_SEMANTICS.md)继续拥有运行身份、装配和接纳结果。应用发行目录的签名由 [Distribution](../../DISTRIBUTION.md)维护，与这里的 npm 插件市场分别演进。
