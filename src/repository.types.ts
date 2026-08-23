import type { MapAnnotationView, ObservationComment, SpatialLayerView } from './types'

export interface DataRepository {
  ensureSession(): Promise<string>
  setDisplayName(name: string): Promise<void>
  getLayers(): Promise<SpatialLayerView[]>
  saveLayer(layer: SpatialLayerView): Promise<SpatialLayerView>
  replaceLayerDataset(layer: SpatialLayerView, previousDatasetId: string): Promise<SpatialLayerView>
  deleteLayer(layer: SpatialLayerView): Promise<void>
  getOriginalFile(layer: SpatialLayerView): Promise<Blob>
  getAnnotations(): Promise<MapAnnotationView[]>
  saveAnnotation(annotation: MapAnnotationView): Promise<MapAnnotationView>
  deleteAnnotation(annotation: MapAnnotationView): Promise<void>
  getComments(): Promise<ObservationComment[]>
  saveComment(comment: ObservationComment): Promise<void>
  deleteComment(commentId: string): Promise<void>
  subscribe(onChange: () => void): () => void
}
