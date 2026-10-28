# Typst Agent Workspace

Pluxel Typst 的独立文件工作区消费者。用真实公开入口验证：原生正文 → Agent Markdown 文件 → coding agent 修改 → 完整候选校验 → 保存正文 → Tiptap 继续编辑 → Typst PDF。

示例没有使用 Studio、Typst 包内部源码、内部 Host 实例获取器或源码 alias。`ReportRenderPlugin` 通过 constructor 注入 `TypstPlugin`，在普通 Host 中调用公开的 `open/update/exportPdf/renderPage` 并释放会话。当前 Typst 包为 private，因此仓库通过本地包依赖提供已构建制品；这不是 registry 安装验收。

## 运行

在仓库根目录：

```sh
mise exec -- vp install --frozen-lockfile
mise exec -- vp run @pluxel-example/typst-agent-workspace#compile
cd projects/typst-agent-workspace
mise exec -- vp run report init
mise exec -- vp run report check workspace
```

`init` 创建本地 `.state/draft.json`，已有状态时拒绝覆盖。`workspace/` 是已提交的实际 agent 编辑结果，基于初始草稿，可直接检查、渲染和接纳。源代码中的 `initialDraft()` 提供相同初始正文；原始导出文件在 `evidence/before/`。

重新进行一次编辑实验：

```sh
mise exec -- vp run report checkout my-report
# 让 coding agent 阅读 my-report/AGENTS.md，并只修改 my-report/content/*.md。
mise exec -- vp run report check my-report
```

`checkout` 的目标目录必须不存在，父目录须已存在。它导出当前已保存的报告；要重做原始任务，可以使用新的项目副本，现有 `.state` 不会被自动重置。

渲染需要安装 `Noto Serif CJK SC`，并显式提供字体文件。按本机位置替换以下路径；Linux 可用 `fc-match -f '%{file}\n' 'Noto Serif CJK SC'` 查找。

```sh
export TYPST_FONT_FILES='["/absolute/path/to/NotoSerifCJK-Regular.ttc"]'
mise exec -- vp run report render workspace
mise exec -- vp run report apply workspace
```

`render` 编译候选但不保存正文，输出目录包含 `report.pdf`、`page-1.png`、`candidate.json`、生成模板及 `compile.json`。保存和编译是独立结果。`apply` 重新校验并一次保存完整正文；已接纳的工作区保留旧基线，再次提交会返回 `STALE_CANDIDATE`。下一轮使用 `checkout` 创建新目录。

## 编辑契约

| 文件                      | 含义                                           |
| ------------------------- | ---------------------------------------------- |
| `.state/draft.json`       | 唯一已保存正文及原始业务数据，由消费者命令持有 |
| `workspace/content/*.md`  | 可编辑 Agent Markdown，每文件对应一个固定区域  |
| `workspace/manifest.json` | 导出基线、路径映射和只读上下文校验值           |
| `workspace/context/`      | 本次数据和可引用对象的说明快照                 |
| `template/`               | 页面与固定章节布局、示例图片，由模板作者维护   |
| `.artifacts/`             | 可删除的编译与测试产物，不提交                 |

区域身份、图表 ID 与 Typst label 保持明确；普通 Markdown 无法保留的合并表格和组件使用局部原生 JSON。语法以[核心 Agent Markdown 文档](../../docs/plugins/rendering/typst-editor.md#agent-markdown)为准。

消费者对所有候选先执行单区域解析，再执行完整集合校验及生成检查；不会逐文件保存。`check` 会检查跨章重复身份、缺失引用、组件参数与资源绑定，但不承诺 Typst 编译成功。报错保留候选文件和已保存状态。文件诊断保留核心 `code/regionId/path`，当前没有 Markdown 行列映射。

这是本地、单报告的消费者实验。自身写命令使用排他锁和单文件原子替换；外部直接修改 `.state`、同时改模板或恶意改清单不属于并发或权限保证。清单哈希用于发现陈旧输入，不是授权凭证。模板配置或组件契约改变时，作者须更新 `templateRevision`。

## 验证

```sh
mise exec -- vp run typecheck
# 沿用上面设置的 TYPST_FONT_FILES，运行包括真实 native PDF/PNG 的测试。
mise exec -- vp run test
```

没有字体配置时仅跳过原生编译用例；其余测试仍运行。测试使用自己的隔离目录，不覆盖本地 `.state` 或已提交的 `workspace`。

测试包括公开制品解析、无修改往返、实际编辑结果重放、跨章移图、复杂表格与字段保留、真实无 DOM Tiptap Editor 命令、候选失败无部分保存、版本冲突及原生 PDF/PNG。它不包含浏览器界面交互，也不证明其他模型、长报告或多人同时编辑的效率。

本次观察与后续核心设计建议见 [evidence/RESULTS.md](evidence/RESULTS.md)。

下一轮 Pluxel Typst 本体重构任务见 [TYPST_SOURCE_PROMPT.md](TYPST_SOURCE_PROMPT.md)：以 Typst 源码为权威，Tiptap 作为结构化编辑视图，并完成核心与已知调用方迁移。该任务尚未实施，本消费者当前仍遵循上述 Markdown 编辑契约。
