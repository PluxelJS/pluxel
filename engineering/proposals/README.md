# 待讨论与待验证的设计

本目录记录仍会改变实现选择的问题。当前契约见[工程索引](../README.md)，使用方式见[公开文档](../../docs/index.md)，已执行验收的环境和范围见[工程记录](../records/README.md)。

| 提案                                                | 待判断的问题                                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [插件分发与市场](plugin-distribution/README.md)     | 自建 registry 能否恢复同一发行的制品，带 provenance 的发行如何收录，安装预检还缺哪些事实，私有目录需要哪些读取权限 |
| [跨平台 Host](PLATFORM_NEUTRAL_RUNTIME.md)          | 跨 isolate 的状态写入与恢复、平台服务及远程 Workbench 会话由谁持有                                                 |
| [Agent 执行与控制](AGENT_WORKFLOW.md)               | 远端 Vite 如何定位脚本，Cloudflare 如何持有一次执行，离线校验能覆盖哪些输入                                        |
| [表单适配器与远程校验](schema-form/README.md)       | 哪些真实调用方需要自有控件、独立源码投影或失焦时的服务端校验                                                       |
| [Plugin fork 的取舍](REMOVE_PLUGIN_FORKS.md)        | 哪些实际部署依赖独立节点，收缩身份后现有持久数据和控制调用如何处理                                                 |
| [Elysia 外部承载](NATIVE_ELYSIA_APPLICATION.md)     | 等价路由冲突、包版本准入和外部应用生命周期各需要什么依据                                                           |
| [插件的 Paraglide i18n 编译工具](I18N_PARAGLIDE.md) | 在实际 VS Code Sherlock 扩展中复核普通键和嵌套键的行内预览与编辑                                                   |
