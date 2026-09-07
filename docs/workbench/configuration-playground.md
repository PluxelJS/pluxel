---
title: 配置 Playground
description: 编辑 Valibot schema，操作生成的表单，并比较原始输入与归一化结果。
---

配置 Playground 是一个独立的交互页面，用于快速试验配置 schema。它把 schema、生成的表单和 Valibot 解析结果放在同一页，方便观察默认值、转换和校验如何影响最终配置。

```text
Valibot schema
  -> valibot-form 输入
  -> Valibot parse/default/transform 输出
```

打开 [配置 Playground](/playground) 即可开始操作。编辑器中的 `v` 对应文档当前使用的 `valibot`，`f` 对应 `valibot-form`。输入 `v.` 或 `f.` 可以查看由真实包生成的补全、参数类型和文档；Playground 不维护另一份容易过期的类型副本。

宽屏下，左侧编辑 schema，右侧操作生成的表单，两侧独立滚动；窄屏下改为上下排列。Input / Output 位于编辑器下方，可按需展开查看。数组和记录的新增输入框取得焦点时不会自动滚动页面。

运行代码后：

- 表单由返回的 object/intersect schema 生成，直接展开，无需点击折叠标题；
- Input 显示表单当前持有的原始值；
- Output 显示 `v.safeParse()` 应用默认值、transform 和 validation 后的结果；
- schema 执行失败或不是 object/intersect 时保留上一次可用表单。

Playground 代码只在当前浏览器页面执行。不要粘贴 secret，也不要运行不可信代码。

完整配置约束见 [配置模型](../getting-started/configuration.md)；字段 metadata 与 Web adapter 见 [Valibot 配置表单](./valibot-form.mdx)。
