---
title: 配置 Playground
description: 编辑 Valibot schema，操作 valibot-form，并实时比较原始输入与归一化输出。
---

# 配置 Playground

配置 Playground 是独立的交互页面，不嵌入普通文档。它把配置 contract 的三个阶段放在同一页面：

```text
Valibot schema
  -> valibot-form 输入
  -> Valibot parse/default/transform 输出
```

打开 [配置 Playground](/playground) 开始操作。编辑器中的 `v` 对应当前 workspace 的 `valibot`，`f` 对应当前 workspace 的 `valibot-form`。输入 `v.` 或 `f.` 可查看源码生成的补全、参数类型和文档。类型声明在文档构建前从真实 package 生成，不维护独立的 Playground 类型副本。

独立 Playground 在空间充足时并排显示 schema 编辑器与结果；容器较窄时按操作顺序改为上下排列。表单、Input 和 Output 可以独立折叠。普通文档中的配置示例始终使用纵向顺序，不加载编辑器。

运行代码后：

- 下方表单由返回的 object/intersect schema 生成；
- Input 显示表单当前持有的原始值；
- Output 显示 `v.safeParse()` 应用默认值、transform 和 validation 后的结果；
- schema 执行失败或不是 object/intersect 时保留上一次可用表单。

Playground 代码只在当前浏览器页面执行。不要粘贴 secret，也不要运行不可信代码。

完整配置约束见 [配置模型](../getting-started/configuration.md)；字段 metadata 与 Web adapter 见 [Valibot 配置表单](./valibot-form.mdx)。普通文档只展示静态代码和渲染结果，不加载编辑器。
