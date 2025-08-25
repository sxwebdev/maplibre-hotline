// Reusable Hotline utilities: building gradient segments, color scale, nearest-point lookup.
// Customizable min/max speed for coloring and arbitrary color arrays.

export interface Point {
  lon: number;
  lat: number;
  speed: number; // km/h
  timestamp: number; // ms epoch
}

export interface Segment {
  id: string;
  path: [number, number][]; // start/end
  speed: number; // representative (midpoint) speed for color
  timestamp: number; // midpoint timestamp
  speed0: number; // endpoints for interpolation
  speed1: number;
  time0: number;
  time1: number;
}

export interface BuildResult {
  segments: Segment[];
  minSpeed: number; // observed (or override)
  maxSpeed: number; // observed (or override)
  initialViewState: {
    longitude: number;
    latitude: number;
    zoom: number;
    pitch: number;
    bearing: number;
  };
  gridIndex: Record<string, Segment[]>; // spatial index on midpoints
  gridSize: number; // degrees
}

export interface NearestResult {
  lon: number;
  lat: number;
  speed: number;
  timestamp: number;
  distMeters: number;
}

// Linear interpolation
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

type RGB = [number, number, number];
export type RGBA = [number, number, number, number];

function parseColor(c: string | RGB): RGB {
  if (Array.isArray(c)) return c;
  let s = c.trim();
  if (s.startsWith("#")) s = s.slice(1);
  if (s.length === 3) {
    const r = parseInt(s[0] + s[0], 16);
    const g = parseInt(s[1] + s[1], 16);
    const b = parseInt(s[2] + s[2], 16);
    return [r, g, b];
  }
  if (s.length === 6) {
    const r = parseInt(s.slice(0, 2), 16);
    const g = parseInt(s.slice(2, 4), 16);
    const b = parseInt(s.slice(4, 6), 16);
    return [r, g, b];
  }
  // fallback gray
  return [128, 128, 128];
}

function lerpColor(a: RGB, b: RGB, t: number): RGBA {
  return [
    Math.round(lerp(a[0], b[0], t)),
    Math.round(lerp(a[1], b[1], t)),
    Math.round(lerp(a[2], b[2], t)),
    255,
  ];
}

export function createSpeedColorScale(
  minSpeed: number,
  maxSpeed: number,
  colors: (string | RGB)[]
): (speed: number) => RGBA {
  const stops = (
    colors.length ? colors : ["#00aa00", "#ffff00", "#ffa500", "#ff0000"]
  ).map(parseColor);
  const n = stops.length;
  return (speed: number) => {
    if (!Number.isFinite(speed)) return [128, 128, 128, 255];
    const span = maxSpeed - minSpeed || 1;
    let u = (speed - minSpeed) / span;
    u = Math.max(0, Math.min(1, u));
    if (n === 1) {
      const c = stops[0];
      return [c[0], c[1], c[2], 255];
    }
    const scaled = u * (n - 1);
    const i = Math.floor(scaled);
    const t = scaled - i;
    const c1 = stops[i];
    const c2 = stops[Math.min(i + 1, n - 1)];
    return lerpColor(c1, c2, t);
  };
}

export function buildGradientCss(colors: (string | RGB)[]): string {
  const stops = (
    colors.length ? colors : ["#00aa00", "#ffff00", "#ffa500", "#ff0000"]
  ).map(parseColor);
  const n = stops.length;
  const parts = stops.map((c, idx) => {
    const pct = (idx / (n - 1)) * 100;
    const hex = `#${c[0].toString(16).padStart(2, "0")}${c[1]
      .toString(16)
      .padStart(2, "0")}${c[2].toString(16).padStart(2, "0")}`;
    return `${hex} ${pct.toFixed(1)}%`;
  });
  return `linear-gradient(90deg, ${parts.join(", ")})`;
}

export interface BuildSegmentsOptions {
  subdivisions: number;
  minSpeedOverride?: number; // forces min for coloring
  maxSpeedOverride?: number; // forces max for coloring
}

export function buildSegments(
  points: Point[],
  options: BuildSegmentsOptions
): BuildResult {
  const { subdivisions, minSpeedOverride, maxSpeedOverride } = options;
  if (!points || points.length < 2) {
    return {
      segments: [],
      minSpeed: minSpeedOverride ?? 0,
      maxSpeed: maxSpeedOverride ?? 1,
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
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    for (let s = 0; s < subdivisions; s++) {
      const t0 = s / subdivisions;
      const t1 = (s + 1) / subdivisions;
      const lon0 = lerp(a.lon, b.lon, t0);
      const lat0 = lerp(a.lat, b.lat, t0);
      const lon1 = lerp(a.lon, b.lon, t1);
      const lat1 = lerp(a.lat, b.lat, t1);
      const speed0 = lerp(a.speed, b.speed, t0);
      const speed1 = lerp(a.speed, b.speed, t1);
      const segSpeed = (speed0 + speed1) / 2;
      const time0 = lerp(a.timestamp, b.timestamp, t0);
      const time1 = lerp(a.timestamp, b.timestamp, t1);
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
        timestamp: (time0 + time1) / 2,
        speed0,
        speed1,
        time0,
        time1,
      });
    }
  }
  if (!Number.isFinite(minS)) minS = 0;
  if (!Number.isFinite(maxS)) maxS = 1;
  const effMin = minSpeedOverride ?? minS;
  const effMax = maxSpeedOverride ?? maxS;

  // Bounding box for initial view
  let minLon = Infinity,
    maxLon = -Infinity,
    minLat = Infinity,
    maxLat = -Infinity;
  for (const p of points) {
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
  }
  const centerLon = (minLon + maxLon) / 2;
  const centerLat = (minLat + maxLat) / 2;
  const span = Math.max(maxLon - minLon, maxLat - minLat);
  let zoom = 3;
  if (span < 0.8) zoom = 5;
  if (span < 0.4) zoom = 6;
  if (span < 0.2) zoom = 7;
  if (span < 0.1) zoom = 8;
  if (span < 0.05) zoom = 9;
  if (span < 0.025) zoom = 10;
  const initialViewState = {
    longitude: centerLon,
    latitude: centerLat,
    zoom,
    pitch: 0,
    bearing: 0,
  };

  // Spatial grid index (midpoints)
  const gridSize = 0.02;
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

  return {
    segments: segs,
    minSpeed: effMin,
    maxSpeed: effMax,
    initialViewState,
    gridIndex,
    gridSize,
  };
}

// Meters per degree approximator
function metersPerDegree(lat: number) {
  const mPerDegLat =
    111132.92 - 559.82 * Math.cos(2 * lat) + 1.175 * Math.cos(4 * lat);
  const mPerDegLon = 111412.84 * Math.cos(lat) - 93.5 * Math.cos(3 * lat);
  return { mPerDegLat, mPerDegLon };
}

export function findNearestPointOnTrack(
  lon: number,
  lat: number,
  segments: Segment[],
  gridIndex?: Record<string, Segment[]>,
  gridSize?: number
): NearestResult | null {
  if (!segments.length) return null;
  let candidates: Segment[] = segments;
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
    const latRad = (((y1 + y2) / 2) * Math.PI) / 180;
    const { mPerDegLat, mPerDegLon } = metersPerDegree(latRad);
    const ax = (x1 - lon) * mPerDegLon;
    const ay = (y1 - lat) * mPerDegLat;
    const vx = (x2 - x1) * mPerDegLon;
    const vy = (y2 - y1) * mPerDegLat;
    const vLen2 = vx * vx + vy * vy || 1;
    let t = -(ax * vx + ay * vy) / vLen2;
    t = Math.max(0, Math.min(1, t));
    const projLon = x1 + (x2 - x1) * t;
    const projLat = y1 + (y2 - y1) * t;
    const dx = (projLon - lon) * mPerDegLon;
    const dy = (projLat - lat) * mPerDegLat;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const speed = s.speed0 + (s.speed1 - s.speed0) * t;
    const timestamp = s.time0 + (s.time1 - s.time0) * t;
    if (!best || dist < best.distMeters) {
      best = { lon: projLon, lat: projLat, speed, timestamp, distMeters: dist };
    }
  }
  return best;
}
