V-Care_Telegram — DhanHQ Option-Chain Telegram Worker
====================================================

FILES
- V-Care_Telegram.mjs : complete Cloudflare Worker source
- wrangler.jsonc      : Cloudflare Worker configuration

WHAT THIS BUILD DOES
- Removes Angel One / SmartAPI integration entirely.
- Uses DhanHQ API v2 Option Chain + Expiry List endpoints.
- Uses full CE/PE chain fields returned by Dhan: LTP, OI, previous OI, volume,
  previous volume, IV, Greeks, best bid/ask and quantities.
- Sends a separate 08:30 IST morning RSS-news briefing to Telegram.
- Intraday analysis uses ONLY option-chain evidence. It does not use charts,
  candles, EMA, RSI, VWAP or other technical indicators.
- Cloudflare Workers AI is used for a constrained option-chain assessment.
- Sends simulated BUY CE / BUY PE alerts with target, stop, trailing and time exit.
- Tracks a simulated position and can send SELL TO CLOSE / EXIT alerts.
- No Dhan order placement is implemented. No live order can be placed by this file.

IMPORTANT DATA NOTES
- Dhan Option Chain endpoint has a documented rate limit of one unique request
  every 3 seconds. This Worker polls on a 3-minute cron schedule.
- This version uses REST Option Chain snapshots; it does NOT maintain a persistent
  Dhan WebSocket connection. A WebSocket relay / Durable Object requires a separate
  persistent-feed implementation and should be added and tested before relying on ticks.
- Dhan API access token generated from Dhan Web is typically valid for 24 hours.
  Update DHAN_ACCESS_TOKEN when it expires, unless you implement a separately tested
  OAuth/token-renewal workflow.
- Data API charges/entitlements depend on the Dhan account/product.
- RSS headlines are unverified context. News direction is not fed into the option-chain
  signal engine.
- AI can be unavailable or return WAIT. WAIT is a valid outcome; no signal is guaranteed.
- Signals are simulated Telegram alerts only, not investment advice or broker orders.

CLOUDFLARE SETUP
1. Put V-Care_Telegram.mjs and wrangler.jsonc in the GitHub repository root.
2. Cloudflare Dashboard > Workers & Pages > Create/your Worker > Settings > Builds:
   connect the GitHub repository and select the production branch.
3. Confirm Worker name is v-care-telegram and entry file is V-Care_Telegram.mjs.
4. In Worker Settings > Variables and Secrets, add these as Secrets:
   DHAN_CLIENT_ID
   DHAN_ACCESS_TOKEN
   TELEGRAM_BOT_TOKEN
   TELEGRAM_CHAT_ID
   TELEGRAM_WEBHOOK_SECRET
   VCARE_ADMIN_TOKEN
5. Add these as Variables (not secrets). The current Dhan index mapping used here is NIFTY=13 and SENSEX=51 in IDX_I; confirm against the current Dhan instrument master if Dhan reports Invalid SecurityId:
   DHAN_NIFTY_UNDERLYING_SCRIP=13
   DHAN_NIFTY_UNDERLYING_SEG=IDX_I
   DHAN_SENSEX_UNDERLYING_SCRIP=51
   DHAN_SENSEX_UNDERLYING_SEG=IDX_I
   VC_UNDERLYINGS=NIFTY,SENSEX
   VC_TARGET_PCT=12
   VC_STOP_PCT=8
   VC_TRAIL_ACTIVATE_PCT=6
   VC_TRAIL_GAP_PCT=3
   VC_MAX_HOLD_MINUTES=20
   MARKET_HOLIDAYS=YYYY-MM-DD,YYYY-MM-DD
6. Bind Workers AI as AI and KV namespace as STATE. The supplied wrangler.jsonc
   keeps the original KV namespace ID. Confirm it exists in the target Cloudflare account.
7. Deploy and open /health, then /status.

TELEGRAM WEBHOOK
Set webhook URL to:
https://<your-worker-domain>/telegram-webhook
Use Telegram setWebhook secret_token equal to TELEGRAM_WEBHOOK_SECRET.
The bot only responds to the configured TELEGRAM_CHAT_ID.

COMMANDS
/start or /help
/status
/briefing
/options NIFTY
/options SENSEX
/analyze

SECURITY
- Never put Dhan access token, Telegram bot token, webhook secret or admin token in GitHub.
- Use Cloudflare Secrets.
- Keep the GitHub repository private.
- Do not enable real order placement without a separate reviewed execution layer,
  explicit risk limits, broker order reconciliation and extensive paper testing.

VALIDATION
- Test /health and /status first.
- Check Dhan access token and both underlying Security IDs.
- Run /options NIFTY and /options SENSEX from Telegram.
- Verify option chain expiry, spot, strike, CE/PE, OI, volume, IV, Greeks and bid/ask.
- Paper-test alert, target, stop, trailing and time-exit behaviour before considering
  any live execution system.
