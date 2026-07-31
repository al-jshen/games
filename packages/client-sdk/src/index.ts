import {
  PROTOCOL_VERSION,
  normalizeCode,
  parseServerFrame,
  type ClientFrame,
  type LogEntry,
  type PlayerInfo,
  type ServerFrame,
  type Snapshot,
} from '@games/protocol';

/**
 * The client half of the protocol. Used by the web app *and* available to TypeScript bots — if the
 * UI depends on it, it stays honest, rather than rotting as a neglected wrapper.
 *
 * Two things it does that matter for feel:
 *  - reconnects with backoff while keeping the last known view on screen, so a flaky network shows
 *    a banner rather than a blank board;
 *  - applies your own move locally before the server answers, using the game's own reducer, so your
 *    move renders at 0 ms instead of one round trip.
 */

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'closed';

export interface MatchState {
  status: ConnectionStatus;
  /** Games this server offers, from the handshake. */
  games: { id: string; title: string; blurb: string; minPlayers: number; maxPlayers: number; estMinutes: [number, number] }[];
  code: string | null;
  matchId: string | null;
  gameId: string | null;
  seat: number | null;
  /** Server-confirmed snapshot. */
  confirmed: Snapshot | null;
  /**
   * What to render: `confirmed` with any unacknowledged local move applied on top. Identical to
   * `confirmed` whenever there is nothing pending.
   */
  view: unknown;
  version: number;
  actors: number[];
  players: PlayerInfo[];
  log: LogEntry[];
  /** Set when the server refused something; cleared on the next successful action. */
  error: { code: string; message: string } | null;
  /** True while a local move is applied but unconfirmed. */
  pending: boolean;
  /** Server-enumerated legal actions, populated only after `requestLegalActions()`. */
  legal: { version: number; actions: unknown[]; truncated: boolean } | null;
}

/**
 * The slice of a game module the client needs for prediction. Deliberately structural, so the web
 * app can hand over a lazily-imported module without the SDK depending on any game.
 */
export interface PredictionAdapter {
  /** Run the rules against a *redacted view*. Must set `unresolved` on contact with hidden info. */
  applyToView(view: unknown, seat: number, action: unknown): { ok: true; state: unknown; unresolved?: boolean } | { ok: false };
}

export interface ClientOptions {
  url?: string;
  /** Where to persist session tokens; omit to disable resume (e.g. for bots). */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  onChange?: (state: MatchState) => void;
  /** Called for each batch of effects, for animations and sound. */
  onEffects?: (seat: number, effects: Record<string, unknown>[]) => void;
}

function defaultUrl(): string {
  if (typeof location === 'undefined') return 'ws://localhost:8787/ws';
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/ws`;
}

let actionCounter = 0;
function newActionId(): string {
  actionCounter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${Date.now().toString(36)}-${actionCounter}-${rand}`;
}

export class GameClient {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly storage: ClientOptions['storage'];
  private readonly onChange: ((s: MatchState) => void) | undefined;
  private readonly onEffects: ClientOptions['onEffects'];
  private adapter: PredictionAdapter | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUs = false;
  /** At most one unacknowledged move in a strictly turn-based game, so depth is 0 or 1. */
  private pendingAction: { id: string; action: unknown } | null = null;
  private queuedIntent: ClientFrame | null = null;

  state: MatchState = {
    status: 'connecting',
    games: [],
    code: null,
    matchId: null,
    gameId: null,
    seat: null,
    confirmed: null,
    view: null,
    version: 0,
    actors: [],
    players: [],
    log: [],
    error: null,
    pending: false,
    legal: null,
  };

  constructor(options: ClientOptions = {}) {
    this.url = options.url ?? defaultUrl();
    this.storage =
      options.storage === undefined
        ? typeof localStorage === 'undefined'
          ? null
          : localStorage
        : options.storage;
    this.onChange = options.onChange;
    this.onEffects = options.onEffects;
  }

  /** Register the game's reducer so local moves can render immediately. Optional. */
  setPredictionAdapter(adapter: PredictionAdapter | null): void {
    this.adapter = adapter;
  }

  private emit(): void {
    this.onChange?.(this.state);
  }

  private patch(next: Partial<MatchState>): void {
    this.state = { ...this.state, ...next };
    this.emit();
  }

  private tokenKey(code: string): string {
    return `match:${code}`;
  }

  private saveToken(code: string, token: string): void {
    try {
      this.storage?.setItem(this.tokenKey(code), token);
    } catch {
      // Private browsing or a full quota: resume is a nice-to-have, not worth failing over.
    }
  }

  private loadToken(code: string): string | null {
    try {
      return this.storage?.getItem(this.tokenKey(code)) ?? null;
    } catch {
      return null;
    }
  }

  connect(resumeCode?: string): void {
    this.closedByUs = false;
    const code = resumeCode ? normalizeCode(resumeCode) : this.state.code;
    this.patch({ status: this.state.confirmed ? 'reconnecting' : 'connecting' });

    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      const token = code ? this.loadToken(code) : null;
      this.send({
        t: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        ...(token ? { sessionToken: token } : {}),
      });
    };

    ws.onmessage = (event) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const parsed = parseServerFrame(raw);
      if (parsed.ok) this.handle(parsed.frame);
    };

    ws.onclose = () => {
      this.ws = null;
      if (this.closedByUs) {
        this.patch({ status: 'closed' });
        return;
      }
      // Keep the last known view on screen behind a banner; never blank the board.
      this.patch({ status: 'reconnecting' });
      this.scheduleReconnect(code ?? undefined);
    };

    ws.onerror = () => {
      // `onclose` always follows, so recovery is handled in one place.
    };
  }

  private scheduleReconnect(code?: string): void {
    if (this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    // Exponential backoff with jitter, capped so a returning laptop reconnects promptly.
    const base = Math.min(5000, 300 * 2 ** Math.min(this.reconnectAttempt, 5));
    const delay = base / 2 + Math.random() * (base / 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(code);
    }, delay);
  }

  private send(frame: ClientFrame): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  private handle(frame: ServerFrame): void {
    switch (frame.t) {
      case 'hello_ok': {
        this.patch({ status: 'connected', games: frame.games });
        if (!frame.resumed && this.queuedIntent) {
          this.send(this.queuedIntent);
          this.queuedIntent = null;
        }
        return;
      }

      case 'joined': {
        this.saveToken(frame.code, frame.sessionToken);
        this.patch({
          code: frame.code,
          matchId: frame.matchId,
          gameId: frame.gameId,
          seat: frame.seat,
        });
        return;
      }

      case 'sync': {
        // Authoritative reset: drop any local prediction rather than trying to rebase it.
        this.pendingAction = null;
        this.adoptSnapshot(frame.snapshot, { log: frame.log, pending: false });
        return;
      }

      case 'applied': {
        if (frame.clientActionId && frame.clientActionId === this.pendingAction?.id) {
          this.pendingAction = null;
        }
        this.adoptSnapshot(frame.snapshot, {
          log: [...this.state.log, { version: frame.snapshot.version, seat: frame.seat, effects: frame.effects }],
          pending: this.pendingAction !== null,
          error: null,
        });
        this.onEffects?.(frame.seat, frame.effects);
        return;
      }

      case 'rejected': {
        // The snapshot attached to a rejection is the truth, so one round trip both refuses the
        // move and repairs the client.
        this.pendingAction = null;
        this.adoptSnapshot(frame.snapshot, {
          pending: false,
          error: { code: frame.code, message: frame.message },
        });
        return;
      }

      case 'legal':
        this.patch({ legal: { version: frame.version, actions: frame.actions, truncated: frame.truncated } });
        return;

      case 'presence':
        this.patch({ players: frame.players });
        return;

      case 'over':
        this.adoptSnapshot(frame.snapshot, { pending: false });
        return;

      case 'error':
        this.patch({ error: { code: frame.code, message: frame.message } });
        return;

      case 'pong':
        return;
    }
  }

  private adoptSnapshot(snapshot: Snapshot, extra: Partial<MatchState> = {}): void {
    this.patch({
      confirmed: snapshot,
      view: snapshot.view,
      version: snapshot.version,
      actors: snapshot.actors,
      players: snapshot.players,
      code: snapshot.code,
      matchId: snapshot.matchId,
      gameId: snapshot.gameId,
      seat: snapshot.players.find((p) => p.you)?.seat ?? this.state.seat,
      ...extra,
    });
  }

  /* ---------------------------------------------------------------- intents */

  createMatch(gameId: string, name?: string, options?: unknown): void {
    const frame: ClientFrame = { t: 'create', gameId, ...(name ? { name } : {}), ...(options ? { options } : {}) };
    if (this.state.status === 'connected') this.send(frame);
    else this.queuedIntent = frame;
  }

  joinMatch(code: string, name?: string): void {
    const normalized = normalizeCode(code);
    this.patch({ code: normalized });
    const token = this.loadToken(normalized);
    if (token) {
      // Prefer reclaiming a seat we already hold over taking a second one.
      this.connect(normalized);
      return;
    }
    const frame: ClientFrame = { t: 'join', code: normalized, ...(name ? { name } : {}) };
    if (this.state.status === 'connected') this.send(frame);
    else this.queuedIntent = frame;
  }

  /**
   * Submit an action, rendering it locally first when it is safe to do so.
   *
   * "Safe" means the prediction adapter could resolve it without touching hidden information. A
   * move that would require guessing a shuffled bag or a face-down deck is *not* predicted: a
   * snap-back on a revealed card looks like a bug, and worse, teaches players that the client
   * sometimes knows things it should not.
   */
  submit(action: unknown): void {
    const id = newActionId();
    const seat = this.state.seat;

    if (this.adapter && seat !== null && this.state.confirmed) {
      const predicted = this.adapter.applyToView(this.state.view, seat, action);
      if (predicted.ok && !predicted.unresolved) {
        this.pendingAction = { id, action };
        this.patch({ view: predicted.state, pending: true, error: null });
      }
    }

    this.send({ t: 'action', expectVersion: this.state.version, clientActionId: id, action });
  }

  requestLegalActions(): void {
    this.send({ t: 'legalActions' });
  }

  resync(): void {
    this.send({ t: 'resync' });
  }

  /** Forget the stored seat for a code, so the next join takes a fresh seat. */
  forget(code: string): void {
    try {
      this.storage?.removeItem(this.tokenKey(normalizeCode(code)));
    } catch {
      // Nothing to do; the token simply stays.
    }
  }

  close(): void {
    this.closedByUs = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}

export { PROTOCOL_VERSION, normalizeCode };
export type { Snapshot, PlayerInfo, LogEntry };
