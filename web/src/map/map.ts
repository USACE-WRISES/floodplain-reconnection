// The map: STAF's basemaps and controls (apps/staf-web/src/app/map.ts: USGS Topo shown, USGS
// Imagery, the Layers control top right, the scale bottom right), the reach canvas, the HUC8
// coverage outlines (where the reach layer is built), the HUC12 outlines a study area is picked
// from, and the legend under the Layers control.
import L from 'leaflet'

const USGS_TOPO_URL = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}'
// The National Map's orthoimagery alone: USGS retired the imagery-with-topo-labels service
// (USGSImageryTopo answered "not found" on 2026-11-19), and its server now lists only USGSHydroCached,
// USGSImageryOnly, USGSShadedReliefOnly and USGSTopo. Tiles to zoom 16, as before.
const USGS_IMAGERY_URL = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}'
const USGS_ATTR = 'USGS The National Map'
/** the imagery service's own credit line */
const USGS_IMAGERY_ATTR = 'USDA, USGS The National Map: Orthoimagery'

/** The view the app opens on: the lower 48. */
export const START = { lat: 38.5, lon: -95.5, zoom: 5 }

/** Panes: the outlines under the reaches, the hovered reach and the chosen site just over them (a canvas
 * of their own, so a hover never repaints the reaches), the markers on top. */
export const PANES = { outlines: 'fprOutlines', units: 'fprUnits', highlight: 'fprHighlight', marks: 'fprMarks' }

function usgs(url: string, attribution = USGS_ATTR): L.TileLayer {
  return L.tileLayer(url, { attribution, maxNativeZoom: 16, maxZoom: 19 })
}

export interface AppMap {
  map: L.Map
  layers: L.Control.Layers
  legend: HTMLElement
  /** the coverage outlines (HUC8) */
  coverage: L.LayerGroup
  /** the HUC12 outlines a study area is picked from */
  picks: L.LayerGroup
}

export function makeMap(box: HTMLElement): AppMap {
  const map = L.map(box, {
    center: [START.lat, START.lon], zoom: START.zoom, maxZoom: 19, minZoom: 3, zoomControl: false,
    attributionControl: false, zoomSnap: 1, inertiaDeceleration: 3000, inertiaMaxSpeed: 1500,
  })
  L.control.zoom({ position: 'topleft', zoomInText: '+', zoomOutText: '-' }).addTo(map)
  L.control.attribution({ position: 'bottomright', prefix: 'Leaflet' }).addTo(map)
  const imagery = usgs(USGS_IMAGERY_URL, USGS_IMAGERY_ATTR)
  const topo = usgs(USGS_TOPO_URL)
  topo.addTo(map)
  Object.assign(map.createPane(PANES.outlines).style, { zIndex: '380' })
  Object.assign(map.createPane(PANES.units).style, { zIndex: '420', pointerEvents: 'none' })
  Object.assign(map.createPane(PANES.highlight).style, { zIndex: '430', pointerEvents: 'none' })
  Object.assign(map.createPane(PANES.marks).style, { zIndex: '640' })
  const coverage = L.layerGroup().addTo(map)
  const picks = L.layerGroup().addTo(map)
  const layers = L.control.layers({ 'USGS Topo': topo, 'USGS Imagery': imagery },
    { 'Where reaches are built': coverage, 'Watersheds (HUC12)': picks }, { position: 'topright' }).addTo(map)
  L.control.scale({ position: 'bottomright', metric: true, imperial: true }).addTo(map)
  const Legend = L.Control.extend({
    onAdd() {
      const div = L.DomUtil.create('div', 'fpr-legend leaflet-control')
      L.DomEvent.disableClickPropagation(div)
      L.DomEvent.disableScrollPropagation(div)
      return div
    },
  })
  const control = new Legend({ position: 'topright' })
  control.addTo(map)
  const legend = control.getContainer() as HTMLElement
  return { map, layers, legend, coverage, picks }
}

/** A canvas renderer for outlines (many polygons, clickable). */
export function outlineRenderer(): L.Canvas {
  return L.canvas({ padding: 0.3, pane: PANES.outlines })
}
