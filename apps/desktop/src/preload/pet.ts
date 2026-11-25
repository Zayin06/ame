import { ipcRenderer } from 'electron'

// Runs only in the pet's isolated, sandboxed world; expose no API to the page.
window.addEventListener('DOMContentLoaded', () => {
  const surface = document.body
  let pointer: number | undefined
  surface.addEventListener('pointerdown', event => {
    if (!event.isTrusted || !event.isPrimary || event.button !== 0 || pointer !== undefined) return
    surface.setPointerCapture(event.pointerId)
    pointer = event.pointerId
    ipcRenderer.send('ame:pet-pointer', 'down')
  })
  surface.addEventListener('pointermove', event => {
    if (event.isTrusted && event.pointerId === pointer) ipcRenderer.send('ame:pet-pointer', 'move')
  })
  const finish = (event: PointerEvent, phase: 'up' | 'cancel') => {
    if (!event.isTrusted || event.pointerId !== pointer) return
    pointer = undefined
    ipcRenderer.send('ame:pet-pointer', phase)
  }
  surface.addEventListener('pointerup', event => finish(event, 'up'))
  surface.addEventListener('pointercancel', event => finish(event, 'cancel'))
  surface.addEventListener('lostpointercapture', event => finish(event, 'cancel'))
})
