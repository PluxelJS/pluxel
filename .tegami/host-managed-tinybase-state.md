---
packages:
  '@pluxel/services': major
---

# Host 托管原生 TinyBase 状态

新增 `/tinybase` 服务入口，每个 Plugin node 使用一份原生 Store，Host 负责恢复、publication 后自动保存、flush 屏障、关闭排空、容量与显式故障恢复。`standardServices()` 与 `servicesPreset()` 包含该服务，应用需直接安装 Services 接纳的精确 TinyBase 版本。

官方 Host 配置、运行策略、日志 policy 和 Management 布局通过 TinyBase 私有文档保存，保留领域文档格式与保存后发布语义；Management 组合新增 TinyBase 服务依赖。旧 JSON 不在启动时迁移，已有部署需备份后显式转换。
