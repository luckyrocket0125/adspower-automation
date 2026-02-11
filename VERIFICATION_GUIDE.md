# Verification Guide: Recent Changes

## 1. Browsers Hidden/Headless Mode

### How to Verify:
1. **Run any automation action** (DNA Analysis, Diagnostics, or Farming)
2. **Check your system**:
   - No browser windows should open visibly
   - Browser processes run in the background (headless)
   - You can verify in Task Manager (Windows) or Activity Monitor (Mac) - you'll see Chrome/Chromium processes but no visible windows

### Technical Details:
- **Location**: `src/services/adspower.js` – `startProfile()` sends the **headless** parameter to AdsPower's API
- **AdsPower API**: `headless: "1"` = run hidden (no window), `headless: "0"` = show browser window
- **Default**: "Run browsers hidden" is checked, so we send `headless: "1"` (hidden)
- **When unchecked**: We send `headless: "0"` so the browser window is visible

### Why This Matters:
- Saves system resources (CPU, RAM, GPU)
- Allows running multiple profiles simultaneously without cluttering your screen
- Prevents accidental interaction with automated browsers

### Toggle to Show Browsers (New):
- **Location**: Top header of the dashboard (right side), checkbox **"Run browsers hidden"**
- **Default**: Checked (browsers run hidden)
- **To show browsers**: Uncheck "Run browsers hidden"; then run DNA, Check, or Farm — browser windows will open visibly
- **Persistence**: The choice is saved in `localStorage` (key: `runBrowsersHidden`) and applies to all actions: DNA, Diagnostics, and Farming (single and bulk)

---

## 2. Proxy Information Moved to Basic Information

### How to Verify:
1. **Open the dashboard** and click on any profile's "View Details" button
2. **Check the profile details modal**:
   - Look in the **"Basic Information"** section (left column)
   - Proxy information should appear **after "Created At"**
   - The separate **"Proxy Information"** section should be **removed**

### Before:
- Proxy had its own section at the bottom
- Took up extra space

### After:
- Proxy is now in Basic Information section
- Cleaner, more organized layout
- Shows: `host:port (type)` or `No proxy`

### Technical Details:
- **Location**: `src/dashboard/public/index.html` around line 3451-3454
- **Code**:
  ```javascript
  <div style="margin-bottom: 12px;">
      <div style="color: #999; font-size: 12px; margin-bottom: 4px;">Proxy</div>
      <div style="color: #fff; font-size: 14px;">${proxyInfo}</div>
  </div>
  ```

---

## 3. Trust Score Removed from DNA Analysis

### How to Verify:
1. **Open profile details** for any profile
2. **Check the "DNA Analysis" section** (right column):
   - Should show: Name, Gender, Birthday, Age Bracket, Location, Language, Interests, Network Error
   - **Trust Score should NOT appear** in this section
   - Trust Score is still calculated and stored, just not displayed in DNA Analysis

### Why This Change:
- Trust Score comes from Diagnostics Check, not DNA Analysis
- DNA Analysis is about persona/interests, not trustworthiness
- Separates concerns: DNA = who the profile is, Trust Score = account health

### Technical Details:
- **Location**: `src/dashboard/public/index.html` around line 3456-3500
- **Removed**: The entire trust score display block (previously lines 3482-3496)

---

## 4. Last Farmed Date Fix

### How to Verify:
1. **Run a farming action** on any profile
2. **Open that profile's details** (click "View Details")
3. **Check the "Activity" section** at the bottom:
   - "Last Farmed" should show the current date/time
   - If you farm again, the date should update

### Before the Fix:
- `lastFarmed` was saved to database but not included in API response
- Modal showed "Never" or old date even after farming

### After the Fix:
- `lastFarmed` is now included in the profile API response
- Modal automatically refreshes after farming completes
- Shows accurate "Last Farmed" timestamp

### Technical Details:

**Backend (API Response)**:
- **Location**: `src/dashboard/server.js` line 133
- **Code**:
  ```javascript
  const profileData = {
      ...profile,
      lastFarmed: profile.lastFarmed || null,  // ← Added this
      diagnosticsResult: diagnosticsResult
  };
  ```

**Frontend (Auto-Refresh)**:
- **Location**: `src/dashboard/public/index.html` around line 3278-3289
- **Code**: After farming completes, if the modal is open, it automatically:
  1. Fetches the latest profile data
  2. Refreshes the modal with updated information
  3. Shows the new "Last Farmed" date

**Database Update**:
- **Location**: `src/modules/farmer.js` line 96
- **Code**:
  ```javascript
  await Profile.update(profileId, { lastFarmed: new Date() });
  ```

### How It Works:
1. User clicks "Farm" button
2. Farming module runs all activities
3. At the end, it updates `lastFarmed` in database with current timestamp
4. Frontend detects farming is complete
5. If profile details modal is open, it automatically refreshes
6. Modal displays the updated "Last Farmed" date

---

## Quick Test Checklist

- [ ] Run DNA Analysis → No browser windows open
- [ ] Run Diagnostics → No browser windows open  
- [ ] Run Farming → No browser windows open
- [ ] Open profile details → Proxy is in Basic Information section
- [ ] Open profile details → Trust Score is NOT in DNA Analysis section
- [ ] Run farming on a profile → Check "Last Farmed" updates correctly
- [ ] Keep modal open during farming → Modal auto-refreshes with new date

---

## Troubleshooting

### Browsers Still Opening?
- Check `src/services/adspower.js` line 423 and 611
- Ensure `openTabs: 0` is being used (not `1`)

### Last Farmed Not Updating?
1. Check browser console for errors
2. Verify the profile ID is correct
3. Check database directly: `db.profiles.findOne({ adspowerId: "your-profile-id" })`
4. Ensure farming completed successfully (check logs)

### Modal Not Refreshing?
- The modal only auto-refreshes if it's already open when farming completes
- If you open the modal after farming, it should show the updated date
- Try closing and reopening the modal
