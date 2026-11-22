import { useEffect, useState } from "react"
import type { PetHostState } from "../../../../../packages/amekit/src/pet-host"
import { petLabels, petRows, petSpriteCss, petStates, type PetState } from "../../../../../packages/amekit/src/pet"

export type PetSettingsProps = {
  petState: PetHostState | null
  spriteUrl?: string
  selectedModel?: string
  loading?: boolean
  error?: string
  onConfigure: (input: { enabled?: boolean; scale?: number; resetPosition?: boolean }) => Promise<void> | void
  onSpeech: (input: { enabled?: boolean; sound?: boolean }) => Promise<void> | void
  onGenerateDialogue: (model: string) => Promise<void> | void
  onTestSpeech: () => Promise<void> | void
}

export function PetSettings(props: PetSettingsProps) {
  useEffect(() => { void import("../pet-settings.css") }, [])
  const [preview, setPreview] = useState<PetState | "live">("live")
  const [failure, setFailure] = useState("")
  const [pending, setPending] = useState(false)
  const state = props.petState
  const selected = preview === "live" ? state?.activity ?? "idle" : preview
  const disabled = !state || !!props.loading || pending
  const model = props.selectedModel?.trim() ?? ""
  async function run(action: () => Promise<void> | void, message: string) {
    setFailure(""); setPending(true)
    try { await action() } catch { setFailure(message) } finally { setPending(false) }
  }
  const configure = (input: Parameters<PetSettingsProps["onConfigure"]>[0]) => {
    void run(() => props.onConfigure(input), "Không thể lưu cài đặt pet. Hãy thử lại.")
  }
  const speech = (input: Parameters<PetSettingsProps["onSpeech"]>[0]) => {
    void run(() => props.onSpeech(input), "Không thể lưu cài đặt lời thoại.")
  }
  const alert = failure || props.error || state?.error
  return <section className="pet-settings" aria-label="Desktop Pet" aria-busy={!!props.loading || pending || !!state?.generating}>
    <style>{petSpriteCss}</style>
    <header><h2>Desktop Pet</h2><span className="pet-settings-badge">AME Chibi</span></header>
    <div className="pet-settings-card">
      <div className="pet-settings-preview"><div className="pet-settings-preview-frame">
        <div className="amekit-pet-sprite" role="img" aria-label={`AME Chibi — ${petLabels[selected]}`} style={{ backgroundImage: props.spriteUrl ? `url(${JSON.stringify(props.spriteUrl)})` : undefined, backgroundPositionY: `${petRows[selected] * 12.5}%` }} />
      </div></div>
      <div className="pet-settings-poses" role="group" aria-label="Tư thế pet">
        <button type="button" aria-pressed={preview === "live"} onClick={() => setPreview("live")}>Live</button>
        {petStates.map(pose => <button type="button" key={pose} aria-pressed={preview === pose} onClick={() => setPreview(pose)}>{petLabels[pose]}</button>)}
      </div>
      <div className="pet-settings-row">
        <div><p id="pet-visible-label" className="pet-settings-label">Hiển thị pet trên desktop</p><p>Pet luôn nổi trên các cửa sổ, phản ứng theo agent. Kéo pet để đổi vị trí; lựa chọn được lưu trên máy này.</p></div>
        <button type="button" role="switch" aria-labelledby="pet-visible-label" aria-checked={state?.preferences.enabled ?? false} disabled={disabled} onClick={() => configure({ enabled: !state?.preferences.enabled })}>{state?.preferences.enabled ? "Bật" : "Tắt"}</button>
      </div>
      <div className="pet-settings-row">
        <div><p className="pet-settings-label">Kích thước</p><p>{Math.round((state?.preferences.scale ?? 0.25) * 100)}% · 25%–200%</p></div>
        <input type="range" aria-label="Kích thước pet" aria-valuetext={`${Math.round((state?.preferences.scale ?? 0.25) * 100)}%`} min="25" max="200" step="5" value={(state?.preferences.scale ?? 0.25) * 100} disabled={disabled} onChange={event => configure({ scale: Number(event.currentTarget.value) / 100 })} />
      </div>
      <div className="pet-settings-row"><p>Đưa pet về góc dưới bên phải màn hình chính.</p><button type="button" disabled={disabled} onClick={() => configure({ resetPosition: true })}>Đặt lại vị trí</button></div>
      <div className="pet-settings-row">
        <div><p id="pet-speech-label" className="pet-settings-label">Bong bóng lời thoại</p><p>Tiếng Việt, tự ẩn sau 8 giây; lời chào, trạng thái agent và nhắc nghỉ nhẹ nhàng.</p></div>
        <button type="button" role="switch" aria-labelledby="pet-speech-label" aria-checked={state?.speech.enabled ?? true} disabled={disabled} onClick={() => speech({ enabled: !state?.speech.enabled })}>{(state?.speech.enabled ?? true) ? "Bật" : "Tắt"}</button>
      </div>
      <div className="pet-settings-row">
        <div><p id="pet-sound-label" className="pet-settings-label">Âm báo ting</p><p>Chuông ngắn khi chờ bạn, hoàn thành hoặc lỗi; không đọc lời thoại.</p></div>
        <button type="button" role="switch" aria-labelledby="pet-sound-label" aria-checked={state?.speech.sound ?? true} disabled={disabled} onClick={() => speech({ sound: !state?.speech.sound })}>{(state?.speech.sound ?? true) ? "Bật" : "Tắt"}</button>
      </div>
      <div className="pet-settings-row">
        <div><p className="pet-settings-label">Lời thoại cục bộ</p>
          <p>{state?.dialogueModel ? `Đã lưu từ ${state.dialogueModel} — ${new Date(state.generatedAt).toLocaleString("vi-VN")}` : "Đang dùng lời thoại mặc định offline."}</p>
          <p>Model đã chọn trong chat: {model || "Chưa có — mở chat và chọn model AMECODE trước."}</p>
          <p>Chỉ gửi prompt tạo câu thoại mẫu, không gửi hội thoại hay mã nguồn. Nút tạo dùng tài khoản AmeKit và có thể phát sinh phí model; không tự tạo lại.</p>
        </div>
        <button type="button" disabled={disabled || !!state?.generating || !model} onClick={() => void run(() => props.onGenerateDialogue(model), "Không tạo được lời thoại. Kiểm tra đăng nhập, model AMECODE và kết nối; vẫn giữ lời thoại cục bộ trước đó.")}>{state?.generating ? "Đang tạo…" : "Tạo lời thoại"}</button>
      </div>
      <div className="pet-settings-row"><p>Thử bong bóng và chuông bằng lời thoại đã lưu, không gọi LLM.</p><button type="button" disabled={disabled || !state?.preferences.enabled || !state?.speech.enabled} onClick={() => void run(props.onTestSpeech, "Không thể thử lời thoại.")}>Thử lời thoại</button></div>
    </div>
    {!state && <p role="status">Đang kết nối pet runtime…</p>}
    {alert && <p className="pet-settings-error" role="alert">{alert}</p>}
  </section>
}
