import { useMemo, useState, useRef, useCallback, useEffect } from "react";
import DeckGL from "@deck.gl/react";
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import { Map } from "react-map-gl/maplibre";
import maplibregl from "maplibre-gl";
import {
  generateRandomEvents,
  buildClusterIndex,
  composeClusterRenderable,
  buildClusterLayers,
  computeBbox,
  type EventPoint,
} from "./clusterUtil";

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

  // ---- Clustering demo state ----
  const [events] = useState<EventPoint[]>(() =>
    generateRandomEvents(15000, [60, 56], 15)
  );
  const clusterIndex = useMemo(
    () => buildClusterIndex(events, { radius: 50, maxZoom: 16, minPoints: 2 }),
    [events]
  );
  const [clusterZoom, setClusterZoom] = useState<number>(3);
  const [clusterData, setClusterData] = useState(() =>
    composeClusterRenderable(clusterIndex, computeBbox(60, 56, 80), clusterZoom)
  );
  const [activeClusterId, setActiveClusterId] = useState<number | null>(null);
  const [clusterLeaves, setClusterLeaves] = useState<EventPoint[]>([]);
  const [leavesLoading, setLeavesLoading] = useState(false);
  const [clusterPanelPos, setClusterPanelPos] = useState<{
    x: number;
    y: number;
  } | null>(null);

  // Cluster updates with change detection to avoid infinite update loops
  const prevClusterState = useRef<{
    zoom: number;
    bbox: [number, number, number, number];
    hash: string;
  } | null>(null);
  const updateClusters = useCallback(
    (map?: maplibregl.Map) => {
      const m = map || mapRef.current;
      if (!m) return;
      const b = m.getBounds();
      const z = m.getZoom();
      const bbox: [number, number, number, number] = [
        b.getWest(),
        b.getSouth(),
        b.getEast(),
        b.getNorth(),
      ];
      const prev = prevClusterState.current;
      // Simple bbox + zoom equality check
      const sameZoom = prev && Math.abs(prev.zoom - z) < 1e-6;
      const sameBbox =
        prev &&
        Math.abs(prev.bbox[0] - bbox[0]) < 1e-6 &&
        Math.abs(prev.bbox[1] - bbox[1]) < 1e-6 &&
        Math.abs(prev.bbox[2] - bbox[2]) < 1e-6 &&
        Math.abs(prev.bbox[3] - bbox[3]) < 1e-6;
      if (sameZoom && sameBbox) return; // nothing changed
      const renderable = composeClusterRenderable(clusterIndex, bbox, z);
      // Build a hash of ids to avoid state update if identical content
      const newHash = renderable
        .map((d) => `${d.id}:${d.pointCount}`)
        .join("|");
      if (prev && prev.hash === newHash) {
        prevClusterState.current = { zoom: z, bbox, hash: newHash }; // update bbox/zoom refs only
        return;
      }
      prevClusterState.current = { zoom: z, bbox, hash: newHash };
      setClusterZoom(z);
      setClusterData(renderable);
    },
    [clusterIndex]
  );

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
      capRounded: true,
      jointRounded: true,
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
    // Cluster layers (events)
    ...buildClusterLayers({
      data: clusterData,
      idPrefix: "evt",
      clusterRadiusPx: 20,
      clusterBorderPx: 6,
      clusterFillColor: [255, 255, 255, 255],
      clusterBorderColor: [59, 130, 246, 255], // blue-500
      singlePointRadius: 3,
      singlePointColor: [59, 130, 246, 180],
      textColor: [55, 65, 81, 255],
    }),
  ];

  return (
    <div className="fixed inset-0 w-screen h-screen">
      <DeckGL
        initialViewState={initialViewState}
        controller={true}
        layers={layers}
        onClick={(info: { object?: unknown; x: number; y: number }) => {
          type ClickedObj = { id?: string | number; isCluster?: boolean };
          const obj = info.object as ClickedObj | undefined;
          if (!obj || !obj.isCluster || typeof obj.id === "undefined") return;
          const clusterIdNum = Number(obj.id);
          if (!Number.isFinite(clusterIdNum)) return;
          if (activeClusterId === clusterIdNum) {
            setActiveClusterId(null);
            setClusterLeaves([]);
            setClusterPanelPos(null);
            return;
          }
          setActiveClusterId(clusterIdNum);
          setLeavesLoading(true);
          const clickX = info.x;
          const clickY = info.y;
          if (typeof clickX === "number" && typeof clickY === "number") {
            setClusterPanelPos({ x: clickX, y: clickY });
          } else {
            setClusterPanelPos(null);
          }
          type Position = number[];
          interface LeafFeature {
            id?: string | number;
            properties?: { value?: number; name?: string };
            geometry: { coordinates: Position };
          }
          const gathered: EventPoint[] = [];
          let offset = 0;
          const PAGE = 50;
          try {
            while (offset < 1000) {
              const batch = clusterIndex.getLeaves(
                clusterIdNum,
                PAGE,
                offset
              ) as unknown as LeafFeature[];
              if (!batch.length) break;
              for (const l of batch) {
                const name = l.properties?.name || (l.id ?? "leaf").toString();
                const coords = l.geometry.coordinates;
                if (
                  Array.isArray(coords) &&
                  coords.length >= 2 &&
                  typeof coords[0] === "number" &&
                  typeof coords[1] === "number"
                ) {
                  const lon = coords[0];
                  const lat = coords[1];
                  gathered.push({
                    id: (l.id ?? "leaf").toString(),
                    lon,
                    lat,
                    value: l.properties?.value,
                    name,
                  });
                }
              }
              if (batch.length < PAGE) break;
              offset += PAGE;
            }
            setClusterLeaves(gathered);
          } finally {
            setLeavesLoading(false);
          }
        }}
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
            updateClusters(e.target);
            e.target.on("moveend", () => updateClusters());
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
        <div className="mt-3 pt-3 border-t text-xs text-gray-700 space-y-1">
          <div className="font-medium">Clusters</div>
          <div>Total events: {events.length.toLocaleString()}</div>
          <div>Visible items: {clusterData.length}</div>
        </div>
      </div>
      {activeClusterId != null &&
        clusterPanelPos &&
        (() => {
          const PAD = 6;
          const PANEL_W = 260;
          const PANEL_H = 400; // max height constraint for placement calculations
          let left = clusterPanelPos.x + 12;
          let top = clusterPanelPos.y + 12;
          if (left + PANEL_W > window.innerWidth - PAD)
            left = clusterPanelPos.x - PANEL_W - 12;
          if (left < PAD) left = PAD;
          if (top + PANEL_H > window.innerHeight - PAD)
            top = window.innerHeight - PAD - PANEL_H;
          if (top < PAD) top = PAD;
          return (
            <div
              className="absolute flex flex-col bg-white/95 border border-gray-300 rounded-lg shadow-lg overflow-hidden"
              style={{ left, top, width: PANEL_W, maxHeight: PANEL_H }}
            >
              <div className="px-3 py-2 border-b flex items-center justify-between text-xs font-semibold bg-gray-50">
                <span>Кластер {activeClusterId}</span>
                <button
                  className="text-gray-500 hover:text-gray-800"
                  onClick={() => {
                    setActiveClusterId(null);
                    setClusterLeaves([]);
                    setClusterPanelPos(null);
                  }}
                >
                  ×
                </button>
              </div>
              <div className="p-2 text-[11px] text-gray-600 border-b">
                {leavesLoading
                  ? "Загрузка…"
                  : `Событий: ${clusterLeaves.length}`}
              </div>
              <div className="flex-1 overflow-y-auto text-xs">
                {clusterLeaves.map((ev) => (
                  <div
                    key={ev.id}
                    className="px-3 py-1.5 border-b last:border-b-0 hover:bg-blue-50 cursor-pointer"
                  >
                    <div className="font-medium truncate" title={ev.name}>
                      {ev.name}
                    </div>
                    <div className="text-[10px] text-gray-500">
                      {ev.lon.toFixed(3)}, {ev.lat.toFixed(3)}
                    </div>
                  </div>
                ))}
                {!leavesLoading && !clusterLeaves.length && (
                  <div className="px-3 py-4 text-gray-400 text-center text-[11px]">
                    Нет событий
                  </div>
                )}
              </div>
            </div>
          );
        })()}
    </div>
  );
}
