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

import type { Point, Segment, BuildResult, NearestResult } from "./hotline";
import {
  buildSegments as buildHotlineSegments,
  createSpeedColorScale,
  buildGradientCss,
  findNearestPointOnTrack,
} from "./hotline";

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

// Segment interface now imported

// Route points will be fetched asynchronously
// Keep outside component reference only if needed; inside state for reactivity.

// Utility helpers moved to hotline module

// --- Component ---

export default function HotlineMap() {
  const [points, setPoints] = useState<Point[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

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
        const routeDistanceM: number | undefined = json?.routes?.[0]?.distance;
        let spacing = 60;
        if (routeDistanceM && Number.isFinite(routeDistanceM)) {
          if (routeDistanceM > 1_500_000) spacing = 500;
          else if (routeDistanceM > 800_000) spacing = 300;
          else if (routeDistanceM > 300_000) spacing = 150;
        }
        const pts = buildPointsFromRoute(coords, spacing);
        if (!cancelled) setPoints(pts);
      } catch (e: unknown) {
        if (!cancelled) setError((e as Error).message || "Route fetch failed");
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
  const DENSE_LIMIT = 5000;
  const SUBDIVISIONS = points.length > DENSE_LIMIT ? 1 : 6;
  const HOVER_PIXEL_TOLERANCE = 40;
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [nearestPoint, setNearestPoint] = useState<NearestResult | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number } | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  // Build densified segments and compute min/max speed
  const customMin = 0; // configurable
  const customMax = 120; // configurable
  const colorStops = useMemo(
    () => ["#00aa00", "#ffff00", "#ffa500", "#ff0000"],
    []
  );
  const {
    segments,
    minSpeed,
    maxSpeed,
    initialViewState,
    gridIndex,
    gridSize,
  }: BuildResult = useMemo(
    () =>
      buildHotlineSegments(points, {
        subdivisions: SUBDIVISIONS,
        minSpeedOverride: customMin,
        maxSpeedOverride: customMax,
      }),
    [points, SUBDIVISIONS, customMin, customMax]
  );

  const speedToColor = useMemo(
    () => createSpeedColorScale(minSpeed, maxSpeed, colorStops),
    [minSpeed, maxSpeed, colorStops]
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
            style={{ background: buildGradientCss(colorStops) }}
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
