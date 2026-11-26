// Scam check: "too good to be true" listings, especially from sellers with no track record,
// and the payment tricks UK scammers commonly ask for.

const RED_FLAGS = [
  [/\bbank transfer\b|\bbacs\b/i, 'asks for bank transfer'],
  [/paypal\s*(?:f\s*&\s*f|f\s*and\s*f|friends?\s*(?:and|&)\s*family|gift)/i, 'asks for PayPal friends & family'],
  [/whats\s?app|wa\.me|\btelegram\b|text me on|message me on|\bdm me\b|contact me on/i, 'wants to move off the marketplace'],
  [/\bdeposit\b/i, 'asks for a deposit'],
  [/western union|money\s?gram|gift ?cards?|\bcrypto\b|bitcoin|\busdt\b/i, 'asks for untraceable payment'],
  [/[\w.+-]+@[\w-]+\.[\w.]+/, 'includes an email address'],
  [/\b(?:07\d{3}|\+44\s?7\d{3})\s?\d{3}\s?\d{3}\b/, 'includes a phone number'],
  [/courier only|shipping only|can'?t meet|abroad|overseas|working away/i, 'won\'t meet in person'],
];

const DAY = 86400000;

/**
 * Assess a listing. value = typical resale value (eBay sold median, else CeX sell price) or null.
 * Returns { risk: 'high' | 'medium' | 'low', reasons: string[] }.
 */
export function assessScam(listing, { value = null } = {}) {
  const reasons = [];
  const text = `${listing.title || ''} ${listing.description || ''}`;
  const flags = RED_FLAGS.filter(([re]) => re.test(text)).map(([, why]) => why);
  reasons.push(...flags);

  const seller = listing.seller || null;
  const noRatings = seller != null && seller.ratings === 0;
  const newAccount = seller?.joinedAt != null && Date.now() - new Date(seller.joinedAt).getTime() < 30 * DAY;
  if (noRatings) reasons.push('seller has no ratings');
  else if (newAccount) reasons.push('seller account is under 30 days old');
  const untrusted = noRatings || newAccount;

  const price = listing.price;
  let tooCheap = false;
  let wayTooCheap = false;
  if (value != null && price != null && price > 0) {
    const ratio = price / value;
    tooCheap = value >= 60 && ratio <= 0.45;
    wayTooCheap = value >= 150 && ratio <= 0.3;
    if (tooCheap) reasons.unshift(`${Math.round((1 - ratio) * 100)}% below its usual £${Math.round(value)}`);
  }

  const red = flags.length > 0;
  let risk = 'low';
  if ((tooCheap && (untrusted || red)) || wayTooCheap || (red && untrusted)) risk = 'high';
  else if (tooCheap || red || (untrusted && value != null && value >= 150)) risk = 'medium';
  return { risk, reasons };
}
