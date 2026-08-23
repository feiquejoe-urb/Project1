export const RESEARCH_SYSTEMS = [
  { id: 'system-1', shortName: 'System 1', name: 'Governance & Stakeholder Systems', color: '#8f3c2d' },
  { id: 'system-2', shortName: 'System 2', name: 'Community & Social Systems', color: '#3974b8' },
  { id: 'system-3', shortName: 'System 3', name: 'Economic & Employment Systems', color: '#a46b16' },
  { id: 'system-4', shortName: 'System 4', name: 'Mobility & Accessibility Systems', color: '#168477' },
  { id: 'system-5', shortName: 'System 5', name: 'Environmental & Blue-Green Systems', color: '#438c52' },
  { id: 'system-6', shortName: 'System 6', name: 'Land Use, Urban Structure & Heritage Systems', color: '#73549b' },
] as const

export type ResearchSystemId = typeof RESEARCH_SYSTEMS[number]['id']

export const DEFAULT_SYSTEM_ID: ResearchSystemId = 'system-1'

export function getResearchSystem(id?: string) {
  return RESEARCH_SYSTEMS.find((system) => system.id === id) || RESEARCH_SYSTEMS[0]
}
