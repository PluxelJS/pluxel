# Toolchain Architecture

Management UI build primitive 位于 `@pluxel/rolldown/vite/management-ui`。runtime-dev compiler 负责：

1. 绑定 `managementUi()` source declaration；
2. 收集 Vite module graph 和相关源文件；
3. 计算包含 shared contract、Vite overlay 和 compiler version 的 hash；
4. 构建 Module Federation remote 到 `.pluxel/management`；
5. 原子提交 artifact state，并触发统一 Management revision；
6. owner unload 时停止 watcher 并移除 artifact。

生产构建使用同一 federation contract，按 owner 输出到 `dist/management/<owner>/`。Rolldown 只静态提取
`managementUi(import.meta.url, "...")` 的字符串 declaration；没有 UI 时不加载 Vite，有 UI 时用源码图、
依赖 lockfile、shared 版本和显式 Vite cache key 复用完整 artifact。缓存命中时只加载轻量签名解析层，不加载
完整 Vite/MF builder。UI entry 不进入服务端 bundle。shared packages 只包含 React、Mantine 等 UI peer 和
`@pluxel/runtime/management/ui`；resource transport 实现不进入插件 bundle。
core 是 federation contract 的源码权威；rolldown 发布物内联这一个 dependency-neutral contract，避免
“core 用 rolldown 构建、rolldown 启动又读取 core dist”的构建环，Turbo 直接把该源码计入 rolldown cache key。

static 与 dynamic route 都通过 `RuntimeDevCapabilities.managementUiSource` 接入 compiler，不复制构建逻辑。
