#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""立创商城/嘉立创数据源探针公共库。

设计原则（可复现 + 不打挂接口）：
- 缓存：/tmp/lcsc_probe_cache/（绝不写 workspace）；默认 TTL 见 CACHE_TTL
- 节流：全局最小请求间隔 MIN_INTERVAL 秒（默认 1.0s），串行
- 重试：网络错误/5xx 重试 3 次，指数退避
- 记录：每次真实请求写入 /tmp/lcsc_probe_raw/ 便于事后核对
- WAF：item.szlcsc.com 命中阿里云 WAF 挑战时，用 node 执行挑战 JS 计算
  acw_sc__v2 cookie 后重试（仅研究用；插件不建议绕过，见报告合规章节）
"""

import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
CACHE_DIR = "/tmp/lcsc_probe_cache"
RAW_DIR = "/tmp/lcsc_probe_raw"
OUT_DIR = "/tmp/lcsc_probe_out"
for d in (CACHE_DIR, RAW_DIR, OUT_DIR):
    os.makedirs(d, exist_ok=True)

MIN_INTERVAL = 1.0          # 全局请求最小间隔（秒）
CACHE_TTL = {               # 各数据源建议缓存时间（秒）
    "jlc": 30 * 60,
    "easyeda": 6 * 3600,
    "item": 2 * 3600,
    "global": 6 * 3600,
}

_last_request = [0.0]
_stats = {"requests": 0, "cache_hits": 0, "errors": 0, "waf": 0, "retries": 0}


# ---------------------------------------------------------------- 节流 / 统计
def throttle():
    dt = time.time() - _last_request[0]
    if dt < MIN_INTERVAL:
        time.sleep(MIN_INTERVAL - dt)
    _last_request[0] = time.time()


def stats():
    return dict(_stats)


# ---------------------------------------------------------------- 缓存
def _cache_path(source, key):
    h = hashlib.sha1(key.encode()).hexdigest()[:16]
    safe = re.sub(r"[^0-9A-Za-z_.-]+", "_", key)[:60]
    return os.path.join(CACHE_DIR, f"{source}_{safe}_{h}.json")


def cache_get(source, key):
    p = _cache_path(source, key)
    if not os.path.exists(p):
        return None
    try:
        d = json.load(open(p, encoding="utf-8"))
    except Exception:
        return None
    if time.time() - d.get("_ts", 0) > CACHE_TTL.get(source, 3600):
        return None
    _stats["cache_hits"] += 1
    return d.get("data")


def cache_put(source, key, data):
    p = _cache_path(source, key)
    with open(p, "w", encoding="utf-8") as f:
        json.dump({"_ts": time.time(), "data": data}, f, ensure_ascii=False)


# ---------------------------------------------------------------- HTTP
def http_request(url, method="GET", payload=None, headers=None, timeout=40,
                 raw_save=None):
    """底层请求，返回 (status, body_bytes_or_str, resp_headers dict)。"""
    hdrs = {"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"}
    if headers:
        hdrs.update(headers)
    data = None
    if payload is not None:
        data = json.dumps(payload).encode()
        hdrs.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read()
            status = r.status
            rh = dict(r.headers)
    except urllib.error.HTTPError as e:
        status = e.code
        body = e.read()
        rh = dict(e.headers or {})
    except Exception as e:  # noqa: BLE001
        return 0, f"__NETERR__ {e!r}".encode(), {}
    if raw_save:
        fn = os.path.join(RAW_DIR, raw_save)
        try:
            with open(fn, "wb") as f:
                f.write(body if isinstance(body, bytes) else body.encode())
        except Exception:  # noqa: BLE001
            pass
    _stats["requests"] += 1
    return status, body, rh


def request_with_retry(url, method="GET", payload=None, headers=None,
                       tries=3, backoff=2.0, raw_save=None):
    last = None
    for i in range(tries):
        throttle()
        status, body, rh = http_request(url, method, payload, headers, raw_save=raw_save)
        if status and 200 <= status < 400 and not body.startswith(b"__NETERR__"):
            return status, body, rh
        last = (status, body, rh)
        _stats["errors"] += 1
        _stats["retries"] += 1
        time.sleep(backoff * (i + 1))
    return last if last else (0, b"", {})


# ---------------------------------------------------------------- WAF
_waf_cookie = {"value": None, "ts": 0}


def _run_challenge(html):
    """执行阿里云 WAF 挑战页 JS，返回 acw_sc__v2 cookie 值。"""
    m = re.search(r'<textarea id="renderData"[^>]*>(.*?)</textarea>', html, re.S)
    if not m:
        return None
    scripts = re.findall(r"<script[^>]*>(.*?)</script>", html, re.S)
    if len(scripts) < 2:
        return None
    render = m.group(1)
    s1, s2 = scripts[0], scripts[1]
    js = r"""
const fs=require('fs'), vm=require('vm');
const rd = JSON.parse(fs.readFileSync(0,'utf8'));
let captured={cookie:''};
const doc={cookie:'',getElementById:()=>({innerHTML:rd.render}),createElement:()=>({style:{},setAttribute(){},appendChild(){},addEventListener(){}}),addEventListener(){},documentElement:{},body:{appendChild(){}},querySelector:()=>null,querySelectorAll:()=>[]};
Object.defineProperty(doc,'cookie',{get(){return captured.cookie;},set(v){captured.cookie=v;}});
const sb={document:doc,navigator:{userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',webdriver:false,language:'zh-CN',languages:['zh-CN'],platform:'MacIntel'},location:{reload(){},href:'https://item.szlcsc.com/'},setTimeout:()=>0,clearTimeout(){},console:{log(){},error(){},warn(){}},atob:s=>Buffer.from(s,'base64').toString('binary'),btoa:s=>Buffer.from(s,'binary').toString('base64')};
sb.window=sb;sb.self=sb;sb.globalThis=sb;
const ctx=vm.createContext(sb);
try{vm.runInContext(rd.s1,ctx,{timeout:5000});}catch(e){}
try{vm.runInContext(rd.s2,ctx,{timeout:10000});}catch(e){}
console.log(captured.cookie);
"""
    inp = json.dumps({"render": render, "s1": s1, "s2": s2})
    try:
        p = subprocess.run([("node" if _which("node") else "nodejs"), "-e", js],
                           input=inp, capture_output=True, text=True, timeout=30)
    except Exception as e:  # noqa: BLE001
        return None
    for line in (p.stdout or "").splitlines():
        m2 = re.search(r"acw_sc__v2=([0-9a-fA-F-]+)", line)
        if m2:
            return m2.group(1)
    return None


def _which(name):
    for p in os.environ.get("PATH", "").split(os.pathsep):
        if os.path.exists(os.path.join(p, name)):
            return os.path.join(p, name)
    return None


def get_item_page(pid, allow_waf_solve=True, tries=3):
    """获取 item.szlcsc.com/<pid>.html，自动处理 WAF 挑战。

    返回 dict: {status, size, waf, solved, html}（html 仅在拿到真实页面时给出）
    """
    url = f"https://item.szlcsc.com/{pid}.html"
    headers = {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": "https://www.szlcsc.com/",
    }
    if _waf_cookie["value"] and time.time() - _waf_cookie["ts"] < 1800:
        headers["Cookie"] = f"acw_sc__v2={_waf_cookie['value']}"
    for i in range(tries):
        throttle()
        status, body, _rh = http_request(url, headers=headers,
                                         raw_save=f"item_{pid}_try{i}.html")
        html = body.decode("utf-8", "ignore") if isinstance(body, bytes) else str(body)
        if "__NEXT_DATA__" in html:      # 正常页面
            return {"status": status, "size": len(html), "waf": False,
                    "solved": False, "html": html}
        if "aliyun_waf" in html or "acw_sc__v2" in html or "renderData" in html:
            _stats["waf"] += 1
            if not allow_waf_solve:
                return {"status": status, "size": len(html), "waf": True,
                        "solved": False, "html": ""}
            ck = _run_challenge(html)
            if ck:
                _waf_cookie["value"] = ck
                _waf_cookie["ts"] = time.time()
                headers["Cookie"] = f"acw_sc__v2={ck}"
                continue
        # 网络失败或其它
        if status == 0:
            return {"status": 0, "size": len(html), "waf": False,
                    "solved": False, "html": ""}
    return {"status": status, "size": len(html), "waf": True,
            "solved": bool(_waf_cookie["value"]), "html": ""}


# ---------------------------------------------------------------- JSON 工具
def parse_next_data(html):
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except Exception:  # noqa: BLE001
        return None


def dig(obj, *path, default=None):
    cur = obj
    for p in path:
        if isinstance(cur, dict):
            cur = cur.get(p, default)
        elif isinstance(cur, list) and isinstance(p, int):
            cur = cur[p] if 0 <= p < len(cur) else default
        else:
            return default
    return cur


def save_out(name, obj):
    p = os.path.join(OUT_DIR, name)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    return p
