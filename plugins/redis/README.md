# `@pluxel/redis`

原生 Redis connection、typed Lua，以及 Cache / Rates backend。

本包为 workspace 内部预览，不是仓库外项目的安装入口。

宿主 catalog 需要 RedisPlugin；按需加入 RedisCacheBackendPlugin / RedisRatesBackendPlugin；业务插件通过 constructor 注入直接使用的能力。

- [用法、配置与验证](../../docs/plugins/redis.md)
- [维护约束](DESIGN.md)
