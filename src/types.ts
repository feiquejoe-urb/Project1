import type { FeatureCollection, GeoJsonProperties, Geometry, Point } from 'geojson'
import type { ResearchSystemId } from './systems'

export type LayerFormat = 'GeoJSON' | 'Shapefile'
export type StyleMode = 'single' | 'categorical' | 'graduated'
export type PinCategoryId = 'activity' | 'placemaking' | 'spatial' | 'story' | 'documentation' | 'issue'
export type AttachmentMode = 'none' | 'images' | 'pdf'

export interface SpatialLayer {
  id: string
  systemId: ResearchSystemId
  datasetId: string
  name: string
  description: string
  sourceNote: string
  processingNote: string
  contributorId: string
  contributorName: string
  creatorDeviceId: string
  createdAt: string
  updatedAt: string
  status: 'active' | 'hidden'
  opacity: number
  color: string
  styleMode?: StyleMode
  styleField?: string
  stylePalette?: string
  featureCount: number
  geometryTypes: string[]
  schemaVersion: 2
}

export interface LayerDataset {
  id: string
  layerId: string
  format: LayerFormat
  originalFileName: string
  originalFile?: Blob
  originalObjectPath?: string
  normalizedObjectPath?: string
  geojson: FeatureCollection<Geometry, GeoJsonProperties>
  crs: 'EPSG:4326'
  bbox?: [number, number, number, number]
  featureCount: number
  geometryTypes: string[]
  fieldNames: string[]
  schemaFingerprint: string
  processingStatus: 'ready' | 'failed'
  processingError?: string
  createdAt: string
}

export interface SpatialLayerView extends SpatialLayer {
  dataset: LayerDataset
}

export interface MapAnnotation {
  id: string
  systemId: ResearchSystemId
  title: string
  note: string
  geometry: Point
  pinCategory: PinCategoryId
  attachmentMode: AttachmentMode
  contributorId: string
  contributorName: string
  creatorDeviceId: string
  createdAt: string
  updatedAt: string
  status: 'active' | 'hidden'
  schemaVersion: 2
}

export interface ObservationAttachment {
  id: string
  annotationId: string
  type: 'image' | 'pdf'
  fileName: string
  mimeType: string
  fileSize: number
  blob?: Blob
  objectPath?: string
  url?: string
  sortOrder: number
  createdAt: string
}

export interface MapAnnotationView extends MapAnnotation {
  attachments: ObservationAttachment[]
}

export interface ObservationComment {
  id: string
  annotationId: string
  content: string
  contributorId: string
  contributorName: string
  creatorDeviceId: string
  createdAt: string
  updatedAt: string
}

export interface ContributorIdentity {
  id: string
  name: string
  deviceId: string
}

export type InspectorSelection =
  | { type: 'layer'; layerId: string }
  | { type: 'feature'; layerId: string; properties: GeoJsonProperties }
  | { type: 'annotation'; annotationId: string }
  | { type: 'pinGroup'; contributorName: string }
  | null
