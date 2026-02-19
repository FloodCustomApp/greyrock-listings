# GreyRock CRE — AppFolio Listings Widget

Automated scraper that pulls commercial property listings from AppFolio and serves them as a beautiful, interactive widget for the GreyRock CRE website.

## How It Works

```
AppFolio Listings Page  →  GitHub Actions (every 30 min)  →  listings.json  →  Widget fetches JSON
                              ↓ (on failure)
                         Email alert sent
                         Last good data stays live
```

1. **GitHub Actions** runs the scraper on a schedule (every 30 min during business hours)
2. The scraper fetches your AppFolio listings page, parses the HTML, and saves structured JSON
3. **GitHub Pages** hosts the JSON file and widget at a public URL
4. Your Wix site embeds the widget, which fetches the JSON on page load
5. If the scraper fails (e.g., AppFolio changes their page), you get an **email alert** and the last good data continues to be served

## Setup Instructions

### 1. Create the GitHub Repo

```bash
# Clone or create a new repo
git init greyrock-listings
cd greyrock-listings

# Copy all project files in, then:
git add .
git commit -m "Initial commit: AppFolio listings scraper + widget"
git remote add origin https://github.com/YOUR_USERNAME/greyrock-listings.git
git push -u origin main
```

### 2. Enable GitHub Pages

1. Go to your repo → **Settings** → **Pages**
2. Under "Source", select **Deploy from a branch**
3. Select **main** branch and **/docs** folder
4. Click Save

Your widget will be live at: `https://YOUR_USERNAME.github.io/greyrock-listings/`

### 3. Update the Widget Data URL

In `docs/index.html`, update the `DATA_URL` constant (around line 365):

```javascript
// Change this:
const DATA_URL = 'listings.json';

// To this:
const DATA_URL = 'https://YOUR_USERNAME.github.io/greyrock-listings/listings.json';
```

### 4. Configure Email Alerts (Optional but Recommended)

To receive email notifications when the scraper fails:

1. Go to your repo → **Settings** → **Variables and secrets** → **Actions**
2. Add these **Repository Variables**:
   - `ALERT_EMAIL` = `info@greyrockcre.com` (or your preferred address)
   - `APPFOLIO_URL` = `https://greyrockcommercial.appfolio.com/listings` (optional, has default)

3. Add these **Repository Secrets** (for sending email):
   - `SMTP_SERVER` = `smtp.gmail.com` (or your mail server)
   - `SMTP_PORT` = `587`
   - `SMTP_USERNAME` = your email sender address
   - `SMTP_PASSWORD` = your email app password

> **Gmail users:** Use an [App Password](https://support.google.com/accounts/answer/185833), not your regular password.

Even without email setup, **GitHub will email you automatically** when the workflow fails — just make sure your GitHub notification settings are enabled.

### 5. Run the First Scrape

1. Go to **Actions** tab in your repo
2. Click "Scrape AppFolio Listings" workflow
3. Click "Run workflow" → "Run workflow"
4. Watch it run — it should complete in under 30 seconds

### 6. Embed in Wix

On your Wix site's "For Lease" page:

1. Add an **Embed HTML** element (or "Custom Element")
2. Set it to use a **Website address (URL)**
3. Enter: `https://YOUR_USERNAME.github.io/greyrock-listings/`
4. Resize the element to fill the page width and give it enough height (800-1000px)

## Alert Layers

| Layer | What It Does | Setup Required |
|-------|-------------|----------------|
| **GitHub Notifications** | Emails you when any workflow fails | None (built-in) |
| **Validation Checks** | Fails the workflow if data looks wrong (0 listings, suspicious values) | None (built-in) |
| **Stale Data Banner** | Shows yellow warning on widget if data > 2 hours old | None (built-in) |
| **Email Alert Job** | Sends detailed failure email with instructions | SMTP secrets (optional) |

## File Structure

```
greyrock-listings/
├── .github/
│   └── workflows/
│       └── scrape.yml          # GitHub Actions workflow (cron + alerts)
├── scraper/
│   └── scrape.mjs              # Node.js scraper script
├── docs/                       # GitHub Pages root
│   ├── index.html              # The listing widget
│   └── listings.json           # Auto-updated listing data
├── package.json
└── README.md
```

## Troubleshooting

**Scraper keeps failing:**
- Visit `https://greyrockcommercial.appfolio.com/listings` in your browser
- If the page looks different than expected, the HTML structure may have changed
- Check the workflow logs in the Actions tab for specific errors

**Widget shows stale data banner:**
- The scraper may have failed recently — check the Actions tab
- The banner auto-clears once a fresh scrape succeeds

**Widget shows "Unable to Load":**
- Make sure GitHub Pages is enabled and the URL is correct
- Check browser console for CORS or fetch errors

**No listings appearing:**
- Your AppFolio account may have no active listings
- The widget will show a "No Properties Currently Available" message with a contact link

## Customization

- **Colors/fonts:** Edit the CSS variables in `docs/index.html`
- **Scrape frequency:** Edit the cron schedule in `.github/workflows/scrape.yml`
- **Stale threshold:** Change `STALE_THRESHOLD_HOURS` in `docs/index.html`
- **Map center:** Adjust the default coordinates in `docs/index.html` (currently Charlotte metro)
