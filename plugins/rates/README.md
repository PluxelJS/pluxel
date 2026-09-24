# `@pluxel/rates`

caller 隔离的原子频率判定，支持 memory 或 Redis backend。

本包为 workspace 内部预览，不是仓库外项目的安装入口。

宿主 catalog 需要 RatesPlugin 与一个 RatesBackend provider；业务插件通过 constructor 注入直接使用的能力。

- [用法、配置与验证](../../docs/plugins/rates.md)
- [维护约束](DESIGN.md)
