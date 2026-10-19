"""
抓商品页真实网络响应（CDP Network 域）

比在页面里翻全局变量可靠：接口返回什么就是什么。
用法：python tools/cdp_net.py <商品ID> [在页面上再做什么]
"""
import json
import sys
import time

sys.path.insert(0, "tools")
from cdp_lib import CDP, http_list, new_tab  # noqa: E402

import websocket  # noqa: E402


def main():
    iid = sys.argv[1] if len(sys.argv) > 1 else "844934128301"
    t = new_tab("https://www.goofish.com/item?id=%s&categoryId=126862698" % iid)
    ws = websocket.create_connection(t["webSocketDebuggerUrl"], timeout=180,
                                      suppress_origin=True)
    _id = [0]

    def send(method, params=None):
        _id[0] += 1
        ws.send(json.dumps({"id": _id[0], "method": method,
                            "params": params or {}}))
        return _id[0]

    bodies = {}          # requestId -> url
    hits = []

    send("Network.enable")
    send("Page.enable")
    send("Page.reload", {"ignoreCache": True})

    end = time.time() + 45
    pending = {}         # requestId -> url
    while time.time() < end:
        try:
            m = json.loads(ws.recv())
        except Exception:
            continue
        meth = m.get("method")
        if meth == "Network.requestWillBeSent":
            req = m["params"]["request"]
            u = req.get("url", "")
            if "mtop" in u or "detail" in u:
                pending[m["params"]["requestId"]] = u
        elif meth == "Network.loadingFinished":
            rid = m["params"]["requestId"]
            u = pending.pop(rid, None)
            if not u:
                continue
            mid = send("Network.getResponseBody", {"requestId": rid})
            # 等这一个 id 的响应
            t2 = time.time() + 8
            while time.time() < t2:
                try:
                    mm = json.loads(ws.recv())
                except Exception:
                    break
                if mm.get("id") == mid:
                    body = (mm.get("result") or {}).get("body") or ""
                    if body:
                        hits.append((u, body))
                    break

    ws.close()
    try:
        websocket.create_connection(t["webSocketDebuggerUrl"], timeout=10,
                                    suppress_origin=True).close()
    except Exception:
        pass

    print("捕获 %d 个接口响应" % len(hits))
    for u, body in hits:
        short = u.split("?")[0].split("/")[-2:]
        print("\n=== %s" % "/".join(short))
        print("   长度 %d" % len(body))
        if "skuList" in body:
            try:
                j = json.loads(body)
                it = j.get("data", {}).get("itemDO", {})
                sl = it.get("skuList")
                print("   ★ 有 skuList:", type(sl).__name__,
                      len(sl) if isinstance(sl, list) else "")
                if isinstance(sl, list) and sl:
                    for s in sl[:4]:
                        props = " | ".join(
                            "%s=%s" % (p.get("propertyText"), p.get("valueText"))
                            for p in (s.get("propertyList") or []))
                        print("     ", props, " price=", s.get("price"),
                              " cents=", s.get("priceInCent"),
                              " qty=", s.get("quantity"))
            except Exception as e:
                print("   解析失败", e)
        with open("net-%s.json" % iid, "w", encoding="utf-8") as f:
            pass
    # 存全部
    with open("tools/fixtures/xy-net-%s.json" % iid, "w", encoding="utf-8") as f:
        json.dump([{"url": u, "body": b} for u, b in hits], f, ensure_ascii=False)
    print("\n已存 tools/fixtures/xy-net-%s.json" % iid)


if __name__ == "__main__":
    main()
