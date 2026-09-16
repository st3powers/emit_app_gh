# backend/emit_utils.py
import json
import shutil
from collections import OrderedDict

import numpy as np
import netCDF4 as nc
import h5py
import earthaccess
from PIL import Image
from pathlib import Path

# Only the _RFL_ file is ever downloaded (see download_granule); the largest
# one observed so far is ~3.6 GB, so keep some headroom above that.
BUNDLE_BYTES = 4 * 1024 ** 3

# Anchored to this file, not the working directory, so the server can be
# started from anywhere.
BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"; DATA_DIR.mkdir(exist_ok=True)
OVERLAY_DIR = BASE_DIR / "overlays"; OVERLAY_DIR.mkdir(exist_ok=True)


def _is_reflectance(name: str) -> bool:
    """True for the RFL file only.

    An EMITL2ARFL granule bundles three files that all start with the same
    prefix: ..._RFL_..., ..._RFLUNCERT_... and ..._MASK_.... Matching on the
    substring "RFL" would also accept RFLUNCERT, which has no `reflectance`
    variable, so match the delimited token instead.
    """
    return "_RFL_" in name and name.endswith(".nc")


def _looks_complete(path: Path) -> bool:
    """True if `path` is a readable netCDF holding the reflectance variable.

    A download killed partway through -- a full disk is the usual cause --
    leaves a truncated .nc on disk. HDF5 records the expected end-of-file in
    the superblock, so opening a stub fails instead of silently returning
    garbage. Without this check a truncated file is treated as a cache hit
    forever: the granule can never load and never re-downloads.
    """
    try:
        ds = nc.Dataset(path)
    except OSError:
        return False
    try:
        return "reflectance" in ds.variables
    finally:
        ds.close()


def granule_path(granule_id: str) -> Path:
    """Locate the already-downloaded reflectance file for a granule."""
    exact = DATA_DIR / f"{granule_id}.nc"
    if exact.exists():
        return exact
    for cand in sorted(DATA_DIR.glob(f"*{granule_id}*.nc")):
        if _is_reflectance(cand.name):
            return cand
    raise FileNotFoundError(
        f"No reflectance file for {granule_id} under {DATA_DIR}; "
        "load the scene before requesting a spectrum."
    )


def download_granule(granule_id: str) -> Path:
    for p in sorted(DATA_DIR.glob(f"*{granule_id}*.nc")):
        if not _is_reflectance(p.name):
            continue
        if _looks_complete(p):
            return p
        # Truncated leftover from an interrupted download: drop it so the
        # granule can be fetched again rather than failing forever.
        p.unlink()

    free = shutil.disk_usage(str(DATA_DIR)).free
    if free < BUNDLE_BYTES:
        raise OSError(
            f"Only {free / 1024 ** 3:.1f} GB free where granules are cached, "
            f"but an EMIT bundle needs about {BUNDLE_BYTES / 1024 ** 3:.0f} GB. "
            f"Free up space or delete old granules from {DATA_DIR}."
        )

    results = earthaccess.search_data(short_name="EMITL2ARFL",
                                      granule_ur=granule_id)
    if not results:
        raise FileNotFoundError(f"CMR has no EMITL2ARFL granule {granule_id}")

    # The granule bundles three files (RFL + RFLUNCERT + MASK) but only RFL
    # is ever read, so fetch just that link instead of the whole ~3.6 GB set.
    rfl_urls = [u for u in results[0].data_links()
                if _is_reflectance(Path(u).name)]
    if not rfl_urls:
        raise FileNotFoundError(f"No _RFL_ download link for {granule_id}")

    files = earthaccess.download(rfl_urls, str(DATA_DIR))
    rfl = [f for f in files if _is_reflectance(Path(f).name)]
    if not rfl:
        raise FileNotFoundError(
            f"Download of {granule_id} produced no _RFL_ file (got: "
            f"{[Path(f).name for f in files]})"
        )

    out = Path(rfl[0])
    if not _looks_complete(out):
        # earthaccess logs the write failure but still returns the path, so
        # the partial file has to be caught and cleared here.
        size_gb = out.stat().st_size / 1024 ** 3 if out.exists() else 0.0
        out.unlink(missing_ok=True)
        raise OSError(
            f"Download of {granule_id} was incomplete (stopped at "
            f"{size_gb:.2f} GB, most likely out of disk space). The partial "
            "file has been removed; free up space and try again."
        )
    return out


def _open(nc_path: Path) -> nc.Dataset:
    """Open a granule with auto-masking off.

    netCDF4 masks _FillValue (-9999) into a MaskedArray by default. The code
    below filters fill values explicitly with plain comparisons, and a masked
    scalar compares as `masked` (falsy) rather than False, which silently
    defeats those guards. Reading raw values keeps the comparisons honest.
    """
    ds = nc.Dataset(nc_path)
    ds.set_auto_mask(False)
    return ds


def _read_glt(ds):
    loc = ds.groups["location"]
    glt_x = loc.variables["glt_x"][:]   # (rows, cols) → swath column index (1-based, 0 = nodata)
    glt_y = loc.variables["glt_y"][:]
    gt = ds.geotransform                # [ulx, xres, 0, uly, 0, yres]
    return glt_x, glt_y, gt


def make_rgb_overlay(nc_path: Path, granule_id: str):
    ds = _open(nc_path)
    try:
        refl = ds.variables["reflectance"]          # (downtrack, crosstrack, bands)
        wl = ds.groups["sensor_band_parameters"].variables["wavelengths"][:]

        # pick bands nearest to ~650/560/470 nm
        rgb_idx = [int(np.argmin(np.abs(wl - t))) for t in (650, 560, 470)]
        # reflectance is stored contiguous/uncompressed with bands as the
        # fastest-varying dimension per pixel, so `refl[:, :, i]` for a single
        # band strides across the whole extent -- reading 3 bands that way is
        # 3 full passes over the file. A single fancy-indexed read (one
        # hyperslab selection covering all 3 bands) is one pass instead of
        # three, WITHOUT `refl[:]`'s ~1.8 GB full-array read -- that blew past
        # the memory limit on a small cloud instance (observed as repeated
        # OOM kills in production; fine on a dev machine with RAM to spare).
        swath_rgb = refl[:, :, rgb_idx]

        glt_x, glt_y, gt = _read_glt(ds)
        # both indices must be set; 0 marks nodata in either plane
        valid = (glt_x > 0) & (glt_y > 0)
        out = np.zeros((*glt_x.shape, 4), dtype=np.uint8)

        # 2% linear stretch per band
        stretched = np.zeros_like(swath_rgb)
        for b in range(3):
            band = swath_rgb[..., b]
            real = band[band > -9990]
            if real.size == 0:
                continue
            lo, hi = np.nanpercentile(real, (2, 98))
            if hi <= lo:                            # flat band: avoid /0
                continue
            stretched[..., b] = np.clip((band - lo) / (hi - lo), 0, 1)

        out[valid, :3] = (stretched[glt_y[valid] - 1, glt_x[valid] - 1] * 255).astype(np.uint8)
        out[valid, 3] = 255  # alpha: transparent outside swath

        png_path = OVERLAY_DIR / f"{granule_id}.png"
        Image.fromarray(out).save(png_path)

        ulx, xres, _, uly, _, yres = gt
        rows, cols = glt_x.shape
        bounds = [[uly + rows * yres, ulx], [uly, ulx + cols * xres]]  # [[S, W], [N, E]]
        return png_path, bounds
    finally:
        ds.close()


def _bounds_path(granule_id: str) -> Path:
    return OVERLAY_DIR / f"{granule_id}.bounds.json"


def get_or_make_rgb_overlay(nc_path: Path, granule_id: str):
    """Cached wrapper around make_rgb_overlay.

    Building the overlay means a full pass over the ~1.8 GB reflectance
    array (see make_rgb_overlay), so re-selecting an already-loaded scene
    should reuse the PNG rather than paying that cost again. Bounds are
    cheap to recompute but are cached alongside the PNG anyway so a cache
    hit needs no netCDF access at all.
    """
    png_path = OVERLAY_DIR / f"{granule_id}.png"
    bounds_path = _bounds_path(granule_id)
    if png_path.exists() and bounds_path.exists():
        return png_path, json.loads(bounds_path.read_text())

    png_path, bounds = make_rgb_overlay(nc_path, granule_id)
    bounds_path.write_text(json.dumps(bounds))
    return png_path, bounds


def extract_spectrum(nc_path: Path, lat: float, lon: float):
    ds = _open(nc_path)
    try:
        glt_x, glt_y, gt = _read_glt(ds)
        ulx, xres, _, uly, _, yres = gt

        col = int((lon - ulx) / xres)
        row = int((lat - uly) / yres)
        if not (0 <= row < glt_x.shape[0] and 0 <= col < glt_x.shape[1]):
            return None, None
        if glt_x[row, col] <= 0 or glt_y[row, col] <= 0:
            return None, None

        sx, sy = glt_x[row, col] - 1, glt_y[row, col] - 1
        spectrum = ds.variables["reflectance"][sy, sx, :].astype(float)
        wl = ds.groups["sensor_band_parameters"].variables["wavelengths"][:].astype(float)

        # mask deep water-vapor absorption bands (flagged as -0.01) and fill values
        spectrum[spectrum <= -0.005] = np.nan
        return wl.tolist(), [None if np.isnan(v) else round(float(v), 5) for v in spectrum]
    finally:
        ds.close()


# Open remote (un-downloaded) granule handles, keyed by granule id. Each is
# an h5py.File over an earthaccess-authenticated HTTP file object: h5py
# issues byte-range GETs for just the metadata/data it actually touches,
# rather than reading the ~1.8 GB file start-to-finish. Kept open for the
# process lifetime (bounded below) since re-opening pays a ~1-2s HDF5
# object-header parse cost that a cache hit skips entirely.
_REMOTE_CACHE_MAX = 8
_remote_handles: "OrderedDict[str, h5py.File]" = OrderedDict()
# Wavelengths don't vary click to click, but re-reading them was costing
# almost as much as the pixel read itself (~1s) on every single request.
_remote_wavelengths: dict = {}


def _open_remote(granule_id: str) -> h5py.File:
    if granule_id in _remote_handles:
        _remote_handles.move_to_end(granule_id)
        return _remote_handles[granule_id]

    results = earthaccess.search_data(short_name="EMITL2ARFL", granule_ur=granule_id)
    if not results:
        raise FileNotFoundError(f"CMR has no EMITL2ARFL granule {granule_id}")
    files = earthaccess.open(results)
    rfl = [f for f in files if _is_reflectance(Path(f.path).name)]
    if not rfl:
        raise FileNotFoundError(f"No _RFL_ file to stream for {granule_id}")

    ds = h5py.File(rfl[0], "r")
    if len(_remote_handles) >= _REMOTE_CACHE_MAX:
        oldest_id, oldest = _remote_handles.popitem(last=False)
        oldest.close()
        _remote_wavelengths.pop(oldest_id, None)
    _remote_handles[granule_id] = ds
    return ds


def extract_spectrum_remote(granule_id: str, lat: float, lon: float):
    """Same result as extract_spectrum, but over HTTP range requests instead
    of a local download -- the fast path while the full granule is still
    downloading in the background. Cheap because a single pixel's full
    285-band spectrum is one small contiguous read (reflectance is stored
    band-interleaved-by-pixel): unlike the RGB overlay, which needs bands
    subset across every pixel, a single-pixel spectrum only ever touches its
    own ~1 KB, plus a couple of small metadata/GLT reads.
    """
    ds = _open_remote(granule_id)
    ulx, xres, _, uly, _, yres = ds.attrs["geotransform"]

    col = int((lon - ulx) / xres)
    row = int((lat - uly) / yres)
    glt_x_ds = ds["location"]["glt_x"]
    glt_y_ds = ds["location"]["glt_y"]
    if not (0 <= row < glt_x_ds.shape[0] and 0 <= col < glt_x_ds.shape[1]):
        return None, None
    gx, gy = int(glt_x_ds[row, col]), int(glt_y_ds[row, col])
    if gx <= 0 or gy <= 0:
        return None, None

    spectrum = ds["reflectance"][gy - 1, gx - 1, :].astype(float)
    if granule_id not in _remote_wavelengths:
        _remote_wavelengths[granule_id] = ds["sensor_band_parameters"]["wavelengths"][:].astype(float)
    wl = _remote_wavelengths[granule_id]

    spectrum[spectrum <= -0.005] = np.nan
    return wl.tolist(), [None if np.isnan(v) else round(float(v), 5) for v in spectrum]
