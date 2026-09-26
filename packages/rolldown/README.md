# @pluxel/rolldown

Pluxel 的构建、Vite 源码转换与离线查询工具。应用和插件包共享声明语义；不执行 runtime 服务安装。

| 入口                             | 用途与指南                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `@pluxel/rolldown` 的 `pluxel()` | tsdown static application 构建；[工具链](../../docs/development/tooling.md)                                   |
| `/build` 的 `pluginPackage()`    | 自定义 Plugin package 构建；普通项目使用 `pluxel build`，见[插件包](../../docs/development/plugin-package.md) |
| `/inspect` 的 `openProject()`    | 定位 Plugin/Part、依赖、配置与显式选择的应用输入；[源码查询](../../docs/development/inspection.md)            |
| `/vite`                          | Vite source adapter 与 sourceSpaces；[源码边界](../../docs/development/tooling.md#source-build-boundary)      |
| `/distribution`                  | static artifact finalizer、签名和离线验证；[交付](../../docs/development/distribution.md)                     |

应用入口采用 `defineHostApplication(factory)`。构建静态分析 Plugin 和部署输入声明，不执行工厂或读取环境、秘密文件；运行时才应用输入。

Semantic pass、candidate generation、watcher 与制品发布的内部不变量见 [TOOLCHAIN.md](../../engineering/TOOLCHAIN.md)，发行物约束见 [DISTRIBUTION.md](../../engineering/DISTRIBUTION.md)。
