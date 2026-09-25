# backend/main.py
import sys
from pathlib import Path

# Make `import emit_utils` work no matter where uvicorn is launched from.
BASE_DIR = Path(__file__).resolve().parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import earthaccess

import emit_utils

FRONTEND_DIR = BASE_DIR.parent / "frontend"

app = FastAPI(title="EMIT scene browser")
app.add_middleware(CORSMiddleware, allow_origins=["*"],
                   allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def no_browser_cache(request, call_next):
    """Disable browser caching for everything this dev server serves.

    StaticFiles sends no Cache-Control header, so browsers apply heuristic
    freshness to app.js/index.html and can serve a stale copy on a normal
    navigation without even revalidating against Last-Modified -- confusing
    during active frontend development.
    """
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    return response

_auth = None


def ensure_login():
    """Authenticate to Earthdata once, on first use.

    Logging in at import time took the server down when credentials were
    missing, and earthaccess' default "all" strategy ends in an interactive
    password prompt -- which, with no console attached to a uvicorn worker,
    hangs startup instead of failing. Only the non-interactive strategies are
    tried here: EARTHDATA_USERNAME/EARTHDATA_PASSWORD, then ~/.netrc.
    """
    global _auth
    if _auth is not None and _auth.authenticated:
        return _auth
    for strategy in ("environment", "netrc"):
        try:
            auth = earthaccess.login(strategy=strategy)
        except Exception:
            continue
        if auth is not None and auth.authenticated:
            _auth = auth
            return _auth
    raise HTTPException(
        status_code=503,
        detail="Not authenticated to Earthdata. Set EARTHDATA_USERNAME and "
               "EARTHDATA_PASSWORD, or create a .netrc file in your home "
               "directory, then restart. See README.md.",
    )


def _footprint(umm):
    """Scene outline as [[lat, lon], ...], or None if CMR gave no geometry."""
    geom = umm["SpatialExtent"]["HorizontalSpatialDomain"]["Geometry"]
    polygons = geom.get("GPolygons")
    if polygons:
        pts = polygons[0]["Boundary"]["Points"]
        return [[p["Latitude"], p["Longitude"]] for p in pts]
    rects = geom.get("BoundingRectangles")
    if rects:
        r = rects[0]
        s, n = r["SouthBoundingCoordinate"], r["NorthBoundingCoordinate"]
        w, e = r["WestBoundingCoordinate"], r["EastBoundingCoordinate"]
        return [[s, w], [s, e], [n, e], [n, w]]
    return None


def _bbox(footprint):
    """Axis-aligned [[south, west], [north, east]] enclosing `footprint`."""
    lats = [p[0] for p in footprint]
    lons = [p[1] for p in footprint]
    return [[min(lats), min(lons)], [max(lats), max(lons)]]


@app.get("/api/health")
def health():
    """Confirm the server is up, and report whether Earthdata auth works."""
    try:
        ensure_login()
    except HTTPException as exc:
        return {"server": "ok", "earthdata": "unauthenticated",
                "detail": exc.detail}
    return {"server": "ok", "earthdata": "authenticated"}


@app.get("/api/search")
def search_scenes(west: float, south: float, east: float, north: float,
                  # EMIT launched mid-2022; no end date means CMR searches
                  # through "now", so new granules (2025, 2026, ...) show up
                  # without this default ever needing to be bumped.
                  date_start: str = "2022-01-01", date_end: Optional[str] = None,
                  cloud_cover_max: float = 25):
    ensure_login()
    results = earthaccess.search_data(
        short_name="EMITL2ARFL",           # L2A surface reflectance
        bounding_box=(west, south, east, north),
        temporal=(date_start, date_end),
        cloud_cover=(0, cloud_cover_max),
        # Most-recent-first, so the count=50 cap keeps the newest scenes for
        # AOIs with more matches than that -- otherwise it silently keeps
        # only the *oldest* ones (CMR's default), which is why this used to
        # look like results were "limited to 2023/2024".
        sort_key="-start_date",
        count=50,
    )
    scenes = []
    for g in results:
        umm = g["umm"]
        # one malformed granule shouldn't take down the whole search
        try:
            footprint = _footprint(umm)
            if footprint is None:
                continue
            scenes.append({
                "id": umm["GranuleUR"],
                "time": umm["TemporalExtent"]["RangeDateTime"]["BeginningDateTime"],
                "footprint": footprint,
                "browse_url": emit_utils.browse_url(umm),
                "browse_bounds": _bbox(footprint),
                "cloud_cover": umm.get("CloudCover"),
            })
        except (KeyError, IndexError, TypeError):
            continue
    return {"scenes": scenes}


@app.get("/api/load/{granule_id}")
def load_scene(granule_id: str):
    """Download granule (if needed) and build an orthorectified RGB browse image."""
    ensure_login()
    try:
        nc_path = emit_utils.download_granule(granule_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except OSError as exc:
        # out of disk space, or a partial download that was just cleared
        raise HTTPException(status_code=507, detail=str(exc))

    try:
        png_path, bounds = emit_utils.get_or_make_rgb_overlay(nc_path, granule_id)
    except (KeyError, OSError) as exc:
        raise HTTPException(status_code=500,
                            detail=f"Could not build overlay: {exc}")
    return {"overlay_url": f"/overlays/{png_path.name}", "bounds": bounds}


@app.get("/api/preview/{granule_id}")
def preview_scene(granule_id: str):
    """The scene's quicklook, orthorectified onto the map -- no granule download.

    CMR's browse PNG is the raw swath; this warps it through the granule's GLT
    (read remotely) so it can sit on the map as a preview until /api/load's
    real overlay replaces it. Seconds rather than minutes; cached after that.
    """
    ensure_login()
    try:
        png_path, bounds = emit_utils.get_or_make_preview_overlay(granule_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except (KeyError, OSError) as exc:
        # OSError covers network failures (requests' errors subclass it) and
        # an undecodable PNG as well as remote HDF5 read errors.
        raise HTTPException(status_code=502,
                            detail=f"Could not build map preview: {exc}")
    return {"overlay_url": f"/overlays/{png_path.name}", "bounds": bounds}


@app.get("/api/spectrum")
def get_spectrum(granule_id: str, lat: float, lon: float):
    try:
        nc_path = emit_utils.granule_path(granule_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    try:
        wavelengths, reflectance = emit_utils.extract_spectrum(nc_path, lat, lon)
    except (KeyError, OSError) as exc:
        # e.g. the cached granule is truncated; reload the scene to refetch it
        raise HTTPException(
            status_code=500,
            detail=f"Could not read {nc_path.name} ({exc}). Reload the scene.")
    if wavelengths is None:
        return {"error": "Point outside scene"}
    return {"wavelengths": wavelengths, "reflectance": reflectance}


@app.get("/api/spectrum_remote")
def get_spectrum_remote(granule_id: str, lat: float, lon: float):
    """Like /api/spectrum, but streams one pixel over HTTP range requests
    instead of requiring download_granule() to have finished first -- the
    fast path the UI uses while the full-resolution raster is still loading
    in the background (~1-2s per click once the granule's remote handle is
    warm, vs. however long the full download takes).
    """
    ensure_login()
    try:
        wavelengths, reflectance = emit_utils.extract_spectrum_remote(granule_id, lat, lon)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except OSError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Remote read failed ({exc}). Waiting on the full-resolution download instead.")
    if wavelengths is None:
        return {"error": "Point outside scene"}
    return {"wavelengths": wavelengths, "reflectance": reflectance}


# Mounted with absolute directories, and after the API routes so /api/* wins.
app.mount("/overlays", StaticFiles(directory=str(emit_utils.OVERLAY_DIR)),
          name="overlays")
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True),
          name="frontend")
