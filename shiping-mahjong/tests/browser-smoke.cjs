const assert=require('node:assert/strict');
const {chromium}=require('playwright');

async function waitForUserTurn(page,timeout=25000){
  await page.waitForFunction(()=>document.querySelectorAll('#hand-tiles .tile-face.playable').length>0,{timeout});
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
    assert.ok(backImage.includes('assets/mahjong/Back.svg'),'牌背必须使用本地矢量素材');

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
