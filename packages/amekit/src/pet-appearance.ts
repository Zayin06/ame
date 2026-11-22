import type { Rectangle } from "./pet"

export type PetPalette = { background: string; foreground: string; border: string }
export const defaultPetPalette: PetPalette = { background: "#242424", foreground: "#eeeeee", border: "#505050" }
export function petPalette(value: PetPalette): PetPalette {
  const color = /^(?:#[\da-f]{3,8}|(?:rgba?|hsla?|oklch|oklab|lch|lab|color)\([a-z\d.,%+\- /]+\))$/i
  if (!value || ![value.background, value.foreground, value.border].every(value => typeof value === "string" && value.length <= 160 && color.test(value))) throw new Error("INVALID_PET_PALETTE")
  return { background: value.background, foreground: value.foreground, border: value.border }
}

export function petBubbleBounds(pet: Rectangle, area: Rectangle, contentHeight: number) {
  const width = Math.min(286, area.width), height = Math.min(Math.max(1, Math.ceil(contentHeight)), area.height)
  const center = pet.x + pet.width / 2
  const x = Math.max(area.x, Math.min(center - width / 2, area.x + area.width - width))
  const above = pet.y - area.y, below = area.y + area.height - pet.y - pet.height
  const side = above >= height + 4 || above >= below ? "above" : "below"
  const y = Math.max(area.y, Math.min(side === "above" ? pet.y - height - 4 : pet.y + pet.height + 4, area.y + area.height - height))
  const inset = Math.min(22, width / 2)
  return { bounds: { x: Math.round(x), y: Math.round(y), width, height }, side, anchor: Math.max(inset, Math.min(center - Math.round(x), width - inset)) }
}

export function petPaletteScript(palette: PetPalette) {
  const colors = petPalette(palette)
  return `var root=document.documentElement;root.style.setProperty('--bubble-background',${JSON.stringify(colors.background)});root.style.setProperty('--bubble-foreground',${JSON.stringify(colors.foreground)});root.style.setProperty('--bubble-border',${JSON.stringify(colors.border)})`
}
