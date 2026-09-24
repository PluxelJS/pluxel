# `@pluxel/storage`

通过 s3mini API 访问有界的 local / remote bucket catalog。

本包为 workspace 内部预览，不是仓库外项目的安装入口。

宿主 catalog 需要 S3Plugin；业务插件通过 constructor 注入直接使用的能力。

- [用法、配置与验证](../../docs/plugins/storage.md)
- [维护约束](DESIGN.md)
