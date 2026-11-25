/**
 * Pump.fun Replay Sprint — 24h long-hold paper bot (agent-fun/replay/v2).
 *
 * Protocol: NDJSON in on stdin (hello, then one batch per slot, then
 * done), exactly one reply line out per batch. The bot reads no clock
 * and rolls no dice: every decision is a pure function of the events
 * seen so far, so two executions emit byte-identical action logs.
 *
 * Trading idea, final form after tuning seven variants against this
 * kit's dev window: take a small, equal bet on nearly every young
 * coin and then simply wait. Momentum filters were tried in earlier
 * sprints and only bought local tops, so entry needs nothing more
 * than a coin that exists, is still young, and has at least two buy
 * trades behind it. The bet size is 0.01 SOL, the smallest size that
 * still counts as a round trip, further capped by the harness's
 * 1%-of-real-reserve order cap so no order is ever rejected for size.
 * A position is sold in full on the first of three triggers: the
 * mark reaches +300% over the fee-inclusive entry price, the mark
 * falls to -30%, or 120000 slots have passed since the buy. This
 * sprint's final window runs 24 hours rather than the 6 hours of the
 * earlier sprints, and that changes the turnover arithmetic: on dev,
 * stretching the time exit from 30000 to 120000 slots shrank the
 * loss from -0.178 SOL to -0.012 SOL while still completing 33 round
 * trips, safely above the 20-coin guardrail. Going further, to
 * 150000 slots, scored about the same (-0.014) but finished exactly
 * 20 round trips, which is too close to the guardrail to trust on a
 * fresh tape. +200% take-profit (-0.031) and a -40% stop (-0.032)
 * were both worse at this hold length. Dev PnL remains slightly
 * negative, so the entry is a variance play: one or two +300%
 * runners on the final tape are what pay for the many small losers.
 * At most five positions are open at once (the harness cap), so the
 * guardrail is met by turnover over the day, not by breadth at any
 * single moment.
 */

import { runBot, type BuyInput, type SellInput } from "./vendor/makefun-bot.ts";

// All knobs live in this one table so a local grade can move them.
const CFG = {
  stakeLamports: 10_000_000n, // 0.01 SOL per buy, the round-trip floor
  minTradesBeforeBuy: 2, // observed buy trades required before entry
  youngestAgeSlots: 1200, // ignore coins first seen longer ago than this
  gainExitBps: 30_000, // take profit at +300%
  lossExitBps: 3_000, // stop loss at -30%
  timeExitSlots: 120_000, // otherwise sell after this many slots held
  slippageBps: 500,
  pruneAfterQuietSlots: 7_200, // forget unheld coins quiet this long
  pruneAboveSeen: 5_000, // only prune once the book grows past this
};

interface Seen {
  bornSlot: number;
  buysSeen: number;
  enteredSlot: number | null;
}

const seen = new Map<string, Seen>();

function markPrice(quote: bigint, tokens: bigint): number {
  return tokens > 0n ? Number(quote) / Number(tokens) : 0;
}

await runBot({
  onBatch(state, batch) {
    const now = state.slot;
    const reply: Array<BuyInput | SellInput> = [];

    // First pass over the batch: learn what happened this slot.
    for (const ev of batch.events) {
      if (ev.event === "CreateEvent") {
        if (!seen.has(ev.mint)) {
          seen.set(ev.mint, { bornSlot: now, buysSeen: 0, enteredSlot: null });
        }
      } else if (ev.event === "TradeEvent") {
        let s = seen.get(ev.mint);
        if (s === undefined) {
          s = { bornSlot: now, buysSeen: 0, enteredSlot: null };
          seen.set(ev.mint, s);
        }
        if (ev.is_buy) s.buysSeen += 1;
      }
      // CompleteEvent needs no bookkeeping: a completed curve is
      // filtered out at buy time through state.curves.
    }

    // Exits come before entries so a slot freed by a sale can be
    // reused by a buy in the same batch's reply.
    for (const [mint, pos] of state.positions) {
      if (pos.token_amount <= 0n || pos.cost_lamports <= 0n) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined) continue;
      const mark = markPrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (mark <= 0) continue;
      const entryPrice = Number(pos.cost_lamports) / Number(pos.token_amount);
      const gainBps = Math.floor(((mark - entryPrice) / entryPrice) * 10_000);
      const s = seen.get(mint);
      const heldFor = s !== undefined && s.enteredSlot !== null ? now - s.enteredSlot : 0;
      const exitNow =
        gainBps >= CFG.gainExitBps || gainBps <= -CFG.lossExitBps || heldFor >= CFG.timeExitSlots;
      if (exitNow) {
        reply.push({
          side: "sell",
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: CFG.slippageBps,
        });
      }
    }

    // Entries: every young coin with a little buy flow, not yet held
    // and never entered before, while position slots and cash last.
    let slotsFree = state.hello.caps.max_open_positions - state.committedPositionCount();
    if (slotsFree > 0) {
      let cash = state.freeCashLamports();
      const fee = state.txFeeLamports();
      for (const [mint, s] of seen) {
        if (slotsFree <= 0) break;
        if (s.enteredSlot !== null) continue;
        if (state.positions.has(mint)) continue;
        if (now - s.bornSlot > CFG.youngestAgeSlots) continue;
        if (s.buysSeen < CFG.minTradesBeforeBuy) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const cap = state.maxBuyLamports(mint);
        const stake = CFG.stakeLamports < cap ? CFG.stakeLamports : cap;
        if (stake < CFG.stakeLamports) continue; // under the round-trip floor
        if (cash < stake + fee) continue;
        reply.push({
          side: "buy",
          mint,
          quote_lamports: stake,
          max_slippage_bps: CFG.slippageBps,
        });
        // Stamp the entry immediately: fills land two slots later,
        // and the next batch must not queue a second buy meanwhile.
        s.enteredSlot = now;
        cash -= stake + fee;
        slotsFree -= 1;
      }
    }

    // Keep the book small: drop coins nobody holds once their curve
    // has been quiet for a while. Purely a memory bound; the slot
    // arithmetic keeps it deterministic.
    if (seen.size > CFG.pruneAboveSeen) {
      for (const [mint, s] of seen) {
        if (state.positions.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve !== undefined && now - curve.reserves_slot > CFG.pruneAfterQuietSlots) {
          seen.delete(mint);
        }
      }
    }

    return reply;
  },
});
