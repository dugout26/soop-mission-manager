const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3001;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.js':   'text/javascript',
  '.css':  'text/css',
};

// ===== 네이버 게임 e스포츠 API =====
const LCK_CACHE = {};
const CACHE_TTL = 30 * 60 * 1000; // 30분 캐시

function fetchNaverPage(urlStr) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
    };
    https.get(opts, resp => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function fetchLckFromNaver(year, month) {
  const cacheKey = `${year}-${month}`;
  if (LCK_CACHE[cacheKey] && (Date.now() - LCK_CACHE[cacheKey].ts < CACHE_TTL)) {
    return LCK_CACHE[cacheKey].data;
  }

  const monthStr = String(month).padStart(2, '0');
  const pageUrl = `https://game.naver.com/esports/League_of_Legends/schedule/lck?date=${year}-${monthStr}`;

  const html = await fetchNaverPage(pageUrl);

  // __NEXT_DATA__ JSON 추출
  const match = html.match(/__NEXT_DATA__[^>]*>(\{.*?\})<\/script>/s);
  if (!match) {
    throw new Error('네이버 페이지에서 데이터를 찾을 수 없습니다');
  }

  const nextData = JSON.parse(match[1]);
  const monthSchedule = nextData?.props?.initialState?.schedule?.monthSchedule || [];

  const events = [];
  monthSchedule.forEach(group => {
    const schedules = group.schedules || [];
    schedules.forEach(s => {
      const startTs = s.startDate;
      if (!startTs) return;

      const d = new Date(startTs);
      // UTC+9 (KST) 기준
      const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
      const dateStr = `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}-${String(kst.getUTCDate()).padStart(2, '0')}`;
      const timeStr = `${String(kst.getUTCHours()).padStart(2, '0')}:${String(kst.getUTCMinutes()).padStart(2, '0')}`;

      const home = s.homeTeam || {};
      const away = s.awayTeam || {};

      events.push({
        date: dateStr,
        time: timeStr,
        title: s.title || '',
        homeTeam: {
          name: home.nameAcronym || home.name || '',
          code: home.nameEngAcronym || '',
          logo: home.imageUrl || '',
        },
        awayTeam: {
          name: away.nameAcronym || away.name || '',
          code: away.nameEngAcronym || '',
          logo: away.imageUrl || '',
        },
        homeScore: s.homeScore || 0,
        awayScore: s.awayScore || 0,
        status: s.matchStatus || '',
        label: `${home.nameEngAcronym || home.nameAcronym || '?'} vs ${away.nameEngAcronym || away.nameAcronym || '?'}`,
        blockName: s.title || '',
        weeks: s.weeks || 0,
        days: s.days || 0,
      });
    });
  });

  LCK_CACHE[cacheKey] = { data: events, ts: Date.now() };
  return events;
}

async function handleLckSchedule(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const year = parseInt(url.searchParams.get('year')) || new Date().getFullYear();
  const month = parseInt(url.searchParams.get('month')) || (new Date().getMonth() + 1);

  try {
    const events = await fetchLckFromNaver(year, month);

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ events, year, month }));
  } catch(e) {
    console.error('LCK schedule fetch error:', e.message);
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/lck-schedule')) {
    return handleLckSchedule(req, res);
  }

  const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const file = path.join(__dirname, urlPath);
  const ext = path.extname(file);

  fs.readFile(file, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(500); res.end('Error'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(d2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`MK 캘린더 서버 실행 중: http://localhost:${PORT}`);
});
