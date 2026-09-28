# `@pluxel/cache`

caller 隔离的 local / backend 缓存、scope 与进程内 single-flight。

本包为 workspace 内部预览，不是仓库外项目的安装入口。

宿主 catalog 需要 CachePlugin 与一个 CacheBackend provider；业务插件通过 constructor 注入直接使用的能力。

- [用法、配置与验证](../../docs/plugins/cache.md)
- [维护约束](DESIGN.md)
