# Typst Agent Workspace

Pluxel Typst 源码编辑的独立文件消费者。正文直接保存在 `.typ`，业务数据保存在 JSON，Tiptap 文档与引用索引由公开 `@pluxel/plugin-typst/source` 重建。Agent 不经过 Markdown 中转；重新打开不读取隐藏正文 JSON。

`ReportRenderPlugin` 通过 constructor 注入 `TypstPlugin`，使用公开 `open/update/exportPdf/renderPage`。一组源快照共用一个 Host 和一个编译会话，成功与失败都记录请求的源修订；结束后释放会话和 Host。消费者只导入公开构建制品。

## 运行

在仓库根目录构建，再进入消费者目录：

```sh
mise exec -- vp run @pluxel-example/typst-agent-workspace#compile
cd projects/typst-agent-workspace
mise exec -- vp run report check workspace
mise exec -- vp run report init my-report
```

`workspace/` 已从上一轮实际接纳的本地报告一次转换，保留原正文、数据、表格和位于行动建议的 figure；可直接编译。`init` 复制到一个必须不存在的新目录；随后让 Agent 阅读该目录 `AGENTS.md` 并直接修改 `.typ` 和允许的 JSON。复制已有报告使用 `report copy <目录> <新目录>`。

```sh
export TYPST_FONT_FILES='["/run/host/fonts/noto-cjk/NotoSerifCJK-Regular.ttc"]'
mise exec -- vp run report render my-report
mise exec -- vp run report rename-label my-report fig:revenue fig:sales
```

字体路径按本机安装修改，须包含中文字体。`render` 的结果目录包含每次输入源码快照、每次成功的 PDF/PNG/navigation，以及独立的 `compile.json` 回执。源码不因编译而更改。`check` 检查语法、静态引用和 sales 数据 schema；它不能代替实际 Typst 编译。

## 权威文件

| 文件                                            | 含义                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| `main.typ`                                      | 页面与原生 include 组合                                                   |
| `sections/analysis.typ`、`sections/actions.typ` | 可直接编辑的正文、题注、label/ref、手工表格和未知源码                     |
| `template/blocks.typ`                           | 原生指标卡与营收图函数；图表尺寸从 JSON 数据计算                          |
| `data/sales.json`                               | 业务事实，金额单位万元，续约率为百分数                                    |
| `tests/fixtures/report/`                        | 额外验收样本，包含静态 SVG、未知内联/源码块和数学；测试复制覆盖到隔离目录 |
| `lib/`                                          | 从公开 source/library 复制的普通 Typst/MiTeX 资源，属于该项目输入         |
| `.artifacts/`                                   | 消费者外部的可删除编译/测试产物，不是项目恢复前提                         |

`src/model.ts` 声明业务数据 schema 和已知模板调用参数。核心只解析源码，不求值图表，也不生成分析正文。`#metrics(data: json("../data/sales.json"), title: ...)` 的参数与数据目标分别可识别；额外验收样本中的 `#upper(...)` 和 `#for` 继续保留原始源码。

## 保存、冲突与历史

`openWorkspace(directory)` 返回磁盘完整内容摘要 `diskRevision` 和内存 source project。`createTypstSourceEditor({ project, path })` 返回真实 Tiptap Editor；文字、题注和引用的接纳会更新 `project.snapshot().files`。调用 `commit(directory, { baseRevision: diskRevision, files })` 才写磁盘。

此本地 Linux 消费者使用目录旁的排他锁，先完整写入并校验同文件系统临时目录，再复核基线，最后通过 GNU `mv --exchange --no-copy -T` 一次交换目录。文件系统不支持原子 exchange 时明确失败；没有逐文件降级写入。接纳前失败不改变原目录；接纳后的清理失败通过 `cleanupWarnings` 报告，不能把已经保存说成失败未写。

锁覆盖本消费者的读取快照和写操作，读取不会跨越消费者自己的目录交换。已发生的外部修改会产生 `CONFLICT` 并保留两边输入；任意不使用此锁的外部编辑器在最终摘要检查与目录交换之间继续写入，不属于此消费者的并发保证。开始保存前应结束外部写入。断电后的持久化、目录外硬链接及恶意写入不属于这个本地示例的事务承诺。

内存项目的 undo/redo 覆盖一次完整源码事务，包括跨文件改名；保存后再次提交 undo 的快照可以撤销磁盘内容。重新打开会从 `.typ` 建立新历史，历史不是第二份正文。外部完整快照接纳会清空旧 history，旧投影不能覆盖新源码。

无效 Typst 可以原样保存；`check` 和 projection 会显示诊断，修复后恢复结构化编辑。保存、可结构化编辑、成功编译是三个独立结果。编译失败记录旧的 `lastSuccessfulRevision`，不为失败输入生成伪成功预览。

## 验证与证据

```sh
mise exec -- vp run typecheck
# 使用上面的 TYPST_FONT_FILES；省略时会明确跳过唯一 native 用例。
mise exec -- vp run test
mise exec -- node scripts/source-evidence.mjs
```

回归包含真实无 DOM Tiptap 中文编辑、题注、跨文件引用、全项目撤销/重做、静态 figure 移动、复制内部引用、重开、无操作字节保真、无效草稿、跨文件失败无部分保存，以及外部冲突。同一个 native 会话依次编译初始、仅 JSON 更新、无效源码与修复后的快照，检查真实 PNG 变化与失败修订身份。

实际源码差异与 PDF/PNG 见 `evidence/source/`。浏览器交互由 Typst 包的浏览器消费者另行验收；本项目的无 DOM 测试不宣称已验证浏览器中文输入法或鼠标选区。

旧 `evidence/RESULTS.md`、`evidence/before/` 与旧 PDF 是 Markdown 基线历史，不是当前存储契约。旧 `.state/draft.json`、`workspace/content/*.md`、manifest 和生成区域路径已退出运行代码；本次本地 `.state/draft.json` 已显式一次转换并移存 `evidence/markdown-baseline/draft.json`，没有保留运行时兼容读取器。
