import * as ebay from './ebay.js';
import * as craigslist from './craigslist.js';
import * as facebook from './facebook.js';
import * as offerup from './offerup.js';
import * as mercari from './mercari.js';

export const SOURCES = { ebay, craigslist, facebook, offerup, mercari };
export const SOURCE_IDS = Object.keys(SOURCES);
