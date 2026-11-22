import { useEffect, useRef, useState, type FormEvent } from "react"
import type { DebugSessionSnapshot, DebugStatus } from "../../../../../packages/ide-core/src/debugger"

export function formatDebugStatus(status: DebugStatus): { label: string; tone: string } {
  switch (status) {
    case "idle": return { label: "Chưa chạy", tone: "muted" }
    case "running": return { label: "Đang chạy", tone: "success" }
    case "paused": return { label: "Tạm dừng", tone: "warning" }
    case "exited": return { label: "Đã kết thúc", tone: "muted" }
  }
}

export type DebugPanelProps = {
  snapshot: DebugSessionSnapshot
  output: { stream: "stdout" | "stderr" | "console"; text: string }[]
  entry: string
  selectedFrameId?: string
  onEntryChange: (entry: string) => void
  onStart: (entry: string) => void
  onStop: () => void
  onContinue: () => void
  onPause: () => void
  onStepOver: () => void
  onStepInto: () => void
  onStepOut: () => void
  onSelectFrame: (callFrameId: string, path: string, line: number, column: number) => void
  onOpenLocation: (path: string, line: number, column: number) => void
  onRemoveBreakpoint: (path: string, line: number) => void
  onEvaluate: (expression: string) => Promise<{ value: string; type: string; error?: string }>
  onClearOutput?: () => void
}

export function DebugPanel({ snapshot, output, entry, selectedFrameId, onEntryChange, onStart, onStop,
  onContinue, onPause, onStepOver, onStepInto, onStepOut, onSelectFrame, onOpenLocation,
  onRemoveBreakpoint, onEvaluate, onClearOutput }: DebugPanelProps) {
  useEffect(() => { void import("../debug-panel.css") }, [])
  const [expression, setExpression] = useState("")
  const [evaluating, setEvaluating] = useState(false)
  const [result, setResult] = useState<{ value: string; type: string; error?: string } | null>(null)
  const evaluationPending = useRef(false)
  const paused = snapshot.status === "paused"
  const active = paused || snapshot.status === "running"
  const status = formatDebugStatus(snapshot.status)
  const currentFrameId = selectedFrameId ?? snapshot.frames[0]?.callFrameId
  const evaluate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const input = expression.trim()
    if (!active || !input || evaluationPending.current) return
    evaluationPending.current = true
    setEvaluating(true)
    setResult(null)
    try { setResult(await onEvaluate(input)) }
    catch (error) { setResult({ value: "", type: "error", error: error instanceof Error ? error.message : String(error) }) }
    finally { evaluationPending.current = false; setEvaluating(false) }
  }
  return <section className="debug-panel" aria-label="Gỡ lỗi">
    <header className="debug-header">
      <h2>Gỡ lỗi</h2>
      <span role="status" className={`debug-status debug-tone-${status.tone}`}>{status.label}</span>
      {snapshot.exitCode !== undefined && <span className="debug-muted">Mã thoát: {snapshot.exitCode}</span>}
    </header>
    <form className="debug-entry" onSubmit={event => { event.preventDefault(); if (!active && entry.trim()) onStart(entry.trim()) }}>
      <label>Tệp khởi chạy<input type="text" placeholder="src/app.ts" value={entry} disabled={active} onChange={event => onEntryChange(event.target.value)} /></label>
      <button type="submit" disabled={active || !entry.trim()}>Bắt đầu</button>
      <button type="button" disabled={!active} onClick={onStop}>Dừng</button>
    </form>
    <div className="debug-actions" role="group" aria-label="Điều khiển gỡ lỗi">
      <button type="button" disabled={!paused} onClick={onContinue}>Tiếp tục</button>
      <button type="button" disabled={snapshot.status !== "running"} onClick={onPause}>Tạm dừng</button>
      <button type="button" disabled={!paused} onClick={onStepOver}>Bước qua</button>
      <button type="button" disabled={!paused} onClick={onStepInto}>Bước vào</button>
      <button type="button" disabled={!paused} onClick={onStepOut}>Bước ra</button>
    </div>
    <section className="debug-section" aria-label="Ngăn xếp lời gọi">
      <h3>Ngăn xếp lời gọi</h3>
      {!snapshot.frames.length && <p className="debug-muted">Chưa có khung gọi.</p>}
      <ol className="debug-list">
        {snapshot.frames.map(frame => <li key={frame.callFrameId}>
          <button type="button" className="debug-location" disabled={!paused} aria-current={currentFrameId === frame.callFrameId ? "true" : undefined}
            onClick={() => onSelectFrame(frame.callFrameId, frame.path, frame.line, frame.column)}>
            <strong>{frame.functionName || "(ẩn danh)"}</strong> <span>{frame.path}:{frame.line}:{frame.column}</span>
          </button>
        </li>)}
      </ol>
    </section>
    <section className="debug-section" aria-label="Biến cục bộ">
      <h3>Biến cục bộ</h3>
      {!snapshot.variables.length && <p className="debug-muted">Chưa có biến cục bộ.</p>}
      <dl className="debug-variables">{snapshot.variables.map((variable, index) => <div key={`${variable.name}:${index}`}>
        <dt>{variable.name} <small>({variable.type})</small></dt><dd>{variable.value}</dd>
      </div>)}</dl>
    </section>
    <section className="debug-section" aria-label="Điểm dừng">
      <h3>Điểm dừng</h3>
      {!snapshot.breakpoints.length && <p className="debug-muted">Chưa có điểm dừng.</p>}
      <ul className="debug-list">{snapshot.breakpoints.map((breakpoint, index) => <li className="debug-breakpoint" key={`${breakpoint.path}:${breakpoint.line}:${index}`}>
        <button type="button" className="debug-location" onClick={() => onOpenLocation(breakpoint.path, breakpoint.line, 1)}>
          <span>{breakpoint.path}:{breakpoint.line}</span>
          <small className={breakpoint.verified ? "debug-tone-success" : "debug-muted"}>{breakpoint.verified ? "Đã xác minh" : "Chưa xác minh"}</small>
        </button>
        <button type="button" aria-label={`Xóa điểm dừng ${breakpoint.path}:${breakpoint.line}`} onClick={() => onRemoveBreakpoint(breakpoint.path, breakpoint.line)}>Xóa</button>
      </li>)}</ul>
    </section>
    <section className="debug-section" aria-label="Bảng điều khiển đầu ra">
      <header className="debug-header"><h3>Bảng điều khiển đầu ra</h3>
        <button type="button" disabled={!onClearOutput || !output.length} onClick={onClearOutput}>Xóa đầu ra</button>
      </header>
      {!output.length && <p className="debug-muted">Chưa có đầu ra.</p>}
      <pre className="debug-output" role="log" aria-label="Đầu ra gỡ lỗi" aria-live="polite">{output.map((item, index) => <span className={`debug-output-${item.stream}`} key={index}>{item.text}</span>)}</pre>
      <form className="debug-evaluate" onSubmit={evaluate} aria-busy={evaluating}>
        <label>Biểu thức<input type="text" placeholder="Nhập biểu thức..." value={expression} disabled={!active || evaluating} onChange={event => setExpression(event.target.value)} /></label>
        <button type="submit" disabled={!active || !expression.trim() || evaluating}>{evaluating ? "Đang đánh giá…" : "Đánh giá"}</button>
      </form>
      {result && <div className={result.error ? "debug-evaluation-error" : "debug-result"} role={result.error ? "alert" : "status"}>
        {result.error ? result.error : <><span>{result.type}</span><pre>{result.value}</pre></>}
      </div>}
    </section>
  </section>
}
