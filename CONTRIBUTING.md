# 参与贡献

感谢你对 Pluxel 的关注与支持！无论是提交缺陷报告、改进文档、编写测试用例还是实现新功能，我们都非常欢迎。

## 贡献流程

### 1. 提交 Issue

- 报告 Bug 时，请尽量提供最小复现步骤、Node.js 与 pnpm 版本、操作系统信息以及错误日志。
- 提出较大范围的 API 变更或新功能建议前，建议先开启 Issue 讨论设计思路与适用场景。
- 涉及安全隐患的问题请参阅 [安全策略](./SECURITY.md) 私下联络，请勿直接公开在 Issue 中。

### 2. 签署贡献协议

提交代码前请阅读本项目的[贡献者许可协议（CLA）](./CLA.md)。提交 PR 时，请在 PR 模板中勾选同意该协议。

## 本地环境搭建

本项目通过 mise 统一管理 Node.js、pnpm、Vite+、hk 与 Pitchfork。请先参考[工作区工具链](./docs/development/workspace-toolchain.md)安装并启用 mise，然后在仓库根目录运行：

```sh
git clone https://github.com/PluxelJS/pluxel.git
cd pluxel
mise trust
mise install
mise exec -- vp install --frozen-lockfile
vp run @pluxel/cli#compile
vp run hooks:install
vp run verify
```

日常开发常用命令：

- 启动示例宿主：`vp run dev`
- 启动本地文档站：`vp run docs`
- 服务管理（Pitchfork）：`pitchfork list` 或 `pitchfork logs plugin-host`

## 代码与提交规范

1. **架构契约**：修改核心逻辑前，请先查阅 [工程文档索引](./engineering/README.md) 及对应专题设计；涉及公共 API 变动时，遵循 [API 设计准则](.agents/rules/library-api-design.md)。
2. **包边界**：跨包调用只能引用目标包在 `package.json` 的 `exports` 中显式暴露的公共入口，禁止使用跨包内部相对路径。
3. **文档同步**：当公开 API 或交互行为发生变动时，请同步更新 `docs/` 目录中的相关文档。
4. **测试补充**：为新功能或 Bug 修复添加对应的单元测试或回归测试，确保资源的生命周期得到妥善释放。

## 验证与检查

在提交代码前，请运行本地完整检查：

```sh
vp run verify
```

在开发过程中，也可以针对具体包或单项检查运行轻量命令：

```sh
vp run <package-name>#test
vp run <package-name>#typecheck
vp lint
vp fmt --check
```

## 更新日志（Changelog）

如果你的修改包含了对公开发布包（packages 目录下）的用户可见行为调整，请生成一条 Tegami 更新记录：

```sh
vp run tegami
```

按照交互提示选择受影响的包名，并用简明中文描述该版本变更的具体内容。纯内部重构、测试补充或文档修改无需生成更新记录。

## 提交 Pull Request

- 建议单个 PR 聚焦于单一主题，并在描述中简要说明变更动机、核心改动点与验证方式。
- 若包含界面或交互改动，请在 PR 中附上截图或录屏。
- 勾选 PR 模板中的各项检查，并确认已签署 CLA。
