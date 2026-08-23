import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import maplibregl, { type Map as MapLibreMap, type MapMouseEvent } from 'maplibre-gl'
import JSZip from 'jszip'
import type { GeoJsonProperties } from 'geojson'
import { repository } from './db'
import { describeGeoJSON, getGeoJSONBounds, parseSpatialFile, type ParsedSpatialFile } from './geo'
import { compressImage, formatBytes } from './image'
import { DEFAULT_PIN_CATEGORY, getPinCategory, getPinColorExpression, PIN_CATEGORIES } from './pinCategories'
import { buildColorExpression, COLOR_PALETTES, formatStat, getDefaultStyle, getLegendEntries, getPalette, summarizeAttributes, type AttributeField } from './symbology'
import type { ContributorIdentity, InspectorSelection, MapAnnotation, PinCategoryId, SpatialLayer, StyleMode } from './types'

const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty'
const SINGAPORE_CENTER: [number, number] = [103.8198, 1.3521]

function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`
}

function getIdentity(): ContributorIdentity | null {
  const name = localStorage.getItem('common-ground-name')
  const deviceId = localStorage.getItem('common-ground-device')
  return name && deviceId ? { name, deviceId } : null
}

function App() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const layersRef = useRef<SpatialLayer[]>([])
  const annotationsRef = useRef<MapAnnotation[]>([])
  const annotationModeRef = useRef(false)
  const [identity, setIdentity] = useState<ContributorIdentity | null>(getIdentity)
  const [layers, setLayers] = useState<SpatialLayer[]>([])
  const [annotations, setAnnotations] = useState<MapAnnotation[]>([])
  const [mapReady, setMapReady] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [annotationMode, setAnnotationMode] = useState(false)
  const [pendingCoordinates, setPendingCoordinates] = useState<[number, number] | null>(null)
  const [editingAnnotation, setEditingAnnotation] = useState<MapAnnotation | null>(null)
  const [editingLayer, setEditingLayer] = useState<SpatialLayer | null>(null)
  const [stylingLayer, setStylingLayer] = useState<SpatialLayer | null>(null)
  const [tableLayer, setTableLayer] = useState<SpatialLayer | null>(null)
  const [selection, setSelection] = useState<InspectorSelection>(null)
  const [hiddenPinContributors, setHiddenPinContributors] = useState<string[]>([])
  const [toast, setToast] = useState('')
  const [loading, setLoading] = useState(true)

  layersRef.current = layers
  annotationsRef.current = annotations
  annotationModeRef.current = annotationMode

  const notify = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(''), 3200)
  }, [])

  useEffect(() => {
    Promise.all([repository.getLayers(), repository.getAnnotations()])
      .then(([savedLayers, savedAnnotations]) => {
        setLayers(savedLayers)
        setAnnotations(savedAnnotations)
      })
      .catch(() => notify('Local data could not be opened.'))
      .finally(() => setLoading(false))
  }, [notify])

  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return
    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: MAP_STYLE,
      center: SINGAPORE_CENTER,
      zoom: 10.7,
      minZoom: 9,
      maxZoom: 18,
      attributionControl: false,
    })
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right')
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right')
    map.on('load', () => setMapReady(true))
    map.on('click', (event: MapMouseEvent) => {
      if (annotationModeRef.current) {
        setPendingCoordinates([event.lngLat.lng, event.lngLat.lat])
        setAnnotationMode(false)
        return
      }
      const annotationHits = map.getLayer('annotation-points')
        ? map.queryRenderedFeatures(event.point, { layers: ['annotation-points'] })
        : []
      const annotationHit = annotationHits[0]
      if (annotationHit) {
        const annotationId = String(annotationHit.properties?.annotationId || '')
        if (annotationId) setSelection({ type: 'annotation', annotationId })
        return
      }
      const styleLayers = map.getStyle().layers || []
      const interactiveIds = styleLayers
        .filter((layer) => layer.id.startsWith('dataset-'))
        .map((layer) => layer.id)
      const hits = interactiveIds.length ? map.queryRenderedFeatures(event.point, { layers: interactiveIds }) : []
      const hit = hits[0]
      if (!hit) {
        setSelection(null)
        return
      }
      const metadataLayerId = (hit.layer.metadata as { spatialLayerId?: string } | undefined)?.spatialLayerId
      const matchedLayerId = metadataLayerId || layersRef.current.find((item) => hit.layer.id.startsWith(`dataset-${item.id}-`))?.id
      if (matchedLayerId) setSelection({ type: 'feature', layerId: matchedLayerId, properties: hit.properties || {} })
    })
    map.on('mousemove', (event) => {
      if (annotationModeRef.current) {
        map.getCanvas().style.cursor = 'crosshair'
        return
      }
      const interactiveIds = (map.getStyle().layers || [])
        .filter((layer) => layer.id === 'annotation-points' || layer.id.startsWith('dataset-'))
        .map((layer) => layer.id)
      const hasFeature = interactiveIds.length && map.queryRenderedFeatures(event.point, { layers: interactiveIds }).length > 0
      map.getCanvas().style.cursor = hasFeature ? 'pointer' : ''
    })
    mapRef.current = map
    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const activeLayers = layers.filter((layer) => layer.status === 'active')
    const wantedIds = new Set(activeLayers.flatMap((layer) => [`dataset-${layer.id}-fill`, `dataset-${layer.id}-line`, `dataset-${layer.id}-point`]))
    ;(map.getStyle().layers || [])
      .filter((layer) => layer.id.startsWith('dataset-') && !wantedIds.has(layer.id))
      .forEach((layer) => map.removeLayer(layer.id))

    activeLayers.forEach((layer) => {
      const sourceId = `source-${layer.id}`
      const existingSource = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined
      if (existingSource) existingSource.setData(layer.geojson)
      else map.addSource(sourceId, { type: 'geojson', data: layer.geojson })

      const visibility = layer.visible ? 'visible' : 'none'
      const color = buildColorExpression(layer)
      const definitions: Array<{ id: string; type: 'fill' | 'line' | 'circle'; filter: maplibregl.FilterSpecification; paint: Record<string, unknown> }> = [
        { id: `dataset-${layer.id}-fill`, type: 'fill', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': color, 'fill-opacity': layer.opacity * 0.45, 'fill-outline-color': color } },
        { id: `dataset-${layer.id}-line`, type: 'line', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': color, 'line-opacity': layer.opacity, 'line-width': 3 } },
        { id: `dataset-${layer.id}-point`, type: 'circle', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-color': color, 'circle-opacity': layer.opacity, 'circle-radius': 6, 'circle-stroke-color': '#fffdf8', 'circle-stroke-width': 1.5 } },
      ]
      definitions.forEach((definition) => {
        if (!map.getLayer(definition.id)) {
          map.addLayer({ ...definition, source: sourceId, layout: { visibility }, metadata: { spatialLayerId: layer.id } } as maplibregl.LayerSpecification)
        } else {
          map.setLayoutProperty(definition.id, 'visibility', visibility)
          Object.entries(definition.paint).forEach(([property, value]) => map.setPaintProperty(definition.id, property, value))
        }
      })
    })

    const currentSourceIds = Object.keys(map.getStyle().sources).filter((id) => id.startsWith('source-'))
    currentSourceIds.forEach((id) => {
      const layerId = id.replace('source-', '')
      if (!activeLayers.some((layer) => layer.id === layerId) && map.getSource(id)) map.removeSource(id)
    })
    if (map.getLayer('annotation-points')) map.moveLayer('annotation-points')
  }, [layers, mapReady])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const data = {
      type: 'FeatureCollection' as const,
      features: annotations.filter((item) => item.status === 'active' && !hiddenPinContributors.includes(item.contributorName)).map((item) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: item.coordinates },
        properties: { annotationId: item.id, pinCategory: item.pinCategory || DEFAULT_PIN_CATEGORY },
      })),
    }
    const source = map.getSource('annotations') as maplibregl.GeoJSONSource | undefined
    if (source) source.setData(data)
    else {
      map.addSource('annotations', { type: 'geojson', data })
      map.addLayer({
        id: 'annotation-points',
        type: 'circle',
        source: 'annotations',
        paint: {
          'circle-color': getPinColorExpression(),
          'circle-radius': 6.4,
          'circle-stroke-color': '#172921',
          'circle-stroke-width': 2.4,
        },
      })
    }
    if (map.getLayer('annotation-points')) {
      map.setPaintProperty('annotation-points', 'circle-color', getPinColorExpression())
      map.setPaintProperty('annotation-points', 'circle-radius', 6.4)
      map.setPaintProperty('annotation-points', 'circle-stroke-width', 2.4)
      map.moveLayer('annotation-points')
    }
  }, [annotations, hiddenPinContributors, mapReady])

  async function updateLayer(layer: SpatialLayer) {
    setLayers((current) => current.map((item) => item.id === layer.id ? layer : item))
    await repository.saveLayer(layer)
  }

  async function updateAnnotation(annotation: MapAnnotation) {
    setAnnotations((current) => current.map((item) => item.id === annotation.id ? annotation : item))
    await repository.saveAnnotation(annotation)
  }

  async function exportSelected() {
    const selected = layers.filter((layer) => layer.status === 'active' && layer.selectedForExport)
    if (!selected.length) return notify('Select at least one layer to download.')
    const zip = new JSZip()
    const manifest = selected.map(({ originalFile: _file, geojson: _geojson, ...layer }) => layer)
    zip.file('manifest.json', JSON.stringify(manifest, null, 2))
    selected.forEach((layer) => {
      const folder = zip.folder(layer.name.replace(/[<>:"/\\|?*]/g, '-'))!
      folder.file(layer.originalFileName, layer.originalFile)
      folder.file('metadata.json', JSON.stringify({
        name: layer.name,
        description: layer.description,
        source: layer.sourceNote,
        processing: layer.processingNote,
        contributor: layer.contributorName,
        featureCount: layer.featureCount,
        geometryTypes: layer.geometryTypes,
        uploadedAt: layer.createdAt,
      }, null, 2))
      folder.file('normalized.geojson', JSON.stringify(layer.geojson))
    })
    const blob = await zip.generateAsync({ type: 'blob' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `common-ground-layers-${new Date().toISOString().slice(0, 10)}.zip`
    anchor.click()
    URL.revokeObjectURL(url)
    notify(`${selected.length} layer${selected.length > 1 ? 's' : ''} packaged for download.`)
  }

  const selectedLayerCount = layers.filter((layer) => layer.status === 'active' && layer.selectedForExport).length
  const activeLayers = layers.filter((layer) => layer.status === 'active')
  const activeAnnotations = annotations.filter((item) => item.status === 'active')
  const pinGroups = [...new Set(activeAnnotations.map((annotation) => annotation.contributorName))]
    .map((contributorName) => ({ contributorName, annotations: activeAnnotations.filter((annotation) => annotation.contributorName === contributorName) }))

  function togglePinGroup(contributorName: string) {
    setHiddenPinContributors((current) => current.includes(contributorName)
      ? current.filter((name) => name !== contributorName)
      : [...current, contributorName])
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark">CG</div>
          <div><strong>Common Ground</strong><span>NUS spatial share</span></div>
        </div>
        <div className="topbar-actions">
          <div className="status-pill"><i /> Local prototype</div>
          <button className="button ghost" onClick={() => setAnnotationMode((value) => !value)}>{annotationMode ? 'Cancel pin' : '+ Add map pin'}</button>
          <button className="button primary" onClick={() => setUploadOpen(true)}>Upload layer</button>
          <button className="identity-button" onClick={() => setIdentity(null)} title="Change contributor name">
            <span>{identity?.name?.slice(0, 1).toUpperCase() || '?'}</span>{identity?.name || 'Set name'}
          </button>
        </div>
      </header>

      <main className="workspace">
        <aside className="sidebar">
          <section className="sidebar-intro">
            <p className="eyebrow">CLASS ATLAS</p>
            <h1>Singapore, seen together.</h1>
            <p>Layer class datasets, leave field notes, and keep the source attached.</p>
          </section>

          <section className="panel-section layer-section">
            <div className="section-heading"><div><span>DATA LAYERS</span><b>{activeLayers.length}</b></div><button onClick={() => setUploadOpen(true)}>＋</button></div>
            {loading ? <div className="empty-card">Opening local workspace…</div> : activeLayers.length === 0 ? (
              <button className="empty-card interactive" onClick={() => setUploadOpen(true)}><strong>No layers yet</strong><span>Upload GeoJSON or a zipped Shapefile.</span></button>
            ) : (
              <div className="layer-list">
                {activeLayers.map((layer) => (
                  <div className={`layer-card ${selection?.type === 'layer' && selection.layerId === layer.id ? 'active' : ''}`} key={layer.id}>
                    <div className="layer-card-main">
                      <button className={`layer-visibility-box ${layer.visible ? 'on' : ''}`} aria-label={layer.visible ? `Hide ${layer.name}` : `Show ${layer.name}`} onClick={() => updateLayer({ ...layer, visible: !layer.visible })}>{layer.visible ? '✓' : ''}</button>
                      <button className="layer-title" onClick={() => setSelection({ type: 'layer', layerId: layer.id })}>
                        <i style={{ background: layer.styleMode && layer.styleMode !== 'single' ? `linear-gradient(180deg, ${getPalette(layer.stylePalette).colors.join(',')})` : layer.color }} /><span><strong>{layer.name}</strong><small>{layer.featureCount.toLocaleString()} features · {layer.styleMode === 'categorical' ? 'Unique values' : layer.styleMode === 'graduated' ? 'Graduated' : layer.format}</small></span>
                      </button>
                      <div className="export-toggle" title="Select this layer for download"><span aria-hidden="true">↓</span><label><input aria-label={`Select ${layer.name} for download`} type="checkbox" checked={layer.selectedForExport} onChange={() => updateLayer({ ...layer, selectedForExport: !layer.selectedForExport })} /><i /></label></div>
                    </div>
                    {layer.visible && <div className="opacity-row"><span>Opacity</span><input type="range" min="0.15" max="1" step="0.05" value={layer.opacity} onChange={(event) => updateLayer({ ...layer, opacity: Number(event.target.value) })} /></div>}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="panel-section">
            <div className="section-heading"><div><span>FIELD PINS</span><b>{activeAnnotations.length}</b></div></div>
            {pinGroups.length > 0 && <div className="layer-list pin-layer-list">
              {pinGroups.map((group) => {
                const visible = !hiddenPinContributors.includes(group.contributorName)
                const groupColors = [...new Set(group.annotations.map((annotation) => getPinCategory(annotation.pinCategory).color))]
                return <div className={`layer-card pin-layer-card ${selection?.type === 'pinGroup' && selection.contributorName === group.contributorName ? 'active' : ''}`} key={group.contributorName}>
                  <div className="layer-card-main pin-layer-main">
                    <button className={`layer-visibility-box ${visible ? 'on' : ''}`} aria-label={visible ? `Hide ${group.contributorName} pins` : `Show ${group.contributorName} pins`} onClick={() => togglePinGroup(group.contributorName)}>{visible ? '✓' : ''}</button>
                    <button className="layer-title" onClick={() => setSelection({ type: 'pinGroup', contributorName: group.contributorName })}>
                      <i className="pin-layer-mark" style={{ background: groupColors.length > 1 ? `conic-gradient(${groupColors.join(',')})` : groupColors[0] }} /><span><strong>{group.contributorName}</strong><small>{group.annotations.length} field pin{group.annotations.length > 1 ? 's' : ''}</small></span>
                    </button>
                    <span className="pin-layer-count">{group.annotations.length}</span>
                  </div>
                </div>
              })}
            </div>}
            <div className="pin-type-key"><span>PIN TYPES</span><div>{PIN_CATEGORIES.map((category) => <span key={category.id} title={category.description}><i style={{ background: category.color }} />{category.shortLabel}</span>)}</div></div>
            <button className="pin-callout" onClick={() => setAnnotationMode(true)}><span>＋</span><div><strong>Place a pin</strong><small>Choose a type, then add evidence and notes</small></div></button>
          </section>

          <div className="sidebar-footer">
            <button className="download-button" onClick={exportSelected} disabled={!selectedLayerCount}><span>↓</span><div><strong>Download selected</strong><small>{selectedLayerCount ? `${selectedLayerCount} layer${selectedLayerCount > 1 ? 's' : ''} ready` : 'Select layers above'}</small></div></button>
            <p>Stored only in this browser for the prototype.</p>
          </div>
        </aside>

        <section className={`map-stage ${annotationMode ? 'placing' : ''}`}>
          <div ref={mapContainer} className="map-container" />
          <div className="map-title"><span>01° 21′ N</span><strong>Singapore field map</strong></div>
          <div className="map-stats"><div><strong>{activeLayers.length}</strong><span>layers</span></div><div><strong>{activeAnnotations.length}</strong><span>field pins</span></div></div>
          {annotationMode && <div className="placing-banner"><strong>Click anywhere on the map</strong><span>to place a new field pin</span><button onClick={() => setAnnotationMode(false)}>Cancel</button></div>}
          {selection && <Inspector selection={selection} layers={layers} annotations={annotations} identity={identity} onClose={() => setSelection(null)} onSelectAnnotation={(annotation) => setSelection({ type: 'annotation', annotationId: annotation.id })} onEditLayer={setEditingLayer} onStyleLayer={setStylingLayer} onOpenTable={setTableLayer} onEditAnnotation={setEditingAnnotation} onHideLayer={(layer) => updateLayer({ ...layer, status: 'hidden', updatedAt: new Date().toISOString() }).then(() => setSelection(null))} onHideAnnotation={(annotation) => updateAnnotation({ ...annotation, status: 'hidden', updatedAt: new Date().toISOString() }).then(() => setSelection(null))} />}
        </section>
      </main>

      {!identity && <IdentityModal onSave={(name) => {
        const next = { name, deviceId: localStorage.getItem('common-ground-device') || crypto.randomUUID() }
        localStorage.setItem('common-ground-name', next.name)
        localStorage.setItem('common-ground-device', next.deviceId)
        setIdentity(next)
      }} />}
      {uploadOpen && identity && <UploadModal identity={identity} onClose={() => setUploadOpen(false)} onSave={async (newLayers) => {
        for (const layer of newLayers) await repository.saveLayer(layer)
        setLayers((current) => [...newLayers, ...current])
        setUploadOpen(false)
        const bounds = getGeoJSONBounds(newLayers[0].geojson)
        if (bounds) mapRef.current?.fitBounds(bounds, { padding: 90, maxZoom: 15, duration: 900 })
        notify(`${newLayers.length} layer${newLayers.length > 1 ? 's' : ''} added.`)
      }} />}
      {pendingCoordinates && identity && <AnnotationModal identity={identity} coordinates={pendingCoordinates} onClose={() => setPendingCoordinates(null)} onSave={async (annotation) => {
        await repository.saveAnnotation(annotation)
        setAnnotations((current) => [annotation, ...current])
        setPendingCoordinates(null)
        setSelection({ type: 'annotation', annotationId: annotation.id })
        notify('Field pin added.')
      }} />}
      {editingAnnotation && identity && <AnnotationModal identity={identity} coordinates={editingAnnotation.coordinates} existing={editingAnnotation} onClose={() => setEditingAnnotation(null)} onSave={async (annotation) => {
        await updateAnnotation(annotation)
        setEditingAnnotation(null)
        notify('Field pin updated.')
      }} />}
      {editingLayer && <LayerEditModal layer={editingLayer} onClose={() => setEditingLayer(null)} onSave={async (layer) => {
        await updateLayer(layer)
        setEditingLayer(null)
        notify('Layer details updated.')
      }} />}
      {stylingLayer && <LayerStyleModal layer={stylingLayer} onClose={() => setStylingLayer(null)} onSave={async (layer) => {
        await updateLayer(layer)
        setStylingLayer(null)
        notify('Layer visualization updated.')
      }} />}
      {tableLayer && <AttributeTableModal layer={tableLayer} onClose={() => setTableLayer(null)} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

function IdentityModal({ onSave }: { onSave: (name: string) => void }) {
  const [name, setName] = useState(localStorage.getItem('common-ground-name') || '')
  return <div className="modal-backdrop identity-backdrop"><form className="modal identity-modal" onSubmit={(event) => { event.preventDefault(); if (name.trim()) onSave(name.trim()) }}>
    <div className="identity-emblem">CG</div><p className="eyebrow">WELCOME TO COMMON GROUND</p><h2>How should the class know you?</h2><p>Your name will travel with every layer and field pin you add. This browser will remember which contributions are yours.</p>
    <label><span>Contributor name</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={40} placeholder="e.g. Wei Jue" /></label>
    <button className="button primary wide" disabled={!name.trim()}>Enter the map →</button><small>No account is created. Clearing browser data removes your edit access.</small>
  </form></div>
}

function UploadModal({ identity, onClose, onSave }: { identity: ContributorIdentity; onClose: () => void; onSave: (layers: SpatialLayer[]) => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null)
  const [parsed, setParsed] = useState<ParsedSpatialFile[]>([])
  const [fields, setFields] = useState<AttributeField[]>([])
  const [styleMode, setStyleMode] = useState<StyleMode>('single')
  const [styleField, setStyleField] = useState('')
  const [stylePalette, setStylePalette] = useState('civic')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function chooseSpatialFile(nextFile?: File) {
    setFile(nextFile || null)
    setParsed([])
    setFields([])
    setError('')
    if (!nextFile) return
    setBusy(true)
    try {
      const results = await parseSpatialFile(nextFile)
      const attributeFields = summarizeAttributes(results[0].geojson)
      const defaults = getDefaultStyle(attributeFields)
      setParsed(results)
      setFields(attributeFields)
      setStyleMode(defaults.styleMode)
      setStyleField(defaults.styleField || '')
      setStylePalette(defaults.stylePalette)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This file could not be read.')
    } finally {
      setBusy(false)
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!file) return setError('Choose a spatial data file first.')
    if (!parsed.length) return setError('Wait for the spatial file to finish reading.')
    setBusy(true); setError('')
    try {
      const form = new FormData(event.currentTarget)
      const now = new Date().toISOString()
      const baseName = String(form.get('name') || '').trim()
      const newLayers = parsed.map((result, index): SpatialLayer => {
        const summary = describeGeoJSON(result.geojson)
        const resultFields = summarizeAttributes(result.geojson)
        const selectedField = resultFields.some((field) => field.name === styleField) ? styleField : resultFields[0]?.name
        const selectedMode = styleMode === 'graduated' && !resultFields.some((field) => field.name === selectedField && field.type === 'number') ? 'single' : styleMode
        const palette = getPalette(stylePalette)
        return {
          id: makeId('layer'), name: parsed.length > 1 ? `${baseName || result.suggestedName} — ${result.suggestedName}` : baseName || result.suggestedName,
          description: String(form.get('description') || '').trim(), sourceNote: String(form.get('source') || '').trim(), processingNote: String(form.get('processing') || '').trim(),
          contributorName: identity.name, creatorDeviceId: identity.deviceId, createdAt: now, updatedAt: now, status: 'active', visible: true, selectedForExport: false,
          opacity: 0.85, color: palette.colors[Math.min(2 + index, palette.colors.length - 1)], styleMode: selectedMode, styleField: selectedField, stylePalette,
          format: file.name.toLowerCase().endsWith('.zip') ? 'Shapefile' : 'GeoJSON',
          originalFileName: file.name, originalFile: file, geojson: result.geojson, ...summary,
        }
      })
      await onSave(newLayers)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This file could not be read.')
    } finally { setBusy(false) }
  }
  return <Modal title="Upload a data layer" subtitle="GeoJSON or a zipped Shapefile" onClose={onClose}><form className="form-grid" onSubmit={submit}>
    <label className={`file-drop ${parsed.length ? 'has-file' : ''}`}><input type="file" accept=".geojson,.json,.zip" onChange={(event) => chooseSpatialFile(event.target.files?.[0])} /><span>{parsed.length ? '✓' : '↑'}</span><div><strong>{file?.name || 'Choose a spatial file'}</strong><small>{busy ? 'Reading attributes…' : file ? `${formatBytes(file.size)} · ${parsed[0]?.geojson.features.length || 0} features · ${fields.length} fields` : '.geojson, .json or Shapefile .zip'}</small></div></label>
    <label><span>Layer name <em>required</em></span><input name="name" required placeholder="e.g. Heritage sites survey" /></label>
    <label><span>What is this layer for?</span><textarea name="description" rows={2} placeholder="A short description classmates can understand" /></label>
    <div className="two-columns"><label><span>Source</span><input name="source" placeholder="Agency, survey or URL" /></label><label><span>Processing</span><input name="processing" placeholder="Cleaning, joins, transformations…" /></label></div>
    {parsed.length > 0 && <StyleControls fields={fields} mode={styleMode} field={styleField} paletteId={stylePalette} onModeChange={setStyleMode} onFieldChange={setStyleField} onPaletteChange={setStylePalette} />}
    <div className="form-note">All non-empty feature attributes will be visible. Shapefiles should include .shp, .dbf and .prj files inside one ZIP.</div>
    {error && <div className="form-error">{error}</div>}<div className="modal-actions"><button type="button" className="button ghost" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || !parsed.length}>{busy ? 'Reading file…' : 'Add to map'}</button></div>
  </form></Modal>
}

function AnnotationModal({ identity, coordinates, existing, onClose, onSave }: { identity: ContributorIdentity; coordinates: [number, number]; existing?: MapAnnotation; onClose: () => void; onSave: (annotation: MapAnnotation) => Promise<void> }) {
  const [image, setImage] = useState<Blob | undefined>(existing?.image)
  const [imageName, setImageName] = useState(existing?.imageName || '')
  const [pinCategory, setPinCategory] = useState<PinCategoryId | ''>(existing?.pinCategory || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function chooseImage(file?: File) {
    if (!file) return
    if (file.size > 10 * 1024 * 1024) return setError('Choose an image smaller than 10 MB.')
    setBusy(true); setError('')
    try { setImage(await compressImage(file)); setImageName(file.name) } catch (cause) { setError(cause instanceof Error ? cause.message : 'Image compression failed.') } finally { setBusy(false) }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!pinCategory) return setError('Choose what kind of urban observation this pin represents.')
    setBusy(true)
    const form = new FormData(event.currentTarget); const now = new Date().toISOString()
    const annotation: MapAnnotation = { id: existing?.id || makeId('pin'), title: String(form.get('title') || '').trim(), note: String(form.get('note') || '').trim(), oneDriveUrl: String(form.get('url') || '').trim(), coordinates, image, imageName, pinCategory, contributorName: existing?.contributorName || identity.name, creatorDeviceId: existing?.creatorDeviceId || identity.deviceId, createdAt: existing?.createdAt || now, updatedAt: now, status: 'active' }
    await onSave(annotation); setBusy(false)
  }
  return <Modal title={existing ? 'Edit field pin' : 'Add a field pin'} subtitle={`${coordinates[1].toFixed(5)}, ${coordinates[0].toFixed(5)}`} onClose={onClose}><form className="form-grid" onSubmit={submit}>
    <fieldset className="pin-category-picker"><legend>What kind of observation is this? <em>required</em></legend><div>{PIN_CATEGORIES.map((category) => <button type="button" key={category.id} className={pinCategory === category.id ? 'active' : ''} aria-pressed={pinCategory === category.id} onClick={() => { setPinCategory(category.id); setError('') }}><i style={{ background: category.color }} /><span><strong>{category.label}</strong><small>{category.description}</small></span><b>{pinCategory === category.id ? '✓' : ''}</b></button>)}</div></fieldset>
    <label><span>Pin title <em>required</em></span><input name="title" required defaultValue={existing?.title} placeholder="What is here?" /></label>
    <label><span>Field note</span><textarea name="note" rows={4} defaultValue={existing?.note} placeholder="Add context, an observation, or a question…" /></label>
    <label><span>OneDrive link</span><input name="url" type="url" defaultValue={existing?.oneDriveUrl} placeholder="https://1drv.ms/…" /></label>
    <label className={`photo-picker ${image ? 'has-file' : ''}`}><input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => chooseImage(event.target.files?.[0])} /><span>▧</span><div><strong>{image ? imageName || 'Compressed photo' : 'Attach one photo'}</strong><small>{image ? `${formatBytes(image.size)} after compression` : 'JPEG, PNG or WebP · max 10 MB'}</small></div></label>
    {image && <button type="button" className="text-button danger" onClick={() => { setImage(undefined); setImageName('') }}>Remove photo</button>}
    {error && <div className="form-error">{error}</div>}<div className="modal-actions"><button type="button" className="button ghost" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy}>{busy ? 'Preparing…' : existing ? 'Save changes' : 'Place pin'}</button></div>
  </form></Modal>
}

function LayerEditModal({ layer, onClose, onSave }: { layer: SpatialLayer; onClose: () => void; onSave: (layer: SpatialLayer) => Promise<void> }) {
  return <Modal title="Edit layer details" subtitle={`${layer.featureCount.toLocaleString()} features · ${layer.format}`} onClose={onClose}><form className="form-grid" onSubmit={async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); await onSave({ ...layer, name: String(form.get('name')), description: String(form.get('description')), sourceNote: String(form.get('source')), processingNote: String(form.get('processing')), updatedAt: new Date().toISOString() }) }}>
    <label><span>Layer name</span><input name="name" required defaultValue={layer.name} /></label><label><span>What is this layer for?</span><textarea name="description" rows={3} defaultValue={layer.description} /></label><label><span>Source</span><input name="source" defaultValue={layer.sourceNote} /></label><label><span>Processing</span><input name="processing" defaultValue={layer.processingNote} /></label>
    <div className="modal-actions"><button type="button" className="button ghost" onClick={onClose}>Cancel</button><button className="button primary">Save changes</button></div>
  </form></Modal>
}

function StyleControls({ fields, mode, field, paletteId, onModeChange, onFieldChange, onPaletteChange }: { fields: AttributeField[]; mode: StyleMode; field: string; paletteId: string; onModeChange: (mode: StyleMode) => void; onFieldChange: (field: string) => void; onPaletteChange: (palette: string) => void }) {
  const availableFields = mode === 'graduated' ? fields.filter((item) => item.type === 'number') : fields
  function chooseMode(nextMode: StyleMode) {
    onModeChange(nextMode)
    if (nextMode !== 'single') {
      const nextFields = nextMode === 'graduated' ? fields.filter((item) => item.type === 'number') : fields
      if (nextFields.some((item) => item.name === field)) return
      onFieldChange(nextFields[0]?.name || '')
    }
  }
  return <section className="style-controls">
    <div className="style-heading"><div><span>QUICK VISUALIZATION</span><small>Choose how feature values become colors</small></div><b>{fields.length} fields</b></div>
    <div className="mode-picker">
      <button type="button" className={mode === 'single' ? 'active' : ''} onClick={() => chooseMode('single')}><i className="single-icon" />Same color</button>
      <button type="button" className={mode === 'categorical' ? 'active' : ''} disabled={!fields.length} onClick={() => chooseMode('categorical')}><i className="category-icon" />Unique values</button>
      <button type="button" className={mode === 'graduated' ? 'active' : ''} disabled={!fields.some((item) => item.type === 'number')} onClick={() => chooseMode('graduated')}><i className="gradient-icon" />Graduated</button>
    </div>
    {mode !== 'single' && <label className="style-field"><span>Visualize by attribute</span><select value={field} onChange={(event) => onFieldChange(event.target.value)}>{availableFields.map((item) => <option key={item.name} value={item.name}>{item.name} · {item.type}</option>)}</select></label>}
    <div><span className="control-label">Color template</span><div className="palette-picker">{COLOR_PALETTES.map((palette) => <button type="button" key={palette.id} className={paletteId === palette.id ? 'active' : ''} title={palette.name} aria-label={`${palette.name} color template`} onClick={() => onPaletteChange(palette.id)}>{palette.colors.map((color) => <i key={color} style={{ background: color }} />)}</button>)}</div></div>
  </section>
}

function LayerStyleModal({ layer, onClose, onSave }: { layer: SpatialLayer; onClose: () => void; onSave: (layer: SpatialLayer) => Promise<void> }) {
  const fields = summarizeAttributes(layer.geojson)
  const defaults = getDefaultStyle(fields)
  const [mode, setMode] = useState<StyleMode>(layer.styleMode || defaults.styleMode)
  const [field, setField] = useState(layer.styleField || defaults.styleField || '')
  const [paletteId, setPaletteId] = useState(layer.stylePalette || defaults.stylePalette)
  return <Modal title="Style this layer" subtitle={`${layer.featureCount.toLocaleString()} features · ${fields.length} attributes`} onClose={onClose}><form className="form-grid" onSubmit={async (event) => {
    event.preventDefault()
    const palette = getPalette(paletteId)
    await onSave({ ...layer, styleMode: mode, styleField: field, stylePalette: paletteId, color: palette.colors[2], updatedAt: new Date().toISOString() })
  }}>
    <StyleControls fields={fields} mode={mode} field={field} paletteId={paletteId} onModeChange={setMode} onFieldChange={setField} onPaletteChange={setPaletteId} />
    <div className="form-note">Unique values use up to 30 categories on the map. Graduated styling is available for numeric fields only.</div>
    <div className="modal-actions"><button type="button" className="button ghost" onClick={onClose}>Cancel</button><button className="button primary">Apply visualization</button></div>
  </form></Modal>
}

function AttributeTableModal({ layer, onClose }: { layer: SpatialLayer; onClose: () => void }) {
  const [page, setPage] = useState(0)
  const pageSize = 50
  const fields = summarizeAttributes(layer.geojson)
  const totalPages = Math.max(1, Math.ceil(layer.geojson.features.length / pageSize))
  const rows = layer.geojson.features.slice(page * pageSize, (page + 1) * pageSize)
  return <div className="modal-backdrop"><div className="modal table-modal"><div className="modal-header"><div><p className="eyebrow">READ-ONLY ATTRIBUTE TABLE</p><h2>{layer.name}</h2><span>{layer.featureCount.toLocaleString()} rows · {fields.length} columns</span></div><button className="close-button" onClick={onClose}>×</button></div>
    <div className="attribute-table-wrap"><table><thead><tr><th>#</th>{fields.map((field) => <th key={field.name}><strong>{field.name}</strong><small>{field.type}</small></th>)}</tr></thead><tbody>{rows.map((feature, index) => <tr key={page * pageSize + index}><td>{page * pageSize + index + 1}</td>{fields.map((field) => { const value = feature.properties?.[field.name]; return <td key={field.name} title={value === null || value === undefined ? '' : String(value)}>{value === null || value === undefined || value === '' ? <em>—</em> : typeof value === 'object' ? JSON.stringify(value) : String(value)}</td> })}</tr>)}</tbody></table></div>
    <div className="table-footer"><span>Rows {page * pageSize + 1}–{Math.min((page + 1) * pageSize, layer.featureCount)} of {layer.featureCount.toLocaleString()}</span><div><button className="button ghost" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>← Previous</button><b>{page + 1} / {totalPages}</b><button className="button ghost" disabled={page >= totalPages - 1} onClick={() => setPage((value) => value + 1)}>Next →</button></div></div>
  </div></div>
}

function Modal({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}><div className="modal"><div className="modal-header"><div><p className="eyebrow">COMMON GROUND</p><h2>{title}</h2>{subtitle && <span>{subtitle}</span>}</div><button className="close-button" onClick={onClose}>×</button></div>{children}</div></div>
}

function Inspector({ selection, layers, annotations, identity, onClose, onSelectAnnotation, onEditLayer, onStyleLayer, onOpenTable, onEditAnnotation, onHideLayer, onHideAnnotation }: { selection: Exclude<InspectorSelection, null>; layers: SpatialLayer[]; annotations: MapAnnotation[]; identity: ContributorIdentity | null; onClose: () => void; onSelectAnnotation: (annotation: MapAnnotation) => void; onEditLayer: (layer: SpatialLayer) => void; onStyleLayer: (layer: SpatialLayer) => void; onOpenTable: (layer: SpatialLayer) => void; onEditAnnotation: (annotation: MapAnnotation) => void; onHideLayer: (layer: SpatialLayer) => void; onHideAnnotation: (annotation: MapAnnotation) => void }) {
  const layer = 'layerId' in selection ? layers.find((item) => item.id === selection.layerId) : undefined
  const annotation = selection.type === 'annotation' ? annotations.find((item) => item.id === selection.annotationId) : undefined
  const pinGroup = selection.type === 'pinGroup' ? annotations.filter((item) => item.status === 'active' && item.contributorName === selection.contributorName) : []
  if (!layer && !annotation && !pinGroup.length) return null
  const annotationCategory = annotation ? getPinCategory(annotation.pinCategory) : null
  const ownsLayer = Boolean(layer && identity?.deviceId === layer.creatorDeviceId)
  const ownsAnnotation = Boolean(annotation && identity?.deviceId === annotation.creatorDeviceId)
  return <aside className="inspector"><button className="close-button" onClick={onClose}>×</button>
    {annotation ? <>
      <AnnotationPhoto image={annotation.image} title={annotation.title} />
      <div className="pin-category-badge" style={{ '--pin-color': annotationCategory?.color } as React.CSSProperties}><i /><span>{annotationCategory?.label}</span></div>
      <p className="eyebrow">FIELD PIN</p><h2>{annotation.title}</h2><p className="inspector-copy">{annotation.note || 'No field note added.'}</p>
      <dl><div><dt>Type</dt><dd>{annotationCategory?.label}</dd></div><div><dt>Contributor</dt><dd>{annotation.contributorName}</dd></div><div><dt>Coordinates</dt><dd>{annotation.coordinates[1].toFixed(5)}, {annotation.coordinates[0].toFixed(5)}</dd></div><div><dt>Added</dt><dd>{new Date(annotation.createdAt).toLocaleDateString()}</dd></div></dl>
      {annotation.oneDriveUrl && <a className="external-link" href={annotation.oneDriveUrl} target="_blank" rel="noreferrer">Open OneDrive material ↗</a>}
      {ownsAnnotation && <div className="inspector-actions"><button className="button ghost" onClick={() => onEditAnnotation(annotation)}>Edit pin</button><button className="text-button danger" onClick={() => confirm('Hide this pin from the map?') && onHideAnnotation(annotation)}>Take down</button></div>}
    </> : selection.type === 'pinGroup' ? <>
      <div className="pin-group-emblem">●</div><p className="eyebrow">PIN LAYER</p><h2>{selection.contributorName}</h2>
      <p className="inspector-copy">{pinGroup.length} map pin{pinGroup.length > 1 ? 's' : ''} contributed by this person.</p>
      <div className="pin-preview-list">{pinGroup.map((pin) => { const category = getPinCategory(pin.pinCategory); return <button key={pin.id} onClick={() => onSelectAnnotation(pin)}><i style={{ background: category.color }} /><span><strong>{pin.title}</strong><small>{category.shortLabel} · {pin.note || `${pin.coordinates[1].toFixed(5)}, ${pin.coordinates[0].toFixed(5)}`}</small></span><b>›</b></button> })}</div>
    </> : layer ? <>
      <div className="layer-swatch" style={{ background: layer.styleMode && layer.styleMode !== 'single' ? `linear-gradient(90deg, ${getPalette(layer.stylePalette).colors.join(',')})` : layer.color }} /><p className="eyebrow">{selection.type === 'feature' ? 'MAP FEATURE' : 'DATA LAYER'}</p><h2>{layer.name}</h2>
      {selection.type === 'feature' ? <><PropertyList properties={selection.properties} /><AttributeSummary layer={layer} /><button className="wide-action" onClick={() => onOpenTable(layer)}>View full attribute table →</button></> : <>
        <p className="inspector-copy">{layer.description || 'No description added.'}</p><dl><div><dt>Contributor</dt><dd>{layer.contributorName}</dd></div><div><dt>Features</dt><dd>{layer.featureCount.toLocaleString()}</dd></div><div><dt>Geometry</dt><dd>{layer.geometryTypes.join(', ') || 'Unknown'}</dd></div><div><dt>Source</dt><dd>{layer.sourceNote || 'Not stated'}</dd></div><div><dt>Processing</dt><dd>{layer.processingNote || 'Not stated'}</dd></div></dl>
        <LayerLegend layer={layer} />
        <AttributeSummary layer={layer} />
        <div className="inspector-tool-grid"><button onClick={() => onOpenTable(layer)}>▦ Attribute table</button>{ownsLayer && <button onClick={() => onStyleLayer(layer)}>◐ Style layer</button>}</div>
        {ownsLayer && <div className="inspector-actions"><button className="button ghost" onClick={() => onEditLayer(layer)}>Edit details</button><button className="text-button danger" onClick={() => confirm('Hide this layer from the map?') && onHideLayer(layer)}>Take down</button></div>}
      </>}
    </> : null}
  </aside>
}

function AnnotationPhoto({ image, title }: { image?: Blob; title: string }) {
  const [imageUrl, setImageUrl] = useState('')
  useEffect(() => {
    if (!image) {
      setImageUrl('')
      return
    }
    const url = URL.createObjectURL(image)
    setImageUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [image])
  return imageUrl ? <img className="inspector-photo" src={imageUrl} alt={title} /> : null
}

function PropertyList({ properties }: { properties: GeoJsonProperties }) {
  const entries = Object.entries(properties || {}).filter(([, value]) => value !== null && value !== '' && value !== undefined)
  return <div className="property-list">{entries.length ? entries.map(([key, value]) => <div key={key}><span>{key}</span><strong>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</strong></div>) : <p>No non-empty attributes for this feature.</p>}</div>
}

function LayerLegend({ layer }: { layer: SpatialLayer }) {
  const entries = getLegendEntries(layer)
  return <section className="layer-legend"><div className="summary-heading"><span>LEGEND</span><b>{layer.styleMode === 'categorical' ? 'Unique values' : layer.styleMode === 'graduated' ? 'Graduated' : 'Same color'}{layer.styleField && layer.styleMode !== 'single' ? ` · ${layer.styleField}` : ''}</b></div><div className="legend-items">{entries.map((entry) => <div key={`${entry.label}-${entry.color}`}><i style={{ background: entry.color }} /><span>{entry.label}</span></div>)}</div>{layer.styleMode === 'categorical' && entries.length >= 12 && <small className="legend-note">Showing the first 12 values.</small>}</section>
}

function AttributeSummary({ layer }: { layer: SpatialLayer }) {
  const fields = summarizeAttributes(layer.geojson)
  return <section className="attribute-summary"><div className="summary-heading"><span>ATTRIBUTE SUMMARY</span><b>{layer.featureCount.toLocaleString()} rows · {fields.length} fields</b></div>{fields.length ? <div className="summary-fields">{fields.map((field) => <div className="summary-field" key={field.name}><div><strong>{field.name}</strong><span>{field.type}</span></div><p>{field.type === 'number' && field.min !== undefined ? `Min ${formatStat(field.min)} · Median ${formatStat(field.median || 0)} · Mean ${formatStat(field.mean || 0)} · Max ${formatStat(field.max || 0)}` : `${field.uniqueCount.toLocaleString()} unique · ${field.missing.toLocaleString()} missing`}</p></div>)}</div> : <p className="summary-empty">This layer has no attribute fields.</p>}</section>
}

export default App
