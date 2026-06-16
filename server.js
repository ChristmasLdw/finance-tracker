const express = require('express');
const { execFile } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3008;

// Path prefix middleware: strip /finance-tracker prefix for direct access (port 3008)
// This allows the page to work both via nginx proxy (https://christmasldw.com/finance-tracker/)
// and direct Node.js access (http://christmasldw.com:3008/)
app.use((req, res, next) => {
  if (req.url.startsWith('/finance-tracker')) {
    req.url = req.url.slice('/finance-tracker'.length) || '/';
  }
  next();
});

const WESTOK_SCRIPT = path.join(__dirname, 'scripts/westock-data.js');
const CACHE_DIR = path.join(__dirname, 'cache');
const NEODATA_TOKEN_FILE = path.join(__dirname, '.neodata_token');
const NEODATA_ENDPOINT = 'https://copilot.tencent.com/agenttool/v1/neodata';

// Companies config
const COMPANIES = {
  'hk00700': { name: '腾讯控股', code: '00700', neodataQuery: '腾讯控股 00700.HK 2026年股份回购明细 每日回购股数和金额' },
  'hk01810': { name: '小米集团', code: '01810', neodataQuery: '小米集团-W 01810.HK 2026年股份回购明细 每日回购股数和金额' },
  'hk09992': { name: '泡泡玛特', code: '09992', neodataQuery: '泡泡玛特 09992.HK 2026年股票回购明细 每日回购股数和金额' },
};

// Ensure cache dir
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// Read neodata token
function getNeodataToken() {
  try {
    if (!fs.existsSync(NEODATA_TOKEN_FILE)) return null;
    const raw = fs.readFileSync(NEODATA_TOKEN_FILE, 'utf8').trim();
    const data = JSON.parse(raw);
    return data.token || null;
  } catch (e) {
    return null;
  }
}

// Call neodata API
function callNeodata(query, dataType = 'all') {
  return new Promise((resolve, reject) => {
    const token = getNeodataToken();
    if (!token) return reject(new Error('No neodata token available'));

    const payload = JSON.stringify({
      query,
      channel: 'neodata',
      sub_channel: 'workbuddy',
      ...(dataType !== 'all' ? { data_type: dataType } : {}),
    });

    const url = new URL(NEODATA_ENDPOINT);
    const req = https.request({
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Failed to parse neodata response'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Neodata request timeout')); });
    req.write(payload);
    req.end();
  });
}

// Parse structured buyback data from neodata API recall
// Format: "于2026-06-05回购109.2万股，回购均价为458.273港元"
function parseStructuredBuyback(content) {
  const items = [];
  const regex = /于(\d{4}-\d{2}-\d{2})回购([\d.]+)万股，回购均价为([\d.]+)港元/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const sharesWan = parseFloat(match[2]);
    const avgPrice = parseFloat(match[3]);
    const amount = sharesWan * 10000 * avgPrice;
    items.push({
      date: match[1],
      shares: sharesWan * 10000, // Convert 万 to actual shares
      sharesWan: sharesWan,
      avgPrice: avgPrice,
      amount: Math.round(amount),
      source: 'structured',
    });
  }
  return items;
}

// Parse buyback from Xiaomi news articles (handles both table and single-line formats)
function parseXiaomiBuybackFromArticles(docList) {
  const items = [];
  const seen = new Set();

  // Cumulative indicators to exclude
  const cumulativeWords = /合计|累计|连续|合共|总计|以来.*回购/;

  for (const doc of docList) {
    const content = (doc.content || '') + '\n' + (doc.title || '');

    // Pattern 1: Table format - handles both spaced and packed fields
    // Spaced: "2026.01.09 400.00 37.920 37.740 15132.64"
    // Packed: "2026.01.09400.0037.92037.74015132.64"
    // Strategy: date is 10 chars (YYYY.MM.DD), then use known field patterns
    const tableRegex = /(\d{4}\.\d{2}\.\d{2})\s*(\d+\.\d{2})\s*(\d+\.\d{3})\s*(\d+\.\d{3})\s*(\d+\.\d{2})/g;
    let match;
    while ((match = tableRegex.exec(content)) !== null) {
      const dateStr = match[1].replace(/\./g, '-');
      if (seen.has(dateStr)) continue;
      seen.add(dateStr);
      const sharesWan = parseFloat(match[2]);
      const amountWan = parseFloat(match[5]);
      // Validate: shares should be reasonable (< 10000 万股 for a single day)
      if (sharesWan > 0 && sharesWan < 10000) {
        items.push({
          date: dateStr,
          shares: Math.round(sharesWan * 10000),
          sharesWan,
          avgPrice: Math.round((amountWan / sharesWan) * 100) / 100,
          amount: Math.round(amountWan * 10000),
          source: 'article_table',
        });
      }
    }

    // Pattern 2: "X月X日" single-line format without year
    // Must NOT contain cumulative indicators between the date and the amount
    const singleRegex = /(\d{1,2})月(\d{1,2})日[^。]*?回购[^\d]*?([\d.]+)万股[^。]*?(?:回购金额(?:达|为)|耗资|斥资|金额)\s*([\d.]+)(亿|万)港元/g;
    let m;
    while ((m = singleRegex.exec(content)) !== null) {
      const dateStr = `${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
      // Extract the matched text to check for cumulative indicators
      const matchedText = m[0];
      if (cumulativeWords.test(matchedText)) continue;

      const month = parseInt(m[1]);
      const year = month <= 6 ? '2026' : '2025';
      const fullDate = `${year}-${dateStr}`;
      if (seen.has(fullDate)) continue;
      seen.add(fullDate);

      const sharesWan = parseFloat(m[3]);
      const amount = Math.round(parseFloat(m[4]) * (m[5] === '亿' ? 1e8 : 1e4));
      // Validate: exclude cumulative totals (shares > 2000 万股 for a single day is suspicious)
      if (sharesWan > 0 && sharesWan < 2000) {
        items.push({
          date: fullDate,
          shares: Math.round(sharesWan * 10000),
          sharesWan,
          avgPrice: sharesWan > 0 ? Math.round((amount / (sharesWan * 10000)) * 100) / 100 : 0,
          amount,
          source: 'article_single',
        });
      }
    }

    // Pattern 3: "2026年X月X日" format with explicit year
    const yearRegex = /(\d{4})年(\d{1,2})月(\d{1,2})日[^。]*?回购[^\d]*?([\d.]+)万股[^。]*?(?:回购金额(?:达|为)|耗资|斥资|金额)\s*([\d.]+)(亿|万)港元/g;
    let y;
    while ((y = yearRegex.exec(content)) !== null) {
      const matchedText = y[0];
      if (cumulativeWords.test(matchedText)) continue;

      const dateStr = `${y[1]}-${y[2].padStart(2, '0')}-${y[3].padStart(2, '0')}`;
      if (seen.has(dateStr)) continue;
      seen.add(dateStr);

      const sharesWan = parseFloat(y[4]);
      const amount = Math.round(parseFloat(y[5]) * (y[6] === '亿' ? 1e8 : 1e4));
      if (sharesWan > 0 && sharesWan < 2000) {
        items.push({
          date: dateStr,
          shares: Math.round(sharesWan * 10000),
          sharesWan,
          avgPrice: sharesWan > 0 ? Math.round((amount / (sharesWan * 10000)) * 100) / 100 : 0,
          amount,
          source: 'article_single',
        });
      }
    }
  }

  // Deduplicate and sort by date descending
  const unique = [];
  const seen2 = new Set();
  for (const item of items) {
    if (!seen2.has(item.date)) {
      seen2.add(item.date);
      unique.push(item);
    }
  }
  unique.sort((a, b) => b.date.localeCompare(a.date));
  return unique;
}

// Extract structured buyback from neodata response
function extractBuybackFromNeodata(response, companyCode) {
  const apiRecall = response?.data?.apiData?.apiRecall || [];
  const docRecall = response?.data?.docData?.docRecall || [];

  // First try structured API data
  for (const recall of apiRecall) {
    if (recall.type === '公司回购' && recall.content) {
      const items = parseStructuredBuyback(recall.content);
      if (items.length > 0) return items;
    }
  }

  // Fall back to parsing articles (for Xiaomi)
  for (const recall of docRecall) {
    const docList = recall.docList || [];
    if (docList.length > 0) {
      const items = parseXiaomiBuybackFromArticles(docList);
      if (items.length > 0) return items;
    }
  }

  return [];
}

// Call westock-data CLI
function callWestock(args) {
  return new Promise((resolve, reject) => {
    execFile('node', [WESTOK_SCRIPT, ...args], {
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        if (stdout && stdout.trim()) return resolve(stdout);
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

// Parse westock-data notice output
function parseNoticeTable(output, stockCode) {
  const lines = output.split('\n');
  const notices = [];
  let inTable = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('| id |') || trimmed.startsWith('| --- |')) {
      inTable = true;
      continue;
    }
    if (inTable && trimmed.startsWith('|') && trimmed.includes(stockCode)) {
      if (trimmed.includes('共') && trimmed.includes('条')) continue;
      const cols = trimmed.split('|').map(c => c.trim()).filter(Boolean);
      if (cols.length >= 5) {
        notices.push({
          id: cols[0],
          symbol: cols[1],
          title: cols[2],
          time: cols[3],
          type: cols[4],
        });
      }
    }
    if (inTable && trimmed === '') inTable = false;
  }
  return { notices };
}

// Parse westock-data dividend output
function parseDividendTable(output) {
  const lines = output.split('\n');
  const dividends = [];
  let inTable = false;

  for (const line of lines) {
    if (line.includes('| reportEndDate |')) {
      inTable = true;
      continue;
    }
    if (line.includes('| --- |')) continue;
    if (inTable && line.startsWith('|') && !line.includes('---')) {
      const cols = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cols.length >= 6 && cols[0] !== 'reportEndDate') {
        dividends.push({
          reportEndDate: cols[0],
          exDiviDate: cols[1],
          cashPayDate: cols[2],
          cashDivPerShare: parseFloat(cols[3]) || 0,
          specialDivPerShare: parseFloat(cols[4]) || 0,
          totalCashDivi: cols[5],
          dividendPlan: cols[6] || '',
        });
      }
    }
  }
  return { dividends };
}

// Filter buyback-related notices
function filterBuybackNotices(notices) {
  const buybackKeywords = ['股份购回', '股份回购', '购回', '回购', 'buyback', 'repurchase', '翌日披露'];
  return notices.filter(n => {
    const title = (n.title || '').toLowerCase();
    return buybackKeywords.some(kw => title.includes(kw.toLowerCase()));
  });
}

// 生成最近N个交易日（排除周六周日）
function getLastNTradingDays(n) {
  const days = [];
  const d = new Date();
  d.setHours(d.getHours() + 8);
  d.setDate(d.getDate() - 1);

  while (days.length < n) {
    const dayOfWeek = d.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      days.push(y + "-" + m + "-" + dd);
    }
    d.setDate(d.getDate() - 1);
  }
  return days;
}

// Cache helpers
// getCache: always return cached data if exists (no TTL expiry for user requests).
// Data freshness is maintained by the cron warm-cache job (runs at 9:00 and 20:00 on weekdays).
// Pass maxAgeMs only when you explicitly want a TTL check (e.g. background refresh logic).
function getCache(key, maxAgeMs) {
  const file = path.join(CACHE_DIR, `${key}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    // If maxAgeMs is provided AND we are in a background refresh context (flagged by Infinity),
    // skip TTL check — always serve stale-while-revalidate style.
    if (maxAgeMs && maxAgeMs !== Infinity && (Date.now() - data.timestamp > maxAgeMs)) return null;
    return data.value;
  } catch (e) {
    return null;
  }
}

function getCacheWithMeta(key) {
  const file = path.join(CACHE_DIR, `${key}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function setCache(key, value) {
  const file = path.join(CACHE_DIR, `${key}.json`);
  fs.writeFileSync(file, JSON.stringify({ timestamp: Date.now(), value }));
}

// ==================== API Endpoints ====================

// API: Get daily buyback details (derived from buyback_daily_all cache)
// Supports ?days=3|5|10|20 to control trading day range. Includes zero-buyback days.
// No neodata API calls — pure in-memory derivation from cached data. Sub-millisecond.
app.get('/api/buyback-daily', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 20;
    const validDays = [3, 5, 10, 20].includes(days) ? days : 20;

    const cacheKey = 'buyback_daily_' + validDays + 'd';
    const cached = getCache(cacheKey, Infinity);
    if (cached) return res.json(cached);

    // Derive from buyback_daily_all cache (always available, maintained by warm job)
    const buybackAll = getCache('buyback_daily_all', Infinity);
    const tradingDays = getLastNTradingDays(validDays);

    const results = {};
    for (const [code, info] of Object.entries(COMPANIES)) {
      const allDailyBuybacks = (buybackAll && buybackAll[code] && buybackAll[code].dailyBuybacks) || [];

      // Build lookup map: date -> buyback item
      const buybackMap = {};
      for (const item of allDailyBuybacks) {
        buybackMap[item.date] = item;
      }

      // Build tradingDays array with zero-fill for no-buyback days
      const tradingDayEntries = tradingDays.map(date => ({
        date,
        buyback: buybackMap[date] || null,
      }));

      const daysWithBuyback = tradingDayEntries.filter(e => e.buyback !== null);
      const totalShares = daysWithBuyback.reduce((s, e) => s + e.buyback.shares, 0);
      const totalAmount = daysWithBuyback.reduce((s, e) => s + e.buyback.amount, 0);

      results[code] = {
        name: info.name,
        code: info.code,
        dailyBuybacks: allDailyBuybacks,
        tradingDays: tradingDayEntries,
        totalShares,
        totalAmount,
        totalDays: daysWithBuyback.length,
        dateRange: { start: tradingDays[tradingDays.length - 1], end: tradingDays[0] },
        dataSource: allDailyBuybacks.length > 0 ? (allDailyBuybacks[0]?.source || 'structured') : 'none',
        lastUpdate: new Date().toISOString(),
      };
    }

    setCache(cacheKey, results);
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Get buyback notices for all companies
app.get('/api/buyback', async (req, res) => {
  try {
    const cacheKey = 'buyback_all';
    const cached = getCache(cacheKey, Infinity); // always serve cache; cron updates it
    if (cached) return res.json(cached);

    const results = {};
    for (const [code, info] of Object.entries(COMPANIES)) {
      try {
        const output = await callWestock(['notice', code]);
        const { notices } = parseNoticeTable(output, code);
        const buybackNotices = filterBuybackNotices(notices);
        results[code] = {
          name: info.name,
          code: info.code,
          buybackNotices: buybackNotices.slice(0, 20),
          lastUpdate: new Date().toISOString(),
        };
      } catch (e) {
        results[code] = { name: info.name, code: info.code, buybackNotices: [], error: e.message };
      }
    }

    setCache(cacheKey, results);
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Get dividend data
app.get('/api/dividend', async (req, res) => {
  try {
    const cacheKey = 'dividend_all';
    const cached = getCache(cacheKey, Infinity); // always serve cache; cron updates it
    if (cached) return res.json(cached);

    const results = {};
    for (const [code, info] of Object.entries(COMPANIES)) {
      try {
        const output = await callWestock(['dividend', code, '--years', '5']);
        const { dividends } = parseDividendTable(output);
        results[code] = {
          name: info.name,
          code: info.code,
          dividends,
          lastUpdate: new Date().toISOString(),
        };
      } catch (e) {
        results[code] = { name: info.name, code: info.code, dividends: [], error: e.message };
      }
    }

    setCache(cacheKey, results);
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Get all data at once (notices + dividends + daily buyback)
app.get('/api/all', async (req, res) => {
  try {
    const cacheKey = 'all_data';
    const cached = getCache(cacheKey, Infinity); // always serve cache; cron updates it
    if (cached) return res.json(cached);

    // Get buyback daily data from cache or fetch
    let buybackDailyData = getCache('buyback_daily_all', Infinity);
    if (!buybackDailyData) {
      buybackDailyData = {};
      for (const [code, info] of Object.entries(COMPANIES)) {
        try {
          const neodataResp = await callNeodata(info.neodataQuery, 'all');
          const dailyItems = extractBuybackFromNeodata(neodataResp, code);
          buybackDailyData[code] = {
            name: info.name,
            code: info.code,
            dailyBuybacks: dailyItems,
            totalShares: dailyItems.reduce((s, i) => s + i.shares, 0),
            totalAmount: dailyItems.reduce((s, i) => s + i.amount, 0),
            totalDays: dailyItems.length,
            dataSource: dailyItems.length > 0 ? (dailyItems[0]?.source || 'structured') : 'none',
          };
        } catch (e) {
          buybackDailyData[code] = {
            name: info.name,
            code: info.code,
            dailyBuybacks: [],
            totalShares: 0,
            totalAmount: 0,
            totalDays: 0,
            dataSource: 'error',
            error: e.message,
          };
        }
      }
      setCache('buyback_daily_all', buybackDailyData);
    }

    const results = {};
    for (const [code, info] of Object.entries(COMPANIES)) {
      try {
        const [noticeOutput, divOutput] = await Promise.all([
          callWestock(['notice', code]),
          callWestock(['dividend', code, '--years', '5']),
        ]);

        const { notices } = parseNoticeTable(noticeOutput, code);
        const buybackNotices = filterBuybackNotices(notices);
        const { dividends } = parseDividendTable(divOutput);

        results[code] = {
          name: info.name,
          code: info.code,
          buybackNotices: buybackNotices.slice(0, 20),
          dividends,
          dailyBuybacks: (buybackDailyData[code] && buybackDailyData[code].dailyBuybacks) || [],
          lastUpdate: new Date().toISOString(),
        };
      } catch (e) {
        results[code] = {
          name: info.name,
          code: info.code,
          buybackNotices: [],
          dividends: [],
          dailyBuybacks: (buybackDailyData[code] && buybackDailyData[code].dailyBuybacks) || [],
          error: e.message,
        };
      }
    }

    setCache(cacheKey, results);
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Refresh cache (non-blocking incremental update)
// Clears only the derived keys so cron/warm can rebuild them; raw data files are preserved.
app.post('/api/refresh', async (req, res) => {
  try {
    // Only remove derived cache files (all_data, buyback_daily_Nd, buyback_daily_all)
    // so they get regenerated on next cron run without wiping raw buyback history.
    const toRemove = ['all_data', 'buyback_daily_3d', 'buyback_daily_5d', 'buyback_daily_10d', 'buyback_daily_20d', 'buyback_daily_all', 'buyback_all', 'dividend_all'];
    let removed = 0;
    for (const key of toRemove) {
      const file = path.join(CACHE_DIR, `${key}.json`);
      if (fs.existsSync(file)) { fs.unlinkSync(file); removed++; }
    }
    res.json({ success: true, message: `Cache cleared (${removed} files). Data will be refreshed on next cron run.` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Incremental Warm Update ====================
// Called by cron warm-cache.sh. Fetches latest data from APIs and merges with existing cache.
// Strategy:
//   - buyback_daily_all: merge new records by date (new dates added, existing dates preserved)
//   - all_data: rebuilt from merged buyback data + fresh notices/dividends
//   - buyback_daily_Nd: invalidated so next user request rebuilds from merged dailyBuybacks
app.post('/api/warm', async (req, res) => {
  const log = [];
  const ts = () => new Date().toISOString();

  try {
    // ---- Step 1: Fetch latest buyback records from neodata ----
    log.push(`[${ts()}] Starting incremental warm update...`);

    const existingRaw = getCacheWithMeta('buyback_daily_all');
    const existingData = existingRaw ? existingRaw.value : {};

    const freshData = {};
    for (const [code, info] of Object.entries(COMPANIES)) {
      try {
        const neodataResp = await callNeodata(info.neodataQuery, 'all');
        const freshItems = extractBuybackFromNeodata(neodataResp, code);

        // Merge: build map from existing, then upsert fresh records
        const existingItems = (existingData[code] && existingData[code].dailyBuybacks) || [];
        const mergedMap = {};
        for (const item of existingItems) mergedMap[item.date] = item;
        let newCount = 0;
        for (const item of freshItems) {
          if (!mergedMap[item.date]) newCount++;
          mergedMap[item.date] = item; // fresh data wins for same date
        }
        const mergedItems = Object.values(mergedMap).sort((a, b) => b.date.localeCompare(a.date));

        freshData[code] = {
          name: info.name,
          code: info.code,
          dailyBuybacks: mergedItems,
          totalShares: mergedItems.reduce((s, i) => s + i.shares, 0),
          totalAmount: mergedItems.reduce((s, i) => s + i.amount, 0),
          totalDays: mergedItems.length,
          dataSource: mergedItems.length > 0 ? (mergedItems[0]?.source || 'structured') : 'none',
        };
        log.push(`[${ts()}] ${info.name}: ${mergedItems.length} total records (${newCount} new)`);
      } catch (e) {
        // On error, keep existing data untouched
        freshData[code] = existingData[code] || {
          name: info.name, code: info.code, dailyBuybacks: [],
          totalShares: 0, totalAmount: 0, totalDays: 0, dataSource: 'error', error: e.message,
        };
        log.push(`[${ts()}] ${info.name}: ERROR - ${e.message}, keeping existing data`);
      }
    }
    // Safety check: if ALL companies returned 0 records (likely token expired), keep old data
    const totalNewRecords = Object.values(freshData).reduce((s, c) => s + c.dailyBuybacks.length, 0);
    if (totalNewRecords === 0 && existingRaw) {
      log.push(`[${ts()}] WARNING: All companies returned 0 records (likely auth issue). Keeping existing buyback_daily_all cache unchanged.`);
      // Keep existing data, don't overwrite with empty
      for (const [code, info] of Object.entries(COMPANIES)) {
        if (existingData[code]) {
          freshData[code] = existingData[code];
        }
      }
    }
    setCache('buyback_daily_all', freshData);
    log.push(`[${ts()}] buyback_daily_all cache updated (${totalNewRecords} total records)`);

    // ---- Step 2: Rebuild all_data with fresh notices + dividends + merged buybacks ----
    const allResults = {};
    for (const [code, info] of Object.entries(COMPANIES)) {
      try {
        const [noticeOutput, divOutput] = await Promise.all([
          callWestock(['notice', code]),
          callWestock(['dividend', code, '--years', '5']),
        ]);
        const { notices } = parseNoticeTable(noticeOutput, code);
        const buybackNotices = filterBuybackNotices(notices);
        const { dividends } = parseDividendTable(divOutput);

        allResults[code] = {
          name: info.name,
          code: info.code,
          buybackNotices: buybackNotices.slice(0, 20),
          dividends,
          dailyBuybacks: freshData[code].dailyBuybacks,
          lastUpdate: new Date().toISOString(),
        };
        log.push(`[${ts()}] ${info.name}: notices + dividends fetched`);
      } catch (e) {
        // Keep existing all_data for this company if westock fails
        const existing = getCacheWithMeta('all_data');
        const existingCompany = existing && existing.value && existing.value[code];
        allResults[code] = existingCompany ? {
          ...existingCompany,
          dailyBuybacks: freshData[code].dailyBuybacks,
          lastUpdate: new Date().toISOString(),
        } : {
          name: info.name, code: info.code,
          buybackNotices: [], dividends: [],
          dailyBuybacks: freshData[code].dailyBuybacks,
          error: e.message, lastUpdate: new Date().toISOString(),
        };
        log.push(`[${ts()}] ${info.name}: westock ERROR - ${e.message}, keeping existing notices/dividends`);
      }
    }
    setCache('all_data', allResults);
    log.push(`[${ts()}] all_data cache updated`);

    // ---- Step 3: Pre-build buyback_daily_Nd caches from fresh data ----
    for (const d of [3, 5, 10, 20]) {
      const ndTradingDays = getLastNTradingDays(d);
      const ndResults = {};
      for (const [ndCode, ndInfo] of Object.entries(COMPANIES)) {
        const allDailyBuybacks = freshData[ndCode].dailyBuybacks;
        const ndBuybackMap = {};
        for (const item of allDailyBuybacks) {
          ndBuybackMap[item.date] = item;
        }
        const ndTradingDayEntries = ndTradingDays.map(date => ({
          date,
          buyback: ndBuybackMap[date] || null,
        }));
        const ndDaysWithBuyback = ndTradingDayEntries.filter(e => e.buyback !== null);
        ndResults[ndCode] = {
          name: ndInfo.name,
          code: ndInfo.code,
          dailyBuybacks: allDailyBuybacks,
          tradingDays: ndTradingDayEntries,
          totalShares: ndDaysWithBuyback.reduce((s, e) => s + e.buyback.shares, 0),
          totalAmount: ndDaysWithBuyback.reduce((s, e) => s + e.buyback.amount, 0),
          totalDays: ndDaysWithBuyback.length,
          dateRange: { start: ndTradingDays[ndTradingDays.length - 1], end: ndTradingDays[0] },
          dataSource: allDailyBuybacks.length > 0 ? (allDailyBuybacks[0]?.source || 'structured') : 'none',
          lastUpdate: new Date().toISOString(),
        };
      }
      setCache('buyback_daily_' + d + 'd', ndResults);
    }
    log.push(`[${ts()}] buyback_daily_Nd caches pre-built (3d/5d/10d/20d)`);
    log.push(`[${ts()}] Warm update complete.`);

    res.json({ success: true, log });
  } catch (e) {
    log.push(`[${ts()}] FATAL ERROR: ${e.message}`);
    res.status(500).json({ success: false, error: e.message, log });
  }
});

// ==================== K线数据 API ====================
// 腾讯财经API港股代码映射
const TENCENT_SYMBOLS = {
  'hk00700': 'hk00700',
  'hk01810': 'hk01810',
  'hk09992': 'hk09992',
};

// 获取K线数据（使用腾讯财经API）
function fetchKlineData(symbol, period = '1y') {
  return new Promise((resolve, reject) => {
    const periodDays = {
      '1m': 30, '3m': 90, '6m': 180,
      '1y': 365, '2y': 730, '5y': 1825
    };
    const days = periodDays[period] || 365;
    const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,${days},qfq`;

    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.code === 0 && json.data && json.data[symbol]) {
            const dayData = json.data[symbol].day || json.data[symbol].qfqday || [];
            const klineData = [];
            const buybackData = [];

            for (const item of dayData) {
              const kline = {
                time: item[0],
                open: parseFloat(item[1]),
                close: parseFloat(item[2]),
                high: parseFloat(item[3]),
                low: parseFloat(item[4]),
                volume: parseFloat(item[5]),
              };
              if (!isNaN(kline.open) && !isNaN(kline.close)) {
                klineData.push(kline);
              }

              // 从HGcontent提取回购信息
              const extra = item[6];
              if (extra && extra.HGcontent) {
                const hg = extra.HGcontent;
                // 格式: "回购172.00万股，均价407.133港元"
                const match = hg.match(/回购([\d.]+)万股.*?均价([\d.]+)港元/);
                if (match) {
                  const sharesWan = parseFloat(match[1]);
                  const avgPrice = parseFloat(match[2]);
                  buybackData.push({
                    time: item[0],
                    sharesWan: sharesWan,
                    shares: Math.round(sharesWan * 10000),
                    avgPrice: avgPrice,
                    amount: Math.round(sharesWan * 10000 * avgPrice),
                  });
                }
              }

              // 从FHcontent提取分红信息
              if (extra && extra.FHcontent) {
                // 暂存，后面解析
              }
            }

            resolve({ kline: klineData, buyback: buybackData });
          } else {
            reject(new Error('Invalid Tencent Finance response'));
          }
        } catch (e) {
          reject(new Error('Failed to parse K-line data: ' + e.message));
        }
      });
    }).on('error', reject);
  });
}

// API: 获取K线数据 + 回购/分红事件标记（优先使用本地缓存）
app.get('/api/kline', async (req, res) => {
  try {
    const code = req.query.code || 'hk00700';
    const period = req.query.period || '1y';

    if (!TENCENT_SYMBOLS[code]) {
      return res.status(400).json({ error: 'Unsupported stock code' });
    }

    // 优先读取预缓存的K线数据（由warm-cache.sh每天更新）
    const cacheKey = `kline_${code}_${period}`;
    const cached = getCache(cacheKey, Infinity); // 无限有效期，由cron更新
    if (cached) return res.json(cached);

    // 如果没有预缓存，实时获取（首次访问或缓存被清除）
    const [klineResult, dividendAll] = await Promise.all([
      fetchKlineData(TENCENT_SYMBOLS[code], period),
      getCache('dividend_all', Infinity),
    ]);

    // 构建回购事件标记（从K线数据中提取）
    const buybackMarkers = klineResult.buyback.map(item => ({
      time: item.time,
      position: 'aboveBar',
      color: '#f59e0b',
      shape: 'arrowUp',
      text: `回购 ${item.sharesWan.toFixed(0)}万股`,
      buyback: item,
    }));

    // 构建分红事件标记
    const dividendMarkers = [];
    if (dividendAll && dividendAll[code] && dividendAll[code].dividends) {
      for (const item of dividendAll[code].dividends) {
        if (item.exDiviDate && item.exDiviDate !== '0') {
          const dateStr = item.exDiviDate;
          const formattedDate = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
          dividendMarkers.push({
            time: formattedDate,
            position: 'belowBar',
            color: '#10b981',
            shape: 'arrowDown',
            text: `分红 HK$${item.cashDivPerShare}`,
            dividend: { cashDivPerShare: item.cashDivPerShare, reportEndDate: item.reportEndDate }
          });
        }
      }
    }

    const result = {
      code,
      name: COMPANIES[code].name,
      kline: klineResult.kline,
      markers: { buyback: buybackMarkers, dividend: dividendMarkers },
      lastUpdate: new Date().toISOString(),
    };

    setCache(cacheKey, result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: 预热K线缓存（由warm-cache.sh调用）
app.post('/api/warm-kline', async (req, res) => {
  const log = [];
  const ts = () => new Date().toISOString();
  const periods = ['1m', '3m', '6m', '1y', '2y', '5y'];

  try {
    log.push(`[${ts()}] Starting K-line cache warm...`);

    for (const [code, symbol] of Object.entries(TENCENT_SYMBOLS)) {
      try {
        // 获取最长周期数据（5年）
        const klineResult = await fetchKlineData(symbol, '5y');

        // 获取分红事件
        const dividendAll = getCache('dividend_all', Infinity);

        // 构建回购事件标记（从K线数据中提取）
        const buybackMarkers = klineResult.buyback.map(item => ({
          time: item.time,
          position: 'aboveBar',
          color: '#f59e0b',
          shape: 'arrowUp',
          text: `回购 ${item.sharesWan.toFixed(0)}万股`,
          buyback: item,
        }));

        // 构建分红事件标记
        const dividendMarkers = [];
        if (dividendAll && dividendAll[code] && dividendAll[code].dividends) {
          for (const item of dividendAll[code].dividends) {
            if (item.exDiviDate && item.exDiviDate !== '0') {
              const dateStr = item.exDiviDate;
              const formattedDate = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
              dividendMarkers.push({
                time: formattedDate,
                position: 'belowBar',
                color: '#10b981',
                shape: 'arrowDown',
                text: `分红 HK$${item.cashDivPerShare}`,
                dividend: { cashDivPerShare: item.cashDivPerShare, reportEndDate: item.reportEndDate }
              });
            }
          }
        }

        // 按周期缓存
        const now = new Date();
        for (const period of periods) {
          const periodDays = { '1m': 30, '3m': 90, '6m': 180, '1y': 365, '2y': 730, '5y': 1825 };
          const days = periodDays[period];
          const cutoffDate = new Date(now - days * 24 * 60 * 60 * 1000);
          const cutoffStr = cutoffDate.toISOString().split('T')[0];

          const filteredKline = klineResult.kline.filter(k => k.time >= cutoffStr);
          const filteredBuyback = buybackMarkers.filter(m => m.time >= cutoffStr);
          const filteredDividend = dividendMarkers.filter(m => m.time >= cutoffStr);

          const result = {
            code,
            name: COMPANIES[code].name,
            kline: filteredKline,
            markers: { buyback: filteredBuyback, dividend: filteredDividend },
            lastUpdate: new Date().toISOString(),
          };

          setCache(`kline_${code}_${period}`, result);
        }

        log.push(`[${ts()}] ${COMPANIES[code].name}: ${klineResult.kline.length} days, ${klineResult.buyback.length} buybacks cached`);
      } catch (e) {
        log.push(`[${ts()}] ${COMPANIES[code].name}: ERROR - ${e.message}`);
      }
    }

    log.push(`[${ts()}] K-line cache warm complete.`);
    res.json({ success: true, log });
  } catch (e) {
    log.push(`[${ts()}] FATAL ERROR: ${e.message}`);
    res.status(500).json({ success: false, error: e.message, log });
  }
});

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    tokenAvailable: !!getNeodataToken(),
    companies: Object.keys(COMPANIES),
  });
});

app.listen(PORT, () => {
  console.log(`Finance Tracker API running on port ${PORT}`);
  console.log(`Tracking: ${Object.values(COMPANIES).map(c => c.name).join(', ')}`);
  console.log(`Neodata token: ${getNeodataToken() ? 'available' : 'NOT AVAILABLE'}`);
});
