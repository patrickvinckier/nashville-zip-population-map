# Nashville ZIP Code Population Map

An interactive map and table showing population distribution across ZIP codes within a selected radius of downtown Nashville, TN.

---

## What the app does

- Displays a Leaflet map centered on Nashville with a proportional circle for each ZIP code
- Circles are sized and colored by each ZIP's share of the total regional population
- A sortable, searchable table lists all ZIP codes with population, percentage share, and distance
- A radius filter (10 / 15 / 20 / 25 / 30 miles) narrows the view and recalculates percentages for the visible area
- Clicking a map marker scrolls and highlights the matching row in the table
- Clicking a table row flies the map to that ZIP code
- When real GeoJSON boundary polygons are loaded into `data/zipcodes.json`, the app automatically switches from circles to filled polygons

---

## File structure

```
/
├── index.html          Main page — HTML structure only, no inline logic
├── styles.css          All CSS — responsive grid, map popup, table, controls
├── script.js           All JavaScript — data loading, map, table, interactions
├── data/
│   └── zipcodes.json   ZIP code data (population, distance, lat/lng, geometry)
├── vercel.json         Minimal Vercel config (caching headers)
└── README.md           This file
```

---

## How to run locally

Because the app fetches `data/zipcodes.json` via HTTP, opening `index.html` directly
as a `file://` URL will fail in most browsers (CORS restriction on local fetches).

**Option A — VS Code Live Server** (easiest)
1. Install the "Live Server" extension in VS Code
2. Right-click `index.html` → "Open with Live Server"
3. The app opens at `http://127.0.0.1:5500`

**Option B — Python**
```bash
python -m http.server 8080
# then open http://localhost:8080
```

**Option C — Deploy straight to Vercel** (see below)

---

## How to replace the sample data with real Nashville data

### Population data

The file `data/zipcodes.json` already contains **real** Census-derived population and
distance data for 61 ZIP codes within 30 miles of downtown Nashville.

If you obtain updated or more granular data, replace the values in each JSON object:

```jsonc
{
  "zip": "37203",
  "city": "Nashville",
  "state": "TN",
  "county": "Davidson",
  "population": 11883,       // ← replace with updated count
  "distanceMiles": 1.04,
  "lat": 36.14934,
  "lng": -86.79034,
  "geometry": null           // ← replace null with a GeoJSON Polygon (see below)
}
```

### ZIP code boundary polygons (GeoJSON)

Currently the app uses proportional circles because ZIP boundary polygons are not
included. To enable filled polygon shapes:

1. Download **TIGER/Line ZCTA shapefiles** from the US Census Bureau:
   https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html

2. Convert the shapefile to GeoJSON (use QGIS, Mapshaper, or the `ogr2ogr` CLI tool).

3. For each ZIP code in `data/zipcodes.json`, copy the matching GeoJSON `geometry` object
   (type `"Polygon"` or `"MultiPolygon"`) into the `"geometry"` field.

   The geometry must use **longitude, latitude** coordinate order (GeoJSON standard):
   ```json
   "geometry": {
     "type": "Polygon",
     "coordinates": [
       [[-86.800, 36.155], [-86.785, 36.150], [-86.770, 36.160], [-86.800, 36.155]]
     ]
   }
   ```

4. Save the file. The app detects the geometry type and switches automatically from
   circles to filled polygons — no code changes needed.

---

## How to deploy on Vercel

1. Push this project folder to a GitHub repository.
2. Go to https://vercel.com and click **Add New → Project**.
3. Import your GitHub repository.
4. Vercel auto-detects a static site (no build command needed). Click **Deploy**.
5. Your app is live at `https://your-project.vercel.app`.

The included `vercel.json` sets cache headers so the JSON data file is re-fetched
when updated without needing a full redeploy.

---

## Data sources

- Population and distance figures: Census-derived ZIP-level data
- Downtown Nashville reference point: 36.1627°N, 86.7816°W
- Map tiles: CartoDB dark basemap via Leaflet.js 1.9.4
