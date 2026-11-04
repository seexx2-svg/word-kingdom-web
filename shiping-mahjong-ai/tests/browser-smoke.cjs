const assert=require('node:assert/strict');
const {chromium}=require('playwright');

async function waitForUserTurn(page,timeout=30000){
  const started=Date.now();
  while(Date.now()-started<timeout){
    if(await page.locator('#hand-tiles .tile-face.playable').count()>0)return;
    if(await page.locator('#result-modal:not(.hidden)').count()){
      await page.locator('#result-new').click();
      await page.waitForTimeout(1300);
      continue;
    }
    // Trigger pass synchronously so a just-rendered button cannot detach mid-click.
    const passed=await page.evaluate(()=>{
      const button=document.querySelector('#action-bar .action-pass');
      if(!button)return false;
      button.click();return true;
    });
    if(passed){await page.waitForTimeout(60);continue}
    await page.waitForTimeout(100);
  }
  const debug=await page.evaluate(()=>window.__shipingMahjongDebug?.()||null);
  throw new Error('等待用户操作超时；游戏状态='+JSON.stringify(debug));
}
(async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    const pageErrors=[],failedRequests=[],consoleErrors=[];
    page.on('pageerror',error=>pageErrors.push(error.message));
    page.on('requestfailed',request=>failedRequests.push({url:request.url(),error:request.failure()?.errorText}));
    page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text())});
    await page.goto('http://127.0.0.1:8080/',{waitUntil:'networkidle'});
    await waitForUserTurn(page);
    await page.waitForFunction(()=>document.querySelector('#dice-overlay').classList.contains('hidden'));
    const diagnostic=await page.evaluate(()=>({
      title:document.title,
      handCountText:document.querySelector('#hand-count')?.textContent,
      tileCount:document.querySelectorAll('#hand-tiles .tile-face').length,
      playableCount:document.querySelectorAll('#hand-tiles .tile-face.playable').length,
      drawnTileAtRight:document.querySelector('#hand-tiles .tile-face:last-child')?.classList.contains('drawn-tile'),
      coreType:typeof window.ShipingMahjongCore,
      diceOutcome:document.querySelector('#dice-outcome')?.textContent,
      wallCutCount:document.querySelectorAll('.wall-strip.cut-wall').length,
      dealerCount:document.querySelectorAll('.seat.dealer-seat').length,
      bankroll:document.querySelector('#bankroll-display')?.textContent
    }));
    const shot=await page.screenshot({type:'jpeg',quality:38,fullPage:false});
    console.log('SCREENSHOT_JPEG_BASE64 '+shot.toString('base64'));
    console.log('BROWSER DIAGNOSTIC '+JSON.stringify({diagnostic,pageErrors,failedRequests,consoleErrors}));
    assert.equal(diagnostic.coreType,'object','麻将规则核心脚本必须加载');
    assert.equal(diagnostic.tileCount,14,'轮到用户出牌时应有14张牌');
    assert.equal(diagnostic.playableCount,14,'轮到用户时14张手牌都应可点击');
    assert.equal(diagnostic.drawnTileAtRight,true,'新摸的牌必须独立放在手牌最右侧');
    assert.match(diagnostic.diceOutcome,/坐庄/,'骰子动画后必须公布庄家');
    assert.equal(diagnostic.wallCutCount,1,'骰子必须标出唯一的开牌墙');
    assert.equal(diagnostic.dealerCount,1,'一局必须且只能有一个庄家');
    assert.match(diagnostic.bankroll,/100/,'每家开局带入100积分');
    const dieDiagnostics=await page.locator('.dice-cube').evaluateAll(cubes=>cubes.map(c=>({
      faceCount:c.querySelectorAll('.die-face').length,
      values:Array.from(c.querySelectorAll('.die-face')).map(f=>Number(f.dataset.value)),
      pips:Array.from(c.querySelectorAll('.die-face')).map(f=>f.querySelectorAll('i.on').length),
      settledTransform:c.querySelector('.die-cube3d')?.style.transform
    })));
    for(const die of dieDiagnostics){
      assert.equal(die.faceCount,6,'骰子必须有真实六面立方体，而不只是平面圆点');
      assert.deepEqual(die.values,[1,6,3,4,2,5],'骰子六个面必须各自有正确点数');
      assert.deepEqual(die.pips,[1,6,3,4,2,5],'骰面点数图案必须正确');
      assert.ok(die.settledTransform.includes('rotate'),'骰子落桌后应停在最终朝向');
    }

    // Check the real 3D tumble while the dice are moving on the felt.
    await page.locator('#new-game').click();
    await page.locator('#dice-overlay:not(.hidden)').waitFor();
    const rollingState=await page.locator('.dice-cube').evaluateAll(cubes=>cubes.map(c=>({
      rolling:c.classList.contains('rolling'),
      animation:getComputedStyle(c.querySelector('.die-cube3d')).animationName,
      perspective:getComputedStyle(c).perspective
    })));
    assert.ok(rollingState.every(d=>d.rolling&&d.animation==='die-tumble'&&d.perspective!=='none'),'两颗骰子必须在牌桌上以真实3D立方体滚动');
    await waitForUserTurn(page);
    await page.waitForFunction(()=>document.querySelector('#dice-overlay').classList.contains('hidden'));

    const windOrder=await page.locator('.hud-wind span').allTextContents();
    assert.deepEqual(windOrder,['东','南','西','北'],'中央方位必须从左到右为东南西北');
    assert.match(await page.locator('#seat-3 .seat-meta b').textContent(),/东家/,'左侧座位应为东家');
    assert.match(await page.locator('#seat-0 .seat-meta b').textContent(),/南家/,'下方座位应为南家');
    assert.match(await page.locator('#seat-2 .seat-meta b').textContent(),/西家/,'右侧座位应为西家');
    assert.match(await page.locator('#seat-1 .seat-meta b').textContent(),/北家/,'上方座位应为北家');

    const faceImage=await page.locator('#hand-tiles .tile-face').first().evaluate(e=>getComputedStyle(e).backgroundImage);
    const backImage=await page.locator('.tile-back').first().evaluate(e=>getComputedStyle(e).backgroundImage);
    assert.ok(faceImage.includes('assets/mahjong/'),'牌面必须使用本地高质量矢量素材');
    const backStyle=await page.locator('.tile-back').first().evaluate(e=>({image:getComputedStyle(e).backgroundImage,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}));
    assert.ok(backStyle.image.includes('linear-gradient'),'牌背应为绿色桌面风格，不再使用红色SVG牌背');
    assert.ok(!backStyle.image.includes('Back.svg'),'不能再将红色牌背素材作为玩家暗牌背面');
    const avatarSize=await page.locator('#seat-0 .avatar').evaluate(e=>e.getBoundingClientRect().width);
    assert.ok(avatarSize>=50,'玩家头像应明显放大');
    const hud=await page.locator('.center-hud').boundingBox();
    const felt=await page.locator('.felt').boundingBox();
    assert.ok(Math.abs((hud.x+hud.width/2)-(felt.x+felt.width/2))<12,'中央读秒必须水平居中');
    assert.ok(Math.abs((hud.y+hud.height/2)-(felt.y+felt.height*.48))<55,'中央读秒必须位于牌桌中央附近');
    const northBack=await page.locator('#back-1').boundingBox();
    assert.ok(hud.y>northBack.y+northBack.height,'中央读秒不能遮住北家手牌');
    const leftBack=await page.locator('#back-3').boundingBox();
    const leftAvatar=await page.locator('#seat-3 .avatar').boundingBox();
    const rightBack=await page.locator('#back-2').boundingBox();
    const rightAvatar=await page.locator('#seat-2 .avatar').boundingBox();
    const overlap=(a,b)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
    assert.ok(!overlap(leftBack,leftAvatar),'东家手牌不能挡住东家头像');
    assert.ok(!overlap(rightBack,rightAvatar),'西家手牌不能挡住西家头像');

    const sound=page.locator('#sound-toggle');
    assert.equal(await sound.getAttribute('aria-pressed'),'true','音效默认开启');
    await sound.click();
    assert.equal(await sound.getAttribute('aria-pressed'),'false','音效开关可关闭');
    await sound.click();
    assert.equal(await sound.getAttribute('aria-pressed'),'true','音效开关可重新开启');

    await page.locator('#hand-tiles .tile-face.playable').first().click();
    await page.waitForFunction(()=>document.querySelectorAll('#hand-tiles .tile-face').length===13,{timeout:5000});
    assert.equal(await page.locator('#hand-tiles .tile-face').count(),13,'出牌后手牌应减少到13张');
    await page.waitForFunction(()=>window.__shipingMahjongLastDiscardFlight?.seat===0);
    const discardCallout=await page.locator('#discard-callout').textContent();
    assert.match(discardCallout,/南家.*打出/,'打牌提示必须说清楚是哪家打出的');
    const flight=await page.evaluate(()=>window.__shipingMahjongLastDiscardFlight);
    assert.equal(flight.seat,0,'玩家弃牌动画应从南家位置出发');
    assert.ok(Math.abs(flight.from.x-flight.to.x)>10||Math.abs(flight.from.y-flight.to.y)>10,'弃牌必须有从手牌到弃牌区的移动路径');
    for(let attempt=0;attempt<120;attempt++){
      if(await page.locator('#discards-1 .tile-face').count()>0)break;
      const pass=page.locator('#action-bar .action-pass');
      if(await pass.count())await pass.click();
      else await page.waitForTimeout(100);
    }
    assert.ok(await page.locator('#discards-1 .tile-face').count()>0,'北家必须按轮转规则实际打出弃牌');

    // Force a deterministic AI chi. The meld must identify the eaten tile and then the AI must discard.
    const forcedChi=await page.evaluate(()=>window.__shipingMahjongDebugForceAiChi?.());
    assert.ok(forcedChi&&forcedChi.seat===2,'必须构造出下家吃牌场景');
    await page.waitForFunction(seat=>{
      const d=window.__shipingMahjongDebug?.();
      return d&&d.meldDetails[seat].some(m=>m.type==='chi'&&m.calledTile===2&&m.calledTileIndex===2);
    },forcedChi.seat,{timeout:5000});
    const chiLabel=page.locator('#meld-2 .meld-chi .meld-label');
    await chiLabel.waitFor({timeout:3000});
    assert.equal((await chiLabel.textContent()).trim(),'吃 3万','吃牌副露必须明确标出吃进来的3万');
    const calledTileOutline=await page.locator('#meld-2 .meld-chi .meld-called-tile').first().evaluate(e=>getComputedStyle(e).outlineStyle);
    assert.equal(calledTileOutline,'solid','吃进来的那张牌必须高亮');
    await page.waitForFunction(seat=>{
      const h=window.__shipingMahjongDebug()?.history||[];
      return h.some((x,i)=>x.type==='chi'&&x.seat===seat&&h[i+1]?.type==='discard'&&h[i+1]?.seat===seat);
    },forcedChi.seat,{timeout:6000});

    // Remove an AI timer on purpose. The persistent supervisor must restore the turn.
    const stall=await page.evaluate(()=>window.__shipingMahjongDebugForceAiStall?.());
    assert.ok(stall&&Number.isInteger(stall.seat),'必须能构造一个没有AI任务的电脑回合');
    await page.waitForFunction(({seat,before})=>{
      const d=window.__shipingMahjongDebug?.();
      return d&&d.discards[seat]>before;
    },stall,{timeout:6000});
    await page.locator('#new-game').click();
    await waitForUserTurn(page);

    // Stress twenty complete user turns; a round may end and auto-restart during the stress run.
    const seenDiscardSeats=new Set();
    const recordDiscardSeats=debug=>{if(debug&&Array.isArray(debug.discards))debug.discards.forEach((count,seat)=>{if(count>0)seenDiscardSeats.add(seat)})};
    for(let turn=0;turn<20;turn++){
      await waitForUserTurn(page,30000);
      const playable=page.locator('#hand-tiles .tile-face.playable');
      const count=await playable.count();
      assert.ok(count>=13,'玩家回合必须有可操作手牌');
      const before=await page.evaluate(()=>window.__shipingMahjongDebug?.());
      recordDiscardSeats(before);
      console.log('STRESS TURN '+turn+' BEFORE '+JSON.stringify(before));
      await playable.nth((turn*7+3)%count).click({timeout:5000});
      await waitForUserTurn(page,30000);
      const after=await page.evaluate(()=>window.__shipingMahjongDebug?.());
      recordDiscardSeats(after);
      console.log('STRESS TURN '+turn+' AFTER '+JSON.stringify(after));
    }
    assert.ok(seenDiscardSeats.has(1),'北家必须在压力测试期间出牌');
    assert.ok(seenDiscardSeats.has(2),'西家必须在压力测试期间出牌');
    assert.ok(seenDiscardSeats.has(3),'东家必须在压力测试期间出牌');
    const sideOrientation=await page.evaluate(()=>{
      const checks=['#discards-2','#discards-3'].map(selector=>{
        const host=document.querySelector(selector),tile=document.createElement('div');
        tile.className='tile-face';host.appendChild(tile);
        const style=getComputedStyle(tile),value={transform:style.transform,width:parseFloat(style.width),height:parseFloat(style.height)};
        tile.remove();return value;
      });
      return checks;
    });
    for(const side of sideOrientation){
      assert.equal(side.transform,'none','东、西家弃牌必须正向摆放，不能横转');
      assert.ok(side.height>side.width,'东、西家弃牌必须保持竖直牌面比例');
    }

    // The win presentation must be inside the felt and show melds plus all winning tiles.
    await page.evaluate(()=>window.__shipingMahjongDebugForceWin?.());
    await page.locator('#result-modal:not(.hidden)').waitFor();
    const winLayout=await page.evaluate(()=>{
      const layer=document.querySelector('#result-modal'),felt=document.querySelector('.felt'),card=layer.querySelector('.result-card');
      const a=layer.getBoundingClientRect(),b=felt.getBoundingClientRect(),bg=getComputedStyle(layer).backgroundColor;
      return{
        parentIsFelt:layer.parentElement===felt,
        centeredX:Math.abs((a.left+a.width/2)-(b.left+b.width/2)),
        centeredY:Math.abs((a.top+a.height/2)-(b.top+b.height/2)),
        layerWidth:a.width,viewportWidth:innerWidth,background:bg,
        pointerEvents:getComputedStyle(layer).pointerEvents,
        cardPointerEvents:getComputedStyle(card).pointerEvents,
        hiddenHand:layer.querySelectorAll('.result-winning-hand .tile-face').length,
        exposedMeld:layer.querySelectorAll('.result-meld-group .tile-face').length
      };
    });
    console.log('WIN_LAYOUT '+JSON.stringify(winLayout));
    assert.equal(winLayout.parentIsFelt,true,'胡牌结果必须放在牌桌内部');
    assert.ok(winLayout.centeredX<12&&winLayout.centeredY<18,'胡牌展示必须居中于牌桌：'+JSON.stringify(winLayout));
    assert.ok(winLayout.layerWidth<winLayout.viewportWidth,'胡牌展示不能铺满整个屏幕');
    assert.match(winLayout.background,/0\.2[0-9]+\)/,'牌桌遮罩应保持半透明');
    assert.equal(winLayout.pointerEvents,'none','结果遮罩本身不能挡住牌桌点击');
    assert.equal(winLayout.cardPointerEvents,'auto','结果卡片按钮仍可点击');
    assert.equal(winLayout.hiddenHand,14,'必须展示完整14张胡牌手牌');
    assert.equal(winLayout.exposedMeld,3,'必须展示已亮副露的全部牌');

    await page.locator('#result-new').click();
    await page.locator('#dice-overlay:not(.hidden)').waitFor();
    const diceLayout=await page.evaluate(()=>{
      const dice=document.querySelector('#dice-overlay'),felt=document.querySelector('.felt'),card=document.querySelector('.dice-card');
      const a=dice.getBoundingClientRect(),b=felt.getBoundingClientRect(),c=card.getBoundingClientRect();
      return{parentIsFelt:dice.parentElement===felt,centerX:Math.abs((a.left+a.width/2)-(b.left+b.width/2)),centerY:Math.abs((a.top+a.height/2)-(b.top+b.height/2)),cardWidth:c.width,hasRollingDice:!!dice.querySelector('.dice-cube.rolling')};
    });
    assert.equal(diceLayout.parentIsFelt,true,'骰子动画必须属于牌桌，不是页面独立弹窗');
    assert.ok(diceLayout.centerX<12&&diceLayout.centerY<18,'骰子必须在牌桌正中央');
    assert.ok(diceLayout.cardWidth>100,'中央骰子必须实际显示');
    assert.equal(diceLayout.hasRollingDice,true,'两颗骰子开局应有滚动动画');
    await waitForUserTurn(page);
    await page.waitForFunction(()=>document.querySelector('#dice-overlay').classList.contains('hidden'));

    assert.deepEqual(pageErrors,[],'页面执行期间不应出现未捕获的JavaScript异常');
    assert.deepEqual(failedRequests,[],'页面资源不应加载失败');
    assert.deepEqual(consoleErrors,[],'浏览器控制台不应出现资源或脚本错误');
    console.log('Browser smoke passed: dice deal, rightmost draw, 4-seat wind order, north discard, SVG assets, sound toggle, discard, new game.');
  }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exit(1)});
