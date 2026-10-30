export const fontFamilies = ['LXGW WenKai']

export const initialSource = `#set page(width: 145mm, height: auto, margin: 14mm)
#set text(font: "LXGW WenKai", size: 12pt)
#set heading(numbering: "1.")

= Pluxel × Typst

这份文档在你的浏览器中完成排版。

*真实插件，实时排版。* Pluxel 管理依赖和生命周期，Typst WASM 负责生成文档。

== 试着修改

- 直接编辑正文，预览会自动更新；点击两边可对照跳转。
- 切换排版插件，观察真实热替换与依赖重建。
- 切换到 Typst 源码，调整字号、页宽或页边距。

#table(columns: 2,
  table.header([运行位置], [职责]),
  [浏览器 Worker], [Pluxel Core + Host],
  [Typst 插件], [WASM 编译与排版],
)
`
