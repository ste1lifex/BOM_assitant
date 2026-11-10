# 立创找料 DSH 插件：开源生态调研与决策建议

> 调研日期：2026-11-10（Asia/Shanghai）｜数据与 star 数为当日抓取快照
> 调研方式：GitHub API / 仓库 README 原始内容核验 + 本机对 LCSC 各数据源的实测 + 阅读 Recording_card 项目已有经验
> 结论先行：**类似项目有，但「DSH/agent 原生的立创查价插件」是空白。值得做，但要做「小而美」，不要做全功能平台。**

---

## TL;DR

1. **有类似项目，而且不少**：`jlcparts`（嘉立创 SMT 元件参数化搜索，846★）、`kicad-jlcpcb-tools`（KiCad 内配 LCSC 号 + 出 JLC BOM，2134★）、`easyeda2kicad`（1758★），通用 BOM/库存有 InvenTree（7837★）、Part-DB（1840★），MCP 方向有 `pcbparts-mcp`（144★）等。
2. **但没人做过「立创商城价格/库存 + BOM 批量核对 + agent 原生」这个组合**：上述项目要么只做 EDA 库转换、要么只做嘉立创 SMT 参数选型、要么只是库存系统。
3. **DSH 插件生态里是空白**：社区插件精选列表 `awesome-dsh-plugin` 约 1 万条条目（24,136★），电子类插件已有 6+ 个，**但没有任何立创/LCSC 查价插件**（LCSC/dsh 关键词 GitHub 搜索 = 0 结果）。
4. **数据源可做，但今天实测有一条硬约束**：国际版 `lcsc.com`（美元阶梯价+库存）和嘉立创 SMT 接口（USD 搜索）稳定可用；国内站 `item.szlcsc.com`（人民币价）有阿里云 WAF 间歇拦截，**只能做 best-effort，不能作为唯一数据源**。
5. **顺手纠正 Recording_card 的一个口径问题**：`hardware/BOM_v0.5.md` 里「嘉立创 SMT 人民币」一列，实测其实是 **USD**（与 lcsc.com 美元阶梯价吻合到 ~1%）。也就是说 BOM v0.5 的 SMT 合计 ¥1.334 实为美元数值，人民币口径需重算。这条对 Recording_card 本身就有价值。

---

## 1. 开源社区有没有类似项目？

### 1.1 立创 / 嘉立创 / EasyEDA 生态

| 项目 | ★ | License | 最近 push | 做什么 | 缺口 |
|---|---:|---|---|---|---|
| [yaqwsx/jlcparts](https://github.com/yaqwsx/jlcparts) | 846 | MIT | 2026-11-10 | 嘉立创 SMT 元件**参数化搜索 + 离线数据库** | 选料向，不做 BOM 核对、不做 agent 工具 |
| [Bouni/kicad-jlcpcb-tools](https://github.com/Bouni/kicad-jlcpcb-tools) | 2134 | MIT | 2026-11-06 | KiCad 插件内配 LCSC 编号、查嘉立创元件库、生成 JLC BOM+CPL | 只在 KiCad 内用；不覆盖「给 agent 找料」场景 |
| [uPesy/easyeda2kicad.py](https://github.com/uPesy/easyeda2kicad.py) | 1758 | AGPL-3.0 | 2026-04-08 | 按 LCSC 编号把元件转成 KiCad 库 | 只做库转换，**不查价/不查库存** |
| [easyeda/easyeda-api-skill](https://github.com/easyeda/easyeda-api-skill) | 1078 | 未声明 | 2026-11-09 | 嘉立创 EDA 专业版 AI Skill（WebSocket 桥） | 面向 EDA 操作，不涉供应链 |
| [zhoushoujianwork/easyeda-agent](https://github.com/zhoushoujianwork/easyeda-agent) | 1005 | NOASSERTION | 2026-11-08 | 嘉立创 EDA 开源 AI 自动化（CLI/Agent/MCP） | 设计自动化，不含找料查价 |
| [hyl64/jlcmcp](https://github.com/hyl64/jlcmcp) | 272 | MIT | 2026-08-15 | 嘉立创 EDA MCP Server（59 个工具） | 不涉元件价格/库存 |
| [Averyy/pcbparts-mcp](https://github.com/Averyy/pcbparts-mcp) | 144 | MIT | 2026-11-09 | 为 PCB 装配搜索元件的 MCP Server | 未确认是否接立创；无明确价格/BOM 能力 |
| [openscopeproject/InteractiveHtmlBom](https://github.com/openscopeproject/InteractiveHtmlBom) | 4645 | MIT | 2026-10-17 | 交互式 HTML BOM 可视化 | 无供应商/价格数据 |
| [inventree/InvenTree](https://github.com/inventree/InvenTree) | 7837 | MIT | 2026-11-10 | 开源库存/元器件/BOM 管理系统 | 不自动查立创，价格靠手工/插件 |
| [Part-DB/Part-DB-server](https://github.com/Part-DB/Part-DB-server) | 1840 | AGPL-3.0 | 2026-11-09 | 电子元器件库存管理 | 同上，本地库存为主 |

> 另有 Fabrication-Toolkit（706★）、Ki-nTree（251★）、inventree-part-import（90★，支持从 LCSC 导入 InvenTree）等，均为「库/库存/制造文件」方向，不构成 agent 原生的立创查价工具。

### 1.2 DSH 插件生态

| 事实 | 证据 |
|---|---|
| 社区插件精选列表巨大 | [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) **24,136★**（CC0-1.0，2026-11-10 仍更新），README 约 **10,122** 条插件条目 |
| 有成熟插件市场 + 自定义索引分发 | [dsh-market](https://github.com/dsh-market/dsh-market) **11,769★**（MIT）；目录同时以 format-1 index 形式发布：`https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`，DSH ≥0.2.1 可在 Plugins → Discover → Index sources 添加；上架方式是 **给 awesome-dsh-plugin 提 PR**，市场/索引自动收录 |
| 已有「电子/硬件类」DSH 插件 | `dsh-pcb-parts-search`（元器件搜索，走**芯灵 eda.cn** 接口，只返回 mpn/厂商/描述/数据手册 + EDA 模型过滤，**无价格/库存**）、`dsh-enet-review`/`boardwise`（EasyEDA 网表/原理图审查）、`dsh-electro-lab`（电子计算）、`dsh-breadboard`（硬件仿真）、`kicad-mcp-dsh-plugin`（kicad-mcp 桥） |
| **立创/LCSC 查价插件** | **0 个**（awesome 列表全文 grep：LCSC/立创 无命中；GitHub 搜索 `lcsc+dsh` total=0） |

### 1.3 小结：已有 vs 空缺

- **已有**：EDA 库转换、嘉立创 SMT 参数选型、Kicad 内 BOM 导出、通用 BOM/库存系统、MCP 雏形。
- **空缺**：① agent 原生（DSH 工具）的立创查价+库存查询；② BOM 批量核对（缺货/价格/库存一键核）；③ 人民币 vs 嘉立创 SMT 双口径与「基础库/扩展库」成本提示；④ 替代料推荐。
- 结论：**「查价」这件事早有人做，「让 AI agent 在 DSH 里顺手查立创料」没人做。** 这是小而真实的空档。

---

## 2. 数据源实测（决定可行性的关键）

> 以下为本机 2026-11-10 实际请求结果，不是文档转述。

| 通道 | 能拿到什么 | 币种/口径 | 当前可用性 | 建议 |
|---|---|---|---|---|
| **嘉立创 SMT 元件库接口**<br>`POST jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList` | 关键词搜索、LCSC 编号、库存、阶梯价、基础库/扩展库、立创商品链接 | **USD**（已交叉验证） | ✅ 稳定、无需登录 | **搜索层主数据源** |
| **国际站商品页**<br>`GET lcsc.com/product-detail/{C编号}.html` → `__NEXT_DATA__` | 精确型号、USD 阶梯价、库存（国内/海外仓拆分）、封装、参数 | **USD** | ✅ 稳定；国内专属料返回 `dataIsNull`（如 AD142A4 C7434398） | **精确价格主数据源**（按 C 号直达） |
| **国内站商品页**<br>`GET item.szlcsc.com/{pid}.html` → `__NEXT_DATA__` | 人民币 1pc 价、国内库存、参数（`pageProps.price`） | **CNY** | ⚠️ 阿里云 WAF 间歇拦截：低速率实测 6 次仅 1 次成功（首测成功后转挑战页）；不可靠 | **best-effort 增强**，严格节流+缓存+失败降级，**不做 WAF 绕过** |
| EasyEDA 接口<br>`GET easyeda.com/api/products/{C编号}/components` | C 号→国内 productId 映射（`szlcsc.id`） | — | ✅ 可用（取 pid 用） | 只用于 pid 映射；**价格字段已过时勿用**（C1581 `lcsc.price` 0.0132 vs 实际 USD 0.0072） |
| 国际站搜索接口<br>`POST wmsc.lcsc.com/ftps/wm/search/v3/global` | 搜索结果 | — | ⚠️ 需前端 RSA cipher（明文返回 405 Invalid field） | **MVP 不依赖**；JLC 接口搜索已够用 |
| 中文关键词搜索 | — | — | ❌ JLC 接口中文关键词 total=0（"锂电充电芯片"实测 0 结果）；国内搜索页被 WAF | MVP 用**型号/C 号/英文关键词**；中文别名后续本地映射 |

### 2.1 重要口径纠错：Recording_card BOM v0.5 的「嘉立创 SMT 人民币」

实测同一物料在两处的价格几乎相等（价差 ~1%，属日期/汇率级别波动）：

| 物料 | JLC SMT 接口（被标为 RMB） | lcsc.com 国际站（USD） | 结论 |
|---|---|---|---|
| C668215 TP4054 | 0.0385 | 0.0388 | 接口价 = **USD** |
| C1581 0402 100nF | 0.0071 | 0.0072 | 同上 |
| C16581 TP4056-42 | 0.1853 | 0.1869 | 同上 |

⇒ `BOM_v0.5.md` 的「嘉立创 SMT 1pc 价 / 合计 ¥1.334」实际是 **USD 数值**，不是人民币。人民币口径要么用国内站实时价，要么与嘉立创 SMT 实际报价核对。**插件输出必须每个价格都带 `currency` 和 `source` 字段。**

另：国内站 CNY 与国际站 USD **不是简单汇率关系**。但补充核实（2026-11-10 晚）：Recording_card 的「USD × 6.0」系数**是可用的**——它乘的是 LCSC 全球站**最高采购量档（批量档）USD**，不是首档/订单量档。用 20 个已知人民币价的料验证：`CNY / 最高量档USD` 中位数 **6.07**，估算中位误差 **1.6%**；若对首档 USD 直接乘 6.0 会高估约 2 倍（首档 USD 的比值中位数约 3.1）。插件已据此实现 `cny_estimate`：只有 USD 时输出参考人民币估算（默认系数 6.0，可配置），并始终保留 USD 为实际参考价。

---

## 3. 值得做吗？—— 值得，但做小

### 3.1 推荐方案（A+C 组合，2~3 周可出 MVP）

**核心定位**：做 MCP server（通用：Claude/Cursor/其他 agent 都能用）+ DSH bundle 薄壳（进 DSH 插件市场拿曝光），一套数据层两种入口。

| 工具 | 输入 | 输出 |
|---|---|---|
| `lcsc_search` | 关键词/型号/C 号 | 候选料列表：LCSC 号、型号、品牌、库存、USD 阶梯价、基础库/扩展库、商品链接 |
| `lcsc_part` | C 号数组 | 精确价格/库存/封装/参数；国内站 CNY 价（best-effort，标注来源与时间） |
| `bom_check` | BOM（CSV 文本/行数组） | 逐项核对：verified / NO-STOCK / NOT-FOUND / 币种 / 总价汇总 / 缺货清单 |

**非目标（明确不做）**：不做全功能 BOM 平台、不做爬虫工程、不绕过 WAF、不做自动下单/比价大屏。

### 3.2 分发路径（现成的，不用从零建生态）

1. npm 发布包（`dsh-plugin-*` 命名，MIT License）；
2. 给 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提一条 PR（市场/索引通常一天内自动收录）；
3. 用户可在 DSH 市场一键安装，或在 Discover 添加自定义索引；
4. README 双语 + 数据来源/免责声明（价格库存为公开页面快照，下单前以立创实时页面为准）。

### 3.3 风险与缓解

| 风险 | 缓解 |
|---|---|
| 国内站 WAF/限流导致 CNY 价格不稳 | 国内站只做 best-effort；主数据源用国际站 USD + JLC 接口；严格节流 + 缓存 5~15min + 失败降级 |
| 币种口径再次混用 | 所有价格强制带 `currency`/`source`/`fetched_at`；报告与 README 写明 |
| 接口/页面改版 | 解析层独立、fixture 测试（PoC 已有离线 34 项测试）、失败降级为“仅返回链接” |
| 合规/条款 | 只用公开页面与接口，低频率、标注来源与时间、不绕过反爬、提供免责声明 |
| DSH 插件 API 仍为 0.2.x rc | 锁定 `engines.dsh` 版本范围；把核心逻辑放数据层，插件壳尽量薄 |
| 长期维护 | 小而美 + CI 离线测试 + 清晰贡献指南；热度不够时至少还能当 MCP server 用 |

### 3.4 如果「只想用、不想造」

- 选料/查嘉立创 SMT 参数：直接用 **jlcparts**；
- 在 KiCad 里配 LCSC 号 + 出 JLC BOM：直接用 **kicad-jlcpcb-tools**；
- 在 DSH 里做元器件搜索：装 **dsh-pcb-parts-search**（但只有型号/描述，无价格库存）；
- 想给现有 `Recording_card/tools/lcsc_query.py` 加 agent 能力：包一层 MCP server 或 DSH bundle 即可（本仓库 PoC 可作模板）。

**最终建议**：值得做，但按「MCP 核心 + DSH 薄壳 + 3 个工具 + best-effort 人民币」的最小形态做；先发 MVP 验证下载/issue，再决定要不要加替代料推荐（v2）。若你近期没有维护意愿，就不做，直接用 jlcparts + kicad 插件。

---

## 4. 本次已产出

| 文件 | 说明 |
|---|---|
| `docs/立创找料DSH插件_调研与决策.md` | 本报告 |
| `research/prior-art.md` | prior art 初稿（20+ 项目表与证据链接，部分条目标注「待核验」） |
| `poc/lcsc-dsh-plugin/` | 可安装的 DSH bundle 骨架：`package.json`/`cordis.patch.yml`/`index.js`（3 个工具）/`locale`/`icon`/`README.md`；**离线自测 34/34 通过**；尚未做端到端安装验证 |
| `poc/validate.mjs` | 独立测试脚本（`node poc/validate.mjs --offline`，392 行，含 fixture 与数据层校验） |

> 说明：由于时间与网络波动，`dsh-plugin-architecture.md` 与数据源长文未定稿；DSH 插件机制的关键结论已吸收进本报告（bundle = 带 `dsh.bundle.patch` 的 npm 包，Host 插件 `apply(ctx, config)` + `inject: ['tools']` 注册工具，装完用 `plugin_manager` 验证；社区分发走 awesome-dsh-plugin PR + 市场索引）。

---

## 5. 附：淘宝/1688 搜「电池、插头」这类 DIY 件能做吗？

> 追加实测：2026-11-10 晚，本机直接 HTTP 请求。

### 5.1 实测：纯抓取不可行

| 通道 | 结果 |
|---|---|
| `s.taobao.com/search?q=...`（PC 搜索页） | 200 但 34KB 空壳页，命中 `baxia`（阿里反爬）与 login 逻辑，无商品数据 |
| `h5api.m.taobao.com/.../wsearch.appsearch`（移动搜索 API） | 返回 `RGV587_ERROR::SM::哎哟喂,被挤爆啦`，并跳 `login.taobao.com`，需要 `_m_h5_tk` 签名 + 登录态 |
| `s.taobao.com/list?q=...`（robots 名义允许） | **302 跳登录**（`_____tmd_____/login_jump` 风控页） |
| `taobao.com/robots.txt` | `Disallow: /*?*` —— 所有带查询串的页面（即搜索）明确禁止抓取 |
| 京东搜索 / 1688 搜索 | 京东 302 登录/验证；1688 返回 captcha 页 |

结论：**淘宝搜索没有「匿名 HTTP 可拿数据」的通道**，反爬等级远高于立创（登录 + 签名 + 滑块/风控 + robots 明确禁止）。做「淘宝爬虫插件」既不稳定也可能违反平台协议，不建议。

### 5.2 但「能做」，要做成另外三种形态

| 方案 | 怎么做 | 适合度 |
|---|---|---|
| **A. 你自己的浏览器 + DSH 浏览器自动化插件** | 装 `dsh-chrome-bridge`（9★，驱动你已登录的 Chrome，MV3 扩展 + CDP）或 `dsh-native-browser`/`dsh-computer-use` 等；agent 在你真实会话里搜索，遇到滑块你手动过 | ★★★★ 个人使用最现实；不绕过风控，只是代操作你自己的浏览器 |
| **B. 现成淘宝 MCP，挂到 DSH 的 `dsh-mcp-client` 上** | `banxia79009/chengkit-taobao`（55★，OpenCLI，真实搜索/动态筛选/SKU 价+库存/加购，**PolyForm 非商业许可、仅 Windows**）；`goesByhc/cn-scraper-mcp`（78★，聚合搜索含淘宝）；谨慎对待 `dsh-plugin-yuantoutao`（0★，商业联盟佣金 MCP，非开源数据） | ★★★ 能直接用，但依赖第三方维护与平台风控；注意许可证 |
| **C. 轻量「采购链接助手」插件（推荐自研方向）** | 不抓淘宝数据：根据需求生成精确搜索链接 + 筛选参数（包邮/销量/价格区间/天猫），并用 agent 帮你写规格、避坑清单、比价表；配合立创 API 查电子连接器 | ★★★★★ 零反爬风险、可维护；对 DIY 采购足够用 |

### 5.3 对 DIY 采购的具体建议

1. **电子连接器优先立创**：XH/PH/DC 头、排针、电池座、端子等在立创商城都有正品且可 SMT 贴片（Recording_card 也验证过 1.25mm 电池座 C2905009 等）；
2. **淘宝/1688 只买非电子件**：18650/软包电芯、线材、外壳、螺丝铜柱、结构件；
3. **电芯安全**：认准带保护板/UN38.3/MSDS，警惕容量虚标，优先旗舰店/天猫，必要时按 Recording_card 的外采清单询价；
4. **插件形态建议**：把电商能力做成「B 或 A 的桥」而不是自建爬虫；如果做自研，选 C（链接+规格+比价表生成器），再按需接 A 的浏览器桥做增强。

---

## 6. 补充：基础库/扩展库与「DIY 性价比引擎」（2026-11-10 实测）

> 术语澄清：影响贴片费用的是**嘉立创 SMT 的「基础库 / 优选扩展库 / 扩展库」**（JLCPCB 叫 Basic / Preferred / Extended）；立创EDA 的「标准库/扩展库」是符号库概念，与贴片费无关。

### 6.1 官方费用规则（来源：JLCPCB PCB Assembly FAQ，更新于 2026-09-09）

- 基础库（Basic）与优选扩展库（Preferred Extended）：**免上料费**；
- **扩展库（Extended）：每颗料号 $3 上料费**（操作员需人工上飞达，"we charge $3 per extended component"）；
- 其他参考：工程费 $8、钢网 $1.5、SMT $0.0017/焊点、手焊人工 $3.5；
- 国内嘉立创 SMT 对应概念叫「**换料费**」，人民币规则以 [jlcsmt.com 在线计价](https://www.jlcsmt.com/calc-online) 为准；整盘购买器件另有换料费减免活动。
- 结论：**DIY 小批量打样时，扩展库料号的 $3 上料费往往比元件本身贵 1~2 个数量级**，选型比抠单价重要得多。

### 6.2 数据是否支持？——支持，且现成

- JLC 元件库接口直接返回 `componentLibraryType`（`base` / `expand`），**请求里可用 `componentLibraryType` 过滤**（实测：`base` 搜 "10k" 仅 5 条，`expand` 15542 条）；
- 同一响应还带：`stockCount`、USD 阶梯价、`minPurchaseNum`、`minPurchaseNum`/`leastPatchNumber`、`fullReelPrice`、`componentAlternativesCode`（部分料有替代编号，如 C84681→C7464026）、`preferredComponentFlag`、`lcscGoodsUrl`、数据手册链接等；
- 限制：`preferredComponentFlag` 在接口里基本取不到 true（`componentLibraryType:"preferred"` 过滤返回 0），**优选扩展库需以下单页/嘉立创 SMT 计价页为准**，MVP 可先做 base/expand。

### 6.3 实测示例：Recording_card 录音工牌 BOM v0.5（28 个唯一 LCSC 料）

- 基础库 12 个，**扩展库 16 个**；
- 单次打样上料费：16 × $3 = **$48**；该板元件成本合计约 **$1.36**（按阶梯首档粗算）→ **上料费 ≈ 元件成本的 35 倍**；
- 摊销视角：打 5 片 ≈ $9.6/片，打 30 片 ≈ $1.6/片，只有批量上去后元件单价才开始主导；
- 可优化空间：把部分扩展库料换成同参数基础库/优选扩展库（如 22Ω 0402、PTC、磁珠、部分连接器），每换掉 1 个料号省 $3。

### 6.4 由此确定的插件核心能力（v2 建议）

| 工具 | 作用 |
|---|---|
| `library_audit` | 逐料标注 base / preferred / expand，算出整单扩展库数量与上料费，列出"优先替换清单" |
| `bom_cost` | 输入 BOM + 批量 N，算「元件成本 + 上料费 + 钢网/工程费 + 焊点费」→ 每片综合成本与两条路线（立创商城买散料自焊 vs 嘉立创 SMT）对比 |
| `find_alternatives` | 同封装/同参数、优先 base/preferred、库存充足、价格阶梯更优的候选（JLC 替代编号 + 同关键词 base 搜索 + 规则匹配） |
| 排序策略 | 给 DIY 用户默认按「打样 5 片/30 片的综合成本」排序，而不是按元件单价排序 |

---

## 7. 主要参考

- jlcparts：https://github.com/yaqwsx/jlcparts
- kicad-jlcpcb-tools：https://github.com/Bouni/kicad-jlcpcb-tools
- easyeda2kicad.py：https://github.com/uPesy/easyeda2kicad.py
- DSH 插件精选列表：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
- DSH 社区插件市场：https://github.com/dsh-market/dsh-market
- 已有 DSH 元器件搜索插件：https://github.com/Huaqiu-Electronics/dsh-pcb-parts-search
- PCB 元件搜索 MCP：https://github.com/Averyy/pcbparts-mcp
- 嘉立创 EDA MCP：https://github.com/hyl64/jlcmcp
- InvenTree：https://github.com/inventree/InvenTree ｜ Part-DB：https://github.com/Part-DB/Part-DB-server
- LCSC 国际站商品页示例：https://www.lcsc.com/product-detail/C668215.html
- Recording_card 数据源与经验：`/Users/apple/Developer/Recording_card/tools/lcsc_query.py`、`hardware/BOM_v0.5.md`、`research/02_BOM立创选型.md`
