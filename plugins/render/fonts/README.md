# `@pluxel/fonts`

系统字体发现、程序化注册、持久化上传与统一默认字体。

在直接导入它的包目录安装（catalog 工作区见下方指南）：

```sh
pnpm add @pluxel/fonts
```

宿主 catalog 需要 FontsPlugin；业务插件通过 constructor 注入直接使用的能力。

- [用法、配置与验证](../../../docs/plugins/rendering/fonts.md)
- [维护约束](DESIGN.md)

核心字体发现、`FontsConfig.files` 部署文件与程序化注册无需 Workbench 或 Persistence。配置可用同一导出的 `FontsConfig` 绑定环境变量和 JSON 文件；保存偏好、上传集合才需要安装 Persistence。

跨 renderer 的调度、输入所有权与取消规则见 [执行架构](../ARCHITECTURE.md)。
