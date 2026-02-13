const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// soop-extension을 사용하지 않고 우리의 검색 시스템만 사용
// const { SoopClient, SoopChatEvent } = require('soop-extension');
const { google } = require('googleapis');

const CONFIG = {
  STREAMER_ID: process.env.STREAMER_ID || 'phonics1',
  SOOP_USER_ID: process.env.SOOP_USER_ID || '',
  SOOP_PASSWORD: process.env.SOOP_PASSWORD || '',
  ADMIN_PASSWORD: '',
  PORT: 3000,
};

// 인증
const AUTH_SECRET = crypto.randomBytes(16).toString('hex');
function makeToken(pw) { return crypto.createHmac('sha256', AUTH_SECRET).update(pw).digest('hex'); }
let VALID_TOKEN = '';

function generatePassword() {
  return crypto.randomBytes(3).toString('hex'); // 6자리 랜덤 (예: a3f2b1)
}

function loadOrCreatePassword() {
  const ep = path.join(__dirname, '.env');
  let lines = [];
  try { lines = fs.readFileSync(ep, 'utf-8').split('\n'); } catch(e) {}

  let found = false;
  for (const l of lines) {
    const [k, ...vp] = l.split('=');
    const v = vp.join('=').trim().replace(/^['"]|['"]$/g, '');
    if (k?.trim() === 'ADMIN_PASSWORD' && v) { CONFIG.ADMIN_PASSWORD = v; found = true; }
  }

  if (!found || !CONFIG.ADMIN_PASSWORD) {
    CONFIG.ADMIN_PASSWORD = generatePassword();
    // .env에 저장
    const hasLine = lines.some(l => l.trim().startsWith('ADMIN_PASSWORD'));
    if (hasLine) {
      lines = lines.map(l => l.trim().startsWith('ADMIN_PASSWORD') ? `ADMIN_PASSWORD=${CONFIG.ADMIN_PASSWORD}` : l);
    } else {
      lines.push(`\n# 대시보드 접속 비밀번호 (자동생성)`);
      lines.push(`ADMIN_PASSWORD=${CONFIG.ADMIN_PASSWORD}`);
    }
    fs.writeFileSync(ep, lines.join('\n'));
  }
  VALID_TOKEN = makeToken(CONFIG.ADMIN_PASSWORD);
}

function savePassword(newPw) {
  CONFIG.ADMIN_PASSWORD = newPw;
  VALID_TOKEN = makeToken(newPw);
  const ep = path.join(__dirname, '.env');
  let lines = [];
  try { lines = fs.readFileSync(ep, 'utf-8').split('\n'); } catch(e) {}
  const hasLine = lines.some(l => l.trim().startsWith('ADMIN_PASSWORD'));
  if (hasLine) {
    lines = lines.map(l => l.trim().startsWith('ADMIN_PASSWORD') ? `ADMIN_PASSWORD=${newPw}` : l);
  } else {
    lines.push(`ADMIN_PASSWORD=${newPw}`);
  }
  fs.writeFileSync(ep, lines.join('\n'));
}

// ============================================
// 상태
// ============================================
let missionTemplates = [];   // 미션 틀
let missionResults = [];     // 매칭된 결과
let autoThreshold = 0;       // 이 값 이상이면 템플릿 없어도 자동등록 (0=비활성)
let connectionStatus = 'disconnected';
let soopChat = null;
let reconnectTimer = null;
let sseClients = [];
let unknownPackets = [];
let recentDonors = {};  // userId → { timestamp, resultId, nick, amount } (0018 후 0005 연결용)

// 중복 패킷 방지 (SOOP은 같은 패킷을 3번 보냄)
const seenPackets = new Set();
function isDuplicate(key) {
  if (seenPackets.has(key)) return true;
  seenPackets.add(key);
  setTimeout(() => seenPackets.delete(key), 5000);
  return false;
}

const KNOWN_TYPES = new Set([
  '0000','0001','0002','0004','0005','0007','0012',
  '0018','0087','0093','0104','0109','0105','0127'
]);

// SOOP 채팅 userId에서 세션번호 제거 (예: maxmp7011(2) → maxmp7011)
function normalizeUid(uid) {
  return uid ? uid.replace(/\(\d+\)$/, '') : '';
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter(res => {
    try { res.write(msg); return true; } catch(e) { return false; }
  });
}

// ============================================
// 별풍선 → 미션 매칭
// ============================================
function matchBalloon(userId, userNickname, amount, eventType) {
  const channelUrl = `https://ch.sooplive.co.kr/${userId}`;

  // 1) 템플릿 매칭: 정확한 금액 + 타입 일치
  const matched = missionTemplates.find(t => t.active && amount === t.starCount && (!t.eventType || t.eventType === 'all' || t.eventType === eventType));

  // 2) 자동등록 임계값 체크
  const autoMatch = !matched && autoThreshold > 0 && amount >= autoThreshold;

  if (!matched && !autoMatch) return null;

  const result = {
    id: Date.now() + Math.random(),
    templateId: matched ? matched.id : null,
    templateName: matched ? matched.name : `${amount}개 자동등록`,
    starCount: matched ? matched.starCount : autoThreshold,
    userId, userNickname,
    channelUrl: matched ? (matched.collectDomain ? channelUrl : null) : channelUrl,
    message: matched ? (matched.collectMessage ? '' : null) : '',
    amount, eventType,
    completed: false,
    createdAt: now(),
    timestamp: Date.now(),
    collectDomain: matched ? matched.collectDomain : true,
    collectMessage: matched ? matched.collectMessage : true,
    isAutoThreshold: autoMatch,
    category: matched ? matched.category : '일반',
  };

  missionResults.unshift(result);
  broadcast('result', result);
  const label = matched ? matched.name : '자동등록';
  console.log(`🎯 [${label}] ${userNickname}(${userId}) ${amount}개 [${eventType}]`);
  return result;
}

// ============================================
// 0121 패킷 파싱 시도 (도전/대결미션 추정)
// ============================================
function parse0121(rawStr) {
  try {
    // 0121 패킷은 JSON이 포함되어 있음
    const jsonStart = rawStr.indexOf('{');
    const jsonEnd = rawStr.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      const jsonStr = rawStr.substring(jsonStart, jsonEnd + 1);
      const data = JSON.parse(jsonStr);
      console.log(`🎲 0121 패킷 파싱 성공:`, JSON.stringify(data, null, 2));

      // GIFT 타입이면 대결/도전미션 후원
      if (data.type === 'GIFT') {
        const amt = parseInt(data.gift_count) || 0;
        const uid = data.user_id || '';
        const nick = data.user_nick || '';
        const title = data.title || '';

        console.log(`🎯 대결미션 감지! [${title}] ${nick}(${uid}) → ${amt}개`);

        // 실시간 로그에 별풍선으로 표시
        broadcast('balloon', {
          userId: uid,
          userNickname: nick,
          amount: amt,
          channelUrl: `https://ch.sooplive.co.kr/${uid}`,
          time: now(),
          type: 'mission',
          missionTitle: title,
        });

        // 미션 매칭 시스템에 연동
        const result = matchBalloon(uid, nick, amt, 'mission');

        // 이 유저의 다음 채팅을 메시지로 연결 (대결미션은 별풍 후 직접 타이핑)
        recentDonors[uid] = { timestamp: Date.now(), resultId: result?.id || null, nick, amount: amt };
        setTimeout(() => { delete recentDonors[uid]; }, 60000);

        const entry = {
          time: now(),
          typeCode: '0121',
          eventType: 'mission',
          data: data,
          raw: rawStr.substring(0, 300),
        };
        broadcast('missionPacket', entry);

        // 로그
        const logLine = `[${new Date().toISOString()}] MISSION_GIFT: ${JSON.stringify(data)}\n`;
        fs.appendFile(path.join(__dirname, 'mission_packets.log'), logLine, () => {});
      }
      return data;
    }
  } catch(e) {
    console.log(`🎲 0121 파싱 실패: ${e.message}`);
  }
  return null;
}

// ============================================
// SOOP 연결 (현재 비활성화 - 검색 기능만 사용)
// ============================================
async function connectToSoop() {
  console.log(`🔌 SOOP 채팅 연결 기능은 현재 비활성화됨. 검색 기능만 사용 가능.`);
  connectionStatus = 'search_only';
  broadcast('status', { status: connectionStatus, streamerId: CONFIG.STREAMER_ID });
  return;

  /*
  // 기존 SOOP 연결 코드 (soop-extension 필요)
  if (!CONFIG.STREAMER_ID) { connectionStatus = 'no_config'; broadcast('status', { status: connectionStatus }); return; }
  try {
    connectionStatus = 'connecting'; broadcast('status', { status: connectionStatus });
    console.log(`🔌 [${CONFIG.STREAMER_ID}] 연결 중...`);

    const client = new SoopClient();
    const opts = { streamerId: CONFIG.STREAMER_ID, client };
    if (CONFIG.SOOP_USER_ID && CONFIG.SOOP_PASSWORD) {
      opts.login = { userId: CONFIG.SOOP_USER_ID, password: CONFIG.SOOP_PASSWORD };
    }

    soopChat = client.chat(opts);

  */
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connectToSoop(), 10000);
}

function now() { return new Date().toLocaleTimeString('ko-KR', { hour:'2-digit', minute:'2-digit', second:'2-digit' }); }

// SOOP 프로필 이미지 URL 생성 함수
function getSOOPProfileImage(streamerId) {
  // SOOP 프로필 이미지 URL 패턴: https://stimg.sooplive.co.kr/LOGO/{first_2_chars}/{streamer_id}/{streamer_id}.jpg
  const prefix = streamerId.substring(0, 2).toLowerCase();
  const imageUrl = `https://stimg.sooplive.co.kr/LOGO/${prefix}/${streamerId}/${streamerId}.jpg`;

  // 폴백 이미지 (이미지가 없을 경우)
  return imageUrl;
}

// SOOP BJ 검색 API (sch.sooplive.co.kr)
async function searchSOOPStreamers(query) {
  const https = require('https');
  return new Promise((resolve) => {
    const url = `https://sch.sooplive.co.kr/api.php?m=bjSearch&v=1.0&szKeyword=${encodeURIComponent(query)}&nPageNo=1&nLimit=30`;
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.sooplive.co.kr/'
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.DATA && json.DATA.length > 0) {
            resolve(json.DATA
              .filter(d => (parseInt(d.favorite_cnt) || 0) >= 1000)
              .map(d => ({
                id: d.user_id,
                name: d.user_nick,
                profileImage: d.station_logo || getSOOPProfileImage(d.user_id),
                channelUrl: `https://ch.sooplive.co.kr/${d.user_id}`,
                favorite_cnt: d.favorite_cnt || 0
              })));
          } else {
            resolve([]);
          }
        } catch(e) {
          console.error('SOOP bjSearch 파싱 실패:', e);
          resolve([]);
        }
      });
    }).on('error', (e) => {
      console.error('SOOP bjSearch 요청 실패:', e);
      resolve([]);
    });
  });
}

// ============================================
// HTTP 서버
// ============================================
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${CONFIG.PORT}`);

  // 성능 최적화 헤더
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); // 캐시 비활성화
  res.setHeader('Connection', 'keep-alive');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  const body = () => new Promise(r => { let b=''; req.on('data',c=>b+=c); req.on('end',()=>r(JSON.parse(b||'{}'))); });
  const json = (d, c=200) => { res.writeHead(c, {'Content-Type':'application/json'}); res.end(JSON.stringify(d)); };
  const authOk = () => req.headers['x-auth'] === VALID_TOKEN;

  // 인증
  if (url.pathname === '/api/auth' && req.method === 'POST') {
    body().then(d => {
      if (d.password === CONFIG.ADMIN_PASSWORD) {
        json({ ok: true, token: VALID_TOKEN });
      } else {
        json({ ok: false, error: '비밀번호가 틀렸습니다' }, 401);
      }
    }); return;
  }
  // 비밀번호 변경
  if (url.pathname === '/api/change-password' && req.method === 'POST') {
    if (!authOk()) return json({ ok: false, error: '인증 필요' }, 401);
    body().then(d => {
      if (!d.newPassword || d.newPassword.length < 4) return json({ ok: false, error: '4자 이상 입력' }, 400);
      savePassword(d.newPassword);
      json({ ok: true, token: VALID_TOKEN });
      console.log(`🔑 비밀번호 변경됨: ${d.newPassword}`);
    }); return;
  }

  // SSE
  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive' });
    res.write(`event: status\ndata: ${JSON.stringify({status:connectionStatus,streamerId:CONFIG.STREAMER_ID})}\n\n`);
    res.write(`event: templates\ndata: ${JSON.stringify(missionTemplates)}\n\n`);
    res.write(`event: autoThreshold\ndata: ${JSON.stringify({value:autoThreshold})}\n\n`);
    missionResults.forEach(r => res.write(`event: result\ndata: ${JSON.stringify(r)}\n\n`));
    sseClients.push(res);
    req.on('close', () => { sseClients = sseClients.filter(c=>c!==res); });
    return;
  }

  // 인증 필요한 API들
  const needsAuth = ['/api/templates','/api/templates/update','/api/templates/delete','/api/templates/toggle','/api/auto-threshold','/api/results/reset','/api/config','/api/reconnect','/api/export-sheets'];
  if (needsAuth.includes(url.pathname) && req.method === 'POST' && !authOk()) {
    return json({ ok: false, error: '인증 필요' }, 401);
  }

  // 템플릿
  if (url.pathname === '/api/templates' && req.method === 'POST') {
    body().then(d => {
      const t = { id: Date.now(), name: d.name||'미션', starCount: parseInt(d.starCount)||500, eventType: d.eventType||'all', collectDomain: d.collectDomain!==false, collectMessage: d.collectMessage===true, active: true, category: d.category||'일반' };
      missionTemplates.push(t);
      missionTemplates.sort((a,b) => b.starCount - a.starCount);
      broadcast('templates', missionTemplates); json({ok:true});
    }); return;
  }
  if (url.pathname === '/api/templates/update' && req.method === 'POST') {
    body().then(d => {
      const t = missionTemplates.find(t=>t.id==d.id);
      if(t) {
        if(d.name!==undefined) t.name=d.name;
        if(d.starCount!==undefined) t.starCount=parseInt(d.starCount)||t.starCount;
        if(d.eventType!==undefined) t.eventType=d.eventType;
        if(d.collectDomain!==undefined) t.collectDomain=d.collectDomain;
        if(d.collectMessage!==undefined) t.collectMessage=d.collectMessage;
        if(d.category!==undefined) t.category=d.category;
        missionTemplates.sort((a,b)=>b.starCount-a.starCount);
      }
      broadcast('templates', missionTemplates); json({ok:true});
    }); return;
  }
  if (url.pathname === '/api/templates/delete' && req.method === 'POST') {
    body().then(d => { missionTemplates=missionTemplates.filter(t=>t.id!=d.id); broadcast('templates', missionTemplates); json({ok:true}); }); return;
  }
  if (url.pathname === '/api/templates/toggle' && req.method === 'POST') {
    body().then(d => { const t=missionTemplates.find(t=>t.id==d.id); if(t) t.active=!t.active; broadcast('templates', missionTemplates); json({ok:true}); }); return;
  }

  // 자동등록 임계값
  if (url.pathname === '/api/auto-threshold' && req.method === 'POST') {
    body().then(d => {
      autoThreshold = parseInt(d.value) || 0;
      broadcast('autoThreshold', {value: autoThreshold});
      console.log(`⚡ 자동등록 임계값: ${autoThreshold > 0 ? autoThreshold+'개 이상' : '비활성'}`);
      json({ok:true});
    }); return;
  }

  // 결과
  if (url.pathname === '/api/results/toggle' && req.method === 'POST') {
    body().then(d => { const r=missionResults.find(r=>r.id==d.id); if(r){r.completed=!r.completed; broadcast('resultUpdate',r);} json({ok:true}); }); return;
  }
  if (url.pathname === '/api/results/delete' && req.method === 'POST') {
    body().then(d => { missionResults=missionResults.filter(r=>r.id!=d.id); broadcast('resultDelete',{id:d.id}); json({ok:true}); }); return;
  }
  if (url.pathname === '/api/results/memo' && req.method === 'POST') {
    body().then(d => { const r=missionResults.find(r=>r.id==d.id); if(r){r.message=d.message; broadcast('resultUpdate',r);} json({ok:true}); }); return;
  }
  if (url.pathname === '/api/results/reset' && req.method === 'POST') {
    missionResults=[]; broadcast('resetResults',{}); return json({ok:true});
  }

  // 결과 필터링
  if (url.pathname === '/api/results/filter' && req.method === 'GET') {
    const category = url.searchParams.get('category');
    let filteredResults = missionResults;
    if (category && category !== '전체') {
      filteredResults = missionResults.filter(r => r.category === category);
    }
    return json({ results: filteredResults, categories: [...new Set(missionResults.map(r => r.category))] });
  }

  // 설정
  if (url.pathname === '/api/config' && req.method === 'GET') return json({streamerId:CONFIG.STREAMER_ID, autoThreshold});
  if (url.pathname === '/api/config' && req.method === 'POST') {
    body().then(async d => {
      if(d.streamerId!==undefined){
        CONFIG.STREAMER_ID=d.streamerId;
        if(soopChat){try{await soopChat.disconnect();}catch(e){}}
        if(d.streamerId) connectToSoop();
      }
      json({ok:true});
    }); return;
  }
  if (url.pathname === '/api/reconnect' && req.method === 'POST') {
    if(soopChat){try{soopChat.disconnect();}catch(e){}} connectToSoop(); return json({ok:true});
  }

  // SOOP 방송 상태 확인 API (여러 BJ 한번에)
  if (url.pathname === '/api/live-status' && req.method === 'POST') {
    body().then(async (reqData) => {
      const bids = reqData.bids || [];
      if(!bids.length) return json({ results: {} });
      const https = require('https');
      const results = {};
      await Promise.all(bids.map(bid => new Promise(resolve => {
        const postData = `bid=${encodeURIComponent(bid)}`;
        const req2 = https.request({
          hostname: 'live.sooplive.co.kr',
          path: '/afreeca/player_live_api.php',
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData),
            'User-Agent': 'Mozilla/5.0',
            'Referer': `https://play.sooplive.co.kr/${bid}`
          }
        }, (res2) => {
          let data = '';
          res2.on('data', c => data += c);
          res2.on('end', () => {
            try {
              const j = JSON.parse(data);
              const ch = j.CHANNEL || {};
              results[bid] = { live: ch.RESULT === 1, bno: ch.BNO || '', title: ch.TITLE || '' };
            } catch(e) { results[bid] = { live: false }; }
            resolve();
          });
        });
        req2.on('error', () => { results[bid] = { live: false }; resolve(); });
        req2.write(postData);
        req2.end();
      })));
      json({ results });
    });
    return;
  }

  // SOOP 스트리머 검색 API
  if (url.pathname === '/api/search-streamer' && req.method === 'GET') {
    const query = url.searchParams.get('q');
    if (!query || query.length < 1) return json({ streamers: [] });

    // Promise 체인 방식
    searchSOOPStreamers(query)
      .then(searchResults => {
        return json({ streamers: searchResults });
      })
      .catch(e => {
        console.error('SOOP 검색 API 실패:', e);
        console.log(`모든 SOOP 검색 방법 실패. 쿼리: "${query}"`);
        return json({ streamers: [], error: 'SOOP 검색 서버 연결 실패' });
      });
    return; // 여기서 끝
  }

  // Google Sheets 추출 (직접 API)
  if (url.pathname === '/api/export-sheets' && req.method === 'POST') {
    if (!authOk()) return json({ ok: false, error: '인증 필요' }, 401);
    if (!missionResults.length) return json({ ok: false, error: '추출할 데이터가 없습니다' }, 400);
    body().then(async (reqData) => {
      const filterCategory = reqData.category;
      let dataToExport = missionResults;
      if (filterCategory && filterCategory !== '전체') {
        dataToExport = missionResults.filter(r => r.category === filterCategory);
      }
      try {
        const auth = new google.auth.GoogleAuth({
          scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
        });
        const sheets = google.sheets({ version: 'v4', auth });

        const typeName = {balloon:'별풍선',adballoon:'애드벌룬',video:'영상풍선',mission:'대결미션'};
        const d = new Date();
        const dateStr = `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        const categoryFilter = filterCategory && filterCategory !== '전체' ? `_${filterCategory}` : '';
        const title = `MK미션${categoryFilter}_${dateStr}`;
        const header = ['카테고리','미션명','타입','개수','닉네임','유저ID','방송국링크','메시지','상태','시간','확인'];
        const rows = dataToExport.map(r => ([
          r.category||'일반', r.templateName||'', typeName[r.eventType||'balloon']||'', r.amount||0,
          r.userNickname||'', r.userId||'',
          r.channelUrl||'', r.message||'',
          r.completed?'완료':'진행중', r.createdAt||'',
          r.completed?true:false  // 확인 열에 체크박스 초기값 설정
        ]));

        // 1) 새 스프레드시트 생성
        const ss = await sheets.spreadsheets.create({
          requestBody: {
            properties: { title },
            sheets: [{ properties: { sheetId: 0, title: '미션 결과', gridProperties: { frozenRowCount: 1 } } }],
          },
        });
        const ssId = ss.data.spreadsheetId;
        const ssUrl = ss.data.spreadsheetUrl;
        console.log(`📊 스프레드시트 생성: ${title} → ${ssUrl}`);

        // 2) 데이터 입력
        await sheets.spreadsheets.values.update({
          spreadsheetId: ssId,
          range: '미션 결과!A1',
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [header, ...rows] },
        });

        // 3) 모든 사용자에게 편집 권한 부여
        const drive = google.drive({ version: 'v3', auth });
        await drive.permissions.create({
          fileId: ssId,
          requestBody: {
            role: 'writer',
            type: 'anyone'
          },
        });
        console.log(`🔓 스프레드시트 권한 설정: 모든 사용자 편집 가능`);

        // 4) 서식 (헤더 색상, 체크박스, 열 너비, 링크 색)
        const reqs = [
          // 헤더 배경색 + 흰 글씨 + 볼드
          { repeatCell: { range: { sheetId:0, startRowIndex:0, endRowIndex:1 }, cell: { userEnteredFormat: { backgroundColor:{red:.18,green:.49,blue:.2}, textFormat:{bold:true,foregroundColor:{red:1,green:1,blue:1}}, horizontalAlignment:'CENTER' } }, fields:'userEnteredFormat' } },
          // 확인 열 체크박스 (K열 = index 10, 카테고리 추가로 1 증가)
          { repeatCell: { range: { sheetId:0, startRowIndex:1, endRowIndex:rows.length+1, startColumnIndex:10, endColumnIndex:11 }, cell: { dataValidation: { condition: { type:'BOOLEAN' } } }, fields:'dataValidation' } },
          // 열 너비 자동
          { autoResizeDimensions: { dimensions: { sheetId:0, dimension:'COLUMNS', startIndex:0, endIndex:11 } } },
        ];

        // 상태 열 색상 (I열 = index 8, 카테고리 추가로 1 증가)
        rows.forEach((r, i) => {
          const color = r[8]==='완료' ? {red:.83,green:.18,blue:.18} : {red:.18,green:.49,blue:.2};
          reqs.push({ repeatCell: { range:{ sheetId:0, startRowIndex:i+1, endRowIndex:i+2, startColumnIndex:8, endColumnIndex:9 }, cell:{ userEnteredFormat:{ textFormat:{ bold:true, foregroundColor:color } } }, fields:'userEnteredFormat.textFormat' } });
        });

        // 방송국 링크 열 파란색 (G열 = index 6, 카테고리 추가로 1 증가)
        if (rows.length > 0) {
          reqs.push({ repeatCell: { range:{ sheetId:0, startRowIndex:1, endRowIndex:rows.length+1, startColumnIndex:6, endColumnIndex:7 }, cell:{ userEnteredFormat:{ textFormat:{ foregroundColor:{red:.1,green:.45,blue:.91} } } }, fields:'userEnteredFormat.textFormat.foregroundColor' } });
        }

        await sheets.spreadsheets.batchUpdate({ spreadsheetId: ssId, requestBody: { requests: reqs } });

        // 5) Google Apps Script 추가 (H열과 J열 동기화)
        const script = google.script({ version: 'v1', auth });
        try {
          // Apps Script 프로젝트 생성
          const scriptProject = await script.projects.create({
            requestBody: {
              title: `MK미션_스크립트_${Date.now()}`,
              parentId: ssId
            }
          });

          // 동기화 스크립트 코드 (카테고리 추가로 열 인덱스 1씩 증가)
          const scriptCode = `
function onEdit(e) {
  const sheet = e.source.getActiveSheet();
  const range = e.range;
  const row = range.getRow();
  const col = range.getColumn();

  // 헤더 행은 제외
  if (row <= 1) return;

  // I열(상태) 변경 시 K열(확인) 업데이트 (카테고리 추가로 1 증가)
  if (col === 9) { // I열
    const statusValue = range.getValue();
    const checkCell = sheet.getRange(row, 11); // K열

    if (statusValue === '완료') {
      checkCell.setValue(true);
    } else if (statusValue === '진행중') {
      checkCell.setValue(false);
    }
  }

  // K열(확인) 변경 시 I열(상태) 업데이트 (카테고리 추가로 1 증가)
  if (col === 11) { // K열
    const checkValue = range.getValue();
    const statusCell = sheet.getRange(row, 9); // I열

    if (checkValue === true) {
      statusCell.setValue('완료');
    } else if (checkValue === false) {
      statusCell.setValue('진행중');
    }
  }
}`;

          // 스크립트 파일 업데이트
          await script.projects.updateContent({
            scriptId: scriptProject.data.scriptId,
            requestBody: {
              files: [
                {
                  name: 'Code',
                  type: 'SERVER_JS',
                  source: scriptCode
                }
              ]
            }
          });

          console.log(`📜 Apps Script 동기화 스크립트 추가 완료`);
        } catch(scriptError) {
          console.log(`⚠️ Apps Script 추가 실패 (권한 문제일 수 있음): ${scriptError.message}`);
        }

        json({ ok: true, url: ssUrl });
      } catch(e) {
        console.error(`📊 Sheets 오류:`, e.message);
        if (e.message.includes('insufficient') || e.message.includes('scope') || e.message.includes('auth')) {
          json({ ok: false, error: '인증 갱신 필요: 터미널에서 gcloud auth application-default login --scopes=https://www.googleapis.com/auth/spreadsheets,https://www.googleapis.com/auth/drive 실행' });
        } else {
          json({ ok: false, error: e.message });
        }
      }
    }); return;
  }

  // 아이콘
  if (url.pathname === '/icon.png') {
    fs.readFile(path.join(__dirname, 'icon.png'), (e, d) => {
      if(e){res.writeHead(404);res.end('not found');return;}
      res.writeHead(200,{'Content-Type':'image/png'}); res.end(d);
    }); return;
  }

  // 메인 대시보드
  if (url.pathname === '/' || url.pathname === '/index.html') {
    fs.readFile(path.join(__dirname, 'main-dashboard.html'), (e, d) => {
      if(e){res.writeHead(500);res.end('err');return;}
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); res.end(d);
    }); return;
  }

  // 미션매니저 대시보드
  if (url.pathname === '/mission' || url.pathname === '/dashboard.html') {
    fs.readFile(path.join(__dirname, 'dashboard.html'), (e, d) => {
      if(e){res.writeHead(500);res.end('err');return;}
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); res.end(d);
    }); return;
  }

  json({error:'Not Found'}, 404);
});

// ============================================
// 시작
// ============================================
server.listen(CONFIG.PORT, () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║   ⚔  MK 대결미션 매니저 v4.0            ║`);
  console.log(`╠══════════════════════════════════════════╣`);
  console.log(`║   대시보드: http://localhost:${CONFIG.PORT}        ║`);
  console.log(`║   스트리머: phonics1                     ║`);
  console.log(`║   🔍 패킷 로그 → unknown_packets.log    ║`);
  console.log(`║   🎲 미션 로그 → mission_packets.log    ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);

  try {
    const ep = path.join(__dirname, '.env');
    if (fs.existsSync(ep)) fs.readFileSync(ep,'utf-8').split('\n').forEach(l => {
      const [k,...vp]=l.split('='); const v=vp.join('=').trim().replace(/^['"]|['"]$/g,'');
      if(k?.trim()==='STREAMER_ID'&&!CONFIG.STREAMER_ID) CONFIG.STREAMER_ID=v;
      if(k?.trim()==='SOOP_USER_ID'&&!CONFIG.SOOP_USER_ID) CONFIG.SOOP_USER_ID=v;
      if(k?.trim()==='SOOP_PASSWORD'&&!CONFIG.SOOP_PASSWORD) CONFIG.SOOP_PASSWORD=v;
    });
  } catch(e){}
  loadOrCreatePassword();
  console.log(`║   🔑 비밀번호: ${CONFIG.ADMIN_PASSWORD}               ║`);
  console.log(`║   📊 구글시트: API 직접 연동          ║`);

  if (CONFIG.STREAMER_ID) connectToSoop();
  else console.log('⚠️  대시보드에서 스트리머 ID를 입력하세요\n');
});
