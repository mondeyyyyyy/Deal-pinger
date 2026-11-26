// UK marketplaces only.
import * as ebay from './ebay.js';
import * as facebook from './facebook.js';
import * as vinted from './vinted.js';
import * as gumtree from './gumtree.js';
import * as depop from './depop.js';

export const SOURCES = { ebay, facebook, vinted, gumtree, depop };
export const SOURCE_IDS = Object.keys(SOURCES);
