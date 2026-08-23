import type { PinCategoryId } from './types'
import type { ExpressionSpecification } from 'maplibre-gl'

export interface PinCategory {
  id: PinCategoryId
  label: string
  shortLabel: string
  description: string
  color: string
}

export const PIN_CATEGORIES: PinCategory[] = [
  { id: 'activity', label: 'Activity', shortLabel: 'Activity', description: 'Events, routines, gatherings and movement', color: '#e05b3f' },
  { id: 'placemaking', label: 'Place-making', shortLabel: 'Place-making', description: 'How people adapt, claim or care for a place', color: '#168477' },
  { id: 'spatial', label: 'Spatial condition', shortLabel: 'Space', description: 'Form, access, boundary, infrastructure or land use', color: '#3974b8' },
  { id: 'story', label: 'Story & memory', shortLabel: 'Story', description: 'Lived experience, oral history and shared memory', color: '#8a5a9f' },
  { id: 'documentation', label: 'Documentation', shortLabel: 'Document', description: 'Photo evidence, archive material and field records', color: '#64736f' },
  { id: 'issue', label: 'Issue & opportunity', shortLabel: 'Issue', description: 'Conflict, risk, absence or potential for change', color: '#d09a2d' },
]

export const DEFAULT_PIN_CATEGORY: PinCategoryId = 'documentation'

export function getPinCategory(id?: string) {
  return PIN_CATEGORIES.find((category) => category.id === id) || PIN_CATEGORIES.find((category) => category.id === DEFAULT_PIN_CATEGORY)!
}

export function getPinColorExpression() {
  const expression: unknown[] = ['match', ['get', 'pinCategory']]
  PIN_CATEGORIES.forEach((category) => expression.push(category.id, category.color))
  expression.push(getPinCategory(DEFAULT_PIN_CATEGORY).color)
  return expression as ExpressionSpecification
}
