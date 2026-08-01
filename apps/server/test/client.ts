import { PROTOCOL_VERSION, type ServerFrame } from '@games/protocol';
import { WebSocket } from 'ws';

/** A tiny client that queues frames so tests can await the next one of a given type. */
export class TestClient {
  private readonly ws: WebSocket;
  private readonly queue: ServerFrame[] = [];
  private readonly waiters: { match: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }[] = [];
  sessionToken: string | null = null;
  seat: number | null = null;

  private constructor(url: string) {
    this.ws = new WebSocket(url, { perMessageDeflate: false });
    this.ws.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as ServerFrame;
      if (frame.t === 'joined') {
        this.sessionToken = frame.sessionToken;
        this.seat = frame.seat;
      }
      const idx = this.waiters.findIndex((w) => w.match(frame));
      if (idx >= 0) {
        const [waiter] = this.waiters.splice(idx, 1);
        waiter!.resolve(frame);
      } else {
        this.queue.push(frame);
      }
    });
  }

  static async connect(url: string): Promise<TestClient> {
    const client = new TestClient(url);
    await new Promise<void>((done, fail) => {
      client.ws.once('open', () => done());
      client.ws.once('error', fail);
    });
    return client;
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  /** Wait for the next frame of type `t` (checking already-queued frames first). */
  next<T extends ServerFrame['t']>(t: T, extra?: (f: ServerFrame) => boolean): Promise<Extract<ServerFrame, { t: T }>> {
    const match = (f: ServerFrame) => f.t === t && (!extra || extra(f));
    const idx = this.queue.findIndex(match);
    if (idx >= 0) {
      const [frame] = this.queue.splice(idx, 1);
      return Promise.resolve(frame as Extract<ServerFrame, { t: T }>);
    }
    return new Promise((resolve) => {
      this.waiters.push({ match, resolve: (f) => resolve(f as Extract<ServerFrame, { t: T }>) });
    });
  }

  async hello(sessionToken?: string): Promise<Extract<ServerFrame, { t: 'hello_ok' }>> {
    this.send({ t: 'hello', protocolVersion: PROTOCOL_VERSION, ...(sessionToken ? { sessionToken } : {}) });
    return this.next('hello_ok');
  }

  /**
   * Ask for the authoritative snapshot, discarding any earlier ones still sitting in the queue.
   * Joining a room produces a sync per seat change, so without this a later `resync` can be
   * answered by a stale frame from before the moves under test.
   */
  resync(): Promise<Extract<ServerFrame, { t: 'sync' }>> {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i]!.t === 'sync') this.queue.splice(i, 1);
    }
    this.send({ t: 'resync' });
    return this.next('sync');
  }

  close(): void {
    this.ws.close();
  }
}
