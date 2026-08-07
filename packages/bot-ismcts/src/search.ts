import { RandomCursor, type GameModule, type Seat } from '@games/engine';
import type { SearchConfig } from './config.js';
import { DEFAULT_CONFIG } from './config.js';

/**
 * Information Set Monte Carlo Tree Search.
 *
 * Plain MCTS assumes you know which position you are in. Under imperfect information you do not, so
 * each iteration samples a world consistent with what you *do* know, and searches that. The trap is
 * that a tree of *states* would then let the search pick a different move in each sampled world —
 * planning as if it will know the answer later, when in reality it must commit blind. That is
 * strategy fusion, and it is why the tree here is keyed on the acting player's **information set**:
 * indistinguishable worlds share a node, so there is only one place to record a preference and the
 * search is physically unable to have it both ways.
 *
 * The other thing ISMCTS has to get right is the exploration term. Different sampled worlds make
 * different moves legal, so a move seen twice in ten iterations because it was rarely *available* is
 * not the same as one tried twice in ten because it looked bad. UCB therefore counts how often each
 * action was available, not how often the node was visited.
 */

/** Sample a concrete state the searcher might be in, given what this seat can see. */
export type Determinizer<S, V> = (view: V, seat: Seat, rng: RandomCursor) => S;

/**
 * Score a position for `seat`, in [-1, 1], where 1 is winning. Called at leaves and after truncated
 * rollouts, so it must be cheap.
 */
export type Evaluator<S> = (state: S, seat: Seat) => number;

export interface SearchDeps<S, A, V, O> {
  mod: GameModule<S, A, V, O>;
  determinize: Determinizer<S, V>;
  evaluate: Evaluator<S>;
  /** Optional rollout bias. Return an index into `actions`; omit for uniform. */
  rolloutPolicy?: (state: S, seat: Seat, actions: A[], rng: RandomCursor) => number;
  /**
   * Optional fast path for rollouts: pick one legal action without enumerating them all.
   *
   * A rollout needs a single move, but `legalActions` builds every one of them and the rollout
   * discards the rest. Where a game can propose-and-check more cheaply than it can enumerate, this
   * is where it says so.
   */
  sampleAction?: (state: S, seat: Seat, rng: RandomCursor) => A | null;
}

interface Node<A> {
  /** Mean value from the searching seat's point of view. */
  total: number;
  visits: number;
  children: Map<string, Node<A>>;
  /** How often each action was legal in a sampled world that reached here. See the note above. */
  available: Map<string, number>;
  actions: Map<string, A>;
}

const newNode = <A>(): Node<A> => ({
  total: 0,
  visits: 0,
  children: new Map(),
  available: new Map(),
  actions: new Map(),
});

export interface SearchResult<A> {
  action: A;
  /** Visit share per action, most-visited first. The search's opinion, not just its pick. */
  ranking: { action: A; visits: number; value: number }[];
  iterations: number;
  /**
   * The search's own estimate of the position, in [-1, 1] from the searching seat's point of view.
   *
   * Worth recording alongside the eventual result, because unlike the result it *varies per
   * position*. Every position in a game carries the same outcome label, so the value target is one
   * bit per game shared across a hundred rows; a search estimate is a fresh number each time. Mixing
   * the two is the standard bias-for-variance trade: Leela Chess Zero trains its value head on
   * `q_ratio * Q + (1 - q_ratio) * Z`, for exactly this reason.
   */
  rootValue: number;
  /** Spread of leaf evaluations seen. Narrow means the exploration term is swamping the values. */
  valueRange: { min: number; max: number };
}

export function search<S, A, V, O>(
  deps: SearchDeps<S, A, V, O>,
  view: V,
  seat: Seat,
  config: SearchConfig = DEFAULT_CONFIG,
): SearchResult<A> {
  return runSearch(deps, view, seat, config, newNode<A>());
}

function runSearch<S, A, V, O>(
  deps: SearchDeps<S, A, V, O>,
  view: V,
  seat: Seat,
  config: SearchConfig,
  root: Node<A>,
): SearchResult<A> {
  const { determinize } = deps;
  const rng = new RandomCursor(config.seed, 0);

  /*
   * With common random numbers the same worlds are reused round-robin, so every action ends up
   * compared against the same set. Without it each iteration draws fresh, which is standard ISMCTS
   * and independent across actions.
   */
  const pool = config.commonRandomNumbers
    ? Array.from({ length: config.worldPool }, () => determinize(view, seat, rng))
    : null;

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < config.iterations; i++) {
    const world = pool
      ? clone(pool[i % pool.length] as S)
      : determinize(view, seat, rng);
    descend(deps, world, seat, root, config, rng, 0, (v) => {
      if (v < min) min = v;
      if (v > max) max = v;
    });
  }

  const ranking = [...root.children.entries()]
    .map(([key, child]) => ({
      action: root.actions.get(key) as A,
      visits: child.visits,
      value: child.visits > 0 ? child.total / child.visits : 0,
    }))
    .sort((a, b) => b.visits - a.visits);

  if (ranking.length === 0) throw new Error('search: no legal action at the root');

  return {
    action: ranking[0]!.action,
    ranking,
    iterations: config.iterations,
    rootValue: root.visits > 0 ? root.total / root.visits : 0,
    valueRange: { min: Number.isFinite(min) ? min : 0, max: Number.isFinite(max) ? max : 0 },
  };
}

/** One iteration: walk the tree in this world, expand a leaf, evaluate, and back the value up. */
function descend<S, A, V, O>(
  deps: SearchDeps<S, A, V, O>,
  state: S,
  seat: Seat,
  node: Node<A>,
  config: SearchConfig,
  rng: RandomCursor,
  depth: number,
  noteValue: (v: number) => void,
): number {
  const { mod } = deps;
  if (mod.outcome(state).status === 'over' || depth > 200) {
    const value = terminalValue(mod, state, seat);
    noteValue(value);
    backup(node, value);
    return value;
  }

  const actor = mod.currentActors(state)[0];
  if (actor === undefined) {
    const value = terminalValue(mod, state, seat);
    noteValue(value);
    backup(node, value);
    return value;
  }

  const { actions } = mod.legalActions(state, actor);
  if (actions.length === 0) {
    const value = terminalValue(mod, state, seat);
    noteValue(value);
    backup(node, value);
    return value;
  }

  // Availability is counted for every legal action, whether or not it is the one taken. This is what
  // stops a rarely-legal action looking unpopular rather than merely unavailable.
  const keys = actions.map((a) => key(a));
  for (const [i, k] of keys.entries()) {
    node.available.set(k, (node.available.get(k) ?? 0) + 1);
    if (!node.actions.has(k)) node.actions.set(k, actions[i] as A);
  }

  const untried = keys.filter((k) => !node.children.has(k));
  let chosen: string;
  if (untried.length > 0) {
    chosen = untried[rng.int(untried.length)] as string;
    node.children.set(chosen, newNode<A>());
    const child = node.children.get(chosen) as Node<A>;
    const next = applyOrThrow(mod, state, actor, node.actions.get(chosen) as A);
    const value = leafValue(deps, next, seat, config, rng);
    noteValue(value);
    backup(child, value);
    backup(node, value);
    return value;
  }

  chosen = select(node, keys, config, actor === seat);
  const next = applyOrThrow(mod, state, actor, node.actions.get(chosen) as A);
  const child = node.children.get(chosen) as Node<A>;
  const value = descend(deps, next, seat, child, config, rng, depth + 1, noteValue);
  backup(node, value);
  return value;
}

/**
 * UCB over the actions legal in *this* world, using availability counts.
 *
 * The opponent is assumed to be trying to win too, so at their nodes the sign flips — they pick what
 * is worst for us.
 */
function select<A>(node: Node<A>, keys: string[], config: SearchConfig, ours: boolean): string {
  let bestKey = keys[0] as string;
  let bestScore = Number.NEGATIVE_INFINITY;

  let lo = 0;
  let hi = 1;
  if (config.normaliseValues) {
    const means = keys
      .map((k) => node.children.get(k))
      .filter((c): c is Node<A> => Boolean(c) && (c as Node<A>).visits > 0)
      .map((c) => c.total / c.visits);
    if (means.length > 1) {
      lo = Math.min(...means);
      hi = Math.max(...means);
    }
  }
  const rescale = (v: number) => {
    if (!config.normaliseValues || hi - lo < 1e-9) return (v + 1) / 2;
    return (v - lo) / (hi - lo);
  };

  for (const k of keys) {
    const child = node.children.get(k);
    if (!child || child.visits === 0) return k;
    const availability = node.available.get(k) ?? 1;
    const mean = child.total / child.visits;
    const oriented = ours ? mean : -mean;
    const score = rescale(oriented) + config.exploration * Math.sqrt(Math.log(availability) / child.visits);
    if (score > bestScore) {
      bestScore = score;
      bestKey = k;
    }
  }
  return bestKey;
}

/** Evaluate a freshly expanded position, per the configured leaf strategy. */
function leafValue<S, A, V, O>(
  deps: SearchDeps<S, A, V, O>,
  state: S,
  seat: Seat,
  config: SearchConfig,
  rng: RandomCursor,
): number {
  const { mod, evaluate } = deps;
  if (mod.outcome(state).status === 'over') return terminalValue(mod, state, seat);
  if (config.leaf === 'heuristic') return evaluate(state, seat);

  const rolled = rollout(deps, state, seat, config, rng);
  if (config.leaf === 'rollout') return rolled;
  const blended = config.shrinkage * evaluate(state, seat) + (1 - config.shrinkage) * rolled;
  return blended;
}

/** Play on with cheap moves, then evaluate. Depth-capped, which also bounds non-terminating games. */
function rollout<S, A, V, O>(
  deps: SearchDeps<S, A, V, O>,
  start: S,
  seat: Seat,
  config: SearchConfig,
  rng: RandomCursor,
): number {
  const { mod, evaluate, rolloutPolicy, sampleAction } = deps;
  const fast = config.fastRollout && sampleAction ? sampleAction : null;
  let state = start;
  for (let i = 0; i < config.rolloutDepth; i++) {
    if (mod.outcome(state).status === 'over') return terminalValue(mod, state, seat);
    const actor = mod.currentActors(state)[0];
    if (actor === undefined) break;

    let action: A | null;
    if (fast) {
      action = fast(state, actor, rng);
    } else {
      const { actions } = mod.legalActions(state, actor);
      if (actions.length === 0) break;
      const index =
        config.biasedRollout && rolloutPolicy
          ? rolloutPolicy(state, actor, actions, rng)
          : rng.int(actions.length);
      action = actions[index] as A;
    }
    if (action === null) break;

    const result = mod.apply(state, actor, action);
    if (!result.ok) break;
    state = result.state;
  }
  return mod.outcome(state).status === 'over' ? terminalValue(mod, state, seat) : evaluate(state, seat);
}

function terminalValue<S, A, V, O>(mod: GameModule<S, A, V, O>, state: S, seat: Seat): number {
  const outcome = mod.outcome(state);
  if (outcome.status !== 'over') return 0;
  if (outcome.winners.length === 0) return 0;
  return outcome.winners.includes(seat) ? 1 : -1;
}

function backup<A>(node: Node<A>, value: number): void {
  node.visits += 1;
  node.total += value;
}

function applyOrThrow<S, A, V, O>(mod: GameModule<S, A, V, O>, state: S, seat: Seat, action: A): S {
  const result = mod.apply(state, seat, action);
  if (!result.ok) throw new Error(`search: legal action was rejected: ${result.error.code}`);
  return result.state;
}

/**
 * Actions are plain JSON by the engine's own contract, so serialising is a sound identity — and it
 * is what makes an information-set node addressable at all.
 */
function key(action: unknown): string {
  return JSON.stringify(action);
}

/** Worlds in the shared pool are reused across iterations, so each use gets its own copy. */
function clone<S>(state: S): S {
  return JSON.parse(JSON.stringify(state)) as S;
}

/**
 * How much the best move depends on which world you are in.
 *
 * Strategy fusion can only cost you where sampled worlds genuinely want different moves, so this is
 * the number that says whether it is worth worrying about here. Measured by searching each world on
 * its own — a perfect-information search per world, which is exactly the thing ISMCTS is built to
 * avoid, used deliberately as a yardstick.
 *
 * Deliberately *not* folded into the main search. An earlier version sampled the root's preference
 * after every iteration, which mostly measured how unconverged the tree still was: early on it flips
 * constantly because there is no data yet, and late on it stops flipping because the statistics are
 * pooled across all worlds. Neither end of that tells you anything about the worlds disagreeing.
 *
 * Comes with its own control, and needs one. A short search is not deterministic in its own right,
 * so some of the flipping is simply noise. `sameWorld` runs the identical measurement against *one*
 * world with different seeds, which is the floor; only the excess of `acrossWorlds` over it is
 * actually about the worlds.
 */
export function measureDisagreement<S, A, V, O>(
  deps: SearchDeps<S, A, V, O>,
  view: V,
  seat: Seat,
  config: SearchConfig,
  worlds = 12,
): { acrossWorlds: number; sameWorld: number } {
  const rng = new RandomCursor(`${config.seed}:disagree`, 0);
  const settings = { ...config, commonRandomNumbers: false };

  const pickIn = (world: S, seed: string): string => {
    const single: SearchDeps<S, A, V, O> = { ...deps, determinize: () => clone(world) };
    return key(search(single, view, seat, { ...settings, seed }).action);
  };

  const spread = (picks: string[]): number => {
    const counts = new Map<string, number>();
    for (const p of picks) counts.set(p, (counts.get(p) ?? 0) + 1);
    return picks.length === 0 ? 0 : 1 - Math.max(...counts.values()) / picks.length;
  };

  const across: string[] = [];
  for (let i = 0; i < worlds; i++) {
    across.push(pickIn(deps.determinize(view, seat, rng), `${config.seed}:w${i}`));
  }

  const fixed = deps.determinize(view, seat, rng);
  const same: string[] = [];
  for (let i = 0; i < worlds; i++) same.push(pickIn(fixed, `${config.seed}:n${i}`));

  return { acrossWorlds: spread(across), sameWorld: spread(same) };
}
