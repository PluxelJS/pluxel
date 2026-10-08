# Embedded Launcher 架构演示

状态：设计阶段，尚无可运行代码。本文档集于 2026-10-08 基于当前工作区核对，描述待实现目标，不代表 Pluxel 已支持 QuickJS-NG。本项目不发布 npm 包。

演示一个已有原生应用如何通过 Pluxel Services 开放能力，由插件扩展查询、动作和 CLI。Launcher 只是小而直观的载体；交付重点是可复用的嵌入架构，不是完整的 Launcher 产品。

## 确定的目标

- 原生 UI，无浏览器、WebView、React 或 Workbench UI 依赖。
- 同一份插件源码：开发在 Node/Vite 内执行，必须支持真实 HMR；发布在应用内的 QuickJS-NG 执行。
- 开发插件操作真实原生应用的剪贴板、结果列表和设置，不能以 mock 替代最终演示。
- Plugin stop/start、配置更新和依赖联动由 Pluxel 在同一 JSRuntime 内处理。
- 发布包安装、更新、移除后，通过显式重建插件 JSRuntime 接纳新的包集合；原生应用保持运行。
- 原生 UI 和 CLI 使用同一个活动 Host，展示 Commands、配置、依赖、effects、日志和自定义 Services。

## 阅读顺序

1. [架构设计](DESIGN.md)：所有权、双环境交互、HMR、安装管理和运行时边界，实施时的权威设计。
2. [设计思考](DECISIONS.md)：方案选择、性能考虑、没有纳入首版的能力。
3. [实施与验收](IMPLEMENTATION.md)：已知基础、尚未验证的缺口、实施顺序和真实验收场景。

下一 session 从实施文档的第一个阶段开始。先验证真实 QuickJS-NG 可运行闭包及原生往返，再扩展演示。实现中若发现当前框架公共入口无法满足设计，应在所属包修复边界并补验证，不能通过项目内复制 Core、伪造 metadata 或私有源码 import 绕过。

## 演示的最小形态

一个原生窗口，包含搜索框、结果列表和紧凑的插件管理视图。输入算式显示结果并可复制；CLI 调用相同计算器；另一个插件查询原生应用提供的动作目录。管理视图展示可用插件、实际运行结果、配置，以及已安装和正在使用的包版本。

参考实现选择 Qt 6 Widgets/C++ 与原生 QuickJS-NG C API，先验收 Linux。Qt/QuickJS-NG 的准确版本在实施时锁定；其他平台不以“工具包跨平台”代替实测支持。没有 Node 的发布运行是验收条件，构建环境仍可使用 Node、Vite 和 Rolldown。

当前只新增设计文档，不添加占位 `package.json`、空源码目录或 Turbo 任务。实现时按工作区现有约定加入一个 private 项目；不要预先建立独立插件 SDK 仓库或通用跨语言 RPC 框架。
