// Keeps AI crawlers and scrapers out of your shop while leaving ordinary search engines alone.
//
// What it does:
//   1. robots.txt asks AI crawlers (and the AI opt-out tokens that only exist in robots.txt) to stay away.
//   2. Every response carries "X-Robots-Tag: noai, noimageai", the signal image and AI crawlers are asked to respect.
//   3. Requests from known AI crawlers get a 403 even if they ignore robots.txt.
//   4. Customer-only pages (receipts, thank-you page, staff screens) are kept out of search results.
//
// What it never touches: Googlebot, Bingbot, DuckDuckBot, Applebot (Siri and Spotlight search),
// Pinterest, and the link-preview fetchers used by Facebook, Slack, X, LinkedIn, iMessage and Discord.
// Your shop stays findable in Google.
//
// Honest limit: this stops crawlers that identify themselves. A scraper that pretends to be a normal
// browser looks like a normal browser. Cloudflare's bot controls (see the guide) are the stronger layer.

// Product names used both in robots.txt and, lowercased, to recognise a crawler by its User-Agent.
const AI_AGENTS = [
  // OpenAI
  'GPTBot', 'ChatGPT-User', 'OAI-SearchBot',
  // Anthropic
  'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'Claude-Web', 'anthropic-ai',
  // Others that collect content for AI training or AI answers
  'CCBot', 'PerplexityBot', 'Perplexity-User', 'Bytespider', 'Amazonbot',
  'meta-externalagent', 'meta-externalfetcher', 'FacebookBot',
  'cohere-ai', 'cohere-training-data-crawler', 'Diffbot', 'ImagesiftBot',
  'Omgilibot', 'Omgili', 'Timpibot', 'YouBot', 'DuckAssistBot', 'MistralAI-User',
  'AI2Bot', 'Ai2Bot-Dolma', 'PanguBot', 'img2dataset', 'Kangaroo Bot',
  'FriendlyCrawler', 'ICC-Crawler', 'SBIntuitionsBot',
];

// Opt-out tokens that only work through robots.txt (they never appear as a User-Agent).
// Google-Extended stops Gemini training and does NOT affect Google Search.
// Applebot-Extended stops Apple's AI training and does NOT affect Siri or Spotlight search.
const ROBOTS_ONLY_TOKENS = ['Google-Extended', 'Applebot-Extended', 'Webzio-Extended'];

const AI_LOWER = AI_AGENTS.map((a) => a.toLowerCase());

function isAiAgent(userAgent) {
  const ua = String(userAgent || '').toLowerCase();
  return !!ua && AI_LOWER.some((a) => ua.includes(a));
}

function robotsTxt(on) {
  const lines = ['# Search engines are welcome.', 'User-agent: *', 'Allow: /', ''];
  if (on) {
    lines.push('# AI crawlers are not. This shop\'s photos and writing are not for AI training.');
    for (const a of [...AI_AGENTS, ...ROBOTS_ONLY_TOKENS]) lines.push('User-agent: ' + a);
    lines.push('Disallow: /', '');
  }
  return lines.join('\n');
}

// Pages that belong to one customer or to the staff. They should never show up in a search.
const PRIVATE_PATHS = new Set(['/', '/index.html', '/admin.html', '/receipt.html', '/thanks.html']);

// enabled():  returns true when the seller has the protection on (it is on unless they turn it off)
// onBlock(req, agent): called when an AI crawler is turned away (rate-limited here so one busy crawler can't flood a log)
function aiShield({ enabled, onBlock }) {
  const lastLogged = new Map();
  return (req, res, next) => {
    // Customer-only pages stay out of search results whether or not AI blocking is on.
    if (PRIVATE_PATHS.has(req.path)) res.set('X-Robots-Tag', 'noindex, nofollow' + (enabled() ? ', noai, noimageai' : ''));
    if (!enabled()) return next();
    if (!res.get('X-Robots-Tag')) res.set('X-Robots-Tag', 'noai, noimageai');
    if (req.path === '/robots.txt') return next();
    const ua = req.get('user-agent');
    if (isAiAgent(ua)) {
      const key = String(ua).slice(0, 80), now = Date.now();
      if (onBlock && now - (lastLogged.get(key) || 0) > 3600e3) {
        lastLogged.set(key, now);
        if (lastLogged.size > 200) lastLogged.clear();
        onBlock(req, key);
      }
      return res.status(403).type('text/plain').send('AI crawlers are not allowed on this site.');
    }
    next();
  };
}

module.exports = { aiShield, robotsTxt, isAiAgent, AI_AGENTS, ROBOTS_ONLY_TOKENS };
