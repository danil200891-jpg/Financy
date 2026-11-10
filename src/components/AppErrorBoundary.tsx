import { Component, type ReactNode } from 'react'
import { exportJSON } from '../lib/backup'

/** Keep a render failure recoverable without clearing financial storage. */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean; message: string }> {
  state = { failed: false, message: '' }
  static getDerivedStateFromError() { return { failed: true } }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div role="alert" className="mx-auto max-w-[520px] space-y-4 px-5 pt-[calc(env(safe-area-inset-top)+32px)]">
        <h1 className="text-[22px] font-semibold">Не удалось показать экран</h1>
        <p className="text-[15px] text-mist">Данные остаются на устройстве. Сохраните резервную копию и перезапустите приложение.</p>
        <button className="glass press h-14 w-full rounded-2xl" onClick={async () => {
          try { await exportJSON() } catch { this.setState({ message: 'Не удалось сохранить файл. Попробуйте снова.' }) }
        }}>Сохранить резервную копию</button>
        <button className="glass press h-14 w-full rounded-2xl" onClick={() => location.reload()}>Перезапустить приложение</button>
        {this.state.message && <p className="text-[14px] text-amber">{this.state.message}</p>}
      </div>
    )
  }
}
