// Optional evening summary: what Deal Pinger found in the last 24 hours, plus flip profit this month.

const money = (n) => `£${Number.isInteger(Number(n)) ? Number(n) : Number(n).toFixed(2)}`;

export function buildDigest(db) {
  const rows = db.raw.prepare("SELECT listing, estimate, status FROM hits WHERE createdAt >= datetime('now', '-1 day')").all()
    .map(r => ({ status: r.status, listing: JSON.parse(r.listing), estimate: r.estimate ? JSON.parse(r.estimate) : null }));
  const deals = rows.filter(r => r.status !== 'flagged');
  const scams = rows.length - deals.length;
  const best = deals
    .filter(r => r.estimate?.bestProfit != null)
    .sort((a, b) => b.estimate.bestProfit - a.estimate.bestProfit)[0];
  const lines = [];
  if (best) lines.push(`Best: ${money(best.listing.price)} ${best.listing.title} (${best.estimate.bestProfit >= 0 ? '+' : '-'}${money(Math.abs(best.estimate.bestProfit))})`);
  if (scams) lines.push(`${scams} likely scam${scams === 1 ? '' : 's'} hidden`);
  const { monthProfit } = db.flipSummary();
  if (monthProfit) lines.push(`${money(monthProfit)} flip profit this month`);
  return {
    title: `Today: ${deals.length} deal${deals.length === 1 ? '' : 's'}`,
    body: lines.join(' · ') || 'Quiet day. Your searches are still running.',
    url: '/',
    tag: 'digest',
  };
}

/** Send the summary once a day, at or after the chosen time (UK time). hhmm/date are "now" in UK time. */
export async function maybeSendDigest(db, notify, { hhmm, date }) {
  const s = db.getSettings();
  if (!s.digestTime || hhmm < s.digestTime || s.lastDigestDate === date) return false;
  db.setSettings({ lastDigestDate: date });
  await notify.sendRaw(buildDigest(db));
  return true;
}
