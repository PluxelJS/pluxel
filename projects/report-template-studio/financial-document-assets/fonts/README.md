# 随包财务字体

固定字体字节随服务端发行包携带，不依赖系统字体、不在运行时下载，也不加载到浏览器 CSS。PDF 嵌入排版所用字形。

- 中文：Noto Serif CJK SC，2.003，Regular／Bold，未修改的简体中文区域 OpenType 字体。使用用户提供财务函件主题推荐的中文字体，来自 [官方 Serif2.003 字体目录](https://github.com/notofonts/noto-cjk/tree/9b0f1436e455d902de067a2501422e5dc71ad16b/Serif/OTF/SimplifiedChinese)，固定上游提交 `9b0f1436e455d902de067a2501422e5dc71ad16b`；许可证见 [LICENSE-NotoSerifCJK.txt](LICENSE-NotoSerifCJK.txt)。字体内嵌 family 为 `Noto Serif CJK SC`，PostScript 名分别为 `NotoSerifCJKsc-Regular`、`NotoSerifCJKsc-Bold`。
- 西文与数字：Liberation Serif，2.1.5，Regular／Bold，未修改的发布字体（本次由系统安装的同版本字体取入，以内嵌版本及以下 SHA-256 固定字节）。[上游项目](https://github.com/liberationfonts/liberation-fonts/tree/2.1.5)提供 Times New Roman 度量兼容字体；许可证见 [LICENSE-Liberation.txt](LICENSE-Liberation.txt)。

两者采用 SIL Open Font License 1.1，版权与许可文本随字体保留。这里没有重新命名为宋体或 Times New Roman，也不宣称替代具体机构指定的专有字体。

公式使用 Typst 编译器内置的 `New Computer Modern Math`；共享主题显式为公式补上 `Noto Serif CJK SC`，使中文公式标签也使用随工作区提供的字形，无需系统字体或浏览器下载。

| 文件                          | SHA-256                                                            |
| ----------------------------- | ------------------------------------------------------------------ |
| `LiberationSerif-Bold.ttf`    | `28f2d4300ee366d1ff9ca95df967a27e77987c87857fad0d9c85034405aae39d` |
| `LiberationSerif-Regular.ttf` | `86b9ea1c2f41bed9d7c09ccad4abc2894b33df5de60e5bbbece5d48610911870` |
| `NotoSerifCJKsc-Bold.otf`     | `8af07d4b6c2e82bcc72a30e066eaf295f11b9424f4aad2eaa9fe0e9c3b38fc73` |
| `NotoSerifCJKsc-Regular.otf`  | `2a2eae2628df83556c54018c41e20fa532c1b862c5256ae8b3f23feb918d12ca` |
