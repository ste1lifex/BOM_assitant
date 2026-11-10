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

输出里除 `rows` / `summary` 外还有：

- `summary.lines_in_bom`：BOM 实际行数（含没编号的）
- `summary.skipped_lines` + `skipped[]`：没有 LCSC 编号的行，逐行给出 `line` / `designators` / `comment`
- 每行 `stock_source` / `price_source`：该行价格与库存分别取自 `jlcpcb-smt` / `lcsc.com` / `item.szlcsc.com` 中的哪一个
- `summary.library_unknown`：查得到但不在嘉立创 SMT 库里的行数（手焊可另买）

**没有 LCSC 编号的行不会被静默丢弃**，而是列进 `skipped` 并在 `notes` 里点名。
看到 `skipped_lines > 0` 就说明：**这个总价一定偏低**（缺的料没算进去）。

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

## 固有局限（无法消除，务必知情）

下面这些**不是 bug，是数据源与规则的客观限制**。插件能保证的是「不隐瞒」（每条价格都带 `currency` + `source`，缺数据就标 `NOT-FOUND` / `skipped` / `估算`），但消除不了。

### 1. 价格本质是「美元 SMT 元件价」，不是立创商城零售价

- `unit_usd` 取自**嘉立创 SMT 元件库的 USD 阶梯价**（按采购量取档）——这是贴片/BOM 配单口径；
- 立创商城（零售、含税、包邮门槛不同）的人民币价是**另一套价格体系**；
- 两者**从不互相换算**：有真实 CNY 才给 `unit_cny`，拿不到才给 `unit_cny_estimate` 并固定标注「估算参考」。
- 所以**手焊 DIY 用户看到的"人民币价"多半是估算**，不是你在立创商城结账时的价格。

### 2. 人民币价 best-effort，可能整体为 0 覆盖

CNY 链路是 `EasyEDA API（C 号 → 国内商品 id）→ item.szlcsc.com 页面`：

- 实测 EasyEDA 对非浏览器 IP 返回 **403**，这一步挂掉 → **CNY 覆盖率为 0**；
- `item.szlcsc.com` 有阿里云 WAF，间歇 405 / 挑战页；
- 此时 `components_cny_estimate` = 各料「最高采购量档 USD × 6.0」的粗估，**只能当参考，不能当报价**。

### 3. 6.0 是标定系数，不是汇率

`usdToCnyFactor` 默认 `6.0`，来自 Recording_card 项目 20 个已知人民币价料的中位误差 ≈1.6% 的标定。
它不是实时汇率，也不区分品类：**MCU / 连接器 / 继电器 / 电源模块**这类国内外定价差大的料，误差会明显大于 1.6%。
可以在 bundle config 里改，但改了也只是更贴近某个项目的历史样本。

### 4. 三个仓库，三种库存；手焊要看的那一个**当前拿不到**

这是本插件最容易被误读的地方，务必看清：

| 仓库 | 谁在用 | 数据源 | 当前可达 |
|---|---|---|---|
| 立创商城**国内站**（szlcsc） | **手焊 DIY 真正下单的地方** | `EasyEDA API → item.szlcsc.com` | ❌ EasyEDA 403，链路第一环就断 |
| 立创商城**国际站**（lcsc.com） | 海外零售 | `lcsc.com` 商品页 `stockNumber` | ✅ 可读，但那是**国际仓** |
| 嘉立创 **SMT 备料仓**（JLCPCB） | 贴片打样 | JLCPCB SMT 元件接口 | ✅ 可读 |

**国际站库存 ≠ 国内仓库存**。实测反例：`C15849`（三星 1uF 0603）在 lcsc.com 的 `stockNumber` 是 **0**，而嘉立创 SMT 有 **12,462,062** 颗——拿国际站的 0 当"立创商城无货"就是错的。

所以 `audit_lcsc_bom` 的实际口径是：

- `assembly=smt`：价格 + 库存都取嘉立创 SMT 备料仓（贴片场景本来就该这么算）；
- `assembly=hand`：**价格**取立创商城零售阶梯价（lcsc.com，比 SMT 批量价更接近你结账的价）；**库存仍取嘉立创 SMT 数**——因为立创国内站不可达、国际站又不能冒充；
- 每行都带 `stock_source` / `price_source`，**看清来源再用**；
- 立创有货、SMT 不供的料（如 `C7429632`：lcsc.com 375,100 颗），手焊模式会用 lcsc.com 兜底，不再误报 `NOT-FOUND`；
- 反过来 `NOT-FOUND` 只说明「三个来源都没查到」，**不等于买不到**。

> 结论：**手焊模式下输出里的「库存」并不是立创商城库存**。这是数据源限制，不是没接线——国内站那条链被挡死了。

### 5. 没有 LCSC 编号的料永远算不出价格

插件**不做自动选型猜测**——BOM 行没有 `Supplier Part` 就直接跳过（并在 `skipped` 里点名）。

三份真实 BOM 实测缺失率：**6%（2/32）、35%（7/20）、3%（1/30）**。第二份缺的正是电流采样电阻、继电器、AC-DC 电源模块。
→ 只加料号这件事必须人来做，插件只能提醒。

### 6. 价格 / 库存是抓取时刻快照

- 阶梯价按 `qty × boards` 取档，但接口档位可能滞后于实际下单页；
- `stock` 只是快照，不等于可下单量；
- 插件不预留库存、不下单。

### 7. SMT 上料费口径有限

- 只按 **$3 / 唯一料号 / 单**（嘉立创经济型）估算；
- **不含**工程费、钢网费、焊点费、加急费、手焊费、测试费；
- **「优选扩展库（Preferred Extended）」未在公开接口暴露**，所以你可能实际免掉上料费 → 插件会**高估**；
- 计费规则会变，以下单页为准。

### 8. 基础库替代只做「保守同类替换」

替代建议的前提：同 category、同 package、`libraryType=base`、有库存、参数匹配。
**不做**电气余量、耐压/耐流、温度等级、寿命、认证（AEC-Q200 等）的全面等效验证。换料前请自己核对 datasheet。

### 9. 参数匹配依赖 JLCPCB 的属性字段

- 属性是英文（`Capacitance` / `Voltage Rating` / …），中文关键词支持差，插件会先翻译；
- 冷门料/新料属性可能缺失 → 「明明有却搜不到」；
- 容差/精度解析是启发式的：`±10%`、`1%`、`X7R` 能识别，生僻写法可能漏。

### 10. SMT 库只是立创全量 SKU 的子集

立创商城百万级 SKU，嘉立创 SMT 备料只是其中一部分。`assembly=smt` 的结果天然偏少。

### 11. 长料号曾完全不可见（本补丁已修）

标准料号是 `C` + 4~7 位数字，但目录里存在 `C9900021114`（C + **10 位**）这类长料号。
v0.2.0 的 `^C\d{4,8}$` 会在 `normalizeJlcItem` 里把这类料**整条丢弃**，表现成「BOM 里明明有编号，却没进审计」。
现已放宽到 `C\d{4,11}`。

> 一句话：**插件给的是「有据可查的估算 + 明确的缺口清单」，不是报价单。**
> 下单前请用 `unit_usd` / `unit_cny` 对应的源页面复核，缺编号的行先补选型。

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
