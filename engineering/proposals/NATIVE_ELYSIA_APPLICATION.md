# Elysia 外部承载的剩余边界

Node 生产与 Vite 开发共用按 Plugin generation 发布路由的机制。已有的网络回归覆盖 Node listener 关闭、客户端断开、stream 与 WebSocket 回收，以及 Vite 替换 generation 时旧连接的归属。[Host HTTP](../HOST.md#http-与管理页面)、[Node listener 回归](../../packages/services/tests/http-listener.test.ts)、[Vite 真实连接回归](../../packages/services/tests/vite/runtime-runner.mts)

## 发布 Plugin 的版本准入

先确定哪些发布包需要声明 `elysia` peer，特别是只通过 `ElysiaApp` 注册路由的 Plugin 是否纳入。再确定接受精确版本还是 semver 范围，以及宿主实际加载预发布版时如何匹配。静态构建已经固定 Elysia 的模块身份，现有 Cap’n Web、TinyBase 准入要求精确版本。[静态 Elysia 解析](../../packages/rolldown/src/cli/elysia-singleton.ts)、[Host 共享运行时准入](../../packages/host/src/shared-runtime.ts)

拟由构建或加载计划从发布包自己的清单读取兼容声明，Native 与 Vite 在开始 Plugin 生命周期前按同一规则校验。制品可以在模块求值前检查，直接传入的 constructor 可能已经求值。应用内源码继续由应用 lockfile 管理。验收覆盖缺声明、非法声明、兼容与不兼容版本、同版本多份实例，并核对两种 Host 对同一包的诊断。

## 依赖上游公开接口的能力

- **等价路由冲突。** 当前可拒绝不同 owner 下 kind、method 和声明路径都相同的路由。待 Elysia 公开与实际 matcher 一致的比较依据，用参数改名、可选片段和结尾斜线检验哪些路径确实等价。被拒候选要指出两个 owner 和冲突路由，已经接纳的路由仍可访问。[路由回归](../../packages/services/tests/services/native-elysia-application.test.ts)
- **外部挂载与卸载。** 当前 `2.0.0-rc.0` 的 Plugin 实例直接调用 `app.onStart()`、`app.onStop()` 会因缺少外部挂载协议而失败。`app.listen()`、`app.stop()` 操作物理 listener，由宿主拥有。待上游提供公开挂载协议，验证正常挂载、失败回滚、延迟登记的清理、在途请求排空及每次挂载只卸载一次，并明确 `.use()` 间接带入的回调怎样处理。[当前生命周期保护](../../packages/services/src/elysia/ElysiaApplicationDirectory.ts)

新增兼容声明应指明实际使用的 Elysia 插件、版本、carrier 和所需能力，并在对应入口验证。只有实际工作负载显示 dispatch 是瓶颈时，再用相同路由、hook、stream 和 WebSocket 流量比较优化前后的延迟、吞吐与资源占用。
