import type { Feature, FeatureCollection, GeoJsonProperties, Geometry, GeoJsonObject } from 'geojson'
import shp from 'shpjs'

export const MAX_GEOJSON_BYTES = 20 * 1024 * 1024
export const MAX_SHAPEFILE_BYTES = 50 * 1024 * 1024
export const MAX_FEATURES_PER_LAYER = 30_000

const isGeometry = (value: GeoJsonObject): value is Geometry =>
  ['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection'].includes(value.type)

export function normalizeGeoJSON(input: GeoJsonObject): FeatureCollection<Geometry, GeoJsonProperties> {
  if (input.type === 'FeatureCollection') return input as FeatureCollection<Geometry, GeoJsonProperties>
  if (input.type === 'Feature') return { type: 'FeatureCollection', features: [input as Feature<Geometry>] }
  if (isGeometry(input)) {
    return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: input }] }
  }
  throw new Error('This file is not valid GeoJSON.')
}

export interface ParsedSpatialFile {
  suggestedName: string
  geojson: FeatureCollection<Geometry, GeoJsonProperties>
}

export async function parseSpatialFile(file: File): Promise<ParsedSpatialFile[]> {
  const lower = file.name.toLowerCase()
  const sizeLimit = lower.endsWith('.zip') ? MAX_SHAPEFILE_BYTES : MAX_GEOJSON_BYTES
  if (file.size > sizeLimit) throw new Error(`This file is larger than the ${Math.round(sizeLimit / 1024 / 1024)} MB prototype limit.`)
  if (lower.endsWith('.geojson') || lower.endsWith('.json')) {
    const parsed = JSON.parse(await file.text()) as GeoJsonObject
    const geojson = normalizeGeoJSON(parsed)
    validateSpatialData(geojson)
    return [{ suggestedName: file.name.replace(/\.(geo)?json$/i, ''), geojson }]
  }
  if (lower.endsWith('.zip')) {
    const parsed = await shp(await file.arrayBuffer())
    const results = Array.isArray(parsed) ? parsed : [parsed]
    return results.map((item, index) => {
      const geojson = normalizeGeoJSON(item as GeoJsonObject)
      validateSpatialData(geojson)
      return {
        suggestedName: (item as FeatureCollection & { fileName?: string }).fileName || file.name.replace(/\.zip$/i, '') + (results.length > 1 ? ` ${index + 1}` : ''),
        geojson,
      }
    })
  }
  throw new Error('Choose a .geojson, .json, or zipped Shapefile.')
}

function validateSpatialData(data: FeatureCollection<Geometry, GeoJsonProperties>) {
  if (data.features.length > MAX_FEATURES_PER_LAYER) throw new Error(`This layer has ${data.features.length.toLocaleString()} features. The prototype limit is ${MAX_FEATURES_PER_LAYER.toLocaleString()}. Split or simplify the data first.`)
  const bounds = getGeoJSONBounds(data)
  if (!bounds) throw new Error('This layer has no readable coordinates.')
  const [[minLng, minLat], [maxLng, maxLat]] = bounds
  if (minLng < -180 || maxLng > 180 || minLat < -90 || maxLat > 90) {
    throw new Error('Coordinates are outside the WGS84 longitude/latitude range. Reproject the file to EPSG:4326 before uploading.')
  }
}

export function describeGeoJSON(data: FeatureCollection<Geometry, GeoJsonProperties>) {
  const geometryTypes = [...new Set(data.features.map((feature) => feature.geometry?.type).filter(Boolean))] as string[]
  return { featureCount: data.features.length, geometryTypes }
}

export function getGeoJSONBounds(data: FeatureCollection<Geometry, GeoJsonProperties>): [[number, number], [number, number]] | null {
  let minLng = Infinity
  let minLat = Infinity
  let maxLng = -Infinity
  let maxLat = -Infinity

  const visit = (value: unknown) => {
    if (!Array.isArray(value)) return
    if (typeof value[0] === 'number' && typeof value[1] === 'number') {
      const [lng, lat] = value as number[]
      minLng = Math.min(minLng, lng)
      minLat = Math.min(minLat, lat)
      maxLng = Math.max(maxLng, lng)
      maxLat = Math.max(maxLat, lat)
      return
    }
    value.forEach(visit)
  }

  data.features.forEach((feature) => {
    if (feature.geometry && 'coordinates' in feature.geometry) visit(feature.geometry.coordinates)
    if (feature.geometry?.type === 'GeometryCollection') feature.geometry.geometries.forEach((geometry) => {
      if ('coordinates' in geometry) visit(geometry.coordinates)
    })
  })
  if (!Number.isFinite(minLng)) return null
  return [[minLng, minLat], [maxLng, maxLat]]
}
