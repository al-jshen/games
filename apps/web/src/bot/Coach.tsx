/**
 * The coach panel: what the network makes of the position, and what it would play.
 *
 * Two numbers rather than one, labelled, because they are different claims. `network` is the value
 * head on the position as it stands -- one forward pass, no reading, right about the eventual winner
 * 69% of the time. `search` is the same head averaged over a few hundred sampled lines. When they
 * disagree the position plays differently from how it looks, which is the most interesting thing
 * this panel can tell you and would be lost by showing only one.
 *
 * Moves are shown only on your own turn. On your opponent's, an evaluation is fair game -- you can
 * see the board -- but a list of *their* best replies would be reading a hand you are not holding.
 */

import { COACH_DEPTHS, type CoachDepthId } from './bot.js';
import type { CoachState } from './useCoach.js';

/** [-1, 1] into a phrase. Bands are wide because the value head is not precise enough to be exact. */
function verdict(value: number): string {
  if (value > 0.5) return 'winning';
  if (value > 0.2) return 'clearly ahead';
  if (value > 0.06) return 'slightly ahead';
  if (value >= -0.06) return 'level';
  if (value >= -0.2) return 'slightly behind';
  if (value >= -0.5) return 'clearly behind';
  return 'losing';
}

const signed = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;

export function Coach({ coach, yourTurn }: { coach: CoachState; yourTurn: boolean }) {
  const read = coach.read;

  return (
    <section className={`panel compact coach ${coach.on ? '' : 'coach-idle'}`}>
      <div className="coach-head">
        <h3>Coach</h3>
        <label
          className="coach-toggle"
          title="Ask the trained network what it makes of the position, and what it would play. It sees only your side of the board — the same view you have."
        >
          <input type="checkbox" checked={coach.on} onChange={(e) => coach.setOn(e.target.checked)} />
          <span>{coach.on ? 'On' : 'Off'}</span>
        </label>
      </div>

      {/*
        Nothing is rendered when the coach is off, and that is a height decision rather than a
        stylistic one. The sidebar is the tightest column in the app -- at 1366x620 the chat box was
        pushed off the bottom of the screen entirely by the three-line explanation that used to sit
        here, which an e2e test caught and a person would have experienced as "where did chat go".
        The same words are on the checkbox's `title`, which is where an explanation of a control
        belongs anyway.
      */}

      {coach.on && coach.error && <p className="error small">{coach.error}</p>}

      {coach.on && !coach.error && (
        <>
          <div className="row coach-controls">
            <select
              className="bot-level"
              aria-label="How hard the coach reads"
              value={coach.depth}
              onChange={(e) => coach.setDepth(e.target.value as CoachDepthId)}
            >
              {COACH_DEPTHS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
            <span className="muted small">
              {!coach.ready ? 'loading the network…' : coach.working ? 'reading…' : read ? `${read.ms}ms` : ''}
            </span>
          </div>

          {read ? (
            <>
              <EvalBar value={read.searchValue} />
              <p className="coach-verdict">
                You are <strong>{verdict(read.searchValue)}</strong>
              </p>
              <p className="muted small coach-numbers">
                search {signed(read.searchValue)} · network {signed(read.staticValue)}
              </p>

              {yourTurn && read.moves.length > 0 && (
                <>
                  <h4 className="coach-sub">It would play</h4>
                  <ol className="coach-moves">
                    {read.moves.map((move, i) => (
                      <li key={`${move.text}-${i}`} className={i === 0 ? 'top' : ''}>
                        <span className="coach-move-text">{move.text}</span>
                        <span className="coach-move-share" title="share of the search's visits">
                          {Math.round(move.visits * 100)}%
                        </span>
                      </li>
                    ))}
                  </ol>
                  {read.instinct && read.instinct !== read.moves[0]?.text && (
                    <p className="muted small">
                      Before reading, the policy head’s pick was <em>{read.instinct}</em>.
                    </p>
                  )}
                </>
              )}
              {!yourTurn && <p className="muted small">Moves are shown on your turn.</p>}
            </>
          ) : (
            <p className="muted small">{coach.ready ? 'Reading the position…' : 'Fetching 3MB of weights, once.'}</p>
          )}
        </>
      )}
    </section>
  );
}

/**
 * The evaluation as a bar, from your side.
 *
 * Centre is level. Deliberately not a percentage: the value head is trained on game outcomes but is
 * not calibrated as a probability, and dressing a tanh output up as "68% to win" would be claiming a
 * precision it does not have.
 */
function EvalBar({ value }: { value: number }) {
  const clamped = Math.max(-1, Math.min(1, value));
  const percent = ((clamped + 1) / 2) * 100;
  return (
    <div
      className="coach-bar"
      role="meter"
      aria-valuemin={-1}
      aria-valuemax={1}
      aria-valuenow={Number(clamped.toFixed(2))}
      aria-label="Position evaluation, from your side"
    >
      <div className="coach-bar-fill" style={{ width: `${percent}%` }} />
      <div className="coach-bar-mid" />
    </div>
  );
}
