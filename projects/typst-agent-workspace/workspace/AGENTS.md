# 季度报告源码协作

本目录的 `.typ`、`data/sales.json` 与资源文件是全部权威输入；没有隐藏正文 JSON。

- 正文直接编辑 `sections/analysis.typ` 与 `sections/actions.typ`。保留未涉及的注释、空白、模板调用与未知语法。
- 业务数据由 `data/sales.json` 持有：金额单位为万元，续约率为百分数。可改数据；不要把指标或图表的求值结果抄成正文。
- 模板作者维护 `main.typ`、`template/` 与 `lib/`。正文使用原生相对 import/include，路径可含 `../`，规范化后必须在项目内。
- 图表 label 与跨文件 `@label` 是真实 Typst 源码。使用编辑器改名事务时同步所有可确认引用；直接改源码也须同步。
- 保存无效源码会保留草稿并报告诊断；编译失败时旧预览仍是旧修订。
- 编辑前退出正在保存此目录的消费者。消费者保存使用同目录旁的排他锁与原子目录交换；任意不使用此锁的外部编辑器并发写入不属于原子提交保证。

在消费者项目根执行 `vp run report check <目录>` 或 `vp run report render <目录>`。`render` 使用显式 TYPST_FONT_FILES；每次保存后重新读磁盘基线再开始下一轮编辑。
