# 市场与安装插件

状态：初版开始落地；当前用法以 [Package Manager](../../../docs/plugins/package-manager.md) 为准，本文保留后续设计。上级：[提案总览](README.md)。
远端访问与缓存由[目录消费](index-protocol.md)维护；本页只确定消费端职责。
市场发布者的后台与 Agent 管理由独立的[管理 API 与最小后台](management.md)维护。

## 装配

市场浏览与安装由同一个 `PackageManagerPlugin` 提供，可以发布可选 Workbench 页面。
它负责检索、详情、版本选择与安装准备，复用现有 pnpm 获取和不可变入口发布；不再要求另装 Market Plugin。
市场连接默认为空。此时直接输入 npm package spec、准备、确认安装及卸载仍完整可用，页面不请求默认公共市场。
市场后台可以单独部署在 Worker，不需要先运行这个 Plugin 或完整 Pluxel 应用。

消费端既可以是本地应用，也可以是远端长驻 Host。浏览器通过应用接口访问；私有市场和 registry 凭据留在 Host。
CLI 可直接使用相同 HTTP 读取协议，不要求存在 Workbench 或 Cap’n Web 管理权限。
初始 Package Manager 由应用装配提供，避免必须先打开市场才能安装管理器自身。

## 市场连接配置

应用配置拥有市场连接：初版为 `PackageManagerConfig.markets` 中的连接 ID 与 API base URL；市场 API 地址与 npm registry 地址是不同概念。
初版消费公共 npm 市场；私有市场认证引用与私有 registry 联动仍待实现，不在 URL 或普通配置中放 token。
一个组织 API 可聚合公共和私有来源，也可以显式配置多个市场。

请求携带已配置连接引用，不让页面任意提供 URL 驱使 Host 转发凭据。
API、认证主体或配置改变后，隔离旧查询与私有缓存；不能把公共同名包当成私有源失败时的替代品。
市场后台的运营配置属于市场发布者，与这里的连接配置分别维护。

## 按需交互

打开页面只取当前市场的一页摘要；详情、版本和 manifest 分别在需要时获取。
搜索由配置的 API 完成，旧查询结果不能覆盖新查询；缓存有容量边界。
多市场先明确选择或分组展示，各自分页，不混合不同相关性排名。
版本详情展示市场返回的 npm provenance 及关联仓库、commit 和构建链接，数据依据见[仓库与构建信息](index-protocol.md#仓库与构建信息)。
tag 指向尚未验证的版本时显示实际状态，旧版仍可显式选择；展示最近来源观测，不能用页面刚刷新来暗示 npm 信息实时，见[版本选择](index-protocol.md#版本选择与新鲜度)。

选中发行后，将市场 ID、包名与精确版本交给同一安装器；后端从配置连接重新读取详情，并核对原生 pnpm 准备结果的摘要，页面不能提交任意下载 URL。
初版准备阶段实际下载并物化私有 revision，确认只发布该批文件，不重新解析 tag 或重新下载。预览绑定安装 revision、有效期与 Plugin generation；过期或选择变化后需重新准备。
默认仍忽略脚本；部署方显式放开构建时，准备阶段就会执行获准脚本，不能称为无副作用的 dry-run。
预览先展示实际包版本、完整安装选择的变化和 source 更新方式；更完整的 Host Plugin/fork 影响检查依照[安装预检](installation.md#安装与升级的预检)后续接入，不在页面另算一套运行依赖图。
页面展示实际的已保存、待应用、已接纳与失败结果，不把下载完成当成运行成功；重连后查询原操作回执。
停止 Package Manager 释放请求、缓存句柄与页面资源，并撤回未提交预览；已经发布的文件及已运行插件由各自所有者管理。
网络错误应可见，不能伪装为空市场或悄悄切换来源。

初版 UI 与可用操作以 [Package Manager 用法](../../../docs/plugins/package-manager.md)为准；后续运营 feature 和完整安装准入交互见[交付顺序](delivery-plan.md#交付顺序)。
