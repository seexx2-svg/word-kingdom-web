const assert=require('node:assert/strict');
const {chromium}=require('playwright');

(async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    const pageErrors=[],failedRequests=[],consoleErrors=[];
    page.on('pageerror',error=>pageErrors.push(error.message));
    page.on('requestfailed',request=>failedRequests.push({url:request.url(),error:request.failure()?.errorText}));
    page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text())});
    await page.goto('http://127.0.0.1:8080/',{waitUntil:'networkidle'});
    await page.waitForTimeout(500);
    const diagnostic=await page.evaluate(()=>({
      title:document.title,
      handCountText:document.querySelector('#hand-count')?.textContent,
      tileCount:document.querySelectorAll('#hand-tiles .tile-face').length,
      playableCount:document.querySelectorAll('#hand-tiles .tile-face.playable').length,
      coreType:typeof window.ShipingMahjongCore,
      uiScript:[...document.scripts].map(s=>s.src),
      css:[...document.styleSheets].map(s=>s.href)
    }));
    const shot=await page.screenshot({type:'jpeg',quality:38,fullPage:false});
    console.log('SCREENSHOT_JPEG_BASE64 '+shot.toString('base64'));
    console.log('BROWSER DIAGNOSTIC '+JSON.stringify({diagnostic,pageErrors,failedRequests,consoleErrors}));
    assert.equal(diagnostic.coreType,'object','麻将规则核心脚本必须加载');
    assert.equal(diagnostic.tileCount,14,'庄家开局应渲染14张手牌');
    assert.equal(diagnostic.playableCount,14,'轮到庄家时14张手牌都应可点击');
    await page.locator('#hand-tiles .tile-face.playable').first().click();
    await page.waitForFunction(()=>document.querySelectorAll('#hand-tiles .tile-face').length===13,null,{timeout:5000});
    assert.equal(await page.locator('#hand-tiles .tile-face').count(),13,'出牌后手牌应减少到13张');
    await page.locator('#new-game').click();
    await page.waitForFunction(()=>document.querySelectorAll('#hand-tiles .tile-face').length===14,null,{timeout:5000});
    assert.deepEqual(pageErrors,[],'页面执行期间不应出现未捕获的JavaScript异常');
    assert.deepEqual(failedRequests,[],'页面资源不应加载失败');
    assert.deepEqual(consoleErrors,[],'浏览器控制台不应出现资源或脚本错误');
    const avatarAssets=await page.evaluate(()=>['you','north','west','east'].map(name=>getComputedStyle(document.querySelector('.avatar-'+name)).backgroundImage));
    assert.ok(avatarAssets.every(url=>url.includes('.svg')),'四家头像都必须使用本地SVG资源');
    const pageBackground=await page.evaluate(()=>getComputedStyle(document.body).backgroundImage);
    assert.ok(pageBackground.includes('mahjong-table-bg.svg'),'桌面场景背景必须加载本地SVG资源');
    console.log('Browser smoke passed: page loaded, initial deal, discard click, new game, no page errors.');
  }finally{
    await browser.close();
  }
})().catch(error=>{console.error(error);process.exit(1)});
