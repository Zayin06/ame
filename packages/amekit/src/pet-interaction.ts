import type { Point } from './pet'

export type PetPointerPhase = 'down' | 'move' | 'up' | 'cancel'

// Use screen coordinates, not client coordinates: moving the window must not
// feed back into the gesture. Once dragged, returning to the origin is no click.
export class PetInteraction {
  private press?: { cursor: Point; origin: Point; at: number; dragging: boolean }

  update(phase: PetPointerPhase, cursor: Point, origin: Point, now: number): { position?: Point; activate?: boolean } {
    if (phase === 'cancel') { this.press = undefined; return {} }
    if (phase === 'down') {
      this.press = { cursor: { ...cursor }, origin: { ...origin }, at: now, dragging: false }
      return {}
    }
    const press = this.press
    if (!press) return {}
    const x = cursor.x - press.cursor.x, y = cursor.y - press.cursor.y
    if (Math.hypot(x, y) >= 5) press.dragging = true
    if (phase === 'up') this.press = undefined
    if (press.dragging) return { position: { x: press.origin.x + x, y: press.origin.y + y } }
    return { activate: phase === 'up' && now - press.at >= 0 && now - press.at <= 500 }
  }
}

export function revealPetMainWindow(window: {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
} | undefined) {
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}
