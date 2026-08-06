import {
  ErrorCodes,
  PROTOCOL_VERSION,
  normalizeCode,
  parseServerFrame,
  type ClientFrame,
  type ChatMessage,
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
  /**
   * An undo waiting on agreement. Set on both players: the proposer is waiting, the other is being
   * asked. `null` whenever nothing is on the table.
   */
  undo: PendingUndoState | null;
  /** How the last undo ended, for a one-line note after the dialog closes. */
  lastUndo: { accepted: boolean; by?: number; reason?: string } | null;
  /** Table talk, oldest first. */
  chat: ChatMessage[];
  /**
   * Set once a rematch exists and this client holds a seat in it. The token is already stored, so the
   * app only has to navigate; the new match is entered the same way any other resume is.
   */
  rematch: { code: string; by: number } | null;
}

export interface PendingUndoState {
  /** Who proposed it. Compare with your own seat to know whether you are asking or answering. */
  by: number;
  /** Whose move is on the table. */
  targetSeat: number;
  atVersion: number;
  /** Effects of the move in question, redacted for you, ready for the game's own describer. */
  effects: Record<string, unknown>[];
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
    undo: null,
    lastUndo: null,
    chat: [],
    rematch: null,
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

  /** Drop a seat token we know is dead, so it stops showing up as a resumable game. */
  private forgetToken(code: string | null): void {
    if (!code) return;
    try {
      this.storage?.removeItem(this.tokenKey(code));
    } catch {
      // Unreadable storage; nothing to clean up.
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
        this.adoptSnapshot(frame.snapshot, {
          log: frame.log,
          pending: false,
          // A sync carries the whole conversation, so it replaces rather than merges. An older
          // server that sends none leaves what we have alone rather than wiping it.
          ...(frame.chat ? { chat: frame.chat } : {}),
        });
        return;
      }

      case 'applied': {
        if (frame.clientActionId && frame.clientActionId === this.pendingAction?.id) {
          this.pendingAction = null;
        }
        this.adoptSnapshot(frame.snapshot, {
          log: [
            ...this.state.log,
            { version: frame.snapshot.version, seat: frame.seat, at: frame.at, effects: frame.effects },
          ],
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

      case 'undoProposed':
        this.patch({
          undo: {
            by: frame.by,
            targetSeat: frame.targetSeat,
            atVersion: frame.atVersion,
            effects: frame.effects,
          },
          lastUndo: null,
        });
        return;

      case 'undoResolved':
        /*
         * Only closes the dialog. An accepted undo also brings a `sync`, and that is what actually
         * rewinds the board -- so the state change arrives through the one path that already knows
         * how to drop local prediction and adopt the server's word.
         */
        this.patch({
          undo: null,
          lastUndo: {
            accepted: frame.accepted,
            ...(frame.by === undefined ? {} : { by: frame.by }),
            ...(frame.reason === undefined ? {} : { reason: frame.reason }),
          },
        });
        return;

      case 'rematch':
        /*
         * Store the seat token before announcing it. The app navigates on this, and arriving at the
         * new match without its token would mean asking to join a room that already has both seats
         * filled -- so the order matters.
         */
        this.saveToken(frame.code, frame.sessionToken);
        this.patch({ rematch: { code: frame.code, by: frame.by } });
        return;

      case 'chat': {
        // Ignore a line we already have: a reconnect can deliver a sync and a broadcast that overlap.
        if (this.state.chat.some((m) => m.id === frame.message.id)) return;
        this.patch({ chat: [...this.state.chat, frame.message] });
        return;
      }

      case 'presence':
        this.patch({ players: frame.players });
        return;

      case 'over':
        this.adoptSnapshot(frame.snapshot, { pending: false });
        return;

      case 'error':
        if (frame.code === ErrorCodes.MATCH_CLOSED) {
          /*
           * Terminal. The room is gone for good, so stop trying to get back into it -- otherwise the
           * socket closing behind this frame would start a reconnect loop against a match that will
           * never answer, and the player would sit watching "Reconnecting…" for ever.
           */
          this.closedByUs = true;
          this.forgetToken(this.state.code);
          this.patch({ error: { code: frame.code, message: frame.message }, undo: null });
          return;
        }
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

  /** Say something to the other player. Empty or whitespace-only messages are dropped server-side. */
  say(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    this.send({ t: 'chat', text: trimmed.slice(0, 500) });
  }

  /** Play again: same game, same two people, sides swapped. Both must be connected. */
  requestRematch(): void {
    this.send({ t: 'rematch' });
  }

  /** Propose taking the last move back. Does nothing until the other player agrees. */
  requestUndo(): void {
    this.send({ t: 'undoRequest' });
  }

  /** Answer a proposal — or, if you are the one who proposed it, withdraw it with `false`. */
  respondUndo(accept: boolean): void {
    this.send({ t: 'undoRespond', accept });
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
export type { Snapshot, PlayerInfo, LogEntry, ChatMessage };
