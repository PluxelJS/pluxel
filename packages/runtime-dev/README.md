# @pluxel/runtime-dev

该包提供 route-neutral 的 `PluginArtifactCompiler`。它为 Workbench UI 和 Node module 保留两个具体 target builder，
共享 source graph、watch queue、content-addressed cache 与 atomic publication。static/dynamic host 只提供 Vite server、
compiler config 和 enabled policy，并通过一个 attachment 绑定 root services 与 Context effects。

compiler 按 declaration 懒创建；Workbench Plane 关闭时不安装 UI provider或加载 Federation builder，Node module
仍可独立编译。每个 runtime root/Vite server 最多安装一个 compiler，不创建通用 Context capability adapter。

内部边界见 `docs/PLUGIN_SYSTEM.md`；作者用法见 `user-docs/getting-started/index.md`。
