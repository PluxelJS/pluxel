# `@pluxel/auth`

Workbench / Management 认证，支持 password、password + TOTP 与 OIDC。

在直接导入它的包目录安装（catalog 工作区见下方指南）：

```sh
pnpm add @pluxel/auth
```

宿主 catalog 需要 AuthPlugin；业务插件通过 constructor 注入直接使用的能力。

- [用法、配置与验证](../../docs/plugins/auth.md)
- [维护约束](DESIGN.md)

宿主需安装 Management；password、TOTP 和 confidential OIDC 还需要 Vault。
