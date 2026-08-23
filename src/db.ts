import { openDB, type DBSchema } from 'idb'
import { DEFAULT_PIN_CATEGORY } from './pinCategories'
import { DEFAULT_SYSTEM_ID } from './systems'
import type { LayerDataset, MapAnnotation, MapAnnotationView, ObservationAttachment, ObservationComment, SpatialLayer, SpatialLayerView } from './types'

interface SpatialShareDB extends DBSchema {
  layers: {
    key: string
    value: SpatialLayer
    indexes: { 'by-created': string; 'by-system': string }
  }
  datasets: {
    key: string
    value: LayerDataset
    indexes: { 'by-layer': string }
  }
  annotations: {
    key: string
    value: MapAnnotation
    indexes: { 'by-created': string; 'by-system': string }
  }
  attachments: {
    key: string
    value: ObservationAttachment
    indexes: { 'by-annotation': string }
  }
  comments: {
    key: string
    value: ObservationComment
    indexes: { 'by-annotation': string; 'by-created': string }
  }
}

const dbPromise = openDB<SpatialShareDB>('common-ground-spatial-share', 2, {
  async upgrade(db, oldVersion, _newVersion, transaction) {
    if (oldVersion < 1) {
      const layers = db.createObjectStore('layers', { keyPath: 'id' })
      layers.createIndex('by-created', 'createdAt')
      const annotations = db.createObjectStore('annotations', { keyPath: 'id' })
      annotations.createIndex('by-created', 'createdAt')
    }
    if (oldVersion < 2) {
      const layers = transaction.objectStore('layers')
      const annotations = transaction.objectStore('annotations')
      if (!layers.indexNames.contains('by-system')) layers.createIndex('by-system', 'systemId')
      if (!annotations.indexNames.contains('by-system')) annotations.createIndex('by-system', 'systemId')
      const datasets = db.createObjectStore('datasets', { keyPath: 'id' })
      datasets.createIndex('by-layer', 'layerId')
      const attachments = db.createObjectStore('attachments', { keyPath: 'id' })
      attachments.createIndex('by-annotation', 'annotationId')
      const comments = db.createObjectStore('comments', { keyPath: 'id' })
      comments.createIndex('by-annotation', 'annotationId')
      comments.createIndex('by-created', 'createdAt')

      const oldLayers = await layers.getAll() as unknown as Array<Record<string, unknown>>
      for (const oldLayer of oldLayers) {
        const id = String(oldLayer.id)
        const datasetId = `dataset-${id}`
        const geojson = oldLayer.geojson as LayerDataset['geojson']
        const fieldNames = geojson?.features ? [...new Set(geojson.features.flatMap((feature) => Object.keys(feature.properties || {})))] : []
        const dataset: LayerDataset = {
          id: datasetId,
          layerId: id,
          format: oldLayer.format === 'Shapefile' ? 'Shapefile' : 'GeoJSON',
          originalFileName: String(oldLayer.originalFileName || 'data.geojson'),
          originalFile: oldLayer.originalFile instanceof Blob ? oldLayer.originalFile : new Blob(),
          geojson,
          crs: 'EPSG:4326',
          featureCount: Number(oldLayer.featureCount || 0),
          geometryTypes: Array.isArray(oldLayer.geometryTypes) ? oldLayer.geometryTypes.map(String) : [],
          fieldNames,
          schemaFingerprint: fieldNames.sort().join('|'),
          processingStatus: 'ready',
          createdAt: String(oldLayer.createdAt || new Date().toISOString()),
        }
        await datasets.put(dataset)
        const migrated: Record<string, unknown> = { ...oldLayer, systemId: DEFAULT_SYSTEM_ID, datasetId, contributorId: String(oldLayer.creatorDeviceId || ''), schemaVersion: 2 }
        delete migrated.visible
        delete migrated.selectedForExport
        delete migrated.format
        delete migrated.originalFileName
        delete migrated.originalFile
        delete migrated.geojson
        await layers.put(migrated as unknown as SpatialLayer)
      }

      const oldAnnotations = await annotations.getAll() as unknown as Array<Record<string, unknown>>
      for (const oldAnnotation of oldAnnotations) {
        const id = String(oldAnnotation.id)
        const legacyImage = oldAnnotation.image instanceof Blob ? oldAnnotation.image : undefined
        if (legacyImage) {
          await attachments.put({
            id: `attachment-${id}`,
            annotationId: id,
            type: 'image',
            fileName: String(oldAnnotation.imageName || 'field-photo.webp'),
            mimeType: legacyImage.type || 'image/webp',
            fileSize: legacyImage.size,
            blob: legacyImage,
            sortOrder: 0,
            createdAt: String(oldAnnotation.createdAt || new Date().toISOString()),
          })
        }
        const coordinates = Array.isArray(oldAnnotation.coordinates) ? oldAnnotation.coordinates : [103.8198, 1.3521]
        const migrated: Record<string, unknown> = {
          ...oldAnnotation,
          systemId: DEFAULT_SYSTEM_ID,
          geometry: { type: 'Point', coordinates },
          pinCategory: oldAnnotation.pinCategory || DEFAULT_PIN_CATEGORY,
          attachmentMode: legacyImage ? 'images' : 'none',
          contributorId: String(oldAnnotation.creatorDeviceId || ''),
          schemaVersion: 2,
        }
        delete migrated.coordinates
        delete migrated.image
        delete migrated.imageName
        delete migrated.oneDriveUrl
        await annotations.put(migrated as unknown as MapAnnotation)
      }
    }
  },
})

export const repository = {
  async getLayers() {
    const db = await dbPromise
    const layers = (await db.getAllFromIndex('layers', 'by-created')).reverse()
    const hydrated = await Promise.all(layers.map(async (layer) => {
      const dataset = await db.get('datasets', layer.datasetId)
      return dataset ? { ...layer, dataset } : null
    }))
    return hydrated.filter((layer): layer is SpatialLayerView => Boolean(layer))
  },
  async saveLayer(layer: SpatialLayerView) {
    const db = await dbPromise
    const transaction = db.transaction(['layers', 'datasets'], 'readwrite')
    const { dataset, ...metadata } = layer
    await Promise.all([transaction.objectStore('layers').put(metadata), transaction.objectStore('datasets').put(dataset), transaction.done])
  },
  async replaceLayerDataset(layer: SpatialLayerView, previousDatasetId: string) {
    const db = await dbPromise
    const transaction = db.transaction(['layers', 'datasets'], 'readwrite')
    const { dataset, ...metadata } = layer
    await transaction.objectStore('datasets').put(dataset)
    await transaction.objectStore('layers').put(metadata)
    if (previousDatasetId !== dataset.id) await transaction.objectStore('datasets').delete(previousDatasetId)
    await transaction.done
  },
  async deleteLayer(layer: SpatialLayerView) {
    const db = await dbPromise
    const transaction = db.transaction(['layers', 'datasets'], 'readwrite')
    await Promise.all([transaction.objectStore('layers').delete(layer.id), transaction.objectStore('datasets').delete(layer.datasetId), transaction.done])
  },
  async getAnnotations() {
    const db = await dbPromise
    const annotations = (await db.getAllFromIndex('annotations', 'by-created')).reverse()
    return Promise.all(annotations.map(async (annotation): Promise<MapAnnotationView> => ({
      ...annotation,
      attachments: await db.getAllFromIndex('attachments', 'by-annotation', annotation.id),
    })))
  },
  async saveAnnotation(annotation: MapAnnotationView) {
    const db = await dbPromise
    const transaction = db.transaction(['annotations', 'attachments'], 'readwrite')
    const { attachments, ...metadata } = annotation
    await transaction.objectStore('annotations').put(metadata)
    const oldAttachmentKeys = await transaction.objectStore('attachments').index('by-annotation').getAllKeys(annotation.id)
    await Promise.all(oldAttachmentKeys.map((key) => transaction.objectStore('attachments').delete(key)))
    await Promise.all(attachments.map((attachment) => transaction.objectStore('attachments').put(attachment)))
    await transaction.done
  },
  async deleteAnnotation(annotation: MapAnnotationView) {
    const db = await dbPromise
    const transaction = db.transaction(['annotations', 'attachments', 'comments'], 'readwrite')
    const attachmentKeys = await transaction.objectStore('attachments').index('by-annotation').getAllKeys(annotation.id)
    const commentKeys = await transaction.objectStore('comments').index('by-annotation').getAllKeys(annotation.id)
    await Promise.all(attachmentKeys.map((key) => transaction.objectStore('attachments').delete(key)))
    await Promise.all(commentKeys.map((key) => transaction.objectStore('comments').delete(key)))
    await transaction.objectStore('annotations').delete(annotation.id)
    await transaction.done
  },
  async getComments() {
    return (await (await dbPromise).getAllFromIndex('comments', 'by-created')).reverse()
  },
  async saveComment(comment: ObservationComment) {
    await (await dbPromise).put('comments', comment)
  },
  async deleteComment(commentId: string) {
    await (await dbPromise).delete('comments', commentId)
  },
}
