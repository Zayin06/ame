import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findModelByID, formatModelOptionLabel, modelKey, modelLevelTags, resolvePreferredModel } from '../model-selection'

const light = { providerID: 'amecode', id: 'light-option', modelID: 'light', name: 'Light' }
const balanced = { providerID: 'amecode', id: 'balanced-option', modelID: 'balanced', name: 'Balanced' }
const models = [light, balanced]

test('model selection follows the API default regardless of catalog order or late arrival', () => {
  const currentValue = resolvePreferredModel({ models, currentValue: '' })
  assert.equal(currentValue, modelKey(light))
  assert.equal(resolvePreferredModel({ models, currentValue, defaultModelID: 'balanced', role: 'admin' }), modelKey(balanced))
  assert.equal(resolvePreferredModel({ models, currentValue: '', defaultModelID: 'balanced' }), modelKey(balanced))
  assert.equal(findModelByID(models, 'balanced-option'), balanced)
  assert.equal(resolvePreferredModel({ models: [], currentValue, defaultModelID: 'balanced' }), '')
})

test('only explicit admin selection persists while it remains available', () => {
  const params = { models, currentValue: modelKey(light), defaultModelID: 'balanced', role: 'admin', userPicked: true }
  assert.equal(resolvePreferredModel(params), modelKey(light))
  assert.equal(resolvePreferredModel({ ...params, models: [balanced] }), modelKey(balanced))
  assert.equal(resolvePreferredModel({ ...params, userPicked: false }), modelKey(balanced))
  assert.equal(resolvePreferredModel({ ...params, role: 'user' }), modelKey(balanced))
  assert.equal(resolvePreferredModel({ ...params, defaultModelID: 'missing', userPicked: false }), modelKey(light))
})

test('model labels show all matching tiers and use canonical IDs', () => {
  const levels = { default: 'balanced', haiku: 'light', sonnet: 'balanced', opus: 'deep' }
  assert.deepEqual(modelLevelTags(balanced, levels), ['default', 'sonnet'])
  assert.equal(formatModelOptionLabel(balanced, levels), 'Balanced (default, sonnet)')
  assert.equal(formatModelOptionLabel(light, levels), 'Light (haiku)')
  assert.equal(formatModelOptionLabel(balanced), 'Balanced')
  assert.deepEqual(modelLevelTags({ id: 'deep' }, levels), ['opus'])
})
