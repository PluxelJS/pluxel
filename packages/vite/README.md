# @pluxel/vite

Pluxel 的 Vite 工具链包。

这个包只放 route-neutral 的 Vite/MF 子编译能力，不是 dynamic/static HMR adapter：

- `@pluxel/vite/plugin-ui`
  构建插件自定义 UI remote，并封装 `@module-federation/vite`、shared package 解析、Paraglide 注入、用户 Vite config merge 和 root-scoped build scheduler。
- `@pluxel/vite/paraglide`
  解析 Pluxel 固定 Paraglide 约定：`project.inlang`、`messages/`、`src/paraglide/`。

dynamic/static route 各自拥有自己的 HMR ingestion 和 commit 逻辑。dynamic 处理 Vite runner/module exports/loader batch；static 处理 static definition import/catalog diff。两条 route 只在需要插件 UI 子编译时复用这里的 helper。

`buildPluginUiRemote(...)` 不主动读取用户项目的 `vite.config.ts`，但调用方可以传入标准 `vite?: InlineConfig`。Pluxel 先生成 remote build 的内部基线，再把用户 config 作为最后一层 merge；插件、alias、define、CSS/codegen 等保持 Vite 原生写法。

需要谨慎覆盖 `build.outDir`、`build.rollupOptions.input`、Module Federation 输出相关字段和 server/root 相关字段。这个包选择暴露标准 Vite 配置，不再发明额外的 source/ui/options 包装；配置错误导致 remote artifact 不可用时，由调用方负责修正。
