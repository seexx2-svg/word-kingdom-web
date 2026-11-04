(()=>{'use strict';
const C=window.ShipingMahjongCore,$=id=>document.getElementById(id);
const NAMES=['你','老李','阿梅','小赵'],SEATS=['南家','北家','西家','东家'];
const SETTINGS_KEY='shiping-mahjong-settings-v1',SOUND_KEY='shiping-mahjong-sound-v1',BANKROLL_KEY='shiping-mahjong-bankroll-v1';
let state=null,settings=loadSettings(),waiting=false,timer=null,toastTimer=null,turnClock=null,turnSeconds=15,activity=[],aiWatchdog=null,aiToken=0;
let diceTimer=null,diceInterval=null,settledState=null,balances=loadBankroll(),soundEnabled=loadSoundSetting(),audioReady=false,audioCtx=null;

function loadSettings(){try{return Object.assign({chi:true,peng:true,gang:true,badHu:true},JSON.parse(localStorage.getItem(SETTINGS_KEY)||'{}'))}catch(_){return{chi:true,peng:true,gang:true,badHu:true}}}
function loadBankroll(){try{const a=JSON.parse(localStorage.getItem(BANKROLL_KEY)||'null');if(Array.isArray(a)&&a.length===4&&a.every(x=>Number.isFinite(x)))return a.map(x=>Math.floor(x))}catch(_){}return[100,100,100,100]}
function saveBankroll(){try{localStorage.setItem(BANKROLL_KEY,JSON.stringify(balances))}catch(_){}}
function saveSettings(){settings={chi:$('setting-chi').checked,peng:$('setting-peng').checked,gang:$('setting-gang').checked,badHu:$('setting-badHu').checked};try{localStorage.setItem(SETTINGS_KEY,JSON.stringify(settings))}catch(_){}toast('规则已保存，新开一局后生效');closeRules()}
function openRules(){$('setting-chi').checked=!!settings.chi;$('setting-peng').checked=!!settings.peng;$('setting-gang').checked=!!settings.gang;$('setting-badHu').checked=!!settings.badHu;$('rules-modal').classList.remove('hidden')}
function closeRules(){$('rules-modal').classList.add('hidden')}
function toast(msg){const e=$('toast');e.textContent=msg;e.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>e.classList.remove('show'),1900)}
function fmt(n){return(n>0?'+':'')+n}
function projectedBalance(seat){return balances[seat]+(state&&state.phase!=='over'?state.scores[seat]:0)}
function updateBankrollTop(){const e=$('bankroll-display');if(e)e.textContent='你的余额 '+projectedBalance(0)}
function settleRound(){if(!state||state.phase!=='over'||settledState===state)return;for(let i=0;i<4;i++)balances[i]=balances[i]+state.scores[i];saveBankroll();settledState=state}
function loadSeatBalances(){for(let i=0;i<4;i++){const e=$('score-'+i);if(e)e.textContent='余额 '+projectedBalance(i)+' 分';const side=$('side-score-'+i);if(side)side.textContent=String(projectedBalance(i))}updateBankrollTop()}
function loadSoundSetting(){try{return localStorage.getItem(SOUND_KEY)!=='off'}catch(_){return true}}
function syncSoundButton(){const b=$('sound-toggle');if(!b)return;b.textContent=soundEnabled?'声音 开':'声音 关';b.setAttribute('aria-pressed',String(soundEnabled));b.title=soundEnabled?'关闭麻将音效':'开启麻将音效'}
function tone(freq,start,duration,volume,wave='sine'){if(!audioCtx)return;const osc=audioCtx.createOscillator(),gain=audioCtx.createGain(),at=audioCtx.currentTime+start;osc.type=wave;osc.frequency.setValueAtTime(freq,at);gain.gain.setValueAtTime(.0001,at);gain.gain.exponentialRampToValueAtTime(Math.max(.0002,volume),at+.008);gain.gain.exponentialRampToValueAtTime(.0001,at+duration);osc.connect(gain);gain.connect(audioCtx.destination);osc.start(at);osc.stop(at+duration+.015)}
function playSound(kind='ui'){if(!soundEnabled||!audioReady)return;const Audio=window.AudioContext||window.webkitAudioContext;if(!Audio)return;try{if(!audioCtx)audioCtx=new Audio();if(audioCtx.state==='suspended')audioCtx.resume();const p={ui:[[880,0,.045,.018,'sine']],庄:[[420,0,.06,.02,'triangle'],[620,.065,.07,.022,'triangle'],[820,.14,.08,.024,'triangle']],摸:[[690,0,.055,.026,'triangle'],[980,.035,.035,.012,'sine']],出:[[245,0,.075,.045,'triangle'],[720,.012,.025,.012,'sine']],吃:[[420,0,.08,.028,'sine'],[560,.07,.09,.03,'sine']],碰:[[520,0,.07,.032,'triangle'],[760,.065,.1,.032,'triangle']],杠:[[360,0,.1,.035,'triangle'],[520,.09,.11,.035,'triangle'],[760,.18,.13,.035,'triangle']],胡:[[523,0,.12,.035,'sine'],[659,.12,.12,.038,'sine'],[784,.24,.15,.04,'sine'],[1046,.39,.24,.045,'sine']]};(p[kind]||p.ui).forEach(v=>tone(...v))}catch(_){}}
function toggleSound(){soundEnabled=!soundEnabled;try{localStorage.setItem(SOUND_KEY,soundEnabled?'on':'off')}catch(_){}syncSoundButton();if(soundEnabled){audioReady=true;playSound('ui')}}
function tileEl(id,cls=''){const e=document.createElement('div');e.className='tile-face tile-'+C.tileCode(id)+(cls?' '+cls:'');e.title=C.tileLabel(id);e.setAttribute('aria-label',C.tileLabel(id));return e}
function backEl(){const e=document.createElement('div');e.className='tile-back';return e}
function addLog(txt,mark='•'){activity.unshift({text:txt,marker:mark,time:new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})});activity=activity.slice(0,16);renderLog();const last=$('last-action');if(last)last.textContent=txt;playSound(mark)}
function renderLog(){const b=$('activity-list');if(!b)return;b.innerHTML='';if(!activity.length){b.innerHTML='<div class="activity-empty">牌局开始后，出牌和操作会显示在这里。</div>';return}activity.forEach(x=>{const row=document.createElement('div');row.className='activity-item';const m=document.createElement('div');m.className='activity-marker';m.textContent=x.marker;const body=document.createElement('div');body.textContent=x.text;const t=document.createElement('span');t.className='activity-time';t.textContent=x.time;body.appendChild(t);row.append(m,body);b.appendChild(row)})}
function clearTimer(){if(timer)clearTimeout(timer);timer=null;if(aiWatchdog)clearTimeout(aiWatchdog);aiWatchdog=null;aiToken++}
function watchdogAiProgress(token){
  if(token!==aiToken)return;
  aiWatchdog=null;
  if(!state||state.phase==='over')return;
  if(state.phase==='reaction'){
    const pending=state.pendingClaims[state.claimCursor];
    if(pending&&pending.seat!==0){
      try{C.passClaim(state,pending.seat);processClaims()}catch(error){recoverAiTurn(error)}
    }else if(!pending)continueAfterDiscard();
    return;
  }
  if(state.phase!=='discard'||state.current===0)return;
  const seat=state.current,hand=state.hands[seat];
  if(!hand||!hand.length){
    recoverAiTurn(new Error('AI 看门狗检测到空手牌'));
    return;
  }
  let index=hand.length-1;
  try{
    const suggested=C.chooseAiDiscard(hand);
    if(Number.isInteger(suggested)&&suggested>=0&&suggested<hand.length)index=suggested;
  }catch(error){console.error('AI 选牌异常，使用最后一张牌兜底：',error)}
  try{
    const tile=hand[index];
    C.discardTile(state,seat,index);
    addLog(NAMES[seat]+'超时自动打出'+C.tileLabel(tile),'出');
    render();processClaims();
  }catch(error){recoverAiTurn(error)}
}
function scheduleAi(ms){
  if(timer)clearTimeout(timer);
  if(aiWatchdog)clearTimeout(aiWatchdog);
  const token=++aiToken,delay=ms||400;
  timer=setTimeout(()=>{if(token!==aiToken)return;timer=null;aiTurn(token)},delay);
  aiWatchdog=setTimeout(()=>watchdogAiProgress(token),2200);
}
function clearTurnClock(){if(turnClock)clearInterval(turnClock);turnClock=null}
function refreshTurnClock(){clearTurnClock();const e=$('turn-clock');if(!e)return;turnSeconds=15;e.textContent='15';if(!state||state.phase!=='discard'||state.current!==0)return;turnClock=setInterval(()=>{if(!state||state.phase!=='discard'||state.current!==0){clearTurnClock();return}turnSeconds=Math.max(0,turnSeconds-1);e.textContent=String(turnSeconds).padStart(2,'0');if(turnSeconds===0)clearTurnClock()},1000)}
function setDiceFace(id,value){const el=$(id);if(!el)return;el.innerHTML='';const patterns={1:[4],2:[0,8],3:[0,4,8],4:[0,2,6,8],5:[0,2,4,6,8],6:[0,2,3,5,6,8]};const selected=new Set(patterns[value]||patterns[1]);for(let i=0;i<9;i++){const dot=document.createElement('i');if(selected.has(i))dot.className='on';el.appendChild(dot)}}
function markWallBreak(side){document.querySelectorAll('.wall-strip').forEach(x=>x.classList.remove('cut-wall'));const map={'南':'.wall-south','北':'.wall-north','西':'.wall-east','东':'.wall-west'};const e=document.querySelector(map[side]||'.wall-south');if(e)e.classList.add('cut-wall')}
function markDealer(dealer){for(let i=0;i<4;i++){const seat=$('seat-'+i);if(!seat)continue;seat.classList.toggle('dealer-seat',i===dealer);const top=seat.querySelector('.seat-top');let mark=top.querySelector('.dealer-mark');if(i===dealer&&!mark){mark=document.createElement('span');mark.className='dealer-mark';mark.textContent='庄';top.appendChild(mark)}else if(i!==dealer&&mark)mark.remove()}}
function newGame(){
  clearTimer();clearTurnClock();if(diceTimer)clearTimeout(diceTimer);if(diceInterval)clearInterval(diceInterval);
  state=null;waiting=false;activity=[];settledState=null;$('result-modal').classList.add('hidden');
  const dice=[1+Math.floor(Math.random()*6),1+Math.floor(Math.random()*6)],setup=C.diceSetup(dice),overlay=$('dice-overlay');
  overlay.classList.remove('hidden');$('dice-outcome').textContent='正在掷骰…';$('dice-subtitle').textContent='骰子将决定庄家和开牌墙位';
  setDiceFace('dice-one',1);setDiceFace('dice-two',1);$('dice-one').classList.add('rolling');$('dice-two').classList.add('rolling');
  diceInterval=setInterval(()=>{setDiceFace('dice-one',1+Math.floor(Math.random()*6));setDiceFace('dice-two',1+Math.floor(Math.random()*6))},85);
  diceTimer=setTimeout(()=>{
    clearInterval(diceInterval);diceInterval=null;setDiceFace('dice-one',dice[0]);setDiceFace('dice-two',dice[1]);$('dice-one').classList.remove('rolling');$('dice-two').classList.remove('rolling');
    $('dice-outcome').textContent='点数 '+dice[0]+' + '+dice[1]+' = '+setup.sum+' · '+NAMES[setup.dealer]+' 坐庄';
    $('dice-subtitle').textContent='从'+setup.wallSide+'墙第 '+setup.wallStack+' 墩开牌';
    playSound('庄');
    diceTimer=setTimeout(()=>{
      state=C.createGame(settings,Math.random,setup);waiting=false;activity=[];markDealer(state.dealer);markWallBreak(state.wallBreak.side);
      $('dealer-label').textContent=NAMES[state.dealer]+' 坐庄 · '+state.wallBreak.side+'墙第'+state.wallBreak.stack+'墩';
      $('turn-label').textContent=state.current===0?'轮到你出牌':'轮到'+NAMES[state.current]+'行动';
      $('dice-overlay').classList.add('hidden');
      addLog('骰子 '+dice[0]+'+'+dice[1]+'，'+NAMES[state.dealer]+' 坐庄，从'+state.wallBreak.side+'墙第'+state.wallBreak.stack+'墩开牌','庄');
      render();if(state.current===0)renderSelfActions();else scheduleAi(650);
    },620);
  },1120);
}
function render(){
  if(!state)return;if(state.phase==='over')settleRound();
  $('wall-count').textContent='牌墙 '+state.wall.length;
  $('hand-count').textContent=state.hands[0].length+' 张';
  $('hand-tip').textContent=state.phase==='discard'&&state.current===0?'点击任意手牌出牌':state.phase==='over'?'本局已结束':'等待其他玩家操作';
  loadSeatBalances();markDealer(state.dealer);
  for(let s=0;s<4;s++){
    $('seat-'+s).classList.toggle('active',state.phase==='discard'&&state.current===s);
    renderBacks(s);renderMelds(s);renderDiscards(s);
  }
  renderHand();
  $('turn-label').textContent=state.phase==='over'?'本局结束':state.phase==='reaction'?'有人打出牌，请选择操作':state.current===0?'轮到你出牌':'轮到'+NAMES[state.current]+'行动';
  if(state.phase==='over')showResult();refreshTurnClock();
}
function renderBacks(s){if(s===0)return;const b=$('back-'+s);b.innerHTML='';for(let i=0;i<Math.min(state.hands[s].length,14);i++)b.appendChild(backEl())}
function renderMelds(s){const b=$('meld-'+s);b.innerHTML='';state.melds[s].forEach(m=>{const g=document.createElement('div');g.className='meld-group';m.tiles.forEach(id=>g.appendChild(tileEl(id)));b.appendChild(g)})}
function renderDiscards(s){const b=$('discards-'+s);b.innerHTML='';state.discards[s].forEach(id=>b.appendChild(tileEl(id)))}
function renderHand(){const b=$('hand-tiles');b.innerHTML='';const turn=state.phase==='discard'&&state.current===0,hand=state.hands[0];hand.forEach((id,i)=>{const drawn=state.lastDraw&&state.lastDraw.seat===0&&i===hand.length-1&&state.lastDraw.tile===id;const e=tileEl(id,(turn?'playable':'disabled')+(drawn?' drawn-tile':''));if(turn)e.addEventListener('click',()=>discardHuman(i));b.appendChild(e)})}
function action(label,handler,type){const b=document.createElement('button');b.className='action-button action-'+type;b.textContent=label;b.addEventListener('click',()=>{audioReady=true;playSound('ui');handler()});$('action-bar').appendChild(b)}
function renderSelfActions(){const b=$('action-bar');b.innerHTML='';if(state.phase!=='discard'||state.current!==0){const n=document.createElement('div');n.className='action-placeholder';n.textContent=state.phase==='over'?'本局已结束':'轮到你时，操作会显示在这里';b.appendChild(n);return}const o=C.selfActions(state,0);if(o.hu)action('自摸胡',()=>{try{C.winSelf(state,0);addLog('你自摸胡牌，+9 分','胡');render()}catch(e){toast(e.message)}},'hu');o.concealedKongs.forEach(id=>action('暗杠 '+C.tileLabel(id),()=>doKong('concealed',id),'gang'));o.addedKongs.forEach(id=>action('补杠 '+C.tileLabel(id),()=>doKong('added',id),'gang'));if(!o.hu&&!o.concealedKongs.length&&!o.addedKongs.length){const n=document.createElement('div');n.className='action-info';n.textContent='暂时没有可执行的胡牌或杠牌操作';b.appendChild(n)}const tip=document.createElement('div');tip.className='action-info';tip.textContent='选择一张手牌即可出牌';tip.style.marginLeft='auto';b.appendChild(tip)}
function doKong(type,id){try{C.claimSelfKong(state,0,type,id);addLog('你'+(type==='concealed'?'暗杠':'补杠')+C.tileLabel(id)+'，+3 分并补牌','杠');render();if(state.phase!=='over')renderSelfActions()}catch(e){toast(e.message)}}
function discardHuman(i){if(state.phase!=='discard'||state.current!==0)return;const id=state.hands[0][i];C.discardTile(state,0,i);addLog('你打出'+C.tileLabel(id),'出');render();processClaims()}
function processClaims(){
  if(!state||state.phase!=='reaction')return;
  let guard=0;
  while(state.phase==='reaction'&&guard++<8){
    const candidate=state.pendingClaims[state.claimCursor];
    if(!candidate){continueAfterDiscard();return}
    if(candidate.seat===0){waiting=true;renderClaim(candidate);$('turn-label').textContent='你可以选择接牌或过';return}
    try{
      const action=C.bestAiClaim(candidate);
      if(!action){C.passClaim(state,candidate.seat);continue}
      const tile=state.lastDiscard.tile;
      C.claimDiscard(state,candidate.seat,action.type,action.optionIndex||0);
      addLog(NAMES[candidate.seat]+(action.type==='hu'?'胡牌':action.type==='gang'?'明杠'+C.tileLabel(tile):action.type==='peng'?'碰'+C.tileLabel(tile):'吃'+C.tileLabel(tile)),action.type==='hu'?'胡':action.type==='gang'?'杠':action.type==='peng'?'碰':'吃');
      render();if(state.phase==='over')return;
      if(state.current===0)renderSelfActions();else scheduleAi(450);
      return;
    }catch(error){
      console.error('AI 接牌处理失败，自动跳过该次接牌：',error);
      try{C.passClaim(state,candidate.seat)}catch(passError){
        console.error('AI 过牌队列异常，强制推进接牌游标：',passError);
        state.claimCursor++;
      }
    }
  }
  if(state.phase==='reaction'&&guard>=8){console.error('接牌队列异常，自动恢复');continueAfterDiscard()}
}
function renderClaim(c){const b=$('action-bar');b.innerHTML='';const acts=c.actions,t=state.lastDiscard.tile;if(acts.some(x=>x.type==='hu'))action('胡牌',()=>doClaim('hu'),'hu');if(acts.some(x=>x.type==='gang'))action('明杠',()=>doClaim('gang'),'gang');if(acts.some(x=>x.type==='peng'))action('碰',()=>doClaim('peng'),'peng');const chi=acts.find(x=>x.type==='chi');if(chi)chi.options.forEach((o,i)=>action('吃 '+o.meld.map(C.tileLabel).join(' '),()=>doClaim('chi',i),'chi'));action('过',passHuman,'pass');const info=document.createElement('div');info.className='action-info';info.textContent='有人打出 '+C.tileLabel(t);b.prepend(info)}
function doClaim(type,i){if(!waiting)return;const t=state.lastDiscard.tile;try{C.claimDiscard(state,0,type,i||0);waiting=false;addLog('你'+(type==='hu'?'胡牌':type==='gang'?'明杠'+C.tileLabel(t):type==='peng'?'碰'+C.tileLabel(t):'吃'+C.tileLabel(t)),type==='hu'?'胡':type==='gang'?'杠':type==='peng'?'碰':'吃');render();if(state.phase!=='over'&&state.current===0)renderSelfActions();else if(state.phase!=='over')scheduleAi(450)}catch(e){toast(e.message)}}
function passHuman(){if(!waiting)return;waiting=false;C.passClaim(state,0);processClaims()}
function continueAfterDiscard(){if(state.phase==='over')return;const from=state.lastDiscard?state.lastDiscard.from:state.current,next=C.nextSeat(from);if(!C.drawTile(state,next)){render();return}addLog(NAMES[next]+'摸牌','摸');render();if(next===0)renderSelfActions();else scheduleAi(420)}
function scheduleAi(ms){clearTimer();timer=setTimeout(aiTurn,ms||400)}
function recoverAiTurn(error){
  console.error('AI 回合发生异常，启动自动恢复：',error);
  try{
    if(!state||state.phase==='over'){render();return}
    if(state.phase==='reaction'){
      const pending=state.pendingClaims[state.claimCursor];
      if(pending&&pending.seat!==0){C.passClaim(state,pending.seat);processClaims();return}
      if(!pending){continueAfterDiscard();return}
      waiting=true;renderClaim(pending);render();return;
    }
    if(state.phase==='discard'&&state.current!==0){
      const seat=state.current,hand=state.hands[seat];
      if(!hand.length){
        const next=C.nextSeat(seat);
        if(C.drawTile(state,next)){addLog(NAMES[next]+'补进下一回合，已自动恢复','摸');render();if(next!==0)scheduleAi(450);else renderSelfActions()}
        else render();
        return;
      }
      let index=C.chooseAiDiscard(hand);
      if(!Number.isInteger(index)||index<0||index>=hand.length)index=hand.length-1;
      const tile=hand[index];C.discardTile(state,seat,index);
      addLog(NAMES[seat]+'自动打出'+C.tileLabel(tile)+'（恢复操作）','出');
      render();processClaims();return;
    }
    render();
  }catch(recoveryError){
    console.error('AI 自动恢复再次失败：',recoveryError);
    toast('电脑回合异常，已尝试恢复；请点击新开一局');
    render();
  }
}
function aiTurn(token){
  timer=null;if(!state||state.phase!=='discard'||state.current===0)return;
  try{
    const seat=state.current,hand=state.hands[seat],o=C.selfActions(state,seat);
    if(o.hu){C.winSelf(state,seat);addLog(NAMES[seat]+'自摸胡牌','胡');render();return}
    if(o.concealedKongs.length||o.addedKongs.length){
      const type=o.concealedKongs.length?'concealed':'added',id=o.concealedKongs[0]!==undefined?o.concealedKongs[0]:o.addedKongs[0];
      C.claimSelfKong(state,seat,type,id);addLog(NAMES[seat]+(type==='concealed'?'暗杠':'补杠')+C.tileLabel(id)+'，+3 分','杠');render();if(state.phase!=='over')scheduleAi(300);return;
    }
    let index=C.chooseAiDiscard(hand);
    if(!Number.isInteger(index)||index<0||index>=hand.length)index=hand.length-1;
    if(index<0)throw new Error('AI 手牌为空，无法出牌');
    const tile=hand[index];C.discardTile(state,seat,index);
    addLog(NAMES[seat]+'打出'+C.tileLabel(tile),'出');render();processClaims();
  }catch(error){recoverAiTurn(error)}
}
function showResult(){
  if(!state.result)return;
  $('result-icon').textContent=state.result.type==='draw'?'荒':'胡';
  $('result-title').textContent=state.result.title;
  const result=state.result,winning=$('result-winning');winning.innerHTML='';
  if(Number.isInteger(result.seat)){
    const title=document.createElement('div');title.className='result-winning-title';
    title.textContent=NAMES[result.seat]+' · '+(result.winType||'胡牌')+' · '+(result.winningType||'胡牌');
    const detail=document.createElement('div');detail.className='result-winning-text';
    detail.textContent='胡牌：'+(result.winningTile===null||result.winningTile===undefined?'—':C.tileLabel(result.winningTile))+'；本局 '+fmt(state.scores[result.seat])+' 积分';
    const hand=document.createElement('div');hand.className='result-winning-hand';
    (result.winningHand||[]).forEach((tile,index)=>{const e=tileEl(tile,index===result.winningHand.length-1&&tile===result.winningTile?'drawn-tile':'');hand.appendChild(e)});
    winning.append(title,detail,hand);
  }else{
    const title=document.createElement('div');title.className='result-winning-title';title.textContent='本局荒牌';
    const detail=document.createElement('div');detail.className='result-winning-text';detail.textContent='没有玩家胡牌，本局杠分仍计入账户';winning.append(title,detail);
  }
  $('result-detail').textContent=result.detail+' · 四家本局合计 '+state.scores.reduce((a,b)=>a+b,0)+' 分';
  const rows=$('result-scores');rows.innerHTML='';
  for(let i=0;i<4;i++){
    const row=document.createElement('div');row.className='result-score';
    const label=document.createElement('span');label.textContent=NAMES[i]+' · 本局 '+fmt(state.scores[i])+' 分';
    const delta=document.createElement('b');delta.textContent='余额 '+balances[i];delta.className='result-balance';
    row.append(label,delta);rows.appendChild(row);
  }
  $('result-modal').classList.remove('hidden');
}
function resetBankroll(){balances=[100,100,100,100];saveBankroll();loadSeatBalances();showResult();toast('四家积分已重置为 100')}
$('sound-toggle').addEventListener('click',toggleSound);
document.addEventListener('pointerdown',()=>{audioReady=true;if(audioCtx&&audioCtx.state==='suspended')audioCtx.resume()},{once:true});
$('rules-open').addEventListener('click',()=>{audioReady=true;playSound('ui');openRules()});
$('rules-open-2').addEventListener('click',()=>{audioReady=true;playSound('ui');openRules()});
$('rules-close').addEventListener('click',closeRules);$('rules-cancel').addEventListener('click',closeRules);$('rules-save').addEventListener('click',saveSettings);
$('new-game').addEventListener('click',()=>{audioReady=true;newGame()});
$('result-new').addEventListener('click',()=>newGame());$('reset-bankroll').addEventListener('click',resetBankroll);
$('rules-modal').addEventListener('click',e=>{if(e.target===$('rules-modal'))closeRules()});
$('result-modal').addEventListener('click',e=>{if(e.target===$('result-modal'))$('result-modal').classList.add('hidden')});

window.__shipingMahjongDebug=()=>state?({
  phase:state.phase,current:state.current,dealer:state.dealer,
  wall:state.wall.length,hands:state.hands.map(h=>h.length),
  discards:state.discards.map(p=>p.length),melds:state.melds.map(m=>m.length),
  pending:state.pendingClaims.map(c=>({seat:c.seat,preferred:c.preferred,actions:c.actions.map(a=>a.type)})),
  claimCursor:state.claimCursor,lastDiscard:state.lastDiscard,
  waiting,aiTimerActive:!!timer,aiWatchdogActive:!!aiWatchdog,activeHand:state.hands[state.current].slice(),aiDiscardProbe:(()=>{try{return C.chooseAiDiscard(state.hands[state.current])}catch(e){return 'ERROR: '+e.message}})(),history:state.history.slice(-12)
}):null;
syncSoundButton();loadSeatBalances();newGame();
})();