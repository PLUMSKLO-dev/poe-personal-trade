import { expect, it, vi } from "vitest";
import { getTradeLeagues } from "../src/main/trade-service";

it("picks up a newly opened PC league without restarting, while caching repeated lookups", async () => {
  vi.useFakeTimers();
  const standard = { id: "Standard", text: "Standard" };
  const newLeague = { id: "New League", text: "New League" };
  const reply = (entries: Array<{ id: string; text: string; realm: string }>) =>
    new Response(JSON.stringify({ result: entries }));
  const fetch = vi.fn()
    .mockResolvedValueOnce(reply([{ ...standard, realm: "pc" }]))
    .mockResolvedValueOnce(reply([
      { ...newLeague, realm: "pc" },
      { ...newLeague, realm: "pc" },
      { ...standard, realm: "pc" },
      { id: "Console Only", text: "Console Only", realm: "xbox" },
    ]));
  vi.stubGlobal("fetch", fetch);
  try {
    expect(await Promise.all([getTradeLeagues(), getTradeLeagues()])).toEqual([[standard], [standard]]);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(await getTradeLeagues()).toEqual([standard]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await getTradeLeagues()).toEqual([newLeague, standard]);
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
