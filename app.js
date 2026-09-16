
/* 单词小王国 1.0 · 单一本地词库版 */
let WORD_BOOK=Array.isArray(window.WORD_BOOK)?window.WORD_BOOK:[];
const ETY_BASE="https://www.etymonline.com/cn";
const ETY_SOURCE_NAME="Etymonline 中文站";
function normalizeLookupWord(word){return String(word||"").trim().toLowerCase().replace(/[’']/g,"'").replace(/\s+/g," ")}
function cleanQuwordText(t){return String(t||"").replace(/\u00a0/g," ").replace(/\r/g,"").replace(/[ \t]+/g," ").replace(/ *\n */g,"\n").replace(/\n{3,}/g,"\n\n").replace(/\s+([，。；：])/g,"$1").trim()}
function wordById(id){return WORD_BOOK.find(w=>w.id===id)}
function etymologyText(w){
  const raw=cleanQuwordText(w?.etymology||"");
  if(!raw)return "";
  return raw.trim();
}
function meaningText(w){
  const base=String(w?.meaningDetail||w?.meaning||"").trim();
  const pos=String(w?.partOfSpeech||"").trim();
  const ex=String(w?.example||w?.sentence||"").trim();
  return [pos?`【${pos}】`:"",base,ex?`例句：${ex}`:""].filter(Boolean).join(" ");
}
function etymUrl(word){return `${ETY_BASE}/word/${encodeURIComponent(normalizeLookupWord(word))}`}
function sourceLink(label,url){return url?`<a class="source-link" href="${url}" target="_blank" rel="noopener noreferrer">来源：${label}</a>`:""}
function markWrong(id){if(!state.wrong.includes(id)){state.wrong=[...state.wrong,id];save()}}
function playableWords(){return WORD_BOOK.filter(w=>w.playable!==false&&/^[A-Za-z]+$/.test(w.word))}

/* 单词小王国 1.0 - rebuilt core */
const state={
  score:Number(localStorage.getItem("wg_score")||0),
  coins:Number(localStorage.getItem("wg_coins")||0),
  streak:Number(localStorage.getItem("wg_streak")||0),
  xp:Number(localStorage.getItem("wg_xp")||0),
  level:Number(localStorage.getItem("wg_level")||1),
  lives:Number(localStorage.getItem("wg_lives")||5),
  stage:Number(localStorage.getItem("wg_stage")||1),
  favorites:JSON.parse(localStorage.getItem("wg_favorites")||"[]"),
  memorized:JSON.parse(localStorage.getItem("wg_memorized")||"[]"),
  wrong:JSON.parse(localStorage.getItem("wg_wrong")||"[]"),
  cleared:JSON.parse(localStorage.getItem("wg_cleared")||"{}"),
  daily:JSON.parse(localStorage.getItem("wg_daily")||"{}"),
  sound:localStorage.getItem("wg_sound")!=="0",
  currentGame:null,
  hints:3,
  timer:null,
  connect:null,
  search:null,
  guess:null,
  hangman:null
};

const LEVELS=[
 {id:1,name:"新手村",diff:"简单",need:0},
 {id:2,name:"字母森林",diff:"简单",need:40},
 {id:3,name:"单词小镇",diff:"简单",need:90},
 {id:4,name:"知识峡谷",diff:"普通",need:160},
 {id:5,name:"词汇沙漠",diff:"普通",need:250},
 {id:6,name:"知识高地",diff:"普通",need:360},
 {id:7,name:"智慧神殿",diff:"困难",need:500},
 {id:8,name:"大师试炼",diff:"困难",need:680},
 {id:9,name:"词汇王国",diff:"困难",need:900},
 {id:10,name:"终极挑战",diff:"史诗",need:1200}
];

function save(){
  Object.assign(localStorage,{
    wg_score:state.score,wg_coins:state.coins,wg_streak:state.streak,wg_xp:state.xp,
    wg_level:state.level,wg_lives:state.lives,wg_stage:state.stage,
    wg_favorites:JSON.stringify(state.favorites),wg_memorized:JSON.stringify(state.memorized),wg_wrong:JSON.stringify(state.wrong),
    wg_cleared:JSON.stringify(state.cleared),wg_daily:JSON.stringify(state.daily)
  });
  updateTop();
}
function updateTop(){
  document.querySelector("#scoreTop").textContent=state.score;
  document.querySelector("#coinsTop").textContent=state.coins;
  document.querySelector("#streakTop").textContent=state.streak;
  document.querySelector("#soundBtn").textContent=state.sound?"🔊":"🔇";
}
function todayKey(){return new Date().toISOString().slice(0,10)}
function dailyReset(){
  const k=todayKey();
  if(state.daily.date!==k){state.daily={date:k,done:0};save();}
}
function xpNeed(){return 100+(state.level-1)*40}
function awardXP(n){
  state.xp+=n;
  while(state.xp>=xpNeed()){state.xp-=xpNeed();state.level++;toast(`🎉 升级到 Lv.${state.level}`)}
}
function markDaily(){
  dailyReset();state.daily.done=Math.min(3,(state.daily.done||0)+1);
}
function recordWin(xp){
  awardXP(Math.round(xp));markDaily();save();
}
function recordFail(){state.streak=0;state.lives=Math.max(0,state.lives-1);save()}
function stageCfg(id=state.stage){
  if(id<=3)return{difficulty:1,time:120,mul:1};
  if(id<=6)return{difficulty:2,time:120,mul:1.25};
  if(id<=9)return{difficulty:3,time:120,mul:1.6};
  return{difficulty:4,time:120,mul:2};
}
function unlocked(id){return id===1||state.score>=LEVELS[id-1].need}
function pool(id=state.stage,extra=()=>true){
  const d=stageCfg(id).difficulty;let p=WORD_BOOK.filter(w=>w.playable!==false&&w.difficulty<=d&&extra(w));
  return p.length?p:WORD_BOOK.filter(w=>w.playable!==false&&extra(w));
}
function pick(id=state.stage,extra=()=>true){
  const p=pool(id,extra);return p[Math.floor(Math.random()*p.length)];
}
function shuffle(a){let x=[...a];for(let i=x.length-1;i>0;i--){let j=Math.floor(Math.random()*(i+1));[x[i],x[j]]=[x[j],x[i]]}return x}
function beep(type="click"){
  if(!state.sound)return;
  try{
    const C=window.AudioContext||window.webkitAudioContext;if(!C)return;
    const c=window._audio||=new C();if(c.state==="suspended")c.resume();
    const o=c.createOscillator(),g=c.createGain(),now=c.currentTime;
    const s={click:[540,.05,.025],good:[720,.12,.05],bad:[170,.15,.04],win:[900,.23,.06]}[type]||[540,.05,.025];
    o.type="sine";o.frequency.value=s[0];g.gain.setValueAtTime(s[2],now);g.gain.exponentialRampToValueAtTime(.001,now+s[1]);
    o.connect(g);g.connect(c.destination);o.start(now);o.stop(now+s[1]);
  }catch(e){}
}
function toggleSound(){state.sound=!state.sound;localStorage.setItem("wg_sound",state.sound?"1":"0");updateTop();if(state.sound)beep("click")}
function toast(t){let x=document.querySelector(".toast");x?.remove();x=document.createElement("div");x.className="toast";x.textContent=t;document.body.appendChild(x);setTimeout(()=>x.remove(),1800)}
function popScore(txt,x=innerWidth/2,y=innerHeight*.3){let d=document.createElement("div");d.className="pop-score";d.textContent=txt;d.style.left=x+"px";d.style.top=y+"px";document.body.appendChild(d);setTimeout(()=>d.remove(),900)}
function celebrate(){beep("win");for(let i=0;i<25;i++){let d=document.createElement("div");d.className="confetti";d.style.left=(45+Math.random()*10)+"vw";d.style.top=(24+Math.random()*10)+"vh";d.style.setProperty("--dx",((Math.random()-.5)*380)+"px");d.style.setProperty("--dy",(160+Math.random()*390)+"px");d.style.background=`hsl(${Math.random()*360},70%,60%)`;document.body.appendChild(d);setTimeout(()=>d.remove(),950)}}
function clearTimers(){if(state.timer){clearInterval(state.timer);state.timer=null}window.removeEventListener("pointermove",connectMove);window.removeEventListener("pointerup",connectEnd);window.removeEventListener("pointercancel",connectEnd)}
function cleanup(){clearTimers();state.connect=null;state.search=null;state.guess=null;state.hangman=null;state.spelling=null;state.currentGame=null;state.locked=false}
function goHome(){cleanup();renderHome()}
function back(){goHome()}

function renderHome(){
  dailyReset();updateTop();
  const pct=Math.min(100,state.xp/xpNeed()*100),daily=state.daily.done||0;
  document.querySelector("#main").innerHTML=`
    <section class="hero">
      <div><div class="eyebrow">WORD KINGDOM · 1.0</div><h1>单词小王国</h1><p>边玩边学，让英语单词变得有趣。</p>
      <div class="hero-actions"><button class="primary" onclick="openLevels()">🗺️ 开始闯关</button><button class="secondary" onclick="openLibrary('all')">📚 单词本</button></div></div>
      <div class="hero-ring"><div>Lv.${state.level}<small>单词学徒</small></div></div>
    </section>
    <div class="profile-strip">
      <div class="profile-card"><div class="small">等级 / XP</div><div class="big">Lv.${state.level}</div><div class="xpbar"><span style="width:${pct}%"></span></div></div>
      <div class="profile-card"><div class="small">生命</div><div class="big">${"❤️".repeat(state.lives)}${"🖤".repeat(5-state.lives)}</div></div>
      <div class="profile-card"><div class="small">词库</div><div class="big">${WORD_BOOK.length} 个单词</div></div>
      <div class="profile-card"><div class="small">收藏</div><div class="big">${state.favorites.length} 个</div></div><div class="profile-card"><div class="small">已背</div><div class="big">${state.memorized.length} 个</div></div>
    </div>
    <div class="learn-links"><button class="secondary" onclick="openLibrary('all')">📖 单词本</button><button class="secondary" onclick="startSpelling()">📝 背单词</button></div><div class="daily"><div class="daily-head"><div class="daily-title">🔥 今日挑战</div><div class="daily-sub">${daily}/3 已完成</div></div><div class="dailybar"><span style="width:${daily/3*100}%"></span></div><div class="learn-links"><button class="secondary" onclick="startDaily()">立即挑战</button><button class="secondary" onclick="openLibrary('wrong')">错题本</button></div></div>
    <div class="section-title">选择玩法</div>
    <section class="games">
      <div class="game" onclick="startConnect()"><div class="game-icon">🔗</div><div class="game-main"><h3>单词连线</h3><p>拖动连接字母，拼出英文单词</p><span class="tag">主玩法</span></div><div class="arrow">›</div></div>
      <div class="game" onclick="startSearch()"><div class="game-icon">🔎</div><div class="game-main"><h3>单词查找</h3><p>在字母方阵中找隐藏单词</p><span class="tag">找词</span></div><div class="arrow">›</div></div>
      <div class="game" onclick="startGuess()"><div class="game-icon">💡</div><div class="game-main"><h3>单词猜测</h3><p>看中文释义，四选一猜英文</p><span class="tag">入门</span></div><div class="arrow">›</div></div>
      <div class="game" onclick="startHangman()"><div class="game-icon">🎯</div><div class="game-main"><h3>猜字游戏</h3><p>没有提示，只根据字母猜单词</p><span class="tag">挑战</span></div><div class="arrow">›</div></div>
    </section>`;
}
function openLevels(){
  cleanup();
  const positions=[
    [8,78],[22,58],[36,70],[50,42],[63,60],[76,30],[62,16],[44,25],[25,13],[10,5]
  ];
  const pts=positions.map(([x,y])=>`${x},${y}`).join(" ");
  document.querySelector("#main").innerHTML=`<section class="level-map-page"><button class="back" onclick="goHome()">← 游戏大厅</button><div class="page-head"><div><h1>🗺️ 闯关地图</h1><p>沿着地图路线逐关前进，完成关卡后继续解锁。</p></div><div class="timer">当前第 ${state.stage} 关</div></div>
  <div class="adventure-map"><svg class="map-route" viewBox="0 0 100 84" preserveAspectRatio="none"><polyline points="${pts}" fill="none" class="route-bg"/><polyline points="${positions.slice(0,Math.max(1,state.stage)).map(([x,y])=>`${x},${y}`).join(" ")}" fill="none" class="route-done"/></svg>
  <div class="map-deco deco-a">☁️</div><div class="map-deco deco-b">🌲</div><div class="map-deco deco-c">🏔️</div>
  ${LEVELS.map((l,i)=>{const [x,y]=positions[i],u=unlocked(l.id),stars=Number(state.cleared[l.id]||0);return `<button class="map-node ${u?"":"locked"} ${state.stage===l.id?"current":""} ${stars>=3?"cleared":""}" style="--x:${x}%;--y:${y}%" ${u?`onclick="selectLevel(${l.id})"`:"disabled"}><span class="node-number">${stars>=3?"✓":l.id}</span><span class="node-label">${l.name}</span><span class="node-stars">${"★".repeat(stars)}${"☆".repeat(3-stars)}</span>${!u?'<span class="node-lock">🔒</span>':""}</button>`}).join("")}
  </div><div class="level-info" id="levelInfo"><h3>选择一个已解锁关卡</h3><div class="row">积分：<b>${state.score}</b>　当前关卡：<b>${state.stage}</b></div></div></section>`;
}
function selectLevel(id){
  if(!unlocked(id))return;state.stage=id;save();
  const l=LEVELS[id-1],c=stageCfg(id);
  document.querySelector("#levelInfo").innerHTML=`<h3>第 ${l.id} 关 · ${l.name}</h3><div class="row"><span>难度 <b>${l.diff}</b></span><span>解锁积分 <b>${l.need}</b></span><span>查找时间 <b>${c.time} 秒</b></span><span>奖励倍率 <b>×${c.mul}</b></span></div><div class="learn-links"><button class="secondary" onclick="startConnect(${id})">🔗 连线</button><button class="secondary" onclick="startSearch(${id})">🔎 查找</button><button class="secondary" onclick="startGuess(${id})">💡 猜测</button><button class="secondary" onclick="startHangman(${id})">🎯 猜字</button></div>`;
}
function openLibrary(tab="all",category="全部",memoryTab="all",page=1){
  cleanup();
  const cats=["全部",...Array.from(new Set(WORD_BOOK.map(w=>w.category).filter(Boolean)))];
  let base=tab==="wrong"?state.wrong.map(wordById).filter(Boolean):tab==="favorite"?state.favorites.map(wordById).filter(Boolean):WORD_BOOK;
  if(category!=="全部") base=base.filter(w=>w.category===category);
  if(memoryTab==="memorized") base=base.filter(w=>state.memorized.includes(w.id));
  if(memoryTab==="unmemorized") base=base.filter(w=>!state.memorized.includes(w.id));
  page=Math.max(1,Number(page)||1);
  const pageSize=100;
  const totalPages=Math.max(1,Math.ceil(base.length/pageSize));
  page=Math.min(page,totalPages);
  const pageItems=base.slice((page-1)*pageSize,page*pageSize);
  const pager=base.length>pageSize?`<div class="library-pager"><button class="secondary" ${page<=1?"disabled":""} onclick="openLibrary('${tab}','${category}','${memoryTab}',${page-1})">← 上一页</button><span>第 ${page}/${totalPages} 页 · 共 ${base.length} 条</span><button class="secondary" ${page>=totalPages?"disabled":""} onclick="openLibrary('${tab}','${category}','${memoryTab}',${page+1})">下一页 →</button></div>`:"";
  document.querySelector("#main").innerHTML=`<section class="library-page"><button class="back" onclick="goHome()">← 游戏大厅</button><div class="page-head"><div><h1>📚 单词本</h1><p>唯一主词库 · ${WORD_BOOK.length} 个词条 · 游戏全部从这里出题</p></div><div class="head-actions"><button class="hint-btn" onclick="startSpelling()">📝 背单词</button></div></div>
  <div class="profile-strip" style="margin:0 0 14px"><div class="profile-card"><div class="small">全部词条</div><div class="big">${WORD_BOOK.length}</div></div><div class="profile-card"><div class="small">已背</div><div class="big">${state.memorized.length}</div></div><div class="profile-card"><div class="small">收藏</div><div class="big">${state.favorites.length}</div></div><div class="profile-card"><div class="small">错题</div><div class="big">${state.wrong.length}</div></div></div>
  <div class="library-tabs"><button class="library-tab ${tab==="all"?"active":""}" onclick="openLibrary('all','${category}','${memoryTab}',1)">全部</button><button class="library-tab ${tab==="favorite"?"active":""}" onclick="openLibrary('favorite','${category}','${memoryTab}',1)">⭐ 收藏</button><button class="library-tab ${tab==="wrong"?"active":""}" onclick="openLibrary('wrong','${category}','${memoryTab}',1)">❌ 错题</button></div>
  <div class="library-subtabs"><button class="library-tab ${memoryTab==='all'?"active":""}" onclick="openLibrary('${tab}','${category}','all',1)">全部</button><button class="library-tab ${memoryTab==='memorized'?"active":""}" onclick="openLibrary('${tab}','${category}','memorized',1)">✅ 已背</button><button class="library-tab ${memoryTab==='unmemorized'?"active":""}" onclick="openLibrary('${tab}','${category}','unmemorized',1)">📖 未背</button></div>
  <div class="category-tabs">${cats.map(c=>`<button class="library-tab ${c===category?"active":""}" onclick="openLibrary('${tab}','${c}','${memoryTab}',1)">${c}</button>`).join("")}</div>
  ${base.length?`<div class="word-cards">${pageItems.map(wordCard).join("")}</div>${pager}`:'<div class="empty">这里还没有单词。</div>'}</section>`;
}
function wordCard(w){const fav=state.favorites.includes(w.id),mem=state.memorized.includes(w.id),et=etymologyText(w);return `<div class="word-card"><button class="fav-btn" onclick="toggleFavorite(${w.id})">${fav?"⭐":"☆"}</button><h3>${w.word} ${mem?'<span class="memory-badge">✅ 已背</span>':''}</h3><div class="meaning">${w.meaning||""}</div><div class="phonetic">${w.phonetic||""}</div><div class="mini-info"><b>释义：</b>${meaningText(w)}${et?`<br><b>词源：</b>${et}${sourceLink(ETY_SOURCE_NAME,w.etymologyUrl||etymUrl(w.word))}`:""}<br><b>分类：</b>${w.category||"综合词汇"}　<b>阶段：</b>${w.stage||"初中"}</div><div class="learn-links"><button class="secondary" onclick="startSpelling(${w.id})">${mem?"再背一次":"背这个词"}</button></div></div>`}
function toggleFavorite(id){state.favorites=state.favorites.includes(id)?state.favorites.filter(x=>x!==id):[...state.favorites,id];save();openLibrary('all');}

/* ---------- Unified Learning Card ---------- */

function learningCard(word,reward,nextFn,nextLabel="下一题"){
  const fav=state.favorites.includes(word.id),et=etymologyText(word);
  const layer=document.createElement("div");layer.className="learning-overlay";layer.id="learnLayer";
  const etBlock=et?`<div class="learning-detail-block"><div class="detail-title">📖 词源</div><div>${et}</div>${sourceLink("Etymonline 中文站",word.etymologyUrl||etymUrl(word.word))}</div>`:"";
  layer.innerHTML=`<div class="learning-card"><div class="learning-icon">📚</div><div style="color:#999;font-size:12px">本题单词</div><div class="learning-word">${word.word}</div><div class="learning-meaning">${word.meaning||""}</div><div class="learning-phonetic">${word.phonetic||""}</div><div class="learning-info"><div class="learning-detail-block"><div class="detail-title">📌 详细释义</div><div>${meaningText(word)}</div>${sourceLink(word.meaningSource||"词典资料",word.meaningUrl)}</div>${etBlock}<div class="learning-detail-block"><div class="detail-title">🏷️ 词汇信息</div><div><b>分类：</b>${word.category||"综合词汇"}　<b>阶段：</b>${word.stage||"初中"}</div></div></div><div class="learning-actions"><button class="secondary" onclick="toggleFavorite(${word.id});document.querySelector('#learnLayer')?.remove()">${fav?"⭐ 取消收藏":"☆ 收藏"}</button><button class="primary" id="learnNext">${reward}<br><span style="font-size:12px;font-weight:500">${nextLabel} →</span></button></div></div>`;
  document.body.appendChild(layer);document.querySelector("#learnNext").onclick=()=>{layer.remove();nextFn()};
}
function hintButton(game){return `<button class="hint-btn" onclick="useHint('${game}')">💡 提示 <span id="hintCount-${game}">${state.hints}</span>/3</button>`}
function resetHints(){state.hints=3}
function updateHintButton(game){const el=document.querySelector(`#hintCount-${game}`);if(el)el.textContent=state.hints}
function useHint(game){
  if(state.hints<=0){toast("本题提示次数已用完");return}
  let used=false;
  if(game==="connect"){
    const c=state.connect;if(!c||c.done||c.hintAnimating)return;
    const target=c.word.word.toLowerCase().split("");
    const available=[...c.letters.keys()];const mapping=[];const usedIdx=new Set(c.path);
    target.forEach(ch=>{const idx=available.find(i=>!usedIdx.has(i)&&!mapping.some(m=>m===i)&&c.letters[i]===ch);if(idx!=null)mapping.push(idx)});
    if(mapping.length===target.length){
      state.hints--;used=true;c.hintAnimating=true;c.hintRevealed=new Set(mapping);
      mapping.forEach((idx,step)=>setTimeout(()=>{const el=document.querySelector(`.wheel-letter[data-i="${idx}"]`);if(el){el.classList.add("hint-revealed","hint-letter");setTimeout(()=>el.classList.remove("hint-letter"),360)}},step*190));
      setTimeout(()=>{c.hintAnimating=false;},Math.max(420,mapping.length*190+450));
    }
  }else if(game==="search"){
    const s=state.search;if(!s)return;
    const target=s.list.find(w=>!s.found.has(w.word));
    if(target&&s.places[target.word]){state.hints--;used=true;const cells=s.places[target.word];cells.forEach(([r,c])=>document.querySelector(`.grid-cell[data-r="${r}"][data-c="${c}"]`)?.classList.add("hint-cell"));setTimeout(()=>cells.forEach(([r,c])=>document.querySelector(`.grid-cell[data-r="${r}"][data-c="${c}"]`)?.classList.remove("hint-cell")),1700);}
  }else if(game==="guess"){
    const g=state.guess;if(!g)return;
    const bad=[...document.querySelectorAll("#guessOptions button")].find(b=>b.textContent!==g.target.word&&!b.disabled);
    if(bad){state.hints--;used=true;bad.disabled=true;bad.classList.add("hint-removed");bad.textContent="× 排除";}
  }else if(game==="hangman"){
    const h=state.hangman;if(!h||h.done)return;
    const k=h.target.word.split("").find(x=>!h.guessed.has(x)&&!h.blocked.has(x));
    if(k){state.hints--;used=true;hangGuess(k);toast(`💡 提示：已揭示字母 ${k.toUpperCase()}`)}
  }
  if(used){beep("click");updateHintButton(game)}
}

/* ---------- Connect ---------- */
function startConnect(levelId=state.stage){
  cleanup();state.locked=false;resetHints();state.stage=levelId;save();if(state.lives<=0){state.lives=5;save();}
  const word=pick(levelId);state.connect={word,letters:shuffle(word.word.toLowerCase().split("")),path:[],active:false,pointer:null,hintRevealed:new Set(),hintAnimating:false};
  document.querySelector("#main").innerHTML=`<section class="connect-page"><button class="back" onclick="goHome()">← 游戏大厅</button><div class="page-head"><div><h1>🔗 单词连线</h1><p>按住字母并拖动，连成正确单词</p></div><div class="head-actions"><div class="timer">+${Math.round(15*stageCfg().mul)} 分</div>${hintButton("connect")}</div></div><div class="play-card" id="connectCard"><div class="connect-rule">不要点击。<b>按住一个字母拖动</b>，连线经过的字母会自动加入答案。</div><div class="connect-answer" id="connectAnswer"><span class="placeholder">拖动开始</span></div><div class="letter-wheel" id="letterWheel"><svg class="connect-svg" id="connectSvg"><polyline class="connect-path" id="connectPath"></polyline><line class="connect-path-tip" id="connectTip"></line></svg><div class="wheel-center">↗<small>拖动</small></div></div><div class="connect-actions"><button class="secondary" onclick="connectNewLetters()">换盘</button></div><div class="feedback" id="connectFeedback"></div></div></section>`;
  renderConnectLetters();bindConnect();
}
function renderConnectLetters(){
  const wheel=document.querySelector("#letterWheel");if(!wheel||!state.connect)return;
  const old=[...wheel.querySelectorAll(".wheel-letter")];
  const n=state.connect.letters.length,r=n>=9?40:37;
  old.forEach(x=>x.remove());
  state.connect.letters.forEach((x,i)=>{
    const b=document.createElement("button");b.className="wheel-letter";b.dataset.i=i;b.textContent=x;
    const a=-Math.PI/2+i*2*Math.PI/n;b.style.left=(50+Math.cos(a)*r)+"%";b.style.top=(50+Math.sin(a)*r)+"%";
    if(state.connect.hintRevealed?.has(i))b.classList.add("hint-revealed");
    b.addEventListener("pointerdown",e=>connectStartPointer(e,Number(b.dataset.i)));wheel.appendChild(b)
  });
}
function animateConnectShuffle(){
  const wheel=document.querySelector("#letterWheel");if(!wheel||!state.connect)return;
  const buttons=[...wheel.querySelectorAll(".wheel-letter")];
  const oldLetters=buttons.map(b=>b.textContent);
  const newLetters=shuffle(oldLetters);
  state.connect.letters=newLetters;state.connect.path=[];state.connect.candidate="";state.connect.hintRevealed=new Set();
  const n=newLetters.length,r=n>=9?40:37;
  const byLetter=new Map();oldLetters.forEach((ch,i)=>{if(!byLetter.has(ch))byLetter.set(ch,[]);byLetter.get(ch).push(buttons[i])});
  const used=new Set();
  newLetters.forEach((ch,j)=>{
    const pool=byLetter.get(ch)||[];let b=pool.find(x=>!used.has(x));if(!b)b=buttons[j];used.add(b);
    const a=-Math.PI/2+j*2*Math.PI/n;
    b.dataset.i=j;b.textContent=ch;b.classList.remove("chosen","hint-revealed","correct");
    b.style.transition="left .42s cubic-bezier(.22,.8,.2,1), top .42s cubic-bezier(.22,.8,.2,1), transform .2s";
    b.style.left=(50+Math.cos(a)*r)+"%";b.style.top=(50+Math.sin(a)*r)+"%";
    b.classList.add("swap-motion");setTimeout(()=>b.classList.remove("swap-motion"),460);
  });
  renderConnectAnswer();drawConnectLine();
}

function bindConnect(){window.addEventListener("pointermove",connectMove,{passive:false});window.addEventListener("pointerup",connectEnd);window.addEventListener("pointercancel",connectEnd)}
function wheelPoint(btn){const r=btn.getBoundingClientRect(),w=document.querySelector("#letterWheel").getBoundingClientRect();return [r.left+r.width/2-w.left,r.top+r.height/2-w.top]}
function drawConnectLine(pointer){
  const svg=document.querySelector("#connectSvg"),path=document.querySelector("#connectPath"),tip=document.querySelector("#connectTip");if(!svg||!state.connect)return;
  const pts=state.connect.path.map(i=>wheelPoint(document.querySelector(`.wheel-letter[data-i="${i}"]`))).filter(Boolean);
  path.setAttribute("points",pts.map(p=>p.join(",")).join(" "));
  if(state.connect.active&&pts.length&&pointer){const p=wheelPoint(pointer);tip.setAttribute("x1",pts[pts.length-1][0]);tip.setAttribute("y1",pts[pts.length-1][1]);tip.setAttribute("x2",p[0]);tip.setAttribute("y2",p[1])}else{tip.setAttribute("x1",0);tip.setAttribute("y1",0);tip.setAttribute("x2",0);tip.setAttribute("y2",0)}
}
function connectStartPointer(e,i){if(state.locked)return;e.preventDefault();beep();state.connect.active=true;state.connect.path=[i];document.querySelectorAll(".wheel-letter").forEach(b=>b.classList.remove("chosen"));document.querySelector(`.wheel-letter[data-i="${i}"]`).classList.add("chosen");renderConnectAnswer();drawConnectLine(document.querySelector(`.wheel-letter[data-i="${i}"]`))}
function connectMove(e){if(!state.connect?.active)return;const el=document.elementFromPoint(e.clientX,e.clientY)?.closest(".wheel-letter");if(el){const i=Number(el.dataset.i);if(!state.connect.path.includes(i)){state.connect.path.push(i);el.classList.add("chosen");renderConnectAnswer()};drawConnectLine(el)}else{state.connect.pointer=e;drawConnectLine(null)};e.preventDefault()}
function connectEnd(){if(!state.connect?.active)return;state.connect.active=false;drawConnectLine(null);const c=state.connect.candidate||state.connect.path.map(i=>state.connect.letters[i]).join(""),target=state.connect.word.word;if(c===target){state.locked=true;const gain=Math.round(15*stageCfg().mul);state.score+=gain;state.coins+=2;state.streak++;state.cleared[state.stage]=Math.max(Number(state.cleared[state.stage]||0),3);recordWin(20);popScore("+"+gain);celebrate();document.querySelectorAll(".wheel-letter").forEach(b=>b.classList.add("correct"));learningCard(state.connect.word,`+${gain} 分 · +2 金币`,()=>startConnect(state.stage),"下一题")}else if(c){markWrong(state.connect.word.id);state.streak=0;save();beep("bad");document.querySelector("#connectCard")?.classList.add("error-shake");const f=document.querySelector("#connectFeedback");if(f){f.className="feedback bad";f.textContent="❌ 顺序不对，请重新连线"};setTimeout(connectClear,400)}}
function renderConnectAnswer(){const c=state.connect,box=document.querySelector("#connectAnswer");if(!box)return;const word=c.path.map(i=>c.letters[i]).join("").toLowerCase();c.candidate=word;box.innerHTML=word?word.split("").map(x=>`<span>${x}</span>`).join(""):'<span class="placeholder">拖动开始</span>';drawConnectLine()}
function connectClear(){if(state.locked)return;state.connect.path=[];state.connect.candidate="";document.querySelectorAll(".wheel-letter").forEach(b=>b.classList.remove("chosen"));document.querySelector("#connectFeedback").innerHTML="";renderConnectAnswer()}
function connectNewLetters(){if(state.locked)return;animateConnectShuffle();document.querySelector("#connectFeedback").innerHTML="";beep("click");}

/* ---------- Search ---------- */
function startSearch(levelId=state.stage){
  cleanup();resetHints();state.stage=levelId;save();if(state.lives<=0){state.lives=5;save();}
  const list=shuffle(pool(levelId,w=>/^[A-Za-z]{3,8}$/.test(w.word))).slice(0,5);const size=10;let grid,places;
  for(let attempt=0;attempt<50;attempt++){grid=Array.from({length:size},()=>Array(size).fill(""));places={};let ok=true;
    for(const w of list){let done=false;for(let t=0;t<120;t++){const dirs=[[0,1],[1,0],[1,1],[1,-1],[0,-1],[-1,0],[-1,1],[-1,-1]],d=dirs[Math.floor(Math.random()*dirs.length)],r=Math.floor(Math.random()*size),c=Math.floor(Math.random()*size);let fits=true,cells=[];for(let j=0;j<w.word.length;j++){let rr=r+d[0]*j,cc=c+d[1]*j;if(rr<0||rr>=size||cc<0||cc>=size||(grid[rr][cc]&&grid[rr][cc]!==w.word[j])){fits=false;break}cells.push([rr,cc])}if(fits){cells.forEach(([rr,cc],j)=>grid[rr][cc]=w.word[j]);places[w.word]=cells;done=true;break}}if(!done){ok=false;break}}
    if(ok)break;
  }
  const letters="abcdefghijklmnopqrstuvwxyz";for(let r=0;r<size;r++)for(let c=0;c<size;c++)if(!grid[r][c])grid[r][c]=letters[Math.floor(Math.random()*26)];
  state.search={grid,list,places,size,found:new Set(),active:false,start:null,end:null,time:stageCfg(levelId).time};
  document.querySelector("#main").innerHTML=`<section class="search-page"><button class="back" onclick="goHome()">← 游戏大厅</button><div class="page-head"><div><h1>🔎 单词查找</h1><p>拖动手指或鼠标寻找隐藏单词</p></div><div class="head-actions"><div class="timer" id="searchTimer"></div>${hintButton("search")}</div></div><div class="grid-wrap"><div class="word-grid" id="wordGrid" style="grid-template-columns:repeat(10,1fr)"></div></div><div class="targets"><b>目标单词</b><div class="target-list" id="targetList"></div><div class="feedback" id="searchFeedback"></div></div></section>`;
  renderGrid();renderTargets();bindSearch();startSearchTimer();
}
function renderGrid(){const g=document.querySelector("#wordGrid");g.innerHTML="";state.search.grid.forEach((row,r)=>row.forEach((x,c)=>{const d=document.createElement("div");d.className="grid-cell";d.textContent=x;d.dataset.r=r;d.dataset.c=c;g.appendChild(d)}))}
function renderTargets(){document.querySelector("#targetList").innerHTML=state.search.list.map(w=>`<span class="target-word ${state.search.found.has(w.word)?"found":""}">${w.word}</span>`).join("")}
function cellPoint(x,y){const el=document.elementFromPoint(x,y)?.closest(".grid-cell");return el?[Number(el.dataset.r),Number(el.dataset.c)]:null}
function lineCells(a,b){if(!a||!b)return[];const dr=b[0]-a[0],dc=b[1]-a[1];if(!(dr===0||dc===0||Math.abs(dr)===Math.abs(dc)))return[];const n=Math.max(Math.abs(dr),Math.abs(dc)),sr=Math.sign(dr),sc=Math.sign(dc);return Array.from({length:n+1},(_,i)=>[a[0]+sr*i,a[1]+sc*i])}
function bindSearch(){const wrap=document.querySelector(".grid-wrap");wrap.onpointerdown=e=>{const p=cellPoint(e.clientX,e.clientY);if(!p)return;e.preventDefault();state.search.active=true;state.search.start=p;state.search.end=p;updateSearchSelection(p)};window.addEventListener("pointermove",searchMove,{passive:false});window.addEventListener("pointerup",searchEnd);window.addEventListener("pointercancel",searchEnd)}
function searchMove(e){if(!state.search?.active)return;const p=cellPoint(e.clientX,e.clientY);if(p){state.search.end=p;updateSearchSelection(p)}e.preventDefault()}
function updateSearchSelection(p){document.querySelectorAll(".grid-cell.selected").forEach(x=>x.classList.remove("selected"));lineCells(state.search.start,p).forEach(([r,c])=>document.querySelector(`.grid-cell[data-r="${r}"][data-c="${c}"]`)?.classList.add("selected"))}
function searchEnd(){if(!state.search?.active)return;state.search.active=false;const cells=lineCells(state.search.start,state.search.end);document.querySelectorAll(".grid-cell.selected").forEach(x=>x.classList.remove("selected"));const word=cells.map(([r,c])=>state.search.grid[r][c]).join(""),rev=word.split("").reverse().join("");const target=state.search.list.find(w=>!state.search.found.has(w.word)&&(w.word===word||w.word===rev));if(target){state.search.found.add(target.word);cells.forEach(([r,c])=>document.querySelector(`.grid-cell[data-r="${r}"][data-c="${c}"]`)?.classList.add("found"));beep("good");renderTargets();const gain=Math.round(15*stageCfg().mul);state.score+=gain;state.coins+=1;state.streak++;recordWin(20*stageCfg().mul);popScore("+"+gain);const remain=state.search.list.length-state.search.found.size;setTimeout(()=>learningCard(target,`+${gain} 分 · +1 金币`,()=>{if(!state.search)return;if(remain<=0)searchComplete();else{const f=document.querySelector("#searchFeedback");if(f){f.className="feedback good";f.textContent=`✅ 已找到 ${target.word}，继续寻找 ${remain} 个`;}}},remain>0?"继续查找":"完成本关"),150)}}
function startSearchTimer(){let remain=state.search.time;const tick=()=>{if(!state.search)return;const m=String(Math.floor(remain/60)).padStart(2,"0"),s=String(remain%60).padStart(2,"0"),el=document.querySelector("#searchTimer");if(el){el.textContent=`⏱ ${m}:${s}`;el.classList.toggle("warning",remain<=10)}if(remain--<=0){clearInterval(state.timer);state.timer=null;state.search?.list.filter(w=>!state.search.found.has(w.word)).forEach(w=>markWrong(w.id));recordFail();toast("⏰ 时间到");goHome()}};tick();state.timer=setInterval(tick,1000)}
function searchComplete(){clearTimers();const bonus=Math.max(0,Math.round((state.search.time)*stageCfg().mul/2));state.score+=bonus;state.coins+=3;save();celebrate();const arr=state.search.list;showLearningList(arr,()=>startSearch(state.stage),`本关完成 · 时间奖励 +${bonus}`)}
function showLearningList(words,next,reward){let i=0;const render=()=>{learningCard(words[i],reward,()=>{i++;i<words.length?render():next()} ,i<words.length-1?"学习下一个":"继续")};render()}

/* ---------- Guess ---------- */
function startGuess(levelId=state.stage){cleanup();resetHints();state.stage=levelId;save();const candidates=pool(levelId,w=>w.word.length===5);const target=pick(levelId,w=>w.word.length===5);const other=shuffle(candidates.filter(w=>w.id!==target.id)).slice(0,3);state.guess={target,options:shuffle([target,...other]),done:false};renderGuess()}
function renderGuess(){const g=state.guess;document.querySelector("#main").innerHTML=`<section class="guess-page"><button class="back" onclick="goHome()">← 游戏大厅</button><div class="page-head"><div><h1>💡 单词猜测</h1><p>看中文释义，选择正确的英文单词</p></div><div class="head-actions"><div class="timer">+${Math.round(20*stageCfg().mul)} 分</div>${hintButton("guess")}</div></div><div class="play-card" style="text-align:center"><div style="color:#999;font-size:12px">这个中文是什么意思？</div><div style="font-size:34px;font-weight:900;margin-top:8px">${g.target.meaning}</div><div class="guess-options" id="guessOptions" style="display:grid;gap:11px;max-width:450px;margin:25px auto">${g.options.map(w=>`<button class="secondary" style="font-size:20px;padding:16px" onclick="chooseGuess(${w.id})">${w.word}</button>`).join("")}</div><div class="feedback" id="guessFeedback"></div></div></section>`}
function chooseGuess(id){const g=state.guess;if(g.done)return;const btns=[...document.querySelectorAll("#guessOptions button")];const good=id===g.target.id;g.done=true;if(good){const gain=Math.round(20*stageCfg().mul);state.score+=gain;state.coins+=3;state.streak++;recordWin(25*stageCfg().mul);popScore("+"+gain);celebrate();btns.find(b=>b.textContent===g.target.word)?.classList.add("correct");setTimeout(()=>learningCard(g.target,`+${gain} 分 · +3 金币`,()=>startGuess(state.stage)) ,220)}else{state.wrong=[...new Set([...state.wrong,g.target.id])];recordFail();const f=document.querySelector("#guessFeedback");f.className="feedback bad";f.textContent="❌ 答错了。正确答案是 "+g.target.word;btns.find(b=>b.textContent===g.target.word)?.classList.add("correct");setTimeout(()=>learningCard(g.target,"这次没答对，先把它记住。",()=>startGuess(state.stage)),500)}}

/* ---------- Hangman ---------- */
const HKEYS=["qwertyuiop","asdfghjkl","zxcvbnm"];
function startHangman(levelId=state.stage){cleanup();resetHints();state.stage=levelId;save();const target=pick(levelId,w=>/^[A-Za-z]{3,12}$/.test(w.word));const wrong=shuffle("abcdefghijklmnopqrstuvwxyz".split("")).filter(x=>!target.word.includes(x)).slice(0,3+Math.floor(Math.random()*5));state.hangman={target,guessed:new Set(),misses:0,blocked:new Set(wrong),done:false};renderHangman();animateBlockedKeys()}
function renderHangman(){const h=state.hangman,reveal=h.target.word.split("").map(x=>h.guessed.has(x)?x:"_");document.querySelector("#main").innerHTML=`<section class="hangman-page"><button class="back" onclick="goHome()">← 游戏大厅</button><div class="page-head"><div><h1>🎯 猜字游戏</h1><p>无中文、音标或其他提示，只根据字母猜单词</p></div><div class="head-actions"><div class="timer">胜利 +${Math.round(25*stageCfg().mul)}</div>${hintButton("hangman")}</div></div><div class="hangman-layout"><div class="hangman-drawing">${hangSvg(h.misses)}</div><div class="hangman-word-card"><div class="masked-word">${reveal.map(x=>`<div class="mask-letter">${x==="_"?"":x}</div>`).join("")}</div><div class="hangman-meta"><span>已猜：${[...h.guessed].join(" ")||"暂无"}</span><span class="errors">错误 ${h.misses}/6</span></div><div class="keyboard" style="margin-top:18px">${HKEYS.map(r=>`<div class="key-row">${r.split("").map(k=>{const bl=h.blocked.has(k),used=h.guessed.has(k);return `<button class="key guess-key ${bl?"blocked":used?(h.target.word.includes(k)?"correct":"absent"):""}" data-k="${k}" ${bl||h.done?"disabled":""} onclick="hangGuess('${k}')">${k}</button>`}).join("")}</div>`).join("")}</div><div class="guess-help">开局会随机给 3～7 个“确定不是答案”的字母加删除线；它们不能点击，也不会扣错误次数。</div></div></div></section>`}
function animateBlockedKeys(){const arr=[...state.hangman.blocked],shuffled=shuffle(arr);document.querySelectorAll(".guess-key.blocked").forEach(b=>{b.classList.remove("blocked");b.disabled=true;b.style.textDecoration="none";});shuffled.forEach((k,i)=>setTimeout(()=>{const b=document.querySelector(`.guess-key[data-k="${k}"]`);if(!b)return;b.classList.add("blocked","block-animation");b.disabled=true},180+i*120))}
function hangSvg(m){return `<svg class="hangman-svg" viewBox="0 0 220 260"><path class="line" d="M25 235H195M55 235V25H165V55"/>${m>=1?'<circle class="person" cx="165" cy="83" r="28"/>':""}${m>=2?'<path class="person" d="M165 111V175"/>':""}${m>=3?'<path class="person" d="M165 128L130 150"/>':""}${m>=4?'<path class="person" d="M165 128L200 150"/>':""}${m>=5?'<path class="person" d="M165 175L135 215"/>':""}${m>=6?'<path class="person" d="M165 175L195 215"/>':""}</svg>`}
function hangGuess(k){const h=state.hangman;if(!h||h.done||h.guessed.has(k)||h.blocked.has(k))return;h.guessed.add(k);if(!h.target.word.includes(k))h.misses++;beep(h.target.word.includes(k)?"good":"bad");renderHangman();const win=h.target.word.split("").every(x=>h.guessed.has(x)),lose=h.misses>=6;if(win||lose){h.done=true;if(win){const gain=Math.round(25*stageCfg().mul);state.score+=gain;state.coins+=4;state.streak++;recordWin(30*stageCfg().mul);popScore("+"+gain);celebrate();setTimeout(()=>learningCard(h.target,`+${gain} 分 · +4 金币`,()=>startHangman(state.stage)),260)}else{state.wrong=[...new Set([...state.wrong,h.target.id])];recordFail();setTimeout(()=>learningCard(h.target,"这次没猜出，先把这个单词记住。",()=>startHangman(state.stage)),300)}}}


function openVocabExplorer(){openLibrary("all");}
function filterVocab(cat){openLibrary("all",cat)}


/* ---------- Spelling / 背单词 ---------- */
function isMemorized(id){return state.memorized.includes(id)}
function markMemorized(id){if(!state.memorized.includes(id)){state.memorized.push(id);save();}}
function startSpelling(id){cleanup();const target=id?wordById(id):pick(state.stage,w=>/^[A-Za-z]+$/.test(w.word));if(!target)return;state.spelling={target,checked:false};renderSpelling();}
function renderSpelling(){const s=state.spelling,w=s.target;document.querySelector("#main").innerHTML=`<section class="spell-page"><button class="back" onclick="goHome()">← 游戏大厅</button><div class="page-head"><div><h1>📝 背单词</h1><p>看中文提示，直接拼写英文单词。拼对后标记为“已背”。</p></div><div class="head-actions"><div class="timer">${isMemorized(w.id)?"✅ 已背过":"待背"}</div></div></div><div class="spell-shell"><div class="spell-prompt"><div class="small">中文释义</div><div class="spell-meaning">${w.meaning||meaningText(w)}</div>${w.phonetic?`<div class="spell-phonetic">${w.phonetic}</div>`:""}</div><input id="spellInput" class="spell-input" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="输入英文单词" onkeydown="if(event.key==='Enter')checkSpelling()"><div id="spellStatus" class="spell-status"></div><div class="spell-actions"><button class="secondary" onclick="checkSpelling()">检查</button><button class="secondary" onclick="revealSpelling()">显示答案</button><button class="primary" onclick="nextSpelling()">下一个 →</button></div></div></section>`;setTimeout(()=>document.querySelector('#spellInput')?.focus(),30)}
function checkSpelling(){const s=state.spelling;if(!s)return;const input=document.querySelector('#spellInput');const status=document.querySelector('#spellStatus');const got=String(input?.value||'').trim().toLowerCase(),ans=s.target.word.trim().toLowerCase();if(got===ans){markMemorized(s.target.id);status.className='spell-status good';status.textContent='✅ 拼写正确！已标记为“已背”';beep('good');celebrate();}else{status.className='spell-status bad';status.textContent='❌ 拼写不对，再试一次。';beep('bad');}}
function revealSpelling(){const s=state.spelling;if(!s)return;const status=document.querySelector('#spellStatus');if(status){status.className='spell-status';status.textContent=`答案：${s.target.word}`}}
function nextSpelling(){const current=state.spelling?.target?.id;const poolWords=pool(state.stage,w=>w.id!==current&&/^[A-Za-z]+$/.test(w.word));if(!poolWords.length)return;const target=poolWords[Math.floor(Math.random()*poolWords.length)];state.spelling={target,checked:false};renderSpelling()}

/* ---------- Daily ---------- */
function startDaily(){dailyReset();const type=(state.daily.done||0)%4;type===0?startConnect(state.stage):type===1?startSearch(state.stage):type===2?startGuess(state.stage):startHangman(state.stage)}

/* ---- entry ---- */
window.addEventListener("wg-wordbook-updated",()=>{updateTop(); if(!state.currentGame)renderHome();});
updateTop();renderHome();
