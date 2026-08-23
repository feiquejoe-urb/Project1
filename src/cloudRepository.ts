import * as tus from 'tus-js-client'
import type { FeatureCollection, GeoJsonProperties, Geometry } from 'geojson'
import { requireSupabase } from './supabaseClient'
import type { DataRepository } from './repository.types'
import type { LayerDataset, MapAnnotationView, ObservationAttachment, ObservationComment, SpatialLayerView } from './types'
import type { ResearchSystemId } from './systems'

const TUS_THRESHOLD = 6 * 1024 * 1024
let sessionPromise: Promise<string> | null = null

function fail(error: { message: string } | null, context: string) {
  if (error) throw new Error(`${context}: ${error.message}`)
}

async function ensureSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const client = requireSupabase()
      const { data: existing, error: sessionError } = await client.auth.getSession()
      fail(sessionError, 'Could not restore your browser identity')
      if (existing.session?.user.id) return existing.session.user.id
      const { data, error } = await client.auth.signInAnonymously()
      fail(error, 'Could not create an anonymous browser identity')
      if (!data.user?.id) throw new Error('Supabase did not return a user identity.')
      return data.user.id
    })().catch((error) => { sessionPromise = null; throw error })
  }
  return sessionPromise
}

function safeFileName(name: string) {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || 'file'
}

async function uploadObject(bucket: string, path: string, body: Blob, contentType: string) {
  const client = requireSupabase()
  const userId = await ensureSession()
  if (body.size <= TUS_THRESHOLD) {
    const { error } = await client.storage.from(bucket).upload(path, body, { contentType, upsert: false })
    fail(error, `Could not upload ${safeFileName(path.split('/').pop() || 'file')}`)
    return
  }

  const { data: sessionData, error: sessionError } = await client.auth.getSession()
  fail(sessionError, 'Could not authorize the upload')
  const accessToken = sessionData.session?.access_token
  if (!accessToken) throw new Error('The upload session expired. Please reload and try again.')
  const projectUrl = String(import.meta.env.VITE_SUPABASE_URL).replace(/\/$/, '')
  await new Promise<void>((resolve, reject) => {
    const upload = new tus.Upload(body, {
      endpoint: `${projectUrl}/storage/v1/upload/resumable`,
      retryDelays: [0, 1000, 3000, 5000, 10000],
      headers: { authorization: `Bearer ${accessToken}`, 'x-upsert': 'false' },
      metadata: { bucketName: bucket, objectName: path, contentType, cacheControl: '3600', owner: userId },
      removeFingerprintOnSuccess: true,
      onError: (error) => reject(new Error(`Large file upload failed: ${error.message}`)),
      onSuccess: () => resolve(),
    })
    upload.findPreviousUploads().then((previous) => {
      if (previous[0]) upload.resumeFromPreviousUpload(previous[0])
      upload.start()
    }).catch(reject)
  })
}

async function removeObjects(bucket: string, paths: Array<string | undefined>) {
  const existing = paths.filter((path): path is string => Boolean(path))
  if (!existing.length) return
  const { error } = await requireSupabase().storage.from(bucket).remove(existing)
  fail(error, 'Could not remove stored files')
}

function layerRow(layer: SpatialLayerView, userId: string) {
  return {
    id: layer.id, system_id: layer.systemId, current_dataset_id: layer.datasetId,
    name: layer.name, description: layer.description, source_note: layer.sourceNote,
    processing_note: layer.processingNote, created_by: userId, contributor_name: layer.contributorName,
    created_at: layer.createdAt, updated_at: layer.updatedAt, status: layer.status,
    opacity: layer.opacity, color: layer.color, style_mode: layer.styleMode || 'single',
    style_field: layer.styleField || null, style_palette: layer.stylePalette || null,
    feature_count: layer.featureCount, geometry_types: layer.geometryTypes, schema_version: layer.schemaVersion,
  }
}

function datasetRow(dataset: LayerDataset) {
  return {
    id: dataset.id, layer_id: dataset.layerId, format: dataset.format,
    original_file_name: dataset.originalFileName, original_object_path: dataset.originalObjectPath,
    normalized_object_path: dataset.normalizedObjectPath, crs: dataset.crs, bbox: dataset.bbox || null,
    feature_count: dataset.featureCount, geometry_types: dataset.geometryTypes, field_names: dataset.fieldNames,
    schema_fingerprint: dataset.schemaFingerprint, processing_status: dataset.processingStatus,
    processing_error: dataset.processingError || null, created_at: dataset.createdAt,
  }
}

type DbRow = Record<string, unknown>

async function uploadDataset(layer: SpatialLayerView, userId: string) {
  const dataset = layer.dataset
  if (!dataset.originalFile) throw new Error('The original spatial file is missing.')
  const base = `${userId}/${layer.id}/${dataset.id}`
  const originalPath = `${base}/original-${safeFileName(dataset.originalFileName)}`
  const normalizedPath = `${base}/normalized.geojson`
  const normalized = new Blob([JSON.stringify(dataset.geojson)], { type: 'application/geo+json' })
  await uploadObject('spatial-data', originalPath, dataset.originalFile, dataset.originalFile.type || 'application/octet-stream')
  try {
    await uploadObject('spatial-data', normalizedPath, normalized, 'application/geo+json')
  } catch (error) {
    await removeObjects('spatial-data', [originalPath])
    throw error
  }
  return { ...dataset, originalObjectPath: originalPath, normalizedObjectPath: normalizedPath }
}

async function hydrateDataset(row: DbRow): Promise<LayerDataset> {
  const path = String(row.normalized_object_path)
  const { data, error } = await requireSupabase().storage.from('spatial-data').download(path)
  fail(error, `Could not load ${String(row.original_file_name)}`)
  const geojson = JSON.parse(await data!.text()) as FeatureCollection<Geometry, GeoJsonProperties>
  return {
    id: String(row.id), layerId: String(row.layer_id), format: row.format as LayerDataset['format'],
    originalFileName: String(row.original_file_name), originalObjectPath: String(row.original_object_path),
    normalizedObjectPath: path, geojson, crs: 'EPSG:4326',
    bbox: Array.isArray(row.bbox) ? row.bbox.map(Number) as [number, number, number, number] : undefined,
    featureCount: Number(row.feature_count), geometryTypes: (row.geometry_types as string[]) || [],
    fieldNames: (row.field_names as string[]) || [], schemaFingerprint: String(row.schema_fingerprint || ''),
    processingStatus: row.processing_status as LayerDataset['processingStatus'],
    processingError: row.processing_error ? String(row.processing_error) : undefined, createdAt: String(row.created_at),
  }
}

function attachmentBucket(type: ObservationAttachment['type']) {
  return type === 'pdf' ? 'observation-documents' : 'observation-images'
}

async function hydrateAttachment(row: DbRow): Promise<ObservationAttachment> {
  const type = row.type as ObservationAttachment['type']
  const objectPath = String(row.object_path)
  const { data, error } = await requireSupabase().storage.from(attachmentBucket(type)).createSignedUrl(objectPath, 3600)
  fail(error, `Could not open ${String(row.file_name)}`)
  return {
    id: String(row.id), annotationId: String(row.annotation_id), type, objectPath,
    url: data!.signedUrl, fileName: String(row.file_name), mimeType: String(row.mime_type),
    fileSize: Number(row.file_size), sortOrder: Number(row.sort_order), createdAt: String(row.created_at),
  }
}

export const cloudRepository: DataRepository = {
  ensureSession,

  async setDisplayName(name) {
    const id = await ensureSession()
    const { error } = await requireSupabase().from('profiles').upsert({ id, display_name: name, updated_at: new Date().toISOString() })
    fail(error, 'Could not save your display name')
  },

  async getLayers() {
    await ensureSession()
    const client = requireSupabase()
    const { data: layerRows, error } = await client.from('layers').select('*').order('created_at', { ascending: false })
    fail(error, 'Could not load map layers')
    const datasetIds = (layerRows || []).map((row) => row.current_dataset_id).filter(Boolean) as string[]
    if (!datasetIds.length) return []
    const { data: datasetRows, error: datasetError } = await client.from('layer_datasets').select('*').in('id', datasetIds)
    fail(datasetError, 'Could not load layer datasets')
    const datasets = new Map((datasetRows || []).map((row) => [String(row.id), row as DbRow]))
    const hydrated = await Promise.all((layerRows || []).map(async (row): Promise<SpatialLayerView | null> => {
      const datasetRowData = datasets.get(String(row.current_dataset_id))
      if (!datasetRowData) return null
      return {
        id: String(row.id), systemId: row.system_id as ResearchSystemId, datasetId: String(row.current_dataset_id),
        name: String(row.name), description: String(row.description), sourceNote: String(row.source_note),
        processingNote: String(row.processing_note), contributorId: String(row.created_by),
        contributorName: String(row.contributor_name), creatorDeviceId: String(row.created_by),
        createdAt: String(row.created_at), updatedAt: String(row.updated_at), status: row.status as 'active' | 'hidden',
        opacity: Number(row.opacity), color: String(row.color), styleMode: row.style_mode as SpatialLayerView['styleMode'],
        styleField: row.style_field ? String(row.style_field) : undefined,
        stylePalette: row.style_palette ? String(row.style_palette) : undefined,
        featureCount: Number(row.feature_count), geometryTypes: (row.geometry_types as string[]) || [],
        schemaVersion: 2, dataset: await hydrateDataset(datasetRowData),
      }
    }))
    return hydrated.filter((layer): layer is SpatialLayerView => Boolean(layer))
  },

  async saveLayer(layer) {
    const client = requireSupabase()
    const userId = await ensureSession()
    if (layer.dataset.originalObjectPath && layer.dataset.normalizedObjectPath) {
      const { error } = await client.from('layers').update(layerRow(layer, userId)).eq('id', layer.id)
      fail(error, 'Could not update the layer')
      return layer
    }
    const initialRow = { ...layerRow(layer, userId), current_dataset_id: null }
    const { error: layerError } = await client.from('layers').insert(initialRow)
    fail(layerError, 'Could not create the layer')
    let uploaded: LayerDataset | null = null
    try {
      uploaded = await uploadDataset(layer, userId)
      const { error: datasetError } = await client.from('layer_datasets').insert(datasetRow(uploaded))
      fail(datasetError, 'Could not save the layer dataset')
      const { error: pointerError } = await client.from('layers').update({ current_dataset_id: uploaded.id }).eq('id', layer.id)
      fail(pointerError, 'Could not activate the layer dataset')
      return { ...layer, dataset: uploaded }
    } catch (error) {
      if (uploaded) await removeObjects('spatial-data', [uploaded.originalObjectPath, uploaded.normalizedObjectPath])
      await client.from('layers').delete().eq('id', layer.id)
      throw error
    }
  },

  async replaceLayerDataset(layer, previousDatasetId) {
    const client = requireSupabase()
    const userId = await ensureSession()
    const { data: previous } = await client.from('layer_datasets').select('original_object_path,normalized_object_path').eq('id', previousDatasetId).maybeSingle()
    const uploaded = await uploadDataset(layer, userId)
    try {
      const { error: datasetError } = await client.from('layer_datasets').insert(datasetRow(uploaded))
      fail(datasetError, 'Could not save the replacement dataset')
      const row = layerRow({ ...layer, dataset: uploaded }, userId)
      const { error: metadataError } = await client.from('layers').update({ ...row, current_dataset_id: previousDatasetId }).eq('id', layer.id)
      fail(metadataError, 'Could not update layer details')
      const { error: swapError } = await client.rpc('replace_layer_dataset', { p_layer_id: layer.id, p_new_dataset_id: uploaded.id })
      fail(swapError, 'Could not activate the replacement dataset')
      if (previous) await removeObjects('spatial-data', [previous.original_object_path, previous.normalized_object_path])
      return { ...layer, dataset: uploaded }
    } catch (error) {
      await removeObjects('spatial-data', [uploaded.originalObjectPath, uploaded.normalizedObjectPath])
      throw error
    }
  },

  async deleteLayer(layer) {
    await ensureSession()
    await removeObjects('spatial-data', [layer.dataset.originalObjectPath, layer.dataset.normalizedObjectPath])
    const { error } = await requireSupabase().from('layers').delete().eq('id', layer.id)
    fail(error, 'Could not delete the layer')
  },

  async getOriginalFile(layer) {
    if (layer.dataset.originalFile) return layer.dataset.originalFile
    if (!layer.dataset.originalObjectPath) throw new Error('The original file location is missing.')
    const { data, error } = await requireSupabase().storage.from('spatial-data').download(layer.dataset.originalObjectPath)
    fail(error, 'Could not download the original file')
    return data!
  },

  async getAnnotations() {
    await ensureSession()
    const client = requireSupabase()
    const { data: rows, error } = await client.from('annotations').select('*').order('created_at', { ascending: false })
    fail(error, 'Could not load field observations')
    const ids = (rows || []).map((row) => String(row.id))
    let attachmentRows: DbRow[] = []
    if (ids.length) {
      const response = await client.from('attachments').select('*').in('annotation_id', ids).order('sort_order')
      fail(response.error, 'Could not load observation attachments')
      attachmentRows = (response.data || []) as DbRow[]
    }
    const grouped = new Map<string, DbRow[]>()
    for (const row of attachmentRows) grouped.set(String(row.annotation_id), [...(grouped.get(String(row.annotation_id)) || []), row])
    return Promise.all((rows || []).map(async (row): Promise<MapAnnotationView> => ({
      id: String(row.id), systemId: row.system_id as ResearchSystemId, title: String(row.title), note: String(row.note),
      geometry: { type: 'Point', coordinates: [Number(row.longitude), Number(row.latitude)] },
      pinCategory: row.pin_category as MapAnnotationView['pinCategory'], attachmentMode: row.attachment_mode as MapAnnotationView['attachmentMode'],
      contributorId: String(row.created_by), contributorName: String(row.contributor_name), creatorDeviceId: String(row.created_by),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at), status: row.status as 'active' | 'hidden', schemaVersion: 2,
      attachments: await Promise.all((grouped.get(String(row.id)) || []).map(hydrateAttachment)),
    })))
  },

  async saveAnnotation(annotation) {
    const client = requireSupabase()
    const userId = await ensureSession()
    const [longitude, latitude] = annotation.geometry.coordinates
    const annotationRow = {
      id: annotation.id, system_id: annotation.systemId, title: annotation.title, note: annotation.note,
      longitude, latitude, pin_category: annotation.pinCategory, attachment_mode: annotation.attachmentMode,
      created_by: userId, contributor_name: annotation.contributorName, created_at: annotation.createdAt,
      updated_at: annotation.updatedAt, status: annotation.status, schema_version: annotation.schemaVersion,
    }
    const { error: annotationError } = await client.from('annotations').upsert(annotationRow)
    fail(annotationError, 'Could not save the field observation')
    const { data: oldRows, error: oldError } = await client.from('attachments').select('*').eq('annotation_id', annotation.id)
    fail(oldError, 'Could not compare observation attachments')
    const keptIds = new Set(annotation.attachments.map((item) => item.id))
    const removed = (oldRows || []).filter((row) => !keptIds.has(String(row.id)))
    for (const row of removed) await removeObjects(attachmentBucket(row.type as ObservationAttachment['type']), [String(row.object_path)])
    if (removed.length) {
      const { error } = await client.from('attachments').delete().in('id', removed.map((row) => row.id))
      fail(error, 'Could not remove old attachments')
    }

    const saved: ObservationAttachment[] = []
    for (const attachment of annotation.attachments) {
      if (attachment.objectPath) { saved.push(attachment); continue }
      if (!attachment.blob) throw new Error(`Attachment data is missing for ${attachment.fileName}.`)
      const extension = safeFileName(attachment.fileName).split('.').pop() || (attachment.type === 'pdf' ? 'pdf' : 'bin')
      const path = `${userId}/${annotation.id}/${attachment.id}.${extension}`
      const bucket = attachmentBucket(attachment.type)
      await uploadObject(bucket, path, attachment.blob, attachment.mimeType)
      const row = {
        id: attachment.id, annotation_id: annotation.id, type: attachment.type, object_path: path,
        file_name: attachment.fileName, mime_type: attachment.mimeType, file_size: attachment.fileSize,
        sort_order: attachment.sortOrder, created_at: attachment.createdAt,
      }
      const { error } = await client.from('attachments').upsert(row)
      if (error) { await removeObjects(bucket, [path]); fail(error, `Could not save ${attachment.fileName}`) }
      const { data: signed, error: signedError } = await client.storage.from(bucket).createSignedUrl(path, 3600)
      fail(signedError, `Could not open ${attachment.fileName}`)
      saved.push({ ...attachment, objectPath: path, url: signed!.signedUrl })
    }
    return { ...annotation, contributorId: userId, creatorDeviceId: userId, attachments: saved }
  },

  async deleteAnnotation(annotation) {
    await ensureSession()
    for (const attachment of annotation.attachments) await removeObjects(attachmentBucket(attachment.type), [attachment.objectPath])
    const { error } = await requireSupabase().from('annotations').delete().eq('id', annotation.id)
    fail(error, 'Could not delete the field observation')
  },

  async getComments() {
    await ensureSession()
    const { data, error } = await requireSupabase().from('comments').select('*').order('created_at', { ascending: false })
    fail(error, 'Could not load comments')
    return (data || []).map((row): ObservationComment => ({
      id: String(row.id), annotationId: String(row.annotation_id), content: String(row.content),
      contributorId: String(row.created_by), contributorName: String(row.contributor_name), creatorDeviceId: String(row.created_by),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }))
  },

  async saveComment(comment) {
    const userId = await ensureSession()
    const { error } = await requireSupabase().from('comments').upsert({
      id: comment.id, annotation_id: comment.annotationId, content: comment.content, created_by: userId,
      contributor_name: comment.contributorName, created_at: comment.createdAt, updated_at: comment.updatedAt,
    })
    fail(error, 'Could not save the comment')
  },

  async deleteComment(commentId) {
    await ensureSession()
    const { error } = await requireSupabase().from('comments').delete().eq('id', commentId)
    fail(error, 'Could not delete the comment')
  },

  subscribe(onChange) {
    const client = requireSupabase()
    let timer = 0
    const schedule = () => { window.clearTimeout(timer); timer = window.setTimeout(onChange, 350) }
    const channel = client.channel('common-ground-live')
    for (const table of ['layers', 'layer_datasets', 'annotations', 'attachments', 'comments']) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, schedule)
    }
    channel.subscribe()
    return () => { window.clearTimeout(timer); void client.removeChannel(channel) }
  },
}
