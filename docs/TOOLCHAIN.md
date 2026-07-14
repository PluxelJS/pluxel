# Toolchain Architecture

Workbench UI build primitive 位于 `@pluxel/rolldown/vite/workbench-ui`。runtime-dev compiler 负责：

1. 绑定 `workbench.entry()` source declaration；
2. 收集 Vite module graph 和相关源文件；
3. 计算包含 shared contract、Vite overlay 和 compiler version 的 hash；
4. 构建 Module Federation remote 到 `.pluxel/workbench`；
5. 原子提交 artifact state，并触发统一 Workbench revision；
6. owner unload 时停止 watcher 并移除 artifact。

compiler 在绑定 UI declaration 时即发布 `building`，不等源码 hash 计算完成；Workbench 将其视为等待状态，
由后续 ready/error revision 驱动结果，不使用客户端超时或轮询猜测构建是否完成。

生产构建使用同一 federation contract，按 owner 输出到 `dist/workbench/<owner>/`。Rolldown 只静态提取
`workbench.entry(import.meta.url, "...")` 的字符串 declaration；没有 UI 时不加载 Vite，有 UI 时用源码图、
依赖 lockfile、shared 版本和显式 Vite cache key 复用完整 artifact。缓存命中时只加载轻量签名解析层，不加载
完整 Vite/MF builder。UI entry 不进入服务端 bundle。shared packages 只包含 React、Mantine 等 UI peer 和
`@pluxel/runtime/workbench/ui`；resource transport 实现不进入插件 bundle。
反向边界同样成立：UI entry 对服务端 Workbench extension 只保留 type-only import，remote source graph 不得
包含 `@pluxel/runtime/workbench`、core Context 或 Node API。
`@pluxel/core/federation` 是 dependency-neutral contract 的权威入口。core 的声明产物处理由 core 自己的
build config 完成，不反向依赖 `@pluxel/rolldown`；Turbo 因而保持 `core -> rolldown` 的单向构建顺序，
rolldown 从已构建的公开 subpath 内联 contract，不依赖源码 alias 或旧 dist。

static 与 dynamic route 都通过 `RuntimeDevCapabilities.workbenchUiSource` 接入 compiler，不复制构建逻辑。
