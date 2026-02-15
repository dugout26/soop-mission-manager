const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SoopClient, SoopChatEvent } = require('soop-extension');
const { google } = require('googleapis');

// 서버 크래시 방지 - 에러가 나도 서버가 죽지 않도록
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

const CONFIG = {
  STREAMER_ID: process.env.STREAMER_ID || 'phonics1',
  SOOP_USER_ID: process.env.SOOP_USER_ID || '',
  SOOP_PASSWORD: process.env.SOOP_PASSWORD || '',
  ADMIN_PASSWORD: '',
  PORT: parseInt(process.env.PORT) || 3000,
};

// 인증
let AUTH_SECRET = '';
function makeToken(pw) { return crypto.createHmac('sha256', AUTH_SECRET).update(pw).digest('hex'); }
let VALID_TOKEN = '';

function generatePassword() {
  return crypto.randomBytes(3).toString('hex');
}

function loadOrCreateAuth() {
  const ep = path.join(__dirname, '.env');
  const isCloud = !!process.env.RAILWAY_ENVIRONMENT || !!process.env.RENDER || !!process.env.FLY_APP_NAME;
  let lines = [];
  try { lines = fs.readFileSync(ep, 'utf-8').split('\n'); } catch(e) {}

  let foundPw = false, foundSecret = false;

  // 환경변수 우선 체크 (클라우드 배포용)
  if (process.env.AUTH_SECRET) { AUTH_SECRET = process.env.AUTH_SECRET; foundSecret = true; }
  if (process.env.ADMIN_PASSWORD) { CONFIG.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD; foundPw = true; }

  // .env 파일에서 읽기
  for (const l of lines) {
    const [k, ...vp] = l.split('=');
    const v = vp.join('=').trim().replace(/^['"]|['"]$/g, '');
    if (k?.trim() === 'ADMIN_PASSWORD' && v && !foundPw) { CONFIG.ADMIN_PASSWORD = v; foundPw = true; }
    if (k?.trim() === 'AUTH_SECRET' && v && !foundSecret) { AUTH_SECRET = v; foundSecret = true; }
  }

  // AUTH_SECRET 생성
  if (!foundSecret || !AUTH_SECRET) {
    AUTH_SECRET = crypto.randomBytes(16).toString('hex');
    if (!isCloud) {
      const hasLine = lines.some(l => l.trim().startsWith('AUTH_SECRET'));
      if (hasLine) {
        lines = lines.map(l => l.trim().startsWith('AUTH_SECRET') ? `AUTH_SECRET=${AUTH_SECRET}` : l);
      } else {
        lines.push(`\n# 인증 시크릿 (자동생성, 삭제하면 토큰 초기화)`);
        lines.push(`AUTH_SECRET=${AUTH_SECRET}`);
      }
      fs.writeFileSync(ep, lines.join('\n'));
    }
  }

  if (!foundPw || !CONFIG.ADMIN_PASSWORD) {
    CONFIG.ADMIN_PASSWORD = generatePassword();
    if (!isCloud) {
      try { lines = fs.readFileSync(ep, 'utf-8').split('\n'); } catch(e) {}
      const hasLine = lines.some(l => l.trim().startsWith('ADMIN_PASSWORD'));
      if (hasLine) {
        lines = lines.map(l => l.trim().startsWith('ADMIN_PASSWORD') ? `ADMIN_PASSWORD=${CONFIG.ADMIN_PASSWORD}` : l);
      } else {
        lines.push(`\n# 대시보드 접속 비밀번호 (자동생성)`);
        lines.push(`ADMIN_PASSWORD=${CONFIG.ADMIN_PASSWORD}`);
      }
      fs.writeFileSync(ep, lines.join('\n'));
    }
  }
  VALID_TOKEN = makeToken(CONFIG.ADMIN_PASSWORD);
}

function savePassword(newPw) {
  CONFIG.ADMIN_PASSWORD = newPw;
  VALID_TOKEN = makeToken(newPw);
  const ep = path.join(__dirname, '.env');
  try {
    let lines = fs.readFileSync(ep, 'utf-8').split('\n');
    const hasLine = lines.some(l => l.trim().startsWith('ADMIN_PASSWORD'));
    if (hasLine) {
      lines = lines.map(l => l.trim().startsWith('ADMIN_PASSWORD') ? `ADMIN_PASSWORD=${newPw}` : l);
    } else {
      lines.push(`ADMIN_PASSWORD=${newPw}`);
    }
    fs.writeFileSync(ep, lines.join('\n'));
  } catch(e) { /* 클라우드 환경: 파일 없어도 메모리에서 동작 */ }
}

// ============================================
// 상태 (파일 자동 저장/복원)
// ============================================
const DATA_FILE = path.join(__dirname, 'data.json');
let missionTemplates = [];   // 미션 틀
let missionResults = [];     // 매칭된 결과
let autoThreshold = 0;       // 이 값 이상이면 템플릿 없어도 자동등록 (0=비활성)

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ missionTemplates, missionResults, autoThreshold }));
  } catch(e) { console.error('💾 저장 실패:', e.message); }
}
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      missionTemplates = d.missionTemplates || [];
      missionResults = d.missionResults || [];
      autoThreshold = d.autoThreshold || 0;
      console.log(`💾 데이터 복원: 템플릿 ${missionTemplates.length}개, 결과 ${missionResults.length}개`);
    }
  } catch(e) { console.error('💾 복원 실패:', e.message); }
}
loadData();
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

const SAVE_EVENTS = new Set(['templates','result','resultUpdate','resultDelete','resetResults','autoThreshold']);
let saveTimer = null;
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter(res => {
    try { res.write(msg); return true; } catch(e) { return false; }
  });
  // 데이터 변경 시 자동 저장 (디바운스 1초)
  if (SAVE_EVENTS.has(event)) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveData, 1000);
  }
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
    templateName: matched ? matched.name : '자동등록',
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

      // GIFT/CHALLENGE_GIFT 타입이면 대결/도전미션 후원
      if (data.type === 'GIFT' || data.type === 'CHALLENGE_GIFT') {
        const amt = parseInt(data.gift_count) || 0;
        const uid = data.user_id || '';
        const nick = data.user_nick || '';
        const title = data.title || '';
        const isChallenege = data.type === 'CHALLENGE_GIFT';
        const eventType = isChallenege ? 'challenge' : 'mission';

        console.log(`🎯 ${isChallenege ? '도전미션' : '대결미션'} 감지! [${title}] ${nick}(${uid}) → ${amt}개`);

        // 실시간 로그에 별풍선으로 표시
        broadcast('balloon', {
          userId: uid,
          userNickname: nick,
          amount: amt,
          channelUrl: `https://ch.sooplive.co.kr/${uid}`,
          time: now(),
          type: eventType,
          missionTitle: title,
        });

        // 미션 매칭 시스템에 연동
        const result = matchBalloon(uid, nick, amt, eventType);

        // 이 유저의 다음 채팅을 메시지로 연결
        recentDonors[uid] = { timestamp: Date.now(), resultId: result?.id || null, nick, amount: amt };
        setTimeout(() => { delete recentDonors[uid]; }, 60000);

        const entry = {
          time: now(),
          typeCode: '0121',
          eventType: eventType,
          data: data,
          raw: rawStr.substring(0, 300),
        };
        broadcast('missionPacket', entry);

        // 로그
        const logLine = `[${new Date().toISOString()}] ${data.type}: ${JSON.stringify(data)}\n`;
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
// SOOP 연결
// ============================================
async function connectToSoop() {
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

    soopChat.on(SoopChatEvent.CONNECT, () => console.log(`✅ 채팅 서버 연결`));
    soopChat.on(SoopChatEvent.ENTER_CHAT_ROOM, () => {
      connectionStatus = 'connected';
      broadcast('status', { status: connectionStatus, streamerId: CONFIG.STREAMER_ID });
      console.log(`🎉 채팅방 입장! 이벤트 감지 시작`);
    });

    // ⭐ 별풍선
    soopChat.on(SoopChatEvent.TEXT_DONATION, (d) => {
      const amt = parseInt(d.amount) || 0;
      const uid = d.from, nick = d.fromUsername;
      if (isDuplicate(`balloon_${uid}_${amt}`)) return;
      console.log(`⭐ 별풍선 ${nick}(${uid}) → ${amt}개`);
      broadcast('balloon', { userId: uid, userNickname: nick, amount: amt, channelUrl: `https://ch.sooplive.co.kr/${uid}`, time: now(), type: 'balloon' });
      const result = matchBalloon(uid, nick, amt, 'balloon');

      let foundMsg = null;
      if (global._recentChats) {
        const recent = global._recentChats.find(c => normalizeUid(c.userId) === uid && (Date.now() - c.ts) < 60000);
        if (recent) {
          foundMsg = recent.comment;
          console.log(`💬 직전 채팅에서 TTS 연결! ${nick}(${uid}): "${foundMsg}"`);
          if (result) { result.message = foundMsg; broadcast('resultUpdate', result); }
          broadcast('donationMsg', { userId: uid, userNickname: nick, amount: amt, message: foundMsg, time: now() });
        }
      }
      if (!foundMsg) {
        recentDonors[uid] = { timestamp: Date.now(), resultId: result?.id || null, nick, amount: amt };
        setTimeout(() => { delete recentDonors[uid]; }, 60000);
      }
    });

    // 🎈 애드벌룬
    soopChat.on(SoopChatEvent.AD_BALLOON_DONATION, (d) => {
      const amt = parseInt(d.amount) || 0;
      const uid = d.from, nick = d.fromUsername;
      if (isDuplicate(`adballoon_${uid}_${amt}`)) return;
      console.log(`🎈 애드벌룬 ${nick}(${uid}) → ${amt}개`);
      broadcast('balloon', { userId: uid, userNickname: nick, amount: amt, channelUrl: `https://ch.sooplive.co.kr/${uid}`, time: now(), type: 'adballoon' });
      const result = matchBalloon(uid, nick, amt, 'adballoon');
      recentDonors[uid] = { timestamp: Date.now(), resultId: result?.id || null, nick, amount: amt };
      setTimeout(() => { delete recentDonors[uid]; }, 60000);
    });

    // 🎬 영상풍선
    soopChat.on(SoopChatEvent.VIDEO_DONATION, (d) => {
      const amt = parseInt(d.amount) || 0;
      const uid = d.from, nick = d.fromUsername;
      if (isDuplicate(`video_${uid}_${amt}`)) return;
      console.log(`🎬 영상풍선 ${nick}(${uid}) → ${amt}개`);
      broadcast('balloon', { userId: uid, userNickname: nick, amount: amt, channelUrl: `https://ch.sooplive.co.kr/${uid}`, time: now(), type: 'video' });
      matchBalloon(uid, nick, amt, 'video');
    });

    // UNKNOWN 패킷
    soopChat.on(SoopChatEvent.UNKNOWN, (parts) => {
      const raw = Array.isArray(parts) ? parts.join('|') : String(parts);
      if (isDuplicate(`unknown_${raw.substring(0, 100)}`)) return;
      const entry = {
        time: now(),
        partsCount: Array.isArray(parts) ? parts.length : 0,
        snippet: raw.substring(0, 300),
        parts: Array.isArray(parts) ? parts.slice(0, 15).map(p => p.substring(0, 80)) : [],
      };
      unknownPackets.unshift(entry);
      if (unknownPackets.length > 200) unknownPackets.pop();
      broadcast('unknown', entry);
    });

    // 💬 채팅 → 후원 메시지 연결
    soopChat.on(SoopChatEvent.CHAT, (d) => {
      const rawUid = d.userId;
      const uid = normalizeUid(rawUid);
      const msg = d.comment;
      if (isDuplicate(`chat_${uid}_${msg}`)) return;

      const waiting = Object.keys(recentDonors);
      if (waiting.length > 0) {
        console.log(`💬 채팅수신 ${uid}: "${msg}" (대기중: ${waiting.join(',')})`);
      }

      if (recentDonors[uid] && msg) {
        const donor = recentDonors[uid];
        console.log(`✅ TTS 메시지 연결! ${donor.nick}(${uid}): "${msg}"`);
        if (donor.resultId) {
          const r = missionResults.find(r => r.id === donor.resultId);
          if (r) { r.message = msg; broadcast('resultUpdate', r); }
        }
        broadcast('donationMsg', { userId: uid, userNickname: donor.nick, amount: donor.amount, message: msg, time: now() });
        delete recentDonors[uid];
      }
    });

    // RAW 패킷
    soopChat.on(SoopChatEvent.RAW, (buffer) => {
      try {
        const str = buffer.toString('utf-8');
        if (str.length >= 6) {
          const typeCode = str.substring(2, 6);

          if (['0018', '0087', '0105', '0121'].includes(typeCode)) {
            const rawHash = str.substring(0, 100);
            if (isDuplicate(`raw_${typeCode}_${rawHash}`)) return;
            const SEP = '\f';
            const parts = str.split(SEP);
            const fieldDump = parts.map((p,i) => `[${i}] = "${p.substring(0,200).replace(/[\x00-\x1f]/g,'·')}"`).join('\n');
            const debugLog = `[${new Date().toISOString()}] TYPE=${typeCode} PARTS=${parts.length}\n${fieldDump}\n${'='.repeat(60)}\n`;
            fs.appendFile(path.join(__dirname, 'donation_debug.log'), debugLog, () => {});

            if (typeCode === '0018') {
              const possibleMsgs = parts.filter((p, i) => {
                if (i <= 5) return false;
                const clean = p.replace(/[\x00-\x1f]/g, '').trim();
                if (!clean || clean.length < 2) return false;
                if (/^[0-9._-]+$/.test(clean)) return false;
                if (/^[a-f0-9-]{36}$/i.test(clean)) return false;
                if (/^[a-z]{2}_[A-Z]{2}$/.test(clean)) return false;
                if (/^(kor_|typecast_|tts_)/i.test(clean)) return false;
                if (clean === parts[1]?.replace(/[\x00-\x1f]/g,'').trim()) return false;
                return true;
              });
              if (possibleMsgs.length > 0) {
                fs.appendFile(path.join(__dirname, 'donation_debug.log'), `  → 텍스트 후보: ${JSON.stringify(possibleMsgs)}\n`, () => {});
              }
            }
          }

          if (typeCode === '0005') {
            const SEP = '\f';
            const chatParts = str.split(SEP);
            const chatUserId = normalizeUid(chatParts[2]?.replace(/[\x00-\x1f]/g, '').trim());
            const chatComment = chatParts[1]?.replace(/[\x00-\x1f]/g, '').trim();
            if (chatUserId && chatComment) {
              if (isDuplicate(`raw0005_${chatUserId}_${chatComment}`)) return;
              if (!global._recentChats) global._recentChats = [];
              global._recentChats.unshift({ ts: Date.now(), userId: chatUserId, comment: chatComment });
              if (global._recentChats.length > 50) global._recentChats.pop();
            }
            if (chatUserId && recentDonors[chatUserId]) {
              const debugLog = `[${new Date().toISOString()}] RAW_CHAT_AFTER_DONATION userId=${chatUserId} msg="${chatComment}"\n${'='.repeat(60)}\n`;
              fs.appendFile(path.join(__dirname, 'donation_debug.log'), debugLog, () => {});
            }
          }

          if (typeCode === '0121') {
            if (isDuplicate(`raw0121_${str.substring(0, 150)}`)) return;
            console.log(`🎲 0121 패킷 감지! 길이: ${str.length}`);
            parse0121(str);
            const entry = { time: now(), typeCode, length: str.length, preview: str.substring(0, 400).replace(/[\x00-\x1f]/g, '·'), fullData: str.replace(/[\x00-\x1f]/g, '·') };
            broadcast('rawUnknown', entry);
            const logLine = `[${new Date().toISOString()}] TYPE=0121 LEN=${str.length}\nFULL: ${str.replace(/[\x00-\x1f]/g, '·')}\n${'='.repeat(80)}\n`;
            fs.appendFile(path.join(__dirname, 'unknown_packets.log'), logLine, () => {});
          }
          else if (!KNOWN_TYPES.has(typeCode)) {
            const entry = { time: now(), typeCode, length: str.length, preview: str.substring(0, 300).replace(/[\x00-\x1f]/g, '·') };
            broadcast('rawUnknown', entry);
            const logLine = `[${new Date().toISOString()}] TYPE=${typeCode} LEN=${str.length} DATA=${str.substring(0, 500).replace(/[\x00-\x1f]/g, '·')}\n`;
            fs.appendFile(path.join(__dirname, 'unknown_packets.log'), logLine, () => {});
          }
        }
      } catch(e) {}
    });

    soopChat.on(SoopChatEvent.DISCONNECT, () => {
      connectionStatus = 'disconnected';
      broadcast('status', { status: connectionStatus });
      console.log('❌ 연결 끊김. 10초 후 재연결');
      scheduleReconnect();
    });

    await soopChat.connect();
  } catch (e) {
    console.error(`❌ 연결 실패: ${e.message}`);
    connectionStatus = 'error';
    broadcast('status', { status: connectionStatus, error: e.message });
    scheduleReconnect();
  }
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

// SOOP BJ 검색 캐시 (5분 TTL)
const searchCache = new Map();
const SEARCH_CACHE_TTL = 5 * 60 * 1000;

// SOOP BJ 검색 API (sch.sooplive.co.kr)
async function searchSOOPStreamers(query) {
  // 캐시 확인
  const cacheKey = query.toLowerCase().trim();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL) {
    return cached.data;
  }

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
            const results = json.DATA
              .filter(d => (parseInt(d.favorite_cnt) || 0) >= 1000)
              .map(d => ({
                id: d.user_id,
                name: d.user_nick,
                profileImage: d.station_logo || getSOOPProfileImage(d.user_id),
                channelUrl: `https://ch.sooplive.co.kr/${d.user_id}`,
                favorite_cnt: d.favorite_cnt || 0
              }));
            searchCache.set(cacheKey, { ts: Date.now(), data: results });
            resolve(results);
          } else {
            searchCache.set(cacheKey, { ts: Date.now(), data: [] });
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
  const cookieToken = (req.headers.cookie || '').split(';').map(c=>c.trim()).find(c=>c.startsWith('mk_token='));
  const cookieVal = cookieToken ? cookieToken.split('=')[1] : '';
  const setCookie = (token) => `mk_token=${token}; Path=/; Max-Age=2592000; SameSite=Lax`;
  const json = (d, c=200, extra={}) => { res.writeHead(c, {'Content-Type':'application/json', ...extra}); res.end(JSON.stringify(d)); };
  const authOk = () => req.headers['x-auth'] === VALID_TOKEN || cookieVal === VALID_TOKEN;

  // 토큰 검증
  if (url.pathname === '/api/verify' && req.method === 'GET') {
    if (authOk()) return json({ ok: true });
    return json({ ok: false }, 401);
  }

  // 인증
  if (url.pathname === '/api/auth' && req.method === 'POST') {
    body().then(d => {
      if (d.password === CONFIG.ADMIN_PASSWORD) {
        json({ ok: true, token: VALID_TOKEN }, 200, {'Set-Cookie': setCookie(VALID_TOKEN)});
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
      json({ ok: true, token: VALID_TOKEN }, 200, {'Set-Cookie': setCookie(VALID_TOKEN)});
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

  // 스트레스 테스트용 (별풍선 시뮬레이션)
  if (url.pathname === '/api/test-balloon' && req.method === 'POST') {
    body().then(d => {
      const { userId, userNickname, amount, eventType, message } = d;
      if (!userId || !amount) return json({ ok: false, error: 'userId, amount 필수' }, 400);
      broadcast('balloon', { userId, userNickname, amount, type: eventType || 'balloon', time: now() });
      const result = matchBalloon(userId, userNickname, parseInt(amount), eventType || 'balloon');
      if (result && message) {
        result.message = message;
        broadcast('resultUpdate', result);
      } else if (result && !message) {
        // 분리전송: 메시지 없이 별풍선만 → recentDonors에 등록 (나중에 채팅으로 연결)
        recentDonors[userId] = { timestamp: Date.now(), resultId: result.id, nick: userNickname, amount: parseInt(amount) };
        setTimeout(() => { delete recentDonors[userId]; }, 60000);
      }
      json({ ok: true, matched: !!result, id: result?.id, hasMessage: !!message });
    }); return;
  }

  // 스트레스 테스트용 (채팅 시뮬레이션 — 별풍선 후 메시지 따로 보내기)
  if (url.pathname === '/api/test-chat' && req.method === 'POST') {
    body().then(d => {
      const { userId, message } = d;
      if (!userId || !message) return json({ ok: false, error: 'userId, message 필수' }, 400);
      if (recentDonors[userId]) {
        const donor = recentDonors[userId];
        if (donor.resultId) {
          const r = missionResults.find(r => r.id === donor.resultId);
          if (r) { r.message = message; broadcast('resultUpdate', r); }
        }
        broadcast('donationMsg', { userId, userNickname: donor.nick, amount: donor.amount, message, time: now() });
        delete recentDonors[userId];
        json({ ok: true, linked: true });
      } else {
        json({ ok: true, linked: false, reason: 'no recent donor' });
      }
    }); return;
  }

  // 인증 필요한 API들
  const needsAuth = ['/api/templates','/api/templates/update','/api/templates/delete','/api/templates/toggle','/api/auto-threshold','/api/results/reset','/api/config','/api/reconnect','/api/export-sheets'];
  if (needsAuth.includes(url.pathname) && req.method === 'POST' && !authOk()) {
    return json({ ok: false, error: '인증 필요' }, 401);
  }

  // 템플릿
  if (url.pathname === '/api/templates' && req.method === 'POST') {
    body().then(d => {
      const t = { id: Date.now(), name: d.name||'미션', starCount: parseInt(d.starCount)||500, eventType: d.eventType||'all', collectDomain: d.collectDomain!==false, collectMessage: d.collectMessage===true, active: true };
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

  // DeepLol 스트리머 계정 조회 (프록시) - 캐시 포함
  if (url.pathname === '/api/streamer-lol' && req.method === 'GET') {
    const name = url.searchParams.get('name');
    if (!name) return json({ ok: false, error: 'name 파라미터 필요' }, 400);
    // 캐시 (10분)
    if (!global._lolCache) global._lolCache = new Map();
    const cacheKey = name.toLowerCase();
    const cached = global._lolCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < 600000) return json(cached.data);
    const _https = require('https');
    const zlib = require('zlib');
    function fetchDeepLol(queryName, status) {
      return new Promise((resolve) => {
        const apiUrl = `https://b2c-api-cdn.deeplol.gg/summoner/strm_pro_info?name=${encodeURIComponent(queryName)}&status=${status}`;
        _https.get(apiUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'gzip, deflate, br' } }, (resp) => {
          let stream = resp;
          const enc = resp.headers['content-encoding'];
          if (enc === 'gzip') stream = resp.pipe(zlib.createGunzip());
          else if (enc === 'deflate') stream = resp.pipe(zlib.createInflate());
          else if (enc === 'br') stream = resp.pipe(zlib.createBrotliDecompress());
          let data = '';
          stream.on('data', c => data += c);
          stream.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(null); } });
          stream.on('error', () => resolve(null));
        }).on('error', () => resolve(null));
      });
    }
    (async () => {
      try {
        const ok = (r) => r && r.account_list && r.account_list.length > 0;
        const names = [name];
        const cleaned = name.replace(/[^가-힣a-zA-Z0-9]+$/g, '').trim();
        if (cleaned && cleaned !== name) names.push(cleaned);
        for (const status of ['streamer', 'pro']) {
          for (const n of names) {
            const r = await fetchDeepLol(n, status);
            if (ok(r)) { global._lolCache.set(cacheKey, { ts: Date.now(), data: r }); return json(r); }
          }
        }
        json({ account_list: [], searchName: name });
      } catch(e) { json({ account_list: [], searchName: name, error: e.message }); }
    })();
    return;
  }

  // Google Sheets 추출 (직접 API)
  if (url.pathname === '/api/export-sheets' && req.method === 'POST') {
    if (!authOk()) return json({ ok: false, error: '인증 필요' }, 401);
    if (!missionResults.length) return json({ ok: false, error: '추출할 데이터가 없습니다' }, 400);
    body().then(async () => {
      try {
        let auth;
        if (process.env.GCP_CREDENTIALS) {
          const creds = JSON.parse(process.env.GCP_CREDENTIALS);
          if (creds.type === 'service_account') {
            auth = new google.auth.GoogleAuth({
              credentials: creds,
              scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
            });
          } else {
            const oauth2 = new google.auth.OAuth2(creds.client_id, creds.client_secret);
            oauth2.setCredentials({ refresh_token: creds.refresh_token });
            if (creds.quota_project_id) oauth2.quotaProjectId = creds.quota_project_id;
            auth = oauth2;
          }
        } else {
          auth = new google.auth.GoogleAuth({
            scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
          });
        }
        const sheets = google.sheets({ version: 'v4', auth });

        const typeName = {balloon:'별풍선',adballoon:'애드벌룬',video:'영상풍선',mission:'대결미션',challenge:'도전미션'};
        const d = new Date();
        const dateStr = `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        const title = `MK미션_${dateStr}`;
        // A:미션이름 B:타입 C:개수 D:닉네임 E:유저ID F:방송국링크 G:메시지 H:시간 I:확인(체크박스) J:상태(수식)
        const header = ['미션이름','타입','개수','닉네임','유저ID','방송국링크','메시지','시간','확인','상태'];

        // 미션이름별 그룹핑
        const grouped = {};
        for (const r of missionResults) {
          const name = r.templateName || '기타';
          if (!grouped[name]) grouped[name] = [];
          grouped[name].push(r);
        }
        const missionNames = Object.keys(grouped);

        // 1) 새 스프레드시트 생성 (미션별 시트 탭)
        const sheetDefs = missionNames.map((name, i) => ({
          properties: { sheetId: i, title: name, gridProperties: { frozenRowCount: 1 } }
        }));
        const ss = await sheets.spreadsheets.create({
          requestBody: {
            properties: { title },
            sheets: sheetDefs,
          },
        });
        const ssId = ss.data.spreadsheetId;
        const ssUrl = ss.data.spreadsheetUrl;
        console.log(`📊 스프레드시트 생성: ${title} (${missionNames.length}개 시트) → ${ssUrl}`);

        // 2) 각 시트에 데이터 입력 (확인=FALSE, 상태=수식)
        const valueData = missionNames.map(name => ({
          range: `'${name}'!A1`,
          values: [header, ...grouped[name].map((r, i) => ([
            r.templateName||'', typeName[r.eventType||'balloon']||'', r.amount||0,
            r.userNickname||'', r.userId||'',
            r.channelUrl||'', r.message||'',
            r.createdAt||'',
            r.completed ? true : false,
            `=IF(I${i+2},"완료","진행중")`
          ]))]
        }));
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: ssId,
          requestBody: { valueInputOption: 'USER_ENTERED', data: valueData },
        });

        // 3) 모든 사용자에게 편집 권한 부여
        const drive = google.drive({ version: 'v3', auth });
        await drive.permissions.create({
          fileId: ssId,
          requestBody: { role: 'writer', type: 'anyone' },
        });

        // 4) 각 시트 서식
        const reqs = [];
        const colWidths = [120, 80, 60, 120, 120, 250, 250, 100, 60, 80];
        missionNames.forEach((name, sheetIdx) => {
          const rows = grouped[name];
          const rowCount = rows.length;
          // 헤더 배경색 + 흰 글씨 + 볼드
          reqs.push({ repeatCell: { range: { sheetId:sheetIdx, startRowIndex:0, endRowIndex:1 }, cell: { userEnteredFormat: { backgroundColor:{red:.18,green:.49,blue:.2}, textFormat:{bold:true,foregroundColor:{red:1,green:1,blue:1}}, horizontalAlignment:'CENTER' } }, fields:'userEnteredFormat' } });
          // 확인 열 체크박스 (I열 = index 8)
          if (rowCount > 0) {
            reqs.push({ repeatCell: { range: { sheetId:sheetIdx, startRowIndex:1, endRowIndex:rowCount+1, startColumnIndex:8, endColumnIndex:9 }, cell: { dataValidation: { condition: { type:'BOOLEAN' } } }, fields:'dataValidation' } });
          }
          // 열 너비 명시 설정
          colWidths.forEach((w, ci) => {
            reqs.push({ updateDimensionProperties: { range: { sheetId:sheetIdx, dimension:'COLUMNS', startIndex:ci, endIndex:ci+1 }, properties: { pixelSize: w }, fields:'pixelSize' } });
          });
          // 상태 열 색상 (J열 = index 9) — 조건부 서식으로 완료=빨강, 진행중=초록
          if (rowCount > 0) {
            reqs.push({ addConditionalFormatRule: { rule: { ranges: [{ sheetId:sheetIdx, startRowIndex:1, endRowIndex:rowCount+1, startColumnIndex:9, endColumnIndex:10 }], booleanRule: { condition: { type:'TEXT_EQ', values:[{userEnteredValue:'완료'}] }, format: { textFormat: { bold:true, foregroundColor:{red:.83,green:.18,blue:.18} } } } }, index:0 } });
            reqs.push({ addConditionalFormatRule: { rule: { ranges: [{ sheetId:sheetIdx, startRowIndex:1, endRowIndex:rowCount+1, startColumnIndex:9, endColumnIndex:10 }], booleanRule: { condition: { type:'TEXT_EQ', values:[{userEnteredValue:'진행중'}] }, format: { textFormat: { bold:true, foregroundColor:{red:.18,green:.49,blue:.2} } } } }, index:1 } });
          }
          // 방송국 링크 열 파란색 (F열 = index 5)
          if (rowCount > 0) {
            reqs.push({ repeatCell: { range:{ sheetId:sheetIdx, startRowIndex:1, endRowIndex:rowCount+1, startColumnIndex:5, endColumnIndex:6 }, cell:{ userEnteredFormat:{ textFormat:{ foregroundColor:{red:.1,green:.45,blue:.91} } } }, fields:'userEnteredFormat.textFormat.foregroundColor' } });
          }
        });

        await sheets.spreadsheets.batchUpdate({ spreadsheetId: ssId, requestBody: { requests: reqs } });

        json({ ok: true, url: ssUrl });
      } catch(e) {
        console.error(`📊 Sheets 오류:`, e.message, e.code || '', e.status || '');
        if (e.response?.data) console.error(`📊 상세:`, JSON.stringify(e.response.data).substring(0, 500));
        json({ ok: false, error: e.message });
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

  // 대시보드 (미션매니저)
  if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/mission' || url.pathname === '/dashboard.html') {
    fs.readFile(path.join(__dirname, 'dashboard.html'), (e, d) => {
      if(e){res.writeHead(500);res.end('err');return;}
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); res.end(d);
    }); return;
  }

  // 팀뽑기
  if (url.pathname === '/team') {
    fs.readFile(path.join(__dirname, 'main-dashboard.html'), (e, d) => {
      if(e){res.writeHead(500);res.end('err');return;}
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); res.end(d);
    }); return;
  }

  // 사다리 타기
  if (url.pathname === '/ladder') {
    fs.readFile(path.join(__dirname, 'ladder.html'), (e, d) => {
      if(e){res.writeHead(500);res.end('err');return;}
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); res.end(d);
    }); return;
  }

  // 팀뽑기 공유용 (로그인 불필요)
  if (url.pathname === '/pick') {
    fs.readFile(path.join(__dirname, 'pick.html'), (e, d) => {
      if(e){res.writeHead(500);res.end('err');return;}
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); res.end(d);
    }); return;
  }

  // 지통실 (멀티 스트림 뷰어)
  if (url.pathname === '/control') {
    fs.readFile(path.join(__dirname, 'control.html'), (e, d) => {
      if(e){res.writeHead(500);res.end('err');return;}
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); res.end(d);
    }); return;
  }

  // 헬스체크
  if (url.pathname === '/health') {
    json({ status: 'ok', uptime: process.uptime() });
    return;
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
  loadOrCreateAuth();
  console.log(`║   🔑 비밀번호: ${CONFIG.ADMIN_PASSWORD}               ║`);
  console.log(`║   📊 구글시트: API 직접 연동          ║`);

  if (CONFIG.STREAMER_ID) connectToSoop();
  else console.log('⚠️  대시보드에서 스트리머 ID를 입력하세요\n');
});
