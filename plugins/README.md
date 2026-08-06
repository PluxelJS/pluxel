# Pluxel 官方插件

`plugins/*` 存放由 Pluxel 与框架一同维护、可独立安装和装配的具体插件。它们不是 runtime 内置服务：
应用通过正常 catalog 选择插件，其他插件也只通过与第三方作者相同的公开依赖协议消费它们。

## 仓库定位

官方插件是 Pluxel 的实践验证（dogfood）层和一致性验证层，承担两个同等重要的职责：

1. 提供可复用能力，避免下游插件重复处理生命周期、并发、配置、诊断和 Workbench 集成；
2. 在真实使用压力下检验公开作者模型，把反复出现的阻力转化为更好的 Pluxel 跨插件设计。

官方插件始终跟随当前 Pluxel 设计。core/runtime 的作者面发生变化时，如果受影响的官方插件仍依赖旧
模式、兼容别名或私有 helper，这项变化就不算完成。反过来，官方插件也不能成为框架特例的理由：只有
当问题能够证明是一项对第三方 provider 同样成立、可复用的 ownership 或 lifecycle 需求时，才应反哺
core/runtime。

## 目录与能力边界

- `plugins/*`：具体 `@Plugin` 实现及其包内 Workbench extension。
- `packages/*`：不声明具体插件生命周期的通用 contract、adapter 和框架库。
- `projects/*`：应用与产品集成，也是多个官方插件在真实 host 中共同运行的验证场所。
- 官方插件只使用 `@pluxel/runtime` 的公开入口，不使用 toolchain 或 host installation internal helper。
- 必需 capability 写成 constructor dependency；可选集成使用 `plugins.use()`。
- 调用方状态从依赖注入时绑定的 `ctx.caller` 推导。共享 provider 状态不得依赖可变的全局“当前调用方”。
- Workbench 是可选且由宿主拥有的能力。它可以投影配置、状态、诊断和 typed resource，但关闭后不得影响
  业务能力与核心生命周期。
- secret 只以安全引用表示，并由适当的宿主能力解析；不得复制到 Workbench contract、日志或普通持久化
  配置中。

## 反哺流程

```text
官方插件中的真实使用
  -> 识别反复出现的作者阻力或缺失不变量
  -> 用真实生命周期与并发场景验证问题
  -> 改进最小且通用的 Pluxel 公开边界
  -> 在同一变更中迁移官方插件
  -> 更新当前作者模型的权威文档
```

在需求得到充分理解前，包内 workaround 保留在包内。这样既能让官方插件持续充当设计探针，也能避免
runtime 逐渐积累只服务于某个集成的特殊 hook。

## 首批插件

- [`@pluxel/cache`](cache/README.md)：显式 scope、同步 local cache、多态异步 backend 与进程内请求合并。
- [`@pluxel/rates`](rates/README.md)：caller-aware 四算法 admission control、原子 decision 与 memory backend。
- [`@pluxel/redis`](redis/README.md)：Redis capability、standalone provider、Lua helper 与内置 cache/rates backend。
- [`@pluxel/wretch`](wretch/README.md)：基于 Wretch 的出站 HTTP capability。
  - `@pluxel/wretch/example`：随包构建的标准 consumer 与 static runtime smoke 入口。
- [`@pluxel/package-manager`](package-manager/README.md)：基于 pnpm Rust engine 的受控插件包安装、原子 source publication 与可选 Workbench 管理页。
- [`@pluxel/metrics`](metrics/README.md)：constructor + `measure()` 的 operation RED metrics，并通过 OTLP/HTTP protobuf 输出。

首批官方插件仍保持 private，以便在真实 consumer 中稳定 contract；`@pluxel/wretch` 提供
原生 immutable Wretch base、最小宿主级出站策略和可选的统一 Workbench HTTP 设置 Port。
