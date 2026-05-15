from __future__ import annotations

import re
from typing import Any, Optional

import httpx

from app.config import get_settings


TRIAL_LOOKUP_URL = "https://api.upcitemdb.com/prod/trial/lookup"
PAID_LOOKUP_URL = "https://api.upcitemdb.com/prod/v1/lookup"


def _digits_only(s: str) -> str:
    return re.sub(r"\D+", "", s or "")


def _upca_check_digit_ok(upc12: str) -> bool:
    # UPC-A 12 digits: last digit is check digit
    if not re.fullmatch(r"\d{12}", upc12 or ""):
        return False
    digits = [int(c) for c in upc12]
    odd_sum = sum(digits[0:11:2])
    even_sum = sum(digits[1:11:2])
    total = (odd_sum * 3) + even_sum
    check = (10 - (total % 10)) % 10
    return check == digits[11]


def _ean13_check_digit_ok(ean13: str) -> bool:
    if not re.fullmatch(r"\d{13}", ean13 or ""):
        return False
    digits = [int(c) for c in ean13]
    s = 0
    for i in range(12):
        s += digits[i] * (1 if i % 2 == 0 else 3)
    check = (10 - (s % 10)) % 10
    return check == digits[12]


def extract_barcode_candidates(ocr_snippets: list[str]) -> list[str]:
    """
    Return likely UPC/EAN candidates (best-effort).
    Accepts:
    - UPC-A (12 digits)
    - EAN-13 (13 digits)
    - EAN-8 (8 digits) is intentionally ignored (high false positive rate for our OCR).
    """
    out: list[str] = []
    seen: set[str] = set()
    for raw in ocr_snippets or []:
        s = str(raw or "")
        # Capture digit runs even if spaced/hyphenated.
        for m in re.finditer(r"(?:\d[\s\-]{0,2}){11,13}", s):
            cand = _digits_only(m.group(0))
            if len(cand) == 12 and _upca_check_digit_ok(cand):
                if cand not in seen:
                    out.append(cand)
                    seen.add(cand)
            elif len(cand) == 13 and _ean13_check_digit_ok(cand):
                if cand not in seen:
                    out.append(cand)
                    seen.add(cand)
    return out


async def lookup_upcitemdb(upc_or_ean: str) -> Optional[dict[str, Any]]:
    """
    Lookup a UPC/EAN in UPCitemdb.
    - Uses paid endpoint if UP CITEMDB_USER_KEY is set.
    - Otherwise falls back to the trial endpoint (no key; rate limited).
    Returns a minimal normalized dict or None.
    """
    code = (upc_or_ean or "").strip()
    if not re.fullmatch(r"\d{12,13}", code):
        return None

    settings = get_settings()
    user_key = (getattr(settings, "upcitemdb_user_key", "") or "").strip()
    key_type = (getattr(settings, "upcitemdb_key_type", "") or "").strip() or "user_key"
    url = PAID_LOOKUP_URL if user_key else TRIAL_LOOKUP_URL
    headers = {"Accept": "application/json"}
    if user_key:
        headers.update({"user_key": user_key, "key_type": key_type})

    params = {"upc": code}
    try:
        async with httpx.AsyncClient(timeout=6.5) as client:
            r = await client.get(url, params=params, headers=headers)
            if r.status_code != 200:
                return None
            data = r.json()
    except Exception:
        return None

    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list) or not items:
        return None
    it = items[0] if isinstance(items[0], dict) else None
    if not it:
        return None

    title = str(it.get("title") or "").strip() or None
    brand = str(it.get("brand") or "").strip() or None
    model = str(it.get("model") or "").strip() or None
    images = it.get("images") if isinstance(it.get("images"), list) else []
    image_url = str(images[0]).strip() if images and str(images[0]).strip() else None

    # Some items also provide an "offers" array with price, but we do not depend on it.
    return {
        "code": code,
        "title": title,
        "brand": brand,
        "model": model,
        "image_url": image_url,
        "source": "upcitemdb",
    }

