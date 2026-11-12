# 插件分发与市场的剩余设计

状态：部分已实现；本目录只保留后续设计与验收问题。核对日期：2026-11-12。

市场底座已经落地：Worker/D1、公开浏览网页、多 registry 与私有来源隔离、人工收录、FTS5 查询、分类标签、Cap’n Web 管理和持久通知回执均有实现。Package Manager 已整合市场浏览与准备/确认安装。
当前用法由 [Worker 项目](../../../projects/plugin-market/README.md)、[Package Manager](../../../docs/plugins/package-manager.md)与其[内部设计](../../../plugins/package-manager/DESIGN.md)维护；本地构建发布链路见 [PNPR 体验指南](../../../docs/development/plugin-market.md)。

自动 provenance 收录仍被原生 Sigstore/workerd 验证阻塞。Worker 当前处理通知时明确失败，人工 `refresh` 也只接纳未声明 attestations 的发行。已有通知、租约和调度机制不能代表这条自动收录路径完成；复现见[独立实验](../../spikes/plugin-market-worker/README.md)。

## 剩余问题

| 方向           | 还需要决定或实现的内容                                                     | 设计入口                        |
| -------------- | -------------------------------------------------------------------------- | ------------------------------- |
| 自动收录       | 原生 provenance 正负例、可信材料刷新、租约约束下的验证与目录提交、补漏扫描 | [目录生产](index-production.md) |
| 发布格式       | 独立 Plugin manifest 的最小字段与生产者；真实 tarball 的生成及消费         | [发布格式](package-format.md)   |
| Host 安装      | 全包 Plugin/依赖影响预检、过期前提、实际接纳结果与可重查回执               | [安装与生效](installation.md)   |
| 私有市场消费   | 普通消费者权限、Host 凭据引用与缓存隔离；现有管理员私源能力继续保留        | [市场客户端](market-client.md)  |
| 管理界面与契约 | 管理网页、独立契约导出、客户端版本准入及必要的异步管理任务                 | [市场管理](management.md)       |
| 查询演进       | 候选状态、来源可用性、已验证仓库信息、OpenAPI 与代表查询质量               | [目录消费](index-protocol.md)   |
| 运行与恢复     | 目标 D1 容量、备份恢复、恢复后的编辑版本和租约失效，按需引入对象存储       | [底层结构](foundation.md)       |

当前公开网页是浏览入口；运营编辑仍通过管理 API 和脚本进行。多来源目录已实现，受保护市场的普通消费者认证尚未接入，不能把这两项合并为“私有来源未实现”。

## 继续讨论的顺序

先确定下一轮要解决的实际使用路径：可信自动收录、真实 Host 升级预检，或管理界面。前两者分别受运行环境和 Host 状态接口约束，不能由 UI 或新增 manifest 字段代替。

[交付与验收](delivery-plan.md)列出每条路径的完成条件。ban、重定向、离线授权、多市场政策冲突仍等待具体需求；已有隐藏、分类和官方标记不扩大为安装准入政策。

[Plugin identity](../../PLUGIN_IDENTITY.md)、[Host / Core](../../PLUGIN_SYSTEM.md)与[生命周期](../../CORE_LIFECYCLE_SEMANTICS.md)继续拥有运行身份、装配和接纳结果。应用发行目录的签名由 [Distribution](../../DISTRIBUTION.md)维护，与这里的 npm 插件市场分别演进。
