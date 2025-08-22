import { useMemo, useState, useRef, useCallback, useEffect } from "react";
import DeckGL from "@deck.gl/react";
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import { Map } from "react-map-gl/maplibre";
import maplibregl from "maplibre-gl";

/**
 * Quick start:
 *   npm install react react-dom @deck.gl/react @deck.gl/core @deck.gl/layers react-map-gl maplibre-gl
 *
 * Replace `points` with your data: [{ lon, lat, speed }...]
 */

// --- Example data (lon, lat, speed, timestamp) ---

interface Point {
  lon: number;
  lat: number;
  speed: number; // km/h
  timestamp: number; // ms epoch
}

// --- Realistic route fetch (Moscow -> St. Petersburg) using OSRM public demo server ---
// NOTE: Public demo server has rate limits; for production, self-host OSRM or use a routing provider.
const ROUTE_START: [number, number] = [37.617635, 55.755814]; // Moscow (lon, lat)
const ROUTE_END: [number, number] = [131.885, 43.115]; // Vladivostok (lon, lat)

function haversineKm(a: [number, number], b: [number, number]) {
  const R = 6371;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h =
    sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function densify(
  coords: [number, number][],
  targetSpacingMeters = 50
): [number, number][] {
  if (coords.length < 2) return coords;
  const out: [number, number][] = [];
  const spacingKm = targetSpacingMeters / 1000;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    out.push(a as [number, number]);
    const distKm = haversineKm(a, b);
    if (distKm > spacingKm) {
      const steps = Math.floor(distKm / spacingKm);
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
  }
  out.push(coords[coords.length - 1] as [number, number]);
  return out;
}

function buildPointsFromRoute(
  rawCoords: [number, number][],
  spacingMeters = 60
): Point[] {
  const dense = densify(rawCoords, spacingMeters); // adaptive spacing
  // Compute cumulative distance to derive timestamps & speed profile
  const distsKm: number[] = [0];
  for (let i = 1; i < dense.length; i++) {
    distsKm[i] = distsKm[i - 1] + haversineKm(dense[i - 1], dense[i]);
  }
  const totalKm = distsKm[distsKm.length - 1] || 1;
  const startTime = Date.now() - totalKm * (1000 * 60); // 1 minute per km into past
  const points: Point[] = [];
  for (let i = 0; i < dense.length; i++) {
    const frac = distsKm[i] / totalKm; // 0..1 along route
    // Speed model: slower (urban) near ends, faster mid-route (highway), noise added
    const highwayFactor = Math.sin(Math.PI * frac); // 0 at ends, 1 center
    let speed = 30 + 90 * highwayFactor; // 30..120
    speed +=
      8 * Math.sin(frac * 40 * Math.PI) + 4 * Math.sin(frac * 90 * Math.PI); // local oscillations
    speed = Math.max(0, Math.min(120, speed));
    const timestamp =
      startTime + (distsKm[i] / totalKm) * (totalKm * 60 * 1000);
    const [lon, lat] = dense[i];
    points.push({ lon, lat, speed, timestamp });
  }
  return points;
}

interface Segment {
  id: string; // unique id
  path: [number, number][]; // two coordinate pairs (start, end)
  speed: number; // representative speed (e.g. midpoint) for color mapping
  timestamp: number; // midpoint timestamp
  // for interpolation along the subdivided mini-segment
  speed0: number;
  speed1: number;
  time0: number;
  time1: number;
}

// Route points will be fetched asynchronously
// Keep outside component reference only if needed; inside state for reactivity.

// Utility: linear interpolation between two numbers
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

type RGB = [number, number, number];
type RGBA = [number, number, number, number];

// Interpolate between two RGB colors
function lerpColor(c1: RGB, c2: RGB, t: number): RGBA {
  return [
    Math.round(lerp(c1[0], c2[0], t)),
    Math.round(lerp(c1[1], c2[1], t)),
    Math.round(lerp(c1[2], c2[2], t)),
    255,
  ];
}

// Map speed (min..max) to a 4-stop gradient: green -> yellow -> orange -> red
function makeSpeedToColor(minSpeed: number, maxSpeed: number) {
  const stops: { t: number; color: RGB }[] = [
    { t: 0.0, color: [0, 170, 0] }, // green
    { t: 1 / 3, color: [255, 255, 0] }, // yellow
    { t: 2 / 3, color: [255, 165, 0] }, // orange
    { t: 1.0, color: [255, 0, 0] }, // red
  ];

  return (speed: number): RGBA => {
    if (!Number.isFinite(speed)) return [128, 128, 128, 255];

    const span = maxSpeed - minSpeed || 1; // avoid divide-by-zero
    let u = (speed - minSpeed) / span;
    u = Math.max(0, Math.min(1, u));

    // find surrounding stops
    let i = 0;
    while (i < stops.length - 1 && u > stops[i + 1].t) i++;
    const a = stops[i];
    const b = stops[Math.min(i + 1, stops.length - 1)];

    // normalize u within [a.t, b.t]
    const localT = (u - a.t) / (b.t - a.t || 1);
    return lerpColor(a.color, b.color, localT);
  };
}

/**
 * Build densified segments to simulate a smooth gradient.
 * Each original segment is subdivided so color transitions appear continuous.
 */
interface BuildResult {
  segments: Segment[];
  minSpeed: number;
  maxSpeed: number;
  initialViewState: {
    longitude: number;
    latitude: number;
    zoom: number;
    pitch: number;
    bearing: number;
  };
  gridIndex: Record<string, Segment[]>; // spatial lookup grid
  gridSize: number; // degrees
}

function buildSegments(pts: Point[], subdivisions: number): BuildResult {
  if (!pts || pts.length < 2) {
    return {
      segments: [],
      minSpeed: 0,
      maxSpeed: 1,
      initialViewState: {
        longitude: 0,
        latitude: 0,
        zoom: 2,
        pitch: 0,
        bearing: 0,
      },
      gridIndex: {},
      gridSize: 0.05,
    };
  }

  let minS = Infinity;
  let maxS = -Infinity;
  const segs: Segment[] = [];

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    for (let s = 0; s < subdivisions; s++) {
      const t0 = s / subdivisions;
      const t1 = (s + 1) / subdivisions;
      const lon0 = lerp(a.lon, b.lon, t0);
      const lat0 = lerp(a.lat, b.lat, t0);
      const lon1 = lerp(a.lon, b.lon, t1);
      const lat1 = lerp(a.lat, b.lat, t1);
      // speed along subdivided segment interpolated between endpoints
      const speed0 = lerp(a.speed, b.speed, t0);
      const speed1 = lerp(a.speed, b.speed, t1);
      const segSpeed = (speed0 + speed1) / 2;
      const time0 = lerp(a.timestamp, b.timestamp, t0);
      const time1 = lerp(a.timestamp, b.timestamp, t1);
      const segTime = (time0 + time1) / 2;
      if (Number.isFinite(segSpeed)) {
        minS = Math.min(minS, segSpeed);
        maxS = Math.max(maxS, segSpeed);
      }
      segs.push({
        id: `${i}-${s}`,
        path: [
          [lon0, lat0],
          [lon1, lat1],
        ],
        speed: segSpeed,
        timestamp: segTime,
        speed0,
        speed1,
        time0,
        time1,
      });
    }
  }

  // Compute bounding box for initial view
  let minLon = Infinity,
    maxLon = -Infinity,
    minLat = Infinity,
    maxLat = -Infinity;
  for (const p of pts) {
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
  }
  const centerLon = (minLon + maxLon) / 2;
  const centerLat = (minLat + maxLat) / 2;
  // Heuristic zoom: smaller span -> larger zoom. Rough conversion.
  const span = Math.max(maxLon - minLon, maxLat - minLat);
  let zoom = 3;
  if (span < 0.8) zoom = 5;
  if (span < 0.4) zoom = 6;
  if (span < 0.2) zoom = 7;
  if (span < 0.1) zoom = 8;
  if (span < 0.05) zoom = 9;
  if (span < 0.025) zoom = 10;
  const ivs = {
    longitude: centerLon,
    latitude: centerLat,
    zoom,
    pitch: 0,
    bearing: 0,
  };

  // Build simple spatial grid index on segment midpoints (lon/lat degrees)
  const gridSize = 0.02; // ~1-2km depending on latitude; tune
  const gridIndex: Record<string, Segment[]> = {};
  for (const s of segs) {
    const [[lon0, lat0], [lon1, lat1]] = s.path;
    const midLon = (lon0 + lon1) / 2;
    const midLat = (lat0 + lat1) / 2;
    const key = `${Math.floor(midLon / gridSize)}_${Math.floor(
      midLat / gridSize
    )}`;
    (gridIndex[key] ||= []).push(s);
  }

  if (!Number.isFinite(minS)) minS = 0;
  if (!Number.isFinite(maxS)) maxS = 1;

  return {
    segments: segs,
    minSpeed: minS,
    maxSpeed: maxS,
    initialViewState: ivs,
    gridIndex,
    gridSize,
  };
}

// Approximate meters per degree latitude and longitude at given latitude
function metersPerDegree(lat: number) {
  const mPerDegLat =
    111132.92 - 559.82 * Math.cos(2 * lat) + 1.175 * Math.cos(4 * lat);
  const mPerDegLon = 111412.84 * Math.cos(lat) - 93.5 * Math.cos(3 * lat);
  return { mPerDegLat, mPerDegLon };
}

interface NearestResult {
  lon: number;
  lat: number;
  speed: number;
  timestamp: number;
  distMeters: number;
}

function findNearestPointOnTrack(
  lon: number,
  lat: number,
  segs: Segment[],
  gridIndex?: Record<string, Segment[]>,
  gridSize?: number
): NearestResult | null {
  if (!segs.length) return null;
  let candidates: Segment[] = segs;
  if (gridIndex && gridSize) {
    const gx = Math.floor(lon / gridSize);
    const gy = Math.floor(lat / gridSize);
    const set = new Set<Segment>();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const key = `${gx + dx}_${gy + dy}`;
        const arr = gridIndex[key];
        if (arr) for (const seg of arr) set.add(seg);
      }
    }
    if (set.size) candidates = Array.from(set);
  }
  let best: NearestResult | null = null;
  for (const s of candidates) {
    const [[x1, y1], [x2, y2]] = s.path;
    // project to local meters
    const latRad = (((y1 + y2) / 2) * Math.PI) / 180;
    const { mPerDegLat, mPerDegLon } = metersPerDegree(latRad);
    const ax = (x1 - lon) * mPerDegLon;
    const ay = (y1 - lat) * mPerDegLat;
    const vx = (x2 - x1) * mPerDegLon;
    const vy = (y2 - y1) * mPerDegLat;
    const vLen2 = vx * vx + vy * vy || 1;
    let t = -(ax * vx + ay * vy) / vLen2; // projection of point onto segment (relative to start)
    t = Math.max(0, Math.min(1, t));
    const projLon = x1 + (x2 - x1) * t;
    const projLat = y1 + (y2 - y1) * t;
    const dx = (projLon - lon) * mPerDegLon;
    const dy = (projLat - lat) * mPerDegLat;
    const dist = Math.sqrt(dx * dx + dy * dy);
    // interpolate speed/time along mini segment using stored endpoints
    const speed = s.speed0 + (s.speed1 - s.speed0) * t;
    const timestamp = s.time0 + (s.time1 - s.time0) * t;
    if (!best || dist < best.distMeters) {
      best = { lon: projLon, lat: projLat, speed, timestamp, distMeters: dist };
    }
  }
  return best;
}

export default function HotlineMap() {
  const [points, setPoints] = useState<Point[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch route once
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const url = `https://router.project-osrm.org/route/v1/driving/${ROUTE_START[0]},${ROUTE_START[1]};${ROUTE_END[0]},${ROUTE_END[1]}?overview=full&geometries=geojson`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = await resp.json();
        const coords: [number, number][] | undefined =
          json?.routes?.[0]?.geometry?.coordinates;
        if (!coords || !coords.length)
          throw new Error("No coordinates in route");
        // Adaptive densify spacing based on full route distance (meters)
        const routeDistanceM: number | undefined = json?.routes?.[0]?.distance;
        let spacing = 60; // default short routes
        if (routeDistanceM && Number.isFinite(routeDistanceM)) {
          if (routeDistanceM > 1_500_000) spacing = 500; // >1500 km
          else if (routeDistanceM > 800_000) spacing = 300; // >800 km
          else if (routeDistanceM > 300_000) spacing = 150; // >300 km
        }
        const pts = buildPointsFromRoute(coords, spacing);
        if (!cancelled) setPoints(pts);
      } catch (e: unknown) {
        if (!cancelled) {
          setError((e as Error).message || "Route fetch failed");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);
  // Adaptive: if a lot of points, skip extra densification (1) to keep GPU + JS light.
  const DENSE_LIMIT = 5000; // if points > this, no artificial subdivision
  const SUBDIVISIONS = points.length > DENSE_LIMIT ? 1 : 6;
  const HOVER_PIXEL_TOLERANCE = 40; // wider hover radius in pixels
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [nearestPoint, setNearestPoint] = useState<NearestResult | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number } | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  // Build densified segments and compute min/max speed
  const {
    segments,
    minSpeed,
    maxSpeed,
    initialViewState,
    gridIndex,
    gridSize,
  } = useMemo(
    () => buildSegments(points, SUBDIVISIONS),
    [points, SUBDIVISIONS]
  );

  const speedToColor = useMemo(
    () => makeSpeedToColor(minSpeed, maxSpeed),
    [minSpeed, maxSpeed]
  );

  const handleHover = useCallback(
    (info: {
      coordinate?: [number, number];
      x?: number;
      y?: number;
      viewport?: { project?: (lngLat: [number, number]) => number[] };
    }) => {
      if (!info.coordinate) {
        setNearestPoint(null);
        setTooltip(null);
        return;
      }
      const [lon, lat] = info.coordinate;
      const nearest = findNearestPointOnTrack(
        lon,
        lat,
        segments,
        gridIndex,
        gridSize
      );
      // derive meter threshold from pixel tolerance
      let thresholdMeters = 500; // fallback large
      try {
        const vp = info.viewport as unknown as {
          zoom?: number;
          distanceScales?: { metersPerPixel?: number[] };
        };
        if (vp?.distanceScales?.metersPerPixel) {
          const mPerPx = vp.distanceScales.metersPerPixel[0];
          if (Number.isFinite(mPerPx))
            thresholdMeters = mPerPx * HOVER_PIXEL_TOLERANCE;
        } else if (vp?.zoom != null) {
          const latRad = (info.coordinate[1] * Math.PI) / 180;
          const mPerPxApprox =
            (156543.03392 * Math.cos(latRad)) / Math.pow(2, vp.zoom);
          thresholdMeters = mPerPxApprox * HOVER_PIXEL_TOLERANCE;
        }
      } catch {
        /* ignore */
      }
      if (nearest && nearest.distMeters < thresholdMeters) {
        setNearestPoint(nearest);
        let x = info.x ?? 0;
        let y = info.y ?? 0;
        try {
          if (info.viewport && typeof info.viewport.project === "function") {
            const p = info.viewport.project([nearest.lon, nearest.lat]);
            if (Array.isArray(p) && p.length >= 2) {
              x = p[0];
              y = p[1];
            }
          }
        } catch {
          // ignore
        }
        setTooltip({ x, y });
      } else {
        setNearestPoint(null);
        setTooltip(null);
      }
    },
    [segments, gridIndex, gridSize]
  );

  const layers = [
    new PathLayer<Segment>({
      id: "hotline-track",
      data: segments,
      getPath: (d) => d.path,
      getColor: (d) => speedToColor(d.speed),
      getWidth: 6,
      widthUnits: "pixels",
      rounded: true,
      pickable: false,
    }),
    ...(nearestPoint
      ? [
          new ScatterplotLayer<NearestResult>({
            id: "nearest-marker",
            data: [nearestPoint],
            getPosition: (d) => [d.lon, d.lat],
            getRadius: 6,
            radiusUnits: "pixels",
            stroked: true,
            filled: true,
            getFillColor: [255, 255, 255, 200],
            getLineColor: [0, 0, 0, 230],
            lineWidthMinPixels: 2,
            pickable: false,
          }),
        ]
      : []),
  ];

  return (
    <div className="fixed inset-0 w-screen h-screen">
      <DeckGL
        initialViewState={initialViewState}
        controller={true}
        layers={layers}
        onHover={(pi) => {
          const { coordinate, x, y, viewport } = pi as unknown as {
            coordinate?: number[];
            x: number;
            y: number;
            viewport?: { project?: (lngLat: [number, number]) => number[] };
          };
          handleHover({
            coordinate:
              coordinate && coordinate.length >= 2
                ? ([coordinate[0], coordinate[1]] as [number, number])
                : undefined,
            x,
            y,
            viewport,
          });
        }}
      >
        <Map
          reuseMaps
          mapLib={maplibregl}
          mapStyle="https://basemaps.cartocdn.com/gl/positron-gl-style/style.json"
          onLoad={(e: { target: maplibregl.Map }) => {
            mapRef.current = e.target;
          }}
        />
      </DeckGL>
      {loading && (
        <div className="absolute top-4 right-4 bg-white/90 text-gray-800 px-3 py-2 rounded shadow text-xs">
          Loading route…
        </div>
      )}
      {error && (
        <div className="absolute top-4 right-4 bg-red-600 text-white px-3 py-2 rounded shadow text-xs max-w-xs">
          Route error: {error}
        </div>
      )}
      {nearestPoint &&
        tooltip &&
        (() => {
          const OFFSET = 10;
          const assumedWidth = tooltipRef.current?.offsetWidth || 180; // fallback width
          let left = tooltip.x + OFFSET;
          if (left + assumedWidth + OFFSET > window.innerWidth) {
            left = tooltip.x - assumedWidth - OFFSET;
          }
          const top = tooltip.y + OFFSET;
          return (
            <div
              className="absolute pointer-events-none"
              style={{ left, top, zIndex: 9999, maxWidth: 240 }}
            >
              <div
                ref={tooltipRef}
                className="bg-white text-gray-900 border border-gray-300 rounded-md shadow-lg px-2.5 py-2 text-xs leading-tight"
              >
                <div>
                  <span className="font-semibold">Lon:</span>{" "}
                  {nearestPoint.lon.toFixed(5)}
                </div>
                <div>
                  <span className="font-semibold">Lat:</span>{" "}
                  {nearestPoint.lat.toFixed(5)}
                </div>
                <div>
                  <span className="font-semibold">Speed:</span>{" "}
                  {nearestPoint.speed.toFixed(1)} km/h
                </div>
                <div>
                  <span className="font-semibold">Time:</span>{" "}
                  {new Date(nearestPoint.timestamp).toLocaleString()}
                </div>
              </div>
            </div>
          );
        })()}

      {/* Simple legend */}
      <div className="absolute bottom-4 left-4 bg-white/90 rounded-2xl shadow p-3 text-sm">
        <div className="font-medium mb-2">Speed</div>
        <div className="flex items-center gap-2">
          <span>low</span>
          <div
            className="h-2 w-40 rounded-full"
            style={{
              background:
                "linear-gradient(90deg, rgb(0,170,0) 0%, rgb(255,255,0) 33%, rgb(255,165,0) 66%, rgb(255,0,0) 100%)",
            }}
          />
          <span>high</span>
        </div>
        <div className="mt-2 text-xs text-gray-600">
          Min: {Number.isFinite(minSpeed) ? minSpeed.toFixed(1) : "-"} · Max:{" "}
          {Number.isFinite(maxSpeed) ? maxSpeed.toFixed(1) : "-"}
        </div>
      </div>
    </div>
  );
}
