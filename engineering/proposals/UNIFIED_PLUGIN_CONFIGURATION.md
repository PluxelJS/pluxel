# 插件配置与 Vault 来源设计

本提案的配置工厂、显式 env/file 绑定、config 分层、结构化 Vault KV、只读部署记录、revision/CAS、原子提交与 owner 订阅已经落入实现。当前使用方式与约束以以下文档为准：

- [插件配置](../../docs/getting-started/configuration.md)：schema、来源绑定、优先级与来源只读规则。
- [Vault](../../docs/runtime/vault.md)：结构化记录、观察、并发提交、部署模式与历史数据迁移。
- [Config 架构](../CONFIG.md)：单一 revision、管理写入、持久确认与动态候选检查。
- [Toolchain](../TOOLCHAIN.md)：静态声明边界与 `.env.example`。

普通静态对象优先使用 `satisfies`；应用的 `defineHostApplication(factory)` 保留启动上下文，`envBinding` / `fileBinding` 从显式导入的 schema 推导输入映射。插件只声明数据形状，宿主选择部署变量和文件名称。

移除两个静态 schema 字段后的取舍与实测：

- [官方 Content Mapper 实验](../experiments/tsgo-content-mapper/README.md)：当前 7.0.2 不支持；7.1 nightly 拒绝内建 `.ts` / `.tsx`，不能用它给普通插件源码注入类型。
- [普通 TypeScript 绑定实验](../experiments/tsgo-plugin-inputs/README.md)：保留任意 private `configs.use(schema)` 字段，宿主导入同一 schema；验证源码、发布声明消费者、实际 LSP 补全与诊断。生产方案不增加扩展名、代码生成或编译器插件。

## 尚未扩展的范围

- 生产构建的来源清单仍要求直接、可静态分析的声明。运行时支持动态 catalog 候选检查，不表示构建可推导任意条件或动态 import 的所有绑定。
- 绑定中的 Vault 根 schema 描述部署输入记录；私有 KV 仍由插件业务校验，不自动成为部署入口。
- Vault watcher 表达最新已提交状态，不是保留每次写入的事件日志。插件负责连接替换、QR attempt 生命周期及 applied revision。
- 本轮不增加 Vault plaintext 导出、独立 Documents/Secrets 服务或通用跨 config/Vault 事务。加密文件的备份仍由存储运维负责。
- Node 上的验证不能作为其他运行平台或真实外部账号连接成功的证明。
