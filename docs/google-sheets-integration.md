QA.Hub → Google Sheets Integration

Create a Google Sheet with an AI Audit Data tab. Deploy the Apps Script Web App template from api/google-sheets-webapp.js. Set GOOGLE_SHEETS_WEBHOOK_URL in Vercel. Optional sync secret can be used for additional validation.

The QA audit is saved to Firebase first. Google Sheets synchronization is separate so a Sheet outage does not fail an AI audit.
