const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SoopClient, SoopChatEvent } = require('soop-extension');
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

const KNOWN_TYPES = new Set([
  '0000','0001','0002','0004','0005','0007','0012',
  '0018','0087','0093','0104','0109','0105','0127'
]);

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
        matchBalloon(uid, nick, amt, 'mission');

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
      console.log(`⭐ 별풍선 ${nick}(${uid}) → ${amt}개`);
      broadcast('balloon', { userId: uid, userNickname: nick, amount: amt, channelUrl: `https://ch.sooplive.co.kr/${uid}`, time: now(), type: 'balloon' });
      const result = matchBalloon(uid, nick, amt, 'balloon');

      // 직전 채팅에서 메시지 찾기 (메시지가 후원보다 먼저 올 수 있음)
      let foundMsg = null;
      if (global._recentChats) {
        const recent = global._recentChats.find(c => c.userId === uid && (Date.now() - c.ts) < 10000);
        if (recent) {
          foundMsg = recent.comment;
          console.log(`💬 직전 채팅에서 TTS 연결! ${nick}(${uid}): "${foundMsg}"`);
          if (result) { result.message = foundMsg; broadcast('resultUpdate', result); }
          broadcast('donationMsg', { userId: uid, userNickname: nick, amount: amt, message: foundMsg, time: now() });
        }
      }

      // 직전에 못 찾았으면 후속 채팅 대기 (10초)
      if (!foundMsg) {
        recentDonors[uid] = { timestamp: Date.now(), resultId: result?.id || null, nick, amount: amt };
        setTimeout(() => { delete recentDonors[uid]; }, 10000);
      }
    });

    // 🎈 애드벌룬
    soopChat.on(SoopChatEvent.AD_BALLOON_DONATION, (d) => {
      const amt = parseInt(d.amount) || 0;
      const uid = d.from, nick = d.fromUsername;
      console.log(`🎈 애드벌룬 ${nick}(${uid}) → ${amt}개`);
      broadcast('balloon', { userId: uid, userNickname: nick, amount: amt, channelUrl: `https://ch.sooplive.co.kr/${uid}`, time: now(), type: 'adballoon' });
      matchBalloon(uid, nick, amt, 'adballoon');
    });

    // 🎬 영상풍선
    soopChat.on(SoopChatEvent.VIDEO_DONATION, (d) => {
      const amt = parseInt(d.amount) || 0;
      const uid = d.from, nick = d.fromUsername;
      console.log(`🎬 영상풍선 ${nick}(${uid}) → ${amt}개`);
      broadcast('balloon', { userId: uid, userNickname: nick, amount: amt, channelUrl: `https://ch.sooplive.co.kr/${uid}`, time: now(), type: 'video' });
      matchBalloon(uid, nick, amt, 'video');
    });

    // UNKNOWN 패킷
    soopChat.on(SoopChatEvent.UNKNOWN, (parts) => {
      const raw = Array.isArray(parts) ? parts.join('|') : String(parts);
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
      const uid = d.userId;
      const msg = d.comment;
      if (recentDonors[uid] && msg) {
        const donor = recentDonors[uid];
        console.log(`💬 TTS 메시지 연결! ${donor.nick}(${uid}): "${msg}"`);
        // 미션 결과에 메시지 연결
        if (donor.resultId) {
          const r = missionResults.find(r => r.id === donor.resultId);
          if (r) {
            r.message = msg;
            broadcast('resultUpdate', r);
          }
        }
        // 별풍선 로그에도 메시지 전송
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

          // 후원 패킷 + 후원 직후 채팅 기록
          if (['0018', '0087', '0105', '0121'].includes(typeCode)) {
            const SEP = '\f';
            const parts = str.split(SEP);
            const fieldDump = parts.map((p,i) => `[${i}] = "${p.substring(0,200).replace(/[\x00-\x1f]/g,'·')}"`).join('\n');
            const debugLog = `[${new Date().toISOString()}] TYPE=${typeCode} PARTS=${parts.length}\n${fieldDump}\n${'='.repeat(60)}\n`;
            fs.appendFile(path.join(__dirname, 'donation_debug.log'), debugLog, () => {});

            // 0018 패킷에서 모든 텍스트 필드 검사 (TTS 메시지 후보)
            if (typeCode === '0018') {
              const possibleMsgs = parts.filter((p, i) => {
                if (i <= 5) return false;  // bjId, senderId, nick, count, fanOrder
                const clean = p.replace(/[\x00-\x1f]/g, '').trim();
                if (!clean || clean.length < 2) return false;
                if (/^[0-9._-]+$/.test(clean)) return false;  // 숫자/코드
                if (/^[a-f0-9-]{36}$/i.test(clean)) return false;  // UUID
                if (/^[a-z]{2}_[A-Z]{2}$/.test(clean)) return false;  // locale
                if (/^(kor_|typecast_|tts_)/i.test(clean)) return false;  // TTS 음성명
                if (clean === parts[1]?.replace(/[\x00-\x1f]/g,'').trim()) return false;  // bjId
                return true;
              });
              if (possibleMsgs.length > 0) {
                console.log(`📝 0018 패킷 내 텍스트 후보: ${JSON.stringify(possibleMsgs)}`);
                fs.appendFile(path.join(__dirname, 'donation_debug.log'), `  → 텍스트 후보: ${JSON.stringify(possibleMsgs)}\n`, () => {});
              }
            }
          }

          // 모든 채팅을 최근 버퍼에 저장 (후원 전 메시지 확인용)
          if (typeCode === '0005') {
            const SEP = '\f';
            const parts = str.split(SEP);
            const chatUserId = parts[2]?.replace(/[\x00-\x1f]/g, '').trim();
            const chatComment = parts[1]?.replace(/[\x00-\x1f]/g, '').trim();
            if (chatUserId && chatComment) {
              // 최근 채팅 버퍼에 저장 (최대 50개)
              if (!global._recentChats) global._recentChats = [];
              global._recentChats.unshift({ ts: Date.now(), userId: chatUserId, comment: chatComment });
              if (global._recentChats.length > 50) global._recentChats.pop();
            }
            // 후원 후 채팅 매칭
            if (chatUserId && recentDonors[chatUserId]) {
              const debugLog = `[${new Date().toISOString()}] CHAT_AFTER_DONATION userId=${chatUserId} msg="${chatComment}"\n${'='.repeat(60)}\n`;
              fs.appendFile(path.join(__dirname, 'donation_debug.log'), debugLog, () => {});
            }
          }

          // 후원 패킷 올 때 직전 채팅도 기록 (메시지가 먼저 올 수 있음)
          if (typeCode === '0018') {
            const SEP = '\f';
            const parts = str.split(SEP);
            const donorId = parts[2]?.replace(/[\x00-\x1f]/g, '').trim();
            if (donorId && global._recentChats) {
              const recent = global._recentChats.filter(c => c.userId === donorId && (Date.now() - c.ts) < 10000);
              if (recent.length > 0) {
                const debugLog = `[${new Date().toISOString()}] CHAT_BEFORE_DONATION userId=${donorId}\n${recent.map(c => `  "${c.comment}" (${((Date.now()-c.ts)/1000).toFixed(1)}초 전)`).join('\n')}\n${'='.repeat(60)}\n`;
                fs.appendFile(path.join(__dirname, 'donation_debug.log'), debugLog, () => {});
              }
            }
          }

          // 0121 패킷 특별 처리 (도전/대결미션 추정)
          if (typeCode === '0121') {
            console.log(`🎲 0121 패킷 감지! 길이: ${str.length}`);
            parse0121(str);

            const entry = {
              time: now(),
              typeCode,
              length: str.length,
              preview: str.substring(0, 400).replace(/[\x00-\x1f]/g, '·'),
              fullData: str.replace(/[\x00-\x1f]/g, '·'),
            };
            broadcast('rawUnknown', entry);

            // 파일에 전체 내용 기록
            const logLine = `[${new Date().toISOString()}] TYPE=0121 LEN=${str.length}\nFULL: ${str.replace(/[\x00-\x1f]/g, '·')}\n${'='.repeat(80)}\n`;
            fs.appendFile(path.join(__dirname, 'unknown_packets.log'), logLine, () => {});
          }
          else if (!KNOWN_TYPES.has(typeCode)) {
            const entry = {
              time: now(),
              typeCode,
              length: str.length,
              preview: str.substring(0, 300).replace(/[\x00-\x1f]/g, '·'),
            };
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

// ============================================
// HTTP 서버
// ============================================
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${CONFIG.PORT}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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

  // Google Sheets 추출 (직접 API)
  if (url.pathname === '/api/export-sheets' && req.method === 'POST') {
    if (!authOk()) return json({ ok: false, error: '인증 필요' }, 401);
    if (!missionResults.length) return json({ ok: false, error: '추출할 데이터가 없습니다' }, 400);
    body().then(async () => {
      try {
        const auth = new google.auth.GoogleAuth({
          scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
        });
        const sheets = google.sheets({ version: 'v4', auth });

        const typeName = {balloon:'별풍선',adballoon:'애드벌룬',video:'영상풍선',mission:'대결미션'};
        const d = new Date();
        const dateStr = `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        const title = `MK미션_${dateStr}`;
        const header = ['미션명','타입','개수','닉네임','유저ID','방송국링크','메시지','상태','시간','확인'];
        const rows = missionResults.map(r => ([
          r.templateName||'', typeName[r.eventType||'balloon']||'', r.amount||0,
          r.userNickname||'', r.userId||'',
          r.channelUrl||'', r.message||'',
          r.completed?'완료':'진행중', r.createdAt||''
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

        // 3) 서식 (헤더 색상, 체크박스, 열 너비, 링크 색)
        const reqs = [
          // 헤더 배경색 + 흰 글씨 + 볼드
          { repeatCell: { range: { sheetId:0, startRowIndex:0, endRowIndex:1 }, cell: { userEnteredFormat: { backgroundColor:{red:.18,green:.49,blue:.2}, textFormat:{bold:true,foregroundColor:{red:1,green:1,blue:1}}, horizontalAlignment:'CENTER' } }, fields:'userEnteredFormat' } },
          // 확인 열 체크박스 (J열 = index 9)
          { repeatCell: { range: { sheetId:0, startRowIndex:1, endRowIndex:rows.length+1, startColumnIndex:9, endColumnIndex:10 }, cell: { dataValidation: { condition: { type:'BOOLEAN' } } }, fields:'dataValidation' } },
          // 열 너비 자동
          { autoResizeDimensions: { dimensions: { sheetId:0, dimension:'COLUMNS', startIndex:0, endIndex:10 } } },
        ];

        // 상태 열 색상 (H열 = index 7)
        rows.forEach((r, i) => {
          const color = r[7]==='완료' ? {red:.83,green:.18,blue:.18} : {red:.18,green:.49,blue:.2};
          reqs.push({ repeatCell: { range:{ sheetId:0, startRowIndex:i+1, endRowIndex:i+2, startColumnIndex:7, endColumnIndex:8 }, cell:{ userEnteredFormat:{ textFormat:{ bold:true, foregroundColor:color } } }, fields:'userEnteredFormat.textFormat' } });
        });

        // 방송국 링크 열 파란색 (F열 = index 5)
        if (rows.length > 0) {
          reqs.push({ repeatCell: { range:{ sheetId:0, startRowIndex:1, endRowIndex:rows.length+1, startColumnIndex:5, endColumnIndex:6 }, cell:{ userEnteredFormat:{ textFormat:{ foregroundColor:{red:.1,green:.45,blue:.91} } } }, fields:'userEnteredFormat.textFormat.foregroundColor' } });
        }

        await sheets.spreadsheets.batchUpdate({ spreadsheetId: ssId, requestBody: { requests: reqs } });

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

  // 대시보드
  if (url.pathname === '/' || url.pathname === '/index.html') {
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
