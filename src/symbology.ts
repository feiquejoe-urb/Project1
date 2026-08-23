import type { FeatureCollection, GeoJsonProperties, Geometry } from 'geojson'
import type { SpatialLayerView, StyleMode } from './types'

export const COLOR_PALETTES = [
  { id: 'civic', name: 'Civic', colors: ['#f2d8c8', '#e7a17d', '#d66d50', '#a94535', '#682c26'] },
  { id: 'ocean', name: 'Ocean', colors: ['#d9eef1', '#9bcfd5', '#55a8b2', '#247784', '#104954'] },
  { id: 'forest', name: 'Forest', colors: ['#e2edd9', '#afd09e', '#75ad72', '#3e7e52', '#214d38'] },
  { id: 'violet', name: 'Violet', colors: ['#eee5f2', '#cbb5d8', '#a17fba', '#76548f', '#49325e'] },
  { id: 'sunset', name: 'Sunset', colors: ['#ffe0b5', '#f7ae6d', '#e57455', '#ba4359', '#713047'] },
  { id: 'contrast', name: 'Contrast', colors: ['#2f7f73', '#ef6a4c', '#4e73a8', '#d2a441', '#8b5d9f', '#d04f78'] },
] as const

export interface AttributeField {
  name: string
  type: 'number' | 'text' | 'boolean' | 'mixed'
  nonEmpty: number
  missing: number
  uniqueCount: number
  min?: number
  q1?: number
  median?: number
  mean?: number
  q3?: number
  max?: number
}

function valuesForField(data: FeatureCollection<Geometry, GeoJsonProperties>, field: string) {
  return data.features.map((feature) => feature.properties?.[field]).filter((value) => value !== null && value !== undefined && value !== '')
}

function quantile(sorted: number[], position: number) {
  if (!sorted.length) return 0
  const index = (sorted.length - 1) * position
  const lower = Math.floor(index)
  const fraction = index - lower
  return sorted[lower + 1] === undefined ? sorted[lower] : sorted[lower] + fraction * (sorted[lower + 1] - sorted[lower])
}

export function summarizeAttributes(data: FeatureCollection<Geometry, GeoJsonProperties>): AttributeField[] {
  const names = [...new Set(data.features.flatMap((feature) => Object.keys(feature.properties || {})))]
  return names.map((name) => {
    const values = valuesForField(data, name)
    const primitiveTypes = new Set(values.map((value) => typeof value))
    const type: AttributeField['type'] = primitiveTypes.size > 1 ? 'mixed' : primitiveTypes.has('number') ? 'number' : primitiveTypes.has('boolean') ? 'boolean' : 'text'
    const summary: AttributeField = {
      name,
      type,
      nonEmpty: values.length,
      missing: data.features.length - values.length,
      uniqueCount: new Set(values.map((value) => JSON.stringify(value))).size,
    }
    if (type === 'number') {
      const numbers = (values as number[]).filter(Number.isFinite).sort((a, b) => a - b)
      if (numbers.length) {
        summary.min = numbers[0]
        summary.q1 = quantile(numbers, 0.25)
        summary.median = quantile(numbers, 0.5)
        summary.mean = numbers.reduce((sum, value) => sum + value, 0) / numbers.length
        summary.q3 = quantile(numbers, 0.75)
        summary.max = numbers[numbers.length - 1]
      }
    }
    return summary
  })
}

export function getPalette(paletteId?: string) {
  return COLOR_PALETTES.find((palette) => palette.id === paletteId) || COLOR_PALETTES[0]
}

export function getDefaultStyle(fields: AttributeField[]): { styleMode: StyleMode; styleField?: string; stylePalette: string; color: string } {
  const palette = COLOR_PALETTES[0]
  return { styleMode: 'single', styleField: fields[0]?.name, stylePalette: palette.id, color: palette.colors[2] }
}

export function buildColorExpression(layer: SpatialLayerView): string | unknown[] {
  const palette = getPalette(layer.stylePalette)
  const mode = layer.styleMode || 'single'
  const field = layer.styleField
  if (!field || mode === 'single') return layer.color || palette.colors[2]

  if (mode === 'categorical') {
    const unique = [...new Set(valuesForField(layer.dataset.geojson, field).map(String))].sort((a, b) => a.localeCompare(b)).slice(0, 30)
    if (!unique.length) return layer.color || palette.colors[2]
    return ['match', ['to-string', ['get', field]], ...unique.flatMap((value, index) => [value, palette.colors[index % palette.colors.length]]), '#c6c3ba']
  }

  const numbers = valuesForField(layer.dataset.geojson, field).filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  if (!numbers.length) return layer.color || palette.colors[2]
  const min = Math.min(...numbers)
  const max = Math.max(...numbers)
  if (min === max) return palette.colors[2]
  const stops = palette.colors.flatMap((color, index) => [min + (max - min) * index / (palette.colors.length - 1), color])
  return ['interpolate', ['linear'], ['to-number', ['get', field], min], ...stops]
}

export function getLegendEntries(layer: SpatialLayerView) {
  const palette = getPalette(layer.stylePalette)
  const mode = layer.styleMode || 'single'
  const field = layer.styleField
  if (!field || mode === 'single') return [{ label: 'All features', color: layer.color || palette.colors[2] }]
  if (mode === 'categorical') {
    const unique = [...new Set(valuesForField(layer.dataset.geojson, field).map(String))].sort((a, b) => a.localeCompare(b)).slice(0, 12)
    return unique.map((value, index) => ({ label: value, color: palette.colors[index % palette.colors.length] }))
  }
  const numbers = valuesForField(layer.dataset.geojson, field).filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  if (!numbers.length) return []
  const min = Math.min(...numbers)
  const max = Math.max(...numbers)
  if (min === max) return [{ label: formatStat(min), color: palette.colors[2] }]
  return palette.colors.map((color, index) => {
    const start = min + (max - min) * index / palette.colors.length
    const end = min + (max - min) * (index + 1) / palette.colors.length
    return { label: `${formatStat(start)}–${formatStat(end)}`, color }
  })
}

export function formatStat(value: number) {
  return Math.abs(value) >= 1000 ? value.toLocaleString(undefined, { maximumFractionDigits: 1 }) : Number(value.toFixed(2)).toString()
}
