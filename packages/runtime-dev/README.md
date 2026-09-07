# @pluxel/runtime-dev

该包提供 route-neutral 的 `PluginArtifactCompiler`。它为 Workbench UI 和 Node module 保留两个具体 target builder，
共享 source graph、watch queue、content-addressed cache 与 atomic publication。static/dynamic host 只提供 Vite server、
compiler config 和 workspace package selection，并通过一个 attachment 绑定 root services 与 Context effects。

compiler 按 declaration 懒创建；Workbench Plane 关闭时不安装 UI provider或加载 Federation builder，Node module
仍可独立编译。每个 runtime root/Vite server 最多安装一个 compiler，不创建通用 Context capability adapter。

开发模式下，Workbench publication 不等待冷 producer 构建完成。compiler 会同步提交 definition topology 与 Content
artifact，已存在的 producer artifact 会快速复用；缺失的 producer 进入后台队列，使用 `.pluxel/plugin-artifacts`
下的持久 Vite cache 构建。未就绪的 View/Attachment 会保留 layout 位置并显示构建中，后台失败时显示错误；成功后再提交完整
artifact tuple 并触发 Workbench session reload。开发 producer 默认只生成运行时 MF artifact，不生成 dynamic types；
distribution 模式仍同步构建并严格校验 dynamic type artifact。

内部边界见 `engineering/PLUGIN_SYSTEM.md`；作者用法见 `docs/getting-started/index.md`。
