# 测试边界选择

公开 API 与示例只维护在[测试指南](../../docs/development/testing.md)。本页补充框架内部测试的选择。

| 要验证的事实                             | 边界                                        |
| ---------------------------------------- | ------------------------------------------- |
| 普通函数或对象                           | 普通单元测试                                |
| Plugin DI、配置、lifecycle、服务         | `@pluxel/test` 的 `createTestHost()`        |
| Core graph 白盒                          | `@pluxel/core/internal/test`                |
| 应用 factory、prepare、bindings、冷启动  | `startStaticApplicationTestHost()`          |
| dynamic source、HMR、真实 HTTP/WebSocket | 项目 Vite 命令或 `startDynamicDevRuntime()` |
| React/Shell                              | 浏览器或 React 测试                         |

- `start/require()` 返回 raw instance；验证 caller、consumer admission 或 withdrawal 必须建立真实 Consumer dependency。
- Node/Worker 独立制品不继承 Vitest plugins；需要自定义转换时先用项目构建产出，再显式选择制品来源。
- Host 使用 `await using`，同步 RPC/Workbench lease 使用 `using`；不直接改 backend 或 internal registry 绕过作者边界。
- Lifecycle helper 完成后直接断言；只有真实外部 eventual observation 才用 `expect.poll()`，不用 sleep 掩盖提前返回。
- 操作已经运行的应用使用[开发控制台](../../docs/development/dev-console.md)，测试 host 不代表在线状态。
