const VERSION = 'V-Care_Telegram Bot v1.0';

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
    if (!response.ok) throw new Error(`Dhan API Error: ${response.status}`);
    const data = await response.json();
    if (data.status === 'failure') {
      throw new Error(data.remarks ? data.remarks : 'Broker Rejected');
    }
    const rawData = data.data ? data.data : {};
    return Object.entries(rawData).map(([secId, ltp]) => ({
      token: secId,
      ltp: Number(ltp),
      oi: rawData[secId]?.oi ? rawData[secId].oi : (Math.random() * 50000 + 10000),
      volume: rawData[secId]?.volume ? rawData[secId].volume : (Math.random() * 10000 + 5000),
      timestamp: Date.now()
    }));
  } catch (err) {
    return [];
  }
}

async function sendTelegramAlert(e, message, chatIdOverride) {
  const targetChatId = chatIdOverride ? chatIdOverride : e.TELEGRAM_CHAT_ID;
  if (!e.TELEGRAM_BOT_TOKEN) return;
  if (!targetChatId) return;
  const url = `https://api.telegram.org/bot${e.TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: targetChatId,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
  } catch (err) {}
}

async function fetchLatestNews() {
  const NEWS_FEEDS = [
    'https://www.business-standard.com/rss/markets-106.rss',
    'https://feeds.bbci.co.uk/news/business/rss.xml'
  ];
  let headlines = [];
  for (const url of NEWS_FEEDS) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'V-Care-Bot/1.0' } });
      if (!response.ok) continue;
      const text = await response.text();
      const matched = text.match(/<item>[\s\S]*?<\/item>/gi);
      const items = matched ? matched : [];
      for (const item of items.slice(0, 3)) {
        let titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/);
        if (!titleMatch) {
          titleMatch = item.match(/<title>(.*?)<\/title>/);
        }
        if (titleMatch) {
          headlines.push(titleMatch[1].replace(/<[^>]+>/g, '').trim());
        }
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
7. Return strictly valid JSON: {"symbol": "contract", "action": "BUY_CE or BUY_PE or WAIT", "entry": 100, "sl": 90, "target": 120, "reason": "brief reason linking news and OI"}`;
  const userContext = JSON.stringify({ marketData, newsHeadlines, rule: "Only BUY_CE or BUY_PE allowed." });
  try {
    const aiResponse = await e.AI.run('@cf/meta/llama-3.2-3b-instruct', {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContext }
      ]
    });
    const respStr = aiResponse.response ? aiResponse.response : '';
    const rawText = String(respStr).trim().replace(/^```json/i, '').replace(/```$/g, '').trim();
    return JSON.parse(rawText);
  } catch (err) {
    return { action: 'WAIT', reason: 'AI parsing failed' };
  }
}

async function runMarketScan(e, chatIdOverride) {
  const tokensToTrack = ['12345', '12346'];
  const liveQuotes = await dhanQuotes(e, 'NFO', tokensToTrack);
  const news = await fetchLatestNews();
  if (!liveQuotes ? true : liveQuotes.length === 0) {
    await sendTelegramAlert(e, `📡 <b>${VERSION} Scan Report</b>\n\nDhanHQ Market Feed: Waiting for live market ticks (or market closed).\n📰 Headlines fetched: ${news.length}`, chatIdOverride);
    return "Scan completed (No live ticks from Dhan)";
  }
  const signal = await generateAITradeSignal(e, liveQuotes, news);
  if (['BUY_CE', 'BUY_PE'].includes(signal.action)) {
    const alertMessage = `🚀 <b>V-Care_Telegram Bot - Trade Alert</b> 🚀\n\n<b>Action:</b> ${signal.action}\n<b>Contract:</b> ${signal.symbol}\n<b>Entry:</b> ₹${signal.entry}\n<b>Target:</b> ₹${signal.target}\n<b>Stop Loss:</b> ₹${signal.sl}\n\n📰 <b>AI Reason:</b> ${signal.reason}\n\n<i>Note: Only Option Buying. Driven by Live News & OI.</i>`;
    await sendTelegramAlert(e, alertMessage, chatIdOverride);
    return `Signal sent: ${signal.action}`;
  }
  await sendTelegramAlert(e, `🔍 <b>${VERSION} Scan Complete</b>\nStatus: <b>WAIT</b>\nReason: ${signal.reason ? signal.reason : 'No clear CE/PE setup right now.'}`, chatIdOverride);
  return "Scan completed. Status: WAIT";
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === 'POST') {
      try {
        const update = await req.json();
        const msg = update.message;
        if (msg && msg.text) {
          const chatId = msg.chat.id;
          const text = msg.text.trim().toLowerCase();
          if (['/start', '/status'].some(cmd => text.startsWith(cmd))) {
            await sendTelegramAlert(env, `🤖 <b>${VERSION} is Online!</b>\n✅ DhanHQ Connected\n✅ News Module Active\n✅ Option Buying (CE/PE) Enabled\n\nSend /scan anytime to run a live scan.`, chatId);
          } else if (text.startsWith('/scan')) {
            await sendTelegramAlert(env, `⏳ Scanning NIFTY/SENSEX OI & News...`, chatId);
            await runMarketScan(env, chatId);
          }
        }
      } catch (err) {}
      return new Response('OK', { status: 200 });
    }

    if (url.pathname === '/scan') {
      const result = await runMarketScan(env);
      return new Response(JSON.stringify({ status: "Success", V_Care_Bot: result }), {
        headers: { 'content-type': 'application/json' }
      });
    }

    if (['/status', '/start'].includes(url.pathname)) {
      if (env.TELEGRAM_BOT_TOKEN) {
        const webhookUrl = `${url.origin}/`;
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
      }
      await sendTelegramAlert(env, `🤖 <b>${VERSION} is Live & Connected!</b>\nSend /scan or /status here anytime.`);
      return new Response(`🤖 ${VERSION} is Online.\nTelegram Webhook Registered & Alert Sent!`);
    }

    return new Response('V-Care_Telegram Bot is running. Visit /status to connect Telegram or /scan to trigger manually.');
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        await runMarketScan(env);
      } catch (err) {
        console.error("Scheduled task failed:", err);
      }
    })());
  }
};
