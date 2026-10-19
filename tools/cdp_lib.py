"""CDP 小工具：连接、导航、执行 JS"""
import json
import time
import urllib.request
import urllib.parse

import websocket

CDP = "http://127.0.0.1:9222"


def http_list():
    return json.loads(urllib.request.urlopen(CDP + "/json/list", timeout=10).read())


def new_tab(url):
    u = CDP + "/json/new?" + urllib.parse.quote(url, safe=":/?=&%.#")
    return json.loads(urllib.request.urlopen(
        urllib.request.Request(u, method="PUT"), timeout=15).read())


def wait_ready(sec=12):
    end = time.time() + sec
    while time.time() < end:
        try:
            d = http_list()
            pages = [t for t in d if t.get("type") == "page"
                     and "webSocketDebuggerUrl" in t]
            if pages:
                return True
        except Exception:
            pass
        time.sleep(1)
    return False


class Tab:
    def __init__(self, ws_url, timeout=180):
        self.ws = websocket.create_connection(ws_url, timeout=timeout,
                                              suppress_origin=True)
        self._id = 0

    def js(self, expr, await_promise=False, timeout=150):
        self._id += 1
        mid = self._id
        self.ws.send(json.dumps({
            "id": mid, "method": "Runtime.evaluate",
            "params": {"expression": expr, "returnByValue": True,
                       "awaitPromise": await_promise, "userGesture": True}
        }))
        end = time.time() + timeout
        while time.time() < end:
            try:
                m = json.loads(self.ws.recv())
            except Exception:
                continue
            if m.get("id") == mid:
                r = m.get("result", {})
                if "exceptionDetails" in r:
                    return {"__err": str(r["exceptionDetails"])[:300]}
                return r.get("result", {}).get("value")
        return None

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


def pick(url_part):
    for t in http_list():
        if t.get("type") == "page" and url_part in (t.get("url") or ""):
            return Tab(t["webSocketDebuggerUrl"])
    return None
