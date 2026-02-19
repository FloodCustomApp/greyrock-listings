#!/usr/bin/env node
/**
 * GreyRock CRE — AppFolio Listings Scraper
 * 
 * Fetches the public AppFolio listings page, parses HTML into structured JSON,
 * validates the results, and writes listings.json with health metadata.
 * 
 * Exit codes:
 *   0 = success
 *   1 = fetch/network error
 *   2 = parse error (HTML structure may have changed)
 *   3 = validation error (data looks wrong)
 */

import { JSDOM } from 'jsdom';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const APPFOLIO_URL = process.env.APPFOLIO_URL || 'https://greyrockcommercial.appfolio.com/listings';
const OUTPUT_DIR = process.env.OUTPUT_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_FILE = resolve(OUTPUT_DIR, 'docs', 'listings.json');
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || '';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;

// ─── HELPERS ───────────────────────────────────────────────────────────────────

function log(level, msg, data = null) {
  const timestamp = new Date().toISOString();
  const entry = { timestamp, level, msg };
  if (data) entry.data = data;
  console.log(JSON.stringify(entry));
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchWithRetry(url, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      log('info', `Fetching AppFolio listings (attempt ${attempt}/${retries})`, { url });
      
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'GreyRockCRE-ListingSync/1.0 (+https://greyrockcre.com)',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(30000), // 30s timeout
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const html = await response.text();
      log('info', `Fetched ${html.length} bytes of HTML`);
      return html;
      
    } catch (err) {
      log('warn', `Fetch attempt ${attempt} failed: ${err.message}`);
      if (attempt < retries) {
        await sleep(RETRY_DELAY_MS * attempt);
      } else {
        throw err;
      }
    }
  }
}

// ─── PARSER ────────────────────────────────────────────────────────────────────

function parseListings(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // AppFolio uses .listing-item or similar card containers
  // We look for links to /listings/detail/ which each listing has
  const listings = [];
  
  // Strategy 1: Find all detail links and work backwards to their parent cards
  const detailLinks = doc.querySelectorAll('a[href*="/listings/detail/"]');
  
  if (detailLinks.length === 0) {
    // Strategy 2: Check if the page says "no vacancies"
    const noVacancies = doc.body.textContent.includes('no available properties') || 
                        doc.body.textContent.includes('No vacancies found') ||
                        doc.body.textContent.includes('no vacancies');
    
    if (noVacancies) {
      log('info', 'AppFolio reports no current vacancies');
      return { listings: [], noVacancies: true };
    }
    
    // If we found neither listings nor a "no vacancies" message, the structure changed
    throw new Error('STRUCTURE_CHANGED: Could not find listing detail links or vacancy status');
  }

  // Collect unique listing UUIDs (each listing has multiple links to same detail page)
  const seenUUIDs = new Set();
  
  detailLinks.forEach(link => {
    const href = link.getAttribute('href');
    const uuidMatch = href.match(/\/listings\/detail\/([a-f0-9-]+)/);
    if (!uuidMatch) return;
    
    const uuid = uuidMatch[1];
    if (seenUUIDs.has(uuid)) return;
    seenUUIDs.add(uuid);

    // Walk up to find the listing card container
    // AppFolio wraps each listing in a container (usually a div or li)
    let card = link.closest('.listing-item') || 
               link.closest('[class*="listing"]') ||
               link.closest('li') ||
               findCardContainer(link);

    if (!card) {
      log('warn', `Could not find card container for listing ${uuid}`);
      return;
    }

    const listing = extractListingData(card, uuid);
    if (listing) {
      listings.push(listing);
    }
  });

  log('info', `Parsed ${listings.length} listings from ${seenUUIDs.size} unique UUIDs`);
  return { listings, noVacancies: false };
}

function findCardContainer(element) {
  // Walk up the DOM tree looking for a reasonable container
  let current = element.parentElement;
  let depth = 0;
  while (current && depth < 10) {
    // A card container typically has multiple children including text, links, etc.
    const childCount = current.children.length;
    const hasMultipleLinks = current.querySelectorAll('a').length >= 2;
    const hasText = current.textContent.trim().length > 50;
    
    if (childCount >= 3 && hasMultipleLinks && hasText) {
      return current;
    }
    current = current.parentElement;
    depth++;
  }
  return null;
}

function extractListingData(card, uuid) {
  const text = card.textContent;
  
  // Extract rent/price
  const rentMatch = text.match(/\$[\d,]+(?:\.\d{2})?/);
  const rent = rentMatch ? parseFloat(rentMatch[0].replace(/[$,]/g, '')) : null;

  // Extract square footage
  const sqftMatch = text.match(/([\d,]+)\s*(?:SF|sq\s*ft|square\s*feet)/i);
  const sqft = sqftMatch ? parseInt(sqftMatch[1].replace(/,/g, '')) : null;

  // Extract address — look for the address pattern (street, city, state ZIP)
  const addressMatch = text.match(/(\d+\s+[A-Za-z0-9\s.,#-]+,\s*[A-Za-z\s]+,\s*[A-Z]{2}\s*\d{5})/);
  const address = addressMatch ? addressMatch[1].trim() : null;

  // Extract title — usually in an h2 or h3 within the card, or a bold link
  let title = null;
  const headings = card.querySelectorAll('h1, h2, h3, h4, h5');
  for (const h of headings) {
    const hText = h.textContent.trim();
    if (hText.length > 3 && hText.length < 200) {
      title = hText;
      break;
    }
  }
  // Fallback: use the first detail link text if it's descriptive
  if (!title) {
    const detailLink = card.querySelector('a[href*="/listings/detail/"]');
    if (detailLink) {
      const linkText = detailLink.textContent.trim();
      if (linkText.length > 5 && !linkText.match(/^(View|Apply|Map|Details)/i)) {
        title = linkText;
      }
    }
  }
  // Final fallback: use address as title
  if (!title) title = address || `Listing ${uuid.slice(0, 8)}`;

  // Extract description
  let description = '';
  const paragraphs = card.querySelectorAll('p, .description, [class*="desc"]');
  for (const p of paragraphs) {
    const pText = p.textContent.trim();
    if (pText.length > 30 && !pText.includes('Privacy Policy')) {
      description = pText;
      break;
    }
  }
  // Fallback: grab longest text block that isn't the title or address
  if (!description) {
    const allText = card.textContent.replace(/\s+/g, ' ').trim();
    // Find descriptive text (longer than address, not just numbers)
    const descMatch = allText.match(/[A-Z][a-z].{50,500}/);
    if (descMatch) {
      description = descMatch[0].trim();
      if (description.length > 300) description = description.slice(0, 297) + '...';
    }
  }

  // Extract availability
  let available = 'Contact for availability';
  if (/available\s*now/i.test(text)) {
    available = 'Now';
  } else {
    const dateMatch = text.match(/available\s+(\w+\s+\d{1,2},?\s*\d{4}|\w+\s+\d{4})/i);
    if (dateMatch) available = dateMatch[1];
  }

  // Extract lease type or commercial type
  let propertyType = 'Commercial';
  const typePatterns = [
    { pattern: /commercial\s*type:\s*(\w+)/i, group: 1 },
    { pattern: /lease\s*type:\s*([A-Za-z\s]+?)(?:\s*Available|\s*$)/i, group: 1 },
    { pattern: /\b(office|retail|industrial|warehouse|mixed[- ]use|medical|flex)\b/i, group: 1 },
  ];
  for (const { pattern, group } of typePatterns) {
    const match = text.match(pattern);
    if (match) {
      propertyType = match[group].trim();
      // Capitalize first letter
      propertyType = propertyType.charAt(0).toUpperCase() + propertyType.slice(1);
      break;
    }
  }

  // Extract rent per SF
  const rentSFMatch = text.match(/\$([\d.]+)\s*\/(?:yr|mo|sf)/i);
  const rentPerSF = rentSFMatch ? parseFloat(rentSFMatch[1]) : 
                    (rent && sqft ? parseFloat((rent / sqft * 12).toFixed(2)) : null);

  // Extract image URL
  let imageUrl = null;
  const img = card.querySelector('img');
  if (img) {
    const src = img.getAttribute('src') || img.getAttribute('data-src');
    // Skip placeholder images
    if (src && !src.includes('place_holder')) {
      imageUrl = src;
    }
  }

  // Build the apply URL
  const applyUrl = `https://greyrockcommercial.appfolio.com/listings/rental_applications/new?listable_uid=${uuid}&source=Website`;
  const detailUrl = `https://greyrockcommercial.appfolio.com/listings/detail/${uuid}`;

  // Extract city from address
  let city = null;
  if (address) {
    const cityMatch = address.match(/,\s*([A-Za-z\s]+),\s*[A-Z]{2}/);
    if (cityMatch) city = cityMatch[1].trim();
  }

  return {
    id: uuid,
    title,
    address,
    city,
    type: propertyType,
    rent,
    sqft,
    rentPerSF,
    description,
    available,
    status: available === 'Now' ? 'available' : 'coming-soon',
    imageUrl,
    detailUrl,
    applyUrl,
  };
}

// ─── CITY GEOCODING (offline lookup for Charlotte metro) ───────────────────────

const CHARLOTTE_METRO_COORDS = {
  'charlotte': { lat: 35.2271, lng: -80.8431 },
  'concord': { lat: 35.4088, lng: -80.5795 },
  'gastonia': { lat: 35.2621, lng: -81.1873 },
  'huntersville': { lat: 35.4107, lng: -80.8429 },
  'mooresville': { lat: 35.5849, lng: -80.8101 },
  'cornelius': { lat: 35.4868, lng: -80.8601 },
  'davidson': { lat: 35.4993, lng: -80.8487 },
  'matthews': { lat: 35.1168, lng: -80.7237 },
  'mint hill': { lat: 35.1796, lng: -80.6468 },
  'pineville': { lat: 35.0832, lng: -80.8923 },
  'indian trail': { lat: 35.0760, lng: -80.6593 },
  'harrisburg': { lat: 35.3264, lng: -80.6555 },
  'kannapolis': { lat: 35.4874, lng: -80.6217 },
  'rock hill': { lat: 34.9249, lng: -81.0251 },
  'fort mill': { lat: 35.0074, lng: -80.9451 },
  'columbia': { lat: 34.0007, lng: -81.0348 },
  'default': { lat: 35.32, lng: -80.85 },
};

function geocodeCity(city) {
  if (!city) return CHARLOTTE_METRO_COORDS['default'];
  const key = city.toLowerCase().trim();
  return CHARLOTTE_METRO_COORDS[key] || CHARLOTTE_METRO_COORDS['default'];
}

// ─── VALIDATION ────────────────────────────────────────────────────────────────

function validateListings(listings) {
  const errors = [];
  const warnings = [];

  // Check minimum expected fields on each listing
  for (const listing of listings) {
    if (!listing.address) {
      warnings.push(`Listing ${listing.id}: missing address`);
    }
    if (!listing.rent && listing.rent !== 0) {
      warnings.push(`Listing ${listing.id}: missing rent`);
    }
    if (!listing.sqft) {
      warnings.push(`Listing ${listing.id}: missing sqft`);
    }
  }

  // Sanity checks
  if (listings.length > 200) {
    errors.push(`Unexpectedly high listing count: ${listings.length}. Possible parse error.`);
  }

  for (const listing of listings) {
    if (listing.rent && listing.rent > 1000000) {
      warnings.push(`Listing ${listing.id}: suspiciously high rent $${listing.rent}`);
    }
    if (listing.sqft && listing.sqft > 1000000) {
      warnings.push(`Listing ${listing.id}: suspiciously high sqft ${listing.sqft}`);
    }
  }

  return { errors, warnings, valid: errors.length === 0 };
}

// ─── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  
  try {
    // 1. Fetch the page
    const html = await fetchWithRetry(APPFOLIO_URL);

    // 2. Parse listings
    const { listings, noVacancies } = parseListings(html);

    // 3. Add geocoding for map display
    for (const listing of listings) {
      const coords = geocodeCity(listing.city);
      listing.lat = coords.lat + (Math.random() - 0.5) * 0.01; // slight jitter so pins don't stack
      listing.lng = coords.lng + (Math.random() - 0.5) * 0.01;
    }

    // 4. Validate
    const validation = validateListings(listings);
    
    if (!validation.valid) {
      log('error', 'Validation failed', { errors: validation.errors });
      process.exit(3);
    }

    if (validation.warnings.length > 0) {
      log('warn', 'Validation warnings', { warnings: validation.warnings });
    }

    // 5. Load previous data for comparison
    let previousCount = null;
    let previousHash = null;
    if (existsSync(OUTPUT_FILE)) {
      try {
        const prev = JSON.parse(readFileSync(OUTPUT_FILE, 'utf-8'));
        previousCount = prev.listings?.length ?? null;
        previousHash = prev.meta?.contentHash ?? null;
      } catch (e) {
        log('warn', 'Could not read previous listings.json');
      }
    }

    // 6. Simple content hash to detect changes
    const contentHash = simpleHash(JSON.stringify(listings));
    const hasChanges = contentHash !== previousHash;

    // 7. Build output
    const output = {
      meta: {
        lastUpdated: new Date().toISOString(),
        source: APPFOLIO_URL,
        listingCount: listings.length,
        noVacancies,
        previousCount,
        hasChanges,
        contentHash,
        scrapeDurationMs: Date.now() - startTime,
        warnings: validation.warnings,
        version: '1.0.0',
      },
      listings,
    };

    // 8. Write output
    writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf-8');
    log('info', 'Successfully wrote listings.json', {
      count: listings.length,
      hasChanges,
      file: OUTPUT_FILE,
    });

    // 9. Summary for GitHub Actions
    if (process.env.GITHUB_STEP_SUMMARY) {
      const summary = [
        `## 📋 Scrape Results`,
        `| Metric | Value |`,
        `| --- | --- |`,
        `| Listings Found | ${listings.length} |`,
        `| Previous Count | ${previousCount ?? 'N/A'} |`,
        `| Changes Detected | ${hasChanges ? '✅ Yes' : '➖ No'} |`,
        `| Duration | ${Date.now() - startTime}ms |`,
        `| Warnings | ${validation.warnings.length} |`,
        noVacancies ? `\n> ℹ️ AppFolio reports no current vacancies` : '',
        validation.warnings.length > 0 ? `\n### ⚠️ Warnings\n${validation.warnings.map(w => `- ${w}`).join('\n')}` : '',
      ].join('\n');
      
      writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a' });
    }

  } catch (err) {
    log('error', `Scraper failed: ${err.message}`, { stack: err.stack });
    
    // Write error summary for GitHub Actions
    if (process.env.GITHUB_STEP_SUMMARY) {
      const summary = [
        `## ❌ Scrape Failed`,
        `**Error:** ${err.message}`,
        ``,
        `The AppFolio page structure may have changed. Check the scraper logs for details.`,
        ``,
        `> Last successful data is still being served to the website.`,
      ].join('\n');
      writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a' });
    }

    // Determine exit code
    if (err.message.includes('STRUCTURE_CHANGED')) {
      process.exit(2);
    } else {
      process.exit(1);
    }
  }
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash.toString(36);
}

main();
