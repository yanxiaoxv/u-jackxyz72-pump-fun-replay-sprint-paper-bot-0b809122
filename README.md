# Pump.fun Replay Sprint — Small-Size Long-Hold Bot (24h)

[![Competition](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/yanxiaoxv/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/yanxiaoxv/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for pump.fun bonding curves, speaking
`agent-fun/replay/v2` on stdin/stdout. It runs as `node main.ts`
(Node 22, no dependencies, no network, no clock, no randomness),
answering every `batch` with exactly one `reply` line.

## Strategy, in plain words

Buy every young coin, cheaply, and hold it long enough for a rare
runner to pay for the many small losers.

- **Entry:** a coin becomes a candidate when it is created. Once it
  has at least 2 buy trades behind it and is still young (first seen
  within the last 1200 slots), buy 0.01 SOL of it — the smallest size
  that still counts as a round trip — capped at 1% of the curve's
  real SOL reserve so the size cap never rejects the order.
- **No momentum filter:** on this data, buying only coins that already
  rose just buys tops. Every young coin with a little buy flow gets
  the same small bet.
- **Exit:** sell the whole position when the mark is up +300% (a real
  runner), down −30% (stop-loss), or after ~120000 slots held.
- **Capacity:** at most 5 open positions (the harness cap), so the
  20-coin guardrail is met by turnover, not by holding many coins.

## Why these numbers

This sprint's final window is 24 hours, not the 6 hours of the
earlier sprints — a long hold no longer starves turnover. Tuned on
this kit's own dev window across 7 graded variants of the same bot:

| variant | dev net PnL (SOL) | round trips |
|---|---:|---:|
| hold 30000 slots, +300% TP, −30% SL | −0.178 | 101 |
| hold 60000 slots | −0.116 | 61 |
| hold 100000 slots | −0.026 | 30 |
| hold 150000 slots | −0.014 | 20 |
| hold 120000 slots, +200% TP | −0.031 | 33 |
| hold 120000 slots, −40% SL | −0.032 | 25 |
| **hold 120000 slots, +300% TP, −30% SL (final)** | **−0.012** | **33** |

The 150000-slot hold was marginally better on PnL but landed exactly
on 20 round trips — too close to the guardrail to risk on a fresh
tape. The final setting keeps 33 round trips and a 0.57% max
drawdown on dev. Dev PnL is still slightly negative, so the final
window is a variance game: the bet is that a fresh 24-hour tape
produces one or two +300% runners. Two local grades of the final bot
produced byte-identical action logs.

## How it runs

```
node main.ts
```

The harness sends `hello`, then one `batch` per slot, then `done`.
The bot keeps per-mint state (first-seen slot, buy-trade count,
bought slot) and prices positions from the batch `marks`. All
decisions are deterministic functions of the events seen so far, so
two executions produce byte-identical action logs.

## Layout

- `main.ts` — the bot (entrypoint).
- `vendor/makefun-bot.ts` — the kit's SDK shim, byte-identical copy.
- `LICENSE` — MIT.
