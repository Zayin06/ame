import type { Model } from '../../../../packages/protocol/src/index'

export type ModelLevel = 'default' | 'haiku' | 'sonnet' | 'opus'
export type ModelLevels = Record<ModelLevel, string>

export function modelKey(model: Pick<Model, 'providerID' | 'id'>): string {
  return `${model.providerID}/${model.id}`
}

export function findModelByID(models: readonly Model[], id?: string): Model | undefined {
  return models.find(model => (model.modelID ?? model.id) === id || model.id === id)
}

export function resolvePreferredModel({ models, currentValue, defaultModelID, role, userPicked }: { models: readonly Model[]; currentValue: string; defaultModelID?: string; role?: string; userPicked?: boolean }): string {
  if (!models.length) return ''
  const preferred = findModelByID(models, defaultModelID) ?? models[0]
  if (role === 'user') return modelKey(preferred)
  if (userPicked && models.some(model => modelKey(model) === currentValue)) return currentValue
  return modelKey(preferred)
}

export function modelLevelTags(model: Pick<Model, 'id' | 'modelID'>, levels?: Partial<ModelLevels>): ModelLevel[] {
  const id = model.modelID ?? model.id
  return (['default', 'haiku', 'sonnet', 'opus'] as const).filter(level => levels?.[level] === id)
}

export function formatModelOptionLabel(model: Model, levels?: Partial<ModelLevels>): string {
  const tags = modelLevelTags(model, levels)
  return tags.length ? `${model.name} (${tags.join(', ')})` : model.name
}
