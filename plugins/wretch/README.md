# `@pluxel/plugin-wretch`

原生 immutable Wretch client，共享宿主的出站并发、超时与 origin policy。

在直接导入它的包目录安装（catalog 工作区见下方指南）：

```sh
pnpm add @pluxel/plugin-wretch
```

宿主 catalog 需要 WretchPlugin；业务插件通过 constructor 注入直接使用的能力。

- [用法、配置与验证](../../docs/plugins/wretch.md)
- [维护约束](DESIGN.md)

普通 HTTP client 与受管设置都可在 `services: []` 中运行；受管设置显式启用后使用 Core 内建 TinyBase，文件后端由 Host 统一选择。
