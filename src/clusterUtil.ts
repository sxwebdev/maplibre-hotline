import Supercluster from "supercluster";
import type {
  ClusterFeature as SCClusterFeature,
  PointFeature,
} from "supercluster";

export interface EventPoint {
  id: string;
  lon: number;
  lat: number;
  value?: number;
  name?: string; // optional display name
}

export interface ClusterFeature {
  id: string | number;
  longitude: number;
  latitude: number;
  pointCount: number;
  expansionZoom?: number;
  leaves?: EventPoint[];
}

export interface ClusterLayerData extends ClusterFeature {
  isCluster: boolean;
}

// Convert clusters + single points to unified array for deck.gl
export function composeClusterRenderable(
  index: ReturnType<typeof buildClusterIndex>,
  bbox: [number, number, number, number],
  zoom: number
): ClusterLayerData[] {
  type CP = { value: number };
  const items = index.getClusters(bbox, Math.floor(zoom)) as Array<
    SCClusterFeature<CP> | PointFeature<CP>
  >;
  return items.map((f) => {
    const [lon, lat] = f.geometry.coordinates as [number, number];
    const isCluster = "cluster" in f.properties && !!f.properties.cluster;
    const pointCount = isCluster
      ? (f as SCClusterFeature<CP>).properties.point_count || 0
      : 1;
    const id =
      ("id" in f && f.id) ||
      (isCluster
        ? (f as SCClusterFeature<CP>).properties.cluster_id
        : undefined) ||
      `${lon}_${lat}`;
    return {
      id: id!,
      longitude: lon,
      latitude: lat,
      pointCount,
      isCluster,
    };
  });
}

// ---- deck.gl layer factory (kept here for reuse) ----
import { ScatterplotLayer, TextLayer } from "@deck.gl/layers";
// We type return as any[] to avoid pulling full Layer typings into this util.
export interface BuildClusterLayersParams {
  data: ClusterLayerData[];
  singlePointRadius?: number; // px
  clusterRadiusPx?: number; // px (visual only)
  clusterBorderPx?: number; // stroke width
  clusterFillColor?: [number, number, number, number];
  clusterBorderColor?: [number, number, number, number];
  singlePointColor?: [number, number, number, number];
  textColor?: [number, number, number, number];
  idPrefix?: string;
}

export function buildClusterLayers({
  data,
  singlePointRadius = 4,
  clusterRadiusPx = 20,
  clusterBorderPx = 6,
  clusterFillColor = [255, 255, 255, 255],
  clusterBorderColor = [37, 99, 235, 255], // blue-500
  singlePointColor = [37, 99, 235, 200],
  textColor = [55, 65, 81, 255], // gray-700
  idPrefix = "clusters",
}: BuildClusterLayersParams) {
  const clusters = data.filter((d) => d.isCluster);
  const singles = data.filter((d) => !d.isCluster);
  const clusterCircle = new ScatterplotLayer({
    id: `${idPrefix}-circles`,
    data: clusters,
    getPosition: (d: ClusterLayerData) => [d.longitude, d.latitude],
    getRadius: clusterRadiusPx,
    radiusUnits: "pixels",
    filled: true,
    stroked: true,
    getFillColor: clusterFillColor,
    getLineColor: clusterBorderColor,
    lineWidthUnits: "pixels",
    lineWidthMinPixels: clusterBorderPx,
    pickable: true,
  });
  const clusterText = new TextLayer({
    id: `${idPrefix}-labels`,
    data: clusters,
    getPosition: (d: ClusterLayerData) => [d.longitude, d.latitude],
    getText: (d: ClusterLayerData) => `${d.pointCount}`,
    getSize: 14,
    sizeUnits: "pixels",
    getColor: textColor,
    background: false,
    getTextAnchor: () => "middle",
    getAlignmentBaseline: () => "center",
    pickable: false,
  });
  const singlePoints = new ScatterplotLayer({
    id: `${idPrefix}-singles`,
    data: singles,
    getPosition: (d: ClusterLayerData) => [d.longitude, d.latitude],
    getRadius: singlePointRadius,
    radiusUnits: "pixels",
    filled: true,
    stroked: false,
    getFillColor: singlePointColor,
    pickable: true,
  });
  return [singlePoints, clusterCircle, clusterText];
}

export interface BuildClusterIndexOptions {
  maxZoom?: number; // max zoom for clustering (default 16)
  radius?: number; // cluster radius in pixels (default 40)
  minPoints?: number; // min points to form cluster
}

export function buildClusterIndex(
  points: EventPoint[],
  options: BuildClusterIndexOptions = {}
) {
  const { maxZoom = 16, radius = 40, minPoints = 2 } = options;
  type P = { value: number; name?: string };
  const index = new Supercluster<P>({
    maxZoom,
    radius,
    minPoints,
    map: (props) => ({ value: props.value, name: props.name }),
    reduce: (accumulated, props) => {
      accumulated.value += props.value;
      // name aggregation not needed
    },
  });
  const features: PointFeature<P>[] = points.map((p) => ({
    type: "Feature",
    id: p.id,
    properties: { value: p.value ?? 0, name: p.name },
    geometry: { type: "Point", coordinates: [p.lon, p.lat] },
  }));
  index.load(features);
  return index;
}

export function getClustersForViewport(
  index: ReturnType<typeof buildClusterIndex>,
  bbox: [number, number, number, number],
  zoom: number
): ClusterFeature[] {
  type CP = { value: number };
  const items = index.getClusters(bbox, Math.floor(zoom)) as Array<
    SCClusterFeature<CP> | PointFeature<CP>
  >;
  return items.map((f) => {
    const [lon, lat] = f.geometry.coordinates as [number, number];
    const isCluster = "cluster" in f.properties && !!f.properties.cluster;
    const pointCount = isCluster
      ? (f as SCClusterFeature<CP>).properties.point_count || 0
      : 1;
    const id =
      ("id" in f && f.id) ||
      (isCluster
        ? (f as SCClusterFeature<CP>).properties.cluster_id
        : undefined) ||
      `${lon}_${lat}`;
    return {
      id: id!,
      longitude: lon,
      latitude: lat,
      pointCount,
    };
  });
}

export function getClusterLeaves(
  index: ReturnType<typeof buildClusterIndex>,
  clusterId: number,
  limit = 50,
  offset = 0
): EventPoint[] {
  const leaves = index.getLeaves(clusterId, limit, offset) as PointFeature<{
    value: number;
  }>[];
  return leaves.map((l) => ({
    id: (l.id ?? "leaf").toString(),
    lon: l.geometry.coordinates[0],
    lat: l.geometry.coordinates[1],
    value: l.properties.value,
  }));
}

export function computeBbox(
  lon: number,
  lat: number,
  delta = 60
): [number, number, number, number] {
  return [lon - delta, lat - delta, lon + delta, lat + delta];
}

export function generateRandomEvents(
  count: number,
  center: [number, number],
  spreadDeg = 5
): EventPoint[] {
  const [clon, clat] = center;
  const pts: EventPoint[] = [];
  const adjectives = [
    "Красное",
    "Синее",
    "Быстрое",
    "Тихое",
    "Громкое",
    "Яркое",
    "Скрытое",
    "Большое",
    "Малое",
    "Дальнее",
  ];
  const nouns = [
    "Событие",
    "Сигнал",
    "Алерт",
    "Маркер",
    "Пакет",
    "Триггер",
    "Инцидент",
    "Импульс",
    "Отчёт",
    "Запрос",
  ];
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.random() * spreadDeg;
    const lon = clon + Math.cos(angle) * r;
    const lat = clat + Math.sin(angle) * r * 0.5; // squash lat spread
    const name = `${adjectives[i % adjectives.length]} ${
      nouns[i % nouns.length]
    } #${i}`;
    pts.push({
      id: `e${i}`,
      lon,
      lat,
      value: Math.round(Math.random() * 100),
      name,
    });
  }
  return pts;
}
