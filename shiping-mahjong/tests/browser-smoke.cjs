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
    for(let attempt=0;attempt<120;attempt++){
      if(await page.locator('#discards-1 .tile-face').count()>0)break;
      const pass=page.locator('#action-bar .action-pass');
      if(await pass.count())await pass.click();
      else await page.waitForTimeout(100);
    }
    assert.ok(await page.locator('#discards-1 .tile-face').count()>0,'北家必须按轮转规则实际打出弃牌');

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
    const sideTransform=await page.evaluate(()=>{
      const host=document.querySelector('#discards-2'),tile=document.createElement('div');
      tile.className='tile-face';host.appendChild(tile);
      const value=getComputedStyle(tile).transform;tile.remove();return value;
    });
    assert.notEqual(sideTransform,'none','东/西家弃牌应旋转为朝向侧座位的方向');
    await page.locator('#new-game').click();
    await page.locator('#dice-overlay:not(.hidden)').waitFor({timeout:2000});
    await waitForUserTurn(page);
    await page.waitForFunction(()=>document.querySelector('#dice-overlay').classList.contains('hidden'));
    assert.deepEqual(pageErrors,[],'页面执行期间不应出现未捕获的JavaScript异常');
    assert.deepEqual(failedRequests,[],'页面资源不应加载失败');
    assert.deepEqual(consoleErrors,[],'浏览器控制台不应出现资源或脚本错误');
    console.log('Browser smoke passed: dice deal, rightmost draw, 4-seat wind order, north discard, SVG assets, sound toggle, discard, new game.');
  }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exit(1)});
