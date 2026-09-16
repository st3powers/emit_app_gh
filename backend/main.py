# backend/main.py
import sys
from pathlib import Path

# Make `import emit_utils` work no matter where uvicorn is launched from.
BASE_DIR = Path(__file__).resolve().parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import earthaccess

import emit_utils

FRONTEND_DIR = BASE_DIR.parent / "frontend"

app = FastAPI(title="EMIT scene browser")
app.add_middleware(CORSMiddleware, allow_origins=["*"],
                   allow_methods=["*"], allow_headers=["*"])

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
                  date_start: str = "2023-01-01", date_end: str = "2024-12-31"):
    ensure_login()
    results = earthaccess.search_data(
        short_name="EMITL2ARFL",           # L2A surface reflectance
        bounding_box=(west, south, east, north),
        temporal=(date_start, date_end),
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
        png_path, bounds = emit_utils.make_rgb_overlay(nc_path, granule_id)
    except (KeyError, OSError) as exc:
        raise HTTPException(status_code=500,
                            detail=f"Could not build overlay: {exc}")
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


# Mounted with absolute directories, and after the API routes so /api/* wins.
app.mount("/overlays", StaticFiles(directory=str(emit_utils.OVERLAY_DIR)),
          name="overlays")
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True),
          name="frontend")
