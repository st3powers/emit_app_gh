# EMIT scene browser

Search NASA EMIT L2A surface-reflectance granules on a map, load a scene as an
orthorectified RGB overlay, and click any pixel to plot its spectrum.

- `backend/` — FastAPI server (`main.py`) + granule/raster helpers (`emit_utils.py`)
- `frontend/` — Leaflet map + Plotly spectrum chart, served by the backend
- `backend/data/` — downloaded granules (gitignored, gets large)
- `backend/overlays/` — generated browse PNGs (gitignored)

## Setup (Windows)

The `venv` in this folder is already provisioned against Python 3.9.10. To
rebuild it from scratch:

```bat
python -m venv venv
venv\Scripts\python.exe -m pip install -r requirements.txt
```

## Earthdata credentials

Everything except `/api/health` needs a free
[NASA Earthdata Login](https://urs.earthdata.nasa.gov/users/new). The server
never prompts interactively — it reads credentials from one of two places:

**Option A — environment variables** (per-shell, nothing written to disk):

```powershell
$env:EARTHDATA_USERNAME = "your_username"
$env:EARTHDATA_PASSWORD = "your_password"
.\run.bat
```

**Option B — `.netrc` file** (persistent). Create `C:\Users\<you>\.netrc`
containing:

```
machine urs.earthdata.nasa.gov
    login your_username
    password your_password
```

It must be `.netrc` with a leading dot, **not** the `_netrc` spelling curl uses
on Windows: earthaccess reads it through `tinynetrc`, which hardcodes
`~/.netrc` and so never tries the `_netrc` fallback. File Explorer won't let you
create a leading-dot name, so make it from a shell:

```powershell
notepad $HOME\.netrc
```

Say yes when Notepad offers to create the file.

## Run

```bat
run.bat
```

Then open <http://127.0.0.1:8000>. Check
<http://127.0.0.1:8000/api/health> to confirm the server is up and
credentials are being picked up.

## Using it

1. Pan/zoom to an area of interest and click **Search EMIT scenes in view**.
2. Click a scene in the list. NASA's quicklook appears in the panel at once,
   and a few seconds later on the map as a preview: the server warps that
   raw-swath PNG onto the map grid with the granule's GLT, read remotely
   (`/api/preview`), so no granule is downloaded yet.
3. Click the map inside the scene to plot that pixel's spectrum. This first
   click starts the full granule download in the background; its true
   reflectance overlay then replaces the preview.

## Notes

- Step 2 downloads the full granule bundle (reflectance + uncertainty + mask),
  about **3.6 GB per scene** (measured via CMR), into `backend/data/`. The first
  load of a scene takes many minutes; later loads reuse the cached file. Clear
  that folder when you're done — it fills a disk quickly.
- The default search window is 2023-01-01 → 2024-12-31. Override it with the
  `date_start` / `date_end` query parameters on `/api/search`.
- Building the RGB overlay reads three single bands out of a
  `(1280, 1242, 285)` float32 array that is stored **contiguous and
  uncompressed** (verified from the file header). There is no decompression
  cost, but each band is a strided read whose stride is 1140 bytes, so every
  band touches the whole 1.81 GB extent — three passes, largely absorbed by the
  OS page cache after the first. Expect tens of seconds once the file is local.
  Reading all three bands in a single pass would cut this roughly threefold if
  it ever becomes annoying.
- Python 3.9 is end-of-life and pins `earthaccess` to 0.11.0 (newer releases
  require 3.10+). The app works as-is; moving to Python 3.11+ would unlock
  current `earthaccess` versions.

## Troubleshooting

**`507` "Only N GB free"** — each scene needs ~4 GB headroom. Delete granules
you're done with from `backend/data/`; each scene is three files sharing a
timestamp suffix (`_RFL_`, `_RFLUNCERT_`, `_MASK_`).

**`507` "Download was incomplete"** — the download ran out of disk partway.
The partial file is deleted automatically, so just free space and click the
scene again.

A download interrupted by a full disk leaves a truncated `.nc` behind. Because
HDF5 stores the expected end-of-file in its superblock, opening one fails with
`truncated file: eof = ..., stored_eof = ...` rather than returning bad data.
`download_granule()` validates every cached file and refetches anything
truncated — but a granule already cached by an *older* build of this app will
keep failing until the server is restarted on current code.

**`500` "Could not read ...nc"** — that cached granule is damaged. Reload the
scene from the list to refetch it.

**Server seems to hang on first load** — it isn't hung; it's pulling 3.6 GB.
Watch `backend/data/` grow, and note uvicorn only writes its access-log line
when a request *finishes*, so an in-flight load logs nothing.
