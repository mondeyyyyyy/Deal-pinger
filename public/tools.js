// Small reseller tools, shared by the app and the tests.

const round2 = (n) => Math.round(n * 100) / 100;

/** Profit if you buy at `buy` and sell at `sell`, after a selling fee (%) and postage. */
export function profitFor({ buy, sell, feePct = 0, postage = 0 }) {
  const profit = round2(sell * (1 - feePct / 100) - postage - buy);
  return { profit, roiPct: buy > 0 ? Math.round((profit / buy) * 100) : null };
}

// Words sellers add to grab attention that don't belong in your own listing.
const JUNK_TAIL = /\s*[-–|:]\s*(collection only|collect only|pick ?up only|quick sale|urgent|bargain|must go|no offers|no time ?wasters|cheap|offers?)\b.*$/i;
const JUNK_ANY = /\b(collection only|pick ?up only|quick sale|must go|no time ?wasters)\b/gi;

/** A clean title (eBay allows 80 characters) and a simple description to relist something you bought. */
export function relistText({ title, notes = '' }) {
  let t = String(title || '').replace(JUNK_TAIL, '').replace(JUNK_ANY, '').replace(/[!?*]{2,}/g, '').replace(/\s{2,}/g, ' ').replace(/[\s,.\-–|:]+$/, '').trim();
  if (t.length > 80) t = t.slice(0, 80).replace(/\s+\S*$/, '');
  const lines = [t, ''];
  if (String(notes).trim()) lines.push(String(notes).trim(), '');
  lines.push('Condition: as shown in the photos. Happy to answer any questions.', 'Posted within 1–2 working days with tracking.');
  return { title: t, description: lines.join('\n') };
}
