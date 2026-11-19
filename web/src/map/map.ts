// The map: STAF's basemaps and controls (apps/staf-web/src/app/map.ts: USGS Topo shown, USGS
// Imagery, the Layers control top right, the scale bottom right), the reach canvas, the HUC8
// coverage outlines (where the reach layer is built), the HUC12 outlines a study area is picked
// from, and the legend under the Layers control.
import L from 'leaflet'

const USGS_TOPO_URL = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}'
const USGS_IMAGERY_URL = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}'
const USGS_ATTR = 'USGS The National Map'

/** The view the app opens on: the lower 48. */
export const START = { lat: 38.5, lon: -95.5, zoom: 5 }

/** Panes: the outlines under the reaches, the reaches under the markers. */
export const PANES = { outlines: 'fprOutlines', units: 'fprUnits', marks: 'fprMarks' }

function usgs(url: string): L.TileLayer {
  return L.tileLayer(url, { attribution: USGS_ATTR, maxNativeZoom: 16, maxZoom: 19 })
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
  const imagery = usgs(USGS_IMAGERY_URL)
  const topo = usgs(USGS_TOPO_URL)
  topo.addTo(map)
  Object.assign(map.createPane(PANES.outlines).style, { zIndex: '380' })
  Object.assign(map.createPane(PANES.units).style, { zIndex: '420', pointerEvents: 'none' })
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
