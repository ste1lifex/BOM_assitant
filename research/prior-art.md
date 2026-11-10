# 开源社区 prior art 调研：立创/嘉立创找料查价与 DSH 插件

- **调研日期 / 抓取日期：2026-11-10（Asia/Shanghai）**，所有 star / 最近 push 时间均为该日快照，会持续变化。
- **方法**：GitHub Search API（`/search/repositories`，按 star 排序，一次返回多仓的 star/license/language/pushed_at）为主；关键项目再抓 README / 源码做能力核验；DSH 插件生态用 GitHub topic 与 awesome 列表核验。未认证 API 有小时限流，无法确认的字段一律写「未核实」。
- **判定口径**：「支持立创/嘉立创」指直接使用 LCSC（立创商城）/ JLCPCB（嘉立创 SMT）的元件编号、价格或库存数据；「价格+库存」指同时提供两者；「BOM 批量核对」指可对整个 BOM 逐项查料/查价/校验；「替代料」指提供 pin-to-pin / 参数替代推荐。
- 本文件为**中间稿**，随调研持续更新（最后更新见文末）。

---

## 一、立创 / 嘉立创 / EasyEDA 生态

| # | 项目 | 语言 | ★ | License | 最近 push | 功能一句话 | 立创/嘉立创 | 价格+库存 | BOM 批量 | 替代料 | Agent/MCP | 明显缺口 |
|---|------|------|---|---------|-----------|-----------|-------------|-----------|----------|--------|-----------|----------|
| 1 | [Bouni/kicad-jlcpcb-tools](https://github.com/Bouni/kicad-jlcpcb-tools) | Python | 2134 | MIT | 2026-11-06 | KiCad 插件：从插件内分配 LCSC 编号、查嘉立创元件库、生成 JLCPCB BOM+CPL | ✅ | 待核验（含 JLCPCB 元件数据库检索，疑似价格/库存） | ✅ | 未核实 | ❌ | 只在 KiCad 内用，非 agent，无替代料 |
| 2 | [uPesy/easyeda2kicad.py](https://github.com/uPesy/easyeda2kicad.py) | Python | 1758 | AGPL-3.0 | 2026-04-08 | 把任意 LCSC/EasyEDA 元件（符号/封装/3D）转换为 KiCad 库 | ✅（按 LCSC 编号抓取） | ❌ | ❌ | ❌ | ❌ | 只做库转换，不查价 |
| 3 | [yaqwsx/jlcparts](https://github.com/yaqwsx/jlcparts) | Python | 846 | MIT | 2026-11-10 | 嘉立创 SMT 元件参数化搜索 + 离线数据库（jlcparts 服务） | ✅ | ✅（疑似价格+库存，待核验） | 部分（选料用） | 未核实 | ❌ | 检索/选料向，不直接核对用户 BOM |
| 4 | [TousstNicolas/JLC2KiCad](https://github.com/TousstNicolas/JLC2KiCad) | 待核验 | 待核验 | 待核验 | 待核验 | 按 LCSC/JLC 编号生成 KiCad 库的 CLI/GUI | ✅ | ❌ | ❌ | ❌ | ❌ | 待核验 |
| 5 | [openscopeproject/InteractiveHtmlBom](https://github.com/openscopeproject/InteractiveHtmlBom) | Python | 4645 | MIT | 2026-10-17 | KiCad/EasyEDA/Eagle 等的交互式 HTML BOM 可视化 | ⚪ 读 EasyEDA 文件 | ❌ | 展示 BOM | ❌ | ❌ | 无供应商/价格数据 |
| 6 | [bennymeg/Fabrication-Toolkit](https://github.com/bennymeg/Fabrication-Toolkit) | Python | 706 | Apache-2.0 | 2026-09-29 | KiCad 的 JLC 制造插件（BOM/CPL 导出、丝印等） | ✅（制造格式） | ❌ | 导出 BOM | ❌ | ❌ | 只导出制造文件，不查价 |
| 7 | [hulryung/kicad-lcsc-manager](https://github.com/hulryung/kicad-lcsc-manager) | Python | 77 | MIT | 2026-10-23 | KiCad 内导入 LCSC/EasyEDA 元件（符号/封装/3D） | ✅ | ❌ | ❌ | ❌ | ❌ | 同 easyeda2kicad，小项目 |
| 8 | [rasmushauschild/easyeda2kicad_plugin](https://github.com/rasmushauschild/easyeda2kicad_plugin) | Python | 57 | 未声明 | 2025-08-22 | KiCad 插件：导入 EasyEDA/LCSC 元件 | ✅ | ❌ | ❌ | ❌ | ❌ | 停更较久 |
| 9 | [Yanndroid/KiCAD-EasyEDA-Parts](https://github.com/Yanndroid/KiCAD-EasyEDA-Parts) | Python | 35 | MIT | 2024-06-03 | KiCad 插件：下载 EasyEDA 符号/封装/3D 并转换 | ✅ | ❌ | ❌ | ❌ | ❌ | 已较久未更新 |
| 10 | [easyeda/easyeda-api-sdk](https://github.com/easyeda/easyeda-api-sdk) | TypeScript | 78 | Apache-2.0 | 2026-10-16 | 嘉立创EDA专业版官方扩展开发 SDK | ⚪ 平台侧 | ❌ | ❌ | ❌ | ❌ | 只是 EDA 插件 SDK，不涉供应链 |
| 11 | [easyeda/easyeda-api-skill](https://github.com/easyeda/easyeda-api-skill) | JavaScript | 1078 | 未声明 | 2026-11-09 | 嘉立创EDA专业版 AI SKILL：给 AI 编程工具提供 EasyEDA Pro API + WebSocket 桥接 | ⚪ 平台侧 | ❌ | ❌ | ❌ | ✅（Agent Skill） | 面向 EDA 操作，不查价 |
| 12 | [zhoushoujianwork/easyeda-agent](https://github.com/zhoushoujianwork/easyeda-agent) | Go | 1005 | NOASSERTION | 2026-11-08 | 嘉立创 EDA 专业版开源 AI 自动化（原理图/PCB/工程检查），CLI / Agent Skill / MCP | ⚪ 平台侧 | ❌ | ❌ | ❌ | ✅（MCP） | 设计自动化，不含找料查价 |
| 13 | [hyl64/jlcmcp](https://github.com/hyl64/jlcmcp) | TypeScript | 272 | MIT | 2026-08-15 | 嘉立创 EDA MCP Server（官方栈版）59 工具：PCB/原理图自动化、DRC 等 | ⚪ 平台侧 | ❌（待核验） | ❌ | ❌ | ✅（MCP） | 不涉元件价格/库存 |
| 14 | [biosshot/easyeda-copilot](https://github.com/biosshot/easyeda-copilot) | TypeScript | 216 | MIT | 2026-10-22 | EasyEDA AI 助手：自然语言生成原理图、浏览 LCSC 元件、PCB 设计 | ✅（浏览 LCSC） | 待核验 | 待核验 | ❌ | ✅ | 待核验 |
| 15 | [Averyy/pcbparts-mcp](https://github.com/Averyy/pcbparts-mcp) | Python | 144 | MIT | 2026-11-09 | 为 PCB 装配搜索电子元件的 MCP server | 待核验（是否接 LCSC/JLC） | 待核验 | 待核验 | 待核验 | ✅（MCP） | **需重点核验** |

（以上「待核验」项在最终稿补齐；无法确认则保留「未核实」。）

---

## 二、通用 BOM / 元器件管理（只收与找料/库存/价格直接相关）

| # | 项目 | 语言 | ★ | License | 最近 push | 功能一句话 | 立创/嘉立创 | 价格+库存 | BOM 批量 | 替代料 | Agent/MCP | 明显缺口 |
|---|------|------|---|---------|-----------|-----------|-------------|-----------|----------|--------|-----------|----------|
| 16 | [inventree/InvenTree](https://github.com/inventree/InvenTree) | Python | 7837 | MIT | 2026-11-10 | 开源库存/元器件管理（BOM、库存、供应商、API） | ⚪ 通过插件 | ⚪ 供应商价格插件 | ✅ BOM 管理 | 未核实 | ⚪ 有 API，无官方 MCP | 自建库存系统，不是查价工具 |
| 17 | [Part-DB/Part-DB-server](https://github.com/Part-DB/Part-DB-server) | PHP | 1840 | AGPL-3.0 | 2026-11-09 | 电子元器件库存管理系统（参数、BOM、供应商） | ⚪ | ⚪ | ✅ | 未核实 | ❌ | 本地库存为主，价格靠手工/供应商链接 |
| 18 | [30350n/inventree-part-import](https://github.com/30350n/inventree-part-import) | Python | 90 | MIT | 2026-06-17 | CLI：从 DigiKey/LCSC/Mouser 等供应商导入元件到 InvenTree | ✅ LCSC | 待核验 | 导入向 | ❌ | ❌ | 需自建 InvenTree |
| 19 | [replaysMike/Binner](https://github.com/replaysMike/Binner) | C# | 549 | GPL-3.0 | 2026-04-18 | 面向创客/工程师的开源元件库存系统 | 未核实 | 未核实 | 未核实 | 未核实 | ❌ | 生态小 |
| 20 | Bomist（[官网](https://bomist.com/) / [BOMIST org](https://github.com/BOMIST)） | 闭源 | — | 闭源 | — | 桌面版 BOM/库存管理，支持多供应商价格 | 未核实 | ✅（商业版） | ✅ | 未核实 | ❌ | **非开源**，不可作为开源 prior art 直接复用 |
| 21 | [sparkmicro/Ki-nTree](https://github.com/sparkmicro/Ki-nTree) | Python | 251 | GPL-3.0 | 2026-07-09 | KiCad + InvenTree 快速建元件 | ⚪ | ⚪ | 部分 | ❌ | ❌ | 依赖 InvenTree |
| 22 | [afkiwers/inventree_kicad](https://github.com/afkiwers/inventree_kicad) | Python | 81 | MIT | 2026-10-30 | KiCad 元件库 API 对接 InvenTree | ⚪ | ⚪ | ❌ | ❌ | ❌ | 只是库对接 |
| 23 | [pipeworx-io/mcp-octopart](https://github.com/pipeworx-io/mcp-octopart) | JavaScript | 0 | MIT | 2026-11-09 | Octopart MCP（Nexar Supply API，GraphQL） | ❌（欧美） | ✅（Nexar） | 待核验 | 未核实 | ✅（MCP） | 新项目、0 star、需 Nexar API key |
| 24 | [SpectraSynq/mcp-nexar](https://github.com/SpectraSynq/mcp-nexar) | Python | 0 | Apache-2.0 | 2026-07-13 | Nexar/Octopart GraphQL 元件搜索 MCP | ❌ | ✅（Nexar） | 待核验 | 未核实 | ✅（MCP） | 同上 |

---

## 三、DSH 插件生态（是否有电子/元器件类插件）

| # | 项目 | ★ | License | 最近 push | 说明 | 电子类插件 |
|---|------|---|---------|-----------|------|-----------|
| 25 | [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) | 24135 | CC0-1.0 | 2026-11-10 | DSH 插件精选列表（社区维护） | 待核验：正在检索 README 是否收录电子/立创类插件 |
| 26 | [dsh-market/dsh-market](https://github.com/dsh-market/dsh-market) | 11767 | MIT | 2026-11-09 | DSH 可视化插件市场 | 待核验 |
| 27 | [0xsline/awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness) | 1341 | CC0-1.0 | 2026-11-06 | DSH 生态精选（插件/工具/基础设施） | 待核验 |
| 28 | [anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop) | 35582 | MIT | 2026-11-06 | DSH 桌面端（插件生态） | 非电子类 |

---

## 四、横向对比与「已有 vs 缺口」（草稿，待补齐证据）

### 4.1 已有人把「立创查价 + 库存 + 替代料」做成开源项目了吗？

- **查价/库存**：**部分有**。jlcparts 做了嘉立创 SMT 元件参数化检索与离线数据库；kicad-jlcpcb-tools 能在 KiCad 内查嘉立创元件库并生成 BOM；easyeda2kicad 系列只做库转换、不查价。
- **替代料**：**未发现成熟开源实现**（待最终确认）。
- **BOM 批量核对**：kicad-jlcpcb-tools 面向 BOM+CPL 导出（制造向），是否逐项核对价格/库存待核验；通用库存系统（InvenTree/Part-DB）可管 BOM 但不自动查立创。
- 结论（暂定）：**「立创查价+库存」有人做过，「替代料 + BOM 批量核对 + 中文价格口径」没有成熟开源项目**。

### 4.2 有没有 agent-native / DSH 版？

- 有 **MCP 化**趋势：pcbparts-mcp、jlcmcp、easyeda-agent、mcp-octopart/mcp-nexar 等，但均未覆盖「立创商城查价+库存+替代料+BOM 核对」这个组合；**未发现 DSH（cordis）插件形态的电子/立创类插件**（待 README 级核验确认）。

### 4.3 中文价格口径 / 嘉立创双口径是否被覆盖？

- 待核验：jlcparts 用的是嘉立创 SMT 报价数据（人民币口径）；「立创商城零售价 vs 嘉立创 SMT 价」双口径是否有项目同时覆盖，需查 README/数据源。

---

## 五、结论（草稿，最终 5-8 条待定稿）

1. 立创/EasyEDA 生态的开源项目集中在**库转换与制造文件**（easyeda2kicad、kicad-jlcpcb-tools、Fabrication-Toolkit、InteractiveHtmlBom），不等于找料查价。
2. 真正碰「嘉立创元件价格/库存」的开源项目少而小：jlcparts 是代表（离线参数化检索），但面向选料而非 BOM 核对。
3. 通用 BOM 管理系统（InvenTree、Part-DB）成熟，但价格/库存靠自建/插件，不直接对接立创商城。
4. AI/agent 方向已有 MCP 探索（pcbparts-mcp、mcp-octopart 等），但**立创专属、agent-native 的找料查价工具是空白**。
5. DSH 插件生态体量大（awesome 列表 2.4 万 star），但**未发现电子/元器件类插件**（待核验）。
6. 替代料推荐与「中文双口径价格」是最明显的缺口。
7. 需求应区分「查价工具」（确定性高、适合 CLI/插件）与「AI 找料 agent」（需要语义检索+替代推理）两类。

---

## 六、参考链接

- https://github.com/Bouni/kicad-jlcpcb-tools
- https://github.com/uPesy/easyeda2kicad.py
- https://github.com/yaqwsx/jlcparts
- https://github.com/inventree/InvenTree
- https://github.com/Part-DB/Part-DB-server
- https://github.com/Averyy/pcbparts-mcp
- https://github.com/hyl64/jlcmcp
- https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
- https://github.com/dsh-market/dsh-market
- （最终稿补齐）

---

*最后更新：2026-11-10（调研进行中）*
