"""Shared client for SGU's *OGC API — Features* endpoints (PLAN.md §2.3, §2.4).

Two SGU products feed this pipeline and both are served by the same software with
the same quirks, so the transport lives here once:

  * `strandforskjutningsmodell` — the century shoreline table (`shoreline.py`, §6)
  * `jordarter25k-100k`         — the soil polygons (`fetch_soils.py`, §9/§10)

Both are open (CC0) and anonymous. What this module wraps:

  * **retries** on transport errors and HTTP 429, honouring `Retry-After`;
  * **pagination** — the API caps a page at `PAGE_LIMIT` features and advertises
    the next one as a `rel="next"` link, so a full extract is a link walk.

Nothing here knows about a collection's schema; the callers do.
"""

from __future__ import annotations

import time

import requests

from .fetch_dem import DEFAULT_BACKOFF, MAX_RETRIES, USER_AGENT, FetchError

# One page of features. The API caps its own page size below this on some
# collections, which is exactly why the caller walks `rel="next"` instead of
# trusting one request.
PAGE_LIMIT = 1000
MAX_PAGES = 50


def retry_delay(response: requests.Response, attempt: int) -> float:
    header = response.headers.get("Retry-After", "")
    try:
        return max(1.0, float(header))
    except ValueError:
        return DEFAULT_BACKOFF * attempt


def get_json(url: str) -> dict:
    """GET one OGC API page. Retries on transport errors and HTTP 429."""
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=120)
        except requests.RequestException as exc:
            if attempt == MAX_RETRIES:
                raise FetchError(f"SGU request failed after {attempt} attempts: {exc}") from exc
            time.sleep(DEFAULT_BACKOFF * attempt)
            continue
        if response.status_code == 429:
            if attempt == MAX_RETRIES:
                raise FetchError(f"SGU rate-limited (429) after {attempt} attempts: {url}")
            delay = retry_delay(response, attempt)
            print(f"  SGU 429, retrying in {delay:.0f}s ({attempt}/{MAX_RETRIES})")
            time.sleep(delay)
            continue
        if response.status_code >= 400:
            raise FetchError(
                f"SGU HTTP {response.status_code} for {url}: {response.text[:300]}"
            )
        return response.json()
    raise FetchError(f"SGU request exhausted retries: {url}")


def page_features(url: str, label: str, max_pages: int = MAX_PAGES) -> dict:
    """Walk `rel="next"` from `url` and return one merged FeatureCollection.

    `label` only names the collection in the error message raised when the walk
    does not terminate — a runaway link cycle must fail loudly rather than spin.
    """
    features: list[dict] = []
    for _page in range(max_pages):
        payload = get_json(url)
        features.extend(payload.get("features", []))
        nxt = [
            link.get("href")
            for link in payload.get("links", [])
            if link.get("rel") == "next" and link.get("href")
        ]
        if not nxt:
            return {"type": "FeatureCollection", "features": features}
        url = nxt[0]
    raise FetchError(f"SGU collection {label!r} did not paginate to an end in {max_pages} pages")
