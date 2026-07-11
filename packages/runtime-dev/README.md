# @pluxel/runtime-dev

该包实现 runtime route 的开发能力：plugin replacement、worker watch，以及 Web Management 开启时的 UI source compiler。

插件作者只声明 `ui()` 并调用 `web.ui.register()`；runtime-dev 通过 host 安装的 dev capability 接收源码声明。Web Management 关闭时不创建 compiler 或 watcher。

公开作者模型见 `docs/PLUGIN_AUTHORING_FINAL.md`。
