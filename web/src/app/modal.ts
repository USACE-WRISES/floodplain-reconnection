// Dialogs with Bootstrap 5's markup and classes (its stylesheet is in the page), opened and closed
// here: one dialog at a time, closed by its X, a Close button, Escape or a click outside it.
import { el, esc } from './html'

let open: { root: HTMLElement, backdrop: HTMLElement, onClose?: () => void, keys: (e: KeyboardEvent) => void } | null = null

export interface ModalOptions {
  /** 'lg' or 'xl' for a wider dialog */
  size?: 'lg' | 'xl'
  /** the footer's markup (a Close button when not given; '' for none) */
  footer?: string
  onClose?: () => void
}

/** Shows a dialog; returns its body element (for wiring what it holds). */
export function showModal(title: string, body: string, opts: ModalOptions = {}): HTMLElement {
  closeModal()
  const footer = opts.footer ?? '<button type="button" class="btn btn-outline-secondary btn-sm" data-close>Close</button>'
  const root = el(`
    <div class="modal fade" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="fpr-modal-title">
      <div class="modal-dialog modal-dialog-scrollable${opts.size ? ` modal-${opts.size}` : ''}">
        <div class="modal-content">
          <button type="button" class="fpr-modal-x" aria-label="Close" data-close>&times;</button>
          <div class="modal-header"><h4 class="modal-title" id="fpr-modal-title">${esc(title)}</h4></div>
          <div class="modal-body">${body}</div>
          ${footer ? `<div class="modal-footer">${footer}</div>` : ''}
        </div>
      </div>
    </div>`)
  const backdrop = el('<div class="modal-backdrop fade"></div>')
  document.body.append(backdrop, root)
  document.body.classList.add('modal-open')
  root.style.display = 'block'
  const keys = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeModal()
  }
  document.addEventListener('keydown', keys)
  root.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    if (t === root || t.closest('[data-close]')) closeModal()
  })
  open = { root, backdrop, onClose: opts.onClose, keys }
  requestAnimationFrame(() => {
    root.classList.add('show')
    backdrop.classList.add('show')
    root.querySelector<HTMLElement>('.fpr-modal-x')?.focus({ preventScroll: true })
  })
  return root.querySelector<HTMLElement>('.modal-body')!
}

export function closeModal(): void {
  if (!open) return
  const { root, backdrop, onClose, keys } = open
  open = null
  document.removeEventListener('keydown', keys)
  root.remove()
  backdrop.remove()
  document.body.classList.remove('modal-open')
  onClose?.()
}

export function modalOpen(): boolean {
  return open !== null
}
