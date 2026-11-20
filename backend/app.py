"""ScholarPi Web — local development backend.

The published app runs on Qoder Sites: a static frontend plus the Edge Function
in ../functions. This Flask module is the local mirror of that split, so the same
browser bundle works offline:

  * hosts the built frontend (frontend/dist), including /papers — the bundled
    demo papers with their pre-parsed per-page text
  * /functions/v1/app/… (and the legacy /api/… aliases)
      llm/*     transparent DeepSeek passthrough (streaming) with the shared demo key
      relay     CORS relay for arXiv / search engines / arbitrary pages
      mcp       JSON-RPC bridge to visitor-configured MCP servers
      health    demo-key availability + remaining quota

The key in DEEPSEEK_API_KEY never reaches the browser: only its presence and the
remaining quota are reported by the health route.
"""

import json
import os
import re
import socket
import threading
import time
import ipaddress
from urllib.parse import urljoin, urlparse

import requests
from flask import Flask, Response, jsonify, request, send_file, send_from_directory

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DIST_DIR = os.path.abspath(os.environ.get("SCHOLARPI_DIST", os.path.join(BASE_DIR, "..", "frontend", "dist")))
DATA_DIR = os.path.join(BASE_DIR, "data")
PAPERS_DIR = os.path.join(DATA_DIR, "demo_papers")
USAGE_FILE = os.path.join(DATA_DIR, "usage.json")

UPSTREAM = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
DEMO_KEY = os.environ.get("DEEPSEEK_API_KEY", "").strip()
DEFAULT_MODEL = os.environ.get("SCHOLARPI_MODEL", "deepseek-flash")

# Free-tier guard rails, only applied when the request is paid for by DEMO_KEY.
LIMIT_PER_MIN = int(os.environ.get("DEMO_LIMIT_PER_MIN", "6"))
LIMIT_PER_HOUR = int(os.environ.get("DEMO_LIMIT_PER_HOUR", "120"))
LIMIT_PER_DAY = int(os.environ.get("DEMO_LIMIT_PER_DAY", "600"))
MAX_PROMPT_CHARS = int(os.environ.get("DEMO_MAX_PROMPT_CHARS", "300000"))

RELAY_TIMEOUT = (10, 40)
RELAY_MAX_BYTES = int(os.environ.get("RELAY_MAX_BYTES", str(8 * 1024 * 1024)))
RELAY_TEXT_TYPES = re.compile(
    r"^(text/|application/(json|xml|xhtml\+xml|atom\+xml|rss\+xml|javascript|x-javascript))", re.I
)
RELAY_PDF_TYPES = re.compile(r"^application/(pdf|octet-stream)", re.I)
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 ScholarPiWeb/0.1"

# The browser sends this placeholder when the visitor has no own key: the
# request is then paid for by DEMO_KEY. It is not a secret and is never used
# upstream.
DEMO_SENTINELS = {"scholarpi-demo", "demo", "placeholder", "none"}

app = Flask(__name__, static_folder=None)

# ---------------------------------------------------------------------------
# demo quota


class Quota:
    """Sliding-window request counter, persisted so a restart does not reset it."""

    def __init__(self, path: str):
        self.path = path
        self.lock = threading.Lock()
        self.events = []  # [(ts, key), ...]
        self.banned = {}  # key -> until ts
        self._dirty_at = 0.0
        self._load()

    def _load(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                raw = json.load(f)
            self.events = [(float(t), str(k)) for t, k in raw.get("events", [])]
            self.banned = {str(k): float(v) for k, v in (raw.get("banned") or {}).items()}
        except Exception:
            pass

    def _flush(self, force=False):
        now = time.time()
        if not force and now - self._dirty_at < 5:
            return
        self._dirty_at = now
        tmp = self.path + ".tmp"
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"events": self.events, "banned": self.banned}, f)
            os.replace(tmp, self.path)
        except Exception:
            pass

    def check(self, key: str):
        """Record an allowed request; return (allowed, retry_after, usage, exhausted_window)."""
        now = time.time()
        with self.lock:
            self.events = [(t, k) for t, k in self.events if now - t < 86400]
            if self.banned.get(key, 0) > now:
                return False, int(self.banned[key] - now), self._usage(key), "已临时限制"
            mine = sorted(t for t, k in self.events if k == key)
            for window, cap, label in ((60, LIMIT_PER_MIN, f"每分钟 {LIMIT_PER_MIN} 次"), (3600, LIMIT_PER_HOUR, f"每小时 {LIMIT_PER_HOUR} 次"), (86400, LIMIT_PER_DAY, f"每天 {LIMIT_PER_DAY} 次")):
                ev = [t for t in mine if now - t < window]
                if len(ev) >= cap:
                    return False, max(1, int(window - (now - ev[0])) + 1), self._usage(key), label
            self.events.append((now, key))
            self._flush()
            return True, 0, self._usage(key), ""

    def peek(self, key: str):
        """Report remaining quota without consuming any."""
        now = time.time()
        with self.lock:
            ev = [t for t, k in self.events if k == key and now - t < 86400]
        return True, 0, self._stats(ev, now)

    def _usage(self, key: str):
        now = time.time()
        with self.lock:
            ev = [t for t, k in self.events if k == key and now - t < 86400]
        return self._stats(ev, now)

    @staticmethod
    def _stats(ev, now):
        used_h = sum(1 for t in ev if now - t < 3600)
        return {
            "usedMinute": sum(1 for t in ev if now - t < 60),
            "usedHour": used_h,
            "usedDay": len(ev),
            "limitMinute": LIMIT_PER_MIN,
            "limitHour": LIMIT_PER_HOUR,
            "limitDay": LIMIT_PER_DAY,
            "remainingHour": max(0, LIMIT_PER_HOUR - used_h),
        }

    def strike(self, key: str, seconds=3600):
        with self.lock:
            self.banned[key] = time.time() + seconds
            self._flush(force=True)


quota = Quota(USAGE_FILE)


def client_key() -> str:
    """IP + per-browser id, so several tabs of one person share one budget."""
    fwd = request.headers.get("X-Forwarded-For", "")
    ip = fwd.split(",")[0].strip() if fwd else (request.remote_addr or "?")
    cid = (request.headers.get("X-Pi-Client") or "")[:40]
    return f"{ip}|{cid}"


# ---------------------------------------------------------------------------
# LLM passthrough


def bearer_token() -> str:
    auth = request.headers.get("Authorization", "").strip()
    return auth[7:].strip() if auth.lower().startswith("bearer ") else ""


def using_demo_key() -> bool:
    """True when the visitor brought no real key (nothing, or the demo placeholder)."""
    token = bearer_token()
    return not token or token.lower() in DEMO_SENTINELS


def _forward_headers():
    h = {"User-Agent": UA, "Accept": request.headers.get("Accept", "application/json")}
    token = bearer_token()
    if token and token.lower() not in DEMO_SENTINELS:
        h["Authorization"] = "Bearer " + token
    elif DEMO_KEY:
        h["Authorization"] = "Bearer " + DEMO_KEY
    ctype = request.headers.get("Content-Type")
    if ctype:
        h["Content-Type"] = ctype
    for name in ("X-Session-Id", "Accept-Language"):
        if request.headers.get(name):
            h[name] = request.headers[name]
    return h


@app.route("/api/llm/<path:subpath>", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"])
def llm_proxy(subpath):
    if request.method == "OPTIONS":
        return _cors(Response(status=204))
    target = f"{UPSTREAM}/{subpath}"
    demo_mode = using_demo_key()
    if demo_mode and not DEMO_KEY:
        return jsonify(error="missing_demo_key", message="后端未配置 DEEPSEEK_API_KEY，请在设置中填入自己的 Key。"), 401
    body = request.get_data()
    if demo_mode and request.method == "POST" and subpath.startswith("chat/"):
        if len(body) > MAX_PROMPT_CHARS * 6:
            quota.strike(client_key(), 600)
            return jsonify(error="payload_too_large", message="单次请求内容过长，请缩小阅读范围。"), 413
        allowed, retry_after, usage, note = quota.check(client_key())
        if not allowed:
            resp = jsonify(
                error="rate_limited",
                message=f"公共演示额度已用完（{note}）。请稍后再试，或在设置中填入自己的 DeepSeek Key 继续不限次使用。",
                retryAfter=retry_after,
                usage=usage,
            )
            resp.headers["Retry-After"] = str(retry_after)
            return _cors(resp), 429

    upstream_resp = _request(target, body, stream=True)
    if isinstance(upstream_resp, Response):  # error response built by _request/_err
        return upstream_resp
    if upstream_resp.status_code in (301, 302, 303, 307, 308):
        loc = upstream_resp.headers.get("Location", "")
        upstream_resp.close()
        return _err("redirect_unsupported", f"上游返回重定向 {loc}，请改为浏览器直连 DeepSeek 或自带 Key。", 502)

    def gen():
        try:
            for chunk in upstream_resp.iter_content(chunk_size=1024):
                if chunk:
                    yield chunk
        finally:
            upstream_resp.close()

    hop = {"content-encoding", "content-length", "transfer-encoding", "connection", "set-cookie"}
    headers = {k: v for k, v in upstream_resp.headers.items() if k.lower() not in hop}
    ctype = upstream_resp.headers.get("Content-Type", "application/json")
    if "text/event-stream" in ctype:
        headers["Cache-Control"] = "no-cache, no-transform"
        headers["X-Accel-Buffering"] = "no"
    return _cors(Response(gen(), status=upstream_resp.status_code, headers=headers, mimetype=ctype))


@app.route("/api/chat/proxy", methods=["POST", "OPTIONS"])
def chat_proxy_alias():
    """Explicit alias for the streaming chat call, as specified in the design."""
    return llm_proxy("chat/completions")


def _err(code: str, message: str, status: int):
    resp = jsonify(error=code, message=message)
    resp.status_code = status
    return _cors(resp)


def _request(url, body=None, stream=False):
    try:
        return requests.request(
            request.method,
            url,
            data=body,
            headers=_forward_headers(),
            stream=stream,
            timeout=(15, 600),
            allow_redirects=False,
        )
    except requests.RequestException as e:
        return _err("upstream_unreachable", f"无法连接 DeepSeek：{e.__class__.__name__}", 502)


# ---------------------------------------------------------------------------
# CORS relay (GET only)


def _assert_public_host(host: str, port: int):
    """Reject loopback / private / link-local / metadata targets (SSRF guard)."""
    try:
        infos = socket.getaddrinfo(host, port or 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        return "无法解析该主机名"
    if not infos:
        return "无法解析该主机名"
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            return "出于安全考虑，不能访问内网或本机地址"
    return None


def _mirror_arxiv_pdf(url: str) -> str:
    """arxiv.org throttles datacenter egress; export.arxiv.org serves the same files fast."""
    try:
        u = urlparse(url)
    except ValueError:
        return url
    if u.hostname in ("arxiv.org", "www.arxiv.org") and re.match(r"^/pdf/", u.path or "", re.I):
        u = u._replace(netloc="export.arxiv.org")
        return u.geturl()
    return url


def _safe_target(raw: str):
    if not raw:
        return None, "缺少 url 参数"
    if raw.startswith("//"):
        raw = "https:" + raw
    try:
        u = urlparse(raw)
    except ValueError:
        return None, "URL 无法解析"
    if u.scheme not in ("http", "https"):
        return None, "只允许 http/https"
    if not u.hostname:
        return None, "URL 缺少主机名"
    blocked = {
        "localhost",
        "metadata.google.internal",
        "metadata",
        "instance-data",
    }
    if u.hostname.lower() in blocked or u.hostname.lower().endswith(".local"):
        return None, "该地址不允许访问"
    err = _assert_public_host(u.hostname, u.port or (443 if u.scheme == "https" else 80))
    if err:
        return None, err
    return u.geturl(), None


# Search engines that only answer POSTs (DuckDuckGo HTML, Tavily). The relay
# stays GET/POST-only, never a general proxy.
RELAY_POST_HOSTS = {"html.duckduckgo.com", "duckduckgo.com", "api.tavily.com"}

# Visitor-supplied search keys (Brave / Tavily) belong to the user and must
# reach their own API, so the relay may carry them — but only these headers to
# only these hosts. The DeepSeek key never travels this way (see llm_proxy).
RELAY_KEY_HOSTS = {
    "api.search.brave.com": {"X-Subscription-Token"},
    "api.tavily.com": {"Authorization"},
}


@app.route("/api/relay", methods=["GET", "POST", "OPTIONS"])
def relay():
    """Fetch a third-party page server-side and hand the body back to the browser.

    GET  /api/relay?url=…[&format=bytes]
    POST /api/relay  {url, method:"GET"|"POST", body, contentType, headers}

    text  -> JSON {ok,status,url,contentType,text}
    bytes -> raw body (used for PDFs)
    """
    if request.method == "OPTIONS":
        return _cors(Response(status=204))
    payload = {}
    if request.method == "GET":
        raw = request.args.get("url", "")
        want_bytes = request.args.get("format") == "bytes"
        rng = request.args.get("range", "")
        method, req_body, req_ctype = "GET", None, ""
    else:
        payload = request.get_json(silent=True) or {}
        raw = payload.get("url", "")
        want_bytes = False
        rng = ""
        method = str(payload.get("method") or "POST").upper()
        req_body = payload.get("body")
        req_ctype = str(payload.get("contentType") or "")
        if method not in ("GET", "POST"):
            return _cors(jsonify(error="blocked", message="只支持 GET/POST")), 400
        if not req_ctype and method == "POST":
            req_ctype = "application/x-www-form-urlencoded"
    target, err = _safe_target(raw)
    if err:
        return _cors(jsonify(error="blocked", message=err)), 400
    try:
        host = urlparse(target).hostname or ""
    except ValueError:
        host = ""
    if method == "POST" and host not in RELAY_POST_HOSTS:
        return _cors(jsonify(error="blocked", message=f"不允许向 {host} 转发 POST 请求")), 403

    headers = {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": request.headers.get("Accept-Language", "en-US,en;q=0.8"),
    }
    if req_ctype:
        headers["Content-Type"] = req_ctype
    if want_bytes and re.match(r"^\d+-\d+$", rng or ""):
        headers["Range"] = f"bytes={rng}"
    allowed = RELAY_KEY_HOSTS.get(host) or set()
    for name, value in (payload.get("headers") or {}).items():
        if isinstance(value, str) and len(value) < 512 and name in allowed:
            headers[name] = value
    if (payload.get("headers") or {}) and not allowed:
        return _cors(jsonify(error="blocked", message=f"不允许向 {host} 转发带密钥的请求")), 403
    url, session, resp = target, requests.Session(), None
    for _ in range(5):
        try:
            call = session.post if method == "POST" else session.get
            resp = call(
                url,
                headers=headers,
                data=(req_body.encode("utf-8") if req_body else None),
                timeout=RELAY_TIMEOUT,
                stream=True,
                allow_redirects=False,
            )
        except requests.RequestException as e:
            return _cors(jsonify(error="fetch_failed", message=f"抓取失败：{e.__class__.__name__}")), 502
        if resp.status_code in (301, 302, 303, 307, 308):
            nxt = resp.headers.get("Location")
            resp.close()
            if not nxt:
                break
            url, err = _safe_target(urljoin(url, nxt))
            if err:
                return _cors(jsonify(error="blocked", message=f"重定向被拒绝：{err}")), 400
            continue
        break

    assert resp is not None
    ctype = resp.headers.get("Content-Type", "")
    if want_bytes:
        if not (RELAY_PDF_TYPES.match(ctype) or "pdf" in url.lower() or url.lower().endswith(".pdf")):
            resp.close()
            return _cors(jsonify(error="not_binary", message=f"目标不是可下载文件（{ctype or '未知类型'}）")), 415
        buf, size = bytearray(), 0
        for chunk in resp.iter_content(chunk_size=65536):
            buf += chunk
            size += len(chunk)
            if size > RELAY_MAX_BYTES:
                resp.close()
                return _cors(jsonify(error="too_large", message="文件超过大小限制")), 413
        resp.close()
        return _cors(
            Response(bytes(buf), status=resp.status_code, mimetype="application/pdf",
                     headers={"Content-Disposition": "inline"}),
        )

    if not RELAY_TEXT_TYPES.match(ctype) and resp.status_code == 200:
        resp.close()
        return _cors(jsonify(error="not_text", message=f"目标不是文本内容（{ctype or '未知类型'}）")), 415

    data, size = b"", 0
    chunks = []
    for chunk in resp.iter_content(chunk_size=65536):
        chunks.append(chunk)
        size += len(chunk)
        if size > RELAY_MAX_BYTES:
            break
    resp.close()
    raw_body = b"".join(chunks)
    charset = resp.encoding or "utf-8"
    try:
        text = raw_body.decode(charset, errors="replace")
    except LookupError:
        text = raw_body.decode("utf-8", errors="replace")
    out = {
        "ok": 200 <= resp.status_code < 300,
        "status": resp.status_code,
        "url": resp.url or url,
        "contentType": ctype,
        "text": text,
        "truncated": size > RELAY_MAX_BYTES,
    }
    return _cors(jsonify(out))


# ---------------------------------------------------------------------------
# MCP bridge (visitor-configured MCP servers)
#
# Same envelope as functions/mcp.ts: the browser posts {endpoint, body, headers}
# and this server performs the JSON-RPC call. The local dev server additionally
# allows a loopback MCP endpoint (the user's own machine, e.g. `npx …` on
# 127.0.0.1:8931); the published Edge Function refuses private addresses.

MCP_ALLOWED_METHODS = {"initialize", "tools/list", "tools/call", "ping", "notifications/initialized"}
MCP_DENY_HEADERS = {
    "host", "content-length", "cookie", "set-cookie", "x-forwarded-for", "x-real-ip",
    "connection", "keep-alive", "upgrade", "te", "trailer", "transfer-encoding",
    "proxy-authorization", "via", "route", "loopback",
}
MCP_MAX_BYTES = 128 * 1024
MCP_MAX_HEADERS = 16


def _safe_mcp_target(raw):
    if not raw:
        return None, "缺少 endpoint"
    if raw.startswith("//"):
        raw = "https:" + raw
    try:
        u = urlparse(raw)
    except ValueError:
        return None, "URL 无法解析"
    if u.scheme not in ("http", "https"):
        return None, "只允许 http/https"
    if not u.hostname:
        return None, "URL 缺少主机名"
    if u.username or u.password:
        return None, "URL 不能包含凭据"
    host = u.hostname.lower()
    if host in {"metadata.google.internal", "metadata", "instance-data"} or host.endswith(".local"):
        return None, "该地址不允许访问"
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return u.geturl(), None
    if ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
        return None, "出于安全考虑，不能访问该地址"
    return u.geturl(), None


def _mcp_headers(raw):
    out = {}
    for name, value in (raw or {}).items():
        if len(out) >= MCP_MAX_HEADERS:
            break
        low = str(name).lower()
        if low in MCP_DENY_HEADERS or not all(0x21 <= ord(c) <= 0x7E for c in low):
            continue
        if isinstance(value, str) and len(value) <= 1024:
            out[name] = value
    return out


@app.route("/api/mcp", methods=["POST", "OPTIONS"])
def mcp_bridge():
    """POST {endpoint, body:JSON-RPC, headers?, protocolVersion?} -> {status, contentType, text}."""
    if request.method == "OPTIONS":
        return _cors(Response(status=204))
    payload = request.get_json(silent=True) or {}
    endpoint = str(payload.get("endpoint") or "").strip()
    body = payload.get("body")
    if not endpoint:
        return _cors(jsonify(error="bad_request", message="缺少 endpoint")), 400
    if not isinstance(body, dict):
        return _cors(jsonify(error="bad_request", message="缺少 JSON-RPC body")), 400
    method = str(body.get("method") or "")
    if method not in MCP_ALLOWED_METHODS:
        return _cors(jsonify(error="bad_request", message=f"不支持的 MCP 方法：{method or '(空)'}")), 400
    target, err = _safe_mcp_target(endpoint)
    if err:
        return _cors(jsonify(error="blocked", message=err)), 400

    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "User-Agent": UA,
        "MCP-Protocol-Version": str(payload.get("protocolVersion") or "2024-11-05"),
    }
    headers.update(_mcp_headers(payload.get("headers")))
    session, url, resp = requests.Session(), target, None
    for _ in range(3):
        try:
            resp = session.post(
                url,
                headers=headers,
                data=json.dumps(body).encode("utf-8"),
                timeout=RELAY_TIMEOUT,
                stream=True,
                allow_redirects=False,
            )
        except requests.RequestException as e:
            return _cors(jsonify(error="fetch_failed", message=f"MCP 调用失败：{e.__class__.__name__}")), 502
        if resp.status_code in (301, 302, 303, 307, 308):
            nxt = resp.headers.get("Location")
            resp.close()
            if not nxt:
                break
            url, err = _safe_mcp_target(urljoin(url, nxt))
            if err:
                return _cors(jsonify(error="blocked", message=f"重定向被拒绝：{err}")), 400
            continue
        break

    assert resp is not None
    ctype = resp.headers.get("Content-Type", "")
    chunks, size = [], 0
    for chunk in resp.iter_content(chunk_size=65536):
        chunks.append(chunk)
        size += len(chunk)
        if size > MCP_MAX_BYTES:
            break
    resp.close()
    if size > MCP_MAX_BYTES:
        return _cors(jsonify(error="too_large", message="MCP 响应超过大小限制")), 413
    out = {
        "ok": 200 <= resp.status_code < 300,
        "status": resp.status_code,
        "contentType": ctype,
        "text": b"".join(chunks).decode("utf-8", errors="replace"),
        "sessionId": resp.headers.get("Mcp-Session-Id", "") or resp.headers.get("mcp-session-id", "") or "",
        "protocolVersion": resp.headers.get("MCP-Protocol-Version", "") or "",
    }
    return _cors(jsonify(out))


@app.route("/api/search/arxiv", methods=["GET"])
def arxiv_proxy():
    """Named arXiv entry point (keeps the browser off export.arxiv.org's missing CORS)."""
    qs = request.query_string.decode("utf-8", "replace")
    target = "https://export.arxiv.org/api/query" + (f"?{qs}" if qs else "")
    return _relay_as_xml(target)


def _relay_as_xml(target):
    try:
        r = requests.get(target, headers={"User-Agent": UA}, timeout=RELAY_TIMEOUT)
    except requests.RequestException as e:
        return _cors(jsonify(error="fetch_failed", message=str(e))), 502
    return _cors(Response(r.content, status=r.status_code, mimetype="application/atom+xml"))


@app.route("/api/web/fetch", methods=["GET"])
def web_fetch():
    """Named page-fetch entry point, same behaviour as /api/relay."""
    return relay()


# ---------------------------------------------------------------------------
# demo papers


def _manifest():
    path = os.path.join(PAPERS_DIR, "manifest.json")
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


_text_cache = {}


@app.route("/api/demo-papers", methods=["GET"])
def demo_papers():
    return _cors(jsonify({"papers": _manifest(), "demoKey": bool(DEMO_KEY)}))


@app.route("/api/demo-papers/<pid>/text", methods=["GET"])
def demo_paper_text(pid):
    entry = next((p for p in _manifest() if p.get("id") == pid), None)
    if not entry:
        return jsonify(error="not_found", message="没有这篇演示论文"), 404
    hit = _text_cache.get(pid)
    if hit:
        return _cors(jsonify(hit))
    path = os.path.join(PAPERS_DIR, entry["textFile"])
    try:
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
    except Exception as e:
        return jsonify(error="not_indexed", message=f"该论文尚未预解析：{e.__class__.__name__}"), 404
    _text_cache[pid] = doc
    return _cors(jsonify(doc))


@app.route("/api/demo-papers/<pid>/pdf", methods=["GET"])
def demo_paper_pdf(pid):
    entry = next((p for p in _manifest() if p.get("id") == pid), None)
    if not entry:
        return jsonify(error="not_found", message="没有这篇演示论文"), 404
    path = os.path.join(PAPERS_DIR, entry["pdfFile"])
    if not os.path.exists(path):
        return jsonify(error="not_found", message="PDF 文件不存在"), 404
    return send_file(path, mimetype="application/pdf", conditional=True, download_name=entry["pdfFile"])


# ---------------------------------------------------------------------------
# status / static


@app.route("/api/health", methods=["GET"])
def health():
    allowed, _, usage = quota.peek(client_key())
    return _cors(
        jsonify(
            ok=True,
            demoKey=bool(DEMO_KEY),
            defaultModel=DEFAULT_MODEL,
            upstream=UPSTREAM,
            relay=True,
            demoPapers=len(_manifest()),
            usage=usage,
            limitNote=f"公共演示额度：每分钟 {LIMIT_PER_MIN} 次 / 每小时 {LIMIT_PER_HOUR} 次 / 每天 {LIMIT_PER_DAY} 次",
        )
    )


def _cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = request.headers.get("Origin", "*") or "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-Pi-Client, X-Session-Id"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
    resp.headers["Access-Control-Max-Age"] = "600"
    resp.headers["Access-Control-Expose-Headers"] = "Content-Type, Retry-After"
    return resp


@app.after_request
def add_cors(resp):
    if request.path.startswith("/api/"):
        return _cors(resp)
    return resp


@app.route("/")
def index():
    return _static("index.html")


@app.route("/<path:filename>")
def _static(filename):
    root = os.path.join(DIST_DIR, filename)
    # Revalidate every load (etag/304): `npm run build` keeps the same asset URLs,
    # so a long max-age would serve a stale bundle to the next person who opens the app.
    if os.path.isfile(root):
        return send_from_directory(DIST_DIR, filename, max_age=0, etag=True)
    if os.path.isfile(os.path.join(DIST_DIR, "index.html")):
        return send_from_directory(DIST_DIR, "index.html", max_age=0)
    return (
        "<h1>ScholarPi Web</h1>"
        "<p>前端尚未构建。请在项目根目录运行 <code>npm install &amp;&amp; npm run build</code> 后刷新。</p>"
        "<p>后端接口：<a href='/api/health'>/api/health</a></p>",
        200,
    )


FUNCTION_PREFIX = "/functions/v1/app"


def _mirror_api_routes():
    """Expose every /api route under the Sites Function path too.

    The published build calls /functions/v1/app/…; mirroring keeps one frontend
    bundle for local development and for Qoder Sites.
    """
    for rule in list(app.url_map.iter_rules()):
        if not rule.rule.startswith("/api/"):
            continue
        app.add_url_rule(
            FUNCTION_PREFIX + rule.rule[len("/api"):],
            endpoint="sites_" + rule.endpoint,
            view_func=app.view_functions[rule.endpoint],
            methods=sorted(rule.methods - {"HEAD", "OPTIONS"}),
        )


_mirror_api_routes()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    if not DEMO_KEY:
        print("[ScholarPi] 警告：未设置 DEEPSEEK_API_KEY —— 演示额度模式不可用，仅支持用户自带 Key。")
    print(f"[ScholarPi] http://127.0.0.1:{port}  (前端目录: {DIST_DIR})")
    app.run(host=os.environ.get("HOST", "127.0.0.1"), port=port, threaded=True, debug=False)
