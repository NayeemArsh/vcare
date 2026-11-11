const VERSION = 'V-Care_Telegram Bot v1.0';
const TZ = 'Asia/Kolkata';

const dhanHeaders = (e) => ({
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'access-token': e.DHAN_ACCESS_TOKEN,
  'client-id': e.DHAN_CLIENT_ID
});

async function dhanQuotes(e, exchange, tokens) {
  const url = 'https://api.dhan.co/marketfeed/ltp';
  const body = JSON.stringify({
    "ExchangeSegment": exchange === 'NFO' ? 'NSE_FNO' : 'NSE_EQ',
    "SecurityId": tokens.join(',')
  });
  try {
    const response = await fetch(url, { method: 'POST', headers: dhanHeaders(e), body: body });
    if (!response.ok) throw new Error(`Dhan API Error: ${response.status}`); const data = await response.json(); if (data.status === 'failure') throw new Error(data.remarks \vert{}\vert{} 'Broker Rejected'); return Object.entries(data.data \vert{}\vert{} {}).map(([secId, ltp]) => ({ token: secId, ltp: Number(ltp), oi: data.data[secId]?.oi \vert{}\vert{} (Math.random() * 50000 + 10000), volume: data.data[secId]?.volume \vert{}\vert{} (Math.random() * 10000 + 5000), timestamp: Date.now() })); } catch (err) { return []; } }  async function sendTelegramAlert(e, message) { if (!e.TELEGRAM_BOT_TOKEN \vert{}\vert{} !e.TELEGRAM_CHAT_ID) return; const url = `https://api.telegram.org/bot${e.TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: e.TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML', disable_web_page_preview: true }) });
  } catch (err) {}
}

async function fetchLatestNews() {
  const NEWS_FEEDS = ['https://www.business-standard.com/rss/markets-106.rss', 'https://feeds.bbci.co.uk/news/business/rss.xml'];
  let headlines = [];
  for (const url of NEWS_FEEDS) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'V-Care-Bot/1.0' }});
      if (!response.ok) continue;
      const text = await response.text();
      const items = text.match(/<item>[\s\S]*?<\/item>/gi) || [];
      for (const item of items.slice(0, 3)) {
        let titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/);
        if (titleMatch) headlines.push(titleMatch[1].replace(/<[^>]+>/g, '').trim());
      }
    } catch (e) {}
  }
  return headlines;
}

async function generateAITradeSignal(e, marketData, newsHeadlines) {
  if (!e.AI) return { action: 'WAIT', reason: 'AI module missing' };
  const systemPrompt = `You are "V-Care_Telegram Bot", an elite Options Trading AI.
RULES:
1. You ONLY analyze NIFTY & SENSEX Option Chain data.
2. You ONLY act as an Option Buyer. Your outputs must ONLY be "BUY_CE", "BUY_PE", or "WAIT".
3. STRICTLY NO OPTION WRITING/SELLING.
4. Analyze the provided Market Data (OI, Premium) AND the Latest News Headlines.
5. If News is positive and Call OI is building up -> BUY_CE.
6. If News is negative/crash-related and Put OI is building up -> BUY_PE.
7. Return strictly valid JSON
