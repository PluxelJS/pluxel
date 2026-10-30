#import "../lib/pluxel.typ" as report
= 行动建议

营收趋势见 @fig:income。该编号及链接由 Typst 生成。

+ 销售负责人在下周例会前核对渠道合同；以明细与财务台账一致为验收标准。
+ 客户成功负责人在月底前汇总续约访谈；以形成可追溯原因清单为验收标准。
+ 财务负责人在季末复核收入确认口径；以已验收合同和确认金额一致为验收标准。

原生数学保留：$ g = (v_1 - v_0) / v_0 $。

LaTeX 原式：#report.latex("g = \\frac{v_1-v_0}{v_0}", block: true) <eq:growth>

计算公式见 @eq:growth。

跟随模板：#report.reference(<fig:income>, caption: auto)。
不附题注：#report.reference(<fig:income>, caption: false)。
编号与题注：#report.reference(<fig:income>, caption: true)。
