# BOM_assitant — 立创选料 DSH 插件

按「用料需求」在立创商城 / 嘉立创元件库中找**性价比最优**的料，并给已有 BOM 做价格、库存、基础库/扩展库体检。
来自 [Recording_card](../Recording_card)（开源录音工牌）项目里立创选型与查价的探索，做成 DeepSeek Harness（DSH）插件。

## 两个工具（默认手焊）

| 工具 | 作用 |
|---|---|
| `find_lcsc_parts` | 需求（封装/容值/耐压/电流/精度）→ 参数匹配 + 价格/库存/库类型排序，返回 5 条候选 |
| `audit_lcsc_bom` | 已有 BOM（CSV 或 JSON）→ 逐行价格/库存/基础库-扩展库；SMT 模式算 $3/料号上料费并推荐基础库替代 |

- `assembly=hand`（默认）：DIY 手焊，不考虑上料费；立创国内站人民币价 best-effort，取不到时给批量档 USD × 6.0 的**参考估算**（明确标注，非实际报价）
- `assembly=smt`：嘉立创贴片，基础库优先，扩展库按 $3/唯一料号/单摊销
- 只暴露 2 个工具，避免与其他插件一起装时污染模型上下文

## 目录

```
docs/
  立创找料DSH插件_调研与决策.md      # 开源生态调研、prior art、数据源实测、决策建议
  工具设计_LCSC选料插件.md           # 工具面/参数/排序算法/实现状态
research/
  prior-art.md                       # 20+ 同类项目调研（初稿）
  lcsc-probe/                        # 数据源探针脚本
poc/
  lcsc-dsh-plugin/                   # 可安装 DSH bundle（index.js 工具层 + data.js 数据层，零依赖）
  validate.mjs                       # 离线测试（60 项）
  test-recording-card.mjs            # 用 Recording_card 真实 BOM 联网实测
  test-output/                       # 实测 JSON 输出
```

## 快速开始

```bash
# 离线测试
node poc/validate.mjs

# 用 Recording_card BOM 联网实测
node poc/test-recording-card.mjs

# 装进 DSH（在 DSH 会话中让 agent 执行 plugin_manager install_bundle）
#   target: /absolute/path/to/poc/lcsc-dsh-plugin
```

## 数据源与限制

- JLCPCB SMT 元件库接口：搜索、属性、基础库/扩展库、库存、USD 阶梯价（主数据源）
- lcsc.com 国际站商品页：USD 阶梯价、库存
- item.szlcsc.com 国内站：人民币 1pc 价（best-effort，阿里云 WAF 间歇限流）
- CNY 与 USD **从不未经标注地换算**；估算值固定标注「估算参考」
- 不绕过 WAF、不抓淘宝/1688、不做下单；价格库存为快照，下单前请复核

## 状态

- 插件 v0.2.0，已安装到本机 DSH desktop profile 并端到端验证通过
- Recording_card BOM v0.5（28 个唯一料）：基础库 12 / 扩展库 16；SMT 5 片打样扩展库上料费 16×$3 = $48
- 替代料验证：C1581（扩展库 100nF）→ C307331（基础库），每换掉 1 个扩展库料每单省 $3

## License

MIT（见 [LICENSE](LICENSE)）。数据来自公开接口与页面，仅供选型参考，不构成采购承诺。
