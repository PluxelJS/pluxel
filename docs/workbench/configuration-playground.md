---
title: 配置试验场（Playground）
description: 在交互式 Playground 中编写 Valibot Schema，实时预览生成的表单与归一化输出结果。
---

配置试验场（Playground）是一个纯前端的交互式演练环境。你可以在其中编写 Valibot Schema，实时观察它所生成的表单交互形态，并对比原始输入与经过校验、默认值填充后的最终输出。

```text
Valibot Schema
      │
      ▼
valibot-form 渲染交互表单
      │
      ▼
Valibot safeParse 归一化输出
```

## 核心功能

访问文档站的 [配置 Playground](/playground) 即可开始体验：

- **实时编辑**：在 Monaco 编辑器中编写 Schema，享受基于实际依赖库导出的 TypeScript 类型补全；
- **双向联动**：右侧表单中的输入会实时反映在 Output 面板中，方便观察 `v.optional`、`v.pipe` 与数据转换效果；
- **字段元数据辅助**：支持使用 `valibot-form` 的 `f.formMeta` 设置字段标题、占位符与表单布局提示。

详细的配置语法规范请参考 [配置模型](../plugin-development/configuration.md)，完整的表单元数据请参考 [Valibot 配置表单](./valibot-form.mdx)。
