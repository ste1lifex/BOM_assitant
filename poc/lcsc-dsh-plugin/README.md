# dsh-plugin-lcsc — 立创选料助手（DSH 插件）

按「用料需求」在立创商城/嘉立创元件库中找**性价比最优**的料，并给已有 BOM 做价格/库存/库类型体检。
为 DeepSeek Harness（DSH）设计，只有 **2 个工具**，避免污染模型上下文。

- 需求示例：`0402 100nF 50V X7R ±10% capacitor`、`3.3V LDO SOT-23-5 500mA`、`10kΩ 0402 resistor`、`TP4054`、`C1581`
- 默认 **手焊（assembly="hand"）**：不考虑贴片上料费，优先立创商城人民币零售价（best-effort）
- 可选 **嘉立创 SMT（assembly="smt"）**：基础库优先，扩展库按 **USD 3/料号/单** 上料费摊销进每片成本
- 场景：DIY 选型、替代料、BOM 打样成本预估、SMT 上料费优化

## 两个工具

### `find_lcsc_parts`

输入一条用料需求，返回 3-8 个按综合性价比排序的候选（单价 / 库存覆盖 / 参数匹配 / 基础库优先）。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `need` | string | 必填 | 需求，中文或英文：类别 + 封装 + 参数（容值/耐压/电流/精度/尺寸），或型号/LCSC 编号 |
| `assembly` | `hand` / `smt` | `hand` | hand=自己买料手焊（忽略库类型）；smt=嘉立创贴片（基础库优先，扩展库计入上料费） |
| `quantity` | integer | 1 | 每板用量 |
| `boards` | integer | 1 | 打板数量（决定价格阶梯与上料费摊销） |
| `sort` | `balanced` / `cost` / `stock` | `balanced` | 排序偏好 |
| `limit` | integer | 5 | 返回条数（1-8） |
| `include_cny` | boolean | hand 模式下 true | 是否取立创国内站人民币价（best-effort，受 WAF/限流影响） |
| `exclude_lcsc` | string[] | — | 排除的料号（找替代料时用） |

输出示例（节选）：

```json
{
  "need": "0402 100nF 50V X7R ±10% capacitor",
  "assembly": "smt", "quantity": 5, "boards": 5, "order_qty": 25,
  "candidates": [{
    "lcsc": "C307331", "model": "CL05B104KB54PNC", "package": "0402",
    "library": "base", "stock": 21402583,
    "price": { "currency": "USD", "unit": 0.0089, "source": "jlcpcb-smt" },
    "effective_unit_usd": 0.0089, "fee_per_board_usd": 0,
    "specs": [{"name": "Capacitance", "value": "100nF"}, {"name": "Voltage Rating", "value": "50V"}],
    "score": 0.96,
    "reasons": ["基础库：无上料费", "阶梯价 $0.0089（按采购量 25）", "库存 21402583"],
    "url": "https://www.lcsc.com/product-detail/C307331.html"
  }]
}
```

### `audit_lcsc_bom`

对已有 BOM（CSV/TSV 文本或 `[{"lcsc":"C1581","qty":5}]` JSON）做体检：逐行价格（USD 阶梯，按采购量取档）、库存、基础库/扩展库，SMT 模式下算扩展库上料费，并给扩展库料**推荐 1 个基础库替代**。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `bom` | string | 必填 | CSV/TSV 文本，或 JSON 数组字符串；必须有 LCSC 编号列 |
| `assembly` | `hand` / `smt` | `hand` | smt 时计入扩展库上料费 |
| `boards` | integer | 1 | 打板数量 |
| `include_cny` | boolean | false | 额外尝试人民币零售价（best-effort，最多 10 个料号） |
| `suggest_alternatives` | boolean | true | 为扩展库料推荐基础库替代（仅 smt 模式） |

## 数据源（全部公开、免登录）

| 数据源 | 用途 | 限制 |
|---|---|---|
| JLCPCB SMT 元件库接口 | 主搜索：关键词、参数属性、基础库/扩展库过滤、库存、USD 阶梯价 | 中文关键词支持差（需求会先翻译成英文/型号）；优选扩展库标记未暴露 |
| lcsc.com 国际站商品页 | USD 阶梯价、库存复核（`data.js` 精确查询用） | 国内专属料无国际数据 |
| item.szlcsc.com 国内站 | 人民币 1pc 零售价、国内库存（best-effort） | 阿里云 WAF 间歇拦截，只能降级 |
| EasyEDA 接口 | C 编号 → 国内商品 id 映射 | 价格字段过时，仅作映射 |

**价格口径**：USD 与 CNY **从不互相换算**；每条价格都带 `currency` 和 `source`。扩展库上料费按 `$3/唯一料号/单`（JLCPCB 经济型），未包含工程费、钢网费、焊点费。

**CNY 参考估算（仅参考）**：手焊模式下，如果立创国内站的人民币价取不到（WAF/限流），插件会额外给出 `cny_estimate`，算法为 **该料最高采购量档（批量档）USD × 6.0**。这个 6.0 来自 Recording_card 项目的实测标定（20 个已知人民币价的料，中位误差约 **1.6%**；个别专供料会偏差较大）。注意：

- 系数乘的是 `priceUsdTiers` 的**最高量档**，不是订单量对应档（后者直接乘 6.0 会高估约 2 倍）；
- 估算值只做参考，`price` 字段里的 USD 仍是实际参考价；有真实 CNY 价时不会输出估算；
- 可通过插件配置 `usdToCnyFactor` 调整系数（默认 `6.0`，放在 profile 的 bundle config / `cordis.patch.yml` 里）。

## 安装（DSH）

```bash
# 本地目录安装（在当前 profile 生效）
# 在 DSH 会话中让 agent 执行 plugin_manager install_bundle：
#   action: install_bundle
#   target: /absolute/path/to/poc/lcsc-dsh-plugin
```

装好后可在设置 → 插件中看到「立创选料助手」，两个工具对 agent 可用。卸载：`plugin_manager` → `remove_bundle`。

## 自测

```bash
node --check poc/lcsc-dsh-plugin/index.js
node poc/validate.mjs                    # 离线单测（无网络）
node poc/test-recording-card.mjs         # 用 Recording_card 真实 BOM 联网实测
```

## 设计取舍

- 只做 2 个工具：通用关键词搜索（`dsh-pcb-parts-search`）、KiCad 库转换（`easyeda2kicad`）、BOM/CPL 导出（`kicad-jlcpcb-tools`）已有成熟项目，不重复。
- 默认覆盖手焊党（大多数 DIY 用户），SMT 作为可选开关——SMT 计费规则可能变化，避免把规则写死成默认。
- 输出面向模型上下文优化：候选默认 5 条、字段紧凑、每条带 `reasons` 便于直接解释。
- 不绕过 WAF、不做淘宝/1688、不做下单；价格库存为公开接口快照，下单前请复核。

## 免责声明

本插件仅做公开数据聚合与计算，价格/库存为抓取时刻快照，不构成采购承诺；嘉立创/立创商城费用规则以下单页实时信息为准。MIT License。
