export function petChime(): string {
  const rate = 22050, samples = Math.round(rate * 0.45)
  const wav = Buffer.alloc(44 + samples * 2)
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++) {
    const t = i / rate, envelope = Math.min(1, t / 0.008) * Math.exp(-t * 10) * Math.min(1, (samples - i) / 400)
    const tone = Math.sin(2 * Math.PI * 1046.5 * t) + 0.3 * Math.sin(2 * Math.PI * 2093 * t)
    wav.writeInt16LE(Math.round(tone * envelope * 4500), 44 + i * 2)
  }
  return `data:audio/wav;base64,${wav.toString("base64")}`
}
