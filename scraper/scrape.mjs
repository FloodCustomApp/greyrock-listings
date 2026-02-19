#!/usr/bin/env node
/**
 * GreyRock CRE — AppFolio Listings Scraper v2.0
 * 
 * Fetches the public AppFolio listings index page, then visits each listing's
 * detail page to extract real gallery images, full descriptions, and accurate
 * property data.
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
const BASE_URL = 'https://greyrockcommercial.appfolio.com';
const APPFOLIO_URL = process.env.APPFOLIO_URL || `${BASE_URL}/listings`;
const OUTPUT_DIR = process.env.OUTPUT_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_FILE = resolve(OUTPUT_DIR, 'docs', 'listings.json');
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const DETAIL_FETCH_DELAY_MS = 1500; // polite delay between detail page fetches

const HEADERS = {
  'User-Agent': 'GreyRockCRE-ListingSync/2.0 (+https://greyrockcre.com)',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
};

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
      log('info', `Fetching (attempt ${attempt}/${retries})`, { url });
      const response = await fetch(url, {
        headers: HEADERS,
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const html = await response.text();
      log('info', `Fetched ${html.length} bytes`);
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

// ─── INDEX PAGE PARSER ─────────────────────────────────────────────────────────

function parseIndexPage(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // Find all detail links → extract unique listing UUIDs
  const detailLinks = doc.querySelectorAll('a[href*="/listings/detail/"]');

  if (detailLinks.length === 0) {
    const noVacancies = doc.body.textContent.includes('no available properties') ||
                        doc.body.textContent.includes('No vacancies found') ||
                        doc.body.textContent.includes('no vacancies');
    if (noVacancies) {
      log('info', 'AppFolio reports no current vacancies');
      return { uuids: [], noVacancies: true };
    }
    throw new Error('STRUCTURE_CHANGED: Could not find listing detail links or vacancy status');
  }

  const uuids = [...new Set(
    [...detailLinks]
      .map(link => link.getAttribute('href')?.match(/\/listings\/detail\/([a-f0-9-]+)/)?.[1])
      .filter(Boolean)
  )];

  log('info', `Found ${uuids.length} unique listing UUIDs on index page`);
  return { uuids, noVacancies: false };
}

// ─── DETAIL PAGE PARSER ────────────────────────────────────────────────────────

function parseDetailPage(html, uuid) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const text = doc.body?.textContent || '';

  // ── IMAGES ──
  // Gallery images: .gallery img, .swipebox img
  // Filter out AppFolio logo (large.png) and placeholders, deduplicate
  const allImgs = doc.querySelectorAll('.gallery img, .swipebox img, img[class*="gallery"]');
  const imageUrls = [...new Set(
    [...allImgs]
      .map(img => img.getAttribute('src') || img.getAttribute('data-src'))
      .filter(src => src && !src.includes('large.png') && !src.includes('place_holder'))
  )];

  // Fallback: any CDN images on the page
  if (imageUrls.length === 0) {
    const fallbackImgs = doc.querySelectorAll('img');
    for (const img of fallbackImgs) {
      const src = img.getAttribute('src') || img.getAttribute('data-src');
      if (src && src.includes('images.cdn.appfolio.com') && !src.includes('large.png')) {
        if (!imageUrls.includes(src)) imageUrls.push(src);
      }
    }
  }

  // ── TITLE ──
  let title = null;
  const headings = doc.querySelectorAll('h1, h2, h3');
  for (const h of headings) {
    const hText = h.textContent.trim();
    if (hText.length > 5 && hText.length < 300 && !hText.match(/^(Current|Rental|Apply)/i)) {
      title = hText;
      break;
    }
  }
  if (!title) {
    title = doc.querySelector('title')?.textContent?.trim() || `Listing ${uuid.slice(0, 8)}`;
  }

  // ── ADDRESS ──
  const addressMatch = text.match(/(\d+\s+[A-Za-z0-9\s.,#-]+,\s*[A-Za-z\s]+,\s*[A-Z]{2}\s*\d{5})/);
  const address = addressMatch ? addressMatch[1].trim() : null;

  // ── DESCRIPTION ──
  let description = '';
  const descEl = doc.querySelector('.listing-detail__description, [class*="listing-detail__description"], .js-listing-description');
  if (descEl) {
    description = descEl.textContent.trim();
  }
  if (!description) {
    const paragraphs = doc.querySelectorAll('p');
    let longest = '';
    for (const p of paragraphs) {
      const pText = p.textContent.trim();
      if (pText.length > longest.length && !pText.includes('Privacy Policy')) {
        longest = pText;
      }
    }
    description = longest;
  }

  // ── RENT ──
  const rentMatch = text.match(/(?:RENT|Rent)\s*\$?([\d,]+(?:\.\d{2})?)/);
  const rent = rentMatch ? parseFloat(rentMatch[1].replace(/,/g, '')) : null;

  // ── SQUARE FEET ──
  const sqftMatch = text.match(/(?:SQUARE FEET|Square Feet|Sq\.?\s*Ft\.?)\s*([\d,]+)/i) ||
                    text.match(/([\d,]+)\s*(?:SF|sq\s*ft|square\s*feet)/i);
  const sqft = sqftMatch ? parseInt(sqftMatch[1].replace(/,/g, '')) : null;

  // ── RENT PER SF ──
  const rentSFMatch = text.match(/(?:RENT\s*\/\s*SF|Rent\s*\/\s*SF)\s*\$?([\d,.]+)\s*\/yr/i) ||
                      text.match(/\$([\d,.]+)\s*\/(?:yr|sf)/i);
  const rentPerSF = rentSFMatch ? parseFloat(rentSFMatch[1].replace(/,/g, '')) : null;

  // ── AVAILABILITY ──
  let available = 'Contact for availability';
  const availMatch = text.match(/(?:AVAILABLE|Available)\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i) ||
                     text.match(/(?:AVAILABLE|Available)\s+(Now)/i) ||
                     text.match(/(?:AVAILABLE|Available)\s+(\w+\s+\d{1,2},?\s*\d{4})/i);
  if (availMatch) {
    available = availMatch[1].trim();
  }

  // ── COMMERCIAL TYPE & LEASE TYPE ──
  let propertyType = 'Commercial';
  const typeMatch = text.match(/Commercial\s*Type:\s*(\w+)/i);
  if (typeMatch) propertyType = typeMatch[1].trim();

  let leaseType = null;
  const leaseMatch = text.match(/Lease\s*Type:\s*(\w+)/i);
  if (leaseMatch) leaseType = leaseMatch[1].trim();

  // ── UTILITIES ──
  let utilities = null;
  const utilMatch = text.match(/Utilities\s*Included:\s*([^\n]+)/i);
  if (utilMatch) utilities = utilMatch[1].trim();

  // ── CITY ──
  let city = null;
  if (address) {
    const cityMatch = address.match(/,\s*([A-Za-z\s]+),\s*[A-Z]{2}/);
    if (cityMatch) city = cityMatch[1].trim();
  }

  // ── URLS ──
  const detailUrl = `${BASE_URL}/listings/detail/${uuid}`;
  const applyUrl = `${BASE_URL}/listings/rental_applications/new?listable_uid=${uuid}&source=Website`;

  return {
    id: uuid,
    title,
    address,
    city,
    type: propertyType,
    leaseType,
    rent,
    sqft,
    rentPerSF,
    description,
    available,
    status: /now/i.test(available) ? 'available' : 'coming-soon',
    utilities,
    imageUrl: imageUrls[0] || null,    // primary image for card display
    imageUrls: imageUrls,               // all gallery images
    detailUrl,
    applyUrl,
  };
}

// ─── CITY GEOCODING (offline lookup for NC markets) ────────────────────────────

const NC_METRO_COORDS = {
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
  'rockwell': { lat: 35.5513, lng: -80.4024 },
  'salisbury': { lat: 35.6710, lng: -80.4742 },
  'china grove': { lat: 35.5699, lng: -80.5818 },
  'landis': { lat: 35.5463, lng: -80.6107 },
  'default': { lat: 35.32, lng: -80.85 },
};

function geocodeCity(city) {
  if (!city) return NC_METRO_COORDS['default'];
  const key = city.toLowerCase().trim();
  return NC_METRO_COORDS[key] || NC_METRO_COORDS['default'];
}

// ─── VALIDATION ────────────────────────────────────────────────────────────────

function validateListings(listings) {
  const errors = [];
  const warnings = [];

  for (const listing of listings) {
    if (!listing.address) warnings.push(`Listing ${listing.id}: missing address`);
    if (!listing.rent && listing.rent !== 0) warnings.push(`Listing ${listing.id}: missing rent`);
    if (!listing.sqft) warnings.push(`Listing ${listing.id}: missing sqft`);
    if (!listing.imageUrl) warnings.push(`Listing ${listing.id}: no images found`);
  }

  if (listings.length > 200) {
    errors.push(`Unexpectedly high listing count: ${listings.length}`);
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
    // 1. Fetch the index page
    const indexHtml = await fetchWithRetry(APPFOLIO_URL);

    // 2. Parse listing UUIDs from index page
    const { uuids, noVacancies } = parseIndexPage(indexHtml);

    if (noVacancies || uuids.length === 0) {
      const output = {
        meta: {
          lastUpdated: new Date().toISOString(),
          source: APPFOLIO_URL,
          listingCount: 0,
          noVacancies: true,
          hasChanges: false,
          scrapeDurationMs: Date.now() - startTime,
          warnings: [],
          version: '2.0.0',
        },
        listings: [],
      };
      writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf-8');
      log('info', 'No vacancies — wrote empty listings.json');
      return;
    }

    // 3. Fetch each detail page and extract full data
    const listings = [];
    for (let i = 0; i < uuids.length; i++) {
      const uuid = uuids[i];
      const detailUrl = `${BASE_URL}/listings/detail/${uuid}`;

      try {
        log('info', `Fetching detail page ${i + 1}/${uuids.length}`, { uuid });
        const detailHtml = await fetchWithRetry(detailUrl);
        const listing = parseDetailPage(detailHtml, uuid);
        listings.push(listing);
        log('info', `Parsed listing: ${listing.title}`, {
          images: listing.imageUrls.length,
          sqft: listing.sqft,
          rent: listing.rent,
        });
      } catch (err) {
        log('warn', `Failed to fetch detail page for ${uuid}: ${err.message}`);
        // Continue with other listings
      }

      // Polite delay between requests
      if (i < uuids.length - 1) {
        await sleep(DETAIL_FETCH_DELAY_MS);
      }
    }

    if (listings.length === 0) {
      throw new Error('No listings could be parsed from detail pages');
    }

    // 4. Add geocoding for map display
    for (const listing of listings) {
      const coords = geocodeCity(listing.city);
      listing.lat = coords.lat + (Math.random() - 0.5) * 0.005;
      listing.lng = coords.lng + (Math.random() - 0.5) * 0.005;
    }

    // 5. Validate
    const validation = validateListings(listings);

    if (!validation.valid) {
      log('error', 'Validation failed', { errors: validation.errors });
      process.exit(3);
    }

    if (validation.warnings.length > 0) {
      log('warn', 'Validation warnings', { warnings: validation.warnings });
    }

    // 6. Load previous data for comparison
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

    // 7. Content hash for change detection
    const contentHash = simpleHash(JSON.stringify(listings));
    const hasChanges = contentHash !== previousHash;

    // 8. Build output
    const output = {
      meta: {
        lastUpdated: new Date().toISOString(),
        source: APPFOLIO_URL,
        listingCount: listings.length,
        noVacancies: false,
        previousCount,
        hasChanges,
        contentHash,
        scrapeDurationMs: Date.now() - startTime,
        warnings: validation.warnings,
        version: '2.0.0',
      },
      listings,
    };

    // 9. Write output
    writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf-8');
    log('info', 'Successfully wrote listings.json', {
      count: listings.length,
      hasChanges,
      totalImages: listings.reduce((sum, l) => sum + l.imageUrls.length, 0),
      file: OUTPUT_FILE,
    });

    // 10. GitHub Actions summary
    if (process.env.GITHUB_STEP_SUMMARY) {
      const totalImages = listings.reduce((sum, l) => sum + l.imageUrls.length, 0);
      const summary = [
        `## 📋 Scrape Results (v2.0)`,
        `| Metric | Value |`,
        `| --- | --- |`,
        `| Listings Found | ${listings.length} |`,
        `| Total Images | ${totalImages} |`,
        `| Previous Count | ${previousCount ?? 'N/A'} |`,
        `| Changes Detected | ${hasChanges ? '✅ Yes' : '➖ No'} |`,
        `| Duration | ${Date.now() - startTime}ms |`,
        `| Warnings | ${validation.warnings.length} |`,
        '',
        ...listings.map(l => `### ${l.title}\n- 📍 ${l.address || 'No address'}\n- 💰 $${l.rent?.toLocaleString() || '?'}/mo | ${l.sqft?.toLocaleString() || '?'} SF\n- 🖼️ ${l.imageUrls.length} images`),
        validation.warnings.length > 0 ? `\n### ⚠️ Warnings\n${validation.warnings.map(w => `- ${w}`).join('\n')}` : '',
      ].join('\n');
      writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a' });
    }

  } catch (err) {
    log('error', `Scraper failed: ${err.message}`, { stack: err.stack });

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
