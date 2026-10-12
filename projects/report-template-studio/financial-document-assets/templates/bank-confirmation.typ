#let letter = json("/inputs/header.json")
#let accounts = json("/inputs/accounts.json")
#let body = read("/inputs/body.txt")
#import "financial-correspondence.typ": correspondence, prose, section, amount, statement-table, form-table, note
#show: correspondence.with(title: [银行存款余额询证函], numbering: "1 / 1")

#text(weight: "bold")[#letter.bankName：]

被询证单位：#letter.companyName \ 源账套：#letter.sourceName \ 余额日期：#letter.asOf

#prose[
  #for paragraph in body.split("\n") [#paragraph #parbreak()]
]

#statement-table(
  columns: (1.3fr, 1.3fr, 0.6fr, 1.4fr),
  headers: ([科目名称], [银行账号], [本位币], [账面余额]),
  align: (left, left, center, right),
  title: [银行账户余额明细],
  unit: [#letter.currency 元],
  ..accounts.map(account => (
    [#account.code #linebreak() #account.name],
    account.bankAccountNumber,
    letter.currency,
    amount(account.bookAmountDisplay),
  )).flatten(),
)
#note[金额取自所选源账期末余额，以本位币列示，借方为正、贷方为负；不代表银行确认的原币存款余额。金额四舍五入至分，仅影响展示，不改变源账精度。“待核实”表示来源金额缺失或未知。]

#section[回函确认]
回函地址及接收人：#letter.replyTo

#form-table(
  columns: (28mm, 1fr),
  [核对结果], [□ 相符　□ 不符（请另附差异说明）],
  [确认意见], [#v(12mm)],
  [经办人及日期], [#v(6mm)],
  [银行签章], [#v(14mm)],
)
