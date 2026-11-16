// Minimal WebSocket stand-in shared by tests, the client only touches
// send/close plus its event handlers, and close() delivers onclose on a later
// task like a browser does.
export class MockWebSocket {
  static instances: MockWebSocket[] = []

  url: string
  sent: string[] = []
  readyState = 0 // CONNECTING

  onopen: ((ev?: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((err?: unknown) => void) | null = null

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  open() {
    this.readyState = 1
    this.onopen?.()
  }

  send(data: string) {
    this.sent.push(data)
  }

  message(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    setTimeout(() => this.onclose?.(), 0)
  }
}
