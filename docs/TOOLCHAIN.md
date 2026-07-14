# Toolchain Architecture

Workbench UI build primitive 位于 `@pluxel/rolldown/vite/workbench-ui`。

## Source declaration

server Extension 使用：

```ts
workbench.extension({
	contract: BrowserSafeContract,
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
})
```

Rolldown 静态提取 literal entry，并按 declaration module、entry path、source graph、Contract/shared versions 和
compiler version 生成稳定 artifact key。构建 transform 把该 key 注入 `workbench.entry()` 的 internal 第三参数；
作者不声明 plugin ID。artifact 按 key 内容寻址，committed mount 时才关联 Context owner。

UI entry 不进入 server bundle。反向边界同样成立：UI source graph 只能引用 browser-safe contract、
`@pluxel/runtime/workbench/contract`、`@pluxel/runtime/workbench/ui` 和公开 UI peers，不得包含 server Workbench
entry、Plugin、Context 或 Node API。

## Development compiler

runtime-dev compiler：

1. 将 Extension source declaration 绑定到 mount owner；
2. 收集 Vite module graph 与相关源文件；
3. 计算 source/build hash；
4. 构建 Federation remote 到 `.pluxel/workbench`；
5. 原子提交 artifact state；
6. owner unload 时停止 watcher 并移除 artifact。

compiler 在绑定 declaration 时立即发布 `building`；ready/error revision 驱动 Workbench，不使用客户端轮询猜测。

## Production build

生产构建按 artifact key 输出 `dist/workbench/<artifact>/`。缓存 key 包含源码图、依赖 lockfile、shared version、
compiler version 和显式 Vite cache key。UI Contract 和 UI runtime 都是 singleton Federation shared package。

`@pluxel/core/federation` 是唯一 dependency-neutral build contract。runtime-dev、Rolldown 和 host 直接依赖该
contract，不通过 runtime 转手 re-export，也不引入反向 build dependency。
