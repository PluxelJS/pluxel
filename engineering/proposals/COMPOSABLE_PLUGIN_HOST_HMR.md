# Custom Host Artifact Composition

统一应用声明、`@pluxel/host`、`@pluxel/host-dynamic` 与共享开发层已进入当前实现。
当前契约见 [`../PLUGIN_SYSTEM.md`](../PLUGIN_SYSTEM.md)、[`../HMR.md`](../HMR.md) 与
[宿主配置](../../docs/getting-started/host-setup.md)。本提案只保留未实现的扩展边界，不是当前 API。

## 尚未公开的组合边界

Workbench 和 Node artifact 的开发接入目前由 Runtime 的开发组合拥有。
轻量 Host 可以复用通用模块求值与图控制，但没有一个已稳定的公开 API，允许把 Runtime 的 Workbench/Node artifact
能力任意装配到自定义 Context host。不要把内部 compiler、Runtime root 或资源发布 helper 作为第三方扩展点。

只有出现具体自定义宿主消费者时，再确定最小公开组合契约。需要同时验证：

- 能力在 root 创建前安装，关闭后不创建 backend、compiler 或 watcher；
- 候选 artifact 准备失败保留已接受资源，图接受点与资源激活顺序一致；
- Workbench 发布撤销旧会话，Node artifact 仍保留新 setup 成功后清理旧 setup 的领域语义；
- 自定义宿主无需导入官方 Runtime 服务闭包，开发与生产消费相同声明；
- 更新、关闭和迟到构建结果共享明确的接纳、排空与撤回边界。

不为未来扩展预先公开万能 hook 系统；先使用真实消费者验证这两个能力的共同需求。
生产原生 ESM 对已加载 entry 的升级要求进程重启，是当前明确约束，不以 query cache bust 声称实现传递依赖 HMR。
