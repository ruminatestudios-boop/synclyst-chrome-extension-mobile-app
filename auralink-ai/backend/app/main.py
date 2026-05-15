"""
SyncLyst - FastAPI backend.
API-first, headless product onboarding from images.
"""
import collections
import time
from contextlib import asynccontextmanager
from typing import DefaultDict

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse

from app.config import get_settings
from app.routes import vision, products, audit, shopify, feedback, ucp, integrations, usage, billing


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    # Shutdown: close pools, etc. if needed


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title=settings.app_name,
        description="Multimodal product onboarding: image → structured data → omnichannel sync",
        version="0.1.0",
        lifespan=lifespan,
    )
    # Browsers forbid Access-Control-Allow-Origin: * together with credentials.
    # We keep credentials for explicit origin lists; with wildcard, use credentials=False
    # (Bearer tokens in Authorization still work).
    _cors_origins = settings.get_cors_origins_list()
    _cors_credentials = False if _cors_origins == ["*"] else True
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins,
        allow_credentials=_cors_credentials,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # In-memory IP rate limiter for /api/v1/vision/* — 30 requests per minute per IP.
    _VISION_RATE_LIMIT = 30
    _VISION_WINDOW_SECS = 60
    _vision_ip_timestamps: DefaultDict[str, collections.deque] = collections.defaultdict(collections.deque)

    @app.middleware("http")
    async def vision_rate_limit_middleware(request: Request, call_next):
        if request.url.path.startswith("/api/v1/vision/"):
            client_ip = (
                request.headers.get("x-forwarded-for", "").split(",")[0].strip()
                or request.headers.get("x-real-ip", "")
                or (request.client.host if request.client else "unknown")
            )
            now = time.monotonic()
            bucket = _vision_ip_timestamps[client_ip]
            # Remove timestamps older than the window
            while bucket and now - bucket[0] > _VISION_WINDOW_SECS:
                bucket.popleft()
            if len(bucket) >= _VISION_RATE_LIMIT:
                return JSONResponse(
                    status_code=429,
                    content={"error": "Too many requests. Slow down and try again in a minute."},
                )
            bucket.append(now)
        return await call_next(request)

    @app.exception_handler(Exception)
    async def global_exception_handler(request: Request, exc: Exception):
        """Return 500 with a clear message instead of unhandled exception."""
        from fastapi import HTTPException
        if isinstance(exc, HTTPException):
            return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
        detail = str(exc) if str(exc) else "Internal server error"
        return JSONResponse(status_code=500, content={"detail": detail})

    app.include_router(vision.router, prefix="/api/v1/vision", tags=["Vision"])
    app.include_router(products.router, prefix="/api/v1/products", tags=["Products"])
    app.include_router(shopify.router, prefix="/api/v1/shopify", tags=["Shopify"])
    app.include_router(feedback.router, prefix="/api/v1/feedback", tags=["Feedback"])
    app.include_router(audit.router, prefix="/api/v1/audit", tags=["Audit"])
    app.include_router(integrations.router, prefix="/api/v1/integrations", tags=["Integrations"])
    app.include_router(ucp.router, prefix="/.well-known/ucp", tags=["UCP", "GEO"])
    app.include_router(usage.router, prefix="/api/v1/usage", tags=["Usage"])
    app.include_router(billing.router, prefix="/api/v1/billing", tags=["Billing"])
    return app


app = create_app()


_DEV_HUB_HTML = """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>SyncLyst API (local)</title>
<style>
body{font-family:system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1rem;background:#0c0c0e;color:#e4e4e7}
h1{font-size:1.25rem;font-weight:600}
p,li{color:#a1a1aa;font-size:.9rem;line-height:1.5}
.ok{color:#4ade80}.bad{color:#f87171}.box{border:1px solid #27272a;border-radius:12px;padding:1rem 1.1rem;margin:1rem 0;background:#18181b}
a.btn{display:inline-block;margin:.35rem .5rem .35rem 0;padding:.55rem 1rem;border-radius:10px;background:#fafafa;color:#0a0a0a;font-weight:600;text-decoration:none}
a.sec{color:#a78bfa}
code{font-size:.8rem;background:#27272a;padding:.15rem .4rem;border-radius:6px}
</style></head><body>
<h1>SyncLyst backend is running</h1>
<p>This is the <strong>API</strong> on port <code>8000</code>. The web app runs on port <code>3000</code>.</p>
<div class="box"><strong>API health:</strong> <span id="h">…</span></div>
<p><a class="btn" href="http://localhost:3000">Open the app (localhost:3000)</a>
<a class="btn sec" href="/docs">OpenAPI docs</a></p>
<p><strong>Typical local stack</strong> (from repo root):</p>
<pre style="background:#18181b;padding:1rem;border-radius:10px;overflow:auto;font-size:.75rem">npm run dev:all</pre>
<ul>
<li>Frontend: <code>http://localhost:3000</code></li>
<li>This API: <code>http://localhost:8000</code></li>
<li>Publishing: <code>http://localhost:8001</code></li>
</ul>
<script>
fetch('/health').then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});}).then(function(x){
  var el=document.getElementById('h');
  if(x.ok&&x.j&&x.j.status==='ok'){el.innerHTML='<span class="ok">● Connected</span> '+JSON.stringify(x.j);}
  else{el.innerHTML='<span class="bad">● Not ok</span>';}
}).catch(function(){document.getElementById('h').innerHTML='<span class="bad">● Cannot read /health</span>';});
</script>
</body></html>"""


@app.get("/")
def root(request: Request):
    """Browsers get a small hub page; non-HTML clients (e.g. curl) get JSON."""
    accept = request.headers.get("accept") or ""
    if "text/html" in accept:
        return HTMLResponse(content=_DEV_HUB_HTML)
    return {
        "service": "synclyst",
        "message": "API is running. Open in a browser for links, or use /health and /docs.",
        "health": "/health",
        "openapi_docs": "/docs",
        "frontend_dev": "http://localhost:3000",
    }


@app.get("/health")
def health():
    from app.config import get_settings
    s = get_settings()
    shopify_configured = bool(s.shopify_client_id and s.shopify_client_secret)
    return {
        "status": "ok",
        "service": "synclyst",
        "shopify_configured": shopify_configured,
    }
