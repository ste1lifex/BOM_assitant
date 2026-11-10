#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""探针 3：立创商城国内站商品页 item.szlcsc.com。

URL: https://item.szlcsc.com/{productId}.html  （productId 来自 EasyEDA result.szlcsc.id
     / 嘉立创 SMT 接口 componentId，两者实测同源）
关键问题:
  1) __NEXT_DATA__ 是否仍存在，价格/库存/参数的确切 JSON 路径
  2) 反爬（阿里云 WAF acw_sc__v2 挑战）的表现与失败率、重试策略
  3) 无 UA / 高频请求的表现

用法:
    python3 probe_item.py codes      # 批量解析 BOM 料号（自动过 WAF 挑战）
    python3 probe_item.py paths      # 单料号完整路径核查 + 原始 JSON 落盘
    python3 probe_item.py waf        # WAF 挑战/失败率 + 重试统计（N=12）
    python3 probe_item.py noua       # 无 UA / 异常 UA 测试
    python3 probe_item.py burst      # 高频请求（0.2s 间隔 x 10）观察限流
"""

import json
import sys
import time

import common as C

# pid 实测 = EasyEDA szlcsc.id = JLC componentId（见 probe_easyeda.py mapping）
CODE_PID = {
    "C7434398": 8445698, "C668215": 698063, "C16581": 17264, "C1581": 1933,
    "C15850": 16532, "C52923": 53938, "C25744": 26487, "C11702": 12256,
    "C25905": 26648, "C318884": 299976, "C2286": 2659, "C709357": 747093,
    "C22383473": 23926537, "C2905009": 3172294, "C91552": 92741,
    "C8678": 9178, "C347476": 324136, "C82942": 84106,
    "C2687116": 2790619, "C193402": 231120, "C5373222": 6226567,
    "C19330": 20038, "C70110": 71205, "C231329": 231216,
    "C405945": 393870, "C77020": 78147, "C17168": 17853, "C1002": 1354,
    "C351410": 327628, "C725790": 772193,
}


def extract(html):
    """从商品页 __NEXT_DATA__ 提取关键字段，返回 (data, flat)。"""
    d = C.parse_next_data(html)
    if not d:
        return None, None
    pp = C.dig(d, "props", "pageProps", default={}) or {}
    w = pp.get("webData") or {}
    pr = w.get("productRecord") or {}
    params = {}
    for p in w.get("paramList") or []:
        k = p.get("parameterName") or p.get("name")
        v = p.get("parameterValue") or p.get("value")
        if k:
            params[str(k).strip()] = str(v).strip()
    flat = {
        "productId": pr.get("productId"),
        "productCode": pr.get("productCode"),
        "productModel": pr.get("productModel"),
        "brand": pr.get("productGradePlateName"),
        "category": pr.get("productType"),
        "desc": pr.get("remark"),
        "package": pr.get("encapsulationModel"),
        "stockNumber": pr.get("stockNumber"),          # 立创库存
        "validStockNumber": pr.get("validStockNumber"),
        "totalStockNumber": w.get("totalStockNumber"),  # 总库存
        "gdWarehouseStockNumber": w.get("gdWarehouseStockNumber"),  # 广东仓
        "jsWarehouseStockNumber": w.get("jsWarehouseStockNumber"),  # 江苏仓
        "smtStockNumber": w.get("smtStockNumber"),      # SMT 仓
        "minBuyNumber": pr.get("minBuyNumber"),         # 起订量
        "minWholeNumber": pr.get("minWholeNumber"),     # 整盘/整包数量
        "productArrange": pr.get("productArrange"),     # 包装
        "productUnit": pr.get("productUnit"),
        "productMinEncapsulationNumber": pr.get("productMinEncapsulationNumber"),
        "productMinEncapsulationUnit": pr.get("productMinEncapsulationUnit"),
        "theRatio": pr.get("theRatio"),
        "convesionRatio": pr.get("convesionRatio"),
        "encaptionPrice": pr.get("encaptionPrice"),     # 整盘价
        "pageProps.price": pp.get("price"),             # SEO 价（页面显示价）
        "smtLabel": pr.get("smtLabel"),
        "productCycle": pr.get("productCycle"),         # normal/sold_out/stop_product
        "hasStockNow": pr.get("hasStockNow"),
        "productStockStatus": pr.get("productStockStatus"),
        "usableTransitNum": pr.get("usableTransitNum"),
        "isShowPrice": pr.get("isShowPrice"),
        "isEnvironment": w.get("isEnvironment"),
        "pageUrl": pp.get("pageUrl"),
        "pageGeneratedAt": pp.get("pageGeneratedAt"),
        "params": params,
        "webDataKeys": sorted(w.keys()),
    }
    flat["price_coherent_fullreel"] = (
        round(flat["pageProps.price"] * flat["minWholeNumber"], 4)
        if flat["pageProps.price"] and flat["minWholeNumber"] else None)
    return d, flat


def run_codes():
    out = {}
    for code, pid in CODE_PID.items():
        r = C.get_item_page(pid)
        if not r["html"]:
            out[code] = {"pid": pid, "status": r["status"], "waf": r["waf"],
                         "solved": r["solved"], "error": "no __NEXT_DATA__"}
            print(f"{code}: FAIL pid={pid} status={r['status']} waf={r['waf']}")
            continue
        d, flat = extract(r["html"])
        if not d:
            out[code] = {"pid": pid, "error": "parse fail"}
            print(f"{code}: parse FAIL")
            continue
        out[code] = flat
        print(f"{code}: pid={pid} code={flat['productCode']} model={flat['productModel']} "
              f"价格={flat['pageProps.price']} 整盘={flat['encaptionPrice']} "
              f"stock={flat['stockNumber']} total={flat['totalStockNumber']} "
              f"gd={flat['gdWarehouseStockNumber']} min={flat['minBuyNumber']} "
              f"整盘量={flat['minWholeNumber']} 包装={flat['productArrange']}")
    C.save_out("item_codes.json", out)


def run_paths():
    pid = 698063  # C668215
    r = C.get_item_page(pid)
    if not r["html"]:
        print("FAIL", r)
        return
    d, flat = extract(r["html"])
    C.save_out("item_paths_C668215.json",
               {"next_data": d, "flat": flat, "html_len": len(r["html"])})
    print(json.dumps(flat, ensure_ascii=False, indent=1))
    print("\n== 价格相关原始路径 ==")
    pp = d["props"]["pageProps"]
    print("props.pageProps.price =", pp.get("price"))
    pr = pp["webData"]["productRecord"]
    print("props.pageProps.webData.productRecord.encaptionPrice =", pr.get("encaptionPrice"))
    print("props.pageProps.webData.productRecord.minWholeNumber =", pr.get("minWholeNumber"))
    print("props.pageProps.webData.productRecord.theRatio =", pr.get("theRatio"))
    print("props.pageProps.webData.productRecord.minBuyNumber =", pr.get("minBuyNumber"))
    print("props.pageProps.webData.productRecord.encapsulationModel =", pr.get("encapsulationModel"))
    print("props.pageProps.webData.productRecord.productArrange =", pr.get("productArrange"))
    print("props.pageProps.webData.paramList =", json.dumps(
        pp["webData"]["paramList"][:5], ensure_ascii=False))
    print("props.pageProps.webData.productPriceList =", json.dumps(
        C.dig(pp, "webData", "productPriceList"), ensure_ascii=False)[:200])
    print("\nsaved /tmp/lcsc_probe_out/item_paths_C668215.json")


def run_waf():
    """WAF 失败率与重试：连续 12 次冷启动（清 cookie），统计挑战出现次数。"""
    C._waf_cookie["value"] = None
    C._waf_cookie["ts"] = 0
    seq = []
    for i in range(12):
        C._waf_cookie["value"] = None      # 强制冷启动，测挑战概率
        C._waf_cookie["ts"] = 0
        t0 = time.time()
        r = C.get_item_page(698063, allow_waf_solve=True, tries=1)
        ok = bool(r["html"])
        seq.append({"i": i + 1, "status": r["status"], "waf": r["waf"],
                    "ok": ok, "solved": r["solved"],
                    "size": r["size"], "ms": int((time.time() - t0) * 1000)})
        print(f"[{i+1:2}/12] http={r['status']} size={r['size']:7d} "
              f"waf={r['waf']} ok={ok} {seq[-1]['ms']}ms")
    ok_n = sum(1 for x in seq if x["ok"])
    waf_n = sum(1 for x in seq if x["waf"])
    C.save_out("item_waf.json", {"seq": seq, "ok": ok_n, "waf": waf_n,
                                 "rate_ok": ok_n / len(seq),
                                 "stats": C.stats()})
    print(f"\n成功率 {ok_n}/12，WAF 挑战 {waf_n}/12")


def run_noua():
    out = {}
    headers_variants = {
        "无 UA": {"User-Agent": ""},
        "python-urllib 默认": {"User-Agent": "Python-urllib/3.9"},
        "curl UA": {"User-Agent": "curl/8.4.0"},
        "正常 UA 无 Referer": {"Accept": "text/html"},
    }
    for name, hdrs in headers_variants.items():
        C.throttle()
        h = dict(hdrs)
        # 先拿一次有效 cookie，避免挑战干扰"UA 测试"
        r0 = C.get_item_page(698063)
        cookie = C._waf_cookie["value"] or ""
        st, body, rh = C.http_request(f"https://item.szlcsc.com/698063.html",
                                      headers={**h, "Cookie": f"acw_sc__v2={cookie}"} if cookie else h,
                                      raw_save="item_noua_" + str(abs(hash(name)) % 999) + ".html")
        html = body.decode("utf-8", "ignore") if isinstance(body, bytes) else str(body)
        out[name] = {"http": st, "size": len(html), "next_data": "__NEXT_DATA__" in html,
                     "waf": "aliyun_waf" in html or "renderData" in html}
        print(f"{name:18} http={st} size={len(html)} nextdata={out[name]['next_data']} "
              f"waf={out[name]['waf']}")
        time.sleep(0.8)
    C.save_out("item_noua.json", out)


def run_burst():
    """高频请求：拿到 cookie 后 10 次 0.2s 间隔，观察限流/封禁。"""
    C.get_item_page(698063)   # warmup
    cookie = C._waf_cookie["value"] or ""
    seq = []
    for i in range(10):
        st, body, rh = C.http_request(
            "https://item.szlcsc.com/698063.html",
            headers={"Cookie": f"acw_sc__v2={cookie}",
                     "Accept": "text/html,application/xhtml+xml"})
        html = body.decode("utf-8", "ignore") if isinstance(body, bytes) else str(body)
        seq.append({"i": i + 1, "http": st, "size": len(html),
                    "next_data": "__NEXT_DATA__" in html,
                    "waf": "aliyun_waf" in html or "renderData" in html,
                    "hdr": {k: v for k, v in rh.items()
                            if k.lower() in ("retry-after", "x-ratelimit-limit",
                                             "x-ratelimit-remaining", "server",
                                             "x-cache", "content-length")}})
        print(f"[{i+1:2}/10] http={st} size={len(html):7d} "
              f"nextdata={seq[-1]['next_data']} waf={seq[-1]['waf']}")
        time.sleep(0.2)
    C.save_out("item_burst.json", seq)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "codes"
    {"codes": run_codes, "paths": run_paths, "waf": run_waf,
     "noua": run_noua, "burst": run_burst}[cmd]()
    print(f"[stats] {C.stats()}")
