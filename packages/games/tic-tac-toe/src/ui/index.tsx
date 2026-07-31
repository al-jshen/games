import type { TicTacToeAction, TicTacToeView } from '../index.js';
import './tictactoe.css';

/**
 * Deliberately minimal. This board exists to prove that the platform shell, the protocol, and the
 * prediction path all work for a game other than Splendor Duel.
 */
export default function TicTacToeBoard({
  view: raw,
  seat,
  submit,
  pending,
}: {
  view: unknown;
  seat: number | null;
  /** Unused: whose turn it is comes from the view, so an optimistic move renders consistently. */
  actors?: number[];
  submit: (action: unknown) => void;
  pending: boolean;
}) {
  const view = raw as TicTacToeView | null;
  if (!view || seat === null) return <p className="muted">Waiting for the board…</p>;

  // From the view rather than the server's `actors`: while an optimistic move is unconfirmed those
  // disagree, and the view is what is on screen. See the same note in the Splendor Duel board.
  const myTurn = view.turn === seat && view.winner === null && !view.draw;
  const myMark = seat === 0 ? 'x' : 'o';

  return (
    <div className="ttt">
      <p className="muted">
        You are <strong>{myMark.toUpperCase()}</strong>.{' '}
        {view.winner !== null
          ? view.winner === seat
            ? 'You won.'
            : 'You lost.'
          : view.draw
            ? 'Drawn.'
            : myTurn
              ? 'Your move.'
              : "Opponent's move."}
      </p>
      <div className="ttt-grid">
        {view.board.map((cell, i) => (
          <button
            key={i}
            type="button"
            className={`ttt-cell ${cell ? `ttt-${cell}` : ''}`}
            disabled={!myTurn || cell !== null || pending || view.winner !== null || view.draw}
            aria-label={`Cell ${i + 1}${cell ? `, ${cell}` : ', empty'}`}
            onClick={() => submit({ t: 'place', cell: i } satisfies TicTacToeAction)}
          >
            {cell?.toUpperCase() ?? ''}
          </button>
        ))}
      </div>
    </div>
  );
}
